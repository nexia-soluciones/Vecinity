-- MUTACIÓN 2 — levantar_multa deja de delegar en resolver_incidencia y marca el
-- expediente por su cuenta. Es la tentación obvia: "total, es un UPDATE".
CREATE OR REPLACE FUNCTION vecino.levantar_multa(
  p_infractor uuid, p_categoria uuid, p_monto numeric,
  p_descripcion text DEFAULT NULL, p_evidencia_url text DEFAULT NULL, p_nota text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'vecino', 'auth' AS $mut$
DECLARE v_rep jsonb; v_id uuid;
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité puede levantar una multa.'; END IF;
  IF nullif(btrim(coalesce(p_descripcion,'')),'') IS NULL THEN
    RAISE EXCEPTION 'Escribe qué pasó: la multa se le va a cobrar a una casa y tiene que poder explicarse.'; END IF;
  v_rep := vecino.reportar_incidencia(p_infractor, p_categoria, p_descripcion, p_evidencia_url, NULL, NULL);
  v_id  := (v_rep->>'id')::uuid;
  UPDATE vecino.incident_reports
     SET origen='comite', estado='multa', monto_multa=p_monto,
         resolucion_admin=p_nota, resolved_at=now(), resolved_by=auth.uid()
   WHERE id = v_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'transaction_id', NULL);
END $mut$;
