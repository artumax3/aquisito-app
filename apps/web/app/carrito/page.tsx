'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { CartDto, QuoteDto } from '@aquisito/contracts';
import { newIdempotencyKey } from '@aquisito/api-client';
import { api, ApiError, errorMessage, useQuery } from '@/lib/api';
import { AlcoholNotices, Empty, ErrorBox, Loading, Money, useSession } from '@/components/ui';

export default function CartPage() {
  const { me, loading } = useSession();
  const router = useRouter();
  const cart = useQuery<CartDto>(me ? 'cart' : null, {}, [me?.id]);
  const addresses = useQuery<any[]>(me ? 'addresses' : null, {}, [me?.id]);
  const [addressId, setAddressId] = useState('');
  const [method, setMethod] = useState<'card' | 'wallet' | 'cash'>('card');
  const [tip, setTip] = useState(0); // sin propina preseleccionada
  const [coupon, setCoupon] = useState('');
  const [mode, setMode] = useState<'now' | 'later'>('now');
  const [slot, setSlot] = useState('');
  const [invoice, setInvoice] = useState<{ type: 'boleta' | 'factura'; docNumber?: string; name?: string }>({ type: 'boleta' });
  const [quote, setQuote] = useState<QuoteDto | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [terms, setTerms] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [changed, setChanged] = useState<string | null>(null);
  const [cashFor, setCashFor] = useState('');
  // Una clave por intento de confirmación: reintentos y dobles clics no duplican el pedido.
  const idemKey = useRef(newIdempotencyKey());
  const slots = useQuery<any[]>(cart.data?.branchId && mode === 'later' ? 'slots' : null, { params: { id: cart.data?.branchId ?? '' } });

  const cityAddresses = (addresses.data ?? []).filter((a) => a.inCoverage || true);
  useEffect(() => {
    if (!addressId && cityAddresses.length) setAddressId(cityAddresses.find((a) => a.inCoverage)?.id ?? cityAddresses[0].id);
  }, [cityAddresses, addressId]);

  async function requote() {
    setQuote(null);
    setQuoteErr(null);
    setChanged(null);
    if (!addressId || !cart.data?.lines.length) return;
    try {
      const q = await api.call('quote', { body: { addressId, paymentMethod: method, tipCents: tip, couponCode: coupon || undefined, scheduledSlotStart: mode === 'later' && slot ? slot : undefined } });
      setQuote(q);
      idemKey.current = newIdempotencyKey();
    } catch (e) {
      setQuoteErr(errorMessage(e));
    }
  }
  useEffect(() => {
    requote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addressId, method, tip, mode, slot, cart.data?.subtotalCents, cart.data?.lines.length]);

  async function setQty(index: number, quantity: number) {
    const c = cart.data!;
    const items = c.lines.map((l) => ({ variantId: l.variantId, quantity: l.index === index ? quantity : l.quantity, modifierOptionIds: l.modifierOptionIds, comboSelections: l.comboSelections, notes: l.notes ?? undefined })).filter((l) => l.quantity > 0);
    cart.setData(await api.call('putCart', { body: { branchId: c.branchId!, items, replaceOtherBranch: false } }));
  }

  async function place() {
    if (!quote) return;
    setPlacing(true);
    try {
      const order = await api.call('createOrder', {
        idempotencyKey: idemKey.current,
        body: { quoteId: quote.id, quoteVersion: quote.version, alcoholTermsAccepted: terms, invoice: { type: invoice.type, docType: invoice.type === 'factura' ? 'ruc' : invoice.docNumber ? 'dni' : undefined, docNumber: invoice.docNumber, name: invoice.name }, cashChangeForCents: method === 'cash' && cashFor ? Math.round(Number(cashFor) * 100) : undefined },
      });
      if (method === 'card' || method === 'wallet') {
        // Con el simulador de desarrollo se inicia el pago aquí; con un proveedor real el pago se
        // completa en el checkout del proveedor desde la página del pedido.
        const cfg = await api.call('paymentsConfig');
        if (cfg[method].simulator) await api.call('startPayment', { body: { orderId: order.id }, idempotencyKey: `pay-${order.id}` });
      }
      router.push(`/pedidos/${order.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'QUOTE_CHANGED') {
        const nq = (e.details as any).newQuote as QuoteDto;
        setQuote(nq);
        idemKey.current = newIdempotencyKey();
        setChanged(`El total cambió de S/ ${(quote.totalCents / 100).toFixed(2)} a S/ ${(nq.totalCents / 100).toFixed(2)}. Revisa el detalle y confirma de nuevo.`);
      } else setQuoteErr(errorMessage(e));
    } finally {
      setPlacing(false);
    }
  }

  if (loading) return <Loading />;
  if (!me) return <Empty>Inicia sesión para ver tu carrito. <Link href="/cuenta">Ingresar</Link></Empty>;
  if (cart.loading) return <Loading />;
  if (cart.error) return <ErrorBox error={cart.error} onRetry={cart.reload} />;
  const c = cart.data!;
  if (!c.lines.length) return <Empty>Tu carrito está vacío. <Link href="/">Explorar comercios</Link></Empty>;

  return (
    <section className="col" style={{ marginTop: 12 }}>
      <h1>Tu pedido en {c.branchName}</h1>
      <div className="card">
        {c.lines.map((l) => (
          <div key={l.index} className="product">
            <div className="col" style={{ gap: 2 }}>
              <strong>{l.name} <span className="muted small">{l.variantName}</span> {l.containsAlcohol && <span className="badge adult">18+</span>}</strong>
              {l.notes && <span className="small muted">Nota: {l.notes}</span>}
              {l.problem && <span className="badge danger">{l.problem}</span>}
            </div>
            <div className="row">
              <button className="btn sm ghost" aria-label="Quitar uno" onClick={() => setQty(l.index, l.quantity - 1)}>−</button>
              <span>{l.quantity}</span>
              <button className="btn sm ghost" aria-label="Agregar uno" onClick={() => setQty(l.index, l.quantity + 1)}>+</button>
              <Money cents={l.lineTotalCents} />
            </div>
          </div>
        ))}
        {c.problems.length > 0 && <div className="alert warn">{c.problems.join(' · ')}</div>}
      </div>

      <div className="card col">
        <h2>Entrega</h2>
        {addresses.data?.length ? (
          <select aria-label="Dirección" value={addressId} onChange={(e) => setAddressId(e.target.value)}>
            {addresses.data.map((a) => <option key={a.id} value={a.id}>{a.label}: {a.line1} {a.number ?? ''} {a.inCoverage ? '' : '— fuera de cobertura'}</option>)}
          </select>
        ) : <Link href="/cuenta#direcciones">Agrega una dirección con punto confirmado</Link>}
        <div className="row">
          <label className="check"><input type="radio" checked={mode === 'now'} onChange={() => setMode('now')} /> Lo antes posible</label>
          <label className="check"><input type="radio" checked={mode === 'later'} onChange={() => setMode('later')} /> Programar</label>
        </div>
        {mode === 'later' && (
          <select aria-label="Franja" value={slot} onChange={(e) => setSlot(e.target.value)}>
            <option value="">Elige una franja</option>
            {(slots.data ?? []).map((s) => (
              <option key={s.start} value={s.start} disabled={s.available <= 0}>
                {new Date(s.start).toLocaleString('es-PE', { timeZone: 'America/Lima', weekday: 'short', hour: '2-digit', minute: '2-digit' })} · {s.available > 0 ? `${s.available} cupos` : 'completa'}
              </option>
            ))}
          </select>
        )}
        {mode === 'later' && <p className="muted small">El stock se reserva y el pago se cobra al confirmar; el comercio revalida restricciones al preparar.</p>}
      </div>

      <div className="card col">
        <h2>Pago</h2>
        <div className="row">
          {(['card', 'wallet', 'cash'] as const).map((m) => (
            <label key={m} className="check"><input type="radio" checked={method === m} onChange={() => setMethod(m)} /> {m === 'card' ? 'Tarjeta' : m === 'wallet' ? 'Billetera móvil (Yape/Plin vía proveedor)' : 'Efectivo contra entrega'}</label>
          ))}
        </div>
        {method === 'cash' && <label>¿Con cuánto pagarás? (opcional, para el cambio)<input inputMode="decimal" value={cashFor} onChange={(e) => setCashFor(e.target.value)} placeholder="S/" /></label>}
        <label>Propina opcional (100% para el repartidor)
          <div className="row">
            {[0, 100, 200, 300, 500].map((t) => <button key={t} className={`chip light ${tip === t ? 'active' : ''}`} onClick={() => setTip(t)}>{t === 0 ? 'Sin propina' : `S/ ${(t / 100).toFixed(2)}`}</button>)}
          </div>
        </label>
        <div className="row">
          <input aria-label="Cupón" placeholder="Código de cupón" value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} style={{ maxWidth: 220 }} />
          <button className="btn sm secondary" onClick={requote}>Aplicar</button>
        </div>
        <details>
          <summary className="small">Datos para comprobante</summary>
          <div className="col">
            <select value={invoice.type} onChange={(e) => setInvoice({ ...invoice, type: e.target.value as any })}>
              <option value="boleta">Boleta</option>
              <option value="factura">Factura (RUC)</option>
            </select>
            <input placeholder={invoice.type === 'factura' ? 'RUC' : 'DNI (opcional)'} value={invoice.docNumber ?? ''} onChange={(e) => setInvoice({ ...invoice, docNumber: e.target.value })} />
            <input placeholder={invoice.type === 'factura' ? 'Razón social' : 'Nombre (opcional)'} value={invoice.name ?? ''} onChange={(e) => setInvoice({ ...invoice, name: e.target.value })} />
            <p className="muted small">La emisión electrónica ante SUNAT está pendiente de integrar con un proveedor autorizado.</p>
          </div>
        </details>
      </div>

      <div className="card col" aria-live="polite">
        <h2>Resumen</h2>
        {quoteErr && <div className="alert error">{quoteErr}</div>}
        {changed && <div className="alert warn">{changed}</div>}
        {!quote && !quoteErr && <Loading lines={1} />}
        {quote && (
          <>
            {quote.breakdown.map((b) => <div key={b.label} className="row" style={{ justifyContent: 'space-between' }}><span>{b.label}</span><Money cents={b.amountCents} className="" /></div>)}
            <div className="row" style={{ justifyContent: 'space-between', fontSize: '1.15rem' }}><strong>Total</strong><Money cents={quote.totalCents} /></div>
            <span className="muted small">Llega en {quote.etaMinutes.min}–{quote.etaMinutes.max} min (estimación). Cotización v{quote.version}, válida hasta {new Date(quote.expiresAt).toLocaleTimeString('es-PE', { timeZone: 'America/Lima' })}.</span>
            {quote.containsAlcohol && (
              <>
                <AlcoholNotices />
                <div className="alert warn small">{quote.alcoholNotice}</div>
                <label className="check"><input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} /> Mostraré mi documento de identidad al recibir y acepto la política de retorno si la verificación falla.</label>
              </>
            )}
            <button className="btn block" disabled={placing || (quote.containsAlcohol && !terms)} onClick={place}>{placing ? 'Confirmando…' : `Confirmar pedido · S/ ${(quote.totalCents / 100).toFixed(2)}`}</button>
          </>
        )}
      </div>
    </section>
  );
}
