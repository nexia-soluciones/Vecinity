-- ============================================================
-- VECINITY · 025 — OCR de placas + multa semi-automática
-- schema: mifracc · Supabase self-hosted Nexia
--
-- Flujo (decidido con Juan, 2026-06-27):
--   El vecino reporta una incidencia con FOTO de placas + escribe la placa.
--   Una Server Action corre OCR con visión de Claude y llama a
--   procesar_incidencia_auto(). Validación de 3 vías:
--     placa OCR  ≈  placa que escribió el vecino  ≈  placa en `vehicles` (→ casa).
--   Si coinciden:
--     · 1ª vez (sin antecedentes casa+categoría) → AMONESTACIÓN automática (sin monto, notifica).
--     · reincidencia → PROPUESTA de multa (monto por reincidencia) que requiere
--       1 voto del comité (votar_resolucion) para cobrarse.
--   Si NO coinciden / sin placa / sin foto → queda 'pendiente' (revisión manual).
-- ============================================================

-- Columnas para OCR + auto-resolución
-- (plate_detected existe en `visitors` pero NO en incident_reports → se crea aquí)
ALTER TABLE mifracc.incident_reports
  ADD COLUMN IF NOT EXISTS placa_reportada     text,
  ADD COLUMN IF NOT EXISTS plate_detected      text,
  ADD COLUMN IF NOT EXISTS plate_ocr_confidence numeric,
  ADD COLUMN IF NOT EXISTS auto_resuelta       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS voto_por            uuid REFERENCES mifracc.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS voto_at             timestamptz;

-- ------------------------------------------------------------
-- Helper: notificar a la casa infractora por Telegram (si tiene chat).
-- tg_send ignora chat NULL, así que es seguro aunque no esté ligado.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mifracc._notify_infractor(p_house_id uuid, p_texto text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc AS $$
DECLARE v_chat text;
BEGIN
  SELECT telegram_chat_id INTO v_chat
    FROM mifracc.profiles
    WHERE house_id = p_house_id AND telegram_chat_id IS NOT NULL
    LIMIT 1;
  PERFORM mifracc.tg_send(v_chat, p_texto);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ------------------------------------------------------------
-- Normaliza una placa: mayúsculas, solo alfanuméricos.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mifracc._norm_placa(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g'))
$$;

-- ------------------------------------------------------------
-- Auto-procesa una incidencia con la lectura OCR.
-- La llama la Server Action (service_role) tras correr la visión de Claude.
-- SECURITY DEFINER: es el SISTEMA actuando; la multa real sigue requiriendo
-- el voto del comité (votar_resolucion). Idempotente (solo si 'pendiente').
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mifracc.procesar_incidencia_auto(
  p_id              uuid,
  p_placa_reportada text,
  p_plate_ocr       text,
  p_confidence      numeric DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
DECLARE
  r          mifracc.incident_reports%ROWTYPE;
  v_veh      text;
  v_match    boolean;
  v_previas  int;
  v_cat      text;
  v_monto    numeric;
  v_msg      text;
BEGIN
  SELECT * INTO r FROM mifracc.incident_reports WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'La incidencia no existe.'; END IF;
  IF r.estado <> 'pendiente' OR r.auto_resuelta THEN
    RETURN jsonb_build_object('ok', true, 'skipped', true);
  END IF;

  -- Placa registrada de la casa infractora que coincide con la reportada.
  SELECT placa INTO v_veh
    FROM mifracc.vehicles
   WHERE colonia_id = r.colonia_id
     AND house_id = r.infractor_house_id
     AND mifracc._norm_placa(placa) = mifracc._norm_placa(p_placa_reportada)
   LIMIT 1;

  v_match := v_veh IS NOT NULL
         AND p_plate_ocr IS NOT NULL
         AND mifracc._norm_placa(p_plate_ocr) = mifracc._norm_placa(v_veh);

  -- Guarda siempre la lectura OCR + la placa reportada.
  UPDATE mifracc.incident_reports
     SET placa_reportada = p_placa_reportada,
         plate_detected = p_plate_ocr,
         plate_ocr_confidence = p_confidence
   WHERE id = p_id;

  IF NOT v_match THEN
    RETURN jsonb_build_object('ok', true, 'match', false,
      'plate_ocr', p_plate_ocr, 'placa_registrada', v_veh);
  END IF;

  SELECT nombre INTO v_cat FROM mifracc.fine_categories WHERE id = r.categoria_id;

  -- Antecedentes de esa casa en esa categoría (multas + amonestaciones previas).
  SELECT count(*) INTO v_previas
    FROM mifracc.incident_reports
   WHERE colonia_id = r.colonia_id
     AND infractor_house_id = r.infractor_house_id
     AND categoria_id = r.categoria_id
     AND id <> r.id
     AND estado IN ('multa', 'amonestacion');

  IF v_previas = 0 THEN
    -- Primera vez → amonestación automática (sin monto, sin voto).
    UPDATE mifracc.incident_reports
       SET estado = 'amonestacion', auto_resuelta = true, resolved_at = now(),
           resolucion_admin = 'Amonestación automática (1ª vez). Placa verificada por OCR.'
     WHERE id = p_id;
    v_msg := '🔔 Amonestación — ' || coalesce(v_cat, 'Incidencia') ||
             '. Es la primera vez, por lo que es solo un aviso. A la próxima se aplicará multa.';
    PERFORM mifracc._notify_infractor(r.infractor_house_id, v_msg);
    RETURN jsonb_build_object('ok', true, 'match', true, 'accion', 'amonestacion');
  ELSE
    -- Reincidencia → propuesta de multa (espera 1 voto del comité).
    v_monto := (mifracc.sugerir_multa(r.infractor_house_id, r.categoria_id) ->> 'monto_sugerido')::numeric;
    UPDATE mifracc.incident_reports
       SET estado = 'propuesta', auto_resuelta = true, monto_multa = v_monto,
           resolucion_admin = 'Propuesta automática de multa (reincidencia). Placa verificada por OCR. Requiere 1 voto del comité.'
     WHERE id = p_id;
    RETURN jsonb_build_object('ok', true, 'match', true, 'accion', 'propuesta', 'monto', v_monto);
  END IF;
END $$;

-- ------------------------------------------------------------
-- Voto del comité sobre una propuesta automática (1 voto procesa).
-- aprobar=true → cobra la multa (mismo efecto que resolver_incidencia 'multar').
-- aprobar=false → rechaza la propuesta.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mifracc.votar_resolucion(
  p_id      uuid,
  p_aprobar boolean DEFAULT true
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
DECLARE r mifracc.incident_reports%ROWTYPE; v_cat text; v_tx uuid; v_msg text;
BEGIN
  IF NOT mifracc.is_admin() THEN RAISE EXCEPTION 'Solo el comité puede votar.'; END IF;
  SELECT * INTO r FROM mifracc.incident_reports WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'La incidencia no existe.'; END IF;
  IF r.colonia_id <> mifracc.my_colonia_id() THEN RAISE EXCEPTION 'No es de tu colonia.'; END IF;
  IF r.estado <> 'propuesta' THEN RAISE EXCEPTION 'No es una propuesta pendiente de voto.'; END IF;

  IF p_aprobar THEN
    SELECT nombre INTO v_cat FROM mifracc.fine_categories WHERE id = r.categoria_id;
    INSERT INTO mifracc.transactions (colonia_id, house_id, tipo, monto, concepto, estado)
    VALUES (r.colonia_id, r.infractor_house_id, 'cargo', r.monto_multa,
            'Multa: ' || coalesce(v_cat, 'Incidencia'), 'aprobado')
    RETURNING id INTO v_tx;
    UPDATE mifracc.houses SET saldo = saldo + r.monto_multa WHERE id = r.infractor_house_id;
    UPDATE mifracc.houses
       SET estatus = CASE
         WHEN estatus = 'en_convenio' THEN 'en_convenio'::mifracc.estatus_casa
         WHEN saldo > 0 THEN 'con_adeudo'::mifracc.estatus_casa
         ELSE 'al_corriente'::mifracc.estatus_casa END
     WHERE id = r.infractor_house_id;
    UPDATE mifracc.incident_reports
       SET estado = 'multa', transaction_id = v_tx,
           voto_por = auth.uid(), voto_at = now(),
           resolved_at = now(), resolved_by = auth.uid()
     WHERE id = p_id;
    v_msg := '⚠️ Multa aplicada — ' || coalesce(v_cat, 'Incidencia') ||
             ' por reincidencia. Monto: $' || to_char(r.monto_multa, 'FM999G999') ||
             '. Se cargó a tu estado de cuenta.';
    PERFORM mifracc._notify_infractor(r.infractor_house_id, v_msg);
    RETURN jsonb_build_object('ok', true, 'estado', 'multa', 'transaction_id', v_tx);
  ELSE
    UPDATE mifracc.incident_reports
       SET estado = 'rechazado', voto_por = auth.uid(), voto_at = now(),
           resolved_at = now(), resolved_by = auth.uid(),
           resolucion_admin = coalesce(resolucion_admin, '') || ' · Rechazada por el comité.'
     WHERE id = p_id;
    RETURN jsonb_build_object('ok', true, 'estado', 'rechazado');
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION mifracc._notify_infractor(uuid,text)                       TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION mifracc._norm_placa(text)                                  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION mifracc.procesar_incidencia_auto(uuid,text,text,numeric)   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION mifracc.votar_resolucion(uuid,boolean)                     TO authenticated, service_role;
