-- 030_dedup_rastreo.sql — Tercer candado anti-duplicado: por CLAVE DE RASTREO
-- =============================================================================
-- El hash de imagen solo caza el MISMO archivo. Si el vecino re-fotografía el
-- mismo recibo, el hash cambia y se cuela. La clave de rastreo (folio SPEI) es
-- ÚNICA por transferencia real → dedup robusto aunque cambie la imagen.
--
-- set_abono_ocr ahora, al guardar la clave de rastreo del comprobante recién
-- subido, verifica si otra transacción NO rechazada de la colonia ya la tiene.
-- Si sí → rechaza automáticamente el nuevo abono y avisa (duplicado=true).
-- =============================================================================

CREATE OR REPLACE FUNCTION mifracc.set_abono_ocr(p_id uuid, p_ocr jsonb, p_ref text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'mifracc', 'auth'
AS $$
DECLARE
  v_ref   text := nullif(mifracc._norm_ref(p_ref), '');
  v_col   uuid;
  v_house uuid := mifracc.my_house_id();
  v_rows  int;
BEGIN
  -- El abono debe ser del propio vecino y seguir pendiente.
  SELECT colonia_id INTO v_col
    FROM mifracc.transactions
   WHERE id = p_id AND tipo = 'abono' AND estado = 'pendiente' AND house_id = v_house;
  IF v_col IS NULL THEN
    RETURN jsonb_build_object('ok', false);
  END IF;

  -- Dedup por clave de rastreo (única por transferencia). Aunque re-fotografíe
  -- el recibo, la clave es la misma → esa transferencia ya se registró.
  IF v_ref IS NOT NULL AND length(v_ref) >= 6 AND EXISTS (
       SELECT 1 FROM mifracc.transactions
        WHERE colonia_id = v_col AND ref_rastreo = v_ref
          AND estado <> 'rechazado' AND id <> p_id
     ) THEN
    UPDATE mifracc.transactions
       SET estado = 'rechazado',
           comprobante_ocr = p_ocr,
           ref_rastreo = v_ref,
           concepto = concepto || ' · rechazado: transferencia ya registrada'
     WHERE id = p_id;
    RETURN jsonb_build_object('ok', false, 'duplicado', true);
  END IF;

  UPDATE mifracc.transactions
     SET comprobante_ocr = p_ocr, ref_rastreo = v_ref
   WHERE id = p_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('ok', v_rows > 0, 'duplicado', false);
END $$;
