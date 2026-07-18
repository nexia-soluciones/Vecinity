-- 084_comprobante_duplicado_liberacion.sql
-- =============================================================================
-- Cuando el vecino vuelve a subir la MISMA imagen de comprobante, el mensaje
-- ahora le explica que ya está "en proceso de liberación" (o ya aprobado) para
-- tranquilizarlo — antes decía sólo la fecha y la casa, sin contexto de estado.
-- Sigue sin duplicar el pago. Cambio de texto: no toca datos.
-- =============================================================================

CREATE OR REPLACE FUNCTION vecino.registrar_abono(
  p_monto numeric,
  p_comprobante_url text DEFAULT NULL::text,
  p_concepto text DEFAULT 'Abono'::text,
  p_comprobante_hash text DEFAULT NULL::text,
  p_house_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'vecino', 'auth'
AS $function$
DECLARE
  v_house      uuid := coalesce(p_house_id, vecino.my_house_id());
  v_col        uuid;
  v_id         uuid;
  v_dup_fecha  text;
  v_dup_estado text;
  v_dup_msg    text;
BEGIN
  IF v_house IS NULL THEN
    RAISE EXCEPTION 'Tu perfil no está ligado a una casa todavía.';
  END IF;
  IF v_house NOT IN (SELECT vecino.my_finance_house_ids()) THEN
    RAISE EXCEPTION 'No puedes registrar pagos de esa casa.';
  END IF;
  IF p_monto IS NULL OR p_monto <= 0 THEN
    RAISE EXCEPTION 'El monto debe ser mayor a cero.';
  END IF;

  SELECT colonia_id INTO v_col FROM vecino.houses WHERE id = v_house;

  -- anti-duplicado 1: mismo monto en los últimos 10 minutos
  IF EXISTS (
    SELECT 1 FROM vecino.transactions
    WHERE house_id = v_house AND tipo = 'abono' AND monto = p_monto
      AND created_at > now() - interval '10 minutes'
  ) THEN
    RAISE EXCEPTION 'Ya registraste un abono por ese monto hace unos minutos.';
  END IF;

  -- anti-duplicado 2: misma IMAGEN ya usada en la colonia → avisar en qué estado
  -- está (en revisión / aprobado) para que el vecino sepa que su pago ya va en camino.
  IF p_comprobante_hash IS NOT NULL THEN
    SELECT to_char(t.created_at AT TIME ZONE 'America/Mexico_City', 'DD/MM/YYYY'),
           t.estado
      INTO v_dup_fecha, v_dup_estado
      FROM vecino.transactions t
     WHERE t.colonia_id = v_col AND t.comprobante_hash = p_comprobante_hash
       AND t.estado <> 'rechazado'
     ORDER BY t.created_at
     LIMIT 1;
    IF v_dup_fecha IS NOT NULL THEN
      v_dup_msg := CASE
        WHEN v_dup_estado = 'aprobado'
          THEN format('Ese comprobante ya se subió el %s y tu pago ya fue aprobado. No se duplicó.', v_dup_fecha)
        ELSE format('Ese comprobante ya se subió el %s y está en proceso de liberación (el comité lo revisará). No se duplicó tu pago.', v_dup_fecha)
      END;
      RAISE EXCEPTION '%', v_dup_msg;
    END IF;
  END IF;

  INSERT INTO vecino.transactions
    (colonia_id, house_id, tipo, monto, concepto, comprobante_url, comprobante_hash, estado)
  VALUES
    (v_col, v_house, 'abono', p_monto,
     coalesce(nullif(btrim(p_concepto),''),'Abono'), p_comprobante_url, p_comprobante_hash, 'pendiente')
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $function$;
