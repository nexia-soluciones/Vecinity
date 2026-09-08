-- =============================================================================
-- VECINITY · 048 — Postularse como vecino vigilante desde Caty
-- schema: mifracc · Supabase self-hosted Nexia
--
-- El botón de la app quedó en 046; faltaba el camino Telegram (donde vive la
-- mayoría). Mismo patrón: wrapper por chat_id que impersona y llama al RPC real.
-- =============================================================================

CREATE OR REPLACE FUNCTION mifracc.bot_postular_vigilante(p_token text, p_chat text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
DECLARE p mifracc.profiles%ROWTYPE;
BEGIN
  p := mifracc._bot_perfil(p_token, p_chat);
  PERFORM mifracc._bot_como(p.id);
  RETURN mifracc.postular_vigilante();
END $$;

GRANT EXECUTE ON FUNCTION mifracc.bot_postular_vigilante(text,text) TO anon, service_role;

NOTIFY pgrst, 'reload schema';
