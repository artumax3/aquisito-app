'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { CityDto } from '@aquisito/contracts';
import { api, errorMessage, useQuery } from '@/lib/api';
import { Empty, useSession } from '@/components/ui';

export default function CourierApply() {
  const { me, refresh } = useSession();
  const cities = useQuery<CityDto[]>('cities');
  const [f, setF] = useState({ cityId: '', birthDate: '', vehicleType: 'moto', vehiclePlate: '', termsAccepted: false });
  const [res, setRes] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!me) return <Empty>Crea una cuenta primero. <Link href="/cuenta">Ingresar</Link></Empty>;
  return (
    <section className="col" style={{ marginTop: 12, maxWidth: 520 }}>
      <h1>Postular como repartidor</h1>
      <p className="muted small">Debes tener 18 años cumplidos. Revisamos manualmente tu identidad, vehículo y documentos; esto no constituye una validación oficial. La activación requiere aprobación y capacitación (incluida la entrega responsable de productos restringidos).</p>
      <form className="card col" onSubmit={async (e) => { e.preventDefault(); setErr(null); try { const r = await api.call('courierApply', { body: { ...f, vehiclePlate: f.vehiclePlate || undefined, vehicleType: f.vehicleType as any, termsAccepted: true } }); setRes(r.note); await refresh(); } catch (x) { setErr(errorMessage(x)); } }}>
        <select required value={f.cityId} onChange={(e) => setF({ ...f, cityId: e.target.value })}><option value="">Ciudad</option>{cities.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <label>Fecha de nacimiento<input type="date" required value={f.birthDate} onChange={(e) => setF({ ...f, birthDate: e.target.value })} /></label>
        <select value={f.vehicleType} onChange={(e) => setF({ ...f, vehicleType: e.target.value })}><option value="moto">Moto</option><option value="mototaxi">Mototaxi</option><option value="bicicleta">Bicicleta</option><option value="auto">Auto</option><option value="a_pie">A pie</option></select>
        <input placeholder="Placa (si aplica)" value={f.vehiclePlate} onChange={(e) => setF({ ...f, vehiclePlate: e.target.value.toUpperCase() })} />
        <label className="check"><input type="checkbox" checked={f.termsAccepted} onChange={(e) => setF({ ...f, termsAccepted: e.target.checked })} /> Acepto las condiciones operativas (borrador) y compartir mi ubicación solo mientras estoy disponible o con una entrega activa.</label>
        {err && <div className="alert error">{err}</div>}
        {res && <div className="alert ok">{res}</div>}
        <button className="btn" disabled={!f.termsAccepted}>Enviar postulación</button>
      </form>
    </section>
  );
}
