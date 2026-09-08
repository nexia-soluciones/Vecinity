-- ============================================================
-- VECINITY · 012 — Pagos (abono del residente + aprobación del comité)
-- schema: mifracc · Supabase self-hosted Nexia
--
-- Paridad del Django viejo (libro mayor `transactions`: cargo/abono/ajuste).
-- El residente sube un comprobante y registra un ABONO 'pendiente'.
-- El comité aprueba/rechaza; al aprobar se ajusta houses.saldo (incremental,
-- como el legacy) y el estatus de la casa.
-- Bucket Storage `vecino-comprobantes` (público, paths uuid) creado aparte.
-- ============================================================

-- ------------------------------------------------------------
-- RPC: registrar abono (residente) → transacción 'abono' pendiente
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mifracc.registrar_abono(
  p_monto         numeric,
  p_comprobante_url text DEFAULT NULL,
  p_concepto      text DEFAULT 'Abono'
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
  -- anti-duplicado: mismo monto en los últimos 10 minutos
  IF EXISTS (
    SELECT 1 FROM mifracc.transactions
    WHERE house_id = v_house AND tipo = 'abono' AND monto = p_monto
      AND created_at > now() - interval '10 minutes'
  ) THEN
    RAISE EXCEPTION 'Ya registraste un abono por ese monto hace unos minutos.';
  END IF;

  INSERT INTO mifracc.transactions
    (colonia_id, house_id, tipo, monto, concepto, comprobante_url, estado)
  VALUES
    (v_col, v_house, 'abono', p_monto,
     coalesce(nullif(btrim(p_concepto),''),'Abono'), p_comprobante_url, 'pendiente')
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

-- ------------------------------------------------------------
-- RPC: resolver transacción (comité) → aprueba/rechaza + ajusta saldo
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mifracc.resolver_transaccion(
  p_id      uuid,
  p_aprobar boolean
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
DECLARE
  t       mifracc.transactions%ROWTYPE;
  v_delta numeric;
BEGIN
  IF NOT mifracc.is_admin() THEN
    RAISE EXCEPTION 'Solo el comité puede resolver transacciones.';
  END IF;
  SELECT * INTO t FROM mifracc.transactions WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'La transacción no existe.'; END IF;
  IF t.colonia_id <> mifracc.my_colonia_id() THEN
    RAISE EXCEPTION 'La transacción no es de tu colonia.';
  END IF;
  IF t.estado <> 'pendiente' THEN
    RAISE EXCEPTION 'Esa transacción ya fue resuelta.';
  END IF;

  IF p_aprobar THEN
    UPDATE mifracc.transactions SET estado = 'aprobado' WHERE id = p_id;
    -- abono baja el saldo; cargo/ajuste lo suben
    v_delta := CASE t.tipo WHEN 'abono' THEN -t.monto ELSE t.monto END;
    UPDATE mifracc.houses SET saldo = saldo + v_delta WHERE id = t.house_id;
    -- recalcular estatus (en_convenio manda)
    UPDATE mifracc.houses
       SET estatus = CASE
         WHEN estatus = 'en_convenio' THEN 'en_convenio'::mifracc.estatus_casa
         WHEN saldo > 0 THEN 'con_adeudo'::mifracc.estatus_casa
         ELSE 'al_corriente'::mifracc.estatus_casa END
     WHERE id = t.house_id;
  ELSE
    UPDATE mifracc.transactions SET estado = 'rechazado' WHERE id = p_id;
  END IF;

  RETURN jsonb_build_object('ok', true);
END $$;

GRANT EXECUTE ON FUNCTION mifracc.registrar_abono(numeric,text,text)   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION mifracc.resolver_transaccion(uuid,boolean)    TO authenticated, service_role;
