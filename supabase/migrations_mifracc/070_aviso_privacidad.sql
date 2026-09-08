-- 070: Aviso de Privacidad por colonia — con registro de aceptación (LFPDPPP)
--
-- Multi-tenant: cada colonia publica su aviso (versionado); al entrar a la app,
-- el usuario ve el modal hasta que acepte ("Aceptar ahora"). "Aceptar después"
-- solo pospone (vuelve a aparecer en la siguiente sesión). La aceptación queda
-- registrada con usuario, versión y fecha — y el comité ve el avance.
--
-- Publicar una versión NUEVA (activo=true, version+1) vuelve a pedir aceptación
-- a todos: el status busca aceptación de LA versión activa.
--
-- NOTA (mifracc): la sección 6 original (siembra del Aviso de Privacidad
-- Integral REAL de Villa Catania, texto legal LFPDPPP citado textual) se
-- movió a _excluidos/070_datos_reales.sql — mifracc solo debe sembrarse con
-- datos sintéticos/demo. El resto del archivo (tablas, RLS, RPCs) no depende
-- de esa siembra.

-- 1. Avisos ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mifracc.privacy_notices (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  version    int  NOT NULL DEFAULT 1,
  titulo     text NOT NULL,
  contenido  text NOT NULL,           -- markdown ligero (## secciones)
  activo     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (colonia_id, version)
);
-- Un solo aviso activo por colonia
CREATE UNIQUE INDEX IF NOT EXISTS idx_privacy_notices_activo
  ON mifracc.privacy_notices (colonia_id) WHERE activo;

ALTER TABLE mifracc.privacy_notices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS privacy_notices_select ON mifracc.privacy_notices;
CREATE POLICY privacy_notices_select ON mifracc.privacy_notices
  FOR SELECT USING (
    colonia_id IN (SELECT colonia_id FROM mifracc.profiles WHERE id = auth.uid())
  );

-- 2. Aceptaciones -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mifracc.privacy_acceptances (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_id   uuid NOT NULL REFERENCES mifracc.privacy_notices(id) ON DELETE CASCADE,
  profile_id  uuid NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (notice_id, profile_id)
);
ALTER TABLE mifracc.privacy_acceptances ENABLE ROW LEVEL SECURITY;
-- Lectura: la propia, o admin/comité de la colonia. Escritura: solo RPC.
DROP POLICY IF EXISTS privacy_acceptances_select ON mifracc.privacy_acceptances;
CREATE POLICY privacy_acceptances_select ON mifracc.privacy_acceptances
  FOR SELECT USING (
    profile_id = auth.uid()
    OR EXISTS (SELECT 1 FROM mifracc.profiles p
               JOIN mifracc.privacy_notices n ON n.id = notice_id
               WHERE p.id = auth.uid() AND p.role IN ('admin','comite')
                 AND p.colonia_id = n.colonia_id)
  );

-- 3. RPC: ¿tengo un aviso pendiente? ------------------------------------------------
CREATE OR REPLACE FUNCTION mifracc.privacy_status()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = mifracc, public AS $$
DECLARE n record;
BEGIN
  SELECT pn.id, pn.titulo, pn.contenido, pn.version INTO n
  FROM mifracc.privacy_notices pn
  JOIN mifracc.profiles p ON p.colonia_id = pn.colonia_id
  WHERE p.id = auth.uid()
    AND p.approval_status = 'aprobado'
    AND pn.activo
    AND NOT EXISTS (SELECT 1 FROM mifracc.privacy_acceptances a
                    WHERE a.notice_id = pn.id AND a.profile_id = auth.uid());
  IF NOT FOUND THEN
    RETURN jsonb_build_object('pendiente', false);
  END IF;
  RETURN jsonb_build_object('pendiente', true, 'id', n.id,
    'titulo', n.titulo, 'contenido', n.contenido, 'version', n.version);
END $$;

-- 4. RPC: aceptar ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mifracc.privacy_accept(p_notice_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = mifracc, public AS $$
BEGIN
  IF NOT EXISTS (
      SELECT 1 FROM mifracc.privacy_notices n
      JOIN mifracc.profiles p ON p.colonia_id = n.colonia_id
      WHERE n.id = p_notice_id AND n.activo AND p.id = auth.uid()) THEN
    RAISE EXCEPTION 'Aviso no encontrado para tu colonia.';
  END IF;
  INSERT INTO mifracc.privacy_acceptances (notice_id, profile_id)
  VALUES (p_notice_id, auth.uid())
  ON CONFLICT (notice_id, profile_id) DO NOTHING;
  RETURN jsonb_build_object('ok', true);
END $$;

-- 5. RPC: avance para el comité --------------------------------------------------------
CREATE OR REPLACE FUNCTION mifracc.privacy_report()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = mifracc, public AS $$
DECLARE v_col uuid; v_notice record;
BEGIN
  SELECT colonia_id INTO v_col FROM mifracc.profiles
   WHERE id = auth.uid() AND role IN ('admin','comite') AND approval_status = 'aprobado';
  IF v_col IS NULL THEN
    RAISE EXCEPTION 'Solo el comité puede ver el avance del aviso de privacidad.';
  END IF;
  SELECT id, version, titulo INTO v_notice
  FROM mifracc.privacy_notices WHERE colonia_id = v_col AND activo;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('hay_aviso', false);
  END IF;
  RETURN jsonb_build_object(
    'hay_aviso', true, 'version', v_notice.version, 'titulo', v_notice.titulo,
    'aceptados', (SELECT count(*) FROM mifracc.privacy_acceptances
                  WHERE notice_id = v_notice.id),
    'total', (SELECT count(*) FROM mifracc.profiles
              WHERE colonia_id = v_col AND approval_status = 'aprobado'),
    'lista', COALESCE((
      SELECT jsonb_agg(to_jsonb(x)) FROM (
        SELECT p.nombre, h.numero AS casa, a.accepted_at
        FROM mifracc.privacy_acceptances a
        JOIN mifracc.profiles p ON p.id = a.profile_id
        LEFT JOIN mifracc.houses h ON h.id = p.house_id
        WHERE a.notice_id = v_notice.id
        ORDER BY a.accepted_at DESC
      ) x), '[]'::jsonb));
END $$;

GRANT EXECUTE ON FUNCTION mifracc.privacy_status() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION mifracc.privacy_accept(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION mifracc.privacy_report() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
