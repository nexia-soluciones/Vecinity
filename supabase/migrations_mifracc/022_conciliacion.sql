-- ============================================================
-- VECINITY · 022 — Conciliación bancaria (ingresos → casa)
-- schema: mifracc · Supabase self-hosted Nexia
--
-- El comité sube el estado de cuenta (BBVA, Excel). Los ABONOS (ingresos)
-- no dicen qué casa pagó (la referencia SPEI es un folio del banco), así
-- que la asignación a casa es manual/asistida:
--   - bank_ref_map: mapeo APRENDIDO referencia→casa. Una vez que el comité
--     asigna una casa a un concepto, se recuerda y se autosugiere después.
--   - banco_hash: dedup para no reimportar la misma fila del banco.
--   - conciliar_abono: crea el abono y lo aprueba reusando resolver_transaccion
--     (que ajusta saldo + estatus). Decisión: aprobado directo (el banco ya confirmó).
-- ============================================================

-- Dedup: hash de la fila del banco ya importada (fecha|monto|concepto|saldo)
ALTER TABLE mifracc.transactions ADD COLUMN IF NOT EXISTS banco_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS transactions_banco_hash_uq
  ON mifracc.transactions (colonia_id, banco_hash) WHERE banco_hash IS NOT NULL;

-- Mapeo aprendido referencia→casa
CREATE TABLE IF NOT EXISTS mifracc.bank_ref_map (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id  uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  ref_key     text NOT NULL,
  house_id    uuid NOT NULL REFERENCES mifracc.houses(id) ON DELETE CASCADE,
  veces       int  NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (colonia_id, ref_key)
);
ALTER TABLE mifracc.bank_ref_map ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bank_ref_map_read  ON mifracc.bank_ref_map;
DROP POLICY IF EXISTS bank_ref_map_admin ON mifracc.bank_ref_map;
CREATE POLICY bank_ref_map_read ON mifracc.bank_ref_map FOR SELECT
  USING (colonia_id = mifracc.my_colonia_id());
CREATE POLICY bank_ref_map_admin ON mifracc.bank_ref_map FOR ALL
  USING (colonia_id = mifracc.my_colonia_id() AND mifracc.is_admin())
  WITH CHECK (colonia_id = mifracc.my_colonia_id() AND mifracc.is_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON mifracc.bank_ref_map TO authenticated, service_role;

-- Concilia un abono del banco a una casa (aprobado directo) + aprende el mapeo
CREATE OR REPLACE FUNCTION mifracc.conciliar_abono(
  p_house_id   uuid,
  p_monto      numeric,
  p_concepto   text,
  p_banco_hash text,
  p_ref_key    text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
DECLARE v_col uuid := mifracc.my_colonia_id(); v_id uuid;
BEGIN
  IF NOT mifracc.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;
  IF p_house_id IS NULL THEN RAISE EXCEPTION 'Selecciona la casa.'; END IF;
  IF coalesce(p_monto,0) <= 0 THEN RAISE EXCEPTION 'El monto debe ser mayor a 0.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM mifracc.houses WHERE id = p_house_id AND colonia_id = v_col) THEN
    RAISE EXCEPTION 'La casa no pertenece a tu colonia.';
  END IF;

  -- Dedup: si esa fila del banco ya se importó, no la dupliques.
  IF p_banco_hash IS NOT NULL AND EXISTS (
       SELECT 1 FROM mifracc.transactions
        WHERE colonia_id = v_col AND banco_hash = p_banco_hash) THEN
    RETURN jsonb_build_object('ok', false, 'dup', true);
  END IF;

  INSERT INTO mifracc.transactions (colonia_id, house_id, tipo, monto, concepto, estado, banco_hash)
  VALUES (v_col, p_house_id, 'abono', p_monto,
          coalesce(nullif(btrim(p_concepto), ''), 'Pago conciliado (banco)'),
          'pendiente', p_banco_hash)
  RETURNING id INTO v_id;

  PERFORM mifracc.resolver_transaccion(v_id, true);  -- aprueba + ajusta saldo/estatus

  -- Aprende: este concepto/referencia corresponde a esta casa.
  IF p_ref_key IS NOT NULL AND btrim(p_ref_key) <> '' THEN
    INSERT INTO mifracc.bank_ref_map (colonia_id, ref_key, house_id)
    VALUES (v_col, btrim(p_ref_key), p_house_id)
    ON CONFLICT (colonia_id, ref_key)
      DO UPDATE SET house_id = EXCLUDED.house_id,
                    veces = mifracc.bank_ref_map.veces + 1,
                    updated_at = now();
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

GRANT EXECUTE ON FUNCTION mifracc.conciliar_abono(uuid,numeric,text,text,text) TO authenticated, service_role;
