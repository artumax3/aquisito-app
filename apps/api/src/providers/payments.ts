import { config } from '../config';
import { db } from '../db/db';
import { hmacHex, randomToken, safeEqual } from '../common/crypto';
import { logger } from '../common/logger';

export type ChargeOutcome = 'pending' | 'paid' | 'failed' | 'uncertain';

export interface CreateChargeInput {
  paymentId: string;
  orderId: string;
  orderNumber: number;
  amountCents: number;
  currency: 'PEN';
  method: 'card' | 'wallet';
  providerToken?: string;
  customerEmail?: string | null;
  idempotencyKey: string;
}
export interface CreateChargeResult {
  outcome: ChargeOutcome;
  providerReference?: string;
  checkoutUrl?: string;
  failureReason?: string;
}
export interface ProviderStatus {
  status: 'pending' | 'paid' | 'failed' | 'not_found';
  amountCents?: number;
  currency?: string;
  providerReference?: string;
}
export interface VerifiedEvent {
  eventId: string;
  type: string;
  providerReference: string;
  /** Estado CONFIRMADO por el mecanismo del proveedor (firma o consulta directa). */
  status: 'paid' | 'failed' | 'pending' | 'refunded';
  amountCents: number;
  currency: string;
  occurredAt: Date | null;
  verificationNote: string;
}
export interface RefundResult {
  status: 'succeeded' | 'pending' | 'failed';
  providerReference?: string;
}

export interface PaymentProvider {
  readonly name: string;
  readonly isSimulator: boolean;
  createCharge(input: CreateChargeInput): Promise<CreateChargeResult>;
  getStatus(providerReference: string): Promise<ProviderStatus>;
  /** Devuelve null si la autenticidad no puede verificarse. */
  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): Promise<VerifiedEvent | null>;
  refund(providerReference: string, amountCents: number, idempotencyKey: string): Promise<RefundResult>;
}

/**
 * SIMULADOR — solo desarrollo y pruebas. Emula un proveedor externo con estado propio en la tabla
 * sandbox_provider_charges y webhooks firmados con HMAC-SHA256 (X-Sandbox-Signature). La
 * configuración de ensayo/producción lo rechaza (config.productionConfigProblems).
 */
export class SandboxProvider implements PaymentProvider {
  readonly name = 'sandbox';
  readonly isSimulator = true;
  /** Para pruebas: forzar fallas de red al crear el cargo. */
  static failNextCreateWithTimeout = false;

  async createCharge(input: CreateChargeInput): Promise<CreateChargeResult> {
    const reference = `sbx_${randomToken(9)}`;
    await db.q(
      `INSERT INTO sandbox_provider_charges(reference, payment_id, amount_cents, currency, status) VALUES ($1,$2,$3,$4,'pending')`,
      [reference, input.paymentId, input.amountCents, input.currency],
    );
    if (SandboxProvider.failNextCreateWithTimeout) {
      SandboxProvider.failNextCreateWithTimeout = false;
      // El proveedor registró el cargo pero la respuesta "se perdió": resultado incierto.
      throw Object.assign(new Error('timeout simulado'), { uncertainReference: reference });
    }
    return { outcome: 'pending', providerReference: reference, checkoutUrl: `${config().PUBLIC_WEB_URL}/pedidos/${input.orderId}` };
  }

  async getStatus(reference: string): Promise<ProviderStatus> {
    const r = await db.maybe(`SELECT * FROM sandbox_provider_charges WHERE reference = $1`, [reference]);
    if (!r) return { status: 'not_found' };
    return { status: r.status, amountCents: r.amount_cents, currency: r.currency, providerReference: reference };
  }

  /** Cambia el estado "en el proveedor" y produce el cuerpo + firma del webhook correspondiente. */
  static async settle(reference: string, status: 'paid' | 'failed'): Promise<{ body: string; signature: string }> {
    await db.q(`UPDATE sandbox_provider_charges SET status = $2 WHERE reference = $1`, [reference, status]);
    const r = await db.one(`SELECT * FROM sandbox_provider_charges WHERE reference = $1`, [reference]);
    const body = JSON.stringify({
      id: `evt_${randomToken(8)}`,
      type: status === 'paid' ? 'charge.succeeded' : 'charge.failed',
      created_at: new Date().toISOString(),
      data: { reference, amount: r.amount_cents, currency: r.currency, status },
    });
    return { body, signature: SandboxProvider.sign(body) };
  }

  static sign(body: string) {
    return hmacHex(config().SANDBOX_WEBHOOK_SECRET, body);
  }

  async verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): Promise<VerifiedEvent | null> {
    const sig = headers['x-sandbox-signature'];
    if (typeof sig !== 'string' || !safeEqual(sig, SandboxProvider.sign(rawBody))) return null;
    const ev = JSON.parse(rawBody);
    return {
      eventId: ev.id,
      type: ev.type,
      providerReference: ev.data.reference,
      status: ev.data.status,
      amountCents: ev.data.amount,
      currency: ev.data.currency,
      occurredAt: ev.created_at ? new Date(ev.created_at) : null,
      verificationNote: 'hmac-sha256 válido',
    };
  }

  async refund(reference: string, amountCents: number): Promise<RefundResult> {
    const r = await db.maybe(
      `UPDATE sandbox_provider_charges SET refunded_cents = refunded_cents + $2
       WHERE reference = $1 AND status = 'paid' AND refunded_cents + $2 <= amount_cents RETURNING *`,
      [reference, amountCents],
    );
    if (!r) return { status: 'failed' };
    return { status: 'succeeded', providerReference: `sbx_rf_${randomToken(6)}` };
  }
}

/**
 * Culqi (candidato para Perú). Código de integración escrito según la documentación pública
 * (cargos con token de Culqi Checkout/Culqi.js; órdenes para billeteras Yape/Plin; webhooks).
 * ESTADO: sin probar con credenciales reales. Verificar endpoints, campos y habilitación de la
 * cuenta antes de activar. La autenticidad del webhook se establece CONSULTANDO la operación a la
 * API de Culqi con la llave secreta; no se asume ninguna firma no documentada.
 */
export class CulqiProvider implements PaymentProvider {
  readonly name = 'culqi';
  readonly isSimulator = false;

  private async call(path: string, init: RequestInit & { idempotencyKey?: string } = {}) {
    const cfg = config();
    if (!cfg.CULQI_SECRET_KEY) throw new Error('CULQI_SECRET_KEY no configurada');
    const res = await fetch(`${cfg.CULQI_API_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${cfg.CULQI_SECRET_KEY}`,
        'Content-Type': 'application/json',
        ...(init.idempotencyKey ? { 'Idempotency-Key': init.idempotencyKey } : {}),
      },
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  }

  async createCharge(input: CreateChargeInput): Promise<CreateChargeResult> {
    if (input.method === 'card') {
      if (!input.providerToken) return { outcome: 'failed', failureReason: 'Falta token de tarjeta' };
      const r = await this.call('/charges', {
        method: 'POST',
        idempotencyKey: input.idempotencyKey,
        body: JSON.stringify({
          amount: input.amountCents,
          currency_code: input.currency,
          email: input.customerEmail ?? undefined,
          source_id: input.providerToken,
          metadata: { order_id: input.orderId, payment_id: input.paymentId },
        }),
      });
      if (r.status >= 500) return { outcome: 'uncertain' };
      if (!r.ok) return { outcome: 'failed', failureReason: r.body?.user_message ?? 'Rechazado por el proveedor' };
      const paid = r.body?.outcome?.type === 'venta_exitosa';
      return { outcome: paid ? 'paid' : 'pending', providerReference: r.body.id };
    }
    // Billeteras (Yape/Plin) mediante orden de pago; el cliente completa en Culqi Checkout.
    const r = await this.call('/orders', {
      method: 'POST',
      idempotencyKey: input.idempotencyKey,
      body: JSON.stringify({
        amount: input.amountCents,
        currency_code: input.currency,
        description: `Pedido ${input.orderNumber}`,
        order_number: `${input.orderNumber}-${input.paymentId.slice(0, 8)}`,
        expiration_date: Math.floor(Date.now() / 1000) + config().PAYMENT_DEADLINE_MINUTES * 60,
        client_details: { email: input.customerEmail ?? undefined },
        metadata: { order_id: input.orderId, payment_id: input.paymentId },
      }),
    });
    if (r.status >= 500) return { outcome: 'uncertain' };
    if (!r.ok) return { outcome: 'failed', failureReason: r.body?.user_message ?? 'No se pudo crear la orden' };
    return { outcome: 'pending', providerReference: r.body.id };
  }

  async getStatus(reference: string): Promise<ProviderStatus> {
    const path = reference.startsWith('ord_') ? `/orders/${reference}` : `/charges/${reference}`;
    const r = await this.call(path, { method: 'GET' });
    if (r.status === 404) return { status: 'not_found' };
    if (!r.ok) throw new Error(`Culqi status ${r.status}`);
    const b = r.body;
    let status: ProviderStatus['status'] = 'pending';
    if (reference.startsWith('ord_')) status = b.state === 'paid' ? 'paid' : ['expired', 'deleted'].includes(b.state) ? 'failed' : 'pending';
    else status = b.outcome?.type === 'venta_exitosa' ? 'paid' : 'failed';
    return { status, amountCents: b.amount, currency: b.currency_code, providerReference: reference };
  }

  async verifyWebhook(_h: Record<string, string | string[] | undefined>, rawBody: string): Promise<VerifiedEvent | null> {
    let ev: any;
    try {
      ev = JSON.parse(rawBody);
    } catch {
      return null;
    }
    const data = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
    const reference: string | undefined = data?.id;
    if (!reference) return null;
    // Autenticidad: no se confía en el cuerpo; se consulta la operación al proveedor.
    const st = await this.getStatus(reference).catch((e) => {
      logger.warn('culqi: consulta de verificación falló', { err: e.message });
      return null;
    });
    if (!st || st.status === 'not_found') return null;
    return {
      eventId: ev.id ?? `${ev.type}:${reference}:${st.status}`,
      type: ev.type ?? 'unknown',
      providerReference: reference,
      status: st.status,
      amountCents: st.amountCents ?? -1,
      currency: st.currency ?? '',
      occurredAt: null,
      verificationNote: 'estado confirmado por consulta directa a la API de Culqi',
    };
  }

  async refund(reference: string, amountCents: number, idempotencyKey: string): Promise<RefundResult> {
    const r = await this.call('/refunds', {
      method: 'POST',
      idempotencyKey,
      body: JSON.stringify({ amount: amountCents, charge_id: reference, reason: 'solicitud_comprador' }),
    });
    if (r.status >= 500) return { status: 'pending' };
    if (!r.ok) return { status: 'failed' };
    return { status: 'succeeded', providerReference: r.body.id };
  }
}

const registry = new Map<string, PaymentProvider>();
export function paymentProvider(name: string): PaymentProvider {
  const enabled = config().PAYMENT_PROVIDERS.split(',').map((s) => s.trim());
  if (!enabled.includes(name)) throw new Error(`Proveedor de pago no habilitado: ${name}`);
  if (!registry.has(name)) {
    if (name === 'sandbox') {
      if (!config().isDevLike) throw new Error('El simulador de pagos solo puede usarse en desarrollo/pruebas');
      registry.set(name, new SandboxProvider());
    } else if (name === 'culqi') registry.set(name, new CulqiProvider());
    else throw new Error(`Proveedor desconocido: ${name}`);
  }
  return registry.get(name)!;
}

export function providerForMethod(method: 'card' | 'wallet'): PaymentProvider {
  return paymentProvider(method === 'card' ? config().CARD_PROVIDER : config().WALLET_PROVIDER);
}
