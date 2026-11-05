import './globals.css';
import type { Metadata, Viewport } from 'next';
import { SessionProvider, Shell } from '@/components/ui';
import { ServiceWorker } from '@/components/sw';

export const metadata: Metadata = {
  title: 'Aquisito · Delivery local',
  description: 'Pedidos de comercios locales en Aguaytía y Tingo María (nombre provisional, entorno de desarrollo).',
  manifest: '/manifest.webmanifest',
};
export const viewport: Viewport = { themeColor: '#0b3d2e', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-PE">
      <body>
        <SessionProvider>
          <Shell>{children}</Shell>
        </SessionProvider>
        <ServiceWorker />
      </body>
    </html>
  );
}
