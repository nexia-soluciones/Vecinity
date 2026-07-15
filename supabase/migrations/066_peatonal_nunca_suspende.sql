-- 066: la puerta peatonal NUNCA se suspende — ni por mora ni por override
--
-- Decisión del Director (2026-07-14): el acceso a pie a la vivienda no se
-- restringe aunque la casa sea morosa. La mora solo gobierna el acceso
-- VEHICULAR (tarjetas del DS-K2812). Un rostro solo sale de la terminal por
-- retiro administrativo (face_retire: la persona ya no vive ahí, etc.).
--
-- Se redefinen face_sync_plan (solo enroll + remove) y face_mark (rechaza
-- suspend/reactivate). El CHECK de status conserva 'suspendida' por
-- compatibilidad histórica, pero ya no hay camino que lo produzca.

CREATE OR REPLACE FUNCTION vecino.face_sync_plan(p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE v_plan jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vecino.bot_config WHERE token = p_token) THEN
    RAISE EXCEPTION 'token invalido';
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb) INTO v_plan FROM (
    -- ENROLAR: aprobada por el comité, aún no en la terminal
    SELECT f.id, f.enroll_no, f.nombre, 'enroll' AS action, NULL::text AS motivo,
           h.numero AS casa, h.saldo, f.photo_b64
    FROM vecino.face_enrollments f
    JOIN vecino.houses h ON h.id = f.house_id
    WHERE f.status = 'aprobada'
    UNION ALL
    -- BORRAR de la terminal: retirada que sí llegó a enrolarse
    SELECT f.id, f.enroll_no, f.nombre, 'remove', NULL, h.numero, h.saldo, NULL
    FROM vecino.face_enrollments f
    JOIN vecino.houses h ON h.id = f.house_id
    WHERE f.status = 'retirada'
      AND f.enrolled_at IS NOT NULL
      AND f.terminal_removed_at IS NULL
  ) x;
  RETURN v_plan;
END $$;

CREATE OR REPLACE FUNCTION vecino.face_mark(
  p_token text, p_id uuid, p_action text, p_motivo text DEFAULT 'mora')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE v_rows int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vecino.bot_config WHERE token = p_token) THEN
    RAISE EXCEPTION 'token invalido';
  END IF;
  IF p_action = 'enroll' THEN
    UPDATE vecino.face_enrollments
       SET status = 'enrolada', enrolled_at = now()
     WHERE id = p_id AND status = 'aprobada';
  ELSIF p_action = 'remove' THEN
    UPDATE vecino.face_enrollments
       SET terminal_removed_at = now()
     WHERE id = p_id AND status = 'retirada';
  ELSE
    -- suspend/reactivate ya no existen para la peatonal (regla: nunca se suspende)
    RAISE EXCEPTION 'accion invalida: %', p_action;
  END IF;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('updated', v_rows);
END $$;

NOTIFY pgrst, 'reload schema';
