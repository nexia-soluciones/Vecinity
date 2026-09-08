-- ============================================================
-- VECINITY · 023 — Evidencia confiable de multas (hora + geo)
-- schema: mifracc · Supabase self-hosted Nexia
--
-- Objetivo: para el reporte de multas asistido con IA necesitamos hora y
-- lugar CONFIABLES de la evidencia. No dependemos del EXIF de la foto
-- (los navegadores lo borran y se puede falsificar): la app fuerza la
-- cámara y la HORA la sella el servidor (now()) al crear el reporte.
-- La geolocalización (opcional, con permiso) la manda el cliente.
-- ============================================================

ALTER TABLE mifracc.incident_reports
  ADD COLUMN IF NOT EXISTS evidencia_capturada_at timestamptz,
  ADD COLUMN IF NOT EXISTS evidencia_lat numeric,
  ADD COLUMN IF NOT EXISTS evidencia_lng numeric;

-- Reemplaza la firma anterior (4 args) por una con geo. DROP explícito para
-- no dejar dos overloads.
DROP FUNCTION IF EXISTS mifracc.reportar_incidencia(uuid, uuid, text, text);

CREATE OR REPLACE FUNCTION mifracc.reportar_incidencia(
  p_infractor     uuid,
  p_categoria     uuid,
  p_descripcion   text    DEFAULT NULL,
  p_evidencia_url text    DEFAULT NULL,
  p_lat           numeric DEFAULT NULL,
  p_lng           numeric DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
DECLARE
  v_col uuid := mifracc.my_colonia_id();
  v_id  uuid;
BEGIN
  IF v_col IS NULL THEN RAISE EXCEPTION 'Tu perfil no está ligado a una colonia.'; END IF;
  IF p_infractor IS NULL THEN RAISE EXCEPTION 'Indica la casa infractora (número o placa).'; END IF;
  IF NOT EXISTS (SELECT 1 FROM mifracc.houses WHERE id = p_infractor AND colonia_id = v_col) THEN
    RAISE EXCEPTION 'La casa infractora no pertenece a tu colonia.';
  END IF;

  INSERT INTO mifracc.incident_reports
    (colonia_id, reportante_house_id, infractor_house_id, categoria_id, descripcion,
     evidencia_url, evidencia_capturada_at, evidencia_lat, evidencia_lng, estado)
  VALUES
    (v_col, mifracc.my_house_id(), p_infractor, p_categoria, nullif(btrim(p_descripcion),''),
     p_evidencia_url,
     CASE WHEN p_evidencia_url IS NOT NULL THEN now() ELSE NULL END,  -- hora sellada por el servidor
     p_lat, p_lng, 'pendiente')
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

GRANT EXECUTE ON FUNCTION mifracc.reportar_incidencia(uuid,uuid,text,text,numeric,numeric)
  TO authenticated, service_role;
