-- =============================================================================
-- 043_incidencia_sin_casa.sql — Reportar con evidencia SIN saber la casa
-- =============================================================================
-- Juan (2026-07-03): a veces hay evidencia (foto de un carro mal estacionado,
-- basura, etc.) pero el vecino NO sabe qué casa es. Se permite reportar sin casa
-- infractora; queda en estado 'sin_identificar' → el comité la identifica luego
-- con la evidencia (y usa "cambiar casa" de la migr. 042, que la pasa a pendiente).
--
-- NOTA: el valor de enum 'sin_identificar' se agregó en una llamada previa
-- (ALTER TYPE ... ADD VALUE no puede ir en la misma tx que su primer uso).
-- =============================================================================

-- La casa infractora deja de ser obligatoria (puede llegar sin identificar)
ALTER TABLE vecino.incident_reports ALTER COLUMN infractor_house_id DROP NOT NULL;

-- --- RPC: reportar sin casa (solo evidencia) --------------------------------
-- Requiere evidencia (foto): sin casa Y sin foto no hay nada que revisar.
CREATE OR REPLACE FUNCTION vecino.reportar_incidencia_sin_casa(
  p_categoria    uuid,
  p_descripcion  text DEFAULT NULL,
  p_evidencia_url text DEFAULT NULL,
  p_lat          numeric DEFAULT NULL,
  p_lng          numeric DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE v_col uuid := vecino.my_colonia_id(); v_id uuid;
BEGIN
  IF v_col IS NULL THEN RAISE EXCEPTION 'Tu perfil no está ligado a una colonia.'; END IF;
  IF p_evidencia_url IS NULL OR btrim(p_evidencia_url) = '' THEN
    RAISE EXCEPTION 'Sin casa identificada necesitas adjuntar una foto de evidencia.';
  END IF;

  INSERT INTO vecino.incident_reports
    (colonia_id, reportante_house_id, infractor_house_id, categoria_id, descripcion,
     evidencia_url, evidencia_capturada_at, evidencia_lat, evidencia_lng, estado)
  VALUES
    (v_col, vecino.my_house_id(), NULL, p_categoria, nullif(btrim(p_descripcion),''),
     p_evidencia_url, now(), p_lat, p_lng, 'sin_identificar')
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;
GRANT EXECUTE ON FUNCTION vecino.reportar_incidencia_sin_casa(uuid,text,text,numeric,numeric) TO authenticated, service_role;

-- --- corregir_casa_infractora: ahora también identifica los 'sin_identificar' -
-- Al asignar la casa, si venía 'sin_identificar' pasa a 'pendiente' (entra al
-- flujo normal de multar/rechazar). Si ya era 'pendiente', solo reasigna.
CREATE OR REPLACE FUNCTION vecino.corregir_casa_infractora(p_id uuid, p_numero text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE
  v_col   uuid := vecino.my_colonia_id();
  v_house uuid;
  v_estado text;
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;
  IF coalesce(btrim(p_numero),'') = '' THEN RAISE EXCEPTION 'Escribe el número de casa.'; END IF;

  SELECT estado INTO v_estado FROM vecino.incident_reports
   WHERE id = p_id AND colonia_id = v_col;
  IF v_estado IS NULL THEN RAISE EXCEPTION 'Incidencia no encontrada.'; END IF;
  IF v_estado NOT IN ('pendiente','sin_identificar') THEN
    RAISE EXCEPTION 'Solo se puede corregir mientras está pendiente o sin identificar (esta ya está %).', v_estado;
  END IF;

  SELECT id INTO v_house FROM vecino.houses
   WHERE colonia_id = v_col AND numero = btrim(p_numero);
  IF v_house IS NULL THEN
    RAISE EXCEPTION 'No existe la casa % en tu colonia.', btrim(p_numero);
  END IF;

  UPDATE vecino.incident_reports
     SET infractor_house_id = v_house,
         estado = CASE WHEN estado = 'sin_identificar' THEN 'pendiente'::vecino.incident_status ELSE estado END
   WHERE id = p_id;
  RETURN jsonb_build_object('ok', true, 'numero', btrim(p_numero));
END $$;
GRANT EXECUTE ON FUNCTION vecino.corregir_casa_infractora(uuid,text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
