'use client';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { CourierDeliveryDto, OfferDto } from '@aquisito/contracts';
import { LABELS } from '@aquisito/contracts';
import { api, errorMessage, useQuery, useRealtime } from '@/lib/api';
import { ActionButton, AlcoholNotices, Empty, Loading, Money, useSession } from '@/components/ui';
import { DocumentList, DocumentUploader } from '@/components/upload';

const MapView = dynamic(() => import('@/components/map').then((m) => m.MapView), { ssr: false });

/**
 * Vista web de apoyo para repartidores (la aplicación principal es apps/courier-mobile).
 * La ubicación en navegador solo funciona con la pestaña abierta; no hay rastreo en segundo plano.
 */
export default function CourierPage() {
  const { me, has, loading } = useSession();
  const profile = useQuery<any>(has('courier') ? 'courierMe' : null, {}, [me?.id]);
  const offers = useQuery<OfferDto[]>(has('courier') ? 'courierOffers' : null);
  const current = useQuery<CourierDeliveryDto | { none: true }>(has('courier') ? 'courierDelivery' : null);
  const [geo, setGeo] = useState<{ lat: number; lng: number; acc: number; at: Date } | null>(null);
  const [geoErr, setGeoErr] = useState<string | null>(null);
  const watch = useRef<number | null>(null);
  useRealtime(() => { offers.reload(); current.reload(); }, has('courier'));

  useEffect(() => {
    if (!profile.data?.available || !navigator.geolocation) return;
    watch.current = navigator.geolocation.watchPosition(
      async (p) => {
        const g = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, at: new Date(p.timestamp) };
        setGeo(g);
        try {
          await api.call('courierLocation', { body: { lat: g.lat, lng: g.lng, accuracyM: Math.min(10000, g.acc), recordedAt: g.at.toISOString() } });
          setGeoErr(null);
        } catch (e) {
          setGeoErr(errorMessage(e));
        }
      },
      (e) => setGeoErr(`Ubicación no disponible: ${e.message}`),
      { enableHighAccuracy: true, maximumAge: 15000 },
    );
    return () => { if (watch.current != null) navigator.geolocation.clearWatch(watch.current); };
  }, [profile.data?.available]);

  if (loading) return <Loading />;
  if (!me) return <Empty>Ingresa con tu cuenta de repartidor. <Link href="/cuenta">Ingresar</Link></Empty>;
  if (!has('courier')) return <Empty>Aún no eres repartidor. <Link href="/repartidor/postular">Postular</Link></Empty>;
  if (profile.loading) return <Loading />;
  const p = profile.data;
  const d = current.data && !('none' in current.data) ? current.data : null;

  return (
    <section className="col" style={{ marginTop: 12 }}>
      <h1>Repartidor · {p?.cityName}</h1>
      <div className="alert info small">Vista web de apoyo. Para ubicación en segundo plano usa la app móvil (requiere compilación nativa y prueba en dispositivo).</div>
      {p?.status !== 'approved' && <div className="alert warn">Tu cuenta está {p?.status === 'pending' ? 'en revisión' : p?.status}. Podrás conectarte cuando sea aprobada.</div>}
      {p?.status === 'approved' && (
        <div className="card row" style={{ justifyContent: 'space-between' }}>
          <span>{p.available ? '🟢 Disponible' : '⚪ No disponible'} {geo && <span className="small muted">· ubicación {geo.at.toLocaleTimeString('es-PE')} ±{Math.round(geo.acc)} m</span>}</span>
          <ActionButton className={p.available ? 'ghost' : ''} onClick={async () => { await api.call('courierAvailability', { body: { available: !p.available } }); profile.reload(); }}>{p.available ? 'Desconectarme' : 'Conectarme'}</ActionButton>
        </div>
      )}
      {geoErr && <div className="alert warn small">{geoErr}</div>}

      {d ? <ActiveDelivery d={d} reload={() => { current.reload(); offers.reload(); }} /> : (
        <div className="col">
          <h2>Ofertas</h2>
          {!offers.data?.length && <Empty>Sin ofertas por ahora.</Empty>}
          {offers.data?.map((o) => <Offer key={o.id} o={o} onDone={() => { offers.reload(); current.reload(); }} />)}
        </div>
      )}
      <Earnings />
      <CourierDocs />
    </section>
  );
}

function Offer({ o, onDone }: { o: OfferDto; onDone: () => void }) {
  const [left, setLeft] = useState(Math.round((new Date(o.expiresAt).getTime() - Date.now()) / 1000));
  useEffect(() => {
    const h = setInterval(() => setLeft(Math.round((new Date(o.expiresAt).getTime() - Date.now()) / 1000)), 1000);
    return () => clearInterval(h);
  }, [o.expiresAt]);
  return (
    <div className="card col">
      <div className="row" style={{ justifyContent: 'space-between' }}><strong>{o.branchName} → {o.destinationArea}</strong><span className="badge warn">{left > 0 ? `${left} s` : 'vencida'}</span></div>
      <span>Recorrido estimado {(o.estimatedDistanceMeters / 1000).toFixed(1)} km · Pago estimado <Money cents={o.estimatedPayCents} className="" /></span>
      {o.containsAlcohol && <span className="badge adult">Contiene alcohol: verificación presencial obligatoria</span>}
      {o.cashToCollectCents && <span className="small">Cobrar en efectivo: <Money cents={o.cashToCollectCents} className="" /></span>}
      <div className="row">
        <ActionButton disabled={left <= 0} onClick={async () => { await api.call('courierAcceptOffer', { params: { id: o.id } }); onDone(); }}>Aceptar</ActionButton>
        <ActionButton className="ghost" onClick={async () => { await api.call('courierRejectOffer', { params: { id: o.id } }); onDone(); }}>Rechazar</ActionButton>
      </div>
    </div>
  );
}

function ActiveDelivery({ d, reload }: { d: CourierDeliveryDto; reload: () => void }) {
  const [pickup, setPickup] = useState({ code: '', packages: d.packages });
  const [code, setCode] = useState('');
  const [cash, setCash] = useState('');
  const [doc, setDoc] = useState('dni');
  const [match, setMatch] = useState(false);
  const [reject, setReject] = useState('no_document');
  const [fail, setFail] = useState({ kind: 'customer_absent', notes: '' });
  const st = d.deliveryStatus;
  const act = (fn: () => Promise<unknown>) => async () => { await fn(); reload(); };
  const nav = (lat: number, lng: number) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  return (
    <div className="card col">
      <h2>Pedido #{d.orderNumber} · {(LABELS.delivery as any)[st]}</h2>
      <p className="alert warn small">Opera con el vehículo detenido.</p>
      <MapView center={{ lat: d.branch.lat, lng: d.branch.lng }} markers={[{ lat: d.branch.lat, lng: d.branch.lng, label: d.branch.name }, { lat: d.customer.lat, lng: d.customer.lng, label: 'Cliente', color: '#c2410c' }]} height={220} />
      <span><strong>Recoger en:</strong> {d.branch.name} · {d.branch.address} · <a href={nav(d.branch.lat, d.branch.lng)} target="_blank" rel="noreferrer">Navegar</a></span>
      <span><strong>Entregar a:</strong> {d.customer.name} · {d.customer.address} {d.customer.reference ? `(${d.customer.reference})` : ''} · {d.customer.phoneMasked} · <a href={nav(d.customer.lat, d.customer.lng)} target="_blank" rel="noreferrer">Navegar</a></span>
      {d.customer.instructions && <span className="small">Instrucciones: {d.customer.instructions}</span>}
      {d.cashToCollectCents && <span className="alert info">Cobrar <Money cents={d.cashToCollectCents} className="" /> en efectivo{d.cashChangeForCents ? ` (paga con S/ ${(d.cashChangeForCents / 100).toFixed(2)})` : ''}</span>}
      {d.containsAlcohol && <AlcoholNotices />}

      {st === 'asignado' && <ActionButton onClick={act(() => api.call('courierHeading', { params: { orderId: d.orderId } }))}>Voy al comercio</ActionButton>}
      {['asignado', 'en_camino_al_comercio'].includes(st) && (
        <div className="col">
          {d.commercialStatus !== 'listo_para_recojo' && <span className="muted small">El comercio aún prepara el pedido.</span>}
          <input placeholder="Código de recojo (lo muestra el comercio)" inputMode="numeric" value={pickup.code} onChange={(e) => setPickup({ ...pickup, code: e.target.value })} />
          <label>Paquetes recibidos<input type="number" min={1} value={pickup.packages} onChange={(e) => setPickup({ ...pickup, packages: Number(e.target.value) })} /></label>
          <ActionButton disabled={!pickup.code} onClick={act(() => api.call('courierPickup', { params: { orderId: d.orderId }, body: { pickupCode: pickup.code, packages: pickup.packages } }))}>Confirmar recojo</ActionButton>
        </div>
      )}
      {st === 'recogido' && <ActionButton onClick={act(() => api.call('courierDepart', { params: { orderId: d.orderId } }))}>En camino al cliente</ActionButton>}
      {st === 'en_camino_al_cliente' && <ActionButton onClick={act(() => api.call('courierArrive', { params: { orderId: d.orderId } }))}>Llegué al destino</ActionButton>}

      {st === 'verificacion_requerida' && !d.ageCheckApproved && (
        <div className="col alert warn">
          <strong>Verificación presencial de edad obligatoria</strong>
          <span className="small">Pide un documento oficial (DNI, carné de extranjería o pasaporte). Comprueba que la foto y el nombre corresponden al comprador y que tiene 18 años cumplidos. No fotografíes el documento. El código de entrega NO reemplaza esta verificación. Nunca dejes el pedido en la puerta ni lo entregues a otra persona o a un menor.</span>
          <select value={doc} onChange={(e) => setDoc(e.target.value)}><option value="dni">DNI</option><option value="carne_extranjeria">Carné de extranjería</option><option value="pasaporte">Pasaporte</option></select>
          <label className="check"><input type="checkbox" checked={match} onChange={(e) => setMatch(e.target.checked)} /> La persona coincide con el documento, es el comprador y tiene 18 años o más</label>
          <ActionButton disabled={!match} onClick={act(() => api.call('courierAgeCheck', { params: { orderId: d.orderId }, body: { result: 'approved', documentType: doc as any, identityMatchesBuyer: true } }))}>Verificación aprobada</ActionButton>
          <select value={reject} onChange={(e) => setReject(e.target.value)}>
            <option value="no_document">No presenta documento</option><option value="identity_mismatch">Identidad no coincide</option><option value="underage">Menor de 18 años</option><option value="recipient_not_buyer">No es el comprador</option><option value="manifest_intoxication">Intoxicación manifiesta</option><option value="safety_risk">Riesgo de seguridad</option>
          </select>
          <ActionButton className="warn" confirm="Se rechazará la entrega completa y el pedido volverá al comercio. ¿Confirmar?" onClick={act(() => api.call('courierAgeCheck', { params: { orderId: d.orderId }, body: { result: 'rejected', rejectionReason: reject as any, identityMatchesBuyer: false } }))}>Rechazar entrega</ActionButton>
          <span className="small">Si no tienes conexión, no entregues: espera señal o contacta a soporte. La entrega solo se cierra con validación del servidor.</span>
        </div>
      )}
      {(st === 'en_destino' || (st === 'verificacion_requerida' && d.ageCheckApproved)) && (
        <div className="col">
          <input placeholder="Código de entrega (4 dígitos, lo dicta el cliente)" inputMode="numeric" maxLength={4} value={code} onChange={(e) => setCode(e.target.value)} />
          {d.cashToCollectCents && <input placeholder="Efectivo recibido (S/)" inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} />}
          <ActionButton disabled={code.length !== 4} onClick={act(() => api.call('courierDeliver', { params: { orderId: d.orderId }, body: { deliveryCode: code, cashCollectedCents: cash ? Math.round(Number(cash) * 100) : undefined } }))}>Confirmar entrega</ActionButton>
        </div>
      )}
      {['en_camino_al_cliente', 'en_destino'].includes(st) && (
        <details>
          <summary className="small">Problema con la entrega</summary>
          <div className="col">
            <select value={fail.kind} onChange={(e) => setFail({ ...fail, kind: e.target.value })}><option value="customer_absent">Cliente ausente</option><option value="wrong_address">Dirección incorrecta</option><option value="accident">Accidente</option><option value="vehicle_breakdown">Avería</option></select>
            <input placeholder="Detalle" value={fail.notes} onChange={(e) => setFail({ ...fail, notes: e.target.value })} />
            <ActionButton className="warn" disabled={fail.notes.length < 3} onClick={act(() => api.call('courierFail', { params: { orderId: d.orderId }, body: fail as any }))}>Reportar y devolver al comercio</ActionButton>
          </div>
        </details>
      )}
      {st === 'retorno_pendiente' && <div className="alert info">Lleva el pedido de vuelta al comercio. El comercio confirmará la recepción.</div>}
      {['asignado', 'en_camino_al_comercio'].includes(st) && <ActionButton className="ghost sm" confirm="¿Liberar este pedido? Se buscará otro repartidor." onClick={act(() => api.call('courierRelease', { params: { orderId: d.orderId }, body: { reason: 'Liberado por el repartidor' } }))}>Liberar pedido</ActionButton>}
    </div>
  );
}

function Earnings() {
  const e = useQuery<any>('courierEarnings');
  if (!e.data) return null;
  return (
    <div className="card col">
      <h2>Ingresos y efectivo</h2>
      <div className="grid">
        <div><div className="muted small">Pagos por reparto</div><Money cents={e.data.deliveryPayCents} /></div>
        <div><div className="muted small">Propinas</div><Money cents={e.data.tipsCents} /></div>
        <div><div className="muted small">Efectivo por rendir</div><Money cents={e.data.cashHeldCents} /></div>
        <div><div className="muted small">Saldo de operación</div><Money cents={e.data.balanceCents} /></div>
      </div>
      <span className="muted small">{e.data.note}</span>
    </div>
  );
}

function CourierDocs() {
  const docs = useQuery<any[]>('courierDocuments');
  return (
    <details className="card">
      <summary><strong>Mis documentos</strong></summary>
      <div className="col">
        <DocumentList docs={docs.data ?? []} />
        <DocumentUploader ownerType="courier" kinds={['documento_identidad', 'licencia_conducir', 'soat', 'tarjeta_propiedad', 'otro']} onDone={docs.reload} />
      </div>
    </details>
  );
}
