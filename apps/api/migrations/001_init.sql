-- Aquisito · migración inicial. Fuente de verdad: PostgreSQL 16 + PostGIS 3.
-- Dinero: céntimos enteros (bigint). Instantes: timestamptz (UTC). Geometrías: SRID 4326.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- =============== Identidad ===============
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext UNIQUE,
  phone text UNIQUE,
  password_hash text,
  full_name text NOT NULL,
  declared_birth_date date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (email IS NOT NULL OR phone IS NOT NULL OR status = 'deleted')
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  device_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  mfa_verified_at timestamptz
);
CREATE INDEX sessions_user_idx ON sessions(user_id) WHERE revoked_at IS NULL;

CREATE TABLE otp_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL,
  code_hash text NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  request_ip text
);
CREATE INDEX otp_phone_idx ON otp_challenges(phone, created_at DESC);

CREATE TABLE password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE mfa_totp (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_base32 text NOT NULL,
  enabled_at timestamptz,
  last_used_step bigint
);

CREATE TABLE login_attempts (
  id bigserial PRIMARY KEY,
  key text NOT NULL,
  success boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_key_idx ON login_attempts(key, created_at DESC);

-- =============== Geografía ===============
CREATE TABLE cities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'America/Lima',
  center geometry(Point, 4326) NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  pause_reason text,
  alcohol_enabled boolean NOT NULL DEFAULT false,
  service_fee_cents bigint NOT NULL DEFAULT 0 CHECK (service_fee_cents >= 0),
  cash_max_cents bigint NOT NULL DEFAULT 20000,
  alcohol_cash_allowed boolean NOT NULL DEFAULT false,
  is_demo boolean NOT NULL DEFAULT false
);

-- Jurisdicción municipal (distrito). Cada sucursal y cada destino se asocian a una.
CREATE TABLE jurisdictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id uuid NOT NULL REFERENCES cities(id),
  name text NOT NULL,
  ubigeo text,
  geom geometry(MultiPolygon, 4326) NOT NULL,
  is_demo_geometry boolean NOT NULL DEFAULT true,
  UNIQUE (city_id, name)
);
CREATE INDEX jurisdictions_geom_idx ON jurisdictions USING gist(geom);

CREATE TABLE zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id uuid NOT NULL REFERENCES cities(id),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  capacity_orders_per_hour int,
  UNIQUE (city_id, name)
);

CREATE TABLE zone_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id uuid NOT NULL REFERENCES zones(id),
  version int NOT NULL,
  geom geometry(MultiPolygon, 4326) NOT NULL,
  is_current boolean NOT NULL DEFAULT true,
  is_demo_geometry boolean NOT NULL DEFAULT true,
  reason text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (zone_id, version)
);
CREATE UNIQUE INDEX zone_versions_current_uq ON zone_versions(zone_id) WHERE is_current;
CREATE INDEX zone_versions_geom_idx ON zone_versions USING gist(geom) WHERE is_current;

CREATE TABLE zone_suspensions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id uuid NOT NULL REFERENCES zones(id),
  reason text NOT NULL,
  detail text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- =============== Comercios ===============
CREATE TABLE merchants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_name text NOT NULL,
  legal_name text,
  ruc text,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  contact_phone text NOT NULL,
  settlement_account text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','suspended')),
  review_reason text,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  city_id uuid NOT NULL REFERENCES cities(id),
  jurisdiction_id uuid REFERENCES jurisdictions(id),
  name text NOT NULL,
  address text NOT NULL,
  location geometry(Point, 4326) NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended')),
  paused boolean NOT NULL DEFAULT false,
  pause_reason text,
  prep_minutes int NOT NULL DEFAULT 20 CHECK (prep_minutes BETWEEN 1 AND 240),
  accept_timeout_seconds int NOT NULL DEFAULT 300 CHECK (accept_timeout_seconds BETWEEN 30 AND 3600),
  accepts_cash boolean NOT NULL DEFAULT true,
  sells_alcohol boolean NOT NULL DEFAULT false,
  alcohol_permit_status text NOT NULL DEFAULT 'none' CHECK (alcohol_permit_status IN ('none','pending','approved','rejected','expired','suspended')),
  alcohol_permit_expires_at date,
  slot_minutes int NOT NULL DEFAULT 30,
  slot_capacity int NOT NULL DEFAULT 4,
  image_url text,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX branches_city_idx ON branches(city_id);
CREATE INDEX branches_location_idx ON branches USING gist(location);

CREATE TABLE branch_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  weekday int NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  opens time NOT NULL,
  closes time NOT NULL,
  CHECK (opens <> closes)
);
CREATE INDEX branch_hours_idx ON branch_hours(branch_id);

CREATE TABLE branch_closures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  reason text NOT NULL
);

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type text NOT NULL CHECK (owner_type IN ('merchant','branch','courier','incident','user')),
  owner_id uuid NOT NULL,
  kind text NOT NULL,
  storage_key text NOT NULL,
  content_type text NOT NULL,
  size_bytes int NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  expires_at date,
  uploaded_by uuid NOT NULL REFERENCES users(id),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  delete_after date,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_owner_idx ON documents(owner_type, owner_id);

-- =============== Membresías y permisos ===============
CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('customer','merchant_owner','branch_operator','courier','city_dispatcher','support_agent','finance','admin')),
  city_id uuid REFERENCES cities(id),
  merchant_id uuid REFERENCES merchants(id),
  branch_id uuid REFERENCES branches(id),
  granted_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (role <> 'merchant_owner' OR merchant_id IS NOT NULL),
  CHECK (role <> 'branch_operator' OR branch_id IS NOT NULL),
  CHECK (role <> 'city_dispatcher' OR city_id IS NOT NULL),
  CHECK (role <> 'courier' OR city_id IS NOT NULL)
);
CREATE UNIQUE INDEX memberships_uq ON memberships(user_id, role, coalesce(city_id::text,''), coalesce(merchant_id::text,''), coalesce(branch_id::text,'')) WHERE revoked_at IS NULL;

CREATE TABLE consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  granted boolean NOT NULL,
  policy_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consents_user_idx ON consents(user_id, purpose, created_at DESC);

CREATE TABLE data_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('access','rectification','cancellation','opposition','account_deletion')),
  detail text,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','in_progress','completed','rejected')),
  due_at timestamptz NOT NULL,
  resolution text,
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  city_id uuid NOT NULL REFERENCES cities(id),
  jurisdiction_id uuid REFERENCES jurisdictions(id),
  label text NOT NULL,
  line1 text NOT NULL,
  number text,
  reference text,
  instructions text,
  location geometry(Point, 4326) NOT NULL,
  point_confirmed_at timestamptz NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX addresses_user_idx ON addresses(user_id) WHERE deleted_at IS NULL;

CREATE TABLE favorites (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, branch_id)
);

-- =============== Verificación de edad ===============
CREATE TABLE age_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('pending','verified','rejected','revoked')),
  document_type text NOT NULL,
  document_last4 text NOT NULL,
  full_name_on_document text NOT NULL,
  birth_date date NOT NULL,
  method text,
  policy_version text NOT NULL,
  provider_reference text,
  reviewer_id uuid REFERENCES users(id),
  decision_reason text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX age_verifications_user_idx ON age_verifications(user_id, created_at DESC);
CREATE UNIQUE INDEX age_verifications_one_pending ON age_verifications(user_id) WHERE status = 'pending';

-- =============== Catálogo ===============
CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('food','market','drinks','alcohol','offers')),
  sort int NOT NULL DEFAULT 0,
  UNIQUE (branch_id, name)
);

-- SKU: unidad física inventariable. Lleva la marca de alcohol y la edad mínima.
CREATE TABLE skus (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id),
  name text NOT NULL,
  unit text NOT NULL,
  contains_alcohol boolean NOT NULL DEFAULT false,
  minimum_age int CHECK (minimum_age IS NULL OR minimum_age >= 18),
  CHECK (NOT contains_alcohol OR minimum_age IS NOT NULL)
);

CREATE TABLE inventory (
  sku_id uuid PRIMARY KEY REFERENCES skus(id),
  on_hand int NOT NULL CHECK (on_hand >= 0),
  reserved int NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_no_negative_available CHECK (reserved <= on_hand)
);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id),
  category_id uuid NOT NULL REFERENCES categories(id),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  kind text NOT NULL CHECK (kind IN ('prepared','stock','combo')),
  image_url text,
  image_is_demo boolean NOT NULL DEFAULT true,
  contains_alcohol boolean NOT NULL DEFAULT false,
  minimum_age int CHECK (minimum_age IS NULL OR minimum_age >= 18),
  active boolean NOT NULL DEFAULT true,
  sort int NOT NULL DEFAULT 0,
  -- combos
  combo_valid_from timestamptz,
  combo_valid_to timestamptz,
  combo_daily_start time,
  combo_daily_end time,
  combo_quota_total int CHECK (combo_quota_total IS NULL OR combo_quota_total > 0),
  combo_quota_used int NOT NULL DEFAULT 0,
  combo_per_customer_limit int,
  combo_discount_funded_by text CHECK (combo_discount_funded_by IN ('merchant','platform')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (combo_quota_total IS NULL OR combo_quota_used <= combo_quota_total)
);
CREATE INDEX products_branch_idx ON products(branch_id) WHERE active;
CREATE INDEX products_name_idx ON products (lower(name));

CREATE TABLE product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id),
  name text NOT NULL,
  price_cents bigint NOT NULL CHECK (price_cents > 0),
  sku_id uuid REFERENCES skus(id),
  -- unidades del SKU consumidas por una unidad de esta variante (p. ej. six-pack = 6 latas)
  sku_units int NOT NULL DEFAULT 1 CHECK (sku_units > 0),
  active boolean NOT NULL DEFAULT true,
  sort int NOT NULL DEFAULT 0
);
CREATE INDEX product_variants_product_idx ON product_variants(product_id);

CREATE TABLE modifier_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id),
  name text NOT NULL,
  min_select int NOT NULL DEFAULT 0,
  max_select int NOT NULL DEFAULT 1,
  CHECK (min_select >= 0 AND max_select >= min_select AND max_select > 0)
);
CREATE TABLE modifier_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES modifier_groups(id),
  name text NOT NULL,
  price_cents bigint NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  sku_id uuid REFERENCES skus(id),
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE combo_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  combo_product_id uuid NOT NULL REFERENCES products(id),
  label text NOT NULL,
  quantity int NOT NULL CHECK (quantity > 0),
  sort int NOT NULL DEFAULT 0
);
CREATE TABLE combo_component_options (
  component_id uuid NOT NULL REFERENCES combo_components(id),
  variant_id uuid NOT NULL REFERENCES product_variants(id),
  PRIMARY KEY (component_id, variant_id)
);

-- Restricción efectiva: el producto, cualquiera de sus SKU, cualquier adicional o cualquier
-- componente de combo con alcohol vuelve restringido el producto completo.
CREATE VIEW v_product_restriction AS
SELECT p.id AS product_id,
  (p.contains_alcohol
   OR EXISTS (SELECT 1 FROM product_variants v JOIN skus s ON s.id = v.sku_id WHERE v.product_id = p.id AND s.contains_alcohol)
   OR EXISTS (SELECT 1 FROM modifier_groups g JOIN modifier_options o ON o.group_id = g.id JOIN skus s ON s.id = o.sku_id WHERE g.product_id = p.id AND s.contains_alcohol)
   OR EXISTS (SELECT 1 FROM combo_components c JOIN combo_component_options co ON co.component_id = c.id
              JOIN product_variants v ON v.id = co.variant_id JOIN products cp ON cp.id = v.product_id
              LEFT JOIN skus s ON s.id = v.sku_id
              WHERE c.combo_product_id = p.id AND (s.contains_alcohol OR cp.contains_alcohol))
  ) AS contains_alcohol,
  GREATEST(p.minimum_age,
    (SELECT max(s.minimum_age) FROM product_variants v JOIN skus s ON s.id = v.sku_id WHERE v.product_id = p.id),
    (SELECT max(coalesce(s.minimum_age, cp.minimum_age)) FROM combo_components c JOIN combo_component_options co ON co.component_id = c.id
       JOIN product_variants v ON v.id = co.variant_id JOIN products cp ON cp.id = v.product_id
       LEFT JOIN skus s ON s.id = v.sku_id WHERE c.combo_product_id = p.id)
  ) AS minimum_age
FROM products p;

-- =============== Reglas de alcohol ===============
CREATE TABLE alcohol_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction_id uuid NOT NULL REFERENCES jurisdictions(id),
  weekday int NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time time NOT NULL,
  end_time time NOT NULL,
  source text NOT NULL,
  source_reviewed_at date NOT NULL,
  responsible text NOT NULL,
  validated boolean NOT NULL DEFAULT false,
  is_demo boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE alcohol_blackouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction_id uuid NOT NULL REFERENCES jurisdictions(id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  reason text NOT NULL,
  source text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- =============== Tarifas y comisiones ===============
CREATE TABLE delivery_fee_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id uuid NOT NULL REFERENCES cities(id),
  zone_id uuid REFERENCES zones(id),
  branch_id uuid REFERENCES branches(id),
  base_fee_cents bigint NOT NULL CHECK (base_fee_cents >= 0),
  included_meters int NOT NULL CHECK (included_meters >= 0),
  per_km_cents bigint NOT NULL CHECK (per_km_cents >= 0),
  min_order_cents bigint NOT NULL DEFAULT 0,
  surcharge_cents bigint NOT NULL DEFAULT 0,
  surcharge_label text,
  max_distance_meters int NOT NULL,
  courier_base_pay_cents bigint NOT NULL DEFAULT 400,
  courier_per_km_cents bigint NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE commission_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  percent_bp int NOT NULL CHECK (percent_bp BETWEEN 0 AND 5000),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- =============== Cupones ===============
CREATE TABLE coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  city_id uuid REFERENCES cities(id),
  merchant_id uuid REFERENCES merchants(id),
  category_kind text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  min_subtotal_cents bigint NOT NULL DEFAULT 0,
  discount_type text NOT NULL CHECK (discount_type IN ('percent','fixed','free_delivery')),
  value int NOT NULL CHECK (value >= 0),
  max_discount_cents bigint,
  budget_cents bigint NOT NULL CHECK (budget_cents > 0),
  budget_used_cents bigint NOT NULL DEFAULT 0,
  max_uses int NOT NULL CHECK (max_uses > 0),
  uses_count int NOT NULL DEFAULT 0,
  per_user_limit int NOT NULL DEFAULT 1,
  funded_by text NOT NULL CHECK (funded_by IN ('platform','merchant')),
  stackable boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coupon_budget CHECK (budget_used_cents <= budget_cents AND budget_used_cents >= 0),
  CONSTRAINT coupon_uses CHECK (uses_count <= max_uses AND uses_count >= 0),
  CHECK (discount_type <> 'percent' OR value <= 100)
);

-- =============== Carrito y cotizaciones ===============
CREATE TABLE carts (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES branches(id),
  items jsonb NOT NULL DEFAULT '[]', -- entradas efímeras validadas con zod; el pedido se normaliza
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  city_id uuid NOT NULL REFERENCES cities(id),
  address_id uuid NOT NULL REFERENCES addresses(id),
  version int NOT NULL DEFAULT 1,
  items jsonb NOT NULL,
  lines jsonb NOT NULL,
  request jsonb NOT NULL, -- parámetros de la cotización (dirección, medio de pago, propina, cupón, franja)
  payment_method text NOT NULL,
  coupon_id uuid REFERENCES coupons(id),
  subtotal_cents bigint NOT NULL,
  discount_cents bigint NOT NULL,
  delivery_fee_cents bigint NOT NULL,
  service_fee_cents bigint NOT NULL,
  surcharge_cents bigint NOT NULL DEFAULT 0,
  surcharge_label text,
  tip_cents bigint NOT NULL,
  total_cents bigint NOT NULL CHECK (total_cents >= 0),
  distance_meters int NOT NULL,
  distance_method text NOT NULL,
  eta_min int NOT NULL,
  eta_max int NOT NULL,
  contains_alcohol boolean NOT NULL,
  minimum_age int,
  scheduled_slot_start timestamptz,
  fee_rule_id uuid REFERENCES delivery_fee_rules(id),
  zone_version_id uuid REFERENCES zone_versions(id),
  courier_pay_cents bigint NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- =============== Pedidos ===============
CREATE SEQUENCE order_number_seq START 1001;
CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number bigint NOT NULL UNIQUE DEFAULT nextval('order_number_seq'),
  code text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  city_id uuid NOT NULL REFERENCES cities(id),
  quote_id uuid NOT NULL UNIQUE REFERENCES quotes(id),
  idempotency_key text NOT NULL,
  address_id uuid REFERENCES addresses(id),
  address_line1 text NOT NULL,
  address_reference text,
  address_instructions text,
  destination geometry(Point, 4326) NOT NULL,
  destination_jurisdiction_id uuid REFERENCES jurisdictions(id),
  destination_zone_id uuid REFERENCES zones(id),
  contact_phone text,
  commercial_status text NOT NULL DEFAULT 'pendiente_confirmacion',
  delivery_status text NOT NULL DEFAULT 'sin_asignar',
  payment_status text NOT NULL DEFAULT 'pendiente',
  payment_method text NOT NULL CHECK (payment_method IN ('card','wallet','cash','transfer')),
  subtotal_cents bigint NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  delivery_fee_cents bigint NOT NULL CHECK (delivery_fee_cents >= 0),
  service_fee_cents bigint NOT NULL DEFAULT 0,
  surcharge_cents bigint NOT NULL DEFAULT 0,
  tip_cents bigint NOT NULL DEFAULT 0 CHECK (tip_cents >= 0),
  total_cents bigint NOT NULL CHECK (total_cents >= 0),
  refunded_cents bigint NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  courier_pay_cents bigint NOT NULL DEFAULT 0,
  coupon_id uuid REFERENCES coupons(id),
  coupon_funded_by text,
  contains_alcohol boolean NOT NULL DEFAULT false,
  minimum_age int,
  alcohol_terms_accepted_at timestamptz,
  scheduled_for timestamptz,
  accept_deadline timestamptz,
  payment_deadline timestamptz,
  eta_at timestamptz,
  prep_minutes int,
  pickup_code text NOT NULL,
  delivery_code_hash text NOT NULL,
  delivery_code_enc text NOT NULL,
  delivery_code_used_at timestamptz,
  packages int NOT NULL DEFAULT 1,
  cash_change_for_cents bigint,
  invoice_type text NOT NULL DEFAULT 'boleta',
  invoice_doc_type text,
  invoice_doc_number text,
  invoice_name text,
  version int NOT NULL DEFAULT 1,
  confirmed_at timestamptz,
  accepted_at timestamptz,
  ready_at timestamptz,
  picked_up_at timestamptz,
  delivered_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  CHECK (total_cents = subtotal_cents - discount_cents + delivery_fee_cents + service_fee_cents + surcharge_cents + tip_cents),
  CHECK (refunded_cents <= total_cents)
);
CREATE INDEX orders_user_idx ON orders(user_id, created_at DESC);
CREATE INDEX orders_branch_idx ON orders(branch_id, created_at DESC);
CREATE INDEX orders_city_active_idx ON orders(city_id, commercial_status);

CREATE TABLE order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  product_id uuid NOT NULL REFERENCES products(id),
  variant_id uuid NOT NULL REFERENCES product_variants(id),
  name text NOT NULL,
  variant_name text NOT NULL,
  product_kind text NOT NULL,
  quantity int NOT NULL CHECK (quantity > 0),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  modifiers_cents bigint NOT NULL DEFAULT 0,
  discount_cents bigint NOT NULL DEFAULT 0,
  line_total_cents bigint NOT NULL CHECK (line_total_cents >= 0),
  contains_alcohol boolean NOT NULL DEFAULT false,
  notes text,
  modifiers jsonb NOT NULL DEFAULT '[]',
  removed_at timestamptz,
  sort int NOT NULL DEFAULT 0
);
CREATE INDEX order_lines_order_idx ON order_lines(order_id);

-- Fotografía lógica de componentes/SKU consumidos por cada línea (combos y adicionales).
CREATE TABLE order_line_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_line_id uuid NOT NULL REFERENCES order_lines(id),
  variant_id uuid REFERENCES product_variants(id),
  sku_id uuid REFERENCES skus(id),
  name text NOT NULL,
  quantity int NOT NULL CHECK (quantity > 0),
  unit_reference_cents bigint NOT NULL DEFAULT 0,
  contains_alcohol boolean NOT NULL DEFAULT false
);

CREATE TABLE order_status_history (
  id bigserial PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  cycle text NOT NULL CHECK (cycle IN ('commercial','delivery','payment')),
  from_status text,
  to_status text NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  actor_role text,
  reason text,
  order_version int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_status_history_idx ON order_status_history(order_id, id);

CREATE TABLE substitutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  order_line_id uuid NOT NULL REFERENCES order_lines(id),
  kind text NOT NULL CHECK (kind IN ('remove','substitute')),
  substitute_variant_id uuid REFERENCES product_variants(id),
  price_diff_cents bigint NOT NULL DEFAULT 0,
  note text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','expired')),
  proposed_by uuid NOT NULL REFERENCES users(id),
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX substitutions_one_pending ON substitutions(order_line_id) WHERE status = 'pending';

CREATE TABLE scheduled_slot_bookings (
  branch_id uuid NOT NULL REFERENCES branches(id),
  slot_start timestamptz NOT NULL,
  booked int NOT NULL DEFAULT 0,
  capacity int NOT NULL,
  PRIMARY KEY (branch_id, slot_start),
  CHECK (booked <= capacity AND booked >= 0)
);

-- =============== Inventario: reservas y movimientos ===============
CREATE TABLE inventory_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  sku_id uuid NOT NULL REFERENCES skus(id),
  quantity int NOT NULL CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','committed')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, sku_id)
);
CREATE INDEX inventory_reservations_active_idx ON inventory_reservations(expires_at) WHERE status = 'active';

CREATE TABLE inventory_movements (
  id bigserial PRIMARY KEY,
  sku_id uuid NOT NULL REFERENCES skus(id),
  order_id uuid REFERENCES orders(id),
  kind text NOT NULL CHECK (kind IN ('reserve','release','commit','restock','adjust','return_restock','return_discard')),
  quantity int NOT NULL,
  on_hand_after int NOT NULL,
  reserved_after int NOT NULL,
  reason text,
  actor_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- =============== Repartidores y despacho ===============
CREATE TABLE couriers (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  city_id uuid NOT NULL REFERENCES cities(id),
  birth_date date NOT NULL,
  vehicle_type text NOT NULL,
  vehicle_plate text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','suspended')),
  identity_review text NOT NULL DEFAULT 'pending' CHECK (identity_review IN ('pending','manual_reviewed','rejected')),
  terms_accepted_at timestamptz NOT NULL,
  alcohol_training_at timestamptz,
  available boolean NOT NULL DEFAULT false,
  review_reason text,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE courier_locations (
  courier_id uuid PRIMARY KEY REFERENCES couriers(user_id),
  location geometry(Point, 4326) NOT NULL,
  accuracy_m real NOT NULL,
  recorded_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX courier_locations_geom_idx ON courier_locations USING gist(location);

CREATE TABLE delivery_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  courier_id uuid NOT NULL REFERENCES couriers(user_id),
  status text NOT NULL DEFAULT 'offered' CHECK (status IN ('offered','accepted','rejected','expired','cancelled')),
  estimated_distance_meters int NOT NULL,
  estimated_pay_cents bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX delivery_offers_one_open_per_order ON delivery_offers(order_id) WHERE status = 'offered';
CREATE UNIQUE INDEX delivery_offers_one_open_per_courier ON delivery_offers(courier_id) WHERE status = 'offered';

CREATE TABLE deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  courier_id uuid NOT NULL REFERENCES couriers(user_id),
  offer_id uuid REFERENCES delivery_offers(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  assigned_by uuid REFERENCES users(id),
  assign_reason text,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  end_reason text
);
-- Una sola asignación vigente por pedido y una entrega activa por repartidor (capacidad 1 en v1).
CREATE UNIQUE INDEX deliveries_one_active_per_order ON deliveries(order_id) WHERE status = 'active';
CREATE UNIQUE INDEX deliveries_one_active_per_courier ON deliveries(courier_id) WHERE status = 'active';

-- Comprobación presencial de edad en la puerta. Sin foto del documento por defecto.
CREATE TABLE door_age_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  delivery_id uuid NOT NULL REFERENCES deliveries(id),
  courier_id uuid NOT NULL REFERENCES couriers(user_id),
  result text NOT NULL CHECK (result IN ('approved','rejected')),
  document_type text,
  rejection_reason text,
  identity_matches_buyer boolean NOT NULL,
  notes text,
  synced boolean NOT NULL DEFAULT true,
  checked_at timestamptz NOT NULL DEFAULT now(),
  CHECK (result <> 'approved' OR (identity_matches_buyer AND document_type IS NOT NULL)),
  CHECK (result <> 'rejected' OR rejection_reason IS NOT NULL)
);
CREATE UNIQUE INDEX door_age_checks_one_per_delivery ON door_age_checks(delivery_id);

-- =============== Pagos ===============
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  provider text NOT NULL,
  method text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL DEFAULT 'PEN' CHECK (currency = 'PEN'),
  status text NOT NULL DEFAULT 'pendiente',
  provider_reference text,
  idempotency_key text NOT NULL UNIQUE,
  checkout_url text,
  expires_at timestamptz,
  last_checked_at timestamptz,
  failure_reason text,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Un solo intento "vivo" por pedido: no se crea un nuevo cargo si hay uno pendiente/incierto/pagado.
CREATE UNIQUE INDEX payments_one_live_per_order ON payments(order_id)
  WHERE status IN ('pendiente','autorizado','en_conciliacion','pagado','reembolso_pendiente','parcialmente_reembolsado','reembolsado');
CREATE UNIQUE INDEX payments_provider_ref_uq ON payments(provider, provider_reference) WHERE provider_reference IS NOT NULL;

CREATE TABLE payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  payment_id uuid REFERENCES payments(id),
  event_type text NOT NULL,
  occurred_at timestamptz,
  verified boolean NOT NULL,
  verification_note text,
  payload jsonb NOT NULL,
  processed_at timestamptz,
  outcome text,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid REFERENCES payments(id),
  order_id uuid NOT NULL REFERENCES orders(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  concept text NOT NULL DEFAULT 'mixed',
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed','not_required')),
  provider_reference text,
  idempotency_key text NOT NULL UNIQUE,
  requested_by uuid REFERENCES users(id),
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cash_collections (
  order_id uuid PRIMARY KEY REFERENCES orders(id),
  courier_id uuid NOT NULL REFERENCES couriers(user_id),
  amount_due_cents bigint NOT NULL,
  change_for_cents bigint,
  collected_cents bigint NOT NULL,
  collected_at timestamptz NOT NULL DEFAULT now(),
  remitted_at timestamptz,
  CHECK (collected_cents >= amount_due_cents)
);

CREATE TABLE coupon_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id uuid NOT NULL REFERENCES coupons(id),
  user_id uuid NOT NULL REFERENCES users(id),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','reversed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- =============== Libro de movimientos (inmutable) ===============
CREATE TABLE ledger_entries (
  id bigserial PRIMARY KEY,
  order_id uuid REFERENCES orders(id),
  party_type text NOT NULL CHECK (party_type IN ('platform','merchant','courier','customer','gateway')),
  party_id uuid,
  entry_type text NOT NULL,
  amount_cents bigint NOT NULL,
  description text NOT NULL,
  reference text,
  dedupe_key text NOT NULL UNIQUE,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_party_idx ON ledger_entries(party_type, party_id, created_at);

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'La tabla % es inmutable: registre un ajuste', TG_TABLE_NAME;
END $$;
CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_type text NOT NULL CHECK (party_type IN ('merchant','courier')),
  party_id uuid NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL CHECK (period_end > period_start),
  total_cents bigint NOT NULL,
  entries_count int NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','executed','void')),
  execution_reference text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX settlements_period_uq ON settlements(party_type, party_id, period_start, period_end) WHERE status <> 'void';
-- Cada movimiento pertenece a lo sumo a una liquidación vigente: evita incluir un pedido dos veces.
CREATE TABLE settlement_items (
  settlement_id uuid NOT NULL REFERENCES settlements(id),
  ledger_entry_id bigint NOT NULL UNIQUE REFERENCES ledger_entries(id),
  PRIMARY KEY (settlement_id, ledger_entry_id)
);

-- =============== Soporte ===============
CREATE TABLE order_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  sender_user_id uuid NOT NULL REFERENCES users(id),
  sender_role text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  reporter_user_id uuid REFERENCES users(id),
  reporter_role text NOT NULL,
  kind text NOT NULL,
  description text NOT NULL,
  evidence_document_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution text,
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ratings (
  order_id uuid PRIMARY KEY REFERENCES orders(id),
  user_id uuid NOT NULL REFERENCES users(id),
  store_score int NOT NULL CHECK (store_score BETWEEN 1 AND 5),
  courier_score int CHECK (courier_score BETWEEN 1 AND 5),
  comment text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE complaints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  year int NOT NULL,
  seq int NOT NULL,
  number text NOT NULL UNIQUE,
  consumer_name text NOT NULL,
  consumer_doc_type text NOT NULL,
  consumer_doc_number text NOT NULL,
  consumer_email citext NOT NULL,
  consumer_phone text,
  consumer_address text,
  is_minor boolean NOT NULL DEFAULT false,
  guardian_name text,
  kind text NOT NULL CHECK (kind IN ('reclamo','queja')),
  good_type text NOT NULL,
  order_id uuid REFERENCES orders(id),
  amount_cents bigint,
  detail text NOT NULL,
  request text NOT NULL,
  due_date date NOT NULL,
  response text,
  responded_at timestamptz,
  responded_by uuid REFERENCES users(id),
  user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (year, seq)
);
CREATE TABLE complaint_counters (year int PRIMARY KEY, last_seq int NOT NULL);

CREATE TABLE peru_holidays (day date PRIMARY KEY, name text NOT NULL);

-- =============== Notificaciones, outbox, auditoría ===============
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  category text NOT NULL DEFAULT 'transactional' CHECK (category IN ('transactional','marketing')),
  title text NOT NULL,
  body text NOT NULL,
  -- texto apto para pantalla bloqueada: sin datos sensibles ni detalles de alcohol
  lockscreen_body text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  dedupe_key text NOT NULL UNIQUE,
  read_at timestamptz,
  push_status text NOT NULL DEFAULT 'not_configured',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC);

CREATE TABLE outbox_events (
  id bigserial PRIMARY KEY,
  topic text NOT NULL,
  aggregate_id uuid,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  dead_at timestamptz,
  last_error text
);
CREATE INDEX outbox_pending_idx ON outbox_events(next_attempt_at) WHERE processed_at IS NULL AND dead_at IS NULL;

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id),
  actor_roles text[],
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text,
  reason text,
  data jsonb NOT NULL DEFAULT '{}',
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE courier_trainings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  courier_id uuid NOT NULL REFERENCES couriers(user_id),
  topic text NOT NULL CHECK (topic IN ('documentos','rechazo','privacidad','soporte','venta_responsable')),
  completed_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid REFERENCES users(id)
);

CREATE TABLE app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE push_tokens (
  token text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('android','ios','web')),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE delivery_code_attempts (
  id bigserial PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  courier_id uuid NOT NULL,
  success boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- SOLO DESARROLLO/PRUEBAS: estado del proveedor de pagos simulado ("sandbox").
-- Representa al sistema externo del proveedor; la configuración de producción rechaza este proveedor.
CREATE TABLE sandbox_provider_charges (
  reference text PRIMARY KEY,
  payment_id uuid NOT NULL,
  amount_cents bigint NOT NULL,
  currency text NOT NULL,
  status text NOT NULL,
  refunded_cents bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
