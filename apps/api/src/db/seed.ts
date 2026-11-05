import { config } from '../config';
import { Tx } from './db';
import { base32Encode, hashPassword, randomToken } from '../common/crypto';
import { createHash } from 'crypto';

/**
 * DATOS DE DEMOSTRACIÓN — ficticios. Nombres de comercios, productos, precios, polígonos, tarifas
 * y horarios son sintéticos y NO representan negocios reales, coberturas aprobadas, tarifas de
 * mercado ni horarios municipales oficiales. Bloqueado en producción.
 */
export interface SeedResult {
  credentials: { email: string; password: string; role: string; mfaSecret?: string }[];
  ids: Record<string, string>;
}

const box = (s: number, w: number, n: number, e: number) =>
  `ST_Multi(ST_GeomFromText('POLYGON((${w} ${s}, ${e} ${s}, ${e} ${n}, ${w} ${n}, ${w} ${s}))', 4326))`;

/** Secreto TOTP determinístico por correo para que las pruebas puedan generar códigos. */
export const demoMfaSecret = (email: string) => base32Encode(createHash('sha256').update(`demo-mfa:${email}`).digest().subarray(0, 20));

export async function seedDemo(t: Tx, opts: { password?: string } = {}): Promise<SeedResult> {
  const cfg = config();
  if (cfg.isProd || !cfg.ALLOW_DEMO_SEED) throw new Error('El sembrado de demostración está bloqueado en este entorno');
  const exists = await t.maybe(`SELECT 1 FROM cities WHERE slug = 'aguaytia'`);
  if (exists) throw new Error('La base ya tiene datos de demostración. Use una base vacía (pnpm db:reset en desarrollo).');

  const password = opts.password ?? randomToken(12);
  const pwHash = await hashPassword(password);
  const credentials: SeedResult['credentials'] = [];
  const ids: Record<string, string> = {};

  // ---------- Ciudades, jurisdicciones (geometrías de prueba), zonas ----------
  const agu = await t.one(`INSERT INTO cities(slug, name, center, service_fee_cents, alcohol_enabled, is_demo) VALUES ('aguaytia','Aguaytía', ST_SetSRID(ST_MakePoint(-75.5089,-9.0372),4326), 100, true, true) RETURNING id`);
  const tgm = await t.one(`INSERT INTO cities(slug, name, center, service_fee_cents, alcohol_enabled, is_demo) VALUES ('tingo-maria','Tingo María', ST_SetSRID(ST_MakePoint(-75.9980,-9.2950),4326), 100, true, true) RETURNING id`);
  ids.aguaytia = agu.id;
  ids.tingo = tgm.id;
  const jAgu = await t.one(`INSERT INTO jurisdictions(city_id, name, geom) VALUES ($1, 'Distrito de Padre Abad (geometría de prueba)', ${box(-9.07, -75.55, -9.0, -75.47)}) RETURNING id`, [agu.id]);
  const jRupa = await t.one(`INSERT INTO jurisdictions(city_id, name, geom) VALUES ($1, 'Distrito de Rupa-Rupa (geometría de prueba)', ${box(-9.33, -76.03, -9.27, -75.975)}) RETURNING id`, [tgm.id]);
  const jCastillo = await t.one(`INSERT INTO jurisdictions(city_id, name, geom) VALUES ($1, 'Distrito de Castillo Grande (geometría de prueba)', ${box(-9.30, -76.07, -9.26, -76.03)}) RETURNING id`, [tgm.id]);
  ids.jAguaytia = jAgu.id;
  ids.jRupa = jRupa.id;
  ids.jCastillo = jCastillo.id;
  const zAgu = await t.one(`INSERT INTO zones(city_id, name) VALUES ($1,'Aguaytía Centro') RETURNING id`, [agu.id]);
  const zTgm = await t.one(`INSERT INTO zones(city_id, name) VALUES ($1,'Tingo María Centro') RETURNING id`, [tgm.id]);
  const zCas = await t.one(`INSERT INTO zones(city_id, name) VALUES ($1,'Castillo Grande') RETURNING id`, [tgm.id]);
  ids.zoneAguaytia = zAgu.id;
  ids.zoneTingo = zTgm.id;
  ids.zoneCastillo = zCas.id;
  await t.q(`INSERT INTO zone_versions(zone_id, version, geom, reason) VALUES ($1,1,${box(-9.05, -75.522, -9.024, -75.495)},'Polígono inicial de PRUEBA')`, [zAgu.id]);
  await t.q(`INSERT INTO zone_versions(zone_id, version, geom, reason) VALUES ($1,1,${box(-9.312, -76.015, -9.28, -75.982)},'Polígono inicial de PRUEBA')`, [zTgm.id]);
  await t.q(`INSERT INTO zone_versions(zone_id, version, geom, reason) VALUES ($1,1,${box(-9.295, -76.055, -9.27, -76.032)},'Polígono inicial de PRUEBA')`, [zCas.id]);

  for (const c of [agu.id, tgm.id]) {
    const r = await t.one(
      `INSERT INTO delivery_fee_rules(city_id, base_fee_cents, included_meters, per_km_cents, min_order_cents, max_distance_meters, courier_base_pay_cents, courier_per_km_cents, is_demo)
       VALUES ($1, 400, 1500, 150, 1000, 6000, 350, 80, true) RETURNING id`,
      [c],
    );
    ids[`fee_${c}`] = r.id;
  }

  // Reglas de alcohol FICTICIAS (is_demo, sin validar): en ensayo/producción no habilitan venta.
  for (const j of [jAgu.id, jRupa.id]) {
    for (let d = 0; d < 7; d++) {
      await t.q(
        `INSERT INTO alcohol_rules(jurisdiction_id, weekday, start_time, end_time, source, source_reviewed_at, responsible, validated, is_demo)
         VALUES ($1,$2,'08:00','23:00','DATO FICTICIO DE PRUEBA — reemplazar por la ordenanza vigente verificada', current_date, 'Equipo demo', false, true)`,
        [j, d],
      );
    }
  }
  // Castillo Grande queda SIN reglas: demuestra que un distrito vecino no hereda reglas.

  // ---------- Usuarios ----------
  async function user(email: string, name: string, role: string, extra: { mfa?: boolean; phone?: string; birth?: string } = {}) {
    const u = await t.one(`INSERT INTO users(email, phone, password_hash, full_name, declared_birth_date, is_demo) VALUES ($1,$2,$3,$4,$5,true) RETURNING id`, [email, extra.phone ?? null, pwHash, name, extra.birth ?? null]);
    const cred: SeedResult['credentials'][number] = { email, password, role };
    if (extra.mfa) {
      const secret = demoMfaSecret(email);
      await t.q(`INSERT INTO mfa_totp(user_id, secret_base32, enabled_at) VALUES ($1,$2, now())`, [u.id, secret]);
      cred.mfaSecret = secret;
    }
    credentials.push(cred);
    return u.id as string;
  }
  const admin = await user('admin@demo.aquisito.local', 'Ana Administradora (demo)', 'admin', { mfa: true });
  await t.q(`INSERT INTO memberships(user_id, role) VALUES ($1,'admin')`, [admin]);
  const fin = await user('finanzas@demo.aquisito.local', 'Fabio Finanzas (demo)', 'finance', { mfa: true });
  await t.q(`INSERT INTO memberships(user_id, role) VALUES ($1,'finance')`, [fin]);
  const sup = await user('soporte@demo.aquisito.local', 'Sofía Soporte (demo)', 'support_agent');
  await t.q(`INSERT INTO memberships(user_id, role) VALUES ($1,'support_agent')`, [sup]);
  const dAgu = await user('despacho.aguaytia@demo.aquisito.local', 'Diego Despacho Aguaytía (demo)', 'city_dispatcher');
  await t.q(`INSERT INTO memberships(user_id, role, city_id) VALUES ($1,'city_dispatcher',$2)`, [dAgu, agu.id]);
  const dTgm = await user('despacho.tingo@demo.aquisito.local', 'Dina Despacho Tingo (demo)', 'city_dispatcher');
  await t.q(`INSERT INTO memberships(user_id, role, city_id) VALUES ($1,'city_dispatcher',$2)`, [dTgm, tgm.id]);
  Object.assign(ids, { admin, finance: fin, support: sup, dispatcherAguaytia: dAgu, dispatcherTingo: dTgm });

  // ---------- Comercios y catálogos ----------
  async function branch(key: string, city: string, jur: string, owner: string, trade: string, name: string, address: string, lat: number, lng: number, o: { alcohol?: boolean; prep?: number } = {}) {
    const m = await t.one(`INSERT INTO merchants(trade_name, legal_name, owner_user_id, contact_phone, status, is_demo, reviewed_at) VALUES ($1,$2,$3,'+51900000000','approved',true, now()) RETURNING id`, [trade, `${trade} (razón social ficticia)`, owner]);
    await t.q(`INSERT INTO memberships(user_id, role, merchant_id) VALUES ($1,'merchant_owner',$2)`, [owner, m.id]);
    await t.q(`INSERT INTO commission_rules(merchant_id, percent_bp, valid_from) VALUES ($1, 1200, now() - interval '1 year')`, [m.id]);
    const b = await t.one(
      `INSERT INTO branches(merchant_id, city_id, jurisdiction_id, name, address, location, status, prep_minutes, sells_alcohol, alcohol_permit_status, alcohol_permit_expires_at, is_demo)
       VALUES ($1,$2,$3,$4,$5, ST_SetSRID(ST_MakePoint($6,$7),4326), 'active', $8, $9, $10, $11, true) RETURNING id`,
      [m.id, city, jur, name, address, lng, lat, o.prep ?? 20, !!o.alcohol, o.alcohol ? 'approved' : 'none', o.alcohol ? new Date(Date.now() + 365 * 86400000) : null],
    );
    // Horario de prueba amplio (todo el día) para demostraciones; editable por el comercio.
    for (let d = 0; d < 7; d++) {
      await t.q(`INSERT INTO branch_hours(branch_id, weekday, opens, closes) VALUES ($1,$2,'00:00','12:00'),($1,$2,'12:00','00:00')`, [b.id, d]);
    }
    ids[`merchant_${key}`] = m.id;
    ids[`branch_${key}`] = b.id;
    return b.id as string;
  }
  const cat = async (b: string, name: string, kind: string, sort: number) => (await t.one(`INSERT INTO categories(branch_id, name, kind, sort) VALUES ($1,$2,$3,$4) RETURNING id`, [b, name, kind, sort])).id as string;
  async function prepared(b: string, c: string, name: string, desc: string, price: number, variants?: [string, number][], mods?: { group: string; min: number; max: number; options: [string, number][] }) {
    const p = await t.one(`INSERT INTO products(branch_id, category_id, name, description, kind) VALUES ($1,$2,$3,$4,'prepared') RETURNING id`, [b, c, name, desc]);
    for (const [i, [vn, vp]] of (variants ?? [['Único', price] as [string, number]]).entries()) await t.q(`INSERT INTO product_variants(product_id, name, price_cents, sort) VALUES ($1,$2,$3,$4)`, [p.id, vn, vp, i]);
    if (mods) {
      const g = await t.one(`INSERT INTO modifier_groups(product_id, name, min_select, max_select) VALUES ($1,$2,$3,$4) RETURNING id`, [p.id, mods.group, mods.min, mods.max]);
      for (const [on, op] of mods.options) await t.q(`INSERT INTO modifier_options(group_id, name, price_cents) VALUES ($1,$2,$3)`, [g.id, on, op]);
    }
    return p.id as string;
  }
  async function stock(b: string, c: string, name: string, desc: string, unit: string, price: number, qty: number, alcohol = false) {
    const s = await t.one(`INSERT INTO skus(branch_id, name, unit, contains_alcohol, minimum_age) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [b, name, unit, alcohol, alcohol ? 18 : null]);
    await t.q(`INSERT INTO inventory(sku_id, on_hand) VALUES ($1,$2)`, [s.id, qty]);
    const p = await t.one(`INSERT INTO products(branch_id, category_id, name, description, kind, contains_alcohol, minimum_age) VALUES ($1,$2,$3,$4,'stock',$5,$6) RETURNING id`, [b, c, name, desc, alcohol, alcohol ? 18 : null]);
    const v = await t.one(`INSERT INTO product_variants(product_id, name, price_cents, sku_id) VALUES ($1,$2,$3,$4) RETURNING id`, [p.id, unit, price, s.id]);
    return { productId: p.id as string, variantId: v.id as string, skuId: s.id as string };
  }
  async function combo(b: string, c: string, name: string, desc: string, price: number, comps: { label: string; qty: number; variants: string[] }[], extra: { quota?: number } = {}) {
    const p = await t.one(`INSERT INTO products(branch_id, category_id, name, description, kind, combo_quota_total, combo_discount_funded_by) VALUES ($1,$2,$3,$4,'combo',$5,'merchant') RETURNING id`, [b, c, name, desc, extra.quota ?? null]);
    const v = await t.one(`INSERT INTO product_variants(product_id, name, price_cents) VALUES ($1,'Combo',$2) RETURNING id`, [p.id, price]);
    for (const [i, cp] of comps.entries()) {
      const cc = await t.one(`INSERT INTO combo_components(combo_product_id, label, quantity, sort) VALUES ($1,$2,$3,$4) RETURNING id`, [p.id, cp.label, cp.qty, i]);
      for (const vid of cp.variants) await t.q(`INSERT INTO combo_component_options(component_id, variant_id) VALUES ($1,$2)`, [cc.id, vid]);
    }
    return { productId: p.id as string, variantId: v.id as string };
  }

  const owners: string[] = [];
  for (let i = 1; i <= 6; i++) owners.push(await user(`comercio${i}@demo.aquisito.local`, `Propietario Comercio ${i} (demo)`, 'merchant_owner'));
  ids.owner1 = owners[0];
  ids.owner2 = owners[1];
  ids.owner4 = owners[3];
  ids.owner5 = owners[4];

  // ===== Aguaytía =====
  const b1 = await branch('sazon', agu.id, jAgu.id, owners[0], 'Sazón Amazónico Demo', 'Sazón Amazónico (demo) – Centro', 'Jr. Ficticio 123, Aguaytía', -9.0365, -75.5095, { prep: 25 });
  const c1a = await cat(b1, 'Platos regionales', 'food', 1);
  const c1b = await cat(b1, 'Bebidas', 'drinks', 2);
  const aji = { group: 'Acompañamiento', min: 0, max: 2, options: [['Ají de cocona', 0], ['Porción extra de plátano', 300]] as [string, number][] };
  await prepared(b1, c1a, 'Juane de gallina', 'Arroz sazonado con gallina en hoja de bijao', 1800, undefined, aji);
  await prepared(b1, c1a, 'Tacacho con cecina', 'Plátano verde majado con cecina', 2000, [['Personal', 2000], ['Para compartir', 3600]], aji);
  await prepared(b1, c1a, 'Patarashca de pescado', 'Pescado de río envuelto en hoja', 2400);
  await prepared(b1, c1a, 'Inchicapi', 'Sopa de gallina con maní', 1600);
  await prepared(b1, c1a, 'Arroz chaufa amazónico', 'Con cecina y plátano', 1700);
  await prepared(b1, c1a, 'Ensalada de chonta', 'Palmito fresco', 1200);
  await prepared(b1, c1a, 'Pollo a la brasa 1/4', 'Con papas y ensalada', 1500);
  await prepared(b1, c1b, 'Refresco de cocona', 'Vaso 500 ml', 500, [['Vaso', 500], ['Jarra 1 L', 900]]);
  await prepared(b1, c1b, 'Chicha morada', 'Vaso 500 ml', 500);
  await prepared(b1, c1b, 'Limonada', 'Vaso 500 ml', 500);
  const agua1 = await stock(b1, c1b, 'Agua mineral 625 ml', 'Sin gas', 'botella', 250, 40);
  void agua1;

  const b2 = await branch('frontera', agu.id, jAgu.id, owners[1], 'Minimarket Demo Aguaytía', 'Minimarket Puente (demo)', 'Av. Ficticia 456, Aguaytía', -9.039, -75.506, { alcohol: true, prep: 10 });
  const c2a = await cat(b2, 'Abarrotes', 'market', 1);
  const c2b = await cat(b2, 'Bebidas sin alcohol', 'drinks', 2);
  const c2c = await cat(b2, 'Snacks', 'market', 3);
  const c2d = await cat(b2, 'Cervezas y vinos (18+)', 'alcohol', 4);
  const c2e = await cat(b2, 'Ofertas y combos', 'offers', 5);
  await stock(b2, c2a, 'Arroz extra 1 kg', 'Bolsa', 'bolsa 1 kg', 520, 50);
  await stock(b2, c2a, 'Azúcar rubia 1 kg', 'Bolsa', 'bolsa 1 kg', 450, 40);
  await stock(b2, c2a, 'Aceite vegetal 900 ml', 'Botella', 'botella 900 ml', 1050, 30);
  await stock(b2, c2a, 'Fideos spaghetti 500 g', 'Paquete', 'paquete 500 g', 380, 60);
  await stock(b2, c2a, 'Leche evaporada 400 g', 'Lata', 'lata 400 g', 420, 3);
  const gaseosa = await stock(b2, c2b, 'Gaseosa 500 ml', 'Botella', 'botella 500 ml', 300, 80);
  const agua2 = await stock(b2, c2b, 'Agua mineral 625 ml', 'Sin gas', 'botella', 250, 60);
  const chifles = await stock(b2, c2c, 'Chifles 150 g', 'Plátano frito', 'bolsa 150 g', 450, 30);
  const papas = await stock(b2, c2c, 'Papas fritas 150 g', 'Snack', 'bolsa 150 g', 500, 20);
  const queso = await stock(b2, c2c, 'Tabla de quesos 300 g', 'Para compartir', 'tabla 300 g', 2200, 8);
  const cerveza = await stock(b2, c2d, 'Cerveza lata 355 ml', 'Lata individual', 'lata 355 ml', 450, 48, true);
  const vino = await stock(b2, c2d, 'Vino tinto 750 ml', 'Botella', 'botella 750 ml', 3500, 6, true);
  ids.cerveza_variant = cerveza.variantId;
  ids.cerveza_sku = cerveza.skuId;
  ids.vino_variant = vino.variantId;
  ids.leche_sku = (await t.one(`SELECT sku_id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.name = 'Leche evaporada 400 g' AND p.branch_id = $1`, [b2])).sku_id;
  ids.gaseosa_variant = gaseosa.variantId;
  ids.gaseosa_sku = gaseosa.skuId;
  ids.chifles_variant = chifles.variantId;
  ids.chifles_sku = chifles.skuId;
  const cb1 = await combo(b2, c2e, 'Combo piqueo: 2 cervezas + chifles', 'Dos latas de 355 ml y una bolsa de chifles 150 g (dato de prueba)', 1250, [{ label: 'Cervezas 355 ml', qty: 2, variants: [cerveza.variantId] }, { label: 'Piqueo', qty: 1, variants: [chifles.variantId, papas.variantId] }]);
  const cb2 = await combo(b2, c2e, 'Combo vino + tabla de quesos', 'Botella 750 ml y tabla de quesos 300 g (dato de prueba)', 5200, [{ label: 'Vino 750 ml', qty: 1, variants: [vino.variantId] }, { label: 'Tabla de quesos', qty: 1, variants: [queso.variantId] }], { quota: 10 });
  const cb3 = await combo(b2, c2e, 'Combo refrescante: 2 gaseosas + papas', 'Dos gaseosas 500 ml y papas 150 g', 1000, [{ label: 'Gaseosas 500 ml', qty: 2, variants: [gaseosa.variantId, agua2.variantId] }, { label: 'Snack', qty: 1, variants: [papas.variantId, chifles.variantId] }]);
  ids.combo_piqueo_variant = cb1.variantId;
  ids.combo_piqueo_product = cb1.productId;
  ids.combo_vino_variant = cb2.variantId;
  ids.combo_refresco_variant = cb3.variantId;
  ids.combo_refresco_product = cb3.productId;
  ids.papas_variant = papas.variantId;

  const b3 = await branch('panaderia', agu.id, jAgu.id, owners[2], 'Panadería Demo Aguaytía', 'Panadería Amanecer (demo)', 'Jr. Ficticio 789, Aguaytía', -9.034, -75.511);
  const c3 = await cat(b3, 'Panes y dulces', 'food', 1);
  for (const [n, p] of [['Pan francés x 6', 300], ['Pan de yema x 6', 360], ['Empanada de carne', 450], ['Alfajor', 250], ['Torta de chocolate (tajada)', 700], ['Pye de manzana', 650], ['Biscocho', 300], ['Rosquitas x 10', 400], ['Cachito', 150], ['Café pasado', 350]] as [string, number][]) await prepared(b3, c3, n, 'Producto de demostración', p);
  await t.q(`INSERT INTO branch_closures(branch_id, starts_at, ends_at, reason) VALUES ($1, now() - interval '1 day', now() + interval '60 days', 'Mantenimiento del horno (caso de prueba: comercio cerrado)')`, [b3]);

  // ===== Tingo María =====
  const b4 = await branch('huallaga', tgm.id, jRupa.id, owners[3], 'Cevichería Demo Tingo', 'Cevichería Río (demo)', 'Av. Ficticia 101, Tingo María', -9.2955, -75.9975, { prep: 20 });
  const c4a = await cat(b4, 'Platos', 'food', 1);
  const c4b = await cat(b4, 'Bebidas', 'drinks', 2);
  for (const [n, p] of [['Ceviche de doncella', 2500], ['Chicharrón de pescado', 2300], ['Sudado de paiche', 2800], ['Tacacho con chorizo', 2000], ['Arroz con mariscos', 2600], ['Leche de tigre', 1500], ['Causa de pescado', 1600], ['Jalea mixta', 3000]] as [string, number][]) await prepared(b4, c4a, n, 'Plato de demostración', p);
  await prepared(b4, c4b, 'Refresco de camu camu', 'Vaso 500 ml', 600);
  await prepared(b4, c4b, 'Chicha morada', 'Vaso 500 ml', 500);

  const b5 = await branch('bella', tgm.id, jRupa.id, owners[4], 'Bodega Demo Tingo', 'Bodega La Bella (demo)', 'Jr. Ficticio 202, Tingo María', -9.2935, -75.9995, { alcohol: true, prep: 10 });
  const c5a = await cat(b5, 'Abarrotes', 'market', 1);
  const c5b = await cat(b5, 'Bebidas', 'drinks', 2);
  const c5c = await cat(b5, 'Cervezas (18+)', 'alcohol', 3);
  const c5d = await cat(b5, 'Combos', 'offers', 4);
  for (const [n, u, p, q] of [['Arroz superior 1 kg', 'bolsa 1 kg', 500, 40], ['Lentejas 500 g', 'bolsa 500 g', 450, 25], ['Atún en lata 170 g', 'lata 170 g', 650, 30], ['Galletas de soda', 'paquete', 150, 50], ['Café instantáneo 50 g', 'frasco 50 g', 900, 12], ['Huevos x 6', 'bandeja x 6', 600, 20]] as [string, string, number, number][]) await stock(b5, c5a, n, 'Producto de demostración', u, p, q);
  const gas5 = await stock(b5, c5b, 'Gaseosa 1.5 L', 'Botella', 'botella 1.5 L', 700, 30);
  const chif5 = await stock(b5, c5b, 'Maní salado 100 g', 'Bolsa', 'bolsa 100 g', 300, 25);
  const cer5 = await stock(b5, c5c, 'Cerveza lata 355 ml', 'Lata individual', 'lata 355 ml', 450, 36, true);
  ids.cerveza_tingo_variant = cer5.variantId;
  const cb5 = await combo(b5, c5d, 'Combo previa: 2 cervezas + maní', 'Dos latas de 355 ml y maní 100 g (dato de prueba)', 1100, [{ label: 'Cervezas', qty: 2, variants: [cer5.variantId] }, { label: 'Maní', qty: 1, variants: [chif5.variantId] }]);
  await combo(b5, c5d, 'Combo familiar sin alcohol', 'Gaseosa 1.5 L y maní', 900, [{ label: 'Gaseosa', qty: 1, variants: [gas5.variantId] }, { label: 'Maní', qty: 1, variants: [chif5.variantId] }]);
  ids.combo_tingo_variant = cb5.variantId;

  const b6 = await branch('juguera', tgm.id, jRupa.id, owners[5], 'Juguería Demo Tingo', 'Juguería Bella Durmiente (demo)', 'Mercado ficticio, puesto 12, Tingo María', -9.297, -75.996, { prep: 10 });
  const c6 = await cat(b6, 'Jugos y desayunos', 'food', 1);
  for (const [n, p] of [['Jugo de papaya', 600], ['Jugo surtido', 700], ['Jugo de cocona', 650], ['Sándwich de pollo', 800], ['Sándwich de chicharrón', 900], ['Tamal', 500], ['Quinua con manzana', 400], ['Ensalada de frutas', 900], ['Emoliente', 300]] as [string, number][]) await prepared(b6, c6, n, 'Producto de demostración', p);
  const agotado = await stock(b6, c6, 'Yogur natural 1 L', 'Caso de prueba: AGOTADO', 'botella 1 L', 1200, 0);
  ids.agotado_variant = agotado.variantId;

  // Operador de sucursal con cuenta propia
  const op = await user('operador.minimarket@demo.aquisito.local', 'Óscar Operador (demo)', 'branch_operator');
  await t.q(`INSERT INTO memberships(user_id, role, branch_id) VALUES ($1,'branch_operator',$2)`, [op, b2]);
  ids.operator = op;

  // ---------- Repartidores ----------
  async function courier(email: string, name: string, city: string, lat: number, lng: number, approved = true) {
    const u = await user(email, name, 'courier', { phone: `+5190${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}` });
    await t.q(`INSERT INTO couriers(user_id, city_id, birth_date, vehicle_type, vehicle_plate, status, identity_review, terms_accepted_at, alcohol_training_at, is_demo) VALUES ($1,$2,'1995-04-12','moto','DEMO-01',$3,$4, now(), $5, true)`, [u, city, approved ? 'approved' : 'pending', approved ? 'manual_reviewed' : 'pending', approved ? new Date() : null]);
    await t.q(`INSERT INTO memberships(user_id, role, city_id) VALUES ($1,'courier',$2)`, [u, city]);
    await t.q(`INSERT INTO consents(user_id, purpose, granted, policy_version) VALUES ($1,'location_tracking',true,'borrador-0.1')`, [u]);
    if (approved) {
      for (const topic of ['documentos', 'rechazo', 'privacidad', 'soporte', 'venta_responsable']) await t.q(`INSERT INTO courier_trainings(courier_id, topic) VALUES ($1,$2)`, [u, topic]);
    }
    void lat;
    void lng;
    return u;
  }
  ids.courierAguaytia1 = await courier('repartidor.aguaytia1@demo.aquisito.local', 'Rubén Repartidor (demo)', agu.id, -9.037, -75.508);
  ids.courierAguaytia2 = await courier('repartidor.aguaytia2@demo.aquisito.local', 'Rosa Repartidora (demo)', agu.id, -9.04, -75.51);
  ids.courierTingo1 = await courier('repartidor.tingo1@demo.aquisito.local', 'Raúl Repartidor (demo)', tgm.id, -9.295, -75.998);
  ids.courierTingo2 = await courier('repartidor.tingo2@demo.aquisito.local', 'Rita Repartidora (demo)', tgm.id, -9.296, -75.997);
  ids.courierPending = await courier('repartidor.pendiente@demo.aquisito.local', 'Pedro Postulante (demo)', agu.id, -9.037, -75.508, false);

  // ---------- Clientes ----------
  async function customer(key: string, email: string, name: string, city: string, lat: number, lng: number, age: 'verified' | 'none' | 'rejected' | 'revoked' | 'pending', birth: string) {
    const u = await user(email, name, 'customer', { phone: `+5191${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, birth });
    const jur = await t.maybe(`SELECT id FROM jurisdictions WHERE city_id = $1 AND ST_Contains(geom, ST_SetSRID(ST_MakePoint($2,$3),4326))`, [city, lng, lat]);
    const a = await t.one(
      `INSERT INTO addresses(user_id, city_id, jurisdiction_id, label, line1, number, reference, location, point_confirmed_at) VALUES ($1,$2,$3,'Casa','Calle Demo','100','Frente al parque (ficticio)', ST_SetSRID(ST_MakePoint($4,$5),4326), now()) RETURNING id`,
      [u, city, jur?.id ?? null, lng, lat],
    );
    if (age !== 'none') {
      await t.q(
        `INSERT INTO age_verifications(user_id, status, document_type, document_last4, full_name_on_document, birth_date, method, policy_version, reviewer_id, decision_reason, decided_at)
         VALUES ($1,$2,'dni','0000',$3,$4,'manual_video','politica-edad-0.1',$5,'Dato de demostración', now())`,
        [u, age === 'revoked' ? 'revoked' : age, name, birth, age === 'pending' ? null : admin],
      );
    }
    ids[`customer_${key}`] = u;
    ids[`address_${key}`] = a.id;
    return u;
  }
  await customer('aguaytia', 'cliente.aguaytia@demo.aquisito.local', 'Carla Clienta Aguaytía (demo)', agu.id, -9.0378, -75.5072, 'verified', '1990-06-15');
  await customer('tingo', 'cliente.tingo@demo.aquisito.local', 'Carlos Cliente Tingo (demo)', tgm.id, -9.2962, -75.9962, 'verified', '1988-02-29');
  await customer('noverificado', 'cliente.noverificado@demo.aquisito.local', 'Nora No Verificada (demo)', agu.id, -9.0381, -75.5081, 'none', '1999-01-01');
  await customer('menor', 'cliente.menor@demo.aquisito.local', 'Mateo Menor (demo)', agu.id, -9.0375, -75.509, 'rejected', '2010-03-03');
  await customer('revocado', 'cliente.revocado@demo.aquisito.local', 'Raquel Revocada (demo)', agu.id, -9.0383, -75.5101, 'revoked', '1992-09-09');
  // Dirección fuera de cobertura (caso de prueba)
  ids.address_fuera = (await t.one(
    `INSERT INTO addresses(user_id, city_id, label, line1, reference, location, point_confirmed_at) VALUES ($1,$2,'Chacra (fuera de cobertura)','Carretera demo km 12','Caso de prueba', ST_SetSRID(ST_MakePoint(-75.60,-9.10),4326), now()) RETURNING id`,
    [ids.customer_aguaytia, agu.id],
  )).id;

  await t.q(
    `INSERT INTO coupons(code, city_id, starts_at, ends_at, discount_type, value, max_discount_cents, budget_cents, max_uses, per_user_limit, funded_by, min_subtotal_cents)
     VALUES ('BIENVENIDA', NULL, now() - interval '1 day', now() + interval '90 days', 'percent', 10, 1000, 50000, 200, 1, 'platform', 1500),
            ('ENVIOGRATIS', $1, now() - interval '1 day', now() + interval '90 days', 'free_delivery', 0, NULL, 20000, 100, 2, 'platform', 2000)`,
    [tgm.id],
  );

  await t.q(
    `INSERT INTO banners(city_id, title, body, conditions, link_branch_id, contains_alcohol, starts_at, ends_at, is_demo) VALUES
     ($1,'Envío gratis en Tingo María','Usa el cupón ENVIOGRATIS en tu pedido','Dato de demostración. Compra mínima S/ 20.00, 2 usos por persona, hasta agotar presupuesto.',NULL,false, now() - interval '1 day', now() + interval '90 days', true),
     ($2,'Combo refrescante a S/ 10.00','2 gaseosas 500 ml + papas en Minimarket Puente','Dato de demostración. Precio por separado comprobable en la ficha del combo.',$3,false, now() - interval '1 day', now() + interval '90 days', true),
     ($2,'Combo piqueo con cervezas','2 latas de 355 ml + chifles','Solo mayores de 18 años verificados. Dato de demostración. Tomar bebidas alcohólicas en exceso es dañino.',$3,true, now() - interval '1 day', now() + interval '90 days', true)`,
    [tgm.id, agu.id, b2],
  );

  // Feriados nacionales 2026 (a verificar con fuente oficial antes de operar).
  for (const [d, n] of [['2026-01-01', 'Año Nuevo'], ['2026-04-02', 'Jueves Santo'], ['2026-04-03', 'Viernes Santo'], ['2026-05-01', 'Día del Trabajo'], ['2026-06-07', 'Batalla de Arica y Día de la Bandera'], ['2026-06-29', 'San Pedro y San Pablo'], ['2026-07-23', 'Día de la Fuerza Aérea'], ['2026-07-28', 'Fiestas Patrias'], ['2026-07-29', 'Fiestas Patrias'], ['2026-08-06', 'Batalla de Junín'], ['2026-08-30', 'Santa Rosa de Lima'], ['2026-10-08', 'Combate de Angamos'], ['2026-11-01', 'Todos los Santos'], ['2026-12-08', 'Inmaculada Concepción'], ['2026-12-09', 'Batalla de Ayacucho'], ['2026-12-25', 'Navidad'], ['2027-01-01', 'Año Nuevo']]) {
    await t.q(`INSERT INTO peru_holidays(day, name) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [d, `${n} (verificar)`]);
  }
  return { credentials, ids };
}
