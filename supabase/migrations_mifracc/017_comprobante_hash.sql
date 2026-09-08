-- ============================================================
-- VECINITY · 017 — Anti-duplicado de comprobante por imagen (hash)
-- schema: mifracc · Supabase self-hosted Nexia
--
-- El legacy bloqueaba abonos por mismo monto en 10 min, pero el "mismo
-- comprobante subido dos veces" se detectaba a mano. Aquí se automatiza:
-- el cliente manda el SHA-256 del archivo; si ese comprobante ya existe
-- (en una transacción no rechazada), se rechaza solo.
-- ============================================================

ALTER TABLE mifracc.transactions
  ADD COLUMN IF NOT EXISTS comprobante_hash text;

CREATE INDEX IF NOT EXISTS idx_tx_comprobante_hash
  ON mifracc.transactions(colonia_id, comprobante_hash)
  WHERE comprobante_hash IS NOT NULL;

-- Reemplazar registrar_abono (ahora recibe el hash del comprobante)
DROP FUNCTION IF EXISTS mifracc.registrar_abono(numeric, text, text);

CREATE OR REPLACE FUNCTION mifracc.registrar_abono(
  p_monto            numeric,
  p_comprobante_url  text DEFAULT NULL,
  p_concepto         text DEFAULT 'Abono',
  p_comprobante_hash text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
DECLARE
  v_house uuid := mifracc.my_house_id();
  v_col   uuid := mifracc.my_colonia_id();
  v_id    uuid;
BEGIN
  IF v_house IS NULL THEN
    RAISE EXCEPTION 'Tu perfil no está ligado a una casa todavía.';
  END IF;
  IF p_monto IS NULL OR p_monto <= 0 THEN
    RAISE EXCEPTION 'El monto debe ser mayor a cero.';
  END IF;

  -- anti-duplicado 1: mismo monto en los últimos 10 minutos
  IF EXISTS (
    SELECT 1 FROM mifracc.transactions
    WHERE house_id = v_house AND tipo = 'abono' AND monto = p_monto
      AND created_at > now() - interval '10 minutes'
  ) THEN
    RAISE EXCEPTION 'Ya registraste un abono por ese monto hace unos minutos.';
  END IF;

  -- anti-duplicado 2: mismo COMPROBANTE (imagen) ya usado en la colonia
  IF p_comprobante_hash IS NOT NULL AND EXISTS (
    SELECT 1 FROM mifracc.transactions
    WHERE colonia_id = v_col AND comprobante_hash = p_comprobante_hash
      AND estado <> 'rechazado'
  ) THEN
    RAISE EXCEPTION 'Ese comprobante ya fue registrado antes.';
  END IF;

  INSERT INTO mifracc.transactions
    (colonia_id, house_id, tipo, monto, concepto, comprobante_url, comprobante_hash, estado)
  VALUES
    (v_col, v_house, 'abono', p_monto,
     coalesce(nullif(btrim(p_concepto),''),'Abono'), p_comprobante_url, p_comprobante_hash, 'pendiente')
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

GRANT EXECUTE ON FUNCTION mifracc.registrar_abono(numeric,text,text,text) TO authenticated, service_role;
