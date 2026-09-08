-- 032_fix_telegram_plain.sql — tg_send a texto plano (evita errores de Markdown)
-- =============================================================================
-- parse_mode 'Markdown' falla (HTTP 400 "can't parse entities") si el texto trae
-- un `*`, `_`, `[` sin balancear — y el contenido que escribe el comité en un
-- comunicado puede traer cualquier cosa. Se quita parse_mode → texto plano, que
-- nunca falla. También se limpian los marcadores del mensaje de comunicado.
-- =============================================================================

CREATE OR REPLACE FUNCTION mifracc.tg_send(p_chat text, p_text text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF p_chat IS NULL THEN RETURN; END IF;
  PERFORM net.http_post(
    url := 'https://api.telegram.org/bot8632144143:AAGlCGKlI9eU31dK2bFIpzldTiDX8CGKKWE/sendMessage',
    body := jsonb_build_object('chat_id', p_chat, 'text', p_text),
    headers := '{"Content-Type":"application/json"}'::jsonb
  );
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- crear_comunicado: mensaje de Telegram en texto plano (sin *,_).
CREATE OR REPLACE FUNCTION mifracc.crear_comunicado(
  p_house_id uuid,
  p_titulo text,
  p_mensaje text,
  p_autor text DEFAULT 'comite',
  p_verificado boolean DEFAULT false,
  p_tipo text DEFAULT 'aviso'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'mifracc', 'auth', 'net'
AS $$
DECLARE
  v_col   uuid := mifracc.my_colonia_id();
  v_id    uuid;
  v_msg   text;
  v_firma text;
  v_sent  int := 0;
  rec     record;
BEGIN
  IF NOT mifracc.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;
  IF coalesce(btrim(p_titulo),'')='' OR coalesce(btrim(p_mensaje),'')='' THEN
    RAISE EXCEPTION 'Título y mensaje son obligatorios.';
  END IF;
  IF p_house_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM mifracc.houses WHERE id=p_house_id AND colonia_id=v_col) THEN
    RAISE EXCEPTION 'La casa no es de tu colonia.';
  END IF;

  INSERT INTO mifracc.comunicados (colonia_id, house_id, titulo, mensaje, autor, verificado_comite, tipo, created_by)
  VALUES (v_col, p_house_id, btrim(p_titulo), btrim(p_mensaje),
          CASE WHEN p_autor='caty' THEN 'caty' ELSE 'comite' END,
          coalesce(p_verificado,false),
          CASE WHEN p_tipo IN ('aviso','discrepancia','cobro') THEN p_tipo ELSE 'aviso' END,
          auth.uid())
  RETURNING id INTO v_id;

  v_firma := CASE WHEN p_autor='caty'
    THEN (CASE WHEN p_verificado THEN '— Caty · revisado por el comité' ELSE '— Caty (asistente Vecinity)' END)
    ELSE '— Comité Villa Catania' END;
  v_msg := btrim(p_titulo) || E'\n\n' || btrim(p_mensaje) || E'\n\n' || v_firma;

  FOR rec IN
    SELECT p.telegram_chat_id FROM mifracc.profiles p
     WHERE p.colonia_id = v_col AND p.telegram_chat_id IS NOT NULL
       AND (p_house_id IS NULL OR p.house_id = p_house_id)
  LOOP
    PERFORM mifracc.tg_send(rec.telegram_chat_id, v_msg);
    v_sent := v_sent + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'id', v_id, 'telegram_enviados', v_sent);
END $$;
