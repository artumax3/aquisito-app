'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, errorMessage, prefs } from '@/lib/api';
import { Empty, Money } from '@/components/ui';

export default function SearchPage() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const cityId = typeof window !== 'undefined' ? prefs.get('city') : null;

  useEffect(() => {
    if (q.trim().length < 2 || !cityId) return setRes(null);
    const h = setTimeout(async () => {
      setLoading(true);
      try {
        setRes(await api.call('search', { query: { cityId, q } }));
        setErr(null);
      } catch (e) {
        setErr(errorMessage(e));
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(h);
  }, [q, cityId]);

  if (!cityId) return <Empty>Elige primero tu ciudad en <Link href="/">Inicio</Link>.</Empty>;
  return (
    <section className="col" style={{ marginTop: 12 }}>
      <h1>Buscar</h1>
      <input type="search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Comercio, plato o producto" aria-label="Buscar" />
      {loading && <span className="muted">Buscando…</span>}
      {err && <div className="alert error">{err}</div>}
      {res && (
        <>
          <h2>Comercios</h2>
          {!res.stores.length && <span className="muted">Sin coincidencias.</span>}
          {res.stores.map((s: any) => <Link key={s.id} href={`/tienda/${s.id}`} className="card">{s.name} {s.isOpen ? <span className="badge">Abierto</span> : <span className="badge closed">Cerrado</span>}</Link>)}
          <h2>Productos</h2>
          {!res.products.length && <span className="muted">Sin coincidencias.</span>}
          {res.products.map((p: any) => (
            <Link key={p.id} href={`/tienda/${p.branchId}`} className="card row" style={{ justifyContent: 'space-between' }}>
              <span>{p.name} <span className="muted small">· {p.branchName}</span></span>
              <span>desde <Money cents={p.fromPriceCents} /></span>
            </Link>
          ))}
        </>
      )}
    </section>
  );
}
