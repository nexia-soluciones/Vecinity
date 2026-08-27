-- ============================================================
-- 095 — Enlace de Telegram con token de un solo uso
--       (Fase 2 que dejó pendiente 027 #5)
--
-- 027 #5 endureció link_telegram para que un chat ya ligado no se pudiera
-- secuestrar, y dejó anotado que el fix completo era "token de un solo uso
-- en el deep-link". Sin esa fase, el re-enlace simplemente NO EXISTÍA:
--
--   · el deep-link es vecino_<profile_id>: un id ESTABLE y reusable. Quien
--     lo tenga puede ligar su Telegram a esa cuenta cuando quiera. Endurecer
--     el destino no sirve de nada si la credencial no caduca.
--   · un teléfono ya ligado a OTRO perfil recibía NULL, y el bot lo traducía
--     a "tu enlace no es válido o expiró" — mentira: el enlace estaba bien,
--     el chat estaba ocupado. Y peor: la sesión seguía corriendo con la
--     identidad del OTRO perfil, sin que nadie se enterara.
--
-- Lo que costó (26-ago, Villa Aurora): el teléfono de un vecino real quedó
-- ligado a comite.demo (comité, SIN casa). Mandó su deep-link cinco veces y
-- las cinco le dijeron "enlace inválido". Al reservar la alberca, la BD
-- contestó el guard de ESE otro perfil —"tu perfil no está ligado a una
-- casa"— que llegó a Telegram como «Request failed with status code 400».
--
-- Ahora: la app pide un token (sesión autenticada, 15 min, UN solo uso) y el
-- bot lo canjea. Con esa prueba el teléfono SÍ puede cambiar de cuenta: se
-- libera el perfil anterior, se le dice al usuario a quién estaba ligado y
-- queda rastro de quién canjeó qué y cuándo. Deja de ser secuestro porque la
-- credencial caduca y muere al usarse.
--
-- La puerta vieja (link_telegram) sigue viva a propósito: hay deep-links
-- vecino_<uuid> en mensajes de Telegram y pestañas abiertas. Se retira en una
-- migración posterior, con evidencia de que nadie la usa.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- El invariante baja a la BD: un chat de Telegram no puede pertenecer a dos
-- perfiles. _bot_perfil resuelve el chat con `LIMIT 1` y SIN `ORDER BY`: con
-- un duplicado eso es una lotería silenciosa que elige a un humano. Verificado
-- antes de crearlo: 0 duplicados hoy.
-- ------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS profiles_telegram_chat_uniq
  ON vecino.profiles (telegram_chat_id)
  WHERE telegram_chat_id IS NOT NULL;

-- ------------------------------------------------------------
-- Tokens de enlace
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vecino.telegram_link_tokens (
  token       text PRIMARY KEY,
  profile_id  uuid        NOT NULL REFERENCES vecino.profiles(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  -- Lista cerrada a propósito: los únicos productores son las dos funciones
  -- de abajo. Si algún día nace un estado nuevo, se amplía AQUÍ y en ellas.
  estado      text        NOT NULL DEFAULT 'vivo'
              CHECK (estado IN ('vivo','usado','expirado','reemplazado')),
  usado_at    timestamptz,
  usado_chat  text
);

COMMENT ON TABLE vecino.telegram_link_tokens IS
  'Tokens de un solo uso para ligar un chat de Telegram a un perfil. Se emiten '
  'con sesión autenticada (telegram_link_token) y se canjean desde el bot '
  '(telegram_link_consumir). Nadie los lee directo: RLS sin políticas.';

CREATE INDEX IF NOT EXISTS telegram_link_tokens_perfil_idx
  ON vecino.telegram_link_tokens (profile_id, estado);

-- Sin políticas: sólo se tocan por SECURITY DEFINER. Un token legible es un
-- token robable.
ALTER TABLE vecino.telegram_link_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON vecino.telegram_link_tokens FROM anon, authenticated;

-- ------------------------------------------------------------
-- telegram_link_token() — la app pide el token del usuario en sesión
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.telegram_link_token()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'vecino', 'auth', 'extensions', 'public'
AS $$
DECLARE
  v_id  uuid := auth.uid();
  v_tok text;
BEGIN
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Necesitas iniciar sesión para conectar Telegram.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM vecino.profiles
     WHERE id = v_id AND is_active AND approval_status = 'aprobado'
  ) THEN
    RAISE EXCEPTION 'Tu cuenta todavía no está aprobada.';
  END IF;

  -- Un token vivo a la vez por perfil: pedir uno nuevo mata los anteriores,
  -- para que un link viejo que quedó en una pestaña no siga sirviendo.
  UPDATE vecino.telegram_link_tokens
     SET estado = 'reemplazado'
   WHERE profile_id = v_id AND estado = 'vivo';

  v_tok := encode(gen_random_bytes(16), 'hex');   -- 128 bits
  INSERT INTO vecino.telegram_link_tokens (token, profile_id, expires_at)
  VALUES (v_tok, v_id, now() + interval '15 minutes');

  RETURN v_tok;
END $$;

REVOKE ALL ON FUNCTION vecino.telegram_link_token() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vecino.telegram_link_token() TO authenticated, service_role;

-- ------------------------------------------------------------
-- telegram_link_consumir(token, chat) — el bot canjea el token
--
-- Devuelve SIEMPRE jsonb con el motivo, nunca NULL: un guard que devuelve
-- NULL obliga al que llama a inventarse la explicación, y ahí nació el
-- "tu enlace no es válido o expiró" que era falso.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.telegram_link_consumir(p_token text, p_chat text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'vecino'
AS $$
DECLARE
  t             vecino.telegram_link_tokens%ROWTYPE;
  v_nombre      text;
  v_prev_id     uuid;
  v_prev_nombre text;
BEGIN
  p_token := lower(btrim(coalesce(p_token, '')));
  p_chat  := btrim(coalesce(p_chat, ''));
  IF p_token = '' OR p_chat = '' THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'invalido');
  END IF;

  SELECT * INTO t FROM vecino.telegram_link_tokens
   WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'invalido');
  END IF;
  IF t.estado <> 'vivo' THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'usado');
  END IF;
  IF t.expires_at <= now() THEN
    UPDATE vecino.telegram_link_tokens SET estado = 'expirado' WHERE token = p_token;
    RETURN jsonb_build_object('ok', false, 'motivo', 'expirado');
  END IF;

  SELECT nombre INTO v_nombre FROM vecino.profiles
   WHERE id = t.profile_id AND is_active AND approval_status = 'aprobado';
  IF v_nombre IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'perfil');
  END IF;

  -- El teléfono manda: quien canjea un token vivo demostró tener sesión en esa
  -- cuenta hace minutos. Si el chat era de otro perfil se LIBERA y se DICE de
  -- quién era — transferir en silencio deja al anterior sin avisos y sin
  -- enterarse. El orden importa: primero se libera, luego se asigna, o el
  -- índice único rechaza la operación entera.
  SELECT id, nombre INTO v_prev_id, v_prev_nombre
    FROM vecino.profiles
   WHERE telegram_chat_id = p_chat AND id <> t.profile_id;

  IF v_prev_id IS NOT NULL THEN
    UPDATE vecino.profiles
       SET telegram_chat_id = NULL, updated_at = now()
     WHERE id = v_prev_id;
  END IF;

  UPDATE vecino.profiles
     SET telegram_chat_id = p_chat, updated_at = now()
   WHERE id = t.profile_id;

  UPDATE vecino.telegram_link_tokens
     SET estado = 'usado', usado_at = now(), usado_chat = p_chat
   WHERE token = p_token;

  RETURN jsonb_build_object(
    'ok', true, 'nombre', v_nombre, 'antes', v_prev_nombre
  );
END $$;

REVOKE ALL ON FUNCTION vecino.telegram_link_consumir(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vecino.telegram_link_consumir(text,text) TO anon, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
