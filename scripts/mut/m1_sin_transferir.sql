-- MUTACIÓN 1 — telegram_link_consumir vuelve a la conducta de antes de 095:
-- si el chat es de otro perfil, se niega en vez de transferir.
CREATE OR REPLACE FUNCTION vecino.telegram_link_consumir(p_token text, p_chat text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'vecino' AS $mut$
DECLARE t vecino.telegram_link_tokens%ROWTYPE; v_nombre text;
BEGIN
  SELECT * INTO t FROM vecino.telegram_link_tokens WHERE token = lower(btrim(p_token)) FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'motivo', 'invalido'); END IF;
  IF t.estado <> 'vivo' THEN RETURN jsonb_build_object('ok', false, 'motivo', 'usado'); END IF;
  IF t.expires_at <= now() THEN
    UPDATE vecino.telegram_link_tokens SET estado='expirado' WHERE token=t.token;
    RETURN jsonb_build_object('ok', false, 'motivo', 'expirado'); END IF;
  IF EXISTS (SELECT 1 FROM vecino.profiles WHERE telegram_chat_id = p_chat AND id <> t.profile_id) THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'ocupado');
  END IF;
  SELECT nombre INTO v_nombre FROM vecino.profiles WHERE id = t.profile_id;
  UPDATE vecino.profiles SET telegram_chat_id = p_chat WHERE id = t.profile_id;
  UPDATE vecino.telegram_link_tokens SET estado='usado', usado_at=now(), usado_chat=p_chat WHERE token=t.token;
  RETURN jsonb_build_object('ok', true, 'nombre', v_nombre, 'antes', NULL);
END $mut$;
