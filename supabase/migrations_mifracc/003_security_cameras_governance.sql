-- ============================================================
-- VECINITY · Módulos E (Seguridad) · L (Cámaras) · F (Comité/Votación) · G (FKs Mejoras)
-- ============================================================

-- ---------- ENUMS ----------
CREATE TYPE mifracc.sos_mode          AS ENUM ('loud','silent');
CREATE TYPE mifracc.alert_severity    AS ENUM ('baja','media','alta');
CREATE TYPE mifracc.alert_status      AS ENUM ('abierta','en_proceso','resuelta');
CREATE TYPE mifracc.camera_purpose    AS ENUM ('conteo_alberca','zona_prohibida','general');
CREATE TYPE mifracc.camera_event_type AS ENUM ('aforo','actividad_prohibida','merodeo','intrusion');
CREATE TYPE mifracc.proposal_status   AS ENUM ('pendiente','activa','aprobada','rechazada','cancelada');
CREATE TYPE mifracc.proposal_type     AS ENUM ('mejora','comite','general');
CREATE TYPE mifracc.vote_decision     AS ENUM ('a_favor','en_contra','abstencion');

-- ============================================================
-- MÓDULO E — SEGURIDAD VECINAL
-- ============================================================
CREATE TABLE mifracc.sos_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id    uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  profile_id    uuid NOT NULL REFERENCES mifracc.profiles(id) ON DELETE CASCADE,
  house_id      uuid REFERENCES mifracc.houses(id) ON DELETE SET NULL,
  zone_id       uuid REFERENCES mifracc.zones(id) ON DELETE SET NULL,
  mode          mifracc.sos_mode NOT NULL DEFAULT 'loud',
  lat           double precision,
  lng           double precision,
  is_active     boolean NOT NULL DEFAULT true,
  attended_by   uuid REFERENCES mifracc.profiles(id) ON DELETE SET NULL,
  activated_at  timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz
);

CREATE TABLE mifracc.alerts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id    uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  zone_id       uuid REFERENCES mifracc.zones(id) ON DELETE SET NULL,
  categoria     text NOT NULL,
  severidad     mifracc.alert_severity NOT NULL DEFAULT 'media',
  titulo        text NOT NULL,
  descripcion   text,
  lat           double precision,
  lng           double precision,
  author_id     uuid REFERENCES mifracc.profiles(id) ON DELETE SET NULL,
  status        mifracc.alert_status NOT NULL DEFAULT 'abierta',
  evidence      text[] DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz
);

CREATE TABLE mifracc.safe_points (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id    uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  zone_id       uuid REFERENCES mifracc.zones(id) ON DELETE SET NULL,
  nombre        text NOT NULL,
  tipo          text,
  direccion     text,
  telefono      text,
  hours         text,
  lat           double precision,
  lng           double precision,
  owner_id      uuid REFERENCES mifracc.profiles(id) ON DELETE SET NULL,
  is_safe_point boolean NOT NULL DEFAULT true,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mifracc.security_reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id    uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  alert_id      uuid REFERENCES mifracc.alerts(id) ON DELETE SET NULL,
  sos_id        uuid REFERENCES mifracc.sos_events(id) ON DELETE SET NULL,
  captain_id    uuid REFERENCES mifracc.profiles(id) ON DELETE SET NULL,
  descripcion   text,
  status        text NOT NULL DEFAULT 'abierto',
  response_time text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- MÓDULO L — CÁMARAS IP (listo para visión por computadora)
-- ============================================================
CREATE TABLE mifracc.cameras (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id  uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  zone_id     uuid REFERENCES mifracc.zones(id) ON DELETE SET NULL,
  nombre      text NOT NULL,
  tipo        text,
  ubicacion   text,
  stream_url  text,
  proposito   mifracc.camera_purpose NOT NULL DEFAULT 'general',
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mifracc.camera_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id    uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  camera_id     uuid NOT NULL REFERENCES mifracc.cameras(id) ON DELETE CASCADE,
  zone_id       uuid REFERENCES mifracc.zones(id) ON DELETE SET NULL,
  event_type    mifracc.camera_event_type NOT NULL,
  metric_value  numeric,
  snapshot_url  text,
  severidad     mifracc.alert_severity NOT NULL DEFAULT 'media',
  linked_alert_id uuid REFERENCES mifracc.alerts(id) ON DELETE SET NULL,
  detected_at   timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- MÓDULO F — COMITÉ / VOTACIÓN
-- ============================================================
CREATE TABLE mifracc.proposals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id    uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  autor_house_id uuid REFERENCES mifracc.houses(id) ON DELETE SET NULL,
  titulo        text NOT NULL,
  descripcion   text NOT NULL,
  costo_estimado numeric(12,2) NOT NULL DEFAULT 0,
  beneficios    text,
  tipo          mifracc.proposal_type NOT NULL DEFAULT 'general',
  estado        mifracc.proposal_status NOT NULL DEFAULT 'pendiente',
  fecha_creacion timestamptz NOT NULL DEFAULT now(),
  fecha_fin_votacion timestamptz
);

CREATE TABLE mifracc.votes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES mifracc.proposals(id) ON DELETE CASCADE,
  house_id    uuid NOT NULL REFERENCES mifracc.houses(id) ON DELETE CASCADE,
  decision    mifracc.vote_decision NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proposal_id, house_id)
);

CREATE TABLE mifracc.proposal_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES mifracc.proposals(id) ON DELETE CASCADE,
  documento_url text NOT NULL,
  nombre      text
);

CREATE TABLE mifracc.committee_members (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id    uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  profile_id    uuid NOT NULL REFERENCES mifracc.profiles(id) ON DELETE CASCADE,
  cargo         text NOT NULL,
  periodo_inicio date,
  periodo_fin   date,
  proposal_origin_id uuid REFERENCES mifracc.proposals(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- FKs diferidas que apuntan a proposals (definidas en módulos previos)
ALTER TABLE mifracc.improvement_projects
  ADD CONSTRAINT improvement_proposal_fk FOREIGN KEY (proposal_id)
  REFERENCES mifracc.proposals(id) ON DELETE SET NULL;
ALTER TABLE mifracc.access_suspensions
  ADD CONSTRAINT suspension_proposal_fk FOREIGN KEY (proposal_id)
  REFERENCES mifracc.proposals(id) ON DELETE SET NULL;

-- ============================================================
-- RLS
-- ============================================================
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sos_events','alerts','safe_points','security_reports',
    'cameras','camera_events','proposals','committee_members'
  ] LOOP
    EXECUTE format('ALTER TABLE mifracc.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format($p$CREATE POLICY %1$s_read ON mifracc.%1$I FOR SELECT
                      USING (colonia_id = mifracc.my_colonia_id());$p$, t);
    EXECUTE format($p$CREATE POLICY %1$s_admin ON mifracc.%1$I FOR ALL
                      USING (colonia_id = mifracc.my_colonia_id() AND mifracc.is_admin())
                      WITH CHECK (colonia_id = mifracc.my_colonia_id() AND mifracc.is_admin());$p$, t);
  END LOOP;
END $rls$;

-- residentes pueden CREAR su SOS y sus propuestas/votos
CREATE POLICY sos_insert_self ON mifracc.sos_events FOR INSERT
  WITH CHECK (colonia_id = mifracc.my_colonia_id() AND profile_id = auth.uid());
CREATE POLICY alerts_insert ON mifracc.alerts FOR INSERT
  WITH CHECK (colonia_id = mifracc.my_colonia_id());
CREATE POLICY proposals_insert ON mifracc.proposals FOR INSERT
  WITH CHECK (colonia_id = mifracc.my_colonia_id());

-- votes / proposal_documents (RLS por join a proposals)
ALTER TABLE mifracc.votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mifracc.proposal_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY votes_rw ON mifracc.votes FOR ALL
  USING (EXISTS (SELECT 1 FROM mifracc.proposals p WHERE p.id = proposal_id AND p.colonia_id = mifracc.my_colonia_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM mifracc.proposals p WHERE p.id = proposal_id AND p.colonia_id = mifracc.my_colonia_id()));
CREATE POLICY propdocs_read ON mifracc.proposal_documents FOR SELECT
  USING (EXISTS (SELECT 1 FROM mifracc.proposals p WHERE p.id = proposal_id AND p.colonia_id = mifracc.my_colonia_id()));
CREATE POLICY propdocs_write ON mifracc.proposal_documents FOR ALL
  USING (EXISTS (SELECT 1 FROM mifracc.proposals p WHERE p.id = proposal_id AND p.colonia_id = mifracc.my_colonia_id() AND mifracc.is_admin()))
  WITH CHECK (EXISTS (SELECT 1 FROM mifracc.proposals p WHERE p.id = proposal_id AND p.colonia_id = mifracc.my_colonia_id() AND mifracc.is_admin()));

-- ÍNDICES
CREATE INDEX idx_sos_colonia    ON mifracc.sos_events(colonia_id, is_active);
CREATE INDEX idx_sos_zone       ON mifracc.sos_events(zone_id);
CREATE INDEX idx_alerts_colonia ON mifracc.alerts(colonia_id, status);
CREATE INDEX idx_cam_colonia    ON mifracc.cameras(colonia_id);
CREATE INDEX idx_camev_colonia  ON mifracc.camera_events(colonia_id, detected_at);
CREATE INDEX idx_prop_colonia   ON mifracc.proposals(colonia_id, estado);
CREATE INDEX idx_votes_prop     ON mifracc.votes(proposal_id);

GRANT ALL ON ALL TABLES IN SCHEMA mifracc TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA mifracc TO anon, authenticated, service_role;
