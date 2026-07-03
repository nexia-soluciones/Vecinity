-- =============================================================================
-- 042_corregir_infractor.sql — Corregir la casa infractora de una incidencia
-- =============================================================================
-- Juan (2026-07-02): a veces el vecino reporta la casa equivocada; el comité
-- debe poder corregir el número de casa infractora ANTES de multar/rechazar.
-- Solo mientras la incidencia siga 'pendiente' (una vez multada ya generó cargo
-- y resolución oficial → no se toca por esta vía).
-- =============================================================================

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
  IF v_estado <> 'pendiente' THEN
    RAISE EXCEPTION 'Solo se puede corregir mientras está pendiente (esta ya está %).', v_estado;
  END IF;

  SELECT id INTO v_house FROM vecino.houses
   WHERE colonia_id = v_col AND numero = btrim(p_numero);
  IF v_house IS NULL THEN
    RAISE EXCEPTION 'No existe la casa % en tu colonia.', btrim(p_numero);
  END IF;

  UPDATE vecino.incident_reports SET infractor_house_id = v_house WHERE id = p_id;
  RETURN jsonb_build_object('ok', true, 'numero', btrim(p_numero));
END $$;
GRANT EXECUTE ON FUNCTION vecino.corregir_casa_infractora(uuid,text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
