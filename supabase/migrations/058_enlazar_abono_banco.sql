-- =============================================================================
-- 058_enlazar_abono_banco.sql — Enlace MANUAL abono↔banco con APRENDIZAJE
-- (Pedido Juan 2026-07-09: "ir enlazando uno a uno los abonos por aprobar con
--  los registros del banco… que sirva de aprendizaje para que cada mes existan
--  menos casos". Caso casa 163: la fecha del comprobante era 4-jul, no 6-jul →
--  el cruce automático por fecha no lo agarró.)
-- =============================================================================
-- 1. enlazar_abono_banco(abono, fila, motivo): liga banco_hash + aprueba
--    (resolver_transaccion) + auditoría del motivo en el concepto Y en la nota
--    de bank_movs + APRENDE: guarda referencia_del_banco → casa en bank_ref_map
--    (el mismo mapa que autosugiere casa en /conciliacion). El concepto SPEI de
--    cada vecino se repite mes a mes → el próximo mes sale solo.
-- 2. abonos_pendientes_comite v3: nuevo nivel 'aprendido' (referencia en
--    bank_ref_map apuntando a ESTA casa + monto exacto, SIN exigir fecha) —
--    verde/seguro, entre 'casa' y 'monto_fecha'.
-- =============================================================================

-- Igual que normRef del front (upper + colapsar espacios) — bank_ref_map usa este formato
CREATE OR REPLACE FUNCTION vecino._norm_ref_key(p text)
RETURNS text LANGUAGE sql IMMUTABLE
AS $$ SELECT upper(btrim(regexp_replace(coalesce(p,''), '\s+', ' ', 'g'))) $$;

CREATE OR REPLACE FUNCTION vecino.enlazar_abono_banco(
  p_id         uuid,
  p_banco_hash text,
  p_motivo     text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE
  v_col    uuid := vecino.my_colonia_id();
  t        vecino.transactions%ROWTYPE;
  b        vecino.bank_movs%ROWTYPE;
  v_num    text;
  v_ref    text;
  v_motivo text := nullif(btrim(coalesce(p_motivo,'')),'');
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;

  SELECT * INTO t FROM vecino.transactions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'El abono no existe.'; END IF;
  IF t.colonia_id <> v_col THEN RAISE EXCEPTION 'El abono no es de tu colonia.'; END IF;
  IF t.tipo <> 'abono' OR t.estado <> 'pendiente' THEN
    RAISE EXCEPTION 'Ese abono ya no está pendiente.';
  END IF;

  IF EXISTS (SELECT 1 FROM vecino.transactions
              WHERE colonia_id = v_col AND banco_hash = p_banco_hash) THEN
    RETURN jsonb_build_object('ok', false, 'dup', true);
  END IF;

  SELECT * INTO b FROM vecino.bank_movs
   WHERE colonia_id = v_col AND banco_hash = p_banco_hash AND estado = 'pendiente'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ese movimiento del banco ya no está disponible (recarga la lista).';
  END IF;
  IF b.tipo <> 'abono' THEN RAISE EXCEPTION 'Esa fila del banco no es un ingreso.'; END IF;
  IF b.monto <> t.monto THEN
    RAISE EXCEPTION 'Los montos no coinciden (abono $% vs banco $%). Corrige primero el monto del abono.',
      t.monto, b.monto;
  END IF;

  UPDATE vecino.transactions
     SET banco_hash = p_banco_hash,
         concepto = concepto || ' · conciliado banco ' || b.fecha::text
                    || ' (enlazado por el comité' || coalesce(': ' || v_motivo, '') || ')'
   WHERE id = p_id;
  PERFORM vecino.resolver_transaccion(p_id, true);  -- aprueba + saldo (trigger marca bank_movs)

  -- guarda el motivo también en la fila del banco (auditoría del enlace)
  UPDATE vecino.bank_movs SET nota = coalesce('Enlace manual: ' || v_motivo, nota)
   WHERE id = b.id AND v_motivo IS NOT NULL;

  -- 🧠 APRENDIZAJE: esta referencia del banco pertenece a esta casa.
  -- Mismo mapa que autosugiere en /conciliacion y que da palomita 'aprendido'.
  v_ref := vecino._norm_ref_key(b.concepto);
  IF v_ref <> '' THEN
    INSERT INTO vecino.bank_ref_map (colonia_id, ref_key, house_id)
    VALUES (v_col, v_ref, t.house_id)
    ON CONFLICT (colonia_id, ref_key)
      DO UPDATE SET house_id = EXCLUDED.house_id,
                    veces = vecino.bank_ref_map.veces + 1,
                    updated_at = now();
  END IF;

  SELECT numero INTO v_num FROM vecino.houses WHERE id = t.house_id;
  RETURN jsonb_build_object('ok', true, 'id', p_id, 'casa', v_num,
                            'banco_fecha', b.fecha, 'aprendido', v_ref <> '');
END $$;
GRANT EXECUTE ON FUNCTION vecino.enlazar_abono_banco(uuid, text, text) TO authenticated;

-- --- abonos_pendientes_comite v3: + nivel 'aprendido' --------------------------
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
