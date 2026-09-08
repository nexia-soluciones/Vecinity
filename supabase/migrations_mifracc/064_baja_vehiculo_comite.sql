-- 064: Baja de vehículos por el comité — cualquier casa, cualquier estado.
-- Cierra el camino que eliminar_vehiculo prometía ("pide al comité darlo de baja")
-- pero nunca existió. Borrado definitivo (decisión del Director 2026-07-13).

CREATE OR REPLACE FUNCTION mifracc.baja_vehiculo_comite(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
DECLARE
  v mifracc.vehicles%ROWTYPE;
  v_casa text;
  v_tags_activos int;
BEGIN
  IF NOT mifracc.is_admin() THEN
    RAISE EXCEPTION 'Solo el comité puede dar de baja vehículos.';
  END IF;

  SELECT * INTO v FROM mifracc.vehicles WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'El vehículo no existe.'; END IF;

  SELECT numero INTO v_casa FROM mifracc.houses WHERE id = v.house_id;

  -- Defensivo: hoy ningún tag del panel está ligado a vehículos, pero si
  -- algún día lo está, avisamos (el FK es ON DELETE SET NULL — el tag
  -- seguiría activo en el panel y hay que suspenderlo desde el panel RFID).
  SELECT count(*) INTO v_tags_activos
  FROM mifracc.rfid_tags
  WHERE vehicle_id = p_id AND status = 'activo';

  DELETE FROM mifracc.vehicles WHERE id = p_id;

  RETURN jsonb_build_object(
    'ok', true,
    'placa', v.placa,
    'casa', v_casa,
    'aviso_rfid', CASE WHEN v_tags_activos > 0
      THEN v_tags_activos || ' tag(s) RFID activos quedaron sin vehículo — revisa el panel de acceso.'
      ELSE NULL END
  );
END $$;

GRANT EXECUTE ON FUNCTION mifracc.baja_vehiculo_comite(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
