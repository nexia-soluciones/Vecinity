-- ============================================================
-- VECINITY · 011 — Vehículos (alta/baja residente, aprobación comité)
-- schema: mifracc · Supabase self-hosted Nexia
--
-- Paridad del Django viejo (285 vehículos, catálogo 52 marcas / 351 modelos).
-- Residente da de alta (estado 'pendiente'); el comité aprueba/rechaza
-- (política admin directa) y puede asignar tarjeta RFID.
-- ============================================================

-- ------------------------------------------------------------
-- RPC: alta de vehículo (residente). Estado 'pendiente'.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mifracc.agregar_vehiculo(
  p_placa    text,
  p_brand_id uuid DEFAULT NULL,
  p_model_id uuid DEFAULT NULL,
  p_color    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
DECLARE
  v_house_id   uuid := mifracc.my_house_id();
  v_colonia_id uuid := mifracc.my_colonia_id();
  v_placa      text := upper(btrim(coalesce(p_placa,'')));
  v_id         uuid;
BEGIN
  IF v_house_id IS NULL THEN
    RAISE EXCEPTION 'Tu perfil no está ligado a una casa todavía.';
  END IF;
  IF v_placa = '' THEN
    RAISE EXCEPTION 'Escribe la placa del vehículo.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM mifracc.vehicles
    WHERE colonia_id = v_colonia_id AND upper(placa) = v_placa
  ) THEN
    RAISE EXCEPTION 'Ya existe un vehículo con la placa % en tu colonia.', v_placa;
  END IF;

  INSERT INTO mifracc.vehicles
    (colonia_id, house_id, brand_id, model_id, placa, color, estado)
  VALUES
    (v_colonia_id, v_house_id, p_brand_id, p_model_id, v_placa, nullif(btrim(p_color),''), 'pendiente')
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

-- ------------------------------------------------------------
-- RPC: baja de vehículo propio (no si ya está aprobado).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mifracc.eliminar_vehiculo(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
DECLARE v mifracc.vehicles%ROWTYPE;
BEGIN
  SELECT * INTO v FROM mifracc.vehicles WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'El vehículo no existe.'; END IF;
  IF v.house_id <> mifracc.my_house_id() THEN
    RAISE EXCEPTION 'Solo puedes dar de baja vehículos de tu casa.';
  END IF;
  IF v.estado = 'aprobado' THEN
    RAISE EXCEPTION 'El vehículo ya está aprobado. Pide al comité darlo de baja.';
  END IF;
  DELETE FROM mifracc.vehicles WHERE id = p_id;
  RETURN jsonb_build_object('ok', true);
END $$;

GRANT EXECUTE ON FUNCTION mifracc.agregar_vehiculo(text,uuid,uuid,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION mifracc.eliminar_vehiculo(uuid)               TO authenticated, service_role;
