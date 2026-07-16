-- 077 — Gestión de VISITAS RECURRENTES desde el dashboard de vigilancia
-- El guardia no puede leer card_requests (RLS: casa propia o comité), así que
-- el módulo usa RPCs is_guard()-gated: listar las tarjetas de visita de su
-- colonia, corregir el nombre del titular y revocar (borrar) una tarjeta.

-- Listar tarjetas de visita frecuente de la colonia del guardia.
CREATE OR REPLACE FUNCTION vecino.vf_listar()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE v jsonb;
BEGIN
  IF NOT vecino.is_guard() THEN RAISE EXCEPTION 'Solo el personal de vigilancia.'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', r.id,
      'nombre', r.beneficiario_nombre,
      'casa', h.numero,
      'estado', r.estado,
      'created_at', r.created_at,
      'adentro', EXISTS (SELECT 1 FROM vecino.visitors vi
                          WHERE vi.card_request_id = r.id AND vi.estado = 'adentro')
    ) ORDER BY r.beneficiario_nombre), '[]'::jsonb)
    INTO v
  FROM vecino.card_requests r
  LEFT JOIN vecino.houses h ON h.id = r.house_id
  WHERE r.tipo = 'visita'
    AND r.colonia_id = vecino.my_colonia_id()
    AND r.estado IN ('solicitada','en_cola','impresa','entregada');
  RETURN v;
END $$;

-- Corregir el nombre del titular de la tarjeta.
CREATE OR REPLACE FUNCTION vecino.vf_editar(p_card_id uuid, p_nombre text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE v_n integer;
BEGIN
  IF NOT vecino.is_guard() THEN RAISE EXCEPTION 'Solo el personal de vigilancia.'; END IF;
  IF coalesce(trim(p_nombre), '') = '' THEN RAISE EXCEPTION 'El nombre no puede quedar vacío.'; END IF;
  UPDATE vecino.card_requests
     SET beneficiario_nombre = trim(p_nombre)
   WHERE id = p_card_id AND tipo = 'visita' AND colonia_id = vecino.my_colonia_id();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RAISE EXCEPTION 'Tarjeta inexistente o de otra colonia.'; END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- Revocar (borrar) la tarjeta: deja de ser válida al escanear y, si aún no se
-- imprimía, su trabajo pendiente se cancela para no gastar tarjeta física.
CREATE OR REPLACE FUNCTION vecino.vf_revocar(p_card_id uuid, p_motivo text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE v_n integer;
BEGIN
  IF NOT vecino.is_guard() THEN RAISE EXCEPTION 'Solo el personal de vigilancia.'; END IF;
  UPDATE vecino.card_requests
     SET estado = 'cancelada',
         motivo_rechazo = left(coalesce(nullif(trim(p_motivo), ''), 'Revocada por vigilancia'), 300)
   WHERE id = p_card_id AND tipo = 'visita'
     AND colonia_id = vecino.my_colonia_id() AND estado <> 'cancelada';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RAISE EXCEPTION 'Tarjeta inexistente, de otra colonia o ya revocada.'; END IF;
  UPDATE vecino.print_jobs
     SET estado = 'error', error = 'Tarjeta revocada por vigilancia — no imprimir'
   WHERE card_request_id = p_card_id AND estado = 'pendiente';
  RETURN jsonb_build_object('ok', true);
END $$;

GRANT EXECUTE ON FUNCTION vecino.vf_listar() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.vf_editar(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.vf_revocar(uuid, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
