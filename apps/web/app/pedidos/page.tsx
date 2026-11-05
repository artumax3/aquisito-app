'use client';
import Link from 'next/link';
import type { OrderDto } from '@aquisito/contracts';
import { useQuery, useRealtime } from '@/lib/api';
import { Empty, ErrorBox, Loading, Money, StatusBadge, useSession } from '@/components/ui';

export default function OrdersPage() {
  const { me } = useSession();
  const orders = useQuery<OrderDto[]>(me ? 'orders' : null, {}, [me?.id]);
  useRealtime(() => orders.reload(), !!me);
  if (!me) return <Empty>Inicia sesión para ver tus pedidos. <Link href="/cuenta">Ingresar</Link></Empty>;
  if (orders.loading) return <Loading />;
  if (orders.error) return <ErrorBox error={orders.error} onRetry={orders.reload} />;
  return (
    <section className="col" style={{ marginTop: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Mis pedidos</h1>
        <Link className="btn secondary sm" href="/carrito">Ver carrito</Link>
      </div>
      {!orders.data?.length && <Empty>Aún no tienes pedidos.</Empty>}
      {orders.data?.map((o) => (
        <Link key={o.id} href={`/pedidos/${o.id}`} className="card col" style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>#{o.number} · {o.branchName}</strong>
            <Money cents={o.totalCents} />
          </div>
          <div className="row">
            <StatusBadge cycle="commercial" status={o.commercialStatus} />
            <StatusBadge cycle="delivery" status={o.deliveryStatus} />
            <StatusBadge cycle="payment" status={o.paymentStatus} />
          </div>
          <span className="muted small">{new Date(o.createdAt).toLocaleString('es-PE', { timeZone: 'America/Lima' })}</span>
        </Link>
      ))}
    </section>
  );
}
