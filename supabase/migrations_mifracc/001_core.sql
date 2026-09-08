-- ============================================================
-- VECINITY · Módulo A — Núcleo multi-colonia
-- schema: mifracc · Supabase self-hosted Nexia
-- ============================================================

-- ---------- ENUMS ----------
CREATE TYPE mifracc.user_role AS ENUM ('admin','guardia','residente','capitan','comite');
CREATE TYPE mifracc.approval_status AS ENUM ('pendiente','aprobado','rechazado');
CREATE TYPE mifracc.tipo_residente AS ENUM ('propietario','arrendatario');
CREATE TYPE mifracc.estatus_casa AS ENUM ('al_corriente','con_adeudo','en_convenio');

-- ---------- COLONIAS (tenant raíz) ----------
CREATE TABLE mifracc.colonias (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre                  text NOT NULL,
  slug                    text UNIQUE NOT NULL,
  direccion               text,
  logo_url                text,
  google_maps_link        text,
  -- parámetros financieros
  cuota_mensual           numeric(10,2) NOT NULL DEFAULT 0,
  dia_limite_pago         int  NOT NULL DEFAULT 10,
  recargo                 numeric(10,2) NOT NULL DEFAULT 100,
  umbral_saldo_alerta     numeric(10,2) NOT NULL DEFAULT 0,
  -- parámetros acceso RFID
  umbral_suspension_rfid  numeric(10,2),
  rfid_requiere_aprobacion boolean NOT NULL DEFAULT true,
  -- parámetros monitoreo
  aforo_default_alberca   int,
  -- notificaciones
  telegram_bot_token      text,
  created_at              timestamptz NOT NULL DEFAULT now()
);

-- ---------- ZONES (zona / calle) ----------
CREATE TABLE mifracc.zones (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id           uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  nombre               text NOT NULL,
  codigo               text,
  color                text DEFAULT '#3b82f6',
  captain_id           uuid,            -- FK a profiles (se agrega luego, evita ciclo)
  member_count         int NOT NULL DEFAULT 0,
  -- monitoreo / reglas de zona
  max_occupancy        int,
  prohibited_activities text[] DEFAULT '{}',
  lat                  double precision,
  lng                  double precision,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- ---------- HOUSES (casas) ----------
CREATE TABLE mifracc.houses (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id           uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  zone_id              uuid REFERENCES mifracc.zones(id) ON DELETE SET NULL,
  numero               text NOT NULL,
  street               text,
  propietario          text,
  tel_1                text,
  tel_2                text,
  tel_3                text,
  tipo_residente       mifracc.tipo_residente NOT NULL DEFAULT 'propietario',
  esta_rentada         boolean NOT NULL DEFAULT false,
  nombre_arrendatario  text,
  num_habitantes       int NOT NULL DEFAULT 1,
  saldo                numeric(10,2) NOT NULL DEFAULT 0,
  estatus              mifracc.estatus_casa NOT NULL DEFAULT 'al_corriente',
  comprobante_ine_url  text,
  comprobante_predial_url text,
  es_verificado        boolean NOT NULL DEFAULT false,
  pin_finanzas         text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (colonia_id, numero)
);

-- ---------- PROFILES (usuario = auth.users) ----------
CREATE TABLE mifracc.profiles (
  id                uuid PRIMARY KEY,   -- = auth.users.id
  colonia_id        uuid REFERENCES mifracc.colonias(id) ON DELETE SET NULL,
  house_id          uuid REFERENCES mifracc.houses(id) ON DELETE SET NULL,
  nombre            text NOT NULL,
  email             text NOT NULL,
  role              mifracc.user_role NOT NULL DEFAULT 'residente',
  telegram_chat_id  text,
  telefono          text,
  avatar            text,
  is_active         boolean NOT NULL DEFAULT true,
  approval_status   mifracc.approval_status NOT NULL DEFAULT 'pendiente',
  rules_accepted_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- FK diferida zones.captain_id -> profiles
ALTER TABLE mifracc.zones
  ADD CONSTRAINT zones_captain_fk FOREIGN KEY (captain_id)
  REFERENCES mifracc.profiles(id) ON DELETE SET NULL;

-- ---------- INVITATIONS (onboarding sin fricción) ----------
CREATE TABLE mifracc.invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id   uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  house_id     uuid REFERENCES mifracc.houses(id) ON DELETE SET NULL,
  email        text,
  role         mifracc.user_role NOT NULL DEFAULT 'residente',
  token        text UNIQUE NOT NULL,
  invited_by   uuid REFERENCES mifracc.profiles(id) ON DELETE SET NULL,
  accepted_at  timestamptz,
  expires_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- FUNCIONES HELPER (SECURITY DEFINER — evitan recursión RLS)
-- ============================================================
CREATE OR REPLACE FUNCTION mifracc.my_colonia_id()
RETURNS uuid LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = mifracc, auth AS $$
  SELECT colonia_id FROM mifracc.profiles WHERE id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION mifracc.my_role()
RETURNS mifracc.user_role LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = mifracc, auth AS $$
  SELECT role FROM mifracc.profiles WHERE id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION mifracc.is_admin()
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = mifracc, auth AS $$
  SELECT EXISTS (SELECT 1 FROM mifracc.profiles
                 WHERE id = auth.uid() AND role IN ('admin','comite'))
$$;

-- updated_at trigger
CREATE OR REPLACE FUNCTION mifracc.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER trg_profiles_touch BEFORE UPDATE ON mifracc.profiles
  FOR EACH ROW EXECUTE FUNCTION mifracc.touch_updated_at();

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE mifracc.colonias    ENABLE ROW LEVEL SECURITY;
ALTER TABLE mifracc.zones       ENABLE ROW LEVEL SECURITY;
ALTER TABLE mifracc.houses      ENABLE ROW LEVEL SECURITY;
ALTER TABLE mifracc.profiles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE mifracc.invitations ENABLE ROW LEVEL SECURITY;

-- colonias: ves la tuya
CREATE POLICY colonias_read ON mifracc.colonias FOR SELECT
  USING (id = mifracc.my_colonia_id());
CREATE POLICY colonias_admin ON mifracc.colonias FOR ALL
  USING (id = mifracc.my_colonia_id() AND mifracc.is_admin())
  WITH CHECK (id = mifracc.my_colonia_id() AND mifracc.is_admin());

-- zones / houses: lectura misma colonia, escritura admin/comité
CREATE POLICY zones_read ON mifracc.zones FOR SELECT
  USING (colonia_id = mifracc.my_colonia_id());
CREATE POLICY zones_admin ON mifracc.zones FOR ALL
  USING (colonia_id = mifracc.my_colonia_id() AND mifracc.is_admin())
  WITH CHECK (colonia_id = mifracc.my_colonia_id() AND mifracc.is_admin());

CREATE POLICY houses_read ON mifracc.houses FOR SELECT
  USING (colonia_id = mifracc.my_colonia_id());
CREATE POLICY houses_admin ON mifracc.houses FOR ALL
  USING (colonia_id = mifracc.my_colonia_id() AND mifracc.is_admin())
  WITH CHECK (colonia_id = mifracc.my_colonia_id() AND mifracc.is_admin());

-- profiles: ves tu propio perfil y los de tu colonia; editas el tuyo
CREATE POLICY profiles_self_read ON mifracc.profiles FOR SELECT
  USING (id = auth.uid() OR colonia_id = mifracc.my_colonia_id());
CREATE POLICY profiles_self_write ON mifracc.profiles FOR UPDATE
  USING (id = auth.uid()) WITH CHECK (id = auth.uid());
CREATE POLICY profiles_admin ON mifracc.profiles FOR ALL
  USING (colonia_id = mifracc.my_colonia_id() AND mifracc.is_admin())
  WITH CHECK (colonia_id = mifracc.my_colonia_id() AND mifracc.is_admin());

-- invitations: admin de la colonia
CREATE POLICY invitations_admin ON mifracc.invitations FOR ALL
  USING (colonia_id = mifracc.my_colonia_id() AND mifracc.is_admin())
  WITH CHECK (colonia_id = mifracc.my_colonia_id() AND mifracc.is_admin());

-- índices
CREATE INDEX idx_zones_colonia   ON mifracc.zones(colonia_id);
CREATE INDEX idx_houses_colonia  ON mifracc.houses(colonia_id);
CREATE INDEX idx_houses_zone     ON mifracc.houses(zone_id);
CREATE INDEX idx_profiles_colonia ON mifracc.profiles(colonia_id);
CREATE INDEX idx_profiles_house  ON mifracc.profiles(house_id);

-- ============================================================
-- GRANTS (estándar Nexia para schema nuevo)
-- ============================================================
GRANT USAGE ON SCHEMA mifracc TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA mifracc TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA mifracc TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA mifracc GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA mifracc GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
