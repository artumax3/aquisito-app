'use client';
/**
 * Integración con Culqi Checkout (JS v4) para tarjetas y billeteras (Yape/Plin vía orden de pago).
 * Escrita según la documentación pública; SIN PROBAR con una cuenta real (no hay llaves). Verificar
 * nombres de opciones y eventos con la documentación vigente antes de activar.
 * El navegador nunca envía el número de tarjeta a nuestro servidor: solo el token de Culqi.
 */
declare global {
  interface Window {
    Culqi?: any;
    culqi?: () => void;
  }
}

const SCRIPT = 'https://checkout.culqi.com/js/v4';
let loading: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.Culqi) return Promise.resolve();
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SCRIPT;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        loading = null;
        reject(new Error('No se pudo cargar el checkout del proveedor'));
      };
      document.head.appendChild(s);
    });
  }
  return loading;
}

export async function openCulqiCheckout(opts: { publicKey: string; amountCents: number; title: string; orderReference?: string | null }): Promise<{ token?: string; orderCompleted?: boolean }> {
  await loadScript();
  const Culqi = window.Culqi;
  Culqi.publicKey = opts.publicKey;
  Culqi.settings({ title: opts.title, currency: 'PEN', amount: opts.amountCents, ...(opts.orderReference ? { order: opts.orderReference } : {}) });
  Culqi.options({ lang: 'auto', installments: false, paymentMethods: { tarjeta: !opts.orderReference, yape: !!opts.orderReference, billetera: !!opts.orderReference, bancaMovil: false, agente: false, cuotealo: false } });
  return new Promise((resolve, reject) => {
    window.culqi = () => {
      if (Culqi.token) {
        Culqi.close();
        resolve({ token: Culqi.token.id });
      } else if (Culqi.order) {
        Culqi.close();
        // La confirmación real llega por webhook verificado; aquí solo cerramos el checkout.
        resolve({ orderCompleted: true });
      } else if (Culqi.error) {
        reject(new Error(Culqi.error.user_message ?? 'Pago no completado'));
      }
    };
    Culqi.open();
  });
}
