-- ============================================================
-- VECINITY · 026 — OCR de placas en la caseta (visitas)
-- schema: mifracc · Supabase self-hosted Nexia
--
-- Cuando el guardia toma la foto de placas al registrar una visita, una
-- Server Action lee la placa con visión de Claude y llama set_visita_plate.
-- Los visitantes son externos (no están en `vehicles`): el valor es capturar
-- la placa para la bitácora y cotejarla con lo que el guardia escribió.
--   plate_detected → placa "de registro" (la que escribió el guardia, si la hubo).
--   plate_ocr      → lectura cruda del OCR (para verificar / auto-llenar).
-- ============================================================

ALTER TABLE mifracc.visitors
  ADD COLUMN IF NOT EXISTS plate_ocr            text,
  ADD COLUMN IF NOT EXISTS plate_ocr_confidence numeric;

-- Guarda la lectura OCR en una visita; si no había placa de registro, la
-- auto-llena con el OCR. Devuelve si coincide con lo que escribió el guardia.
CREATE OR REPLACE FUNCTION mifracc.set_visita_plate(
  p_id         uuid,
  p_plate      text,
  p_confidence numeric DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
DECLARE v mifracc.visitors%ROWTYPE; v_ocr text; v_match boolean;
BEGIN
  IF NOT mifracc.is_guard() THEN RAISE EXCEPTION 'Solo el personal de vigilancia.'; END IF;
  SELECT * INTO v FROM mifracc.visitors WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'La visita no existe.'; END IF;
  IF v.colonia_id <> mifracc.my_colonia_id() THEN RAISE EXCEPTION 'La visita no es de tu colonia.'; END IF;

  v_ocr := nullif(mifracc._norm_placa(p_plate), '');
  v_match := v_ocr IS NOT NULL
         AND v.plate_detected IS NOT NULL
         AND mifracc._norm_placa(v.plate_detected) = v_ocr;

  UPDATE mifracc.visitors
     SET plate_ocr = upper(btrim(p_plate)),
         plate_ocr_confidence = p_confidence,
         -- auto-llena la placa de registro si venía vacía
         plate_detected = coalesce(nullif(btrim(plate_detected), ''), nullif(upper(btrim(p_plate)), ''))
   WHERE id = p_id;

  RETURN jsonb_build_object(
    'ok', true,
    'plate_ocr', upper(btrim(p_plate)),
    'tenia_placa', (v.plate_detected IS NOT NULL AND btrim(v.plate_detected) <> ''),
    'match', v_match
  );
END $$;

GRANT EXECUTE ON FUNCTION mifracc.set_visita_plate(uuid,text,numeric) TO authenticated, service_role;
