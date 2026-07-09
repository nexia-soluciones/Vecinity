-- =============================================================================
-- 057_match_banco_seguro.sql — Palomita del banco SOLO cuando el match es seguro
-- (Observación Juan 2026-07-09: muchas casas pagan el mismo monto el mismo día;
--  el match por monto+fecha podía ligar el pago de una casa a la fila de otra)
-- =============================================================================
-- Niveles de match en abonos_pendientes_comite():
--   'rastreo'              → clave de rastreo del comprobante contenida en el
--                            concepto del banco (única por transferencia). SEGURO.
--   'casa'                 → el concepto del banco menciona explícitamente LA casa
--                            del abono (C210 / CASA 210). SEGURO.
--   'monto_fecha'          → monto exacto + fecha ±3d Y el cruce es 1 a 1: este
--                            abono es el ÚNICO pendiente que cuadra con esa fila
--                            y esa fila es la ÚNICA que cuadra con este abono. SEGURO.
--   'monto_fecha_ambiguo'  → cuadra por monto+fecha pero hay VARIOS candidatos
--                            (N abonos y/o N filas iguales). La UI avisa y Aprobar
--                            NO liga la fila del banco (resolver normal); se
--                            concilia después en /dashboard/conciliacion.
-- Además: si el concepto del banco menciona OTRA casa válida de la colonia,
-- ese candidato se descarta por completo.
-- Devuelve 'candidatos' (cuántos abonos pendientes cuadran con la misma fila).
-- =============================================================================

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
        -- Casa mencionada explícitamente en el concepto del banco (C210/CASA 210),
        -- ignorando números largos (cuentas/claves de rastreo).
        LEFT JOIN LATERAL (
          SELECT (regexp_match(
                    upper(regexp_replace(b.concepto, '\d{4,}', ' ', 'g')),
                    '\mC(?:ASA)?\s*(\d{1,3})\M'))[1] AS num
        ) casa_b ON true
        -- Ambigüedad del cruce monto+fecha (solo aplica cuando no hay rastreo/casa):
        --   n_abonos: cuántos abonos pendientes cuadran con ESTA fila del banco
        --   n_filas:  cuántas filas del banco cuadran con ESTE abono
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
          )
          -- si el banco menciona OTRA casa válida de la colonia → descartar
          AND NOT (
            casa_b.num IS NOT NULL AND casa_b.num <> h.numero
            AND EXISTS (SELECT 1 FROM vecino.houses hx
                         WHERE hx.colonia_id = v_col AND hx.numero = casa_b.num)
          )
      ) cand
      ORDER BY CASE cand.match_por
                 WHEN 'rastreo' THEN 0 WHEN 'casa' THEN 1
                 WHEN 'monto_fecha' THEN 2 ELSE 3 END,
               cand.dist
      LIMIT 1
    ) m ON true
    WHERE t.colonia_id = v_col AND t.estado = 'pendiente'
  ) q;

  RETURN v_out;
END $$;
