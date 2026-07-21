-- 089 — Reimprimir REEMPLAZA la tarjeta física: mata la anterior, asigna la siguiente
-- Bug real (casa 161, placa W06BGK, 2026-07-21): print_reprint (071) solo movía
-- printed_at y el stock. La tarjeta vieja (14840479) seguía 'asignada' en el
-- inventario, seguía en vehicles.tarjeta_rfid y seguía ACTIVA y enrolada en el
-- DS-K2812 → abría la pluma. La tarjeta nueva que sale de la impresora
-- (la de arriba del paquete) no quedaba registrada → no abría. Al revés.
--
-- Regla: una reimpresión gasta una tarjeta física distinta, así que gasta un
-- serial distinto. El viejo se da de BAJA (no 'suspendido': una baja nunca se
-- reactiva por la regla de mora) y el nuevo entra sin enrolar para que el
-- reconcile de la Orin lo dé de alta en el panel.

-- ══ 0. Estado 'baja' en el enum de tags ═════════════════════════════════
-- OJO al replicar: Postgres NO permite usar un valor de enum recién creado
-- en la MISMA transacción. Si se aplica el archivo completo de un jalón, el
-- ALTER pasa (solo se usa dentro de cuerpos de función, que se evalúan en
-- ejecución), pero cualquier UPDATE ... = 'baja' debe ir en otra tanda.
ALTER TYPE vecino.tag_status ADD VALUE IF NOT EXISTS 'baja';

-- ══ 1. El inventario admite el estado 'reemplazada' ═════════════════════
ALTER TABLE vecino.card_inventory DROP CONSTRAINT IF EXISTS card_inventory_estado_check;
ALTER TABLE vecino.card_inventory ADD CONSTRAINT card_inventory_estado_check
  CHECK (estado = ANY (ARRAY['disponible','asignada','danada','reemplazada']));

-- Con la reimpresión, un job puede tener varias filas de inventario
-- (las reemplazadas + la vigente). Quien busque "el serial del job" debe
-- filtrar estado='asignada' — hay UNA sola vigente por job.
CREATE UNIQUE INDEX IF NOT EXISTS card_inventory_job_vigente
  ON vecino.card_inventory (print_job_id) WHERE estado = 'asignada';

-- ══ 2. print_reprint v2 ═════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION vecino.print_reprint(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, public AS $$
DECLARE
  j vecino.print_jobs%ROWTYPE;
  r vecino.card_requests%ROWTYPE;
  v_total integer;
  v_new_id uuid; v_new text;
  v_old_id uuid; v_old text;
BEGIN
  SELECT * INTO j FROM vecino.print_jobs WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job inexistente.'; END IF;
  IF j.estado <> 'impresa' THEN RAISE EXCEPTION 'Solo se reimprime un job ya impreso.'; END IF;

  -- Ya entregada y firmada: la evidencia quedó ligada al serial viejo. Para
  -- reponerla se re-encola (job nuevo → firma nueva), no se reimprime encima.
  IF EXISTS (SELECT 1 FROM vecino.card_deliveries WHERE print_job_id = p_id) THEN
    RAISE EXCEPTION 'Esta tarjeta ya se entregó firmada. Usa "Re-encolar" para reponerla: la nueva necesita su propia firma.';
  END IF;

  SELECT count(*) INTO v_total FROM vecino.card_inventory WHERE colonia_id = j.colonia_id;

  IF v_total > 0 THEN
    -- La tarjeta de arriba del paquete es la que acaba de imprimirse.
    SELECT id, serial INTO v_new_id, v_new FROM vecino.card_inventory
     WHERE colonia_id = j.colonia_id AND estado = 'disponible'
     ORDER BY orden LIMIT 1 FOR UPDATE SKIP LOCKED;
    IF v_new_id IS NULL THEN
      RAISE EXCEPTION 'No hay tarjetas físicas disponibles en el inventario de esta villa. Registra el lote antes de reimprimir.';
    END IF;

    -- Serial vigente del job: se reemplaza y su tag se da de baja.
    SELECT id, serial INTO v_old_id, v_old FROM vecino.card_inventory
     WHERE print_job_id = p_id AND estado = 'asignada' LIMIT 1 FOR UPDATE;
    IF v_old_id IS NOT NULL THEN
      UPDATE vecino.card_inventory SET estado = 'reemplazada' WHERE id = v_old_id;
      UPDATE vecino.rfid_tags
         SET status = 'baja', motivo = 'reemplazo',
             suspended_at = now(), reactivated_at = NULL
       WHERE colonia_id = j.colonia_id AND codigo_tag = v_old AND status <> 'baja';
    END IF;

    UPDATE vecino.card_inventory
       SET estado = 'asignada', print_job_id = p_id,
           card_request_id = j.card_request_id, assigned_at = now()
     WHERE id = v_new_id;

    IF j.card_request_id IS NOT NULL THEN
      SELECT * INTO r FROM vecino.card_requests WHERE id = j.card_request_id;
      IF r.tipo = 'vehicular' AND r.vehicle_id IS NOT NULL THEN
        UPDATE vecino.vehicles SET tarjeta_rfid = v_new WHERE id = r.vehicle_id;
        -- enrolled_at NULL a propósito: el reconcile de la Orin la da de alta
        -- en el panel en su siguiente ciclo (sin alta, no abre).
        INSERT INTO vecino.rfid_tags (colonia_id, house_id, vehicle_id, codigo_tag, tipo, status)
        VALUES (j.colonia_id, r.house_id, r.vehicle_id, v_new, 'vehiculo', 'activo')
        ON CONFLICT (colonia_id, codigo_tag) DO UPDATE
          SET house_id = EXCLUDED.house_id, vehicle_id = EXCLUDED.vehicle_id,
              tipo = 'vehiculo', status = 'activo', motivo = NULL,
              enrolled_at = NULL, suspended_at = NULL, reactivated_at = NULL;
      END IF;
    END IF;
  END IF;

  UPDATE vecino.print_jobs SET printed_at = now() WHERE id = p_id;
  UPDATE vecino.colonias SET stock_tarjetas = greatest(0, stock_tarjetas - 1)
   WHERE id = j.colonia_id;

  RETURN jsonb_build_object('ok', true, 'serial', v_new, 'serial_anterior', v_old);
END $$;

REVOKE EXECUTE ON FUNCTION vecino.print_reprint(uuid) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION vecino.print_reprint(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
