-- 028_ocr_comprobantes.sql — OCR de comprobantes + auto-conciliación con el banco
-- =============================================================================
-- Idea (Juan): el vecino sube la foto de la transferencia → OCR extrae fecha,
-- monto, CLAVE DE RASTREO/folio y concepto. Esa clave aparece TAMBIÉN en el
-- concepto del estado de cuenta del banco → es la llave para unir automáticamente.
--
-- Flujo:
--   1. Vecino sube foto → registrar_abono (pendiente) → OCR → set_abono_ocr guarda
--      la data extraída + ref_rastreo en el abono.
--   2. Comité sube el Excel del banco → por cada fila, conciliar_auto busca un abono
--      pendiente cuya ref_rastreo esté contenida en el concepto del banco.
--      · Match único   → auto-aprueba ese abono (reconoce la casa sola) + liga banco_hash.
--      · Sin match / ambiguo → cae al flujo manual del comité (conciliar_abono existente).
--
-- Todo aditivo (columnas nuevas + funciones nuevas). No toca datos ni el flujo actual.
-- =============================================================================

-- --- Columnas nuevas en transactions -----------------------------------------
ALTER TABLE vecino.transactions
  ADD COLUMN IF NOT EXISTS comprobante_ocr jsonb,   -- data cruda extraída de la foto
  ADD COLUMN IF NOT EXISTS ref_rastreo text;        -- clave de rastreo/folio normalizada (llave de match)

-- Índice para el match por clave de rastreo (solo abonos que la tengan)
CREATE INDEX IF NOT EXISTS idx_tx_ref_rastreo
  ON vecino.transactions (colonia_id, ref_rastreo)
  WHERE ref_rastreo IS NOT NULL;

-- Normaliza una referencia: mayúsculas y sin caracteres no alfanuméricos
-- (las claves de rastreo se escriben con espacios/guiones distintos en cada banco).
CREATE OR REPLACE FUNCTION vecino._norm_ref(p text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$ SELECT upper(regexp_replace(coalesce(p,''), '[^A-Za-z0-9]', '', 'g')) $$;

-- --- set_abono_ocr: el vecino guarda la data OCR en SU abono pendiente ---------
CREATE OR REPLACE FUNCTION vecino.set_abono_ocr(p_id uuid, p_ocr jsonb, p_ref text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'vecino', 'auth'
AS $$
DECLARE v_rows int;
BEGIN
  UPDATE vecino.transactions
     SET comprobante_ocr = p_ocr,
         ref_rastreo = nullif(vecino._norm_ref(p_ref), '')
   WHERE id = p_id
     AND tipo = 'abono'
     AND estado = 'pendiente'
     AND house_id = vecino.my_house_id();   -- solo su propia casa
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('ok', v_rows > 0);
END $$;

-- --- conciliar_auto: intenta casar una fila del banco con un abono pendiente ---
-- Devuelve:
--   {ok:false, dup:true}                      → esa fila del banco ya se importó
--   {ok:true, matched:true, casa:'NNN', ...}  → auto-conciliado (abono aprobado)
--   {ok:true, matched:false, ambiguo:bool}    → no cuadró → lo resuelve el comité
CREATE OR REPLACE FUNCTION vecino.conciliar_auto(
  p_banco_hash text,
  p_banco_concepto text,
  p_monto numeric,
  p_fecha date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'vecino', 'auth'
AS $$
DECLARE
  v_col     uuid := vecino.my_colonia_id();
  v_refnorm text := vecino._norm_ref(p_banco_concepto);
  v_id      uuid;
  v_house   uuid;
  v_num     text;
  v_cnt     int;
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;

  -- dedup: esa fila del banco ya se importó
  IF p_banco_hash IS NOT NULL AND EXISTS (
       SELECT 1 FROM vecino.transactions
        WHERE colonia_id = v_col AND banco_hash = p_banco_hash) THEN
    RETURN jsonb_build_object('ok', false, 'dup', true);
  END IF;

  -- match fuerte: la clave de rastreo del comprobante está contenida en el concepto del banco
  WITH cand AS (
    SELECT t.id, t.house_id
    FROM vecino.transactions t
    WHERE t.colonia_id = v_col
      AND t.tipo = 'abono'
      AND t.estado = 'pendiente'
      AND t.ref_rastreo IS NOT NULL
      AND length(t.ref_rastreo) >= 6              -- evita falsos positivos con refs cortas
      AND position(t.ref_rastreo IN v_refnorm) > 0
      AND (p_monto IS NULL OR t.monto = p_monto)  -- si el monto cuadra, mejor; si el banco no lo da, no exige
  )
  SELECT count(*), (array_agg(id))[1], (array_agg(house_id))[1]
    INTO v_cnt, v_id, v_house FROM cand;

  IF v_cnt = 0 THEN
    RETURN jsonb_build_object('ok', true, 'matched', false, 'ambiguo', false);
  ELSIF v_cnt > 1 THEN
    RETURN jsonb_build_object('ok', true, 'matched', false, 'ambiguo', true);
  END IF;

  -- match único → ligar la fila del banco a ESE abono y aprobarlo (reconoce la casa sola)
  UPDATE vecino.transactions
     SET banco_hash = p_banco_hash,
         concepto = concepto || ' · conciliado banco ' || coalesce(p_fecha::text, to_char(now(),'YYYY-MM-DD'))
   WHERE id = v_id;
  PERFORM vecino.resolver_transaccion(v_id, true);  -- aprueba + ajusta saldo/estatus (con FOR UPDATE)

  SELECT numero INTO v_num FROM vecino.houses WHERE id = v_house;
  RETURN jsonb_build_object('ok', true, 'matched', true, 'abono_id', v_id, 'casa', v_num);
END $$;

GRANT EXECUTE ON FUNCTION vecino.set_abono_ocr(uuid, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION vecino.conciliar_auto(text, text, numeric, date) TO authenticated;
