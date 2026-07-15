-- 067: Puerta peatonal desde la app — apertura remota + cámara casi-en-vivo
--
-- Dos piezas, mismo patrón outbound del access-bridge (la Orin pregunta):
--   · vecino.door_commands  — cola de aperturas CON TTL de 30s + bitácora.
--     La app (admin/comité/guardia) inserta vía door_open(); la Orin las toma
--     con bridge_fast_poll() (loop rápido ~2s) y las marca con door_mark().
--     Un comando expirado JAMÁS se ejecuta: si la Orin estuvo caída, al volver
--     lo marca 'expirado' — la puerta nunca abre minutos después del tap.
--   · vecino.camera_state   — singleton por cámara con el último frame JPEG
--     (b64). La app llama camera_view() ~1/s: renueva watch_until y recibe el
--     frame; la Orin solo bombea frames mientras watch_until > now() (si nadie
--     mira, no hay tráfico). El frame NUNCA se lee por SELECT directo.

-- 1. Cola de comandos de puerta --------------------------------------------------
CREATE TABLE IF NOT EXISTS vecino.door_commands (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  door         text NOT NULL DEFAULT 'peatonal' CHECK (door IN ('peatonal')),
  action       text NOT NULL DEFAULT 'open' CHECK (action IN ('open')),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '30 seconds',
  taken_at     timestamptz,
  executed_at  timestamptz,
  result       text CHECK (result IN ('ok','error','expirado')),
  error        text
);
CREATE INDEX IF NOT EXISTS idx_door_commands_pending
  ON vecino.door_commands (requested_at) WHERE result IS NULL;

ALTER TABLE vecino.door_commands ENABLE ROW LEVEL SECURITY;
-- Bitácora visible para quienes pueden operar la puerta; escrituras solo por RPC.
DROP POLICY IF EXISTS door_commands_select ON vecino.door_commands;
CREATE POLICY door_commands_select ON vecino.door_commands
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM vecino.profiles
            WHERE id = auth.uid() AND role IN ('admin','comite','guardia'))
  );

-- 2. Estado de cámara (singleton por cámara) -------------------------------------
CREATE TABLE IF NOT EXISTS vecino.camera_state (
  camera      text PRIMARY KEY CHECK (camera IN ('peatonal')),
  watch_until timestamptz,
  frame_b64   text,
  frame_at    timestamptz
);
INSERT INTO vecino.camera_state (camera) VALUES ('peatonal')
ON CONFLICT (camera) DO NOTHING;

ALTER TABLE vecino.camera_state ENABLE ROW LEVEL SECURITY;
-- Sin policies: nadie lee/escribe directo — solo camera_view()/camera_push().

-- 3. Helper de rol operador de puerta ---------------------------------------------
CREATE OR REPLACE FUNCTION vecino.is_door_operator()
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = vecino, auth AS $$
  SELECT EXISTS (SELECT 1 FROM vecino.profiles
                 WHERE id = auth.uid()
                   AND role IN ('admin','comite','guardia')
                   AND approval_status = 'aprobado')
$$;

-- 4. RPC app: pedir apertura -------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.door_open(p_door text DEFAULT 'peatonal')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE v_id uuid; v_pendiente int;
BEGIN
  IF NOT vecino.is_door_operator() THEN
    RAISE EXCEPTION 'Solo comité y vigilantes pueden abrir la puerta desde la app.';
  END IF;
  -- Anti doble-tap: si ya hay un comando vivo sin ejecutar, no apilar otro
  SELECT count(*) INTO v_pendiente FROM vecino.door_commands
   WHERE door = p_door AND result IS NULL AND expires_at > now();
  IF v_pendiente > 0 THEN
    RAISE EXCEPTION 'Ya hay una apertura en curso; espera unos segundos.';
  END IF;
  INSERT INTO vecino.door_commands (door, requested_by)
  VALUES (p_door, auth.uid())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

-- 5. RPC app: estado de un comando (para el feedback del botón) ---------------------
CREATE OR REPLACE FUNCTION vecino.door_status(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE r record;
BEGIN
  IF NOT vecino.is_door_operator() THEN
    RAISE EXCEPTION 'Sin permiso.';
  END IF;
  SELECT * INTO r FROM vecino.door_commands WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Comando no encontrado.'; END IF;
  RETURN jsonb_build_object('result', r.result, 'error', r.error,
                            'executed_at', r.executed_at);
END $$;

-- 6. RPC app: ver cámara (renueva watch y devuelve el último frame) ------------------
CREATE OR REPLACE FUNCTION vecino.camera_view(p_camera text DEFAULT 'peatonal')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE r record;
BEGIN
  IF NOT vecino.is_door_operator() THEN
    RAISE EXCEPTION 'Solo comité y vigilantes pueden ver la cámara.';
  END IF;
  UPDATE vecino.camera_state
     SET watch_until = now() + interval '20 seconds'
   WHERE camera = p_camera
  RETURNING frame_b64, frame_at INTO r;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cámara desconocida.'; END IF;
  RETURN jsonb_build_object(
    'frame_b64', r.frame_b64,
    'frame_at', r.frame_at,
    -- fresco = la Orin está bombeando (frame de <10s)
    'fresh', r.frame_at IS NOT NULL AND r.frame_at > now() - interval '10 seconds');
END $$;

-- 7. RPC Orin: poll rápido (comandos vivos + ¿alguien mira?) -------------------------
--    Toma los comandos atómicamente (taken_at) y marca 'expirado' lo vencido.
CREATE OR REPLACE FUNCTION vecino.bridge_fast_poll(p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE v_cmds jsonb; v_watch boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vecino.bot_config WHERE token = p_token) THEN
    RAISE EXCEPTION 'token invalido';
  END IF;
  -- Vencidos sin ejecutar → 'expirado' (jamás se abren tarde)
  UPDATE vecino.door_commands
     SET result = 'expirado'
   WHERE result IS NULL AND expires_at <= now();
  -- Tomar los vivos (FOR UPDATE SKIP LOCKED por si algún día hay 2 consumidores)
  WITH tomados AS (
    SELECT id FROM vecino.door_commands
     WHERE result IS NULL AND taken_at IS NULL AND expires_at > now()
     ORDER BY requested_at
     FOR UPDATE SKIP LOCKED
  ), upd AS (
    UPDATE vecino.door_commands d
       SET taken_at = now()
      FROM tomados t WHERE d.id = t.id
    RETURNING d.id, d.door, d.action
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(upd)), '[]'::jsonb) INTO v_cmds FROM upd;
  SELECT EXISTS (SELECT 1 FROM vecino.camera_state
                 WHERE watch_until > now()) INTO v_watch;
  RETURN jsonb_build_object('commands', v_cmds, 'watch', v_watch);
END $$;

-- 8. RPC Orin: marcar resultado de un comando ---------------------------------------
CREATE OR REPLACE FUNCTION vecino.door_mark(
  p_token text, p_id uuid, p_ok boolean, p_error text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vecino.bot_config WHERE token = p_token) THEN
    RAISE EXCEPTION 'token invalido';
  END IF;
  UPDATE vecino.door_commands
     SET executed_at = CASE WHEN p_ok THEN now() ELSE executed_at END,
         result = CASE WHEN p_ok THEN 'ok' ELSE 'error' END,
         error = p_error
   WHERE id = p_id AND result IS NULL;
  RETURN jsonb_build_object('ok', true);
END $$;

-- 9. RPC Orin: subir un frame (solo si alguien está mirando) --------------------------
CREATE OR REPLACE FUNCTION vecino.camera_push(
  p_token text, p_b64 text, p_camera text DEFAULT 'peatonal')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vecino.bot_config WHERE token = p_token) THEN
    RAISE EXCEPTION 'token invalido';
  END IF;
  UPDATE vecino.camera_state
     SET frame_b64 = p_b64, frame_at = now()
   WHERE camera = p_camera AND watch_until > now();
  RETURN jsonb_build_object('ok', true);
END $$;

-- 10. Grants ------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION vecino.is_door_operator() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.door_open(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.door_status(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.camera_view(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.bridge_fast_poll(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.door_mark(text, uuid, boolean, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.camera_push(text, text, text) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
