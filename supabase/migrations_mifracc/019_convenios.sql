-- ============================================================
-- VECINITY · 019 — Convenios de pago (morosos al corriente, seguimiento semanal)
-- schema: mifracc · Supabase self-hosted Nexia
--
-- Algunos morosos acuerdan una cantidad SEMANAL para ponerse al corriente,
-- pero el seguimiento es manual. Aquí: un convenio por casa (monto semanal +
-- deuda acordada) y un seguimiento automático: esperado (semanas × monto)
-- vs abonado (abonos aprobados desde que inició el convenio) → al día / atrasado.
-- ============================================================

CREATE TABLE IF NOT EXISTS mifracc.payment_plans (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id    uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  house_id      uuid NOT NULL REFERENCES mifracc.houses(id) ON DELETE CASCADE,
  monto_semanal numeric(10,2) NOT NULL,
  monto_acordado numeric(10,2),               -- deuda total a liquidar (opcional)
  saldo_inicial numeric(10,2),                -- saldo al iniciar el convenio
  nota          text,
  activo        boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES mifracc.profiles(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE mifracc.payment_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_plans_read  ON mifracc.payment_plans;
DROP POLICY IF EXISTS payment_plans_admin ON mifracc.payment_plans;
CREATE POLICY payment_plans_read ON mifracc.payment_plans FOR SELECT
  USING (colonia_id = mifracc.my_colonia_id());
CREATE POLICY payment_plans_admin ON mifracc.payment_plans FOR ALL
  USING (colonia_id = mifracc.my_colonia_id() AND mifracc.is_admin())
  WITH CHECK (colonia_id = mifracc.my_colonia_id() AND mifracc.is_admin());

CREATE INDEX IF NOT EXISTS idx_plans_colonia ON mifracc.payment_plans(colonia_id, activo);

-- crear convenio (comité) → marca la casa en_convenio
CREATE OR REPLACE FUNCTION mifracc.crear_convenio(
  p_house_id uuid, p_monto_semanal numeric, p_monto_acordado numeric DEFAULT NULL, p_nota text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
DECLARE v_col uuid := mifracc.my_colonia_id(); v_saldo numeric; v_id uuid;
BEGIN
  IF NOT mifracc.is_admin() THEN RAISE EXCEPTION 'Solo el comité puede crear convenios.'; END IF;
  IF p_monto_semanal IS NULL OR p_monto_semanal <= 0 THEN RAISE EXCEPTION 'Indica el monto semanal.'; END IF;
  SELECT saldo INTO v_saldo FROM mifracc.houses WHERE id = p_house_id AND colonia_id = v_col;
  IF NOT FOUND THEN RAISE EXCEPTION 'La casa no pertenece a tu colonia.'; END IF;
  IF EXISTS (SELECT 1 FROM mifracc.payment_plans WHERE house_id = p_house_id AND activo) THEN
    RAISE EXCEPTION 'Esa casa ya tiene un convenio activo.';
  END IF;
  INSERT INTO mifracc.payment_plans
    (colonia_id, house_id, monto_semanal, monto_acordado, saldo_inicial, nota, created_by)
  VALUES (v_col, p_house_id, p_monto_semanal, p_monto_acordado, v_saldo, nullif(btrim(p_nota),''), auth.uid())
  RETURNING id INTO v_id;
  UPDATE mifracc.houses SET estatus = 'en_convenio' WHERE id = p_house_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

-- cerrar convenio (comité) → recalcula estatus por saldo
CREATE OR REPLACE FUNCTION mifracc.cerrar_convenio(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
DECLARE pl mifracc.payment_plans%ROWTYPE;
BEGIN
  IF NOT mifracc.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;
  SELECT * INTO pl FROM mifracc.payment_plans WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'El convenio no existe.'; END IF;
  IF pl.colonia_id <> mifracc.my_colonia_id() THEN RAISE EXCEPTION 'No es de tu colonia.'; END IF;
  UPDATE mifracc.payment_plans SET activo = false WHERE id = p_id;
  UPDATE mifracc.houses
     SET estatus = CASE WHEN saldo > 0 THEN 'con_adeudo'::mifracc.estatus_casa
                        ELSE 'al_corriente'::mifracc.estatus_casa END
   WHERE id = pl.house_id;
  RETURN jsonb_build_object('ok', true);
END $$;

-- seguimiento de convenios activos: esperado vs abonado
CREATE OR REPLACE FUNCTION mifracc.convenios_seguimiento()
RETURNS TABLE (
  plan_id        uuid,
  house_id       uuid,
  casa           text,
  monto_semanal  numeric,
  monto_acordado numeric,
  saldo_actual   numeric,
  semanas        int,
  esperado       numeric,
  abonado        numeric,
  al_dia         boolean,
  created_at     timestamptz
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = mifracc, auth AS $$
  SELECT
    pl.id, pl.house_id, h.numero, pl.monto_semanal, pl.monto_acordado, h.saldo,
    GREATEST(0, floor(EXTRACT(EPOCH FROM (now() - pl.created_at)) / 604800))::int AS semanas,
    pl.monto_semanal * GREATEST(0, floor(EXTRACT(EPOCH FROM (now() - pl.created_at)) / 604800)) AS esperado,
    COALESCE((
      SELECT sum(t.monto) FROM mifracc.transactions t
      WHERE t.house_id = pl.house_id AND t.tipo = 'abono' AND t.estado = 'aprobado'
        AND t.created_at >= pl.created_at
    ), 0) AS abonado,
    COALESCE((
      SELECT sum(t.monto) FROM mifracc.transactions t
      WHERE t.house_id = pl.house_id AND t.tipo = 'abono' AND t.estado = 'aprobado'
        AND t.created_at >= pl.created_at
    ), 0) >= pl.monto_semanal * GREATEST(0, floor(EXTRACT(EPOCH FROM (now() - pl.created_at)) / 604800)) AS al_dia,
    pl.created_at
  FROM mifracc.payment_plans pl
  JOIN mifracc.houses h ON h.id = pl.house_id
  WHERE pl.activo AND pl.colonia_id = mifracc.my_colonia_id()
  ORDER BY al_dia ASC, h.numero
$$;

GRANT ALL ON mifracc.payment_plans TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION mifracc.crear_convenio(uuid,numeric,numeric,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION mifracc.cerrar_convenio(uuid)                     TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION mifracc.convenios_seguimiento()                   TO authenticated, service_role;
