'use client';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useState } from 'react';
import type { CityDto } from '@aquisito/contracts';
import { api, errorMessage, useQuery } from '@/lib/api';
import { Empty, useSession } from '@/components/ui';

const MapView = dynamic(() => import('@/components/map').then((m) => m.MapView), { ssr: false });

export default function MerchantApply() {
  const { me, refresh } = useSession();
  const cities = useQuery<CityDto[]>('cities');
  const [f, setF] = useState({ tradeName: '', legalName: '', ruc: '', contactPhone: '+51', settlementAccount: '', cityId: '', name: '', address: '' });
  const [pt, setPt] = useState<{ lat: number; lng: number } | null>(null);
  const [res, setRes] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!me) return <Empty>Crea una cuenta primero. <Link href="/cuenta">Ingresar</Link></Empty>;
  const city = cities.data?.find((c) => c.id === f.cityId);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <section className="col" style={{ marginTop: 12, maxWidth: 640 }}>
      <h1>Registrar mi negocio</h1>
      <p className="muted small">Tu comercio se publicará solo después de la revisión administrativa. Para vender bebidas alcohólicas se requiere una revisión adicional de habilitaciones y permisos.</p>
      <form className="card col" onSubmit={async (e) => { e.preventDefault(); setErr(null); try { const r = await api.call('merchantApply', { body: { tradeName: f.tradeName, legalName: f.legalName || undefined, ruc: f.ruc || undefined, contactPhone: f.contactPhone, settlementAccount: f.settlementAccount || undefined, branch: { cityId: f.cityId, name: f.name, address: f.address, lat: pt!.lat, lng: pt!.lng } } }); setRes(r.note); await refresh(); } catch (x) { setErr(errorMessage(x)); } }}>
        <input required placeholder="Nombre comercial" value={f.tradeName} onChange={set('tradeName')} />
        <input placeholder="Razón social (si corresponde)" value={f.legalName} onChange={set('legalName')} />
        <input placeholder="RUC (si corresponde)" value={f.ruc} onChange={set('ruc')} />
        <input required placeholder="Teléfono de contacto (+51…)" value={f.contactPhone} onChange={set('contactPhone')} />
        <input placeholder="Cuenta para liquidaciones (banco y número)" value={f.settlementAccount} onChange={set('settlementAccount')} />
        <h2>Sucursal</h2>
        <select required value={f.cityId} onChange={set('cityId')}><option value="">Ciudad</option>{cities.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <input required placeholder="Nombre de la sucursal" value={f.name} onChange={set('name')} />
        <input required placeholder="Dirección" value={f.address} onChange={set('address')} />
        {city && <MapView center={city.center} pick={pt} onPick={setPt} />}
        {err && <div className="alert error">{err}</div>}
        {res && <div className="alert ok">{res}</div>}
        <button className="btn" disabled={!pt}>Enviar solicitud</button>
      </form>
    </section>
  );
}
