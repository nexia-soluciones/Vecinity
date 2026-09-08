-- 036_conciliar_monto_fecha.sql — Auto-conciliar: respaldo por MONTO + FECHA
-- =============================================================================
-- Idea (Juan): cuando la clave de rastreo del comprobante NO casa con el concepto
-- del banco (OCR no la leyó, o el banco no la trae), igual queremos conciliar el
-- comprobante que subió el vecino si el MONTO y la FECHA coinciden.
--
-- Diferencia clave con conciliar_auto (028): esto NO auto-aprueba. Solo PROPONE.
-- El comité ve la propuesta (foto del comprobante + casa) y aprueba/descarta.
--
-- Flujo:
--   1. Auto-conciliar corre conciliar_auto (rastreo) como hoy.
--   2. Para las filas del banco que quedaron sin match, llama sugerir_abono
--      (read-only) → devuelve los abonos pendientes CON comprobante cuyo monto
--      es exacto y cuya fecha (OCR, o de registro) cae dentro de ±3 días.
--   3. El comité aprueba → conciliar_confirmar liga la fila del banco a ESE abono
--      y lo aprueba (reusa resolver_transaccion, igual que el match único de 028).
--
-- Todo aditivo (2 funciones nuevas). No toca datos ni el flujo actual.
-- Ventana de fecha: ±3 días (Vibe Check Juan 2026-07-02). Monto SIEMPRE exacto.
-- =============================================================================

-- --- sugerir_abono: candidatos por monto+fecha (READ-ONLY, no muta nada) -------
-- Devuelve: { ok:true, dup:bool, candidatos:[{abono_id, house_id, casa, monto,
--             fecha_ocr, comprobante_url, created_at}] }
--   dup=true → esa fila del banco ya se importó (mismo comportamiento que 028).
CREATE OR REPLACE FUNCTION mifracc.sugerir_abono(
  p_monto      numeric,
  p_fecha      date,
  p_banco_hash text DEFAULT NULL,
  p_dias       int  DEFAULT 3
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'mifracc', 'auth'
AS $$
DECLARE
  v_col  uuid := mifracc.my_colonia_id();
  v_cands jsonb;
BEGIN
  IF NOT mifracc.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;

  -- dedup: esa fila del banco ya se importó
  IF p_banco_hash IS NOT NULL AND EXISTS (
       SELECT 1 FROM mifracc.transactions
        WHERE colonia_id = v_col AND banco_hash = p_banco_hash) THEN
    RETURN jsonb_build_object('ok', true, 'dup', true, 'candidatos', '[]'::jsonb);
  END IF;

  SELECT coalesce(jsonb_agg(c ORDER BY c->>'dist_dias'), '[]'::jsonb)
    INTO v_cands
  FROM (
    SELECT jsonb_build_object(
             'abono_id',        t.id,
             'house_id',        t.house_id,
             'casa',            h.numero,
             'monto',           t.monto,
             'fecha_ocr',       nullif(t.comprobante_ocr->>'fecha',''),
             'comprobante_url', t.comprobante_url,
             'created_at',      t.created_at,
             -- distancia en días respecto a la fecha del banco (para ordenar)
             'dist_dias', abs(
               coalesce(
                 CASE WHEN (t.comprobante_ocr->>'fecha') ~ '^\d{4}-\d{2}-\d{2}$'
                      THEN (t.comprobante_ocr->>'fecha')::date END,
                 (t.created_at AT TIME ZONE 'America/Mexico_City')::date
               ) - p_fecha)
           ) AS c
    FROM mifracc.transactions t
    JOIN mifracc.houses h ON h.id = t.house_id
    WHERE t.colonia_id = v_col
      AND t.tipo = 'abono'
      AND t.estado = 'pendiente'
      AND t.banco_hash IS NULL             -- aún no ligado a ninguna fila del banco
      AND t.comprobante_url IS NOT NULL    -- el vecino subió evidencia
      AND t.monto = p_monto                -- monto EXACTO
      AND abs(
            coalesce(
              CASE WHEN (t.comprobante_ocr->>'fecha') ~ '^\d{4}-\d{2}-\d{2}$'
                   THEN (t.comprobante_ocr->>'fecha')::date END,
              (t.created_at AT TIME ZONE 'America/Mexico_City')::date
            ) - p_fecha) <= p_dias         -- fecha dentro de ±p_dias
  ) q;

  RETURN jsonb_build_object('ok', true, 'dup', false, 'candidatos', v_cands);
END $$;

-- --- conciliar_confirmar: el comité aprueba UNA propuesta ---------------------
-- Liga la fila del banco al abono elegido y lo aprueba. Idempotente por estado.
CREATE OR REPLACE FUNCTION mifracc.conciliar_confirmar(
  p_abono_id   uuid,
  p_banco_hash text,
  p_fecha      date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'mifracc', 'auth'
AS $$
DECLARE
  v_col   uuid := mifracc.my_colonia_id();
  t       mifracc.transactions%ROWTYPE;
  v_num   text;
BEGIN
  IF NOT mifracc.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;

  -- dedup: esa fila del banco ya se importó (evita doble-ligar)
  IF p_banco_hash IS NOT NULL AND EXISTS (
       SELECT 1 FROM mifracc.transactions
        WHERE colonia_id = v_col AND banco_hash = p_banco_hash) THEN
    RETURN jsonb_build_object('ok', false, 'dup', true);
  END IF;

  SELECT * INTO t FROM mifracc.transactions
   WHERE id = p_abono_id FOR UPDATE;                 -- bloqueo anti-carrera
  IF NOT FOUND THEN RAISE EXCEPTION 'El abono no existe.'; END IF;
  IF t.colonia_id <> v_col THEN RAISE EXCEPTION 'El abono no es de tu colonia.'; END IF;
  IF t.tipo <> 'abono' OR t.estado <> 'pendiente' THEN
    RAISE EXCEPTION 'Ese abono ya no está pendiente.';
  END IF;

  UPDATE mifracc.transactions
     SET banco_hash = p_banco_hash,
         concepto = concepto || ' · conciliado banco '
                    || coalesce(p_fecha::text, to_char(now(),'YYYY-MM-DD'))
   WHERE id = p_abono_id;

  PERFORM mifracc.resolver_transaccion(p_abono_id, true);  -- aprueba + ajusta saldo

  SELECT numero INTO v_num FROM mifracc.houses WHERE id = t.house_id;
  RETURN jsonb_build_object('ok', true, 'abono_id', p_abono_id, 'casa', v_num);
END $$;

GRANT EXECUTE ON FUNCTION mifracc.sugerir_abono(numeric, date, text, int) TO authenticated;
GRANT EXECUTE ON FUNCTION mifracc.conciliar_confirmar(uuid, text, date) TO authenticated;
