-- 086_face_enroll_error_amigable.sql
-- =============================================================================
-- Nueva acción 'error' en face_mark para cuando la terminal NO pudo enrolar la
-- foto (rostro no detectado / baja calidad — Hikvision FDLib statusCode 6). Antes
-- la Orin sólo tiraba el error crudo a Telegram del comité y el rostro se quedaba
-- "Aprobada · por activar" para siempre. Ahora:
--   · el registro regresa a 'rechazada' con un motivo amigable (la app ya lo
--     muestra al vecino con "toma otra foto y vuelve a enviarla"), y
--   · Caty le avisa por Telegram (si tiene chat ligado) que mejore la foto.
--
-- La Orin debe llamar: face_mark(<token>, <id>, 'error')  (o con motivo propio)
-- al recibir un statusCode de calidad de rostro, en vez de sólo alertar al comité.
-- =============================================================================

CREATE OR REPLACE FUNCTION vecino.face_mark(
  p_token text,
  p_id uuid,
  p_action text,
  p_motivo text DEFAULT 'mora'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'vecino', 'public'
AS $function$
DECLARE
  v_rows   int := 0;
  v_motivo text;
  r_face   record;
  rec      record;
  v_casa   text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vecino.bot_config WHERE token = p_token) THEN
    RAISE EXCEPTION 'token invalido';
  END IF;

  IF p_action = 'enroll' THEN
    UPDATE vecino.face_enrollments
       SET status = 'enrolada', enrolled_at = now()
     WHERE id = p_id AND status = 'aprobada';
    GET DIAGNOSTICS v_rows = ROW_COUNT;

  ELSIF p_action = 'remove' THEN
    UPDATE vecino.face_enrollments
       SET terminal_removed_at = now()
     WHERE id = p_id AND status = 'retirada';
    GET DIAGNOSTICS v_rows = ROW_COUNT;

  ELSIF p_action = 'error' THEN
    -- La terminal no reconoció el rostro (statusCode 6 u otra falla de calidad).
    -- Se regresa a 'rechazada' con motivo amigable para que el vecino re-tome la foto.
    v_motivo := CASE
      WHEN p_motivo IS NULL OR btrim(p_motivo) IN ('', 'mora')
        THEN 'No se pudo reconocer el rostro en la foto. Toma otra de frente, con buena luz, sin gorra ni lentes oscuros, y vuelve a enviarla.'
      ELSE p_motivo
    END;
    UPDATE vecino.face_enrollments
       SET status = 'rechazada', motivo = v_motivo
     WHERE id = p_id AND status IN ('aprobada', 'enrolada')
    RETURNING * INTO r_face;
    GET DIAGNOSTICS v_rows = ROW_COUNT;

    -- Aviso de Caty por Telegram a los vecinos de la casa con chat ligado.
    IF v_rows > 0 THEN
      SELECT numero INTO v_casa FROM vecino.houses WHERE id = r_face.house_id;
      FOR rec IN
        SELECT telegram_chat_id FROM vecino.profiles
         WHERE house_id = r_face.house_id AND telegram_chat_id IS NOT NULL
        UNION
        SELECT p.telegram_chat_id FROM vecino.house_members hm
          JOIN vecino.profiles p ON p.id = hm.profile_id
         WHERE hm.house_id = r_face.house_id AND p.telegram_chat_id IS NOT NULL
      LOOP
        PERFORM vecino.tg_send(rec.telegram_chat_id,
          format('Hola 👋 La foto de %s (Casa %s) no se pudo activar en la puerta porque no se reconocio bien el rostro. Toma otra de frente, con buena luz y sin gorra ni lentes oscuros, y vuelvela a enviar desde la app. — Caty',
                 r_face.nombre, v_casa));
      END LOOP;
    END IF;

  ELSE
    RAISE EXCEPTION 'accion invalida: %', p_action;
  END IF;

  RETURN jsonb_build_object('updated', v_rows);
END $function$;
