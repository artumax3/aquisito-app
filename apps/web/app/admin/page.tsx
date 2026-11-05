'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { CityDto } from '@aquisito/contracts';
import { ApiError, api, errorMessage, useQuery, useRealtime } from '@/lib/api';
import { ActionButton, Empty, ErrorBox, Loading, Money, StatusBadge, useSession } from '@/components/ui';
import { kindLabel } from '@/components/upload';

type Tab = 'dash' | 'orders' | 'couriers' | 'merchants' | 'docs' | 'age' | 'cities' | 'promos' | 'banners' | 'finance' | 'support' | 'privacy' | 'audit';
const TABS: [Tab, string][] = [['dash', 'Indicadores'], ['orders', 'Pedidos y despacho'], ['couriers', 'Repartidores'], ['merchants', 'Comercios'], ['docs', 'Documentos'], ['age', 'Verificación de edad'], ['cities', 'Ciudades, zonas y alcohol'], ['promos', 'Cupones'], ['banners', 'Banners'], ['finance', 'Finanzas'], ['support', 'Incidencias y reclamaciones'], ['privacy', 'Datos personales'], ['audit', 'Auditoría y eventos']];

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
      {tab === 'cities' && <Cities />}
      {tab === 'promos' && <Coupons />}
      {tab === 'banners' && <Banners />}
      {tab === 'docs' && <Documents />}
      {tab === 'finance' && <Finance />}
      {tab === 'support' && <Support />}
      {tab === 'privacy' && <Privacy />}
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
