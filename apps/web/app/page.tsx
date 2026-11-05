'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { CityDto, StoreSummaryDto } from '@aquisito/contracts';
import { api, prefs, useQuery } from '@/lib/api';
import { Empty, ErrorBox, Loading, Money, useSession } from '@/components/ui';

const KINDS: [string, string][] = [
  ['', 'Todo'],
  ['food', 'Comida'],
  ['market', 'Market y abarrotes'],
  ['drinks', 'Bebidas'],
  ['offers', 'Combos'],
];

export default function Home() {
  const { me } = useSession();
  const cities = useQuery<CityDto[]>('cities');
  const [cityId, setCityId] = useState<string | null>(null);
  const [kind, setKind] = useState('');
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [sort, setSort] = useState('');
  const [geoMsg, setGeoMsg] = useState<string | null>(null);
  const addresses = useQuery<any[]>(me ? 'addresses' : null, {}, [me?.id]);
  const [addressId, setAddressId] = useState<string | null>(null);

  useEffect(() => {
    if (!cities.data?.length || cityId) return;
    const saved = prefs.get('city');
    setCityId(cities.data.find((c) => c.id === saved)?.id ?? null);
  }, [cities.data, cityId]);

  const cityAddresses = useMemo(() => (addresses.data ?? []).filter((a) => a.cityId === cityId), [addresses.data, cityId]);
  const address = cityAddresses.find((a) => a.id === addressId) ?? cityAddresses[0];
  const city = cities.data?.find((c) => c.id === cityId);

  const stores = useQuery<StoreSummaryDto[]>(cityId ? 'stores' : null, {
    query: { cityId: cityId ?? '', categoryKind: kind || undefined, open: onlyOpen ? 'true' : undefined, sort: sort || undefined, lat: address?.lat, lng: address?.lng },
  });

  const choose = (id: string) => {
    setCityId(id);
    prefs.set('city', id);
  };

  const suggest = () => {
    if (!navigator.geolocation) return setGeoMsg('Tu navegador no permite ubicación');
    setGeoMsg('Solicitando permiso de ubicación…');
    navigator.geolocation.getCurrentPosition(
      async (p) => {
        const r = await api.call('suggestCity', { query: { lat: p.coords.latitude, lng: p.coords.longitude } });
        if (r?.id) {
          choose(r.id);
          setGeoMsg(`Te sugerimos ${r.name}. Puedes cambiarla cuando quieras.`);
        }
      },
      () => setGeoMsg('No se otorgó el permiso. Elige tu ciudad manualmente.'),
    );
  };

  if (cities.loading) return <Loading />;
  if (cities.error) return <ErrorBox error={cities.error} onRetry={cities.reload} />;

  if (!cityId) {
    return (
      <section className="col" style={{ marginTop: 24 }}>
        <h1>¿Dónde recibes tu pedido?</h1>
        <p className="muted">Operamos de forma independiente en cada ciudad: comercios, repartidores, tarifas y horarios propios. No hacemos envíos entre ciudades.</p>
        <div className="grid">
          {cities.data!.map((c) => (
            <button key={c.id} className="card btn secondary" style={{ minHeight: 90, fontSize: '1.2rem' }} onClick={() => choose(c.id)} disabled={c.status !== 'active'}>
              {c.name}
              {c.status !== 'active' && <div className="small">Pausado: {c.pauseReason}</div>}
            </button>
          ))}
        </div>
        <button className="btn ghost" onClick={suggest}>Sugerir según mi ubicación</button>
        {geoMsg && <p className="muted">{geoMsg}</p>}
      </section>
    );
  }

  return (
    <section>
      <div className="row" style={{ margin: '14px 0 6px' }}>
        <span className="chip light" onClick={() => setCityId(null)} role="button" tabIndex={0} aria-label="Cambiar ciudad">📍 {city?.name} · cambiar</span>
        {me ? (
          cityAddresses.length ? (
            <select aria-label="Dirección de entrega" value={address?.id} onChange={(e) => setAddressId(e.target.value)} style={{ maxWidth: 360 }}>
              {cityAddresses.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}: {a.line1} {a.number ?? ''} {a.inCoverage ? '' : '(fuera de cobertura)'}
                </option>
              ))}
            </select>
          ) : (
            <Link className="chip light" href="/cuenta#direcciones">Agrega una dirección en {city?.name}</Link>
          )
        ) : (
          <Link className="chip light" href="/cuenta">Ingresa para ver costo de envío exacto</Link>
        )}
      </div>
      {address && !address.inCoverage && <div className="alert warn">Esta dirección está fuera de la zona de reparto: {address.coverageMessage}</div>}
      {city?.status === 'paused' && <div className="alert warn">Operación pausada en {city.name}: {city.pauseReason}</div>}

      <div className="tabs" role="tablist" aria-label="Categorías">
        {KINDS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={kind === k} className={`chip light ${kind === k ? 'active' : ''}`} onClick={() => setKind(k)}>{l}</button>
        ))}
      </div>
      <div className="row muted small" style={{ marginBottom: 10 }}>
        <label className="check"><input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> Solo abiertos</label>
        <select aria-label="Ordenar" value={sort} onChange={(e) => setSort(e.target.value)} style={{ maxWidth: 220 }}>
          <option value="">Ordenar: abiertos primero</option>
          <option value="eta">Menor tiempo estimado</option>
          <option value="fee">Menor costo de envío</option>
        </select>
      </div>

      {stores.loading ? <Loading lines={3} /> : stores.error ? <ErrorBox error={stores.error} onRetry={stores.reload} /> : !stores.data?.length ? (
        <Empty>No hay comercios con estos filtros en {city?.name}.</Empty>
      ) : (
        <div className="grid">
          {stores.data.map((s) => (
            <Link key={s.id} href={`/tienda/${s.id}${address ? `?lat=${address.lat}&lng=${address.lng}` : ''}`} className="card store-card">
              <div className={`thumb ${s.isOpen ? '' : 'closed'}`}>{s.isDemo ? 'Imagen demostrativa' : ''}</div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong>{s.name}</strong>
                {s.isOpen ? <span className="badge">Abierto</span> : <span className="badge closed">Cerrado</span>}
              </div>
              {!s.isOpen && <span className="muted small">{s.closedReason}</span>}
              <span className="muted small">
                {s.etaMinutes ? `${s.etaMinutes.min}–${s.etaMinutes.max} min (estimado)` : ''} ·{' '}
                {s.deliveryFeeCents != null ? <>Envío <Money cents={s.deliveryFeeCents} className="" />{s.distanceMethod === 'approx_haversine' ? ' aprox.' : ''}</> : 'Envío según dirección'}
                {s.minOrderCents ? <> · Mínimo <Money cents={s.minOrderCents} className="" /></> : null}
              </span>
              <span className="muted small">{s.rating ? `★ ${s.rating}` : 'Sin valoraciones aún'}{s.acceptsCash ? ' · Acepta efectivo' : ''}</span>
            </Link>
          ))}
        </div>
      )}
      <p className="muted small" style={{ marginTop: 18 }}>Datos de demostración: comercios, precios y zonas son ficticios. Los tiempos son estimaciones, no promesas.</p>
    </section>
  );
}
