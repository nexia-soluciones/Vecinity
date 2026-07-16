-- 083 — La edición del vigilante es sobre los proveedores RECURRENTES
-- (domésticos: limpieza, jardinería, etc.), NO sobre las tarjetas de visita.
-- 1) RPCs para que vigilancia corrija nombre/casa/tipo y dé de baja proveedores.
-- 2) Se retira la capacidad de editar/revocar tarjetas VF desde vigilancia
--    (vf_editar / vf_revocar quedan solo para service_role; vf_listar sigue).

CREATE OR REPLACE FUNCTION vecino.editar_proveedor(
  p_id uuid, p_nombre text, p_house_id uuid DEFAULT NULL, p_tipo text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE v_col uuid := vecino.my_colonia_id(); v_n integer;
BEGIN
  IF NOT vecino.is_guard() THEN RAISE EXCEPTION 'Solo el personal de vigilancia.'; END IF;
  IF coalesce(btrim(p_nombre), '') = '' THEN RAISE EXCEPTION 'El nombre no puede quedar vacío.'; END IF;
  IF p_house_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM vecino.houses WHERE id = p_house_id AND colonia_id = v_col) THEN
    RAISE EXCEPTION 'La casa no pertenece a tu colonia.';
  END IF;
  UPDATE vecino.service_providers
     SET nombre = btrim(p_nombre),
         house_id = COALESCE(p_house_id, house_id),
         tipo = COALESCE(nullif(btrim(coalesce(p_tipo, '')), ''), tipo)
   WHERE id = p_id AND colonia_id = v_col;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RAISE EXCEPTION 'Proveedor inexistente o de otra colonia.'; END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- Baja lógica: deja de aparecer en el tablero (activo=false); el historial de
-- entradas/salidas (external_services) se conserva.
CREATE OR REPLACE FUNCTION vecino.baja_proveedor(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE v_n integer;
BEGIN
  IF NOT vecino.is_guard() THEN RAISE EXCEPTION 'Solo el personal de vigilancia.'; END IF;
  UPDATE vecino.service_providers SET activo = false
   WHERE id = p_id AND colonia_id = vecino.my_colonia_id() AND activo;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RAISE EXCEPTION 'Proveedor inexistente, de otra colonia o ya dado de baja.'; END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

GRANT EXECUTE ON FUNCTION vecino.editar_proveedor(uuid, text, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.baja_proveedor(uuid) TO authenticated, service_role;

-- Tarjetas VF: el vigilante ya NO edita ni revoca (decisión 2026-07-16).
REVOKE EXECUTE ON FUNCTION vecino.vf_editar(uuid, text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION vecino.vf_revocar(uuid, text) FROM authenticated;

NOTIFY pgrst, 'reload schema';
