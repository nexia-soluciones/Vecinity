-- 038_registrar_abono_admin.sql — El comité registra el pago de un vecino
-- =============================================================================
-- Caso (Juan, 2026-07-02): vecinos (sobre todo mayores) no pueden subir su
-- comprobante y se lo mandan al comité por WhatsApp. Antes Juan ENTRABA a la
-- cuenta del vecino para subirlo (mala práctica). Esta RPC deja que el comité lo
-- registre desde SU sesión, para cualquier casa de su colonia.
--
-- Igual que registrar_abono (017) pero: recibe p_house_id, exige is_admin, y lo
-- deja APROBADO directo (el comité tiene el comprobante en mano y lo está
-- registrando a propósito) → aplica saldo de una vez con resolver_transaccion.
--
-- Doble candado anti-duplicado: por hash del archivo Y por clave de rastreo
-- (evita registrar dos veces el mismo pago aunque re-fotografíen el recibo).
-- Aditivo: función nueva, no toca nada existente.
-- =============================================================================

CREATE OR REPLACE FUNCTION vecino.registrar_abono_admin(
  p_house_id        uuid,
  p_monto           numeric,
  p_concepto        text,
  p_comprobante_url  text  DEFAULT NULL,
  p_comprobante_hash text  DEFAULT NULL,
  p_ocr             jsonb DEFAULT NULL,
  p_ref             text  DEFAULT NULL,
  p_fecha           date  DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE
  v_col uuid := vecino.my_colonia_id();
  v_id  uuid;
  v_ref text := nullif(vecino._norm_ref(p_ref), '');
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;
  IF p_house_id IS NULL THEN RAISE EXCEPTION 'Selecciona la casa.'; END IF;
  IF coalesce(p_monto,0) <= 0 THEN RAISE EXCEPTION 'El monto debe ser mayor a 0.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vecino.houses WHERE id = p_house_id AND colonia_id = v_col) THEN
    RAISE EXCEPTION 'La casa no pertenece a tu colonia.';
  END IF;

  -- dedup por archivo: el mismo comprobante ya se registró para esta casa
  IF p_comprobante_hash IS NOT NULL AND EXISTS (
       SELECT 1 FROM vecino.transactions
        WHERE house_id = p_house_id AND comprobante_hash = p_comprobante_hash) THEN
    RETURN jsonb_build_object('ok', false, 'dup', true);
  END IF;

  -- dedup por clave de rastreo: ese pago ya está en la colonia (aunque sea otra foto)
  IF v_ref IS NOT NULL AND length(v_ref) >= 6 AND EXISTS (
       SELECT 1 FROM vecino.transactions
        WHERE colonia_id = v_col AND ref_rastreo = v_ref AND estado <> 'rechazado') THEN
    RETURN jsonb_build_object('ok', false, 'dup_ref', true);
  END IF;

  INSERT INTO vecino.transactions
    (colonia_id, house_id, tipo, monto, concepto, estado,
     comprobante_url, comprobante_hash, comprobante_ocr, ref_rastreo, created_at)
  VALUES (v_col, p_house_id, 'abono', p_monto,
          coalesce(nullif(btrim(p_concepto), ''), 'Pago registrado por el comité'),
          'pendiente', p_comprobante_url, p_comprobante_hash, p_ocr, v_ref,
          coalesce(p_fecha::timestamptz, now()))
  RETURNING id INTO v_id;

  PERFORM vecino.resolver_transaccion(v_id, true);  -- aprueba + aplica saldo/estatus
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

GRANT EXECUTE ON FUNCTION vecino.registrar_abono_admin(uuid,numeric,text,text,text,jsonb,text,date)
  TO authenticated, service_role;
