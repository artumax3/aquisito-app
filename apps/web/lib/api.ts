'use client';
import { ApiError, createClient, NetworkError } from '@aquisito/api-client';
import type { EndpointKey } from '@aquisito/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

/** Cliente web: mismo origen (/api), cookie httpOnly y CSRF de doble envío. */
export const api = createClient({ baseUrl: '/api', mode: 'cookie', getCsrf: () => readCookie('aq_csrf') });

export { ApiError, NetworkError };

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const problems = (e.details as any)?.problems as string[] | undefined;
    return problems?.length ? `${e.message}: ${problems.join('; ')}` : e.message;
  }
  if (e instanceof NetworkError) return e.message;
  return 'Ocurrió un error inesperado';
}

/** Carga datos de un endpoint con estados de carga/error y recarga manual. */
export function useQuery<T = any>(key: EndpointKey | null, opts: { params?: Record<string, string>; query?: Record<string, any> } = {}, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(!!key);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const reload = useCallback(async () => {
    if (!key) return;
    setLoading(true);
    try {
      const r = await api.call(key, optsRef.current as any);
      setData(r as T);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, JSON.stringify(opts.params), JSON.stringify(opts.query), ...deps]);
  useEffect(() => {
    reload();
  }, [reload]);
  // Si la clave acaba de habilitarse (p. ej. al cargar la sesión) aún no hay datos: seguir en carga.
  return { data, error, loading: loading || (!!key && data === null && error === null), reload, setData };
}

/**
 * Suscripción en tiempo real (SSE). Los eventos solo avisan "algo cambió": la verdad se vuelve a
 * consultar a la API. Al reconectar también se recarga, para no perder novedades.
 */
export function useRealtime(onEvent: (type: string, data: any) => void, enabled = true) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    let es: EventSource | null = null;
    let stopped = false;
    let retry: any;
    const connect = () => {
      es = new EventSource('/api/realtime', { withCredentials: true });
      es.addEventListener('ready', () => cb.current('reconnected', {}));
      const handler = (ev: MessageEvent) => {
        try {
          cb.current((ev as any).type, JSON.parse(ev.data));
        } catch {
          /* noop */
        }
      };
      for (const t of ['order.status_changed', 'order.created', 'offer.created', 'order.cancelled', 'substitution.proposed', 'substitution.responded', 'order.message', 'incident.created', 'refund.confirmed', 'order.eta_changed', 'age_verification.decided', 'complaint.created']) es.addEventListener(t, handler as any);
      es.onerror = () => {
        es?.close();
        if (!stopped) retry = setTimeout(connect, 4000);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      es?.close();
    };
  }, [enabled]);
}

export function useOnline() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    setOnline(navigator.onLine);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

/** Preferencias NO sensibles en almacenamiento local (ciudad elegida). Nunca pagos ni entregas. */
export const prefs = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(`aq:${k}`);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(`aq:${k}`, v);
    } catch {
      /* noop */
    }
  },
};
