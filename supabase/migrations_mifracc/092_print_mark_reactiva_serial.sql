-- 092 — print_mark_job reactiva el tag al asignar un serial reciclado
-- Caso real (2026-07-31): 4 tarjetas recuperadas de impresiones malas (serial
-- ilegible) se re-registraron como inventario disponible. Sus rfid_tags ya
-- existen con status='baja' y enrolled_at poblado. El ON CONFLICT de
-- print_mark_job (074) solo actualizaba house/vehicle/tipo → al imprimirse la
-- tarjeta quedaría revocada en el panel para siempre ("suena pero no abre").
-- Mismo bug que la 089 arregló en print_reprint; aquí se replica el reset:
-- status='activo' + enrolled_at=NULL para que el reconcile de la Orin la
-- re-enrole en el DS-K2812.

CREATE OR REPLACE FUNCTION mifracc.print_mark_job(p_id uuid, p_ok boolean, p_error text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, public AS $$
DECLARE
  j mifracc.print_jobs%ROWTYPE;
  r mifracc.card_requests%ROWTYPE;
  v_inv uuid; v_serial text;
BEGIN
  SELECT * INTO j FROM mifracc.print_jobs WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job inexistente.'; END IF;
  IF j.estado <> 'imprimiendo' THEN RAISE EXCEPTION 'El job no está en impresión.'; END IF;

  IF p_ok THEN
    UPDATE mifracc.print_jobs SET estado = 'impresa', printed_at = now(), error = NULL
     WHERE id = p_id;
    UPDATE mifracc.colonias SET stock_tarjetas = greatest(0, stock_tarjetas - 1)
     WHERE id = j.colonia_id;
    IF j.card_request_id IS NOT NULL THEN
      UPDATE mifracc.card_requests SET estado = 'impresa'
       WHERE id = j.card_request_id AND estado = 'en_cola';
    END IF;

    -- Serial: la tarjeta de arriba del paquete es la que acaba de imprimirse.
    SELECT id, serial INTO v_inv, v_serial FROM mifracc.card_inventory
     WHERE colonia_id = j.colonia_id AND estado = 'disponible'
     ORDER BY orden LIMIT 1 FOR UPDATE SKIP LOCKED;
    IF v_inv IS NOT NULL THEN
      UPDATE mifracc.card_inventory
         SET estado = 'asignada', print_job_id = p_id,
             card_request_id = j.card_request_id, assigned_at = now()
       WHERE id = v_inv;
      IF j.card_request_id IS NOT NULL THEN
        SELECT * INTO r FROM mifracc.card_requests WHERE id = j.card_request_id;
        IF r.tipo = 'vehicular' AND r.vehicle_id IS NOT NULL THEN
          UPDATE mifracc.vehicles SET tarjeta_rfid = v_serial WHERE id = r.vehicle_id;
          -- enrolled_at NULL a propósito: si el serial es reciclado (tag en
          -- baja/enrolado), la Orin lo re-enrola en su siguiente ciclo.
          INSERT INTO mifracc.rfid_tags (colonia_id, house_id, vehicle_id, codigo_tag, tipo, status)
          VALUES (j.colonia_id, r.house_id, r.vehicle_id, v_serial, 'vehiculo', 'activo')
          ON CONFLICT (colonia_id, codigo_tag) DO UPDATE
            SET house_id = EXCLUDED.house_id, vehicle_id = EXCLUDED.vehicle_id,
                tipo = 'vehiculo', status = 'activo', motivo = NULL,
                enrolled_at = NULL, suspended_at = NULL, reactivated_at = NULL;
        END IF;
      END IF;
    END IF;
  ELSE
    UPDATE mifracc.print_jobs SET estado = 'error', error = left(coalesce(p_error,'error'), 500)
     WHERE id = p_id;
  END IF;
  RETURN jsonb_build_object('ok', true, 'serial', v_serial);
END $$;

REVOKE EXECUTE ON FUNCTION mifracc.print_mark_job(uuid,boolean,text) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION mifracc.print_mark_job(uuid,boolean,text) TO service_role;

NOTIFY pgrst, 'reload schema';
