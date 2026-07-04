-- =============================================================================
-- VECINITY · 046 — SOS v2: vecinos vigilantes + zona + acuse + ruta 911
-- schema: vecino · Supabase self-hosted Nexia
--
-- Fixes y mejoras del lazo SOS:
-- 1. FIX: el capitán de zona nunca recibía la alerta — el insert del dashboard
--    no mandaba zone_id. Ahora disparar_sos() lo resuelve desde la casa.
-- 2. Vecinos VIGILANTES: voluntarios que se postulan y el comité aprueba;
--    reciben todo SOS junto con comité y capitán.
-- 3. Acuse de lazo cerrado: la alerta lleva botón "Voy en camino" (Telegram);
--    el primero que lo toca queda como attended_by y se avisa a todos.
-- 4. Ruta 911: la alerta y la app llevan los datos listos para dictar al 911
--    (no hay API pública del 911 en México — lo honesto es facilitar la llamada).
-- =============================================================================

-- ------------------------------------------------------------
-- 1) Vecinos vigilantes
-- ------------------------------------------------------------
CREATE TABLE vecino.vigilantes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id    uuid NOT NULL REFERENCES vecino.colonias(id) ON DELETE CASCADE,
  profile_id    uuid NOT NULL REFERENCES vecino.profiles(id) ON DELETE CASCADE UNIQUE,
  estado        text NOT NULL DEFAULT 'postulado' CHECK (estado IN ('postulado','aprobado','baja')),
  postulado_at  timestamptz NOT NULL DEFAULT now(),
  resuelto_at   timestamptz,
  resuelto_por  uuid REFERENCES vecino.profiles(id) ON DELETE SET NULL
);
CREATE INDEX idx_vigilantes_colonia ON vecino.vigilantes(colonia_id, estado);

ALTER TABLE vecino.vigilantes ENABLE ROW LEVEL SECURITY;
CREATE POLICY vigilantes_self_read ON vecino.vigilantes FOR SELECT
  USING (profile_id = auth.uid());
CREATE POLICY vigilantes_admin ON vecino.vigilantes FOR ALL
  USING (colonia_id = vecino.my_colonia_id() AND vecino.is_admin())
  WITH CHECK (colonia_id = vecino.my_colonia_id() AND vecino.is_admin());
GRANT ALL ON vecino.vigilantes TO anon, authenticated, service_role;

-- Postularse (el propio vecino; requiere vivir en una casa)
CREATE OR REPLACE FUNCTION vecino.postular_vigilante()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE v_house uuid := vecino.my_house_id(); v_col uuid := vecino.my_colonia_id(); v_est text;
BEGIN
  IF v_house IS NULL THEN
    RAISE EXCEPTION 'Para ser vecino vigilante necesitas vivir en la colonia.';
  END IF;
  SELECT estado INTO v_est FROM vecino.vigilantes WHERE profile_id = auth.uid();
  IF v_est = 'aprobado' THEN RAISE EXCEPTION 'Ya eres vecino vigilante.'; END IF;
  IF v_est = 'postulado' THEN RAISE EXCEPTION 'Tu postulación ya está en revisión del comité.'; END IF;
  INSERT INTO vecino.vigilantes (colonia_id, profile_id, estado)
  VALUES (v_col, auth.uid(), 'postulado')
  ON CONFLICT (profile_id) DO UPDATE
    SET estado = 'postulado', postulado_at = now(), resuelto_at = NULL, resuelto_por = NULL;
  RETURN jsonb_build_object('ok', true);
END $$;

-- Comité aprueba o da de baja
CREATE OR REPLACE FUNCTION vecino.resolver_vigilante(p_id uuid, p_accion text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE v_rows int;
BEGIN
  IF NOT vecino.is_admin() THEN
    RAISE EXCEPTION 'Solo el comité puede resolver postulaciones.';
  END IF;
  IF p_accion NOT IN ('aprobar','baja') THEN
    RAISE EXCEPTION 'Acción inválida.';
  END IF;
  UPDATE vecino.vigilantes
     SET estado = CASE p_accion WHEN 'aprobar' THEN 'aprobado' ELSE 'baja' END,
         resuelto_at = now(), resuelto_por = auth.uid()
   WHERE id = p_id AND colonia_id = vecino.my_colonia_id();
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN RAISE EXCEPTION 'No existe esa postulación.'; END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

GRANT EXECUTE ON FUNCTION vecino.postular_vigilante() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.resolver_vigilante(uuid,text) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 2) sos_events: registro de la ruta 911
-- ------------------------------------------------------------
ALTER TABLE vecino.sos_events ADD COLUMN IF NOT EXISTS llamo_911 boolean NOT NULL DEFAULT false;

-- ------------------------------------------------------------
-- 3) disparar_sos: resuelve casa Y ZONA (fix capitán) + regresa datos 911
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.disparar_sos(
  p_lat double precision DEFAULT NULL,
  p_lng double precision DEFAULT NULL,
  p_mode text DEFAULT 'loud')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE
  v_col uuid := vecino.my_colonia_id();
  v_house uuid := vecino.my_house_id();
  v_zone uuid; v_id uuid; v_num text; v_street text; v_colonia text;
BEGIN
  IF v_col IS NULL THEN
    RAISE EXCEPTION 'Tu perfil no está ligado a una colonia.';
  END IF;
  SELECT h.zone_id, h.numero, h.street INTO v_zone, v_num, v_street
    FROM vecino.houses h WHERE h.id = v_house;
  SELECT nombre INTO v_colonia FROM vecino.colonias WHERE id = v_col;

  INSERT INTO vecino.sos_events (colonia_id, profile_id, house_id, zone_id, mode, lat, lng)
  VALUES (v_col, auth.uid(), v_house, v_zone,
          CASE WHEN p_mode = 'silent' THEN 'silent'::vecino.sos_mode ELSE 'loud'::vecino.sos_mode END,
          p_lat, p_lng)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id,
    'casa', v_num, 'calle', v_street, 'colonia', v_colonia);
END $$;

-- El vecino registra que ya llamó al 911 (bitácora del incidente)
CREATE OR REPLACE FUNCTION vecino.sos_marcar_911(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
BEGIN
  UPDATE vecino.sos_events SET llamo_911 = true
   WHERE id = p_id AND profile_id = auth.uid();
  RETURN jsonb_build_object('ok', true);
END $$;

GRANT EXECUTE ON FUNCTION vecino.disparar_sos(double precision,double precision,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.sos_marcar_911(uuid) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 4) tg_send_kb: Telegram con botones inline (pg_net, texto plano)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.tg_send_kb(p_chat text, p_text text, p_kb jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF p_chat IS NULL THEN RETURN; END IF;
  PERFORM net.http_post(
    url := 'https://api.telegram.org/bot8632144143:AAGlCGKlI9eU31dK2bFIpzldTiDX8CGKKWE/sendMessage',
    body := jsonb_build_object('chat_id', p_chat, 'text', p_text,
                               'reply_markup', jsonb_build_object('inline_keyboard', p_kb)),
    headers := '{"Content-Type":"application/json"}'::jsonb
  );
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ------------------------------------------------------------
-- 5) Destinatarios de un SOS (comité + capitán de zona + vigilantes aprobados)
--    Central para notify_sos y para el "avisar al resto" del acuse.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino._sos_destinatarios(p_colonia uuid, p_zone uuid, p_excluir uuid)
RETURNS TABLE (profile_id uuid, chat text) LANGUAGE sql SECURITY DEFINER
SET search_path = vecino AS $$
  SELECT DISTINCT p.id, p.telegram_chat_id
  FROM vecino.profiles p
  WHERE p.colonia_id = p_colonia
    AND p.telegram_chat_id IS NOT NULL
    AND p.id IS DISTINCT FROM p_excluir
    AND ( p.role IN ('comite','admin')
          OR p.id = (SELECT captain_id FROM vecino.zones WHERE id = p_zone)
          OR EXISTS (SELECT 1 FROM vecino.vigilantes v
                      WHERE v.profile_id = p.id AND v.estado = 'aprobado') )
$$;

-- ------------------------------------------------------------
-- 6) notify_sos v2: más destinatarios + datos 911 + botón "Voy en camino"
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.notify_sos()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE v_sender text; v_casa text; v_calle text; v_zona text; v_colonia text;
        v_maps text; v_msg text; r record;
BEGIN
  SELECT p.nombre INTO v_sender FROM vecino.profiles p WHERE p.id = NEW.profile_id;
  SELECT h.numero, h.street INTO v_casa, v_calle FROM vecino.houses h WHERE h.id = NEW.house_id;
  SELECT nombre INTO v_zona FROM vecino.zones WHERE id = NEW.zone_id;
  SELECT nombre INTO v_colonia FROM vecino.colonias WHERE id = NEW.colonia_id;
  v_maps := CASE WHEN NEW.lat IS NOT NULL
                 THEN E'\n📍 https://maps.google.com/?q=' || NEW.lat || ',' || NEW.lng
                 ELSE '' END;
  v_msg := '🚨 SOS / Botón de pánico' || E'\n' ||
           COALESCE(v_sender, 'Un vecino') ||
           CASE WHEN v_casa IS NOT NULL THEN ' (Casa ' || v_casa || ')' ELSE '' END ||
           ' activó una alerta' ||
           CASE WHEN v_zona IS NOT NULL THEN ' en ' || v_zona ELSE '' END || '.' ||
           CASE WHEN NEW.mode = 'silent' THEN E'\n⚠️ Modo silencioso: NO llamar al vecino.' ELSE '' END ||
           v_maps || E'\n\n📞 Datos para el 911:' ||
           E'\n· ' || COALESCE(v_calle || ' ', '') || COALESCE('#' || v_casa, 'domicilio del vecino') ||
           E'\n· ' || COALESCE(v_colonia, 'la colonia') ||
           CASE WHEN NEW.lat IS NOT NULL
                THEN E'\n· Coordenadas: ' || round(NEW.lat::numeric, 5) || ', ' || round(NEW.lng::numeric, 5)
                ELSE '' END;

  FOR r IN SELECT * FROM vecino._sos_destinatarios(NEW.colonia_id, NEW.zone_id, NEW.profile_id)
  LOOP
    PERFORM vecino.tg_send_kb(r.chat, v_msg,
      jsonb_build_array(jsonb_build_array(
        jsonb_build_object('text', '🏃 Voy en camino', 'callback_data', 'sos_go:' || NEW.id))));
    INSERT INTO vecino.notifications(colonia_id, profile_id, tipo, mensaje, canal, estado_envio, ref_tabla, ref_id, enviado_at)
    VALUES (NEW.colonia_id, r.profile_id, 'sos', v_msg, 'telegram', 'enviado', 'sos_events', NEW.id, now());
  END LOOP;
  RETURN NEW;
END $fn$;

-- ------------------------------------------------------------
-- 7) Caty: disparar SOS por chat y acuse "Voy en camino" (primero gana)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.bot_sos(p_token text, p_chat text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE p vecino.profiles%ROWTYPE;
BEGIN
  p := vecino._bot_perfil(p_token, p_chat);
  PERFORM vecino._bot_como(p.id);
  RETURN vecino.disparar_sos(NULL, NULL, 'loud');
END $$;

CREATE OR REPLACE FUNCTION vecino.bot_sos_atender(p_token text, p_chat text, p_sos uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE
  p vecino.profiles%ROWTYPE;
  s vecino.sos_events%ROWTYPE;
  v_rows int; v_atendio text; v_solicitante_chat text; v_casa text; v_otros jsonb;
BEGIN
  p := vecino._bot_perfil(p_token, p_chat);
  SELECT * INTO s FROM vecino.sos_events WHERE id = p_sos;
  IF s.id IS NULL THEN RAISE EXCEPTION 'Esa alerta ya no existe.'; END IF;

  -- Solo quienes reciben el SOS pueden atenderlo.
  -- EXISTS (no `p.id = (subquery)`): con zone_id NULL el subquery da NULL y
  -- NOT(false OR NULL) = NULL → el guard no dispararía (bug cazado en QA).
  IF NOT (p.role IN ('comite','admin')
          OR EXISTS (SELECT 1 FROM vecino.zones z WHERE z.id = s.zone_id AND z.captain_id = p.id)
          OR EXISTS (SELECT 1 FROM vecino.vigilantes v WHERE v.profile_id = p.id AND v.estado = 'aprobado')) THEN
    RAISE EXCEPTION 'Solo comité, capitanes o vigilantes pueden atender un SOS.';
  END IF;

  -- primero gana (evita estampida de "yo voy")
  UPDATE vecino.sos_events SET attended_by = p.id
   WHERE id = p_sos AND attended_by IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  SELECT pr.nombre INTO v_atendio FROM vecino.profiles pr
   WHERE pr.id = coalesce((SELECT attended_by FROM vecino.sos_events WHERE id = p_sos), p.id);
  SELECT pr.telegram_chat_id INTO v_solicitante_chat FROM vecino.profiles pr WHERE pr.id = s.profile_id;
  SELECT h.numero INTO v_casa FROM vecino.houses h WHERE h.id = s.house_id;

  IF v_rows = 0 THEN
    RETURN jsonb_build_object('ok', true, 'ya_atendido', true, 'atendio', v_atendio);
  END IF;

  SELECT coalesce(jsonb_agg(d.chat), '[]'::jsonb) INTO v_otros
    FROM vecino._sos_destinatarios(s.colonia_id, s.zone_id, s.profile_id) d
   WHERE d.chat <> p_chat;

  RETURN jsonb_build_object('ok', true, 'ya_atendido', false, 'atendio', v_atendio,
    'casa', v_casa, 'solicitante_chat', v_solicitante_chat, 'otros_chats', v_otros,
    'silencioso', s.mode = 'silent');
END $$;

-- Estado de vigilante para el bot y la app (tarjeta de postulación)
CREATE OR REPLACE FUNCTION vecino.bot_mi_vigilante(p_token text, p_chat text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE p vecino.profiles%ROWTYPE; v_est text;
BEGIN
  p := vecino._bot_perfil(p_token, p_chat);
  SELECT estado INTO v_est FROM vecino.vigilantes WHERE profile_id = p.id;
  RETURN jsonb_build_object('ok', true, 'estado', v_est);
END $$;

REVOKE EXECUTE ON FUNCTION vecino._sos_destinatarios(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION vecino.bot_sos(text,text) TO anon, service_role;
GRANT EXECUTE ON FUNCTION vecino.bot_sos_atender(text,text,uuid) TO anon, service_role;
GRANT EXECUTE ON FUNCTION vecino.bot_mi_vigilante(text,text) TO anon, service_role;

NOTIFY pgrst, 'reload schema';
