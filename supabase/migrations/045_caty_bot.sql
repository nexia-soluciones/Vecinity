-- =============================================================================
-- VECINITY · 045 — Superpoderes de Caty (bot Telegram)
-- schema: vecino · Supabase self-hosted Nexia
--
-- Caty pasa de solo ligar el chat a operar: reservas, pases de visita,
-- comprobantes por foto, dudas de saldo y reglamento, y escalación al comité.
--
-- Patrón de identidad: el chat_id lo manda Telegram (no falsificable) y cada
-- wrapper bot_* lo resuelve a un perfil. Para NO duplicar lógica, el wrapper
-- IMPERSONA al usuario (set_config de request.jwt.claims, local a la tx) y
-- llama al RPC real: umbral de saldo de reservas, candados anti-duplicado de
-- abonos y validación de casas del propietario aplican idénticos.
-- Gate extra: token de bot (los chat_id son semi-adivinables con la anon key).
-- =============================================================================

-- ------------------------------------------------------------
-- 1) Config del bot (fila única): token compartido con n8n + casa escalación
-- ------------------------------------------------------------
CREATE TABLE vecino.bot_config (
  id              boolean PRIMARY KEY DEFAULT true CHECK (id),
  token           text NOT NULL,
  casa_escalacion text NOT NULL DEFAULT '128',
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE vecino.bot_config ENABLE ROW LEVEL SECURITY;  -- sin policies: solo definer

INSERT INTO vecino.bot_config (token)
VALUES (replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-',''));

-- ------------------------------------------------------------
-- 2) Sesiones conversacionales (flujos multi-paso)
-- ------------------------------------------------------------
CREATE TABLE vecino.bot_sessions (
  chat_id    text PRIMARY KEY,
  step       text,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE vecino.bot_sessions ENABLE ROW LEVEL SECURITY;  -- sin policies: solo definer

-- ------------------------------------------------------------
-- 3) Helpers internos
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino._bot_check(p_token text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vecino.bot_config WHERE token = p_token) THEN
    RAISE EXCEPTION 'BOT_TOKEN_INVALIDO';
  END IF;
END $$;

-- Resuelve el perfil ligado al chat. Falla con NO_LIGADO si el chat no existe.
CREATE OR REPLACE FUNCTION vecino._bot_perfil(p_token text, p_chat text)
RETURNS vecino.profiles LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino AS $$
DECLARE p vecino.profiles%ROWTYPE;
BEGIN
  PERFORM vecino._bot_check(p_token);
  SELECT * INTO p FROM vecino.profiles
   WHERE telegram_chat_id = p_chat AND approval_status = 'aprobado' AND is_active
   LIMIT 1;
  IF p.id IS NULL THEN RAISE EXCEPTION 'NO_LIGADO'; END IF;
  RETURN p;
END $$;

-- Impersonar al usuario para que auth.uid() (y todo my_*) lo vea. Local a la tx.
CREATE OR REPLACE FUNCTION vecino._bot_como(p_profile uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  SELECT set_config('request.jwt.claims',
    json_build_object('sub', p_profile, 'role', 'authenticated')::text, true)
$$;

-- ------------------------------------------------------------
-- 4) Perfil + casas financieras (menú y selector de casa)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.bot_perfil(p_token text, p_chat text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE p vecino.profiles%ROWTYPE; v_casas jsonb;
BEGIN
  p := vecino._bot_perfil(p_token, p_chat);
  PERFORM vecino._bot_como(p.id);
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', h.id, 'numero', h.numero, 'saldo', h.saldo, 'estatus', h.estatus,
           'vivo', h.id = p.house_id) ORDER BY (h.id = p.house_id) DESC, h.numero), '[]'::jsonb)
    INTO v_casas
    FROM vecino.houses h
   WHERE h.id IN (SELECT vecino.my_finance_house_ids());
  RETURN jsonb_build_object('ok', true, 'profile_id', p.id, 'nombre', p.nombre,
    'role', p.role, 'colonia_id', p.colonia_id, 'house_id', p.house_id, 'casas', v_casas);
END $$;

-- ------------------------------------------------------------
-- 5) Reservas: catálogo, disponibilidad y creación
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.bot_areas(p_token text, p_chat text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE p vecino.profiles%ROWTYPE; v jsonb;
BEGIN
  p := vecino._bot_perfil(p_token, p_chat);
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'nombre', a.nombre, 'apertura', a.hora_apertura,
           'cierre', a.hora_cierre, 'min_h', a.duracion_min_horas,
           'max_h', a.duracion_max_horas, 'aforo', a.requiere_aforo,
           'max_personas', a.max_personas_casa, 'reglas', a.reglas)
           ORDER BY a.orden, a.nombre), '[]'::jsonb)
    INTO v
    FROM vecino.common_areas a
   WHERE a.colonia_id = p.colonia_id AND a.activa AND a.reservable;
  RETURN jsonb_build_object('ok', true, 'areas', v);
END $$;

CREATE OR REPLACE FUNCTION vecino.bot_disponibilidad(p_token text, p_chat text, p_area uuid, p_fecha date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE p vecino.profiles%ROWTYPE; v jsonb;
BEGIN
  p := vecino._bot_perfil(p_token, p_chat);
  PERFORM vecino._bot_como(p.id);
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'inicio', d.fecha_hora_inicio, 'fin', d.fecha_hora_fin)), '[]'::jsonb)
    INTO v FROM vecino.disponibilidad_area(p_area, p_fecha) d;
  RETURN jsonb_build_object('ok', true, 'ocupadas', v);
END $$;

CREATE OR REPLACE FUNCTION vecino.bot_crear_reserva(
  p_token text, p_chat text, p_area uuid,
  p_inicio timestamptz, p_fin timestamptz, p_personas int DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE p vecino.profiles%ROWTYPE;
BEGIN
  p := vecino._bot_perfil(p_token, p_chat);
  PERFORM vecino._bot_como(p.id);
  RETURN vecino.crear_reserva(p_area, p_inicio, p_fin, p_personas);
END $$;

-- ------------------------------------------------------------
-- 6) Visitas: pase con token (URL la arma el bot)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.bot_registrar_visita(
  p_token text, p_chat text, p_nombre text, p_fecha timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE p vecino.profiles%ROWTYPE;
BEGIN
  p := vecino._bot_perfil(p_token, p_chat);
  PERFORM vecino._bot_como(p.id);
  RETURN vecino.registrar_visita(p_nombre, p_fecha);
END $$;

-- ------------------------------------------------------------
-- 7) Abonos: registrar comprobante + OCR (mismos candados que la app)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.bot_registrar_abono(
  p_token text, p_chat text, p_monto numeric,
  p_url text DEFAULT NULL, p_hash text DEFAULT NULL, p_house uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE p vecino.profiles%ROWTYPE;
BEGIN
  p := vecino._bot_perfil(p_token, p_chat);
  PERFORM vecino._bot_como(p.id);
  RETURN vecino.registrar_abono(p_monto, p_url, 'Abono vía Caty', p_hash, p_house);
END $$;

CREATE OR REPLACE FUNCTION vecino.bot_set_abono_ocr(
  p_token text, p_chat text, p_id uuid, p_ocr jsonb, p_ref text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE p vecino.profiles%ROWTYPE;
BEGIN
  p := vecino._bot_perfil(p_token, p_chat);
  PERFORM vecino._bot_como(p.id);
  RETURN vecino.set_abono_ocr(p_id, p_ocr, p_ref);
END $$;

-- ------------------------------------------------------------
-- 8) Saldo amable: casa(s) + últimos movimientos (contexto para Haiku)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.bot_movimientos(p_token text, p_chat text, p_house uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE p vecino.profiles%ROWTYPE; v jsonb; v_casa record;
BEGIN
  p := vecino._bot_perfil(p_token, p_chat);
  PERFORM vecino._bot_como(p.id);
  IF p_house NOT IN (SELECT vecino.my_finance_house_ids()) THEN
    RAISE EXCEPTION 'Esa casa no es tuya.';
  END IF;
  SELECT numero, saldo, estatus INTO v_casa FROM vecino.houses WHERE id = p_house;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'tipo', t.tipo, 'monto', t.monto, 'concepto', t.concepto,
           'estado', t.estado,
           'fecha', to_char(t.created_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD'))
           ORDER BY t.created_at DESC), '[]'::jsonb)
    INTO v
    FROM (SELECT * FROM vecino.transactions
           WHERE house_id = p_house ORDER BY created_at DESC LIMIT 10) t;
  RETURN jsonb_build_object('ok', true, 'numero', v_casa.numero, 'saldo', v_casa.saldo,
    'estatus', v_casa.estatus, 'movimientos', v);
END $$;

-- ------------------------------------------------------------
-- 9) Reglamento: búsqueda full-text (spanish) con respaldo ILIKE
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_reglamento_fts ON vecino.reglamento
  USING gin (to_tsvector('spanish', coalesce(titulo,'') || ' ' || texto));

CREATE OR REPLACE FUNCTION vecino.bot_reglamento_buscar(p_token text, p_chat text, p_q text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE p vecino.profiles%ROWTYPE; v jsonb;
BEGIN
  p := vecino._bot_perfil(p_token, p_chat);
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'articulo', r.articulo, 'titulo', r.titulo,
           'texto', left(r.texto, 1400))), '[]'::jsonb)
    INTO v
    FROM (
      SELECT * FROM vecino.reglamento
       WHERE colonia_id = p.colonia_id AND activo
         AND to_tsvector('spanish', coalesce(titulo,'') || ' ' || texto)
             @@ plainto_tsquery('spanish', p_q)
       ORDER BY ts_rank(to_tsvector('spanish', coalesce(titulo,'') || ' ' || texto),
                        plainto_tsquery('spanish', p_q)) DESC
       LIMIT 6
    ) r;
  -- respaldo: sin match FTS, buscar palabras largas con ILIKE
  IF v = '[]'::jsonb THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'articulo', r.articulo, 'titulo', r.titulo,
             'texto', left(r.texto, 1400))), '[]'::jsonb)
      INTO v
      FROM (
        SELECT DISTINCT ON (rg.id) rg.* FROM vecino.reglamento rg,
               unnest(regexp_split_to_array(lower(p_q), '\s+')) w
         WHERE rg.colonia_id = p.colonia_id AND rg.activo
           AND length(w) > 3 AND (rg.texto ILIKE '%'||w||'%' OR rg.titulo ILIKE '%'||w||'%')
         LIMIT 6
      ) r;
  END IF;
  RETURN jsonb_build_object('ok', true, 'articulos', v);
END $$;

-- ------------------------------------------------------------
-- 10) Escalación: guarda registro y devuelve los chats del comité + casa 128
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.bot_escalar(p_token text, p_chat text, p_tema text, p_texto text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE p vecino.profiles%ROWTYPE; v_casa text; v_chats jsonb; v_msg text;
BEGIN
  p := vecino._bot_perfil(p_token, p_chat);
  SELECT numero INTO v_casa FROM vecino.houses WHERE id = p.house_id;
  v_msg := '🙋 ' || coalesce(p.nombre,'Vecino') ||
           coalesce(' (casa '||v_casa||')', ' (sin casa: propietario)') ||
           ' necesita ayuda con ' || coalesce(p_tema,'un tema') || ':' || E'\n' ||
           coalesce(p_texto,'');
  INSERT INTO vecino.notifications (colonia_id, house_id, tipo, mensaje, canal, estado_envio, enviado_at)
  VALUES (p.colonia_id, p.house_id, 'escalacion', v_msg, 'telegram', 'enviado', now());

  -- Destinatarios: comité/admin con Telegram + residentes de la casa de escalación
  SELECT coalesce(jsonb_agg(DISTINCT x.chat), '[]'::jsonb) INTO v_chats
  FROM (
    SELECT pr.telegram_chat_id AS chat FROM vecino.profiles pr
     WHERE pr.colonia_id = p.colonia_id AND pr.role IN ('admin','comite')
       AND pr.telegram_chat_id IS NOT NULL AND pr.telegram_chat_id <> p_chat
    UNION
    SELECT pr.telegram_chat_id FROM vecino.profiles pr
      JOIN vecino.houses h ON h.id = pr.house_id
      JOIN vecino.bot_config bc ON bc.casa_escalacion = h.numero
     WHERE pr.colonia_id = p.colonia_id
       AND pr.telegram_chat_id IS NOT NULL AND pr.telegram_chat_id <> p_chat
  ) x;
  RETURN jsonb_build_object('ok', true, 'mensaje', v_msg, 'chats', v_chats);
END $$;

-- ------------------------------------------------------------
-- 11) Sesiones (get/set/clear) — todo pasa por el token del bot
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.bot_session_get(p_token text, p_chat text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino AS $$
DECLARE s vecino.bot_sessions%ROWTYPE;
BEGIN
  PERFORM vecino._bot_check(p_token);
  SELECT * INTO s FROM vecino.bot_sessions WHERE chat_id = p_chat;
  IF s.chat_id IS NULL THEN RETURN jsonb_build_object('step', NULL, 'data', '{}'::jsonb); END IF;
  -- sesión de más de 2 horas se considera vencida
  IF s.updated_at < now() - interval '2 hours' THEN
    DELETE FROM vecino.bot_sessions WHERE chat_id = p_chat;
    RETURN jsonb_build_object('step', NULL, 'data', '{}'::jsonb);
  END IF;
  RETURN jsonb_build_object('step', s.step, 'data', s.data);
END $$;

CREATE OR REPLACE FUNCTION vecino.bot_session_set(p_token text, p_chat text, p_step text, p_data jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino AS $$
BEGIN
  PERFORM vecino._bot_check(p_token);
  IF p_step IS NULL THEN
    DELETE FROM vecino.bot_sessions WHERE chat_id = p_chat;
  ELSE
    INSERT INTO vecino.bot_sessions (chat_id, step, data, updated_at)
    VALUES (p_chat, p_step, coalesce(p_data,'{}'::jsonb), now())
    ON CONFLICT (chat_id) DO UPDATE SET step = excluded.step, data = excluded.data, updated_at = now();
  END IF;
END $$;

-- ------------------------------------------------------------
-- Permisos: solo EXECUTE de los bot_* para anon (gate real = token + chat)
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION vecino._bot_check(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION vecino._bot_perfil(text,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION vecino._bot_como(uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION vecino.bot_perfil(text,text) TO anon, service_role;
GRANT EXECUTE ON FUNCTION vecino.bot_areas(text,text) TO anon, service_role;
GRANT EXECUTE ON FUNCTION vecino.bot_disponibilidad(text,text,uuid,date) TO anon, service_role;
GRANT EXECUTE ON FUNCTION vecino.bot_crear_reserva(text,text,uuid,timestamptz,timestamptz,int) TO anon, service_role;
GRANT EXECUTE ON FUNCTION vecino.bot_registrar_visita(text,text,text,timestamptz) TO anon, service_role;
GRANT EXECUTE ON FUNCTION vecino.bot_registrar_abono(text,text,numeric,text,text,uuid) TO anon, service_role;
GRANT EXECUTE ON FUNCTION vecino.bot_set_abono_ocr(text,text,uuid,jsonb,text) TO anon, service_role;
GRANT EXECUTE ON FUNCTION vecino.bot_movimientos(text,text,uuid) TO anon, service_role;
GRANT EXECUTE ON FUNCTION vecino.bot_reglamento_buscar(text,text,text) TO anon, service_role;
GRANT EXECUTE ON FUNCTION vecino.bot_escalar(text,text,text,text) TO anon, service_role;
GRANT EXECUTE ON FUNCTION vecino.bot_session_get(text,text) TO anon, service_role;
GRANT EXECUTE ON FUNCTION vecino.bot_session_set(text,text,text,jsonb) TO anon, service_role;

NOTIFY pgrst, 'reload schema';
