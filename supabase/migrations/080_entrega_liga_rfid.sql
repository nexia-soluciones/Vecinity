-- 080 — La entrega liga la tarjeta física al RFID de la puerta
-- Las ~92 vehiculares de la campaña vieja se imprimieron sin registrar qué
-- número (serial RFID) trae cada quien. En la ENTREGA la tarjeta está en la
-- mano: el comité captura el número impreso y ahí se liga a
-- vehicles.tarjeta_rfid + rfid_tags (lo mismo que hace la impresión nueva).
-- Para tarjetas impresas por el sistema, el serial ya está en card_inventory
-- y la entrega solo lo confirma.

ALTER TABLE vecino.card_deliveries
  ADD COLUMN IF NOT EXISTS serial text;

-- Param nuevo con DEFAULT = sobrecarga ambigua → DROP de la firma anterior.
DROP FUNCTION IF EXISTS vecino.entregar_tarjeta_firmada(uuid, text, text, text);

CREATE OR REPLACE FUNCTION vecino.entregar_tarjeta_firmada(
  p_job uuid, p_firmante text, p_firma_b64 text,
  p_ine_path text DEFAULT NULL, p_serial text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, public AS $$
DECLARE
  j vecino.print_jobs%ROWTYPE;
  r vecino.card_requests%ROWTYPE;
  v_at timestamptz;
  v_serial text := nullif(trim(coalesce(p_serial, '')), '');
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité puede entregar tarjetas.'; END IF;
  IF coalesce(trim(p_firmante), '') = '' THEN RAISE EXCEPTION 'Falta el nombre de quien recibe.'; END IF;
  IF coalesce(p_firma_b64, '') = '' THEN RAISE EXCEPTION 'Falta la firma.'; END IF;
  IF length(p_firma_b64) > 500000 THEN RAISE EXCEPTION 'La firma es demasiado pesada.'; END IF;

  SELECT * INTO j FROM vecino.print_jobs
   WHERE id = p_job AND colonia_id = vecino.my_colonia_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tarjeta inexistente o de otra colonia.'; END IF;
  IF j.estado <> 'impresa' THEN RAISE EXCEPTION 'Solo se entrega una tarjeta ya impresa.'; END IF;

  -- Si el sistema ya asignó serial al imprimir, ese manda (el capturado solo
  -- aplica a tarjetas históricas sin serial registrado).
  SELECT COALESCE(
    (SELECT serial FROM vecino.card_inventory WHERE print_job_id = p_job LIMIT 1),
    v_serial) INTO v_serial;

  INSERT INTO vecino.card_deliveries
    (print_job_id, card_request_id, colonia_id, firmante, firma_b64, ine_path, serial, delivered_by)
  VALUES (p_job, j.card_request_id, j.colonia_id, trim(p_firmante), p_firma_b64,
          nullif(trim(coalesce(p_ine_path, '')), ''), v_serial,
          auth.uid())  -- vecino.profiles.id = auth.uid() en este schema
  RETURNING delivered_at INTO v_at;

  IF j.card_request_id IS NOT NULL THEN
    SELECT * INTO r FROM vecino.card_requests WHERE id = j.card_request_id;
    UPDATE vecino.card_requests SET estado = 'entregada', delivered_at = v_at
     WHERE id = j.card_request_id AND estado IN ('en_cola','impresa');

    -- Liga RFID (solo vehicular con serial conocido): igual que la impresión nueva.
    IF v_serial IS NOT NULL AND r.tipo = 'vehicular' AND r.vehicle_id IS NOT NULL THEN
      UPDATE vecino.vehicles SET tarjeta_rfid = v_serial WHERE id = r.vehicle_id;
      INSERT INTO vecino.rfid_tags (colonia_id, house_id, vehicle_id, codigo_tag, tipo, status)
      VALUES (j.colonia_id, r.house_id, r.vehicle_id, v_serial, 'vehiculo', 'activo')
      ON CONFLICT (colonia_id, codigo_tag) DO UPDATE
        SET house_id = EXCLUDED.house_id, vehicle_id = EXCLUDED.vehicle_id, tipo = 'vehiculo';
    END IF;
  END IF;
  RETURN jsonb_build_object('ok', true, 'delivered_at', v_at, 'serial', v_serial);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'Esa tarjeta ya tiene entrega firmada.';
END $$;

GRANT EXECUTE ON FUNCTION vecino.entregar_tarjeta_firmada(uuid, text, text, text, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
