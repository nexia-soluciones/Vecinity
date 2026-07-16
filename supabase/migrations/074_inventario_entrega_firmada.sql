-- 074 — Inventario de tarjetas físicas (seriales RFID) + entrega firmada
--
-- 1) INVENTARIO: las tarjetas PVC llegan numeradas (serial RFID impreso). El
--    operador registra el LOTE respetando el orden físico del paquete (ej.
--    14840505 → 14840409: la primera en imprimirse es la de arriba, 14840505).
--    Al imprimirse cada tarjeta, print_mark_job asigna el siguiente serial
--    disponible y lo liga al job, a la solicitud, al vehículo
--    (vehicles.tarjeta_rfid) y al control de acceso (rfid_tags).
-- 2) ENTREGA FIRMADA: "entregada" deja de ser un dato suelto — el vecino firma
--    de recibido en el teléfono del comité y queda evidencia (firma + fecha
--    sellada por el servidor + quién entregó).

-- ══ 1. Inventario de seriales ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vecino.card_inventory (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id      uuid NOT NULL REFERENCES vecino.colonias(id),
  serial          text NOT NULL,
  orden           integer NOT NULL,   -- orden físico del paquete: se consume de menor a mayor
  estado          text NOT NULL DEFAULT 'disponible'
                  CHECK (estado IN ('disponible','asignada','danada')),
  print_job_id    uuid REFERENCES vecino.print_jobs(id),
  card_request_id uuid REFERENCES vecino.card_requests(id),
  assigned_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (colonia_id, serial)
);
CREATE INDEX IF NOT EXISTS card_inventory_next
  ON vecino.card_inventory (colonia_id, orden) WHERE estado = 'disponible';

ALTER TABLE vecino.card_inventory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS card_inventory_select ON vecino.card_inventory;
CREATE POLICY card_inventory_select ON vecino.card_inventory FOR SELECT
  USING (vecino.is_admin());
GRANT SELECT ON vecino.card_inventory TO authenticated, service_role;

-- Registrar un lote de seriales EN EL ORDEN FÍSICO del paquete (desde → hasta,
-- ascendente o descendente). El orden continúa después del último lote.
CREATE OR REPLACE FUNCTION vecino.print_registrar_lote(p_colonia uuid, p_desde bigint, p_hasta bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, public AS $$
DECLARE
  v_paso integer := CASE WHEN p_hasta >= p_desde THEN 1 ELSE -1 END;
  v_base integer;
  v_n integer;
  v_disp integer;
BEGIN
  IF p_desde IS NULL OR p_hasta IS NULL THEN RAISE EXCEPTION 'Falta el rango (desde/hasta).'; END IF;
  IF abs(p_hasta - p_desde) + 1 > 2000 THEN RAISE EXCEPTION 'Lote demasiado grande (máx 2000).'; END IF;

  SELECT COALESCE(max(orden), 0) INTO v_base FROM vecino.card_inventory WHERE colonia_id = p_colonia;

  INSERT INTO vecino.card_inventory (colonia_id, serial, orden)
  SELECT p_colonia, s::text, v_base + row_number() OVER ()
  FROM generate_series(p_desde, p_hasta, v_paso) s;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  SELECT count(*) INTO v_disp FROM vecino.card_inventory
   WHERE colonia_id = p_colonia AND estado = 'disponible';
  -- El contador simple de la colonia sigue siendo la referencia del stock.
  UPDATE vecino.colonias SET stock_tarjetas = v_disp WHERE id = p_colonia;

  RETURN jsonb_build_object('ok', true, 'agregadas', v_n, 'disponibles', v_disp);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'El lote se encima con seriales ya registrados en esta colonia.';
END $$;

-- Marcar una tarjeta física como dañada (atorada, mal impresa). Sin serial
-- explícito toma la SIGUIENTE disponible (la de arriba del paquete).
CREATE OR REPLACE FUNCTION vecino.print_marcar_danada(p_colonia uuid, p_serial text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, public AS $$
DECLARE
  v_id uuid; v_serial text; v_disp integer;
BEGIN
  SELECT id, serial INTO v_id, v_serial FROM vecino.card_inventory
   WHERE colonia_id = p_colonia AND estado = 'disponible'
     AND (p_serial IS NULL OR serial = p_serial)
   ORDER BY orden LIMIT 1 FOR UPDATE;
  IF v_id IS NULL THEN RAISE EXCEPTION 'No hay ese serial disponible en el inventario.'; END IF;
  UPDATE vecino.card_inventory SET estado = 'danada' WHERE id = v_id;
  SELECT count(*) INTO v_disp FROM vecino.card_inventory
   WHERE colonia_id = p_colonia AND estado = 'disponible';
  UPDATE vecino.colonias SET stock_tarjetas = v_disp WHERE id = p_colonia;
  RETURN jsonb_build_object('ok', true, 'serial', v_serial, 'disponibles', v_disp);
END $$;

-- ══ 2. Asignación de serial al imprimir ═════════════════════════════════
-- print_mark_job (v2): en éxito asigna el siguiente serial disponible de la
-- colonia (si hay inventario) y lo liga a job/solicitud/vehículo/rfid_tags.
CREATE OR REPLACE FUNCTION vecino.print_mark_job(p_id uuid, p_ok boolean, p_error text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, public AS $$
DECLARE
  j vecino.print_jobs%ROWTYPE;
  r vecino.card_requests%ROWTYPE;
  v_inv uuid; v_serial text;
BEGIN
  SELECT * INTO j FROM vecino.print_jobs WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job inexistente.'; END IF;
  IF j.estado <> 'imprimiendo' THEN RAISE EXCEPTION 'El job no está en impresión.'; END IF;

  IF p_ok THEN
    UPDATE vecino.print_jobs SET estado = 'impresa', printed_at = now(), error = NULL
     WHERE id = p_id;
    UPDATE vecino.colonias SET stock_tarjetas = greatest(0, stock_tarjetas - 1)
     WHERE id = j.colonia_id;
    IF j.card_request_id IS NOT NULL THEN
      UPDATE vecino.card_requests SET estado = 'impresa'
       WHERE id = j.card_request_id AND estado = 'en_cola';
    END IF;

    -- Serial: la tarjeta de arriba del paquete es la que acaba de imprimirse.
    SELECT id, serial INTO v_inv, v_serial FROM vecino.card_inventory
     WHERE colonia_id = j.colonia_id AND estado = 'disponible'
     ORDER BY orden LIMIT 1 FOR UPDATE SKIP LOCKED;
    IF v_inv IS NOT NULL THEN
      UPDATE vecino.card_inventory
         SET estado = 'asignada', print_job_id = p_id,
             card_request_id = j.card_request_id, assigned_at = now()
       WHERE id = v_inv;
      IF j.card_request_id IS NOT NULL THEN
        SELECT * INTO r FROM vecino.card_requests WHERE id = j.card_request_id;
        IF r.tipo = 'vehicular' AND r.vehicle_id IS NOT NULL THEN
          UPDATE vecino.vehicles SET tarjeta_rfid = v_serial WHERE id = r.vehicle_id;
          INSERT INTO vecino.rfid_tags (colonia_id, house_id, vehicle_id, codigo_tag, tipo, status)
          VALUES (j.colonia_id, r.house_id, r.vehicle_id, v_serial, 'vehiculo', 'activo')
          ON CONFLICT (colonia_id, codigo_tag) DO UPDATE
            SET house_id = EXCLUDED.house_id, vehicle_id = EXCLUDED.vehicle_id,
                tipo = 'vehiculo';
        END IF;
      END IF;
    END IF;
  ELSE
    UPDATE vecino.print_jobs SET estado = 'error', error = left(coalesce(p_error,'error'), 500)
     WHERE id = p_id;
  END IF;
  RETURN jsonb_build_object('ok', true, 'serial', v_serial);
END $$;

-- ══ 3. Entrega firmada ══════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vecino.card_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  print_job_id    uuid NOT NULL UNIQUE REFERENCES vecino.print_jobs(id),
  card_request_id uuid REFERENCES vecino.card_requests(id),
  colonia_id      uuid NOT NULL REFERENCES vecino.colonias(id),
  firmante        text NOT NULL,      -- quién recibe (lo escribe el comité delante del vecino)
  firma_b64       text NOT NULL,      -- PNG base64 de la firma — columna PESADA: las listas NO la seleccionan
  delivered_by    uuid REFERENCES vecino.profiles(id),
  delivered_at    timestamptz NOT NULL DEFAULT now()  -- fecha sellada por el SERVIDOR
);
ALTER TABLE vecino.card_deliveries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS card_deliveries_select ON vecino.card_deliveries;
CREATE POLICY card_deliveries_select ON vecino.card_deliveries FOR SELECT
  USING (vecino.is_admin());
GRANT SELECT ON vecino.card_deliveries TO authenticated, service_role;
-- Escritura SOLO vía RPC (sin policy de INSERT).

CREATE OR REPLACE FUNCTION vecino.entregar_tarjeta_firmada(
  p_job uuid, p_firmante text, p_firma_b64 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, public AS $$
DECLARE
  j vecino.print_jobs%ROWTYPE;
  v_at timestamptz;
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité puede entregar tarjetas.'; END IF;
  IF coalesce(trim(p_firmante), '') = '' THEN RAISE EXCEPTION 'Falta el nombre de quien recibe.'; END IF;
  IF coalesce(p_firma_b64, '') = '' THEN RAISE EXCEPTION 'Falta la firma.'; END IF;
  IF length(p_firma_b64) > 500000 THEN RAISE EXCEPTION 'La firma es demasiado pesada.'; END IF;

  SELECT * INTO j FROM vecino.print_jobs
   WHERE id = p_job AND colonia_id = vecino.my_colonia_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tarjeta inexistente o de otra colonia.'; END IF;
  IF j.estado <> 'impresa' THEN RAISE EXCEPTION 'Solo se entrega una tarjeta ya impresa.'; END IF;

  INSERT INTO vecino.card_deliveries
    (print_job_id, card_request_id, colonia_id, firmante, firma_b64, delivered_by)
  VALUES (p_job, j.card_request_id, j.colonia_id, trim(p_firmante), p_firma_b64,
          auth.uid())  -- vecino.profiles.id = auth.uid() en este schema
  RETURNING delivered_at INTO v_at;

  IF j.card_request_id IS NOT NULL THEN
    UPDATE vecino.card_requests SET estado = 'entregada', delivered_at = v_at
     WHERE id = j.card_request_id AND estado IN ('en_cola','impresa');
  END IF;
  RETURN jsonb_build_object('ok', true, 'delivered_at', v_at);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'Esa tarjeta ya tiene entrega firmada.';
END $$;

-- ══ Permisos ════════════════════════════════════════════════════════════
REVOKE EXECUTE ON FUNCTION vecino.print_registrar_lote(uuid,bigint,bigint) FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION vecino.print_marcar_danada(uuid,text) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION vecino.print_registrar_lote(uuid,bigint,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION vecino.print_marcar_danada(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION vecino.entregar_tarjeta_firmada(uuid,text,text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
