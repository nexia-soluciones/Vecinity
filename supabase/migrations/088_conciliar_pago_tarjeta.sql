-- =============================================================================
-- 088_conciliar_pago_tarjeta.sql — El pago de tarjeta también resuelve el banco
-- (Vibe Check Juan 2026-07-18)
-- =============================================================================
-- 2º hueco de migr. 087: el cobro de tarjetas de acceso corre en PARALELO al de
-- mantenimiento (card_requests.pago_estado) y NUNCA tocaba vecino.bank_movs. Los
-- depósitos $150/$300/$450/$600 (múltiplos de 150 ≤ $600; la cuota de Catania es
-- $750) quedaban como "ingresos sin conciliar" en /conciliacion y — peor — el
-- comité podía ligarlos por error a un abono de mantenimiento (DOBLE CONTEO).
--
-- Fix: nuevo estado de banco 'tarjeta'. Al aprobar/conciliar un pago de tarjeta,
-- la fila del banco se marca 'tarjeta' (sale de pendientes, ya no se puede cruzar
-- contra mantenimiento). Dos direcciones:
--   (a) validar_pago_tarjeta(..., p_banco_hash) — el comité aprueba el
--       comprobante Y liga la fila del banco de una vez.
--   (b) marcar_mov_tarjeta(hash, card?) — desde /conciliacion, marcar un ingreso
--       como pago de tarjeta (con o sin ligarlo a una solicitud concreta).
-- + sugerir_banco_tarjeta(card) para proponer la fila del banco con evidencia.
--
-- Regla del negocio (Juan): un depósito puede cubrir VARIAS tarjetas (p.ej. $300
-- = 2 tarjetas de la misma casa) → card_requests.banco_hash NO es único; el
-- candado real es el estado de la fila del banco (una fila se marca 'tarjeta'
-- una sola vez). Todo aditivo; RLS por colonia intacto.
-- =============================================================================

-- --- 1. Nuevo estado de banco: 'tarjeta' -------------------------------------
ALTER TABLE vecino.bank_movs DROP CONSTRAINT IF EXISTS bank_movs_estado_check;
ALTER TABLE vecino.bank_movs ADD CONSTRAINT bank_movs_estado_check
  CHECK (estado IN ('pendiente','conciliado','gasto','descartado','tarjeta'));

-- --- 2. card_requests: qué fila del banco pagó esta tarjeta -------------------
--     Nullable, NO único (un depósito puede pagar varias tarjetas de la casa).
ALTER TABLE vecino.card_requests
  ADD COLUMN IF NOT EXISTS banco_hash text;
CREATE INDEX IF NOT EXISTS idx_card_requests_banco_hash
  ON vecino.card_requests (colonia_id, banco_hash) WHERE banco_hash IS NOT NULL;

-- --- 3. Helper interno: marca una fila del banco como pago de tarjeta ---------
--     SECURITY DEFINER, colonia ya validada por el llamador. Idempotente para el
--     bundle: si la fila ya está 'tarjeta' (2ª tarjeta del mismo depósito) no
--     falla. Rechaza ligar una fila ya usada por mantenimiento/gasto.
CREATE OR REPLACE FUNCTION vecino._resolver_mov_tarjeta(
  p_col uuid, p_banco_hash text, p_card_id uuid, p_nota text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino AS $$
DECLARE b vecino.bank_movs%ROWTYPE;
BEGIN
  SELECT * INTO b FROM vecino.bank_movs
   WHERE colonia_id = p_col AND banco_hash = p_banco_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ese movimiento del banco ya no está disponible (recarga la lista).';
  END IF;
  IF b.tipo <> 'abono' THEN
    RAISE EXCEPTION 'Esa fila del banco es un cargo, no un ingreso.';
  END IF;
  IF b.estado IN ('conciliado','gasto') THEN
    RAISE EXCEPTION 'Esa fila del banco ya está conciliada como % — no se puede marcar como tarjeta.', b.estado;
  END IF;
  -- 'pendiente' o 'descartado' → tarjeta; 'tarjeta' ya está (bundle) → no-op de estado.
  UPDATE vecino.bank_movs
     SET estado = 'tarjeta',
         resuelto_id = COALESCE(p_card_id, resuelto_id),
         resuelto_at = now(),
         nota = COALESCE(nullif(btrim(coalesce(p_nota,'')),''), nota)
   WHERE id = b.id;
END $$;

-- --- 4. validar_pago_tarjeta v2: liga la fila del banco al aprobar ------------
--     DROP la firma vieja (nuevo param con DEFAULT → sobrecarga ambigua en PostgREST).
DROP FUNCTION IF EXISTS vecino.validar_pago_tarjeta(uuid, boolean, text);
CREATE OR REPLACE FUNCTION vecino.validar_pago_tarjeta(
  p_id uuid, p_aprobar boolean, p_nota text DEFAULT NULL, p_banco_hash text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE
  r     vecino.card_requests%ROWTYPE;
  v_col uuid := vecino.my_colonia_id();
  v_hash text := nullif(btrim(coalesce(p_banco_hash,'')),'');
BEGIN
  IF NOT vecino.is_admin() THEN
    RAISE EXCEPTION 'Solo el comité puede validar pagos.';
  END IF;
  SELECT * INTO r FROM vecino.card_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR r.colonia_id <> v_col THEN
    RAISE EXCEPTION 'La solicitud no existe o no es de tu colonia.';
  END IF;
  IF r.pago_estado <> 'en_revision' THEN
    RAISE EXCEPTION 'Esta solicitud no tiene un comprobante por revisar.';
  END IF;
  IF NOT p_aprobar AND COALESCE(btrim(p_nota), '') = '' THEN
    RAISE EXCEPTION 'Indica el motivo del rechazo del pago.';
  END IF;

  UPDATE vecino.card_requests
     SET pago_estado = CASE WHEN p_aprobar THEN 'aprobado' ELSE 'rechazado' END,
         pago_validado_by = auth.uid(), pago_validado_at = now(),
         pago_motivo_rechazo = CASE WHEN p_aprobar THEN NULL ELSE btrim(p_nota) END,
         banco_hash = CASE WHEN p_aprobar AND v_hash IS NOT NULL THEN v_hash ELSE banco_hash END
   WHERE id = p_id;

  -- Al aprobar con evidencia bancaria: la fila del banco queda 'tarjeta'.
  IF p_aprobar AND v_hash IS NOT NULL THEN
    PERFORM vecino._resolver_mov_tarjeta(v_col, v_hash, p_id,
      'Pago de tarjeta validado por el comité');
  END IF;

  RETURN jsonb_build_object('ok', true,
    'pago_estado', CASE WHEN p_aprobar THEN 'aprobado' ELSE 'rechazado' END,
    'banco_ligado', p_aprobar AND v_hash IS NOT NULL);
END $$;
GRANT EXECUTE ON FUNCTION vecino.validar_pago_tarjeta(uuid, boolean, text, text) TO authenticated;

-- --- 5. marcar_mov_tarjeta: desde /conciliacion --------------------------------
--     Marca un ingreso del banco como pago de tarjeta. Opcional: liga y aprueba
--     una solicitud concreta de la casa (si el comité la señala).
CREATE OR REPLACE FUNCTION vecino.marcar_mov_tarjeta(
  p_banco_hash text, p_card_id uuid DEFAULT NULL, p_nota text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE
  v_col uuid := vecino.my_colonia_id();
  r     vecino.card_requests%ROWTYPE;
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;

  IF p_card_id IS NOT NULL THEN
    SELECT * INTO r FROM vecino.card_requests WHERE id = p_card_id FOR UPDATE;
    IF NOT FOUND OR r.colonia_id <> v_col THEN
      RAISE EXCEPTION 'La solicitud de tarjeta no existe o no es de tu colonia.';
    END IF;
    IF r.estado IN ('cancelada','rechazada') THEN
      RAISE EXCEPTION 'Esa solicitud de tarjeta está cancelada/rechazada.';
    END IF;
    -- Ligar el banco vale como comprobante: aprueba el pago si aún no lo estaba.
    UPDATE vecino.card_requests
       SET banco_hash = p_banco_hash,
           pago_estado = CASE WHEN pago_estado IN ('pendiente','en_revision','rechazado')
                              THEN 'aprobado' ELSE pago_estado END,
           pago_validado_by = CASE WHEN pago_estado IN ('pendiente','en_revision','rechazado')
                                   THEN auth.uid() ELSE pago_validado_by END,
           pago_validado_at = CASE WHEN pago_estado IN ('pendiente','en_revision','rechazado')
                                   THEN now() ELSE pago_validado_at END,
           pago_motivo_rechazo = NULL
     WHERE id = p_card_id;
  END IF;

  PERFORM vecino._resolver_mov_tarjeta(v_col, p_banco_hash, p_card_id,
    coalesce(nullif(btrim(coalesce(p_nota,'')),''), 'Ingreso marcado como pago de tarjeta'));

  RETURN jsonb_build_object('ok', true, 'card_ligada', p_card_id IS NOT NULL);
END $$;
GRANT EXECUTE ON FUNCTION vecino.marcar_mov_tarjeta(text, uuid, text) TO authenticated;

-- --- 6. sugerir_banco_tarjeta: candidatos del banco para UNA solicitud ---------
--     Ingresos pendientes cuyo monto CUBRE el costo de la tarjeta (monto exacto,
--     o monto ≥ costo por si el depósito trae varias). Ranking: casa mencionada
--     en el concepto → pista de tarjeta → cercanía de fecha. Solo múltiplos ≤600
--     que huelan a tarjeta (evita ofrecer la cuota de $750 de mantenimiento).
CREATE OR REPLACE FUNCTION vecino.sugerir_banco_tarjeta(p_card_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE
  v_col  uuid := vecino.my_colonia_id();
  r      vecino.card_requests%ROWTYPE;
  v_casa text;
  v_out  jsonb;
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;
  SELECT * INTO r FROM vecino.card_requests WHERE id = p_card_id AND colonia_id = v_col;
  IF NOT FOUND THEN RAISE EXCEPTION 'La solicitud no existe o no es de tu colonia.'; END IF;
  SELECT numero INTO v_casa FROM vecino.houses WHERE id = r.house_id;

  SELECT coalesce(jsonb_agg(fila ORDER BY (fila->>'orden')::int, (fila->>'dist')::int), '[]'::jsonb)
    INTO v_out
  FROM (
    SELECT jsonb_build_object(
      'banco_hash', b.banco_hash,
      'fecha',      b.fecha,
      'monto',      b.monto,
      'concepto',   b.concepto,
      'casa_ok',    (cb.num = v_casa),
      'pista',      (b.concepto ~* 'tarjeta|tac|tj|placa|acceso|credencial|adicional|tag|corbat'),
      'orden', CASE
                 WHEN cb.num = v_casa THEN 0
                 WHEN b.concepto ~* 'tarjeta|tac|tj|placa|acceso|credencial|adicional|tag|corbat' THEN 1
                 ELSE 2 END,
      'dist', abs(b.fecha - (r.created_at AT TIME ZONE 'America/Mexico_City')::date)
    ) AS fila
    FROM vecino.bank_movs b
    LEFT JOIN LATERAL (
      SELECT (regexp_match(upper(regexp_replace(b.concepto, '\d{4,}', ' ', 'g')),
              '\mC(?:ASA)?\s*(\d{1,3})\M'))[1] AS num
    ) cb ON true
    WHERE b.colonia_id = v_col AND b.tipo = 'abono' AND b.estado = 'pendiente'
      AND b.monto = COALESCE(r.costo_estimado, 0)          -- monto exacto de la tarjeta
      AND (b.monto::int % 150 = 0) AND b.monto <= 600        -- descarta cuota $750
      -- si el concepto menciona OTRA casa válida, no la ofrezcas
      AND NOT (cb.num IS NOT NULL AND cb.num <> v_casa
               AND EXISTS (SELECT 1 FROM vecino.houses hx
                            WHERE hx.colonia_id = v_col AND hx.numero = cb.num))
  ) q;

  RETURN v_out;
END $$;
GRANT EXECUTE ON FUNCTION vecino.sugerir_banco_tarjeta(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
