'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { OrderDto } from '@aquisito/contracts';
import { api, errorMessage, useQuery, useRealtime } from '@/lib/api';
import { ActionButton, Empty, ErrorBox, Loading, Money, StatusBadge, useSession } from '@/components/ui';
import { DocumentList, DocumentUploader } from '@/components/upload';

const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

export default function MerchantPanel() {
  const { me, has, loading } = useSession();
  const branches = useQuery<any[]>(me && (has('merchant_owner') || has('branch_operator')) ? 'merchantBranches' : null, {}, [me?.id]);
  const [branchId, setBranchId] = useState('');
  const [tab, setTab] = useState<'orders' | 'catalog' | 'combos' | 'hours' | 'reports' | 'docs'>('orders');
  useEffect(() => {
    if (!branchId && branches.data?.length) setBranchId(branches.data[0].id);
  }, [branches.data, branchId]);
  if (loading) return <Loading />;
  if (!me) return <Empty>Ingresa con tu cuenta de comercio. <Link href="/cuenta">Ingresar</Link></Empty>;
  if (!has('merchant_owner') && !has('branch_operator')) return <Empty>Tu cuenta no administra comercios. <Link href="/comercio/alta">Registrar mi negocio</Link></Empty>;
  if (branches.loading) return <Loading />;
  const b = branches.data?.find((x) => x.id === branchId);
  return (
    <section className="col" style={{ marginTop: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Panel del comercio</h1>
        <select aria-label="Sucursal" value={branchId} onChange={(e) => setBranchId(e.target.value)} style={{ maxWidth: 360 }}>
          {branches.data?.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.city_name}</option>)}
        </select>
      </div>
      {b && b.merchant_status !== 'approved' && <div className="alert warn">Tu comercio está en revisión ({b.merchant_status}). Se publicará después de la aprobación.</div>}
      {b?.paused && <div className="alert warn">Sucursal pausada: {b.pause_reason}</div>}
      <div className="tabs">
        {(['orders', 'catalog', 'combos', 'hours', 'reports', 'docs'] as const).map((t) => (
          <button key={t} className={`chip light ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{{ orders: 'Pedidos', catalog: 'Catálogo y stock', combos: 'Combos', hours: 'Horarios y pausa', reports: 'Ventas y liquidaciones', docs: 'Documentos' }[t]}</button>
        ))}
      </div>
      {branchId && tab === 'orders' && <Inbox branchId={branchId} />}
      {branchId && tab === 'catalog' && <Catalog branchId={branchId} />}
      {branchId && tab === 'combos' && <Combos branchId={branchId} />}
      {branchId && tab === 'hours' && <Hours branchId={branchId} paused={!!b?.paused} onChange={branches.reload} isOwner={!!b?.is_owner} />}
      {branchId && tab === 'reports' && <Reports branchId={branchId} />}
      {branchId && tab === 'docs' && b && <Docs branchId={branchId} merchantId={b.merchant_id} isOwner={!!b.is_owner} alcohol={b.alcohol_permit_status} />}
    </section>
  );
}

function Inbox({ branchId }: { branchId: string }) {
  const [scope, setScope] = useState<'active' | 'history'>('active');
  const orders = useQuery<OrderDto[]>('merchantOrders', { params: { id: branchId }, query: { scope } });
  const [alertOn, setAlertOn] = useState(false);
  const prevCount = useRef(0);
  useRealtime(() => orders.reload());
  useEffect(() => {
    const pending = (orders.data ?? []).filter((o) => o.commercialStatus === 'confirmado').length;
    if (pending > prevCount.current && alertOn) {
      try {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        osc.connect(ctx.destination);
        osc.frequency.value = 880;
        osc.start();
        setTimeout(() => osc.stop(), 400);
      } catch {
        /* sin audio */
      }
    }
    prevCount.current = pending;
  }, [orders.data, alertOn]);

  return (
    <div className="col">
      <div className="row">
        <button className={`chip light ${scope === 'active' ? 'active' : ''}`} onClick={() => setScope('active')}>En curso</button>
        <button className={`chip light ${scope === 'history' ? 'active' : ''}`} onClick={() => setScope('history')}>Historial</button>
        <label className="check small"><input type="checkbox" checked={alertOn} onChange={(e) => setAlertOn(e.target.checked)} /> Aviso sonoro de pedidos nuevos</label>
        <button className="btn sm ghost" onClick={orders.reload}>Actualizar</button>
      </div>
      {orders.loading && <Loading />}
      <ErrorBox error={orders.error} onRetry={orders.reload} />
      {!orders.loading && !orders.data?.length && <Empty>No hay pedidos {scope === 'active' ? 'en curso' : 'en el historial'}.</Empty>}
      {orders.data?.map((o) => <MerchantOrder key={o.id} o={o} reload={orders.reload} />)}
    </div>
  );
}

function MerchantOrder({ o, reload }: { o: OrderDto; reload: () => void }) {
  const [reason, setReason] = useState('');
  const [prep, setPrep] = useState(20);
  const [restock, setRestock] = useState(true);
  const [notes, setNotes] = useState('');
  const run = (fn: () => Promise<unknown>) => async () => { await fn(); reload(); };
  const secondsLeft = o.acceptDeadline ? Math.round((new Date(o.acceptDeadline).getTime() - Date.now()) / 1000) : null;
  return (
    <div className="card col">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>#{o.number} {o.scheduledFor && <span className="badge warn">Programado {new Date(o.scheduledFor).toLocaleString('es-PE', { timeZone: 'America/Lima', weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>} {o.containsAlcohol && <span className="badge adult">Alcohol: entrega con verificación</span>}</strong>
        <Money cents={o.subtotalCents} />
      </div>
      <div className="row">
        <StatusBadge cycle="commercial" status={o.commercialStatus} />
        <StatusBadge cycle="delivery" status={o.deliveryStatus} />
        <StatusBadge cycle="payment" status={o.paymentStatus} />
        <span className="small muted">Código de recojo: <strong>{o.pickupCode}</strong></span>
      </div>
      {o.lines.map((l) => (
        <div key={l.id} className="small" style={l.removed ? { textDecoration: 'line-through' } : undefined}>
          {l.quantity} × {l.name} ({l.variantName}){l.notes && <em> · Nota: {l.notes}</em>}{l.components.length > 0 && <span className="muted"> — {l.components.map((c) => `${c.quantity} ${c.name}`).join(', ')}</span>}
          {['confirmado', 'aceptado_comercio'].includes(o.commercialStatus) && !l.removed && (
            <button className="btn sm ghost" style={{ marginLeft: 6 }} onClick={run(() => api.call('merchantSubstitution', { params: { id: o.id }, body: { orderLineId: l.id, kind: 'remove', note: 'Producto no disponible' } }))}>Faltante: proponer retiro</button>
          )}
        </div>
      ))}
      {o.substitutions.filter((s) => s.status === 'pending').length > 0 && <div className="alert warn small">Esperando respuesta del cliente al ajuste propuesto.</div>}
      <div className="row">
        {o.commercialStatus === 'confirmado' && (
          <>
            <ActionButton onClick={run(() => api.call('merchantAccept', { params: { id: o.id } }))}>Aceptar</ActionButton>
            <input placeholder="Motivo de rechazo" value={reason} onChange={(e) => setReason(e.target.value)} style={{ maxWidth: 240 }} />
            <ActionButton className="warn" disabled={reason.length < 3} onClick={run(() => api.call('merchantReject', { params: { id: o.id }, body: { reason } }))}>Rechazar</ActionButton>
            {secondsLeft !== null && <span className="small muted">{secondsLeft > 0 ? `Vence en ${Math.ceil(secondsLeft / 60)} min; si no respondes, se rechaza y se reembolsa.` : 'Plazo vencido'}</span>}
          </>
        )}
        {o.commercialStatus === 'aceptado_comercio' && <ActionButton onClick={run(() => api.call('merchantStart', { params: { id: o.id } }))}>Iniciar preparación</ActionButton>}
        {['aceptado_comercio', 'en_preparacion'].includes(o.commercialStatus) && (
          <span className="row"><input type="number" min={1} max={240} value={prep} onChange={(e) => setPrep(Number(e.target.value))} style={{ width: 90 }} aria-label="Minutos" /><ActionButton className="ghost sm" onClick={run(() => api.call('merchantEta', { params: { id: o.id }, body: { prepMinutes: prep } }))}>Ajustar estimación</ActionButton></span>
        )}
        {o.commercialStatus === 'en_preparacion' && <ActionButton onClick={run(() => api.call('merchantReady', { params: { id: o.id } }))}>Marcar listo</ActionButton>}
        <a className="btn sm ghost" href={`/api/merchant/orders/${o.id}/ticket`} target="_blank" rel="noreferrer">Imprimir comanda</a>
      </div>
      {o.deliveryStatus === 'retorno_pendiente' && (
        <div className="col alert warn">
          <strong>Devolución en camino</strong>
          <label className="check"><input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} /> Tras inspección, los productos vuelven a stock vendible</label>
          <input placeholder="Notas de inspección" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <ActionButton disabled={notes.length < 3} onClick={run(() => api.call('merchantReturnInspection', { params: { id: o.id }, body: { restockSellable: restock, notes } }))}>Confirmar recepción</ActionButton>
        </div>
      )}
    </div>
  );
}

function Catalog({ branchId }: { branchId: string }) {
  const cat = useQuery<any>('merchantCatalog', { params: { id: branchId } });
  const [adj, setAdj] = useState<Record<string, string>>({});
  const [np, setNp] = useState({ categoryId: '', name: '', description: '', kind: 'prepared', price: '', unit: '', stock: '', containsAlcohol: false });
  const [err, setErr] = useState<string | null>(null);
  if (cat.loading) return <Loading />;
  if (cat.error) return <ErrorBox error={cat.error} onRetry={cat.reload} />;
  const c = cat.data;
  return (
    <div className="col">
      <div className="card">
        <h2>Inventario por SKU</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>SKU</th><th>Unidad</th><th>Físico</th><th>Reservado</th><th>Disponible</th><th>Ajuste</th></tr></thead>
          <tbody>
            {c.skus.map((s: any) => (
              <tr key={s.id}>
                <td>{s.name} {s.containsAlcohol && <span className="badge adult">18+</span>}</td><td>{s.unit}</td><td>{s.onHand}</td><td>{s.reserved}</td><td><strong>{s.available}</strong>{s.available === 0 && <span className="badge danger"> agotado</span>}</td>
                <td className="row">
                  <input style={{ width: 80 }} inputMode="numeric" placeholder="±" value={adj[s.id] ?? ''} onChange={(e) => setAdj({ ...adj, [s.id]: e.target.value })} aria-label={`Ajuste ${s.name}`} />
                  <ActionButton className="sm" disabled={!adj[s.id]} onClick={async () => { await api.call('merchantStock', { params: { id: s.id }, body: { delta: Number(adj[s.id]), reason: 'Ajuste manual desde panel' } }); setAdj({ ...adj, [s.id]: '' }); cat.reload(); }}>Aplicar</ActionButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>
      <div className="card">
        <h2>Productos</h2>
        <p className="muted small">Los cambios de precio aplican a nuevas cotizaciones; los pedidos confirmados conservan su precio.</p>
        {err && <div className="alert error">{err}</div>}
        {c.products.map((p: any) => (
          <div key={p.id} className="product">
            <span>{p.name} <span className="muted small">· {p.categoryName} · {p.kind === 'prepared' ? 'plato preparado' : p.kind === 'stock' ? 'inventario físico' : 'combo'}</span> {p.containsAlcohol && <span className="badge adult">18+</span>}</span>
            <span className="row">
              {p.variants.map((v: any) => (
                <label key={v.id} className="small" style={{ maxWidth: 130 }}>{p.variants.length > 1 ? v.name : 'Precio'} S/
                  <input defaultValue={(v.priceCents / 100).toFixed(2)} inputMode="decimal" onBlur={async (e) => {
                    const cents = Math.round(Number(e.target.value) * 100);
                    if (!cents || cents === v.priceCents) return;
                    try { await api.call('merchantPatchProduct', { params: { id: p.id }, body: { priceByVariant: { [v.id]: cents } } }); cat.reload(); } catch (x) { setErr(errorMessage(x)); }
                  }} aria-label={`Precio de ${p.name} ${v.name}`} />
                </label>
              ))}
              <ActionButton className="sm ghost" onClick={async () => { await api.call('merchantPatchProduct', { params: { id: p.id }, body: { active: !p.available } }); cat.reload(); }}>{p.available ? 'Desactivar' : 'Activar'}</ActionButton>
            </span>
          </div>
        ))}
      </div>
      <div className="card col">
        <h2>Nuevo producto</h2>
        <select value={np.categoryId} onChange={(e) => setNp({ ...np, categoryId: e.target.value })}><option value="">Categoría</option>{c.categories.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        <input placeholder="Nombre" value={np.name} onChange={(e) => setNp({ ...np, name: e.target.value })} />
        <input placeholder="Descripción" value={np.description} onChange={(e) => setNp({ ...np, description: e.target.value })} />
        <select value={np.kind} onChange={(e) => setNp({ ...np, kind: e.target.value })}><option value="prepared">Plato preparado (sin inventario)</option><option value="stock">Artículo con inventario físico</option></select>
        <input placeholder="Precio final (S/)" inputMode="decimal" value={np.price} onChange={(e) => setNp({ ...np, price: e.target.value })} />
        {np.kind === 'stock' && <><input placeholder="Unidad (p. ej. botella 500 ml)" value={np.unit} onChange={(e) => setNp({ ...np, unit: e.target.value })} /><input placeholder="Stock inicial" inputMode="numeric" value={np.stock} onChange={(e) => setNp({ ...np, stock: e.target.value })} /></>}
        <label className="check"><input type="checkbox" checked={np.containsAlcohol} onChange={(e) => setNp({ ...np, containsAlcohol: e.target.checked })} /> Contiene alcohol (requiere habilitación aprobada)</label>
        {err && <div className="alert error">{err}</div>}
        <button className="btn" onClick={async () => {
          setErr(null);
          try {
            await api.call('merchantCreateProduct', { params: { id: branchId }, body: { categoryId: np.categoryId, name: np.name, description: np.description, kind: np.kind as any, containsAlcohol: np.containsAlcohol, variants: [{ name: np.kind === 'stock' ? np.unit : 'Único', priceCents: Math.round(Number(np.price) * 100), unit: np.unit || undefined, initialStock: np.stock ? Number(np.stock) : undefined }] } });
            setNp({ ...np, name: '', description: '', price: '', stock: '' });
            cat.reload();
          } catch (e) { setErr(errorMessage(e)); }
        }}>Crear producto</button>
      </div>
    </div>
  );
}

function Combos({ branchId }: { branchId: string }) {
  const cat = useQuery<any>('merchantCatalog', { params: { id: branchId } });
  const [f, setF] = useState({ categoryId: '', name: '', description: '', price: '', quota: '', perCustomer: '' });
  const [comps, setComps] = useState<{ label: string; quantity: number; eligibleVariantIds: string[] }[]>([{ label: '', quantity: 1, eligibleVariantIds: [] }]);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  if (cat.loading) return <Loading />;
  const variants = (cat.data?.products ?? []).filter((p: any) => p.kind !== 'combo').flatMap((p: any) => p.variants.map((v: any) => ({ id: v.id, label: `${p.name} ${v.name}`, price: v.priceCents })));
  const reference = comps.every((c) => c.eligibleVariantIds.length)
    ? comps.reduce((s, c) => s + c.quantity * Math.min(...c.eligibleVariantIds.map((id) => variants.find((v: any) => v.id === id)?.price ?? 0)), 0)
    : null;
  return (
    <div className="card col">
      <h2>Constructor de combos</h2>
      <p className="muted small">Cada componente consume stock real de sus SKU. Si algún componente contiene alcohol, el combo queda restringido a adultos verificados automáticamente.</p>
      <select value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}><option value="">Categoría</option>{cat.data?.categories.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
      <input placeholder="Nombre del combo" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <input placeholder="Descripción con contenido exacto" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      {comps.map((c, i) => (
        <div key={i} className="col" style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 8 }}>
          <div className="row">
            <input placeholder="Etiqueta del componente" value={c.label} onChange={(e) => setComps(comps.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} style={{ flex: 1 }} />
            <input type="number" min={1} value={c.quantity} onChange={(e) => setComps(comps.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) } : x)))} style={{ width: 80 }} aria-label="Cantidad" />
          </div>
          <select multiple value={c.eligibleVariantIds} onChange={(e) => setComps(comps.map((x, j) => (j === i ? { ...x, eligibleVariantIds: [...e.target.selectedOptions].map((o) => o.value) } : x)))} style={{ minHeight: 90 }} aria-label="Variantes elegibles">
            {variants.map((v: any) => <option key={v.id} value={v.id}>{v.label} · S/ {(v.price / 100).toFixed(2)}</option>)}
          </select>
        </div>
      ))}
      <button className="btn sm ghost" onClick={() => setComps([...comps, { label: '', quantity: 1, eligibleVariantIds: [] }])}>+ Componente</button>
      <div className="row">
        <input placeholder="Precio del combo (S/)" inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />
        <input placeholder="Cupo total (opcional)" inputMode="numeric" value={f.quota} onChange={(e) => setF({ ...f, quota: e.target.value })} />
        <input placeholder="Límite por cliente (opcional)" inputMode="numeric" value={f.perCustomer} onChange={(e) => setF({ ...f, perCustomer: e.target.value })} />
      </div>
      {reference !== null && <span className="small muted">Precio de referencia comprobable (suma de precios vigentes más bajos): S/ {(reference / 100).toFixed(2)}</span>}
      {err && <div className="alert error">{err}</div>}
      {ok && <div className="alert ok">{ok}</div>}
      <button className="btn" onClick={async () => {
        setErr(null);
        try {
          const r = await api.call('merchantCreateCombo', { params: { id: branchId }, body: { categoryId: f.categoryId, name: f.name, description: f.description, priceCents: Math.round(Number(f.price) * 100), quotaTotal: f.quota ? Number(f.quota) : undefined, perCustomerLimit: f.perCustomer ? Number(f.perCustomer) : undefined, discountFundedBy: 'merchant', components: comps } });
          setOk(r.containsAlcohol ? 'Combo creado. Contiene alcohol: visible solo para adultos verificados.' : 'Combo creado.');
          cat.reload();
        } catch (e) { setErr(errorMessage(e)); }
      }}>Crear combo</button>
    </div>
  );
}

function Hours({ branchId, paused, onChange, isOwner }: { branchId: string; paused: boolean; onChange: () => void; isOwner: boolean }) {
  const store = useQuery<any>('store', { params: { id: branchId } });
  const [rows, setRows] = useState<{ weekday: number; opens: string; closes: string }[] | null>(null);
  const [reason, setReason] = useState('');
  const [closure, setClosure] = useState({ startsAt: '', endsAt: '', reason: '' });
  const [opEmail, setOpEmail] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (store.data && !rows) setRows(store.data.hours);
  }, [store.data, rows]);
  return (
    <div className="col">
      <div className="card col">
        <h2>Horario semanal</h2>
        <p className="muted small">Si el cierre es menor o igual a la apertura, la franja cruza la medianoche (p. ej. 18:00–02:00).</p>
        {(rows ?? []).map((r, i) => (
          <div key={i} className="row">
            <select value={r.weekday} onChange={(e) => setRows(rows!.map((x, j) => (j === i ? { ...x, weekday: Number(e.target.value) } : x)))} style={{ width: 100 }}>{DAYS.map((d, k) => <option key={k} value={k}>{d}</option>)}</select>
            <input type="time" value={r.opens} onChange={(e) => setRows(rows!.map((x, j) => (j === i ? { ...x, opens: e.target.value } : x)))} style={{ width: 130 }} />
            <input type="time" value={r.closes} onChange={(e) => setRows(rows!.map((x, j) => (j === i ? { ...x, closes: e.target.value } : x)))} style={{ width: 130 }} />
            <button className="btn sm ghost" onClick={() => setRows(rows!.filter((_, j) => j !== i))}>Quitar</button>
          </div>
        ))}
        <div className="row">
          <button className="btn sm ghost" onClick={() => setRows([...(rows ?? []), { weekday: 1, opens: '09:00', closes: '21:00' }])}>+ Franja</button>
          <ActionButton onClick={async () => { await api.call('merchantHours', { params: { id: branchId }, body: { hours: rows ?? [] } }); setMsg('Horario guardado'); }}>Guardar horario</ActionButton>
        </div>
      </div>
      <div className="card col">
        <h2>Cierre especial</h2>
        <div className="row">
          <input type="datetime-local" value={closure.startsAt} onChange={(e) => setClosure({ ...closure, startsAt: e.target.value })} />
          <input type="datetime-local" value={closure.endsAt} onChange={(e) => setClosure({ ...closure, endsAt: e.target.value })} />
        </div>
        <input placeholder="Motivo" value={closure.reason} onChange={(e) => setClosure({ ...closure, reason: e.target.value })} />
        <ActionButton disabled={!closure.startsAt || !closure.endsAt || closure.reason.length < 3} onClick={async () => { await api.call('merchantClosure', { params: { id: branchId }, body: { startsAt: new Date(closure.startsAt).toISOString(), endsAt: new Date(closure.endsAt).toISOString(), reason: closure.reason } }); setMsg('Cierre registrado'); }}>Registrar cierre</ActionButton>
      </div>
      <div className="card col">
        <h2>{paused ? 'Reanudar sucursal' : 'Pausar sucursal'}</h2>
        <input placeholder="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} />
        <ActionButton className={paused ? '' : 'warn'} disabled={reason.length < 3} onClick={async () => { await api.call('merchantPause', { params: { id: branchId }, body: { paused: !paused, reason } }); onChange(); }}>{paused ? 'Reanudar' : 'Pausar'}</ActionButton>
      </div>
      {isOwner && (
        <div className="card col">
          <h2>Operadores (cada uno con su cuenta)</h2>
          <input type="email" placeholder="Correo de la persona (debe tener cuenta)" value={opEmail} onChange={(e) => setOpEmail(e.target.value)} />
          <ActionButton onClick={async () => { await api.call('merchantOperators', { params: { id: branchId }, body: { email: opEmail } }); setMsg('Operador agregado'); }}>Agregar operador</ActionButton>
        </div>
      )}
      {msg && <div className="alert ok">{msg}</div>}
    </div>
  );
}

function Reports({ branchId }: { branchId: string }) {
  const r = useQuery<any>('merchantReport', { params: { id: branchId } });
  if (r.loading) return <Loading />;
  if (r.error) return <ErrorBox error={r.error} />;
  const d = r.data;
  return (
    <div className="col">
      <div className="grid">
        <div className="card"><div className="muted small">Pedidos completados</div><div className="kpi">{d.completedOrders}</div></div>
        <div className="card"><div className="muted small">Cancelados / rechazados</div><div className="kpi">{d.cancelledOrders}</div></div>
        <div className="card"><div className="muted small">Ventas de productos</div><div className="kpi"><Money cents={d.grossProductsCents} className="" /></div></div>
        <div className="card"><div className="muted small">Neto según libro (ventas − comisión − ajustes)</div><div className="kpi"><Money cents={d.netCents} className="" /></div></div>
      </div>
      <div className="card small">
        {Object.entries(d.ledger).map(([k, v]) => <div key={k} className="row" style={{ justifyContent: 'space-between' }}><span>{k}</span><Money cents={v as number} className="" /></div>)}
        <p className="muted">Período {new Date(d.period.from).toLocaleDateString('es-PE')} – {new Date(d.period.to).toLocaleDateString('es-PE')} ({d.period.timezone}).</p>
        <a className="btn sm secondary" href={`/api/merchant/branches/${branchId}/export.csv`}>Exportar CSV</a>
      </div>
      <div className="card">
        <h2>Liquidaciones</h2>
        {!d.settlements.length && <span className="muted">Aún no hay liquidaciones.</span>}
        {d.settlements.map((s: any) => <div key={s.id} className="row small" style={{ justifyContent: 'space-between' }}><span>{new Date(s.period_start).toLocaleDateString('es-PE')} – {new Date(s.period_end).toLocaleDateString('es-PE')} · {s.status}</span><Money cents={s.total_cents} /></div>)}
      </div>
    </div>
  );
}

function Docs({ branchId, merchantId, isOwner, alcohol }: { branchId: string; merchantId: string; isOwner: boolean; alcohol: string }) {
  const docs = useQuery<any[]>('merchantDocuments', { params: { id: branchId } });
  return (
    <div className="col">
      <div className="card col">
        <h2>Estado de habilitación para alcohol</h2>
        <span>{{ none: 'No solicitada', pending: 'En revisión', approved: 'Aprobada', rejected: 'Rechazada', expired: 'Vencida: venta suspendida', suspended: 'Suspendida' }[alcohol] ?? alcohol}</span>
        <span className="muted small">Para vender bebidas alcohólicas sube la autorización vigente; el equipo la revisa manualmente y la habilitación vence con el documento.</span>
      </div>
      <div className="card col">
        <h2>Documentos</h2>
        {docs.loading ? <Loading /> : <DocumentList docs={docs.data ?? []} />}
      </div>
      {isOwner ? (
        <>
          <div className="card col"><h3>Documentos de la sucursal</h3><DocumentUploader ownerType="branch" ownerId={branchId} kinds={['licencia_funcionamiento', 'autorizacion_alcohol', 'certificado_defensa_civil', 'otro']} onDone={docs.reload} /></div>
          <div className="card col"><h3>Documentos del comercio</h3><DocumentUploader ownerType="merchant" ownerId={merchantId} kinds={['ruc', 'representante_legal', 'cuenta_liquidacion', 'licencia_funcionamiento', 'otro']} onDone={docs.reload} /></div>
        </>
      ) : <span className="muted small">Solo el propietario sube documentos.</span>}
    </div>
  );
}
