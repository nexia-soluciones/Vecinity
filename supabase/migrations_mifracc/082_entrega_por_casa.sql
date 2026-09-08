-- 082 — Entrega POR CASA: una firma + un INE cubren todas las tarjetas
-- En la sesión de entrega el responsable de la casa recibe sus N tarjetas en
-- un solo acto: firma una vez, un INE, y cada tarjeta queda con su propio
-- registro de entrega (misma evidencia) y su serial ligado al RFID.
-- Atómica: si una tarjeta del lote falla, no se entrega ninguna.

CREATE OR REPLACE FUNCTION mifracc.entregar_tarjetas_firmadas(
  p_jobs uuid[], p_firmante text, p_firma_b64 text,
  p_ine_path text DEFAULT NULL, p_serials jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, public AS $$
DECLARE
  j mifracc.print_jobs%ROWTYPE;
  r mifracc.card_requests%ROWTYPE;
  v_job uuid;
  v_at timestamptz;
  v_serial text;
  v_n integer := 0;
BEGIN
  IF NOT mifracc.is_admin() THEN RAISE EXCEPTION 'Solo el comité puede entregar tarjetas.'; END IF;
  IF coalesce(array_length(p_jobs, 1), 0) = 0 THEN RAISE EXCEPTION 'Sin tarjetas que entregar.'; END IF;
  IF array_length(p_jobs, 1) > 20 THEN RAISE EXCEPTION 'Demasiadas tarjetas en un solo acto (máx 20).'; END IF;
  IF coalesce(trim(p_firmante), '') = '' THEN RAISE EXCEPTION 'Falta el nombre de quien recibe.'; END IF;
  IF coalesce(p_firma_b64, '') = '' THEN RAISE EXCEPTION 'Falta la firma.'; END IF;
  IF length(p_firma_b64) > 500000 THEN RAISE EXCEPTION 'La firma es demasiado pesada.'; END IF;

  FOREACH v_job IN ARRAY p_jobs LOOP
    SELECT * INTO j FROM mifracc.print_jobs
     WHERE id = v_job AND colonia_id = mifracc.my_colonia_id() FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Una tarjeta del lote no existe o es de otra colonia.'; END IF;
    IF j.estado <> 'impresa' THEN RAISE EXCEPTION 'Una tarjeta del lote no está impresa (estado: %).', j.estado; END IF;

    -- Serial: el asignado al imprimir manda; si no, el confirmado en la entrega.
    SELECT COALESCE(
      (SELECT serial FROM mifracc.card_inventory WHERE print_job_id = v_job LIMIT 1),
      nullif(trim(coalesce(p_serials ->> v_job::text, '')), '')) INTO v_serial;

    INSERT INTO mifracc.card_deliveries
      (print_job_id, card_request_id, colonia_id, firmante, firma_b64, ine_path, serial, delivered_by)
    VALUES (v_job, j.card_request_id, j.colonia_id, trim(p_firmante), p_firma_b64,
            nullif(trim(coalesce(p_ine_path, '')), ''), v_serial, auth.uid())
    RETURNING delivered_at INTO v_at;

    IF j.card_request_id IS NOT NULL THEN
      SELECT * INTO r FROM mifracc.card_requests WHERE id = j.card_request_id;
      UPDATE mifracc.card_requests SET estado = 'entregada', delivered_at = v_at
       WHERE id = j.card_request_id AND estado IN ('en_cola','impresa');

      IF v_serial IS NOT NULL AND r.tipo = 'vehicular' AND r.vehicle_id IS NOT NULL THEN
        UPDATE mifracc.vehicles SET tarjeta_rfid = v_serial WHERE id = r.vehicle_id;
        INSERT INTO mifracc.rfid_tags (colonia_id, house_id, vehicle_id, codigo_tag, tipo, status)
        VALUES (j.colonia_id, r.house_id, r.vehicle_id, v_serial, 'vehiculo', 'activo')
        ON CONFLICT (colonia_id, codigo_tag) DO UPDATE
          SET house_id = EXCLUDED.house_id, vehicle_id = EXCLUDED.vehicle_id, tipo = 'vehiculo';
      END IF;
    END IF;
    v_n := v_n + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'entregadas', v_n, 'delivered_at', v_at);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'Una tarjeta del lote ya tiene entrega firmada.';
END $$;

GRANT EXECUTE ON FUNCTION mifracc.entregar_tarjetas_firmadas(uuid[], text, text, text, jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
