'use client';
import { formatPEN, LABELS } from '@aquisito/contracts';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import { api, errorMessage, useOnline } from '@/lib/api';
import type { MeDto } from '@aquisito/contracts';

export const Money = ({ cents, className }: { cents: number; className?: string }) => <span className={className ?? 'price'}>{formatPEN(cents)}</span>;

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="alert error" role="alert">
      {errorMessage(error)} {onRetry && <button className="btn sm ghost" onClick={onRetry}>Reintentar</button>}
    </div>
  );
}

export const Loading = ({ lines = 2 }: { lines?: number }) => (
  <div className="col" aria-busy="true" aria-label="Cargando">
    {Array.from({ length: lines }).map((_, i) => <div key={i} className="skeleton" />)}
  </div>
);

export const Empty = ({ children }: { children: ReactNode }) => <div className="card muted" style={{ textAlign: 'center' }}>{children}</div>;

export function StatusBadge({ cycle, status }: { cycle: 'commercial' | 'delivery' | 'payment'; status: string }) {
  const label = (LABELS as any)[cycle]?.[status] ?? status;
  const bad = ['rechazado_comercio', 'cancelado', 'fallido', 'vencido', 'entrega_fallida', 'entrega_rechazada'].includes(status);
  const warn = ['pendiente', 'pendiente_confirmacion', 'en_conciliacion', 'reembolso_pendiente', 'verificacion_requerida', 'retorno_pendiente'].includes(status);
  return <span className={`badge ${bad ? 'danger' : warn ? 'warn' : ''}`}>{label}</span>;
}

/** Botón de acción asíncrona con estado "procesando" para evitar dobles envíos. */
export function ActionButton({ onClick, children, className, disabled, confirm }: { onClick: () => Promise<unknown>; children: ReactNode; className?: string; disabled?: boolean; confirm?: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  return (
    <span className="col" style={{ gap: 4 }}>
      <button
        className={`btn ${className ?? ''}`}
        disabled={busy || disabled}
        onClick={async () => {
          if (confirm && !window.confirm(confirm)) return;
          setBusy(true);
          setErr(null);
          try {
            await onClick();
          } catch (e) {
            setErr(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Procesando…' : children}
      </button>
      {err ? <span className="alert error small" role="alert">{errorMessage(err)}</span> : null}
    </span>
  );
}

interface Session {
  me: MeDto | null;
  loading: boolean;
  refresh: () => Promise<void>;
  has: (role: string) => boolean;
}
const SessionCtx = createContext<Session>({ me: null, loading: true, refresh: async () => undefined, has: () => false });
export const useSession = () => useContext(SessionCtx);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeDto | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    try {
      setMe(await api.call('me'));
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    refresh();
  }, []);
  const has = (role: string) => !!me?.memberships.some((m) => m.role === role);
  return <SessionCtx.Provider value={{ me, loading, refresh, has }}>{children}</SessionCtx.Provider>;
}

export function Shell({ children }: { children: ReactNode }) {
  const online = useOnline();
  const path = usePathname();
  const { me, has } = useSession();
  const staff = has('admin') || has('city_dispatcher') || has('support_agent') || has('finance');
  const merchant = has('merchant_owner') || has('branch_operator');
  const tabs = [
    { href: '/', label: 'Inicio' },
    { href: '/buscar', label: 'Buscar' },
    { href: '/pedidos', label: 'Pedidos' },
    { href: '/cuenta', label: 'Cuenta' },
  ];
  return (
    <>
      {!online && <div className="offline" role="status">Sin conexión. Mostramos lo último que cargaste; las compras y entregas se confirman solo con el servidor.</div>}
      <header className="topbar">
        <div className="inner">
          <Link href="/" className="brand" aria-label="Aquisito, inicio">aqui<span>sito</span></Link>
          <span className="small" style={{ opacity: 0.8 }}>Delivery en Aguaytía y Tingo María</span>
          <span className="spacer" />
          {merchant && <Link className="chip" href="/comercio">Panel comercio</Link>}
          {has('courier') && <Link className="chip" href="/repartidor">Repartidor</Link>}
          {staff && <Link className="chip" href="/admin">Administración</Link>}
          {me ? <Link className="chip" href="/cuenta">{me.fullName.split(' ')[0]}</Link> : <Link className="chip" href="/cuenta">Ingresar</Link>}
        </div>
      </header>
      <main className="container">{children}</main>
      <nav className="tabbar" aria-label="Navegación principal">
        {tabs.map((t) => (
          <Link key={t.href} href={t.href} className={(t.href === '/' ? path === '/' : path?.startsWith(t.href)) ? 'on' : ''}>{t.label}</Link>
        ))}
      </nav>
    </>
  );
}

export function AlcoholNotices() {
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="legal">Prohibida la venta de bebidas alcohólicas a menores de 18 años</div>
      <div className="legal">Tomar bebidas alcohólicas en exceso es dañino</div>
    </div>
  );
}
