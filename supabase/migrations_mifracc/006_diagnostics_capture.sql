-- ============================================================
-- VECINITY · Captura para diagnóstico comunitario (Presión vs. Resiliencia)
-- Solo CAPTURA de señales (el índice/tablero se construye post-deploy con datos).
-- Append-only donde la TENDENCIA importa (no reconstruible después).
-- Ref: Mejora_Vecino_Vigilante_Seshat_Local
-- ============================================================

CREATE TYPE mifracc.house_condition AS ENUM ('bueno','regular','malo','abandonado','obra_negra');

-- ---- PRESIÓN: backlog / tiempo de resolución de reportes ----
ALTER TABLE mifracc.incident_reports  ADD COLUMN resolved_at timestamptz;
ALTER TABLE mifracc.incident_reports  ADD COLUMN resolved_by uuid REFERENCES mifracc.profiles(id) ON DELETE SET NULL;
ALTER TABLE mifracc.security_reports  ADD COLUMN resolved_at timestamptz;

-- ---- PRESIÓN: deterioro físico (estado actual en la casa) ----
ALTER TABLE mifracc.houses ADD COLUMN estado_fisico mifracc.house_condition NOT NULL DEFAULT 'bueno';
ALTER TABLE mifracc.houses ADD COLUMN estado_fisico_at timestamptz;

-- ---- PRESIÓN: salud financiera (reserva actual de la colonia) ----
ALTER TABLE mifracc.colonias ADD COLUMN fondo_comun numeric(12,2) NOT NULL DEFAULT 0;

-- ---- PRESIÓN: deterioro físico/áreas comunes — TENDENCIA (append-only) ----
CREATE TABLE mifracc.condition_logs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id     uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  target         text NOT NULL CHECK (target IN ('casa','area_comun','alumbrado','areas_verdes','amenidad','zona')),
  house_id       uuid REFERENCES mifracc.houses(id) ON DELETE CASCADE,
  common_area_id uuid REFERENCES mifracc.common_areas(id) ON DELETE CASCADE,
  zone_id        uuid REFERENCES mifracc.zones(id) ON DELETE SET NULL,
  estado         mifracc.house_condition NOT NULL,
  nota           text,
  registrado_por uuid REFERENCES mifracc.profiles(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---- RESILIENCIA: participación (asambleas) — TENDENCIA ----
CREATE TABLE mifracc.assemblies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id  uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  titulo      text NOT NULL,
  descripcion text,
  fecha       date NOT NULL DEFAULT current_date,
  tipo        text NOT NULL DEFAULT 'ordinaria',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mifracc.assembly_attendance (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id  uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  assembly_id uuid NOT NULL REFERENCES mifracc.assemblies(id) ON DELETE CASCADE,
  house_id    uuid NOT NULL REFERENCES mifracc.houses(id) ON DELETE CASCADE,
  presente    boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assembly_id, house_id)
);

-- ---- RESILIENCIA: salud financiera — TENDENCIA (snapshot mensual) ----
CREATE TABLE mifracc.fund_snapshots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id  uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  fecha       date NOT NULL DEFAULT current_date,
  fondo       numeric(12,2) NOT NULL DEFAULT 0,
  ingresos    numeric(12,2) NOT NULL DEFAULT 0,
  egresos     numeric(12,2) NOT NULL DEFAULT 0,
  nota        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---- PRESIÓN: rotación (renta↔propia) — TENDENCIA automática por trigger ----
CREATE TABLE mifracc.house_tenancy_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id     uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  house_id       uuid NOT NULL REFERENCES mifracc.houses(id) ON DELETE CASCADE,
  esta_rentada   boolean,
  tipo_residente mifracc.tipo_residente,
  changed_at     timestamptz NOT NULL DEFAULT now()
);

-- trigger: registrar cambios de tenencia (rotación) automáticamente
CREATE OR REPLACE FUNCTION mifracc.log_tenancy_change()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO mifracc.house_tenancy_log (colonia_id, house_id, esta_rentada, tipo_residente)
  VALUES (NEW.colonia_id, NEW.id, NEW.esta_rentada, NEW.tipo_residente);
  RETURN NEW;
END $fn$;
CREATE TRIGGER trg_house_tenancy AFTER UPDATE ON mifracc.houses
  FOR EACH ROW
  WHEN (OLD.esta_rentada IS DISTINCT FROM NEW.esta_rentada
        OR OLD.tipo_residente IS DISTINCT FROM NEW.tipo_residente)
  EXECUTE FUNCTION mifracc.log_tenancy_change();

-- trigger: un condition_log de casa actualiza el estado_fisico denormalizado
CREATE OR REPLACE FUNCTION mifracc.apply_condition_to_house()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.house_id IS NOT NULL THEN
    UPDATE mifracc.houses
      SET estado_fisico = NEW.estado, estado_fisico_at = NEW.created_at
      WHERE id = NEW.house_id;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER trg_condition_apply AFTER INSERT ON mifracc.condition_logs
  FOR EACH ROW EXECUTE FUNCTION mifracc.apply_condition_to_house();

-- ============================================================
-- RLS (colonia-scoped) para las tablas nuevas
-- ============================================================
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'condition_logs','assemblies','assembly_attendance','fund_snapshots','house_tenancy_log'
  ] LOOP
    EXECUTE format('ALTER TABLE mifracc.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format($p$CREATE POLICY %1$s_read ON mifracc.%1$I FOR SELECT
                      USING (colonia_id = mifracc.my_colonia_id());$p$, t);
    EXECUTE format($p$CREATE POLICY %1$s_admin ON mifracc.%1$I FOR ALL
                      USING (colonia_id = mifracc.my_colonia_id() AND mifracc.is_admin())
                      WITH CHECK (colonia_id = mifracc.my_colonia_id() AND mifracc.is_admin());$p$, t);
  END LOOP;
END $rls$;

CREATE INDEX idx_cond_colonia   ON mifracc.condition_logs(colonia_id, created_at);
CREATE INDEX idx_cond_house     ON mifracc.condition_logs(house_id);
CREATE INDEX idx_asm_colonia    ON mifracc.assemblies(colonia_id, fecha);
CREATE INDEX idx_att_assembly   ON mifracc.assembly_attendance(assembly_id);
CREATE INDEX idx_fund_colonia   ON mifracc.fund_snapshots(colonia_id, fecha);
CREATE INDEX idx_inc_resolved   ON mifracc.incident_reports(colonia_id, resolved_at);

GRANT ALL ON ALL TABLES IN SCHEMA mifracc TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA mifracc TO anon, authenticated, service_role;
