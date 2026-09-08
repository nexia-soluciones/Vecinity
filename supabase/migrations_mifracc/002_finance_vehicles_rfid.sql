-- ============================================================
-- VECINITY · Módulos B (Finanzas) · C (Multas) · D (Vehículos/Visitantes+OCR) · K (Acceso RFID)
-- ============================================================

-- ---------- ENUMS ----------
CREATE TYPE mifracc.transaction_type   AS ENUM ('cargo','abono','ajuste');
CREATE TYPE mifracc.approval_state     AS ENUM ('pendiente','aprobado','rechazado');
CREATE TYPE mifracc.payment_state      AS ENUM ('pendiente','pagado','atrasado','en_verificacion');
CREATE TYPE mifracc.incident_status    AS ENUM ('pendiente','rechazado','multa');
CREATE TYPE mifracc.vehicle_status     AS ENUM ('pendiente','aprobado','rechazado');
CREATE TYPE mifracc.visit_status       AS ENUM ('esperando','adentro','completada');
CREATE TYPE mifracc.tag_type           AS ENUM ('persona','vehiculo');
CREATE TYPE mifracc.tag_status         AS ENUM ('activo','suspendido','vencido');
CREATE TYPE mifracc.access_dir         AS ENUM ('entra','sale');
CREATE TYPE mifracc.access_result      AS ENUM ('permitido','denegado');
CREATE TYPE mifracc.suspension_status  AS ENUM ('pendiente','aprobada','ejecutada','levantada');

-- ============================================================
-- MÓDULO B — FINANZAS
-- ============================================================
CREATE TABLE mifracc.transactions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id    uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  house_id      uuid NOT NULL REFERENCES mifracc.houses(id) ON DELETE CASCADE,
  tipo          mifracc.transaction_type NOT NULL,
  monto         numeric(10,2) NOT NULL,
  concepto      text NOT NULL,
  comprobante_url text,
  estado        mifracc.approval_state NOT NULL DEFAULT 'aprobado',
  recibo_pdf_url text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mifracc.payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id      uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  house_id        uuid NOT NULL REFERENCES mifracc.houses(id) ON DELETE CASCADE,
  concepto        text NOT NULL DEFAULT 'Mantenimiento Mensual',
  monto           numeric(10,2) NOT NULL,
  fecha_generacion date NOT NULL DEFAULT current_date,
  fecha_vencimiento date NOT NULL,
  estado          mifracc.payment_state NOT NULL DEFAULT 'pendiente',
  comprobante_url text,
  folio           int,
  recibo_pdf_url  text,
  es_deuda_anterior boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (colonia_id, folio)
);

CREATE TABLE mifracc.improvement_projects (   -- adelantada (FK desde expenses)
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id   uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  proposal_id  uuid,
  titulo       text NOT NULL,
  descripcion  text,
  presupuesto  numeric(12,2) NOT NULL DEFAULT 0,
  estado       text NOT NULL DEFAULT 'planeado' CHECK (estado IN ('planeado','en_curso','terminado','cancelado')),
  responsable_id uuid REFERENCES mifracc.profiles(id) ON DELETE SET NULL,
  fecha_inicio date,
  fecha_fin    date,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mifracc.colonia_expenses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id    uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  concepto      text NOT NULL,
  monto         numeric(12,2) NOT NULL,
  fecha_pago    date NOT NULL DEFAULT current_date,
  categoria     text NOT NULL,
  archivo_principal_url text,
  archivo_secundario_url text,
  descripcion   text,
  registrado_por uuid REFERENCES mifracc.profiles(id) ON DELETE SET NULL,
  improvement_id uuid REFERENCES mifracc.improvement_projects(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mifracc.folio_counters (
  colonia_id    uuid PRIMARY KEY REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  ultimo_folio  int NOT NULL DEFAULT 1999
);

-- ============================================================
-- MÓDULO C — MULTAS / INCIDENCIAS
-- ============================================================
CREATE TABLE mifracc.fine_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id  uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  nombre      text NOT NULL,
  monto_base  numeric(10,2) NOT NULL DEFAULT 200
);

CREATE TABLE mifracc.incident_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id      uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  reportante_house_id uuid REFERENCES mifracc.houses(id) ON DELETE SET NULL,
  infractor_house_id  uuid NOT NULL REFERENCES mifracc.houses(id) ON DELETE CASCADE,
  categoria_id    uuid REFERENCES mifracc.fine_categories(id) ON DELETE SET NULL,
  descripcion     text,
  evidencia_url   text,
  estado          mifracc.incident_status NOT NULL DEFAULT 'pendiente',
  resolucion_admin text,
  monto_multa     numeric(10,2) NOT NULL DEFAULT 0,
  transaction_id  uuid REFERENCES mifracc.transactions(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mifracc.report_evidence (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id   uuid NOT NULL REFERENCES mifracc.incident_reports(id) ON DELETE CASCADE,
  archivo_url text NOT NULL,
  subido_por_house_id uuid REFERENCES mifracc.houses(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- MÓDULO D — VEHÍCULOS / VISITANTES (+ OCR placas)
-- ============================================================
CREATE TABLE mifracc.vehicle_brands (
  id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre text UNIQUE NOT NULL
);
CREATE TABLE mifracc.vehicle_models (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id  uuid NOT NULL REFERENCES mifracc.vehicle_brands(id) ON DELETE CASCADE,
  nombre    text NOT NULL
);

CREATE TABLE mifracc.vehicles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id    uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  house_id      uuid NOT NULL REFERENCES mifracc.houses(id) ON DELETE CASCADE,
  brand_id      uuid REFERENCES mifracc.vehicle_brands(id) ON DELETE SET NULL,
  model_id      uuid REFERENCES mifracc.vehicle_models(id) ON DELETE SET NULL,
  placa         text NOT NULL,
  color         text,
  tarjeta_rfid  text,
  estado        mifracc.vehicle_status NOT NULL DEFAULT 'pendiente',
  plate_ocr_confidence numeric(5,2),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (colonia_id, placa)
);

CREATE TABLE mifracc.visitors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id    uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  house_id      uuid NOT NULL REFERENCES mifracc.houses(id) ON DELETE CASCADE,
  nombre        text NOT NULL,
  token_acceso  text UNIQUE,
  foto_identificacion_url text,
  foto_placas_url text,
  plate_detected text,                       -- resultado OCR (Tesseract)
  fecha_programada timestamptz,
  estado        mifracc.visit_status NOT NULL DEFAULT 'esperando',
  guardia_entrada_id uuid REFERENCES mifracc.profiles(id) ON DELETE SET NULL,
  fecha_hora_entrada timestamptz,
  guardia_salida_id  uuid REFERENCES mifracc.profiles(id) ON DELETE SET NULL,
  fecha_hora_salida  timestamptz,
  origen_registro text NOT NULL DEFAULT 'vecino' CHECK (origen_registro IN ('vecino','vigilante')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- MÓDULO K — CONTROL DE ACCESO RFID (gobernado)
-- ============================================================
CREATE TABLE mifracc.rfid_tags (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id    uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  house_id      uuid REFERENCES mifracc.houses(id) ON DELETE CASCADE,
  profile_id    uuid REFERENCES mifracc.profiles(id) ON DELETE SET NULL,
  vehicle_id    uuid REFERENCES mifracc.vehicles(id) ON DELETE SET NULL,
  codigo_tag    text NOT NULL,
  tipo          mifracc.tag_type NOT NULL DEFAULT 'persona',
  status        mifracc.tag_status NOT NULL DEFAULT 'activo',
  motivo        text,
  suspended_at  timestamptz,
  reactivated_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (colonia_id, codigo_tag)
);

CREATE TABLE mifracc.access_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id    uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  tag_id        uuid REFERENCES mifracc.rfid_tags(id) ON DELETE SET NULL,
  lector        text,
  sentido       mifracc.access_dir,
  resultado     mifracc.access_result NOT NULL,
  motivo_denegado text,
  ts            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mifracc.access_suspensions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id    uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  house_id      uuid NOT NULL REFERENCES mifracc.houses(id) ON DELETE CASCADE,
  tag_id        uuid REFERENCES mifracc.rfid_tags(id) ON DELETE SET NULL,
  motivo        text NOT NULL DEFAULT 'adeudo',
  saldo_al_momento numeric(10,2),
  approved_by   uuid REFERENCES mifracc.profiles(id) ON DELETE SET NULL,
  proposal_id   uuid,
  status        mifracc.suspension_status NOT NULL DEFAULT 'pendiente',
  created_at    timestamptz NOT NULL DEFAULT now(),
  executed_at   timestamptz,
  lifted_at     timestamptz
);

-- ============================================================
-- RLS (colonia-scoped: lectura misma colonia, escritura admin/comité)
-- vehicle_brands / vehicle_models = catálogo global (lectura para todos)
-- ============================================================
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'transactions','payments','improvement_projects','colonia_expenses','folio_counters',
    'fine_categories','incident_reports',
    'vehicles','visitors','rfid_tags','access_events','access_suspensions'
  ] LOOP
    EXECUTE format('ALTER TABLE mifracc.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format($p$CREATE POLICY %1$s_read ON mifracc.%1$I FOR SELECT
                      USING (colonia_id = mifracc.my_colonia_id());$p$, t);
    EXECUTE format($p$CREATE POLICY %1$s_admin ON mifracc.%1$I FOR ALL
                      USING (colonia_id = mifracc.my_colonia_id() AND mifracc.is_admin())
                      WITH CHECK (colonia_id = mifracc.my_colonia_id() AND mifracc.is_admin());$p$, t);
  END LOOP;

  -- report_evidence no tiene colonia_id directo → política por join
  EXECUTE 'ALTER TABLE mifracc.report_evidence ENABLE ROW LEVEL SECURITY';
  EXECUTE $p$CREATE POLICY report_evidence_read ON mifracc.report_evidence FOR SELECT
            USING (EXISTS (SELECT 1 FROM mifracc.incident_reports r
                           WHERE r.id = report_id AND r.colonia_id = mifracc.my_colonia_id()));$p$;
  EXECUTE $p$CREATE POLICY report_evidence_write ON mifracc.report_evidence FOR ALL
            USING (EXISTS (SELECT 1 FROM mifracc.incident_reports r
                           WHERE r.id = report_id AND r.colonia_id = mifracc.my_colonia_id()))
            WITH CHECK (EXISTS (SELECT 1 FROM mifracc.incident_reports r
                           WHERE r.id = report_id AND r.colonia_id = mifracc.my_colonia_id()));$p$;
END $rls$;

-- catálogo global de vehículos
ALTER TABLE mifracc.vehicle_brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE mifracc.vehicle_models ENABLE ROW LEVEL SECURITY;
CREATE POLICY brands_read ON mifracc.vehicle_brands FOR SELECT USING (true);
CREATE POLICY models_read ON mifracc.vehicle_models FOR SELECT USING (true);

-- ÍNDICES
CREATE INDEX idx_tx_house        ON mifracc.transactions(house_id);
CREATE INDEX idx_tx_colonia      ON mifracc.transactions(colonia_id);
CREATE INDEX idx_pay_house       ON mifracc.payments(house_id);
CREATE INDEX idx_pay_venc        ON mifracc.payments(fecha_vencimiento);
CREATE INDEX idx_exp_colonia     ON mifracc.colonia_expenses(colonia_id);
CREATE INDEX idx_inc_infractor   ON mifracc.incident_reports(infractor_house_id);
CREATE INDEX idx_veh_house       ON mifracc.vehicles(house_id);
CREATE INDEX idx_veh_placa       ON mifracc.vehicles(colonia_id, placa);
CREATE INDEX idx_vis_house       ON mifracc.visitors(house_id);
CREATE INDEX idx_rfid_house      ON mifracc.rfid_tags(house_id);
CREATE INDEX idx_rfid_status     ON mifracc.rfid_tags(colonia_id, status);
CREATE INDEX idx_access_tag      ON mifracc.access_events(tag_id);

-- GRANTS (refuerzo)
GRANT ALL ON ALL TABLES IN SCHEMA mifracc TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA mifracc TO anon, authenticated, service_role;
