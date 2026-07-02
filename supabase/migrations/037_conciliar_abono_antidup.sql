-- 037_conciliar_abono_antidup.sql — Candado anti-duplicado en conciliar_abono
-- =============================================================================
-- Problema (Juan, 2026-07-02): "Conciliar seleccionados" llamaba conciliar_abono,
-- que SIEMPRE insertaba un abono NUEVO desde la fila del banco, aunque el vecino
-- ya hubiera subido su comprobante para ese mismo pago → pago duplicado (pasó en
-- las casas 252, 161, 105).
--
-- Regla que pidió Juan: "solo se deberían poder conciliar los comprobantes que el
-- vecino ya subió". Solución: ANTES de crear un abono nuevo, conciliar_abono busca
-- un comprobante del vecino ya existente para ese pago (misma casa, mismo monto,
-- fecha ±3 días, con comprobante_url, sin banco_hash) y lo ENLAZA en vez de duplicar:
--   · comprobante 'pendiente' → lo aprueba (aplica saldo UNA vez) + liga banco_hash.
--   · comprobante 'aprobado'  → solo liga banco_hash (ya estaba contado, no re-aplica).
--   · sin comprobante previo  → crea el abono como antes (el vecino no subió nada,
--     el banco es la única evidencia — sigue siendo válido conciliarlo).
--
-- Se agrega el parámetro opcional p_fecha (fecha de la fila del banco) para acotar
-- el match. DROP + CREATE porque cambia la firma (5 → 6 args).
-- =============================================================================

DROP FUNCTION IF EXISTS vecino.conciliar_abono(uuid, numeric, text, text, text);

CREATE OR REPLACE FUNCTION vecino.conciliar_abono(
  p_house_id   uuid,
  p_monto      numeric,
  p_concepto   text,
  p_banco_hash text,
  p_ref_key    text DEFAULT NULL,
  p_fecha      date DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE
  v_col          uuid := vecino.my_colonia_id();
  v_id           uuid;
  v_match_id     uuid;
  v_match_estado vecino.approval_state;
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;
  IF p_house_id IS NULL THEN RAISE EXCEPTION 'Selecciona la casa.'; END IF;
  IF coalesce(p_monto,0) <= 0 THEN RAISE EXCEPTION 'El monto debe ser mayor a 0.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vecino.houses WHERE id = p_house_id AND colonia_id = v_col) THEN
    RAISE EXCEPTION 'La casa no pertenece a tu colonia.';
  END IF;

  -- Dedup: si esa fila del banco ya se importó, no la dupliques.
  IF p_banco_hash IS NOT NULL AND EXISTS (
       SELECT 1 FROM vecino.transactions
        WHERE colonia_id = v_col AND banco_hash = p_banco_hash) THEN
    RETURN jsonb_build_object('ok', false, 'dup', true);
  END IF;

  -- 🔒 CANDADO: ¿el vecino ya subió un comprobante para este pago? → enlázalo,
  -- no crees uno nuevo. (misma casa · mismo monto · ±3 días · con foto · sin banco)
  SELECT t.id, t.estado
    INTO v_match_id, v_match_estado
    FROM vecino.transactions t
   WHERE t.colonia_id = v_col
     AND t.house_id   = p_house_id
     AND t.tipo = 'abono'
     AND t.estado IN ('pendiente','aprobado')
     AND t.banco_hash IS NULL              -- aún no ligado a ninguna fila del banco
     AND t.comprobante_url IS NOT NULL     -- el vecino subió evidencia
     AND t.monto = p_monto                 -- monto EXACTO
     AND (p_fecha IS NULL OR abs(
           coalesce(
             CASE WHEN (t.comprobante_ocr->>'fecha') ~ '^\d{4}-\d{2}-\d{2}$'
                  THEN (t.comprobante_ocr->>'fecha')::date END,
             (t.created_at AT TIME ZONE 'America/Mexico_City')::date
           ) - p_fecha) <= 3)
   ORDER BY t.created_at DESC
   LIMIT 1;

  IF v_match_id IS NOT NULL THEN
    UPDATE vecino.transactions
       SET banco_hash = p_banco_hash,
           concepto = concepto || ' · conciliado banco '
                      || coalesce(p_fecha::text, to_char(now(),'YYYY-MM-DD'))
     WHERE id = v_match_id;
    IF v_match_estado = 'pendiente' THEN
      PERFORM vecino.resolver_transaccion(v_match_id, true);  -- aprueba + saldo (una vez)
    END IF;

    -- Aprende la referencia→casa igual que en el alta normal.
    IF p_ref_key IS NOT NULL AND btrim(p_ref_key) <> '' THEN
      INSERT INTO vecino.bank_ref_map (colonia_id, ref_key, house_id)
      VALUES (v_col, btrim(p_ref_key), p_house_id)
      ON CONFLICT (colonia_id, ref_key)
        DO UPDATE SET house_id = EXCLUDED.house_id,
                      veces = vecino.bank_ref_map.veces + 1,
                      updated_at = now();
    END IF;

    RETURN jsonb_build_object('ok', true, 'id', v_match_id, 'linked', true);
  END IF;

  -- Sin comprobante previo: crea el abono desde el banco (comportamiento original).
  INSERT INTO vecino.transactions (colonia_id, house_id, tipo, monto, concepto, estado, banco_hash)
  VALUES (v_col, p_house_id, 'abono', p_monto,
          coalesce(nullif(btrim(p_concepto), ''), 'Pago conciliado (banco)'),
          'pendiente', p_banco_hash)
  RETURNING id INTO v_id;

  PERFORM vecino.resolver_transaccion(v_id, true);  -- aprueba + ajusta saldo/estatus

  IF p_ref_key IS NOT NULL AND btrim(p_ref_key) <> '' THEN
    INSERT INTO vecino.bank_ref_map (colonia_id, ref_key, house_id)
    VALUES (v_col, btrim(p_ref_key), p_house_id)
    ON CONFLICT (colonia_id, ref_key)
      DO UPDATE SET house_id = EXCLUDED.house_id,
                    veces = vecino.bank_ref_map.veces + 1,
                    updated_at = now();
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', v_id, 'linked', false);
END $$;

GRANT EXECUTE ON FUNCTION vecino.conciliar_abono(uuid,numeric,text,text,text,date)
  TO authenticated, service_role;
