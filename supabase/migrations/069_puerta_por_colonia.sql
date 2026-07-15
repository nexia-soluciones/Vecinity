-- 069: La puerta/cámara pertenece a UNA colonia — hardening del gate
--
-- Hueco detectado (2026-07-15): camera_state/door_commands eran globales; con
-- el gate ampliado de la 068 ("cualquier perfil aprobado"), un perfil aprobado
-- de CUALQUIER colonia (p.ej. cuentas demo) podía ver la cámara y abrir la
-- puerta física de Villa Catania. Ahora cada dispositivo declara su colonia y
-- el gate exige que el perfil sea de ESA colonia.
--
-- (Complemento operativo fuera de esta migración: rotar las contraseñas de
--  las cuentas demo publicadas en la bitácora.)

-- 1. El dispositivo declara su colonia -------------------------------------------
ALTER TABLE vecino.camera_state
  ADD COLUMN IF NOT EXISTS colonia_id uuid REFERENCES vecino.colonias(id);
UPDATE vecino.camera_state
   SET colonia_id = 'ce43b59c-529b-4960-8dd7-d975e43ac2fb'  -- Villa Catania
 WHERE camera = 'peatonal' AND colonia_id IS NULL;

-- 2. Gate por dispositivo: perfil aprobado Y de la colonia del dispositivo --------
DROP FUNCTION IF EXISTS vecino.is_door_operator();
CREATE OR REPLACE FUNCTION vecino.is_door_operator(p_device text DEFAULT 'peatonal')
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = vecino, auth AS $$
  SELECT EXISTS (
    SELECT 1 FROM vecino.profiles p
    JOIN vecino.camera_state cs ON cs.camera = p_device
    WHERE p.id = auth.uid()
      AND p.approval_status = 'aprobado'
      AND p.colonia_id = cs.colonia_id)
$$;
GRANT EXECUTE ON FUNCTION vecino.is_door_operator(text) TO authenticated, service_role;

-- 3. RPCs de la app: pasar el dispositivo al gate ----------------------------------
CREATE OR REPLACE FUNCTION vecino.door_open(p_door text DEFAULT 'peatonal')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE v_id uuid; v_pendiente int;
BEGIN
  IF NOT vecino.is_door_operator(p_door) THEN
    RAISE EXCEPTION 'PUERTA_COLONIA: Esta puerta no pertenece a tu colonia.';
  END IF;
  SELECT count(*) INTO v_pendiente FROM vecino.door_commands
   WHERE door = p_door AND result IS NULL AND expires_at > now();
  IF v_pendiente > 0 THEN
    RAISE EXCEPTION 'Ya hay una apertura en curso; espera unos segundos.';
  END IF;
  INSERT INTO vecino.door_commands (door, requested_by)
  VALUES (p_door, auth.uid())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

CREATE OR REPLACE FUNCTION vecino.camera_view(p_camera text DEFAULT 'peatonal')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE r record;
BEGIN
  IF NOT vecino.is_door_operator(p_camera) THEN
    RAISE EXCEPTION 'PUERTA_COLONIA: Esta cámara no pertenece a tu colonia.';
  END IF;
  UPDATE vecino.camera_state
     SET watch_until = now() + interval '20 seconds'
   WHERE camera = p_camera
  RETURNING frame_b64, frame_at INTO r;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cámara desconocida.'; END IF;
  RETURN jsonb_build_object(
    'frame_b64', r.frame_b64,
    'frame_at', r.frame_at,
    'fresh', r.frame_at IS NOT NULL AND r.frame_at > now() - interval '10 seconds');
END $$;

CREATE OR REPLACE FUNCTION vecino.door_status(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM vecino.door_commands WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Comando no encontrado.'; END IF;
  IF NOT vecino.is_door_operator(r.door) THEN
    RAISE EXCEPTION 'Sin permiso.';
  END IF;
  RETURN jsonb_build_object('result', r.result, 'error', r.error,
                            'executed_at', r.executed_at);
END $$;

-- 4. Bitácora: comité/guardia de la colonia del dispositivo ------------------------
CREATE OR REPLACE FUNCTION vecino.door_log(p_limit int DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
BEGIN
  IF NOT EXISTS (
      SELECT 1 FROM vecino.profiles p
      WHERE p.id = auth.uid()
        AND p.role IN ('admin','comite','guardia')
        AND p.approval_status = 'aprobado'
        AND p.colonia_id IN (SELECT colonia_id FROM vecino.camera_state)) THEN
    RAISE EXCEPTION 'Solo el comité y los guardias pueden ver la bitácora de la puerta.';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(to_jsonb(x)) FROM (
      SELECT d.requested_at, d.result, d.error,
             p.nombre AS nombre, p.role AS rol,
             h.numero AS casa
      FROM vecino.door_commands d
      LEFT JOIN vecino.profiles p ON p.id = d.requested_by
      LEFT JOIN vecino.houses h ON h.id = p.house_id
      ORDER BY d.requested_at DESC
      LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100)
    ) x
  ), '[]'::jsonb);
END $$;

-- 5. RLS de la bitácora directa: misma condición de colonia -------------------------
DROP POLICY IF EXISTS door_commands_select ON vecino.door_commands;
CREATE POLICY door_commands_select ON vecino.door_commands
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM vecino.profiles p
            WHERE p.id = auth.uid()
              AND p.role IN ('admin','comite','guardia')
              AND p.colonia_id IN (SELECT colonia_id FROM vecino.camera_state))
  );

NOTIFY pgrst, 'reload schema';
