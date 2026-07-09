-- =============================================================================
-- 056_corregir_monto_abono.sql — El comité corrige el monto de un abono PENDIENTE
-- (Caso Juan 2026-07-09: casa 222 capturó $750 pero el comprobante dice $450)
-- =============================================================================
-- Solo abonos 'pendiente': antes de aprobar, el monto aún no tocó houses.saldo,
-- así que corregirlo es seguro (resolver_transaccion aplicará el monto ya
-- corregido). Deja rastro de auditoría en el concepto con el monto original.
-- Tras corregir, el cruce con el banco (abonos_pendientes_comite) se recalcula
-- solo en la siguiente carga — si ahora cuadra, sale la palomita.
-- =============================================================================

CREATE OR REPLACE FUNCTION vecino.corregir_monto_abono(
  p_id          uuid,
  p_nuevo_monto numeric,
  p_nota        text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE
  v_col uuid := vecino.my_colonia_id();
  t     vecino.transactions%ROWTYPE;
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;
  IF coalesce(p_nuevo_monto, 0) <= 0 THEN
    RAISE EXCEPTION 'El monto debe ser mayor a 0.';
  END IF;

  SELECT * INTO t FROM vecino.transactions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'El abono no existe.'; END IF;
  IF t.colonia_id <> v_col THEN RAISE EXCEPTION 'El abono no es de tu colonia.'; END IF;
  IF t.tipo <> 'abono' THEN RAISE EXCEPTION 'Solo se pueden corregir abonos.'; END IF;
  IF t.estado <> 'pendiente' THEN
    RAISE EXCEPTION 'Solo se puede corregir un abono pendiente (este ya está %).', t.estado;
  END IF;
  IF t.monto = p_nuevo_monto THEN
    RETURN jsonb_build_object('ok', true, 'sin_cambio', true, 'monto', t.monto);
  END IF;

  UPDATE vecino.transactions
     SET monto = p_nuevo_monto,
         concepto = concepto || ' · monto corregido de $' || t.monto::text
                    || ' a $' || p_nuevo_monto::text || ' por el comité'
                    || coalesce(' (' || nullif(btrim(p_nota), '') || ')', '')
   WHERE id = p_id;

  RETURN jsonb_build_object('ok', true, 'monto_anterior', t.monto,
                            'monto_nuevo', p_nuevo_monto);
END $$;
GRANT EXECUTE ON FUNCTION vecino.corregir_monto_abono(uuid, numeric, text) TO authenticated;
