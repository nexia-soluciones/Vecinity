-- ============================================================
-- 054 — Gestión de multas desde el panel del comité
--
-- Dos RPCs para el módulo /dashboard/multas:
--   · corregir_multa  — cambia el monto de una multa ya aplicada.
--   · cancelar_multa  — cancela la multa y revierte el cargo del saldo.
--
-- Una multa aplicada vive en TRES lugares a la vez:
--   incident_reports (estado='multa', monto_multa, transaction_id)
--   transactions     (el cargo 'Multa: …', estado='aprobado')
--   houses.saldo     (ya sumó el monto)
-- Ambas RPCs mantienen los tres consistentes en una sola transacción.
-- ============================================================

-- ------------------------------------------------------------
-- corregir_multa: ajusta el monto del incident + su cargo + el saldo
-- de la casa por la diferencia. Invalida la resolución oficial para
-- que se regenere con el monto nuevo.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.corregir_multa(
  p_incident_id uuid,
  p_nuevo_monto numeric,
  p_nota        text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE
  r       vecino.incident_reports%ROWTYPE;
  t       vecino.transactions%ROWTYPE;
  v_tope  numeric;
  v_delta numeric;
  v_saldo numeric;
BEGIN
  IF NOT vecino.is_admin() THEN
    RAISE EXCEPTION 'Solo el comité puede corregir multas.';
  END IF;

  SELECT * INTO r FROM vecino.incident_reports WHERE id = p_incident_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'La multa no existe.'; END IF;
  IF r.colonia_id <> vecino.my_colonia_id() THEN
    RAISE EXCEPTION 'La multa no es de tu colonia.';
  END IF;
  IF r.estado <> 'multa' OR r.transaction_id IS NULL THEN
    RAISE EXCEPTION 'Solo se puede corregir una multa aplicada.';
  END IF;

  IF p_nuevo_monto IS NULL OR p_nuevo_monto <= 0 THEN
    RAISE EXCEPTION 'Indica el monto corregido (mayor a 0). Para eliminarla usa cancelar.';
  END IF;
  SELECT tope_multa INTO v_tope FROM vecino.colonias WHERE id = r.colonia_id;
  IF v_tope IS NOT NULL AND p_nuevo_monto > v_tope THEN
    RAISE EXCEPTION 'La multa no puede exceder el tope de $%.', to_char(v_tope,'FM999G999D00');
  END IF;

  SELECT * INTO t FROM vecino.transactions WHERE id = r.transaction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No existe el cargo ligado a esta multa.'; END IF;
  IF t.monto = p_nuevo_monto THEN
    RAISE EXCEPTION 'El monto ya es $%.', to_char(t.monto,'FM999G999D00');
  END IF;

  v_delta := p_nuevo_monto - t.monto;
  UPDATE vecino.transactions SET monto = p_nuevo_monto WHERE id = t.id;

  -- El saldo solo refleja cargos aprobados.
  IF t.estado = 'aprobado' THEN
    UPDATE vecino.houses SET saldo = saldo + v_delta WHERE id = r.infractor_house_id;
    UPDATE vecino.houses
       SET estatus = CASE
         WHEN estatus = 'en_convenio' THEN 'en_convenio'::vecino.estatus_casa
         WHEN saldo > 0 THEN 'con_adeudo'::vecino.estatus_casa
         ELSE 'al_corriente'::vecino.estatus_casa END
     WHERE id = r.infractor_house_id;
  END IF;

  UPDATE vecino.incident_reports
     SET monto_multa      = p_nuevo_monto,
         resolucion_admin = btrim(concat_ws(' · ',
             nullif(btrim(coalesce(resolucion_admin,'')),''),
             'Monto corregido de $' || to_char(t.monto,'FM999G999D00')
               || ' a $' || to_char(p_nuevo_monto,'FM999G999D00')
               || coalesce(': ' || nullif(btrim(p_nota),''), ''))),
         -- La resolución oficial menciona el monto viejo: se regenera al abrirla.
         resolucion_oficial     = NULL,
         resolucion_generada_at = NULL
   WHERE id = p_incident_id;

  SELECT saldo INTO v_saldo FROM vecino.houses WHERE id = r.infractor_house_id;
  RETURN jsonb_build_object('ok', true, 'monto_anterior', t.monto,
                            'monto_nuevo', p_nuevo_monto, 'saldo_casa', v_saldo);
END $$;

-- ------------------------------------------------------------
-- cancelar_multa: el cargo pasa a 'rechazado' (queda en el historial
-- tachado, con su monto original para auditoría), el saldo de la casa
-- se revierte y el incident queda 'rechazado' con el motivo. Si la
-- multa ya se había pagado, la casa queda con saldo a favor.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.cancelar_multa(
  p_incident_id uuid,
  p_nota        text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE
  r       vecino.incident_reports%ROWTYPE;
  t       vecino.transactions%ROWTYPE;
  v_saldo numeric;
BEGIN
  IF NOT vecino.is_admin() THEN
    RAISE EXCEPTION 'Solo el comité puede cancelar multas.';
  END IF;
  IF nullif(btrim(p_nota),'') IS NULL THEN
    RAISE EXCEPTION 'Indica el motivo de la cancelación.';
  END IF;

  SELECT * INTO r FROM vecino.incident_reports WHERE id = p_incident_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'La multa no existe.'; END IF;
  IF r.colonia_id <> vecino.my_colonia_id() THEN
    RAISE EXCEPTION 'La multa no es de tu colonia.';
  END IF;
  IF r.estado <> 'multa' OR r.transaction_id IS NULL THEN
    RAISE EXCEPTION 'Esa multa ya no está activa.';
  END IF;

  SELECT * INTO t FROM vecino.transactions WHERE id = r.transaction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No existe el cargo ligado a esta multa.'; END IF;

  UPDATE vecino.transactions SET estado = 'rechazado' WHERE id = t.id;

  IF t.estado = 'aprobado' THEN
    UPDATE vecino.houses SET saldo = saldo - t.monto WHERE id = r.infractor_house_id;
    UPDATE vecino.houses
       SET estatus = CASE
         WHEN estatus = 'en_convenio' THEN 'en_convenio'::vecino.estatus_casa
         WHEN saldo > 0 THEN 'con_adeudo'::vecino.estatus_casa
         ELSE 'al_corriente'::vecino.estatus_casa END
     WHERE id = r.infractor_house_id;
  END IF;

  UPDATE vecino.incident_reports
     SET estado           = 'rechazado',
         resolucion_admin = btrim(concat_ws(' · ',
             nullif(btrim(coalesce(resolucion_admin,'')),''),
             'Multa de $' || to_char(t.monto,'FM999G999D00')
               || ' cancelada: ' || btrim(p_nota))),
         -- Texto determinista para que el vecino vea la cancelación en su resolución.
         resolucion_oficial = '# Multa cancelada' || E'\n\n'
             || 'El Comité de Administración canceló esta multa el '
             || to_char(now() AT TIME ZONE 'America/Mexico_City', 'DD/MM/YYYY') || '.'
             || E'\n\n> ' || btrim(p_nota),
         resolucion_generada_at = now(),
         resolved_at = now(),
         resolved_by = auth.uid()
   WHERE id = p_incident_id;

  SELECT saldo INTO v_saldo FROM vecino.houses WHERE id = r.infractor_house_id;
  RETURN jsonb_build_object('ok', true, 'monto_cancelado', t.monto, 'saldo_casa', v_saldo);
END $$;

GRANT EXECUTE ON FUNCTION vecino.corregir_multa(uuid, numeric, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.cancelar_multa(uuid, text)          TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
