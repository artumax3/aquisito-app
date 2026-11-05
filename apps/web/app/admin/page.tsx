'use client';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useState } from 'react';
import type { CityDto } from '@aquisito/contracts';
import { ApiError, api, errorMessage, useQuery, useRealtime } from '@/lib/api';
import { ActionButton, Empty, ErrorBox, Loading, Money, StatusBadge, useSession } from '@/components/ui';
import { kindLabel } from '@/components/upload';

const MapView = dynamic(() => import('@/components/map').then((m) => m.MapView), { ssr: false });

type Tab = 'dash' | 'orders' | 'couriers' | 'merchants' | 'docs' | 'age' | 'cities' | 'promos' | 'banners' | 'finance' | 'support' | 'privacy' | 'roles' | 'audit';
const TABS: [Tab, string][] = [['dash', 'Indicadores'], ['orders', 'Pedidos y despacho'], ['couriers', 'Repartidores'], ['merchants', 'Comercios'], ['docs', 'Documentos'], ['age', 'Verificación de edad'], ['cities', 'Ciudades, zonas y alcohol'], ['promos', 'Cupones'], ['banners', 'Banners'], ['finance', 'Finanzas'], ['support', 'Incidencias y reclamaciones'], ['privacy', 'Datos personales'], ['roles', 'Roles y accesos'], ['audit', 'Auditoría y eventos']];

export default function AdminPage() {
  const { me, has, loading } = useSession();
  const [tab, setTab] = useState<Tab>('dash');
  if (loading) return <Loading />;
  if (!me) return <Empty>Ingresa con una cuenta de operación. <Link href="/cuenta">Ingresar</Link></Empty>;
  const staff = ['admin', 'city_dispatcher', 'support_agent', 'finance'].some(has);
  if (!staff) return <Empty>Tu cuenta no tiene permisos de administración.</Empty>;
  const needsMfa = (has('admin') || has('finance')) && !me.mfaVerified;
  return (
    <section className="col" style={{ marginTop: 12 }}>
      <h1>Administración</h1>
      {needsMfa && <div className="alert warn">Las operaciones de administración y finanzas requieren verificación en dos pasos. <Link href="/cuenta">Verificar ahora</Link></div>}
      <div className="tabs">{TABS.map(([k, l]) => <button key={k} className={`chip light ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === 'dash' && <Dashboard />}
      {tab === 'orders' && <Orders />}
      {tab === 'couriers' && <Couriers />}
      {tab === 'merchants' && <Merchants />}
      {tab === 'age' && <AgeQueue />}
      {tab === 'cities' && <><Cities /><CityConfig /></>}
      {tab === 'promos' && <Coupons />}
      {tab === 'banners' && <Banners />}
      {tab === 'docs' && <Documents />}
      {tab === 'finance' && <><Finance /><FinanceOps /></>}
      {tab === 'support' && <Support />}
      {tab === 'privacy' && <Privacy />}
      {tab === 'roles' && <RolesAdmin />}
      {tab === 'audit' && <Audit />}
    </section>
  );
}

function Guard({ q, children }: { q: { loading: boolean; error: unknown; reload: () => void }; children: React.ReactNode }) {
  if (q.loading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  return <>{children}</>;
}

function Dashboard() {
  const d = useQuery<any>('adminDashboard');
  return (
    <Guard q={d}>
      {d.data && (
        <div className="col">
          <p className="muted small">Período {new Date(d.data.period.from).toLocaleDateString('es-PE')} – {new Date(d.data.period.to).toLocaleDateString('es-PE')} ({d.data.period.timezone}). Definiciones en docs/indicadores.md. El valor bruto vendido NO es ingreso de la plataforma.</p>
          {d.data.cities.map((c: any) => (
            <div key={c.cityId} className="card col">
              <h2>{c.city}</h2>
              <div className="grid">
                <Kpi label="Pedidos" v={c.orders} />
                <Kpi label="Completados" v={c.completed} />
                <Kpi label="Cancelación" v={`${(c.cancellationRate * 100).toFixed(1)}%`} />
                <Kpi label="Valor bruto vendido (productos)" v={<Money cents={c.gmvCents} className="" />} />
                <Kpi label="Comisión de plataforma (ingreso)" v={<Money cents={c.platformCommissionCents} className="" />} />
                <Kpi label="Ticket promedio" v={<Money cents={c.avgTicketCents} className="" />} />
                <Kpi label="Reembolsado" v={<Money cents={c.refundedCents} className="" />} />
                <Kpi label="Mediana aceptación (min)" v={c.medianAcceptMinutes ?? '—'} />
                <Kpi label="Mediana preparación (min)" v={c.medianPrepMinutes ?? '—'} />
                <Kpi label="Mediana entrega (min)" v={c.medianDeliveryMinutes ?? '—'} />
                <Kpi label="Recompra" v={`${(c.repurchaseRate * 100).toFixed(0)}%`} />
              </div>
            </div>
          ))}
          <div className="card col">
            <h2>Salud operativa</h2>
            <div className="grid">{Object.entries(d.data.operations).map(([k, v]) => <Kpi key={k} label={k} v={v as any} />)}</div>
          </div>
          <a className="btn sm secondary" href="/api/admin/export/orders.csv">Exportar pedidos (CSV, sin datos personales)</a>
        </div>
      )}
    </Guard>
  );
}
const Kpi = ({ label, v }: { label: string; v: React.ReactNode }) => <div className="card"><div className="muted small">{label}</div><div className="kpi">{v}</div></div>;

function Orders() {
  const [filters, setFilters] = useState<Record<string, string>>({ active: 'true' });
  const cities = useQuery<CityDto[]>('cities');
  const orders = useQuery<any[]>('adminOrders', { query: filters });
  const couriers = useQuery<any[]>('adminCouriers');
  const [detail, setDetail] = useState<any>(null);
  const [assign, setAssign] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  useRealtime(() => orders.reload());
  const set = (k: string, v: string) => setFilters({ ...filters, [k]: v });
  return (
    <div className="col">
      <div className="row">
        <select value={filters.cityId ?? ''} onChange={(e) => set('cityId', e.target.value)}><option value="">Todas las ciudades</option>{cities.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <select value={filters.status ?? ''} onChange={(e) => set('status', e.target.value)}><option value="">Estado comercial</option>{['pendiente_confirmacion', 'confirmado', 'aceptado_comercio', 'en_preparacion', 'listo_para_recojo', 'completado', 'cancelado', 'rechazado_comercio'].map((s) => <option key={s}>{s}</option>)}</select>
        <select value={filters.payment ?? ''} onChange={(e) => set('payment', e.target.value)}><option value="">Pago</option>{['pendiente', 'pagado', 'en_conciliacion', 'fallido', 'vencido', 'reembolso_pendiente', 'reembolsado'].map((s) => <option key={s}>{s}</option>)}</select>
        <select value={filters.courierId ?? ''} onChange={(e) => set('courierId', e.target.value)}><option value="">Repartidor</option>{couriers.data?.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}</select>
        <label className="check small"><input type="checkbox" checked={filters.active === 'true'} onChange={(e) => set('active', e.target.checked ? 'true' : '')} /> Solo activos</label>
        <label className="check small"><input type="checkbox" checked={filters.incidents === 'true'} onChange={(e) => set('incidents', e.target.checked ? 'true' : '')} /> Con incidencias</label>
      </div>
      <Guard q={orders}>
        <div className="table-wrap"><table>
          <thead><tr><th>#</th><th>Sucursal</th><th>Estados</th><th>Total</th><th>Despacho</th><th></th></tr></thead>
          <tbody>
            {orders.data?.map((o) => {
              const cityCouriers = (couriers.data ?? []).filter((c) => c.city_id === o.cityId && c.status === 'approved');
              return (
                <tr key={o.id}>
                  <td>{o.number}{o.containsAlcohol && <span className="badge adult"> 18+</span>}</td>
                  <td>{o.branchName}</td>
                  <td className="col" style={{ gap: 2 }}><StatusBadge cycle="commercial" status={o.commercialStatus} /><StatusBadge cycle="delivery" status={o.deliveryStatus} /><StatusBadge cycle="payment" status={o.paymentStatus} /></td>
                  <td><Money cents={o.totalCents} /></td>
                  <td>
                    {['sin_asignar', 'oferta_enviada'].includes(o.deliveryStatus) && ['confirmado', 'aceptado_comercio', 'en_preparacion', 'listo_para_recojo'].includes(o.commercialStatus) ? (
                      <div className="row">
                        <select value={assign[o.id] ?? ''} onChange={(e) => setAssign({ ...assign, [o.id]: e.target.value })} style={{ maxWidth: 180 }}>
                          <option value="">Asignar a…</option>
                          {cityCouriers.map((c) => <option key={c.id} value={c.id} disabled={c.busy}>{c.full_name}{c.busy ? ' (ocupado)' : c.available ? '' : ' (no disponible)'}</option>)}
                        </select>
                        <ActionButton className="sm" disabled={!assign[o.id]} onClick={async () => { await api.call('adminAssign', { params: { id: o.id }, body: { courierId: assign[o.id], reason: 'Asignación manual supervisada' } }); orders.reload(); couriers.reload(); }}>Asignar</ActionButton>
                      </div>
                    ) : o.courier ? o.courier.name : '—'}
                    {['asignado', 'en_camino_al_comercio'].includes(o.deliveryStatus) && <ActionButton className="sm ghost" onClick={async () => { await api.call('adminUnassign', { params: { id: o.id }, body: { reason: 'Reasignación por despacho' } }); orders.reload(); }}>Reasignar</ActionButton>}
                  </td>
                  <td><button className="btn sm ghost" onClick={async () => setDetail(await api.call('adminOrder', { params: { id: o.id } }))}>Detalle</button></td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </Guard>
      {detail && (
        <div className="card col">
          <div className="row" style={{ justifyContent: 'space-between' }}><h2>Pedido #{detail.order.number}</h2><button className="btn sm ghost" onClick={() => setDetail(null)}>Cerrar</button></div>
          <h3>Pagos</h3>{detail.payments.map((p: any) => <div key={p.id} className="small">{p.provider}/{p.method} · {p.status} · S/ {(p.amount_cents / 100).toFixed(2)} {p.provider === 'sandbox' && <span className="badge warn">simulador</span>}</div>)}
          <h3>Reembolsos</h3>{detail.refunds.length ? detail.refunds.map((r: any) => <div key={r.id} className="small">{r.status} · {r.concept} · S/ {(r.amount_cents / 100).toFixed(2)} · {r.reason}</div>) : <span className="muted small">—</span>}
          <h3>Verificación de edad en puerta</h3>{detail.ageChecks.length ? detail.ageChecks.map((a: any, i: number) => <div key={i} className="small">{a.result} · {a.document_type ?? '—'} · {a.rejection_reason ?? ''} · {new Date(a.checked_at).toLocaleString('es-PE', { timeZone: 'America/Lima' })}</div>) : <span className="muted small">—</span>}
          <h3>Libro de movimientos</h3>{detail.ledger.map((l: any, i: number) => <div key={i} className="small row" style={{ justifyContent: 'space-between' }}><span>{l.party_type} · {l.entry_type}</span><Money cents={l.amount_cents} className="" /></div>)}
          <h3>Inventario</h3>{detail.inventory.map((m: any, i: number) => <div key={i} className="small">{m.kind} {m.quantity} × {m.name}</div>)}
          <h3>Cronología</h3>{detail.order.history.map((h: any, i: number) => <div key={i} className="small">{h.cycle}: {h.from ?? '∅'} → {h.to} · {h.actorRole} {h.reason ? `· ${h.reason}` : ''}</div>)}
          <div className="row">
            <input placeholder="Motivo (obligatorio)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <ActionButton className="warn" disabled={reason.length < 3} confirm="¿Cancelar el pedido? Se liberará stock y se reembolsará lo cobrado." onClick={async () => { await api.call('adminCancel', { params: { id: detail.order.id }, body: { reason } }); setDetail(await api.call('adminOrder', { params: { id: detail.order.id } })); orders.reload(); }}>Cancelar pedido</ActionButton>
          </div>
          {detail.payments.filter((p: any) => p.status === 'pagado').map((p: any) => <RefundForm key={p.id} paymentId={p.id} onDone={async () => setDetail(await api.call('adminOrder', { params: { id: detail.order.id } }))} />)}
        </div>
      )}
    </div>
  );
}

function RefundForm({ paymentId, onDone }: { paymentId: string; onDone: () => void }) {
  const [amount, setAmount] = useState('');
  const [concept, setConcept] = useState('products');
  const [reason, setReason] = useState('');
  return (
    <div className="row">
      <input placeholder="Reembolso S/" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ maxWidth: 120 }} />
      <select value={concept} onChange={(e) => setConcept(e.target.value)} style={{ maxWidth: 160 }}><option value="products">Productos</option><option value="delivery">Reparto</option><option value="tip">Propina</option><option value="service">Servicio</option><option value="mixed">Mixto</option></select>
      <input placeholder="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} />
      <ActionButton className="sm" disabled={!amount || reason.length < 3} onClick={async () => { await api.call('adminRefund', { params: { id: paymentId }, body: { amountCents: Math.round(Number(amount) * 100), concept: concept as any, reason } }); onDone(); }}>Solicitar reembolso</ActionButton>
    </div>
  );
}

function Couriers() {
  const q = useQuery<any[]>('adminCouriers');
  const [reason, setReason] = useState('Revisión manual de identidad, vehículo y documentos');
  return (
    <Guard q={q}>
      <p className="muted small">La aprobación es una revisión manual documentada; no constituye validación oficial de documentos.</p>
      <input value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Motivo de revisión" />
      <div className="table-wrap"><table>
        <thead><tr><th>Nombre</th><th>Vehículo</th><th>Estado</th><th>Disponible</th><th>Capacitación alcohol</th><th>Última ubicación</th><th></th></tr></thead>
        <tbody>{q.data?.map((c) => (
          <tr key={c.id}>
            <td>{c.full_name}</td><td>{c.vehicle_type}</td><td>{c.status}</td><td>{c.available ? (c.busy ? 'ocupado' : 'sí') : 'no'}</td><td>{c.alcohol_training_at ? 'completa' : '—'}</td>
            <td>{c.last_location_at ? new Date(c.last_location_at).toLocaleTimeString('es-PE', { timeZone: 'America/Lima' }) : '—'}</td>
            <td className="row">
              {c.status === 'pending' && <><ActionButton className="sm" onClick={async () => { await api.call('adminReviewCourier', { params: { id: c.id }, body: { approve: true, reason } }); q.reload(); }}>Aprobar</ActionButton><ActionButton className="sm warn" onClick={async () => { await api.call('adminReviewCourier', { params: { id: c.id }, body: { approve: false, reason } }); q.reload(); }}>Rechazar</ActionButton></>}
              {c.status === 'approved' && !c.alcohol_training_at && <ActionButton className="sm ghost" onClick={async () => { await api.call('adminTraining', { params: { id: c.id }, body: { topics: ['documentos', 'rechazo', 'privacidad', 'soporte', 'venta_responsable'] } }); q.reload(); }}>Registrar capacitación</ActionButton>}
            </td>
          </tr>
        ))}</tbody>
      </table></div>
    </Guard>
  );
}

function Merchants() {
  const q = useQuery<any[]>('adminMerchants');
  const [reason, setReason] = useState('Documentación revisada');
  return (
    <Guard q={q}>
      <input value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Motivo" />
      {q.data?.map((m) => (
        <div key={m.id} className="card col">
          <div className="row" style={{ justifyContent: 'space-between' }}><strong>{m.trade_name}</strong><span className="badge">{m.status}</span></div>
          <span className="small muted">{m.legal_name ?? ''} {m.ruc ? `· RUC ${m.ruc}` : ''}</span>
          {m.status === 'pending' && <div className="row"><ActionButton className="sm" onClick={async () => { await api.call('adminReviewMerchant', { params: { id: m.id }, body: { approve: true, reason } }); q.reload(); }}>Aprobar y publicar</ActionButton><ActionButton className="sm warn" onClick={async () => { await api.call('adminReviewMerchant', { params: { id: m.id }, body: { approve: false, reason } }); q.reload(); }}>Rechazar</ActionButton></div>}
          {m.branches.map((b: any) => (
            <div key={b.id} className="row small">
              <span>{b.name} · {b.status} · alcohol: {b.alcoholPermit}</span>
              <ActionButton className="sm ghost" onClick={async () => { await api.call('adminReviewAlcoholPermit', { params: { id: b.id }, body: { approve: b.alcoholPermit !== 'approved', reason } }); q.reload(); }}>{b.alcoholPermit === 'approved' ? 'Suspender habilitación alcohol' : 'Aprobar habilitación alcohol'}</ActionButton>
            </div>
          ))}
        </div>
      ))}
    </Guard>
  );
}

function AgeQueue() {
  const q = useQuery<any[]>('adminAgeQueue');
  const [reason, setReason] = useState('Identidad y fecha de nacimiento verificadas por videollamada según procedimiento');
  return (
    <Guard q={q}>
      <p className="muted small">Revisión humana documentada (docs/politica-edad.md). No se infiere edad por DNI, tarjeta, OTP ni fotografía, y no hay conexión con RENIEC.</p>
      <input value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Motivo" />
      {!q.data?.length && <Empty>No hay solicitudes pendientes.</Empty>}
      {q.data?.map((v) => (
        <div key={v.id} className="card row" style={{ justifyContent: 'space-between' }}>
          <span>{v.account_name} · documento {v.document_type} ****{v.document_last4} · nombre en documento: {v.full_name_on_document} · nac. {v.birth_date}</span>
          <span className="row">
            <ActionButton className="sm" onClick={async () => { await api.call('adminAgeDecide', { params: { id: v.id }, body: { decision: 'verified', reason, method: 'manual_video' } }); q.reload(); }}>Aprobar</ActionButton>
            <ActionButton className="sm warn" onClick={async () => { await api.call('adminAgeDecide', { params: { id: v.id }, body: { decision: 'rejected', reason, method: 'manual_video' } }); q.reload(); }}>Rechazar</ActionButton>
          </span>
        </div>
      ))}
    </Guard>
  );
}

function Cities() {
  const cities = useQuery<CityDto[]>('cities');
  const rules = useQuery<any[]>('adminAlcoholRules');
  const [reason, setReason] = useState('');
  const [zoneCity, setZoneCity] = useState('');
  const zones = useQuery<any[]>(zoneCity ? 'cityZones' : null, { params: { id: zoneCity } });
  const [susp, setSusp] = useState({ reason: 'lluvia', hours: '2' });
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="col">
      <Guard q={cities}>
        <input placeholder="Motivo del cambio (obligatorio, queda en auditoría)" value={reason} onChange={(e) => setReason(e.target.value)} />
        {cities.data?.map((c) => (
          <div key={c.id} className="card row" style={{ justifyContent: 'space-between' }}>
            <span><strong>{c.name}</strong> · {c.status} {c.pauseReason ? `(${c.pauseReason})` : ''}</span>
            <span className="row">
              <ActionButton className="sm warn" disabled={reason.length < 3} onClick={async () => { await api.call('adminCityPatch', { params: { id: c.id }, body: { status: c.status === 'active' ? 'paused' : 'active', reason } }); cities.reload(); }}>{c.status === 'active' ? 'Pausar operación' : 'Reanudar'}</ActionButton>
              <ActionButton className="sm ghost" disabled={reason.length < 3} onClick={async () => { await api.call('adminCityPatch', { params: { id: c.id }, body: { alcoholEnabled: false, reason } }); setMsg('Alcohol deshabilitado'); }}>Deshabilitar alcohol</ActionButton>
              <ActionButton className="sm ghost" disabled={reason.length < 3} onClick={async () => { await api.call('adminCityPatch', { params: { id: c.id }, body: { alcoholEnabled: true, reason } }); setMsg('Interruptor comercial activado. Las prohibiciones normativas y la falta de reglas validadas siguen bloqueando la venta.'); }}>Habilitar alcohol</ActionButton>
              <button className="btn sm secondary" onClick={() => setZoneCity(c.id)}>Zonas</button>
            </span>
          </div>
        ))}
      </Guard>
      {zoneCity && zones.data && (
        <div className="card col">
          <h2>Zonas</h2>
          <div className="row"><select value={susp.reason} onChange={(e) => setSusp({ ...susp, reason: e.target.value })} style={{ maxWidth: 200 }}><option value="lluvia">Lluvia</option><option value="bloqueo_vial">Bloqueo vial</option><option value="falta_capacidad">Falta de capacidad</option><option value="otro">Otro</option></select><input value={susp.hours} onChange={(e) => setSusp({ ...susp, hours: e.target.value })} style={{ maxWidth: 80 }} aria-label="Horas" /> horas</div>
          {zones.data.map((z) => (
            <div key={z.id} className="row small" style={{ justifyContent: 'space-between' }}>
              <span>{z.name} · versión {z.version} {z.isDemoGeometry && <span className="badge warn">geometría de prueba</span>} {z.suspended && <span className="badge danger">suspendida</span>}</span>
              <ActionButton className="sm warn" onClick={async () => { await api.call('adminZoneSuspend', { params: { id: z.id }, body: { reason: susp.reason as any, startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + Number(susp.hours) * 3600000).toISOString() } }); zones.reload(); }}>Suspender</ActionButton>
            </div>
          ))}
        </div>
      )}
      <Guard q={rules}>
        <div className="card">
          <h2>Ventanas de venta de alcohol</h2>
          <p className="muted small">Cada regla guarda fuente normativa, fecha de revisión y responsable. En ensayo/producción solo cuentan reglas validadas; las marcadas como demostración no habilitan venta real.</p>
          <div className="table-wrap"><table><thead><tr><th>Jurisdicción</th><th>Día</th><th>Ventana</th><th>Fuente</th><th>Validada</th></tr></thead>
            <tbody>{rules.data?.map((r) => <tr key={r.id}><td>{r.jurisdiction}</td><td>{r.weekday}</td><td>{r.start_time.slice(0, 5)}–{r.end_time.slice(0, 5)}</td><td className="small">{r.source}</td><td>{r.validated ? 'sí' : <span className="badge warn">no</span>}</td></tr>)}</tbody>
          </table></div>
        </div>
      </Guard>
      {msg && <div className="alert info">{msg}</div>}
    </div>
  );
}

function Coupons() {
  const q = useQuery<any[]>('adminCoupons');
  const [f, setF] = useState({ code: '', discountType: 'percent', value: '10', budget: '200', maxUses: '50', days: '30', fundedBy: 'platform', min: '0' });
  const [err, setErr] = useState<string | null>(null);
  return (
    <Guard q={q}>
      <div className="card col">
        <h2>Nuevo cupón</h2>
        <div className="row">
          <input placeholder="CÓDIGO" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />
          <select value={f.discountType} onChange={(e) => setF({ ...f, discountType: e.target.value })}><option value="percent">% de productos</option><option value="fixed">Monto fijo (céntimos)</option><option value="free_delivery">Envío gratis</option></select>
          <input placeholder="Valor" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} />
          <input placeholder="Presupuesto S/" value={f.budget} onChange={(e) => setF({ ...f, budget: e.target.value })} />
          <input placeholder="Usos máx." value={f.maxUses} onChange={(e) => setF({ ...f, maxUses: e.target.value })} />
          <input placeholder="Mínimo S/" value={f.min} onChange={(e) => setF({ ...f, min: e.target.value })} />
          <select value={f.fundedBy} onChange={(e) => setF({ ...f, fundedBy: e.target.value })}><option value="platform">Financia plataforma</option><option value="merchant">Financia comercio</option></select>
        </div>
        {err && <div className="alert error">{err}</div>}
        <button className="btn" onClick={async () => { try { await api.call('adminCreateCoupon', { body: { code: f.code, discountType: f.discountType as any, value: Number(f.value), budgetCents: Math.round(Number(f.budget) * 100), maxUses: Number(f.maxUses), perUserLimit: 1, fundedBy: f.fundedBy as any, minSubtotalCents: Math.round(Number(f.min) * 100), startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + Number(f.days) * 86400000).toISOString() } }); q.reload(); } catch (e) { setErr(errorMessage(e)); } }}>Crear</button>
        <p className="muted small">Un cupón nunca elimina la restricción de edad ni habilita destinos fuera de cobertura.</p>
      </div>
      <div className="table-wrap"><table><thead><tr><th>Código</th><th>Tipo</th><th>Usos</th><th>Presupuesto</th><th>Financia</th><th>Vigencia</th></tr></thead>
        <tbody>{q.data?.map((c) => <tr key={c.id}><td>{c.code}</td><td>{c.discount_type} {c.value}</td><td>{c.uses_count}/{c.max_uses}</td><td><Money cents={c.budget_used_cents} className="" /> / <Money cents={c.budget_cents} className="" /></td><td>{c.funded_by}</td><td className="small">{new Date(c.ends_at).toLocaleDateString('es-PE')}</td></tr>)}</tbody>
      </table></div>
    </Guard>
  );
}

function Finance() {
  const s = useQuery<any[]>('adminSettlements');
  const merchants = useQuery<any[]>('adminMerchants');
  const couriers = useQuery<any[]>('adminCouriers');
  const [f, setF] = useState({ partyType: 'merchant', partyId: '', from: '', to: '' });
  const [detail, setDetail] = useState<any>(null);
  const [rec, setRec] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const parties = f.partyType === 'merchant' ? (merchants.data ?? []).map((m) => ({ id: m.id, name: m.trade_name })) : (couriers.data ?? []).map((c) => ({ id: c.id, name: c.full_name }));
  return (
    <div className="col">
      <div className="card col">
        <h2>Generar liquidación</h2>
        <div className="row">
          <select value={f.partyType} onChange={(e) => setF({ ...f, partyType: e.target.value, partyId: '' })}><option value="merchant">Comercio</option><option value="courier">Repartidor</option></select>
          <select value={f.partyId} onChange={(e) => setF({ ...f, partyId: e.target.value })}><option value="">Elegir…</option>{parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
          <input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        </div>
        {err && <div className="alert error">{err}</div>}
        <button className="btn" disabled={!f.partyId || !f.from || !f.to} onClick={async () => { try { setDetail(await api.call('adminCreateSettlement', { body: { partyType: f.partyType as any, partyId: f.partyId, periodStart: new Date(`${f.from}T00:00:00-05:00`).toISOString(), periodEnd: new Date(`${f.to}T23:59:59-05:00`).toISOString() } })); s.reload(); } catch (e) { setErr(e instanceof ApiError && e.code === 'MFA_REQUIRED' ? 'Requiere verificación en dos pasos (Cuenta).' : errorMessage(e)); } }}>Generar</button>
        <p className="muted small">La liquidación es una orden reproducible a partir del libro inmutable; la transferencia al tercero se ejecuta fuera de la plataforma con autorización (no hay custodia de fondos ni pagos divididos asumidos).</p>
      </div>
      <div className="card col">
        <h2>Conciliación de pagos</h2>
        <ActionButton onClick={async () => setRec(await api.call('adminReconcile'))}>Conciliar pendientes ahora</ActionButton>
        {rec && <pre className="small">{JSON.stringify(rec, null, 2)}</pre>}
      </div>
      <Guard q={s}>
        <div className="table-wrap"><table><thead><tr><th>Tercero</th><th>Período</th><th>Movimientos</th><th>Total</th><th>Estado</th><th></th></tr></thead>
          <tbody>{s.data?.map((x) => <tr key={x.id}><td>{x.party_type}</td><td className="small">{new Date(x.period_start).toLocaleDateString('es-PE')} – {new Date(x.period_end).toLocaleDateString('es-PE')}</td><td>{x.entries_count}</td><td><Money cents={x.total_cents} /></td><td>{x.status}</td><td><button className="btn sm ghost" onClick={async () => setDetail(await api.call('adminSettlement', { params: { id: x.id } }))}>Ver / recalcular</button></td></tr>)}</tbody>
        </table></div>
      </Guard>
      {detail && (
        <div className="card col">
          <h2>Liquidación</h2>
          <span>Total registrado <Money cents={detail.total_cents} className="" /> · recalculado <Money cents={detail.recomputedTotalCents} className="" /> · {detail.consistent ? <span className="badge">consistente</span> : <span className="badge danger">inconsistente</span>}</span>
          {detail.items.map((i: any) => <div key={i.id} className="small row" style={{ justifyContent: 'space-between' }}><span>{i.entry_type} · {i.description}</span><Money cents={i.amount_cents} className="" /></div>)}
        </div>
      )}
    </div>
  );
}

function Support() {
  const inc = useQuery<any[]>('adminIncidents');
  const comp = useQuery<any[]>('adminComplaints');
  const [res, setRes] = useState<Record<string, { text: string; refund: string; concept: string }>>({});
  const [resp, setResp] = useState<Record<string, string>>({});
  return (
    <div className="col">
      <h2>Incidencias</h2>
      <Guard q={inc}>
        {!inc.data?.length && <Empty>Sin incidencias.</Empty>}
        {inc.data?.map((i) => {
          const r = res[i.id] ?? { text: '', refund: '', concept: 'products' };
          return (
            <div key={i.id} className="card col">
              <div className="row" style={{ justifyContent: 'space-between' }}><strong>Pedido #{i.number} · {i.kind}</strong><span className="badge">{i.status}</span></div>
              <span className="small">{i.description}</span>
              {(i.evidence_document_ids ?? []).length > 0 && (
                <div className="row">{i.evidence_document_ids.map((d: string, k: number) => <ActionButton key={d} className="sm ghost" onClick={async () => { const r = await api.call('fileUrl', { params: { id: d } }); window.open(r.url.startsWith('http') ? r.url : `/api${r.url}`, '_blank', 'noopener'); }}>{`Ver evidencia ${k + 1}`}</ActionButton>)}</div>
              )}
              {i.status === 'open' ? (
                <div className="row">
                  <input placeholder="Resolución" value={r.text} onChange={(e) => setRes({ ...res, [i.id]: { ...r, text: e.target.value } })} />
                  <input placeholder="Reembolso S/" value={r.refund} onChange={(e) => setRes({ ...res, [i.id]: { ...r, refund: e.target.value } })} style={{ maxWidth: 120 }} />
                  <select value={r.concept} onChange={(e) => setRes({ ...res, [i.id]: { ...r, concept: e.target.value } })} style={{ maxWidth: 150 }}><option value="products">Productos</option><option value="delivery">Reparto</option><option value="tip">Propina</option><option value="service">Servicio</option><option value="mixed">Mixto</option></select>
                  <ActionButton className="sm" disabled={r.text.length < 3} onClick={async () => { await api.call('adminResolveIncident', { params: { id: i.id }, body: { resolution: r.text, refundCents: r.refund ? Math.round(Number(r.refund) * 100) : 0, refundConcept: r.concept as any } }); inc.reload(); }}>Resolver</ActionButton>
                </div>
              ) : <span className="small muted">{i.resolution}</span>}
            </div>
          );
        })}
      </Guard>
      <h2>Libro de Reclamaciones</h2>
      <Guard q={comp}>
        {comp.data?.map((c) => (
          <div key={c.id} className="card col">
            <div className="row" style={{ justifyContent: 'space-between' }}><strong>{c.number} · {c.kind} · {c.consumer_name}</strong><span className={`badge ${c.responded ? '' : 'warn'}`}>{c.responded ? 'respondida' : `vence ${c.due_date}`}</span></div>
            {!c.responded && <div className="row"><input placeholder="Respuesta" value={resp[c.id] ?? ''} onChange={(e) => setResp({ ...resp, [c.id]: e.target.value })} /><ActionButton className="sm" disabled={(resp[c.id] ?? '').length < 10} onClick={async () => { await api.call('adminRespondComplaint', { params: { id: c.id }, body: { response: resp[c.id] } }); comp.reload(); }}>Responder</ActionButton></div>}
          </div>
        ))}
      </Guard>
    </div>
  );
}

function Privacy() {
  const q = useQuery<any[]>('adminDataRequests');
  return (
    <Guard q={q}>
      {!q.data?.length && <Empty>Sin solicitudes.</Empty>}
      {q.data?.map((d) => (
        <div key={d.id} className="card row" style={{ justifyContent: 'space-between' }}>
          <span>{d.full_name} · {d.kind} · {d.status} · vence {new Date(d.due_at).toLocaleDateString('es-PE')}</span>
          {d.status !== 'completed' && <ActionButton className="sm" confirm={d.kind === 'account_deletion' ? 'Se anonimizarán los datos personales de forma irreversible. ¿Continuar?' : undefined} onClick={async () => { await api.call('adminProcessDataRequest', { params: { id: d.id }, body: { reason: 'Solicitud atendida tras verificar identidad' } }); q.reload(); }}>Atender</ActionButton>}
        </div>
      ))}
    </Guard>
  );
}

function Audit() {
  const a = useQuery<any[]>('adminAudit');
  const o = useQuery<any[]>('adminOutbox');
  return (
    <div className="col">
      <h2>Auditoría</h2>
      <Guard q={a}><div className="table-wrap"><table><thead><tr><th>Fecha</th><th>Acción</th><th>Entidad</th><th>Motivo</th></tr></thead><tbody>{a.data?.slice(0, 100).map((x) => <tr key={x.id}><td className="small">{new Date(x.created_at).toLocaleString('es-PE', { timeZone: 'America/Lima' })}</td><td>{x.action}</td><td className="small">{x.entity} {x.entity_id?.slice(0, 8)}</td><td className="small">{x.reason}</td></tr>)}</tbody></table></div></Guard>
      <h2>Eventos (outbox)</h2>
      <Guard q={o}><div className="table-wrap"><table><thead><tr><th>#</th><th>Tema</th><th>Intentos</th><th>Estado</th></tr></thead><tbody>{o.data?.slice(0, 100).map((x) => <tr key={x.id}><td>{x.id}</td><td>{x.topic}</td><td>{x.attempts}</td><td>{x.dead_at ? <span className="badge danger">fallido: {x.last_error}</span> : x.processed_at ? 'procesado' : 'pendiente'}</td></tr>)}</tbody></table></div></Guard>
    </div>
  );
}

function Documents() {
  const q = useQuery<any[]>('adminDocuments');
  const [reason, setReason] = useState('Documento revisado manualmente; coincide con el titular');
  const [exp, setExp] = useState<Record<string, string>>({});
  return (
    <Guard q={q}>
      <p className="muted small">Revisión manual: no equivale a validación oficial ante la entidad emisora. Los documentos vencidos suspenden automáticamente la habilitación de alcohol.</p>
      <input value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Motivo" />
      {!q.data?.length && <Empty>Sin documentos.</Empty>}
      {q.data?.map((d) => (
        <div key={d.id} className="card row" style={{ justifyContent: 'space-between' }}>
          <span>{d.ownerName} · {d.ownerType} · <strong>{kindLabel(d.kind)}</strong> · <span className="badge">{d.status}</span> {d.expiresAt ? `· vence ${d.expiresAt}` : ''}</span>
          <span className="row">
            <ActionButton className="sm ghost" onClick={async () => { const r = await api.call('fileUrl', { params: { id: d.id } }); window.open(r.url.startsWith('http') ? r.url : `/api${r.url}`, '_blank', 'noopener'); }}>Ver (enlace 5 min)</ActionButton>
            {d.status === 'pending' && (
              <>
                <input type="date" value={exp[d.id] ?? d.expiresAt ?? ''} onChange={(e) => setExp({ ...exp, [d.id]: e.target.value })} style={{ maxWidth: 160 }} aria-label="Vencimiento" />
                <ActionButton className="sm" onClick={async () => { await api.call('adminReviewDocument', { params: { id: d.id }, body: { approve: true, reason, expiresAt: exp[d.id] || undefined } }); q.reload(); }}>Aprobar</ActionButton>
                <ActionButton className="sm warn" onClick={async () => { await api.call('adminReviewDocument', { params: { id: d.id }, body: { approve: false, reason } }); q.reload(); }}>Rechazar</ActionButton>
              </>
            )}
          </span>
        </div>
      ))}
    </Guard>
  );
}

function Banners() {
  const q = useQuery<any[]>('adminBanners');
  const cities = useQuery<CityDto[]>('cities');
  const [f, setF] = useState({ cityId: '', title: '', body: '', conditions: '', days: '30', containsAlcohol: false });
  const [err, setErr] = useState<string | null>(null);
  return (
    <Guard q={q}>
      <div className="card col">
        <h2>Nuevo banner</h2>
        <select value={f.cityId} onChange={(e) => setF({ ...f, cityId: e.target.value })}><option value="">Todas las ciudades</option>{cities.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <input placeholder="Título" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        <input placeholder="Texto" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
        <input placeholder="Condiciones visibles (vigencia, mínimos, cupos)" value={f.conditions} onChange={(e) => setF({ ...f, conditions: e.target.value })} />
        <input placeholder="Días de vigencia" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} />
        <label className="check"><input type="checkbox" checked={f.containsAlcohol} onChange={(e) => setF({ ...f, containsAlcohol: e.target.checked })} /> Promociona bebidas alcohólicas (solo se mostrará a adultos verificados)</label>
        {err && <div className="alert error">{err}</div>}
        <button className="btn" onClick={async () => { setErr(null); try { await api.call('adminCreateBanner', { body: { cityId: f.cityId || undefined, title: f.title, body: f.body, conditions: f.conditions, containsAlcohol: f.containsAlcohol, startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + Number(f.days) * 86400000).toISOString() } }); q.reload(); } catch (e) { setErr(errorMessage(e)); } }}>Crear</button>
        <p className="muted small">No dirigir campañas a menores ni incentivar consumo excesivo. Las condiciones deben ser verificables.</p>
      </div>
      {q.data?.map((b) => (
        <div key={b.id} className="card row" style={{ justifyContent: 'space-between' }}>
          <span><strong>{b.title}</strong> · {b.conditions} {b.containsAlcohol && <span className="badge adult">18+</span>} {b.isDemo && <span className="badge warn">demo</span>}</span>
          <ActionButton className="sm ghost" onClick={async () => { await api.call('adminPatchBanner', { params: { id: b.id }, body: { active: !b.active, reason: b.active ? 'Desactivado desde el panel' : 'Reactivado desde el panel' } }); q.reload(); }}>{b.active ? 'Desactivar' : 'Activar'}</ActionButton>
        </div>
      ))}
    </Guard>
  );
}

const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

function CityConfig() {
  const cities = useQuery<CityDto[]>('cities');
  const [cityId, setCityId] = useState('');
  const zones = useQuery<any[]>(cityId ? 'cityZones' : null, { params: { id: cityId } });
  const fees = useQuery<any[]>('adminFeeRules');
  const [fee, setFee] = useState({ base: '4.00', includedM: '1500', perKm: '1.50', min: '10.00', surcharge: '0', surchargeLabel: '', maxM: '6000', zoneId: '', reason: '' });
  const [rule, setRule] = useState({ jurisdictionId: '', weekdays: [1, 2, 3, 4, 5] as number[], start: '10:00', end: '22:00', source: '', reviewed: new Date().toISOString().slice(0, 10), responsible: '', validated: false });
  const [black, setBlack] = useState({ jurisdictionId: '', startsAt: '', endsAt: '', reason: '', source: '' });
  const [zoneId, setZoneId] = useState('');
  const [pts, setPts] = useState<{ lat: number; lng: number }[]>([]);
  const [zoneReason, setZoneReason] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const city = cities.data?.find((c) => c.id === cityId);
  const juris = useQuery<any[]>('adminAlcoholRules');
  const jurisdictions = [...new Map((juris.data ?? []).map((r) => [r.jurisdiction_id, r.jurisdiction])).entries()];
  const zone = zones.data?.find((z) => z.id === zoneId);
  const draft = pts.length >= 3 ? { type: 'Polygon', coordinates: [[...pts.map((p) => [p.lng, p.lat]), [pts[0].lng, pts[0].lat]]] } : null;
  return (
    <div className="col" style={{ marginTop: 12 }}>
      <select value={cityId} onChange={(e) => { setCityId(e.target.value); setZoneId(''); setPts([]); }} aria-label="Ciudad a configurar">
        <option value="">Configurar ciudad…</option>{cities.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      {msg && <div className="alert ok">{msg}</div>}
      {city && (
        <>
          <div className="card col">
            <h2>Editar polígono de zona (nueva versión)</h2>
            <select value={zoneId} onChange={(e) => { setZoneId(e.target.value); setPts([]); }}><option value="">Zona…</option>{zones.data?.map((z) => <option key={z.id} value={z.id}>{z.name} (v{z.version})</option>)}</select>
            {zone && (
              <>
                <span className="muted small">Haz clic en el mapa para marcar los vértices en orden (mínimo 3). La versión anterior se conserva en el historial; los pedidos en curso mantienen la versión con la que se cotizaron.</span>
                <MapView center={city.center} polygons={[zone.geometry, ...(draft ? [draft] : [])]} markers={pts.map((p, i) => ({ ...p, label: `Vértice ${i + 1}`, color: '#c2410c' }))} onPick={(p) => setPts([...pts, p])} height={320} />
                <div className="row">
                  <button className="btn sm ghost" onClick={() => setPts(pts.slice(0, -1))} disabled={!pts.length}>Deshacer vértice</button>
                  <input placeholder="Motivo del cambio" value={zoneReason} onChange={(e) => setZoneReason(e.target.value)} />
                  <ActionButton className="sm" disabled={!draft || zoneReason.length < 3} onClick={async () => { const r = await api.call('adminZoneVersion', { params: { id: zoneId }, body: { geometry: draft as any, reason: zoneReason } }); setMsg(`Zona actualizada a la versión ${r.version}`); setPts([]); zones.reload(); }}>Guardar nueva versión</ActionButton>
                </div>
              </>
            )}
          </div>

          <div className="card col">
            <h2>Tarifa de reparto</h2>
            <div className="table-wrap"><table><thead><tr><th>Ámbito</th><th>Base</th><th>Incluye</th><th>Por km</th><th>Mínimo</th><th>Máx.</th></tr></thead>
              <tbody>{fees.data?.filter((f) => f.city_id === cityId).map((f) => <tr key={f.id}><td>{f.branch_id ? 'sucursal' : f.zone_id ? 'zona' : 'ciudad'} {f.is_demo && <span className="badge warn">demo</span>}</td><td><Money cents={f.base_fee_cents} className="" /></td><td>{f.included_meters} m</td><td><Money cents={f.per_km_cents} className="" /></td><td><Money cents={f.min_order_cents} className="" /></td><td>{f.max_distance_meters} m</td></tr>)}</tbody></table></div>
            <div className="row">
              <select value={fee.zoneId} onChange={(e) => setFee({ ...fee, zoneId: e.target.value })} style={{ maxWidth: 200 }}><option value="">Toda la ciudad</option>{zones.data?.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}</select>
              <label className="small">Base S/<input value={fee.base} onChange={(e) => setFee({ ...fee, base: e.target.value })} /></label>
              <label className="small">Metros incluidos<input value={fee.includedM} onChange={(e) => setFee({ ...fee, includedM: e.target.value })} /></label>
              <label className="small">S/ por km extra<input value={fee.perKm} onChange={(e) => setFee({ ...fee, perKm: e.target.value })} /></label>
              <label className="small">Compra mínima S/<input value={fee.min} onChange={(e) => setFee({ ...fee, min: e.target.value })} /></label>
              <label className="small">Recargo S/<input value={fee.surcharge} onChange={(e) => setFee({ ...fee, surcharge: e.target.value })} /></label>
              <label className="small">Motivo del recargo<input value={fee.surchargeLabel} onChange={(e) => setFee({ ...fee, surchargeLabel: e.target.value })} placeholder="p. ej. lluvia" /></label>
              <label className="small">Distancia máx. (m)<input value={fee.maxM} onChange={(e) => setFee({ ...fee, maxM: e.target.value })} /></label>
            </div>
            <input placeholder="Motivo (auditoría)" value={fee.reason} onChange={(e) => setFee({ ...fee, reason: e.target.value })} />
            <ActionButton disabled={fee.reason.length < 3} onClick={async () => { await api.call('adminFeeRule', { body: { cityId, zoneId: fee.zoneId || undefined, baseFeeCents: Math.round(Number(fee.base) * 100), includedMeters: Number(fee.includedM), perKmCents: Math.round(Number(fee.perKm) * 100), minOrderCents: Math.round(Number(fee.min) * 100), surchargeCents: Math.round(Number(fee.surcharge) * 100), surchargeLabel: fee.surchargeLabel || undefined, maxDistanceMeters: Number(fee.maxM), reason: fee.reason } }); setMsg('Tarifa registrada (la más reciente y específica aplica a nuevas cotizaciones)'); fees.reload(); }}>Registrar tarifa</ActionButton>
          </div>
        </>
      )}

      <div className="card col">
        <h2>Ventana de venta de alcohol</h2>
        <p className="muted small">Solo con fuente normativa verificada, fecha de revisión y responsable. Marca "validada" únicamente si la fuente fue confirmada; en producción las no validadas no habilitan venta.</p>
        <select value={rule.jurisdictionId} onChange={(e) => setRule({ ...rule, jurisdictionId: e.target.value })}><option value="">Jurisdicción…</option>{jurisdictions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
        <div className="row">{DAYS.map((d, i) => <label key={d} className="check small"><input type="checkbox" checked={rule.weekdays.includes(i)} onChange={(e) => setRule({ ...rule, weekdays: e.target.checked ? [...rule.weekdays, i] : rule.weekdays.filter((x) => x !== i) })} /> {d}</label>)}</div>
        <div className="row"><input type="time" value={rule.start} onChange={(e) => setRule({ ...rule, start: e.target.value })} style={{ maxWidth: 140 }} /><input type="time" value={rule.end} onChange={(e) => setRule({ ...rule, end: e.target.value })} style={{ maxWidth: 140 }} /></div>
        <input placeholder="Fuente (ordenanza, número, enlace)" value={rule.source} onChange={(e) => setRule({ ...rule, source: e.target.value })} />
        <div className="row"><label className="small">Fecha de revisión<input type="date" value={rule.reviewed} onChange={(e) => setRule({ ...rule, reviewed: e.target.value })} /></label><input placeholder="Responsable" value={rule.responsible} onChange={(e) => setRule({ ...rule, responsible: e.target.value })} /></div>
        <label className="check"><input type="checkbox" checked={rule.validated} onChange={(e) => setRule({ ...rule, validated: e.target.checked })} /> Fuente verificada y vigente</label>
        <ActionButton disabled={!rule.jurisdictionId || rule.source.length < 3 || rule.responsible.length < 2 || !rule.weekdays.length} onClick={async () => { for (const w of rule.weekdays) await api.call('adminAlcoholRule', { body: { jurisdictionId: rule.jurisdictionId, weekday: w, start: rule.start, end: rule.end, source: rule.source, sourceReviewedAt: rule.reviewed, responsible: rule.responsible, validated: rule.validated } }); setMsg('Reglas registradas'); juris.reload(); }}>Registrar ventanas</ActionButton>
        <h3>Prohibición temporal (p. ej. jornada electoral)</h3>
        <select value={black.jurisdictionId} onChange={(e) => setBlack({ ...black, jurisdictionId: e.target.value })}><option value="">Jurisdicción…</option>{jurisdictions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
        <div className="row"><input type="datetime-local" value={black.startsAt} onChange={(e) => setBlack({ ...black, startsAt: e.target.value })} /><input type="datetime-local" value={black.endsAt} onChange={(e) => setBlack({ ...black, endsAt: e.target.value })} /></div>
        <input placeholder="Motivo" value={black.reason} onChange={(e) => setBlack({ ...black, reason: e.target.value })} />
        <input placeholder="Fuente normativa" value={black.source} onChange={(e) => setBlack({ ...black, source: e.target.value })} />
        <ActionButton className="warn" disabled={!black.jurisdictionId || !black.startsAt || !black.endsAt || black.reason.length < 3 || black.source.length < 3} onClick={async () => { await api.call('adminAlcoholBlackout', { body: { jurisdictionId: black.jurisdictionId, startsAt: new Date(black.startsAt).toISOString(), endsAt: new Date(black.endsAt).toISOString(), reason: black.reason, source: black.source } }); setMsg('Prohibición registrada; ningún interruptor comercial la anula'); }}>Registrar prohibición</ActionButton>
      </div>
    </div>
  );
}

function FinanceOps() {
  const merchants = useQuery<any[]>('adminMerchants');
  const couriers = useQuery<any[]>('adminCouriers');
  const settlements = useQuery<any[]>('adminSettlements');
  const refundsQ = useQuery<any[]>('adminRefunds', { query: { status: 'pending' } });
  const [com, setCom] = useState({ merchantId: '', percent: '12', from: new Date().toISOString().slice(0, 10), reason: '' });
  const [ref, setRef] = useState<Record<string, string>>({});
  const [cash, setCash] = useState<{ courierId: string; data: any | null; reference: string }>({ courierId: '', data: null, reference: '' });
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="col" style={{ marginTop: 12 }}>
      {msg && <div className="alert ok">{msg}</div>}
      <div className="card col">
        <h2>Acciones sobre liquidaciones</h2>
        <p className="muted small">Borrador → aprobada (por una persona distinta de quien la generó) → ejecutada (registro de la transferencia realizada fuera de la plataforma). Anular libera los movimientos para una nueva liquidación.</p>
        {settlements.data?.filter((s) => s.status !== 'void').slice(0, 20).map((s) => (
          <div key={s.id} className="row small" style={{ justifyContent: 'space-between' }}>
            <span>{s.party_type} · {new Date(s.period_start).toLocaleDateString('es-PE')}–{new Date(s.period_end).toLocaleDateString('es-PE')} · <Money cents={s.total_cents} className="" /> · <span className="badge">{s.status}</span> {s.execution_reference ?? ''}</span>
            <span className="row">
              {s.status === 'draft' && <ActionButton className="sm" onClick={async () => { await api.call('adminApproveSettlement', { params: { id: s.id }, body: { reason: 'Revisado contra el libro' } }); settlements.reload(); }}>Aprobar</ActionButton>}
              {s.status === 'approved' && <><input placeholder="Referencia bancaria" value={ref[s.id] ?? ''} onChange={(e) => setRef({ ...ref, [s.id]: e.target.value })} style={{ maxWidth: 180 }} /><ActionButton className="sm" disabled={(ref[s.id] ?? '').length < 3} onClick={async () => { await api.call('adminExecuteSettlement', { params: { id: s.id }, body: { reference: ref[s.id], reason: 'Transferencia realizada' } }); settlements.reload(); }}>Registrar ejecución</ActionButton></>}
              {['draft', 'approved'].includes(s.status) && <ActionButton className="sm ghost" confirm="¿Anular la liquidación?" onClick={async () => { await api.call('adminVoidSettlement', { params: { id: s.id }, body: { reason: 'Anulada desde el panel' } }); settlements.reload(); }}>Anular</ActionButton>}
            </span>
          </div>
        ))}
      </div>
      <div className="card col">
        <h2>Rendición de efectivo de repartidores</h2>
        <div className="row">
          <select value={cash.courierId} onChange={async (e) => { const id = e.target.value; setCash({ courierId: id, data: id ? await api.call('adminCourierCash', { params: { id } }) : null, reference: '' }); }}><option value="">Repartidor…</option>{couriers.data?.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}</select>
          {cash.data && <span>Pendiente: <Money cents={cash.data.pendingCents} /> ({cash.data.collections.length} pedidos)</span>}
        </div>
        {cash.data?.pendingCents > 0 && (
          <div className="row">
            <input placeholder="Referencia del depósito o recibo" value={cash.reference} onChange={(e) => setCash({ ...cash, reference: e.target.value })} />
            <ActionButton disabled={cash.reference.length < 3} onClick={async () => { const r = await api.call('adminCashRemittance', { params: { id: cash.courierId }, body: { amountCents: cash.data.pendingCents, reference: cash.reference } }); setMsg(`Rendición registrada: S/ ${(r.remittedCents / 100).toFixed(2)}`); setCash({ ...cash, data: await api.call('adminCourierCash', { params: { id: cash.courierId } }) }); }}>Registrar rendición total</ActionButton>
          </div>
        )}
      </div>
      <div className="card col">
        <h2>Reembolsos pendientes</h2>
        {!refundsQ.data?.length && <span className="muted small">No hay reembolsos pendientes.</span>}
        {refundsQ.data?.map((r) => (
          <div key={r.id} className="row small" style={{ justifyContent: 'space-between' }}>
            <span>#{r.number} · <Money cents={r.amount_cents} className="" /> · {r.concept} · {r.provider} · {r.reason}</span>
            {['cash', 'transfer'].includes(r.provider) ? (
              <span className="row"><input placeholder="Referencia de la devolución" value={ref[r.id] ?? ''} onChange={(e) => setRef({ ...ref, [r.id]: e.target.value })} style={{ maxWidth: 200 }} /><ActionButton className="sm" disabled={(ref[r.id] ?? '').length < 3} onClick={async () => { await api.call('adminConfirmRefund', { params: { id: r.id }, body: { reference: ref[r.id] } }); refundsQ.reload(); }}>Confirmar devolución manual</ActionButton></span>
            ) : <span className="muted">Se confirma con la respuesta del proveedor</span>}
          </div>
        ))}
      </div>
      <div className="card col">
        <h2>Comisión por comercio</h2>
        <div className="row">
          <select value={com.merchantId} onChange={(e) => setCom({ ...com, merchantId: e.target.value })}><option value="">Comercio…</option>{merchants.data?.map((m) => <option key={m.id} value={m.id}>{m.trade_name}</option>)}</select>
          <label className="small">Comisión %<input value={com.percent} onChange={(e) => setCom({ ...com, percent: e.target.value })} style={{ maxWidth: 90 }} /></label>
          <label className="small">Vigente desde<input type="date" value={com.from} onChange={(e) => setCom({ ...com, from: e.target.value })} /></label>
        </div>
        <input placeholder="Motivo (contrato, adenda)" value={com.reason} onChange={(e) => setCom({ ...com, reason: e.target.value })} />
        <ActionButton disabled={!com.merchantId || com.reason.length < 3} onClick={async () => { await api.call('adminCommission', { body: { merchantId: com.merchantId, percentBp: Math.round(Number(com.percent) * 100), validFrom: new Date(`${com.from}T00:00:00-05:00`).toISOString(), reason: com.reason } }); setMsg('Comisión registrada; aplica a pedidos creados desde la fecha indicada'); }}>Registrar comisión</ActionButton>
      </div>
    </div>
  );
}

function RolesAdmin() {
  const cities = useQuery<CityDto[]>('cities');
  const merchants = useQuery<any[]>('adminMerchants');
  const [email, setEmail] = useState('');
  const [user, setUser] = useState<any>(null);
  const [f, setF] = useState({ role: 'support_agent', cityId: '', merchantId: '', reason: '' });
  const [err, setErr] = useState<string | null>(null);
  const reloadUser = async () => setUser(await api.call('adminUsers', { query: { email } }));
  const needsCity = ['city_dispatcher', 'courier'].includes(f.role);
  return (
    <div className="col">
      <p className="muted small">Cada persona usa su propia cuenta. Los roles de administración y finanzas exigen verificación en dos pasos. Todo cambio queda en auditoría.</p>
      <div className="row"><input type="email" placeholder="Correo exacto de la cuenta" value={email} onChange={(e) => setEmail(e.target.value)} /><button className="btn secondary" onClick={async () => { setErr(null); try { await reloadUser(); } catch (e) { setErr(errorMessage(e)); setUser(null); } }}>Buscar</button></div>
      {err && <div className="alert error">{err}</div>}
      {user && (
        <div className="card col">
          <strong>{user.fullName} · {user.email}</strong>
          {user.memberships.map((m: any) => (
            <div key={m.id} className="row small" style={{ justifyContent: 'space-between' }}>
              <span>{m.role} {m.city_id ? `· ciudad ${cities.data?.find((c) => c.id === m.city_id)?.name ?? ''}` : ''} {m.merchant_id ? '· comercio' : ''} {m.branch_id ? '· sucursal' : ''}</span>
              <ActionButton className="sm ghost" confirm="¿Revocar este acceso?" onClick={async () => { await api.call('adminRevokeRole', { params: { id: m.id }, body: { reason: 'Revocado desde el panel' } }); await reloadUser(); }}>Revocar</ActionButton>
            </div>
          ))}
          <div className="row">
            <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{['support_agent', 'city_dispatcher', 'finance', 'admin', 'merchant_owner'].map((r) => <option key={r}>{r}</option>)}</select>
            {needsCity && <select value={f.cityId} onChange={(e) => setF({ ...f, cityId: e.target.value })}><option value="">Ciudad…</option>{cities.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
            {f.role === 'merchant_owner' && <select value={f.merchantId} onChange={(e) => setF({ ...f, merchantId: e.target.value })}><option value="">Comercio…</option>{merchants.data?.map((m) => <option key={m.id} value={m.id}>{m.trade_name}</option>)}</select>}
          </div>
          <input placeholder="Motivo" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
          <ActionButton disabled={f.reason.length < 3 || (needsCity && !f.cityId) || (f.role === 'merchant_owner' && !f.merchantId)} onClick={async () => { await api.call('adminGrantRole', { body: { userId: user.id, role: f.role as any, cityId: f.cityId || undefined, merchantId: f.merchantId || undefined, reason: f.reason } }); await reloadUser(); }}>Otorgar rol</ActionButton>
        </div>
      )}
    </div>
  );
}
