-- =============================================================================
-- 059_aclaracion_abono.sql — Pedir aclaración al vecino sobre su comprobante
-- (Pedido Juan 2026-07-09: comprobantes sin fecha/concepto legibles → mensaje
--  formal desde la misma pantalla pidiendo los datos; la respuesta del vecino
--  alimenta la conciliación: la fecha que conteste entra al comprobante_ocr y
--  el cruce con el banco la usa.)
-- =============================================================================
-- Canales: Telegram (tg_send a los perfiles de la casa con chat ligado, best
-- effort) + banner en la app sobre SU movimiento (Pagos → Mis movimientos).
-- =============================================================================

ALTER TABLE vecino.transactions
  ADD COLUMN IF NOT EXISTS aclaracion_solicitud   text,
  ADD COLUMN IF NOT EXISTS aclaracion_solicitada_at timestamptz,
  ADD COLUMN IF NOT EXISTS aclaracion_respuesta   text,
  ADD COLUMN IF NOT EXISTS aclaracion_respondida_at timestamptz;

-- --- El comité pide la aclaración ---------------------------------------------
-- Sin p_mensaje arma uno formal según lo que falte en el OCR (fecha/concepto).
CREATE OR REPLACE FUNCTION vecino.solicitar_aclaracion_abono(
  p_id      uuid,
  p_mensaje text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE
  v_col     uuid := vecino.my_colonia_id();
  t         vecino.transactions%ROWTYPE;
  v_num     text;
  v_falta   text;
  v_msg     text;
  v_enviados int := 0;
  rec       record;
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;

  SELECT * INTO t FROM vecino.transactions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'El abono no existe.'; END IF;
  IF t.colonia_id <> v_col THEN RAISE EXCEPTION 'El abono no es de tu colonia.'; END IF;
  IF t.tipo <> 'abono' OR t.estado <> 'pendiente' THEN
    RAISE EXCEPTION 'Ese abono ya no está pendiente.';
  END IF;

  SELECT numero INTO v_num FROM vecino.houses WHERE id = t.house_id;

  -- qué le falta al comprobante (para el mensaje automático)
  v_falta := concat_ws(' y ',
    CASE WHEN nullif(t.comprobante_ocr->>'fecha','') IS NULL THEN 'la fecha de la operación' END,
    CASE WHEN nullif(t.comprobante_ocr->>'concepto','') IS NULL THEN 'el concepto que colocó' END);
  IF v_falta = '' THEN v_falta := 'algunos datos'; END IF;

  v_msg := coalesce(nullif(btrim(coalesce(p_mensaje,'')),''),
    'Estimado vecino de la casa ' || v_num || ': recibimos su comprobante de pago por $'
    || t.monto::text || ', pero no pudimos leer en él ' || v_falta
    || ', por lo que nos es difícil conciliarlo con el estado de cuenta. '
    || '¿Nos ayuda indicándonos la fecha en que realizó la transferencia y el concepto '
    || 'que colocó? Puede responder directamente en la app: Pagos → Mis movimientos. '
    || 'Gracias — Comité de administración.');

  UPDATE vecino.transactions
     SET aclaracion_solicitud = v_msg,
         aclaracion_solicitada_at = now(),
         aclaracion_respuesta = NULL,
         aclaracion_respondida_at = NULL
   WHERE id = p_id;

  -- Telegram best-effort a los perfiles de esa casa (residentes y dueños ligados)
  FOR rec IN
    SELECT DISTINCT p.telegram_chat_id
      FROM vecino.profiles p
     WHERE p.telegram_chat_id IS NOT NULL
       AND (p.house_id = t.house_id
            OR p.id IN (SELECT hm.profile_id FROM vecino.house_members hm
                         WHERE hm.house_id = t.house_id))
  LOOP
    PERFORM vecino.tg_send(rec.telegram_chat_id, '📎 ' || v_msg);
    v_enviados := v_enviados + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'mensaje', v_msg, 'telegram_enviados', v_enviados);
END $$;
GRANT EXECUTE ON FUNCTION vecino.solicitar_aclaracion_abono(uuid, text) TO authenticated;

-- --- El vecino responde ---------------------------------------------------------
-- La fecha respondida se inyecta al comprobante_ocr → el cruce con el banco la usa.
CREATE OR REPLACE FUNCTION vecino.responder_aclaracion_abono(
  p_id    uuid,
  p_fecha date DEFAULT NULL,
  p_texto text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE
  t     vecino.transactions%ROWTYPE;
  v_txt text := nullif(btrim(coalesce(p_texto,'')),'');
  v_resp text;
BEGIN
  SELECT * INTO t FROM vecino.transactions
   WHERE id = p_id AND tipo = 'abono' AND estado = 'pendiente'
     AND house_id IN (SELECT vecino.my_finance_house_ids())
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ese movimiento no está disponible.'; END IF;
  IF t.aclaracion_solicitud IS NULL THEN
    RAISE EXCEPTION 'No hay ninguna aclaración pendiente para este movimiento.';
  END IF;
  IF p_fecha IS NULL AND v_txt IS NULL THEN
    RAISE EXCEPTION 'Indica la fecha o escribe el concepto.';
  END IF;

  v_resp := concat_ws(' · ',
    CASE WHEN p_fecha IS NOT NULL THEN 'Fecha de la transferencia: ' || p_fecha::text END,
    v_txt);

  UPDATE vecino.transactions
     SET aclaracion_respuesta = v_resp,
         aclaracion_respondida_at = now(),
         -- ojo: jsonb || NULL = NULL → cada pieza va con coalesce a '{}'
         comprobante_ocr = jsonb_strip_nulls(
           coalesce(comprobante_ocr, '{}'::jsonb)
           || coalesce(CASE WHEN p_fecha IS NOT NULL
                   THEN jsonb_build_object('fecha', p_fecha::text, 'fecha_fuente', 'vecino') END, '{}'::jsonb)
           || coalesce(CASE WHEN v_txt IS NOT NULL
                   THEN jsonb_build_object('concepto_vecino', v_txt) END, '{}'::jsonb))
   WHERE id = p_id;

  RETURN jsonb_build_object('ok', true, 'respuesta', v_resp);
END $$;
GRANT EXECUTE ON FUNCTION vecino.responder_aclaracion_abono(uuid, date, text) TO authenticated;

-- --- abonos_pendientes_comite v4: + estado de la aclaración ---------------------
CREATE OR REPLACE FUNCTION vecino.abonos_pendientes_comite()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE v_col uuid := vecino.my_colonia_id(); v_out jsonb;
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;

  SELECT coalesce(jsonb_agg(fila ORDER BY (fila->>'created_at')), '[]'::jsonb)
    INTO v_out
  FROM (
    SELECT jsonb_build_object(
      'id',              t.id,
      'tipo',            t.tipo,
      'monto',           t.monto,
      'concepto',        t.concepto,
      'estado',          t.estado,
      'comprobante_url', t.comprobante_url,
      'created_at',      t.created_at,
      'casa',            h.numero,
      'ocr_monto',       CASE WHEN (t.comprobante_ocr->>'monto') ~ '^-?\d+(\.\d+)?$'
                              THEN (t.comprobante_ocr->>'monto')::numeric END,
      'ocr_fecha',       nullif(t.comprobante_ocr->>'fecha',''),
      'aclaracion',           t.aclaracion_solicitud,
      'aclaracion_at',        t.aclaracion_solicitada_at,
      'aclaracion_respuesta', t.aclaracion_respuesta,
      'respuesta_at',         t.aclaracion_respondida_at,
      'en_banco',        (m.banco_hash IS NOT NULL),
      'banco_hash',      m.banco_hash,
      'banco_fecha',     m.fecha,
      'match_por',       m.match_por,
      'candidatos',      m.n_abonos
    ) AS fila
    FROM vecino.transactions t
    JOIN vecino.houses h ON h.id = t.house_id
    LEFT JOIN LATERAL (
      SELECT * FROM (
        SELECT b.banco_hash, b.fecha,
               CASE
                 WHEN t.ref_rastreo IS NOT NULL AND length(t.ref_rastreo) >= 6
                      AND position(t.ref_rastreo IN vecino._norm_ref(b.concepto)) > 0
                   THEN 'rastreo'
                 WHEN casa_b.num = h.numero
                   THEN 'casa'
                 WHEN apr.si
                   THEN 'aprendido'
                 WHEN amb.n_abonos = 1 AND amb.n_filas = 1
                   THEN 'monto_fecha'
                 ELSE 'monto_fecha_ambiguo'
               END AS match_por,
               amb.n_abonos,
               abs(b.fecha - coalesce(
                 CASE WHEN (t.comprobante_ocr->>'fecha') ~ '^\d{4}-\d{2}-\d{2}$'
                      THEN (t.comprobante_ocr->>'fecha')::date END,
                 (t.created_at AT TIME ZONE 'America/Mexico_City')::date)) AS dist
        FROM vecino.bank_movs b
        LEFT JOIN LATERAL (
          SELECT (regexp_match(
                    upper(regexp_replace(b.concepto, '\d{4,}', ' ', 'g')),
                    '\mC(?:ASA)?\s*(\d{1,3})\M'))[1] AS num
        ) casa_b ON true
        -- 🧠 referencia APRENDIDA (bank_ref_map) apuntando a ESTA casa
        LEFT JOIN LATERAL (
          SELECT EXISTS (
            SELECT 1 FROM vecino.bank_ref_map rm
             WHERE rm.colonia_id = v_col AND rm.house_id = t.house_id
               AND rm.ref_key = vecino._norm_ref_key(b.concepto)
          ) AS si
        ) apr ON true
        LEFT JOIN LATERAL (
          SELECT
            (SELECT count(*) FROM vecino.transactions t2
              WHERE t2.colonia_id = v_col AND t2.tipo = 'abono'
                AND t2.estado = 'pendiente' AND t2.banco_hash IS NULL
                AND t2.monto = b.monto
                AND abs(b.fecha - coalesce(
                  CASE WHEN (t2.comprobante_ocr->>'fecha') ~ '^\d{4}-\d{2}-\d{2}$'
                       THEN (t2.comprobante_ocr->>'fecha')::date END,
                  (t2.created_at AT TIME ZONE 'America/Mexico_City')::date)) <= 3) AS n_abonos,
            (SELECT count(*) FROM vecino.bank_movs b2
              WHERE b2.colonia_id = v_col AND b2.tipo = 'abono'
                AND b2.estado = 'pendiente'
                AND b2.monto = t.monto
                AND abs(b2.fecha - coalesce(
                  CASE WHEN (t.comprobante_ocr->>'fecha') ~ '^\d{4}-\d{2}-\d{2}$'
                       THEN (t.comprobante_ocr->>'fecha')::date END,
                  (t.created_at AT TIME ZONE 'America/Mexico_City')::date)) <= 3) AS n_filas
        ) amb ON true
        WHERE b.colonia_id = v_col AND b.tipo = 'abono' AND b.estado = 'pendiente'
          AND (
            (t.ref_rastreo IS NOT NULL AND length(t.ref_rastreo) >= 6
               AND position(t.ref_rastreo IN vecino._norm_ref(b.concepto)) > 0)
            OR
            (b.monto = t.monto AND abs(b.fecha - coalesce(
               CASE WHEN (t.comprobante_ocr->>'fecha') ~ '^\d{4}-\d{2}-\d{2}$'
                    THEN (t.comprobante_ocr->>'fecha')::date END,
               (t.created_at AT TIME ZONE 'America/Mexico_City')::date)) <= 3)
            OR
            -- aprendido: referencia enseñada + monto exacto, SIN exigir fecha
            (b.monto = t.monto AND apr.si)
          )
          AND NOT (
            casa_b.num IS NOT NULL AND casa_b.num <> h.numero
            AND EXISTS (SELECT 1 FROM vecino.houses hx
                         WHERE hx.colonia_id = v_col AND hx.numero = casa_b.num)
          )
      ) cand
      ORDER BY CASE cand.match_por
                 WHEN 'rastreo' THEN 0 WHEN 'casa' THEN 1 WHEN 'aprendido' THEN 2
                 WHEN 'monto_fecha' THEN 3 ELSE 4 END,
               cand.dist
      LIMIT 1
    ) m ON true
    WHERE t.colonia_id = v_col AND t.estado = 'pendiente'
  ) q;

  RETURN v_out;
END $$;
