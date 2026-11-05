'use client';
import { useEffect } from 'react';

/** Registra el service worker (instalable). No cachea respuestas de la API. */
export function ServiceWorker() {
  useEffect(() => {
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }, []);
  return null;
}
