'use client';
import dynamic from 'next/dynamic';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { OrderDto, TrackingDto } from '@aquisito/contracts';
import { LABELS } from '@aquisito/contracts';
import { api, useQuery, useRealtime } from '@/lib/api';
import { ActionButton, ErrorBox, Loading, Money, StatusBadge } from '@/components/ui';
import { openCulqiCheckout } from '@/components/culqi';

const MapView = dynamic(() => import('@/components/map').then((m) => m.MapView), { ssr: false });
const ACTIVE = ['asignado', 'en_camino_al_comercio', 'recogido', 'en_camino_al_cliente', 'en_destino', 'verificacion_requerida'];

export default function OrderPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const order = useQuery<OrderDto>('order', { params: { id } });
  const payCfg = useQuery<any>('paymentsConfig');
  const payment = useQuery<any>(order.data?.latestPaymentId ? 'payment' : null, { params: { id: order.data?.latestPaymentId ?? '' } }, [order.data?.version]);
  const [tracking, setTracking] = useState<TrackingDto | null>(null);
  const [code, setCode] = useState<{ code: string; note: string } | null>(null);
  const messages = useQuery<any[]>('orderMessages', { params: { id } });
  const [msg, setMsg] = useState('');
  const [incident, setIncident] = useState({ kind: 'missing_item', description: '' });
  const [evidence, setEvidence] = useState<File | null>(null);
  const [rating, setRating] = useState({ storeScore: 5, courierScore: 5, comment: '' });
  const [info, setInfo] = useState<string | null>(null);

  useRealtime((type, d) => {
    if (type === 'reconnected' || d?.orderId === id) {
      order.reload();
      messages.reload();
    }
  });

  const o = order.data;
  const live = !!o && ACTIVE.includes(o.deliveryStatus);
  useEffect(() => {
    if (!live) return setTracking(null);
    let stop = false;
    const tick = async () => {
      try {
        const t = await api.call('tracking', { params: { id } });
        if (!stop) setTracking(t);
      } catch {
        /* sin conexión: se muestra la última posición con su hora */
      }
    };
    tick();
    const h = setInterval(tick, 10000);
    return () => {
      stop = true;
      clearInterval(h);
    };
  }, [live, id]);

  if (order.loading) return <Loading lines={3} />;
  if (order.error) return <ErrorBox error={order.error} onRetry={order.reload} />;
  if (!o) return null;
  const pendingPayment = o.paymentStatus === 'pendiente' && o.commercialStatus === 'pendiente_confirmacion';
  const subs = o.substitutions.filter((s) => s.status === 'pending');

  return (
    <section className="col" style={{ marginTop: 12 }}>
      <h1>Pedido #{o.number}</h1>
      <div className="row">
        <StatusBadge cycle="commercial" status={o.commercialStatus} />
        <StatusBadge cycle="delivery" status={o.deliveryStatus} />
        <StatusBadge cycle="payment" status={o.paymentStatus} />
      </div>
      <span className="muted">{o.branchName} · {o.scheduledFor ? `Programado para ${new Date(o.scheduledFor).toLocaleString('es-PE', { timeZone: 'America/Lima' })}` : o.etaAt ? `Llegada estimada ${new Date(o.etaAt).toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit' })} (estimación)` : ''}</span>

      {pendingPayment && (
        <div className="card col">
          <h2>Pago pendiente</h2>
          <p className="muted">Tu pedido se confirmará cuando el proveedor de pagos confirme el cobro. No se considera pagado por mostrar una pantalla de éxito ni por capturas.</p>
          {payment.data?.simulated && (
            <div className="dev-banner col">
              SIMULADOR DE PAGOS — SOLO DESARROLLO. Ninguna operación real.
              <div className="row">
                <ActionButton className="sm" onClick={async () => { await api.call('simulatePayment', { params: { id: payment.data.id }, body: { outcome: 'paid' } }); order.reload(); }}>Simular pago aprobado</ActionButton>
                <ActionButton className="sm warn" onClick={async () => { await api.call('simulatePayment', { params: { id: payment.data.id }, body: { outcome: 'failed' } }); order.reload(); }}>Simular rechazo</ActionButton>
              </div>
            </div>
          )}
          {payCfg.data && !payCfg.data[o.paymentMethod]?.simulator && (
            payCfg.data[o.paymentMethod]?.publicKey ? (
              <ActionButton onClick={async () => {
                const cfg = payCfg.data[o.paymentMethod];
                if (o.paymentMethod === 'card') {
                  const r = await openCulqiCheckout({ publicKey: cfg.publicKey, amountCents: o.totalCents, title: `Pedido #${o.number}` });
                  await api.call('startPayment', { body: { orderId: o.id, providerToken: r.token }, idempotencyKey: `pay-${o.id}` });
                } else {
                  const p = await api.call('startPayment', { body: { orderId: o.id }, idempotencyKey: `pay-${o.id}` });
                  await openCulqiCheckout({ publicKey: cfg.publicKey, amountCents: o.totalCents, title: `Pedido #${o.number}`, orderReference: p.checkoutReference });
                }
                order.reload();
              }}>{o.paymentMethod === 'card' ? 'Pagar con tarjeta' : 'Pagar con Yape / Plin'}</ActionButton>
            ) : <div className="alert warn small">El proveedor de pagos aún no está configurado en este entorno.</div>
          )}
          {payCfg.data?.[o.paymentMethod]?.simulator && !o.latestPaymentId && <ActionButton onClick={async () => { await api.call('startPayment', { body: { orderId: o.id }, idempotencyKey: `pay-${o.id}` }); order.reload(); }}>Iniciar pago</ActionButton>}
        </div>
      )}
      {o.paymentStatus === 'en_conciliacion' && <div className="alert warn">Estamos confirmando tu pago con el proveedor. No vuelvas a pagar: no se hará un nuevo cargo hasta conciliar.</div>}

      {subs.map((s) => (
        <div key={s.id} className="card col">
          <h2>El comercio propone un ajuste</h2>
          <p>{s.kind === 'remove' ? 'Retirar un producto no disponible' : 'Sustituir un producto'} {s.note ? `· ${s.note}` : ''}. Diferencia: <Money cents={s.priceDiffCents} className="" /> {s.priceDiffCents < 0 ? '(se reembolsa si ya pagaste)' : ''}</p>
          <div className="row">
            <ActionButton onClick={async () => { await api.call('respondSubstitution', { params: { id: o.id, sid: s.id }, body: { accept: true } }); order.reload(); }}>Aceptar</ActionButton>
            <ActionButton className="ghost" onClick={async () => { await api.call('respondSubstitution', { params: { id: o.id, sid: s.id }, body: { accept: false } }); order.reload(); }}>Rechazar</ActionButton>
          </div>
        </div>
      ))}

      {live && (
        <div className="card col">
          <h2>Seguimiento</h2>
          {o.courier && <span>Repartidor: {o.courier.name} ({o.courier.vehicleType})</span>}
          {tracking?.available && tracking.lat != null && o.address ? (
            <>
              <MapView center={{ lat: tracking.lat, lng: tracking.lng! }} markers={[{ lat: tracking.lat, lng: tracking.lng!, label: 'Repartidor', color: '#f59e0b' }, { lat: o.address.lat, lng: o.address.lng, label: 'Tu dirección' }]} />
              <span className={`small ${tracking.stale ? '' : 'muted'}`}>
                Última ubicación: {new Date(tracking.recordedAt!).toLocaleTimeString('es-PE', { timeZone: 'America/Lima' })} (±{Math.round(tracking.accuracyM ?? 0)} m)
                {tracking.stale && <span className="badge warn"> desactualizada</span>}
              </span>
            </>
          ) : (
            <span className="muted">Ubicación no disponible por ahora. Se mostrará cuando el repartidor la comparta.</span>
          )}
          <div className="col">
            <button className="btn secondary" onClick={async () => setCode(await api.call('deliveryCode', { params: { id: o.id } }))}>Ver código de entrega</button>
            {code && <div className="alert ok"><strong style={{ fontSize: '1.6rem', letterSpacing: 6 }}>{code.code}</strong><div className="small">{code.note}</div></div>}
          </div>
        </div>
      )}

      <div className="card">
        <h2>Detalle</h2>
        {o.lines.map((l) => (
          <div key={l.id} className="product" style={l.removed ? { opacity: 0.5 } : undefined}>
            <span>{l.quantity} × {l.name} <span className="muted small">{l.variantName}</span>{l.removed && ' (retirado)'}{l.components.length > 0 && <span className="muted small"> — {l.components.map((c) => `${c.quantity} ${c.name}`).join(', ')}</span>}</span>
            <Money cents={l.lineTotalCents} />
          </div>
        ))}
        <div className="col small" style={{ marginTop: 8 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}><span>Productos</span><Money cents={o.subtotalCents} className="" /></div>
          {o.discountCents > 0 && <div className="row" style={{ justifyContent: 'space-between' }}><span>Descuento</span><Money cents={-o.discountCents} className="" /></div>}
          <div className="row" style={{ justifyContent: 'space-between' }}><span>Envío</span><Money cents={o.deliveryFeeCents} className="" /></div>
          {o.serviceFeeCents > 0 && <div className="row" style={{ justifyContent: 'space-between' }}><span>Servicio</span><Money cents={o.serviceFeeCents} className="" /></div>}
          {o.tipCents > 0 && <div className="row" style={{ justifyContent: 'space-between' }}><span>Propina</span><Money cents={o.tipCents} className="" /></div>}
          <div className="row" style={{ justifyContent: 'space-between' }}><strong>Total</strong><Money cents={o.totalCents} /></div>
          {o.refundedCents > 0 && <div className="row" style={{ justifyContent: 'space-between' }}><span>Reembolsado</span><Money cents={o.refundedCents} className="" /></div>}
        </div>
      </div>

      <div className="card">
        <h2>Cronología</h2>
        <ul className="timeline">
          {o.history.slice().reverse().map((h, i) => (
            <li key={i}>
              <strong>{(LABELS as any)[h.cycle]?.[h.to] ?? h.to}</strong> <span className="muted small">{new Date(h.at).toLocaleString('es-PE', { timeZone: 'America/Lima' })}</span>
              {h.reason && <div className="muted small">{h.reason}</div>}
            </li>
          ))}
        </ul>
      </div>

      {info && <div className="alert ok">{info}</div>}
      <div className="row">
        {o.canCancel && <ActionButton className="warn" confirm="¿Cancelar el pedido? Si ya pagaste, se solicitará el reembolso." onClick={async () => { await api.call('cancelOrder', { params: { id: o.id }, body: { reason: 'Cancelado por el cliente' } }); order.reload(); }}>Cancelar pedido</ActionButton>}
        <ActionButton className="secondary" onClick={async () => { const r = await api.call('reorder', { params: { id: o.id } }); setInfo(r.omitted ? `Se cargaron los productos disponibles (${r.omitted} ya no están disponibles).` : 'Productos cargados al carrito'); router.push('/carrito'); }}>Volver a pedir</ActionButton>
      </div>

      <div className="card col">
        <h2>Mensajes del pedido</h2>
        {(messages.data ?? []).map((m) => <div key={m.id} className={`alert ${m.mine ? 'ok' : 'info'} small`}><strong>{m.mine ? 'Tú' : m.sender_role}</strong>: {m.body}</div>)}
        <div className="row">
          <input aria-label="Mensaje" value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Escribe al comercio, repartidor o soporte" style={{ flex: 1 }} />
          <ActionButton className="sm" disabled={!msg.trim()} onClick={async () => { await api.call('sendOrderMessage', { params: { id: o.id }, body: { body: msg } }); setMsg(''); messages.reload(); }}>Enviar</ActionButton>
        </div>
      </div>

      <details className="card">
        <summary><strong>Reportar un problema</strong></summary>
        <div className="col">
          <select value={incident.kind} onChange={(e) => setIncident({ ...incident, kind: e.target.value })}>
            <option value="missing_item">Faltó un producto</option>
            <option value="damaged">Producto dañado</option>
            <option value="wrong_item">Producto equivocado</option>
            <option value="late">Demora</option>
            <option value="other">Otro</option>
          </select>
          <textarea value={incident.description} onChange={(e) => setIncident({ ...incident, description: e.target.value })} placeholder="Cuéntanos qué pasó" />
          <label className="small">Foto de evidencia (opcional, máx. 5 MB; solo la ve soporte)<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setEvidence(e.target.files?.[0] ?? null)} /></label>
          <ActionButton disabled={incident.description.length < 3} onClick={async () => {
            const ids: string[] = [];
            if (evidence) {
              const b64 = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] ?? ''); r.onerror = () => rej(r.error); r.readAsDataURL(evidence); });
              ids.push((await api.call('uploadFile', { body: { ownerType: 'incident', ownerId: o.id, contentBase64: b64 } })).id);
            }
            await api.call('reportIncident', { params: { id: o.id }, body: { ...incident, evidenceFileIds: ids } });
            setInfo('Reporte enviado. Soporte te responderá por los mensajes del pedido.');
            setIncident({ ...incident, description: '' });
            setEvidence(null);
          }}>Enviar reporte</ActionButton>
          <span className="muted small">¿Quieres registrar un reclamo formal? Usa el <a href="/reclamaciones">Libro de Reclamaciones</a>.</span>
        </div>
      </details>

      {o.canRate && (
        <details className="card">
          <summary><strong>Valorar pedido</strong></summary>
          <div className="col">
            <label>Comercio (1–5)<input type="number" min={1} max={5} value={rating.storeScore} onChange={(e) => setRating({ ...rating, storeScore: Number(e.target.value) })} /></label>
            <label>Repartidor (1–5)<input type="number" min={1} max={5} value={rating.courierScore} onChange={(e) => setRating({ ...rating, courierScore: Number(e.target.value) })} /></label>
            <textarea value={rating.comment} onChange={(e) => setRating({ ...rating, comment: e.target.value })} placeholder="Comentario (opcional)" />
            <ActionButton onClick={async () => { await api.call('rateOrder', { params: { id: o.id }, body: rating }); setInfo('¡Gracias por tu valoración!'); }}>Enviar valoración</ActionButton>
          </div>
        </details>
      )}
    </section>
  );
}
