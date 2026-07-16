-- 075 — Verificación PÚBLICA del QR de las tarjetas PVC
-- Cualquier teléfono que escanee el QR de una tarjeta (residente /r/<id> o
-- visita frecuente /vf/<id>) llega a una página pública. Sin sesión solo se
-- responde VIGENTE/NO VÁLIDA + nombre de la colonia — CERO datos personales
-- (los checks completos siguen gateados a guardia/comité: migr. 052-053).

CREATE OR REPLACE FUNCTION vecino.verificar_tarjeta_publico(p_clase text, p_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = vecino, public AS $$
DECLARE
  v_valida  boolean;
  v_colonia text;
BEGIN
  IF p_clase = 'r' THEN
    SELECT (p.is_active AND p.approval_status = 'aprobado'), c.nombre
      INTO v_valida, v_colonia
      FROM vecino.profiles p JOIN vecino.colonias c ON c.id = p.colonia_id
     WHERE p.id = p_id;
  ELSIF p_clase = 'vf' THEN
    SELECT (r.estado IN ('impresa','entregada')), c.nombre
      INTO v_valida, v_colonia
      FROM vecino.card_requests r JOIN vecino.colonias c ON c.id = r.colonia_id
     WHERE r.id = p_id AND r.tipo = 'visita';
  ELSE
    RAISE EXCEPTION 'Clase de tarjeta desconocida.';
  END IF;

  IF v_colonia IS NULL THEN
    RETURN jsonb_build_object('valida', false, 'colonia', NULL);
  END IF;
  RETURN jsonb_build_object('valida', coalesce(v_valida, false), 'colonia', v_colonia);
END $$;

GRANT EXECUTE ON FUNCTION vecino.verificar_tarjeta_publico(text, uuid) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
