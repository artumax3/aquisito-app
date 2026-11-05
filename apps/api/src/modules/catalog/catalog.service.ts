import {
  CartItemInput,
  isWithinWeeklyWindows,
  localWeekdayMinutes,
  ProductDto,
  StoreDetailDto,
  StoreSummaryDto,
  comboAvailableStock,
  deliveryFee,
} from '@aquisito/contracts';
import { db, Tx } from '../../db/db';
import { AuthCtx } from '../../common/auth';
import { BizError } from '../../common/errors';
import { timeToMinutes } from '../../common/time';
import { restrictedAccess } from '../alcohol/alcohol.service';
import { routeDistance, travelMinutes } from '../../providers/geo';

export interface OpenState {
  isOpen: boolean;
  reason: string | null;
}

interface OpenInput {
  status: string;
  paused: boolean;
  pause_reason: string | null;
  merchant_status: string;
  city_status: string;
  city_reason: string | null;
  timezone: string;
}

/** Evaluación pura del estado de apertura (reutilizada por la consulta individual y la masiva). */
export function evalOpenState(b: OpenInput, closureReason: string | null, hours: { weekday: number; o: string; c: string }[], at: Date): OpenState {
  if (b.merchant_status !== 'approved' || b.status !== 'active') return { isOpen: false, reason: 'Comercio no publicado' };
  if (b.city_status !== 'active') return { isOpen: false, reason: b.city_reason ?? 'Operación pausada en la ciudad' };
  if (b.paused) return { isOpen: false, reason: b.pause_reason ?? 'Pausado temporalmente' };
  if (closureReason) return { isOpen: false, reason: `Cierre especial: ${closureReason}` };
  const { weekday, minutes } = localWeekdayMinutes(at, b.timezone);
  const open = isWithinWeeklyWindows(hours.map((h) => ({ weekday: h.weekday, opens: timeToMinutes(h.o), closes: timeToMinutes(h.c) })), weekday, minutes);
  return open ? { isOpen: true, reason: null } : { isOpen: false, reason: 'Cerrado en este horario' };
}

export async function branchOpenState(branchId: string, at = new Date(), t: Tx = db): Promise<OpenState> {
  const b = await t.one(
    `SELECT b.status, b.paused, b.pause_reason, m.status AS merchant_status, c.status AS city_status, c.pause_reason AS city_reason, c.timezone
     FROM branches b JOIN merchants m ON m.id = b.merchant_id JOIN cities c ON c.id = b.city_id WHERE b.id = $1`,
    [branchId],
  );
  const closure = await t.maybe(`SELECT reason FROM branch_closures WHERE branch_id = $1 AND starts_at <= $2 AND ends_at > $2 LIMIT 1`, [branchId, at]);
  const hours = await t.q(`SELECT weekday, opens::text AS o, closes::text AS c FROM branch_hours WHERE branch_id = $1`, [branchId]);
  return evalOpenState(b, closure?.reason ?? null, hours, at);
}

export async function feeRuleFor(t: Tx, cityId: string, zoneId: string | null, branchId: string) {
  return t.maybe(
    `SELECT * FROM delivery_fee_rules WHERE city_id = $1 AND active
       AND (branch_id = $3 OR branch_id IS NULL) AND (zone_id = $2 OR zone_id IS NULL)
     ORDER BY (branch_id IS NOT NULL) DESC, (zone_id IS NOT NULL) DESC, created_at DESC LIMIT 1`,
    [cityId, zoneId, branchId],
  );
}

async function canSeeRestricted(a: AuthCtx | null | undefined) {
  return (await restrictedAccess(a)).allowed;
}

/** Elige la regla de tarifa más específica (sucursal > zona > ciudad, luego la más reciente). */
function pickFeeRule(rules: any[], branchId: string, zoneId: string | null) {
  return rules
    .filter((r) => (r.branch_id === null || r.branch_id === branchId) && (r.zone_id === null || r.zone_id === zoneId))
    .sort((a, b) => Number(b.branch_id !== null) - Number(a.branch_id !== null) || Number(b.zone_id !== null) - Number(a.zone_id !== null) || b.created_at - a.created_at)[0];
}

/**
 * Listado de comercios de una ciudad. Consultas por lotes (sucursales, horarios, cierres activos,
 * tarifas): el costo no crece con una consulta por comercio.
 */
export async function listStores(
  a: AuthCtx | null,
  q: { cityId: string; q?: string; open?: string; categoryKind?: string; sort?: string; lat?: number; lng?: number; branchId?: string },
): Promise<StoreSummaryDto[]> {
  const restricted = await canSeeRestricted(a);
  const at = new Date();
  const rows = await db.q(
    `SELECT b.id, b.merchant_id, b.name, m.trade_name, b.city_id, b.prep_minutes, b.image_url, b.is_demo, b.accepts_cash,
       b.status, b.paused, b.pause_reason, m.status AS merchant_status, c.status AS city_status, c.pause_reason AS city_reason, c.timezone,
       ST_Y(b.location) AS lat, ST_X(b.location) AS lng,
       (SELECT array_agg(DISTINCT kind) FROM categories cat WHERE cat.branch_id = b.id AND ($3 OR cat.kind <> 'alcohol')) AS kinds,
       (SELECT round(avg(r.store_score)::numeric, 1) FROM ratings r JOIN orders o ON o.id = r.order_id WHERE o.branch_id = b.id) AS rating,
       (SELECT reason FROM branch_closures bc WHERE bc.branch_id = b.id AND bc.starts_at <= $4 AND bc.ends_at > $4 LIMIT 1) AS closure_reason
     FROM branches b JOIN merchants m ON m.id = b.merchant_id JOIN cities c ON c.id = b.city_id
     WHERE b.city_id = $1 AND b.status = 'active' AND m.status = 'approved' AND ($5::uuid IS NULL OR b.id = $5)
       AND ($2::text IS NULL OR lower(b.name) LIKE '%' || lower($2) || '%' OR lower(m.trade_name) LIKE '%' || lower($2) || '%'
            OR EXISTS (SELECT 1 FROM products p JOIN v_product_restriction r ON r.product_id = p.id
                       WHERE p.branch_id = b.id AND p.active AND ($3 OR NOT r.contains_alcohol) AND lower(p.name) LIKE '%' || lower($2) || '%'))
     ORDER BY b.name`,
    [q.cityId, q.q ?? null, restricted, at, q.branchId ?? null],
  );
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const hours = await db.q(`SELECT branch_id, weekday, opens::text AS o, closes::text AS c FROM branch_hours WHERE branch_id = ANY($1)`, [ids]);
  const rules = await db.q(`SELECT * FROM delivery_fee_rules WHERE city_id = $1 AND active`, [q.cityId]);
  const out: StoreSummaryDto[] = [];
  for (const r of rows) {
    const kinds: string[] = (r.kinds ?? []).filter(Boolean);
    if (q.categoryKind && !kinds.includes(q.categoryKind)) continue;
    const open = evalOpenState(r, r.closure_reason, hours.filter((h) => h.branch_id === r.id), at);
    if (q.open === 'true' && !open.isOpen) continue;
    let fee: number | null = null;
    let eta: { min: number; max: number } | null = null;
    let method: StoreSummaryDto['distanceMethod'] = null;
    const rule = pickFeeRule(rules, r.id, null);
    if (q.lat != null && q.lng != null && rule) {
      const route = await routeDistance({ lat: r.lat, lng: r.lng }, { lat: q.lat, lng: q.lng });
      fee = deliveryFee({ baseFeeCents: rule.base_fee_cents, includedMeters: rule.included_meters, perKmCents: rule.per_km_cents, surchargeCents: rule.surcharge_cents }, route.meters);
      const travel = travelMinutes(route);
      eta = { min: r.prep_minutes + travel, max: r.prep_minutes + travel + 15 };
      method = route.method;
    } else {
      eta = { min: r.prep_minutes + 10, max: r.prep_minutes + 30 };
    }
    out.push({
      id: r.id,
      merchantId: r.merchant_id,
      name: r.name,
      merchantName: r.trade_name,
      cityId: r.city_id,
      categoryKinds: kinds,
      isOpen: open.isOpen,
      closedReason: open.reason,
      prepMinutes: r.prep_minutes,
      etaMinutes: eta,
      deliveryFeeCents: fee,
      distanceMethod: method,
      minOrderCents: rule?.min_order_cents ?? null,
      rating: r.rating,
      imageUrl: r.image_url,
      isDemo: r.is_demo,
      acceptsCash: r.accepts_cash,
    });
  }
  if (q.sort === 'eta') out.sort((x, y) => (x.etaMinutes?.min ?? 999) - (y.etaMinutes?.min ?? 999));
  if (q.sort === 'fee') out.sort((x, y) => (x.deliveryFeeCents ?? 99999) - (y.deliveryFeeCents ?? 99999));
  out.sort((x, y) => Number(y.isOpen) - Number(x.isOpen));
  return out;
}

/** Productos de una sucursal con disponibilidad real. Los restringidos se omiten si no hay acceso. */
export async function loadProducts(
  branchId: string,
  opts: { includeRestricted: boolean; productIds?: string[]; onlyActive?: boolean; at?: Date },
  t: Tx = db,
): Promise<ProductDto[]> {
  const products = await t.q(
    `SELECT p.*, c.name AS category_name, c.kind AS category_kind, r.contains_alcohol AS eff_alcohol, r.minimum_age AS eff_age
     FROM products p JOIN categories c ON c.id = p.category_id JOIN v_product_restriction r ON r.product_id = p.id
     WHERE p.branch_id = $1 AND ($2::uuid[] IS NULL OR p.id = ANY($2)) AND ($3 = false OR p.active)
     ORDER BY c.sort, p.sort, p.name`,
    [branchId, opts.productIds ?? null, opts.onlyActive !== false],
  );
  const visible = products.filter((p) => opts.includeRestricted || (!p.eff_alcohol && p.category_kind !== 'alcohol'));
  if (!visible.length) return [];
  const ids = visible.map((p) => p.id);
  const variants = await t.q(
    `SELECT v.*, s.unit, s.contains_alcohol AS sku_alcohol, i.on_hand, i.reserved
     FROM product_variants v LEFT JOIN skus s ON s.id = v.sku_id LEFT JOIN inventory i ON i.sku_id = v.sku_id
     WHERE v.product_id = ANY($1) AND v.active ORDER BY v.sort, v.price_cents`,
    [ids],
  );
  const groups = await t.q(`SELECT * FROM modifier_groups WHERE product_id = ANY($1) ORDER BY name`, [ids]);
  const options = groups.length
    ? await t.q(`SELECT * FROM modifier_options WHERE group_id = ANY($1) AND active ORDER BY price_cents, name`, [groups.map((g) => g.id)])
    : [];
  const components = await t.q(`SELECT * FROM combo_components WHERE combo_product_id = ANY($1) ORDER BY sort`, [ids]);
  const compOptions = components.length
    ? await t.q(
        `SELECT co.component_id, v.id AS variant_id, v.price_cents, v.sku_units, p.name AS product_name, v.name AS variant_name, i.on_hand, i.reserved, v.sku_id, p.active AS product_active, v.active AS variant_active
         FROM combo_component_options co JOIN product_variants v ON v.id = co.variant_id JOIN products p ON p.id = v.product_id
         LEFT JOIN inventory i ON i.sku_id = v.sku_id WHERE co.component_id = ANY($1)`,
        [components.map((c) => c.id)],
      )
    : [];
  const at = opts.at ?? new Date();
  const tz = (await t.one(`SELECT c.timezone FROM branches b JOIN cities c ON c.id = b.city_id WHERE b.id = $1`, [branchId])).timezone;

  return visible.map((p) => {
    const vs = variants.filter((v) => v.product_id === p.id);
    const variantDtos = vs.map((v) => ({
      id: v.id,
      name: v.name,
      priceCents: v.price_cents,
      available: v.sku_id ? Math.floor(Math.max(0, v.on_hand - v.reserved) / v.sku_units) : null,
      unit: v.unit ?? null,
    }));
    let combo: ProductDto['combo'] = null;
    let available = variantDtos.some((v) => v.available === null || v.available > 0);
    if (p.kind === 'combo') {
      const comps = components.filter((c) => c.combo_product_id === p.id);
      const compDtos = comps.map((c) => ({
        id: c.id,
        label: c.label,
        quantity: c.quantity,
        options: compOptions
          .filter((o) => o.component_id === c.id && o.product_active && o.variant_active)
          .map((o) => ({ variantId: o.variant_id, name: `${o.product_name} ${o.variant_name}`.trim(), unitPriceCents: o.price_cents })),
      }));
      // Precio de referencia comprobable: suma del precio vigente más barato elegible por componente.
      const reference = comps.reduce((sum, c) => {
        const prices = compOptions.filter((o) => o.component_id === c.id).map((o) => o.price_cents);
        return sum + (prices.length ? Math.min(...prices) : 0) * c.quantity;
      }, 0);
      const comboPrice = vs[0]?.price_cents ?? 0;
      // Disponible si cada componente tiene AL MENOS una opción con stock suficiente.
      const perComponent = comps.map((c) => {
        const opts2 = compOptions.filter((o) => o.component_id === c.id && o.product_active && o.variant_active);
        const best = Math.max(0, ...opts2.map((o) => (o.sku_id ? comboAvailableStock([{ available: o.on_hand - o.reserved, required: c.quantity * o.sku_units }]) : 9999)));
        return best;
      });
      const comboStock = perComponent.length ? Math.min(...perComponent) : 0;
      const conditions: string[] = [];
      if (p.combo_valid_to) conditions.push(`Válido hasta ${new Date(p.combo_valid_to).toLocaleString('es-PE', { timeZone: tz })}`);
      if (p.combo_daily_start && p.combo_daily_end) conditions.push(`Disponible de ${p.combo_daily_start.slice(0, 5)} a ${p.combo_daily_end.slice(0, 5)}`);
      if (p.combo_quota_total) conditions.push(`Cupo: ${Math.max(0, p.combo_quota_total - p.combo_quota_used)} de ${p.combo_quota_total}`);
      if (p.combo_per_customer_limit) conditions.push(`Máximo ${p.combo_per_customer_limit} por cliente`);
      const inPeriod = comboInPeriod(p, at, tz);
      if (!inPeriod) conditions.push('Fuera del período u horario de la promoción');
      combo = { components: compDtos, referencePriceCents: reference, savingsCents: Math.max(0, reference - comboPrice), conditions };
      available = comboStock > 0 && inPeriod && (!p.combo_quota_total || p.combo_quota_used < p.combo_quota_total);
      variantDtos.forEach((v) => (v.available = comboStock));
    }
    return {
      id: p.id,
      branchId: p.branch_id,
      categoryId: p.category_id,
      categoryName: p.category_name,
      name: p.name,
      description: p.description,
      imageUrl: p.image_url,
      kind: p.kind,
      containsAlcohol: p.eff_alcohol,
      minimumAge: p.eff_age,
      variants: variantDtos,
      modifierGroups: groups
        .filter((g) => g.product_id === p.id)
        .map((g) => ({ id: g.id, name: g.name, minSelect: g.min_select, maxSelect: g.max_select, options: options.filter((o) => o.group_id === g.id).map((o) => ({ id: o.id, name: o.name, priceCents: o.price_cents })) })),
      combo,
      available: available && p.active,
    };
  });
}

export function comboInPeriod(p: any, at: Date, tz: string): boolean {
  if (p.combo_valid_from && new Date(p.combo_valid_from) > at) return false;
  if (p.combo_valid_to && new Date(p.combo_valid_to) < at) return false;
  if (p.combo_daily_start && p.combo_daily_end) {
    const { weekday, minutes } = localWeekdayMinutes(at, tz);
    const w = { weekday, opens: timeToMinutes(p.combo_daily_start), closes: timeToMinutes(p.combo_daily_end) };
    if (!isWithinWeeklyWindows([w, { ...w, weekday: (weekday + 6) % 7 }], weekday, minutes)) return false;
  }
  return true;
}

export async function storeDetail(a: AuthCtx | null, branchId: string, point?: { lat: number; lng: number }): Promise<StoreDetailDto> {
  const b = await db.maybe(
    `SELECT b.city_id FROM branches b JOIN merchants m ON m.id = b.merchant_id WHERE b.id = $1 AND b.status = 'active' AND m.status = 'approved'`,
    [branchId],
  );
  if (!b) throw new BizError('NOT_FOUND', 'Comercio no encontrado', 404);
  const [summary] = await listStores(a, { cityId: b.city_id, branchId, ...(point ?? {}) });
  if (!summary) throw new BizError('NOT_FOUND', 'Comercio no encontrado', 404);
  const info = await db.one(`SELECT address, sells_alcohol FROM branches WHERE id = $1`, [branchId]);
  const hours = await db.q(`SELECT weekday, to_char(opens,'HH24:MI') AS opens, to_char(closes,'HH24:MI') AS closes FROM branch_hours WHERE branch_id = $1 ORDER BY weekday, opens`, [branchId]);
  const restricted = await canSeeRestricted(a);
  const products = await loadProducts(branchId, { includeRestricted: restricted });
  return { ...summary, address: info.address, hours, products, restrictedContentHidden: !restricted && info.sells_alcohol, sellsAlcohol: restricted && info.sells_alcohol };
}

/** Enlace directo a un producto restringido sin acceso => 404 (no se revela su existencia). */
export async function productDetail(a: AuthCtx | null, productId: string): Promise<ProductDto> {
  const p = await db.maybe(
    `SELECT p.branch_id FROM products p JOIN branches b ON b.id = p.branch_id JOIN merchants m ON m.id = b.merchant_id
     WHERE p.id = $1 AND p.active AND b.status = 'active' AND m.status = 'approved'`,
    [productId],
  );
  if (!p) throw new BizError('NOT_FOUND', 'Producto no encontrado', 404);
  const [dto] = await loadProducts(p.branch_id, { includeRestricted: await canSeeRestricted(a), productIds: [productId] });
  if (!dto) throw new BizError('NOT_FOUND', 'Producto no encontrado', 404);
  return dto;
}

export async function search(a: AuthCtx | null, cityId: string, q: string) {
  const restricted = await canSeeRestricted(a);
  const term = (q ?? '').trim().slice(0, 80);
  if (term.length < 2) return { stores: [], products: [] };
  const stores = await listStores(a, { cityId, q: term });
  const products = await db.q(
    `SELECT p.id, p.name, p.branch_id, b.name AS branch_name, min(v.price_cents) AS from_price
     FROM products p JOIN branches b ON b.id = p.branch_id JOIN merchants m ON m.id = b.merchant_id
     JOIN v_product_restriction r ON r.product_id = p.id JOIN categories c ON c.id = p.category_id
     JOIN product_variants v ON v.product_id = p.id AND v.active
     WHERE b.city_id = $1 AND b.status = 'active' AND m.status = 'approved' AND p.active
       AND ($3 OR (NOT r.contains_alcohol AND c.kind <> 'alcohol'))
       AND (lower(p.name) LIKE '%' || lower($2) || '%' OR lower(p.description) LIKE '%' || lower($2) || '%')
     GROUP BY p.id, b.name ORDER BY p.name LIMIT 40`,
    [cityId, term, restricted],
  );
  return {
    stores,
    products: products.map((p) => ({ id: p.id, name: p.name, branchId: p.branch_id, branchName: p.branch_name, fromPriceCents: p.from_price })),
  };
}

// ======================= Motor de precios (autoridad del servidor) =======================

export interface PricedLine {
  index: number;
  productId: string;
  productKind: string;
  variantId: string;
  name: string;
  variantName: string;
  quantity: number;
  unitPriceCents: number;
  modifiersCents: number;
  lineTotalCents: number;
  containsAlcohol: boolean;
  minimumAge: number | null;
  notes: string | null;
  modifierOptionIds: string[];
  comboSelections: Record<string, string>;
  modifiers: { id: string; name: string; priceCents: number; skuId: string | null }[];
  components: { variantId: string | null; skuId: string | null; name: string; quantity: number; unitReferenceCents: number; containsAlcohol: boolean }[];
  problem: string | null;
}

export interface PricingResult {
  lines: PricedLine[];
  subtotalCents: number;
  demand: Map<string, number>;
  comboUsage: Map<string, number>;
  containsAlcohol: boolean;
  minimumAge: number | null;
  problems: string[];
  categoryKinds: Set<string>;
}

/**
 * Recalcula TODO en servidor: precios vigentes, adicionales válidos, selecciones de combo,
 * demanda agregada por SKU (individual + combos + adicionales) y restricciones. Ningún precio
 * enviado por el cliente se usa.
 */
export async function priceItems(
  t: Tx,
  branchId: string,
  items: CartItemInput[],
  opts: { auth: AuthCtx | null; at?: Date; userId?: string },
): Promise<PricingResult> {
  const at = opts.at ?? new Date();
  const tz = (await t.one(`SELECT c.timezone FROM branches b JOIN cities c ON c.id = b.city_id WHERE b.id = $1`, [branchId])).timezone;
  const restricted = (await restrictedAccess(opts.auth, 18, at, t)).allowed;
  const lines: PricedLine[] = [];
  const demand = new Map<string, number>();
  const comboUsage = new Map<string, number>();
  const problems: string[] = [];
  const categoryKinds = new Set<string>();
  const add = (sku: string | null, q: number) => sku && demand.set(sku, (demand.get(sku) ?? 0) + q);

  for (const [index, it] of items.entries()) {
    const v = await t.maybe(
      `SELECT v.*, p.id AS product_id, p.name AS product_name, p.kind, p.branch_id, p.active AS product_active, p.contains_alcohol AS p_alcohol,
              p.combo_valid_from, p.combo_valid_to, p.combo_daily_start, p.combo_daily_end, p.combo_quota_total, p.combo_quota_used, p.combo_per_customer_limit,
              r.contains_alcohol AS eff_alcohol, r.minimum_age AS eff_age, s.contains_alcohol AS sku_alcohol, c.kind AS category_kind
       FROM product_variants v JOIN products p ON p.id = v.product_id JOIN v_product_restriction r ON r.product_id = p.id
       JOIN categories c ON c.id = p.category_id LEFT JOIN skus s ON s.id = v.sku_id WHERE v.id = $1`,
      [it.variantId],
    );
    // Restringido sin acceso: se trata como inexistente (no filtra existencia por API).
    if (!v || v.branch_id !== branchId || ((v.eff_alcohol || v.category_kind === 'alcohol') && !restricted)) {
      throw new BizError('ITEM_NOT_FOUND', 'Uno de los productos no está disponible en esta sucursal', 422, { index });
    }
    categoryKinds.add(v.category_kind);
    let problem: string | null = null;
    if (!v.product_active || !v.active) problem = 'Producto no disponible';
    let alcohol = !!v.eff_alcohol || v.category_kind === 'alcohol';
    let minAge: number | null = v.eff_age ?? (alcohol ? 18 : null);

    // Adicionales
    const groups = await t.q(`SELECT * FROM modifier_groups WHERE product_id = $1`, [v.product_id]);
    const opts2 = it.modifierOptionIds.length
      ? await t.q(
          `SELECT o.*, s.contains_alcohol AS sku_alcohol, s.minimum_age FROM modifier_options o LEFT JOIN skus s ON s.id = o.sku_id WHERE o.id = ANY($1) AND o.active`,
          [it.modifierOptionIds],
        )
      : [];
    if (opts2.length !== new Set(it.modifierOptionIds).size || opts2.some((o) => !groups.find((g) => g.id === o.group_id)))
      throw new BizError('INVALID_MODIFIER', 'Adicional no válido para este producto', 422, { index });
    for (const g of groups) {
      const n = opts2.filter((o) => o.group_id === g.id).length;
      if (n < g.min_select || n > g.max_select) throw new BizError('INVALID_MODIFIER', `Selecciona entre ${g.min_select} y ${g.max_select} en "${g.name}"`, 422, { index });
    }
    const modifiers = opts2.map((o) => ({ id: o.id, name: o.name, priceCents: o.price_cents, skuId: o.sku_id }));
    for (const o of opts2) {
      add(o.sku_id, it.quantity);
      if (o.sku_alcohol) {
        alcohol = true;
        minAge = Math.max(minAge ?? 18, o.minimum_age ?? 18);
      }
    }
    if (alcohol && !restricted) throw new BizError('ITEM_NOT_FOUND', 'Uno de los productos no está disponible', 422, { index });

    const components: PricedLine['components'] = [];
    const comboSelections: Record<string, string> = {};
    if (v.kind === 'combo') {
      if (!comboInPeriod(v, at, tz)) problem = 'Combo fuera de su período u horario';
      const comps = await t.q(`SELECT * FROM combo_components WHERE combo_product_id = $1 ORDER BY sort`, [v.product_id]);
      for (const c of comps) {
        const eligible = await t.q(
          `SELECT v2.id, v2.sku_id, v2.sku_units, v2.price_cents, p2.name AS pname, v2.name AS vname, p2.active AND v2.active AS ok,
                  coalesce(s.contains_alcohol, false) OR p2.contains_alcohol AS alcohol, coalesce(s.minimum_age, p2.minimum_age) AS min_age
           FROM combo_component_options co JOIN product_variants v2 ON v2.id = co.variant_id JOIN products p2 ON p2.id = v2.product_id
           LEFT JOIN skus s ON s.id = v2.sku_id WHERE co.component_id = $1`,
          [c.id],
        );
        const chosenId = it.comboSelections[c.id] ?? (eligible.length === 1 ? eligible[0].id : undefined);
        const chosen = eligible.find((e) => e.id === chosenId);
        if (!chosen) throw new BizError('COMBO_SELECTION_REQUIRED', `Elige una opción para "${c.label}"`, 422, { index, componentId: c.id });
        if (!chosen.ok) problem = `Componente no disponible: ${c.label}`;
        comboSelections[c.id] = chosen.id;
        add(chosen.sku_id, chosen.sku_units * c.quantity * it.quantity);
        components.push({ variantId: chosen.id, skuId: chosen.sku_id, name: `${chosen.pname} ${chosen.vname}`.trim(), quantity: c.quantity, unitReferenceCents: chosen.price_cents, containsAlcohol: chosen.alcohol });
        if (chosen.alcohol) {
          alcohol = true;
          minAge = Math.max(minAge ?? 18, chosen.min_age ?? 18);
        }
      }
      if (v.combo_quota_total && v.combo_quota_used + it.quantity > v.combo_quota_total) problem = 'Cupo del combo agotado';
      comboUsage.set(v.product_id, (comboUsage.get(v.product_id) ?? 0) + it.quantity);
      if (v.combo_per_customer_limit && opts.userId) {
        const used = await t.one(
          `SELECT coalesce(sum(l.quantity),0)::int AS n FROM order_lines l JOIN orders o ON o.id = l.order_id
           WHERE o.user_id = $1 AND l.product_id = $2 AND o.commercial_status NOT IN ('cancelado','rechazado_comercio')`,
          [opts.userId, v.product_id],
        );
        if (used.n + (comboUsage.get(v.product_id) ?? 0) > v.combo_per_customer_limit) problem = `Límite de ${v.combo_per_customer_limit} por cliente para este combo`;
      }
      if (alcohol && !restricted) throw new BizError('ITEM_NOT_FOUND', 'Uno de los productos no está disponible', 422, { index });
    } else {
      add(v.sku_id, v.sku_units * it.quantity);
    }

    const modifiersCents = modifiers.reduce((s, m) => s + m.priceCents, 0);
    const unit = v.price_cents;
    lines.push({
      index,
      productId: v.product_id,
      productKind: v.kind,
      variantId: v.id,
      name: v.product_name,
      variantName: v.name,
      quantity: it.quantity,
      unitPriceCents: unit,
      modifiersCents,
      lineTotalCents: (unit + modifiersCents) * it.quantity,
      containsAlcohol: alcohol,
      minimumAge: minAge,
      notes: it.notes?.trim() || null,
      modifierOptionIds: it.modifierOptionIds,
      comboSelections,
      modifiers,
      components,
      problem,
    });
  }

  // Stock con demanda AGREGADA (criterio 08/09).
  if (demand.size) {
    const inv = await t.q(
      `SELECT i.sku_id, i.on_hand - i.reserved AS available, s.name FROM inventory i JOIN skus s ON s.id = i.sku_id WHERE i.sku_id = ANY($1)`,
      [[...demand.keys()]],
    );
    for (const [sku, qty] of demand) {
      const row = inv.find((r) => r.sku_id === sku);
      if (!row || row.available < qty) {
        problems.push(`Stock insuficiente: ${row?.name ?? 'producto'} (disponible ${Math.max(0, row?.available ?? 0)}, requerido ${qty})`);
        for (const l of lines) if (l.problem == null && (l.components.some((c) => c.skuId === sku) || l.modifiers.some((m) => m.skuId === sku))) l.problem = 'Stock insuficiente';
        for (const l of lines) {
          const vrow = await t.maybe(`SELECT sku_id FROM product_variants WHERE id = $1`, [l.variantId]);
          if (l.problem == null && vrow?.sku_id === sku) l.problem = 'Stock insuficiente';
        }
      }
    }
  }
  for (const l of lines) if (l.problem && !problems.includes(`${l.name}: ${l.problem}`)) problems.push(`${l.name}: ${l.problem}`);
  const containsAlcohol = lines.some((l) => l.containsAlcohol);
  const ages = lines.map((l) => l.minimumAge).filter((x): x is number => x != null);
  return {
    lines,
    subtotalCents: lines.reduce((s, l) => s + l.lineTotalCents, 0),
    demand,
    comboUsage,
    containsAlcohol,
    minimumAge: containsAlcohol ? Math.max(18, ...ages) : null,
    problems,
    categoryKinds,
  };
}
