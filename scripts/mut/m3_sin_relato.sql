-- MUTACIÓN 3 — se quita la exigencia de escribir qué pasó.
CREATE OR REPLACE FUNCTION vecino.levantar_multa(
  p_infractor uuid, p_categoria uuid, p_monto numeric,
  p_descripcion text DEFAULT NULL, p_evidencia_url text DEFAULT NULL, p_nota text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'vecino', 'auth' AS $mut$
DECLARE v_col uuid := vecino.my_colonia_id(); v_rep jsonb; v_id uuid; v_res jsonb;
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité puede levantar una multa.'; END IF;
  IF p_categoria IS NULL THEN RAISE EXCEPTION 'Elige la categoría de la falta.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vecino.fine_categories WHERE id=p_categoria AND colonia_id=v_col) THEN
    RAISE EXCEPTION 'Esa categoría no es de tu colonia.'; END IF;
  v_rep := vecino.reportar_incidencia(p_infractor, p_categoria, p_descripcion, p_evidencia_url, NULL, NULL);
  v_id  := (v_rep->>'id')::uuid;
  UPDATE vecino.incident_reports SET origen='comite' WHERE id=v_id;
  v_res := vecino.resolver_incidencia(v_id, 'multar', p_monto, p_nota);
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'transaction_id', v_res->>'transaction_id');
END $mut$;
