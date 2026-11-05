/**
 * Pruebas de los adaptadores Culqi y Twilio contra un SERVIDOR SIMULADO local que reproduce las
 * formas de solicitud/respuesta según la documentación pública consultada. Verifican el manejo de
 * éxito, rechazo, error 5xx (resultado incierto), idempotencia, autenticación y verificación de
 * webhooks por consulta. NO reemplazan pruebas con las APIs reales (pendientes de credenciales).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, IncomingMessage, Server } from 'http';
import { AddressInfo } from 'net';
import { config, setConfigForTests } from '../src/config';
import { CulqiProvider } from '../src/providers/payments';
import { TwilioSms } from '../src/providers/messaging';

const calls: { method: string; url: string; headers: IncomingMessage['headers']; body: any }[] = [];
let server: Server;
let base = '';
const prev = { ...config() };

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const ch of req) raw += ch;
    const body = raw ? (req.headers['content-type']?.includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))) : null;
    calls.push({ method: req.method!, url: req.url!, headers: req.headers, body });
    const send = (code: number, b: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.url?.startsWith('/2010-04-01/')) {
      const ok = req.headers.authorization === 'Basic ' + Buffer.from('AC123:tok').toString('base64');
      return ok ? send(201, { sid: 'SM1', status: 'queued' }) : send(401, { message: 'Authenticate' });
    }
    if (req.headers.authorization !== 'Bearer sk_test_simulado') return send(401, { user_message: 'No autorizado' });
    if (req.method === 'POST' && req.url === '/v2/charges') {
      if (body.source_id === 'tkn_5xx') return send(503, {});
      if (body.source_id === 'tkn_rechazo') return send(402, { object: 'error', user_message: 'Tu tarjeta fue rechazada' });
      return send(201, { id: 'chr_test_1', amount: body.amount, currency_code: body.currency_code, outcome: { type: 'venta_exitosa' } });
    }
    if (req.method === 'POST' && req.url === '/v2/orders') return send(201, { id: 'ord_test_1', amount: body.amount, currency_code: body.currency_code, state: 'pending' });
    if (req.method === 'GET' && req.url === '/v2/orders/ord_test_1') return send(200, { id: 'ord_test_1', amount: 3900, currency_code: 'PEN', state: 'paid' });
    if (req.method === 'GET' && req.url === '/v2/charges/chr_test_1') return send(200, { id: 'chr_test_1', amount: 3900, currency_code: 'PEN', outcome: { type: 'venta_exitosa' } });
    if (req.method === 'POST' && req.url === '/v2/refunds') return send(201, { id: 'ref_test_1', amount: body.amount });
    return send(404, { user_message: 'No existe' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setConfigForTests({ CULQI_API_URL: `${base}/v2`, CULQI_SECRET_KEY: 'sk_test_simulado', TWILIO_API_URL: base, TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+15550000000' });
});
afterAll(async () => {
  setConfigForTests(prev);
  await new Promise((r) => server.close(r));
});

const input = (token?: string, method: 'card' | 'wallet' = 'card') => ({ paymentId: 'p1', orderId: 'o1', orderNumber: 1001, amountCents: 3900, currency: 'PEN' as const, method, providerToken: token, customerEmail: 'a@b.pe', idempotencyKey: 'idem-123' });

describe('adaptador Culqi (servidor simulado)', () => {
  const culqi = new CulqiProvider();
  it('cargo con token: éxito con autenticación e Idempotency-Key', async () => {
    const r = await culqi.createCharge(input('tkn_ok'));
    expect(r).toMatchObject({ outcome: 'paid', providerReference: 'chr_test_1' });
    const c = calls.find((x) => x.url === '/v2/charges')!;
    expect(c.headers['idempotency-key']).toBe('idem-123');
    expect(c.body).toMatchObject({ amount: 3900, currency_code: 'PEN', source_id: 'tkn_ok' });
  });
  it('rechazo → fallido con mensaje del proveedor; 5xx → incierto (no se reintenta a ciegas)', async () => {
    expect(await culqi.createCharge(input('tkn_rechazo'))).toMatchObject({ outcome: 'failed', failureReason: 'Tu tarjeta fue rechazada' });
    expect((await culqi.createCharge(input('tkn_5xx'))).outcome).toBe('uncertain');
    expect((await culqi.createCharge(input(undefined))).outcome).toBe('failed');
  });
  it('billetera (Yape/Plin) crea orden pendiente; consulta de estado', async () => {
    expect(await culqi.createCharge(input(undefined, 'wallet'))).toMatchObject({ outcome: 'pending', providerReference: 'ord_test_1' });
    expect(await culqi.getStatus('ord_test_1')).toMatchObject({ status: 'paid', amountCents: 3900, currency: 'PEN' });
    expect((await culqi.getStatus('ord_inexistente')).status).toBe('not_found');
  });
  it('webhook: el estado se toma de la consulta al proveedor, no del cuerpo recibido', async () => {
    const forged = JSON.stringify({ type: 'order.status.changed', data: JSON.stringify({ id: 'ord_test_1', state: 'paid', amount: 1 }) });
    const ev = await culqi.verifyWebhook({}, forged);
    expect(ev).toMatchObject({ providerReference: 'ord_test_1', status: 'paid', amountCents: 3900 });
    expect(await culqi.verifyWebhook({}, JSON.stringify({ type: 'x', data: { id: 'ord_falsa' } }))).toBeNull();
    expect(await culqi.verifyWebhook({}, 'no-json')).toBeNull();
  });
  it('reembolso', async () => {
    expect(await culqi.refund('chr_test_1', 1000, 'refund-idem')).toMatchObject({ status: 'succeeded', providerReference: 'ref_test_1' });
  });
  it('sin llave secreta no hay llamadas', async () => {
    setConfigForTests({ CULQI_SECRET_KEY: '' });
    await expect(culqi.getStatus('ord_test_1')).rejects.toThrow(/CULQI_SECRET_KEY/);
    setConfigForTests({ CULQI_SECRET_KEY: 'sk_test_simulado' });
  });
});

describe('adaptador Twilio (servidor simulado)', () => {
  it('envía SMS con autenticación básica', async () => {
    const r = await new TwilioSms().send('+51987654321', 'Código 123456');
    expect(r).toEqual({ delivered: true, reference: 'SM1' });
    const c = calls.find((x) => x.url?.startsWith('/2010-04-01/'))!;
    expect(c.body).toMatchObject({ To: '+51987654321', From: '+15550000000' });
  });
});
