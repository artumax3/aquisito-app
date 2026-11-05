-- Revisión de documentos con vencimiento, banners promocionales y avisos de proximidad.
ALTER TABLE documents ADD COLUMN review_reason text;
CREATE INDEX documents_expiry_idx ON documents(expires_at) WHERE status = 'approved' AND expires_at IS NOT NULL;

CREATE TABLE banners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id uuid REFERENCES cities(id),
  title text NOT NULL,
  body text NOT NULL,
  conditions text NOT NULL,
  link_branch_id uuid REFERENCES branches(id),
  -- Un banner que promociona alcohol solo se muestra a adultos verificados.
  contains_alcohol boolean NOT NULL DEFAULT false,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  active boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX banners_city_idx ON banners(city_id, starts_at, ends_at) WHERE active;

-- Aviso de proximidad: uno por pedido.
CREATE TABLE order_nearby_notices (
  order_id uuid PRIMARY KEY REFERENCES orders(id),
  notified_at timestamptz NOT NULL DEFAULT now()
);
