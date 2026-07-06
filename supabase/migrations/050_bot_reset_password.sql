-- ============================================================================
-- 050 · Recuperación de contraseña vía Caty (Telegram)
-- ----------------------------------------------------------------------------
-- Caty necesita el email del vecino ligado para pedirle a GoTrue un enlace de
-- recuperación (admin/generate_link, server-side en n8n). Reutiliza _bot_perfil:
-- valida el token del bot + que el chat esté ligado a un perfil aprobado/activo.
-- No expone el email a nadie más: lo consume el nodo de n8n (server-side) para
-- construir el enlace token_hash → /reset-password.
-- ============================================================================

CREATE OR REPLACE FUNCTION vecino.bot_email(p_token text, p_chat text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE p vecino.profiles%ROWTYPE; v_email text;
BEGIN
  p := vecino._bot_perfil(p_token, p_chat);            -- valida token + liga
  SELECT email INTO v_email FROM auth.users WHERE id = p.id;
  IF v_email IS NULL OR v_email = '' THEN
    RETURN jsonb_build_object('ok', false, 'msg', 'sin_email');
  END IF;
  RETURN jsonb_build_object('ok', true, 'email', v_email, 'nombre', p.nombre);
END $$;

GRANT EXECUTE ON FUNCTION vecino.bot_email(text, text) TO anon, authenticated, service_role;
