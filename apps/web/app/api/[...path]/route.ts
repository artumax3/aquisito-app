import type { NextRequest } from 'next/server';

/**
 * Proxy de mismo origen hacia el API (URL leída en tiempo de ejecución). Mantiene la cookie de
 * sesión httpOnly en el dominio web, reenvía solo cabeceras necesarias y transmite la respuesta
 * en streaming (necesario para SSE).
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const FORWARD = ['content-type', 'cookie', 'idempotency-key', 'x-csrf-token', 'x-client', 'accept', 'x-correlation-id', 'x-sandbox-signature'];

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const base = process.env.API_URL || 'http://localhost:4000';
  const url = `${base}/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`;
  const headers = new Headers();
  for (const h of FORWARD) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  const fwd = req.headers.get('x-forwarded-for');
  headers.set('x-forwarded-for', fwd ?? '127.0.0.1');
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  let res: Response;
  try {
    res = await fetch(url, { method: req.method, headers, body: hasBody ? await req.arrayBuffer() : undefined, redirect: 'manual', cache: 'no-store' });
  } catch {
    return Response.json({ error: { code: 'API_UNAVAILABLE', message: 'El servicio no está disponible. Inténtalo en unos momentos.' } }, { status: 503 });
  }
  const out = new Headers();
  res.headers.forEach((v, k) => {
    if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie'].includes(k)) out.set(k, v);
  });
  for (const c of (res.headers as any).getSetCookie?.() ?? []) out.append('set-cookie', c);
  return new Response(res.body, { status: res.status, headers: out });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
