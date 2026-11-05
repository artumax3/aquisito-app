// Prueba de carga del piloto (SUPUESTO DE INGENIERÍA, no demanda real): 100 sesiones activas
// navegando y ~20 confirmaciones de pedido por minuto. Mide p50/p95 por operación.
// Uso: API=http://localhost:4000 PASS=... node infra/scripts/load-test.mjs
const API = process.env.API ?? 'http://localhost:4000';
const PASS = process.env.PASS ?? 'Demo-Aquisito-2026';
const DURATION_S = Number(process.env.DURATION_S ?? 60);
const SESSIONS = Number(process.env.SESSIONS ?? 100);
const stats = {};
const rec = (k, ms, ok) => ((stats[k] ??= { t: [], err: 0 }), stats[k].t.push(ms), ok || stats[k].err++);
async function call(k, path, opts = {}) {
  const t = performance.now();
  try {
    const r = await fetch(API + path, opts);
    const body = await r.json().catch(() => null);
    rec(k, performance.now() - t, r.ok);
    return { r, body };
  } catch {
    rec(k, performance.now() - t, false);
    return { r: null, body: null };
  }
}
const j = (token, body, extra = {}) => ({ method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra }, body: body ? JSON.stringify(body) : undefined });

const login = async (email) => (await call('login', '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASS }) })).body?.token;
const cities = (await (await fetch(API + '/cities')).json());
const agu = cities.find((c) => c.slug === 'aguaytia');
const stores = await (await fetch(`${API}/stores?cityId=${agu.id}`)).json();
const sazon = stores.find((s) => s.name.includes('Sazón'));
const detail = await (await fetch(`${API}/stores/${sazon.id}`)).json();
const variant = detail.products.find((p) => p.kind === 'prepared').variants[0].id;
const tokens = [];
for (const e of ['cliente.aguaytia', 'cliente.noverificado', 'cliente.revocado']) tokens.push(await login(`${e}@demo.aquisito.local`));
const buyer = tokens[0];
const addr = (await call('addresses', '/me/addresses', j(buyer))).body.find((a) => a.inCoverage).id;

const end = Date.now() + DURATION_S * 1000;
async function browse(i) {
  const tk = tokens[i % tokens.length];
  while (Date.now() < end) {
    await call('GET /stores', `/stores?cityId=${agu.id}&lat=-9.0378&lng=-75.5072`, j(tk));
    await call('GET /stores/:id', `/stores/${sazon.id}`, j(tk));
    await call('GET /cart', '/cart', j(tk));
    await call('GET /orders', '/orders', j(tk));
    await call('GET /search', `/search?cityId=${agu.id}&q=juane`, j(tk));
    await new Promise((r) => setTimeout(r, 500 + Math.random() * 1500));
  }
}
async function buyLoop() {
  // ~20 confirmaciones/minuto
  while (Date.now() < end) {
    await call('PUT /cart', '/cart', { ...j(buyer), method: 'PUT', body: JSON.stringify({ branchId: sazon.id, items: [{ variantId: variant, quantity: 1 }], replaceOtherBranch: true }) });
    const q = await call('POST /checkout/quotes', '/checkout/quotes', j(buyer, { addressId: addr, paymentMethod: 'cash', tipCents: 0 }));
    if (q.body?.id) await call('POST /orders', '/orders', j(buyer, { quoteId: q.body.id, quoteVersion: q.body.version }, { 'idempotency-key': `load${Date.now()}${Math.random().toString(36).slice(2)}` }));
    await new Promise((r) => setTimeout(r, 3000));
  }
}
const t0 = Date.now();
await Promise.all([...Array.from({ length: SESSIONS }, (_, i) => browse(i)), buyLoop()]);
const pct = (a, p) => a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
console.log(`Duración ${((Date.now() - t0) / 1000).toFixed(0)} s · ${SESSIONS} sesiones concurrentes · API ${API}`);
console.log('operación'.padEnd(24), 'n'.padStart(6), 'p50 ms'.padStart(8), 'p95 ms'.padStart(8), 'errores'.padStart(8));
for (const [k, v] of Object.entries(stats)) console.log(k.padEnd(24), String(v.t.length).padStart(6), pct(v.t, 50).toFixed(0).padStart(8), pct(v.t, 95).toFixed(0).padStart(8), String(v.err).padStart(8));
