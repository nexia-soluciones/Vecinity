-- =============================================================================
-- VECINITY · 048 — Postularse como vecino vigilante desde Caty
-- schema: vecino · Supabase self-hosted Nexia
--
-- El botón de la app quedó en 046; faltaba el camino Telegram (donde vive la
-- mayoría). Mismo patrón: wrapper por chat_id que impersona y llama al RPC real.
-- =============================================================================

CREATE OR REPLACE FUNCTION vecino.bot_postular_vigilante(p_token text, p_chat text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE p vecino.profiles%ROWTYPE;
BEGIN
  p := vecino._bot_perfil(p_token, p_chat);
  PERFORM vecino._bot_como(p.id);
  RETURN vecino.postular_vigilante();
END $$;

GRANT EXECUTE ON FUNCTION vecino.bot_postular_vigilante(text,text) TO anon, service_role;

NOTIFY pgrst, 'reload schema';
