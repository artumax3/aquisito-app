import Link from 'next/link';
export default function NotFound() {
  return <div className="card" style={{ marginTop: 24 }}><h1>No encontramos esta página</h1><Link href="/">Volver al inicio</Link></div>;
}
