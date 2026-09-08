-- ============================================================
-- VECINITY · Notificaciones automáticas (pg_net → Telegram)
-- Token SOLO dentro de mifracc.tg_send (SECURITY DEFINER, fuente no legible por anon/auth).
-- ============================================================

-- Helper de envío (único lugar con el token). Nunca bloquea al caller.
CREATE OR REPLACE FUNCTION mifracc.tg_send(p_chat text, p_text text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$
BEGIN
  IF p_chat IS NULL THEN RETURN; END IF;
  PERFORM net.http_post(
    url := 'https://api.telegram.org/bot8632144143:AAGlCGKlI9eU31dK2bFIpzldTiDX8CGKKWE/sendMessage',
    body := jsonb_build_object('chat_id', p_chat, 'text', p_text, 'parse_mode', 'Markdown'),
    headers := '{"Content-Type":"application/json"}'::jsonb
  );
EXCEPTION WHEN OTHERS THEN NULL;
END $fn$;

-- ============================================================
-- 1) SOS → comité de la colonia + capitán de la zona (instantáneo)
-- ============================================================
CREATE OR REPLACE FUNCTION mifracc.notify_sos()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE v_sender text; v_casa text; v_zona text; v_maps text; v_msg text; r record;
BEGIN
  SELECT p.nombre, h.numero INTO v_sender, v_casa
    FROM mifracc.profiles p LEFT JOIN mifracc.houses h ON h.id = NEW.house_id
    WHERE p.id = NEW.profile_id;
  SELECT nombre INTO v_zona FROM mifracc.zones WHERE id = NEW.zone_id;
  v_maps := CASE WHEN NEW.lat IS NOT NULL
                 THEN E'\n📍 https://maps.google.com/?q=' || NEW.lat || ',' || NEW.lng
                 ELSE '' END;
  v_msg := '🚨 *SOS / Botón de pánico*' || E'\n' ||
           COALESCE(v_sender, 'Un vecino') ||
           CASE WHEN v_casa IS NOT NULL THEN ' (Casa ' || v_casa || ')' ELSE '' END ||
           ' activó una alerta' ||
           CASE WHEN v_zona IS NOT NULL THEN ' en ' || v_zona ELSE '' END || '.' ||
           CASE WHEN NEW.mode = 'silent' THEN E'\n⚠️ Modo silencioso.' ELSE '' END ||
           v_maps;

  FOR r IN
    SELECT DISTINCT p.id, p.telegram_chat_id
    FROM mifracc.profiles p
    WHERE p.colonia_id = NEW.colonia_id
      AND p.telegram_chat_id IS NOT NULL
      AND ( p.role IN ('comite','admin')
            OR p.id = (SELECT captain_id FROM mifracc.zones WHERE id = NEW.zone_id) )
  LOOP
    PERFORM mifracc.tg_send(r.telegram_chat_id, v_msg);
    INSERT INTO mifracc.notifications(colonia_id, profile_id, tipo, mensaje, canal, estado_envio, ref_tabla, ref_id, enviado_at)
    VALUES (NEW.colonia_id, r.id, 'sos', v_msg, 'telegram', 'enviado', 'sos_events', NEW.id, now());
  END LOOP;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_notify_sos ON mifracc.sos_events;
CREATE TRIGGER trg_notify_sos AFTER INSERT ON mifracc.sos_events
  FOR EACH ROW EXECUTE FUNCTION mifracc.notify_sos();

-- ============================================================
-- 2) Saldo alto → aviso al residente (al cruzar el umbral)
-- ============================================================
CREATE OR REPLACE FUNCTION mifracc.notify_saldo()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE v_chat text; v_umbral numeric; v_msg text;
BEGIN
  SELECT umbral_saldo_alerta INTO v_umbral FROM mifracc.colonias WHERE id = NEW.colonia_id;
  IF NEW.saldo > COALESCE(v_umbral, 0) AND NEW.saldo > COALESCE(OLD.saldo, 0) THEN
    SELECT telegram_chat_id INTO v_chat FROM mifracc.profiles
      WHERE house_id = NEW.id AND telegram_chat_id IS NOT NULL
      ORDER BY (role = 'residente') DESC LIMIT 1;
    IF v_chat IS NOT NULL THEN
      v_msg := '💸 *Aviso de saldo*' || E'\n' ||
               'Tu casa ' || NEW.numero || ' tiene un saldo pendiente de $' ||
               to_char(NEW.saldo, 'FM999,999.00') ||
               '. Te recomendamos revisar tus pagos para evitar recargos.';
      PERFORM mifracc.tg_send(v_chat, v_msg);
      INSERT INTO mifracc.notifications(colonia_id, house_id, tipo, mensaje, canal, estado_envio, ref_tabla, ref_id, enviado_at)
      VALUES (NEW.colonia_id, NEW.id, 'saldo_alto', v_msg, 'telegram', 'enviado', 'houses', NEW.id, now());
    END IF;
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_notify_saldo ON mifracc.houses;
CREATE TRIGGER trg_notify_saldo AFTER UPDATE OF saldo ON mifracc.houses
  FOR EACH ROW WHEN (NEW.saldo IS DISTINCT FROM OLD.saldo)
  EXECUTE FUNCTION mifracc.notify_saldo();

-- ============================================================
-- 3) Pago vencido (día >10) → aviso de recargo. Lo dispara n8n (schedule diario).
--    Marca 'atrasado' y notifica una vez por pago (idempotente vía notifications).
-- ============================================================
CREATE OR REPLACE FUNCTION mifracc.run_late_fee_notifications()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE r record; v_chat text; v_msg text; cnt int := 0;
BEGIN
  FOR r IN
    SELECT pay.id, pay.concepto, pay.fecha_vencimiento, pay.house_id, pay.colonia_id,
           h.numero, c.recargo
    FROM mifracc.payments pay
    JOIN mifracc.houses h   ON h.id = pay.house_id
    JOIN mifracc.colonias c ON c.id = pay.colonia_id
    WHERE pay.estado IN ('pendiente','atrasado')
      AND pay.fecha_vencimiento < current_date
      AND NOT EXISTS (
        SELECT 1 FROM mifracc.notifications n
        WHERE n.ref_tabla='payments' AND n.ref_id=pay.id AND n.tipo='multa_pago'
      )
  LOOP
    UPDATE mifracc.payments SET estado='atrasado' WHERE id = r.id AND estado <> 'atrasado';
    SELECT telegram_chat_id INTO v_chat FROM mifracc.profiles
      WHERE house_id = r.house_id AND telegram_chat_id IS NOT NULL LIMIT 1;
    v_msg := '⏰ *Pago vencido*' || E'\n' || 'Tu pago "' || r.concepto || '" venció el ' ||
             to_char(r.fecha_vencimiento, 'DD/Mon') ||
             '. Aplica un recargo de $' || to_char(COALESCE(r.recargo,0), 'FM999,999.00') ||
             '. Regulariza para evitar más cargos.';
    PERFORM mifracc.tg_send(v_chat, v_msg);
    INSERT INTO mifracc.notifications(colonia_id, house_id, tipo, mensaje, canal, estado_envio, ref_tabla, ref_id, enviado_at)
    VALUES (r.colonia_id, r.house_id, 'multa_pago', v_msg, 'telegram',
            CASE WHEN v_chat IS NULL THEN 'pendiente' ELSE 'enviado' END, 'payments', r.id, now());
    cnt := cnt + 1;
  END LOOP;
  RETURN cnt;
END $fn$;

REVOKE ALL ON FUNCTION mifracc.run_late_fee_notifications() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION mifracc.run_late_fee_notifications() TO service_role;
