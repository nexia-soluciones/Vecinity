-- ============================================================
-- VECINITY · 018 — Cobros mensuales + recargo por pago tardío
-- schema: mifracc · Supabase self-hosted Nexia
--
-- (A) generar_cobros_mensuales(periodo): CARGO de la cuota a cada casa
--     (idempotente por periodo). cuota = colonias.cuota_mensual ($750).
-- (B) aplicar_recargos(periodo): a las casas que siguen debiendo después
--     del día límite, agrega un CARGO de recargo (colonias.recargo $100).
-- Ambas: solo comité. Pensadas para correr el día 1 (cobros) y el día
-- siguiente al límite (recargos), vía botón o n8n scheduleTrigger.
-- ============================================================

-- ------------------------------------------------------------
-- (A) Generar cobros mensuales
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mifracc.generar_cobros_mensuales(p_periodo text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
DECLARE
  v_col      uuid := mifracc.my_colonia_id();
  v_cuota    numeric;
  v_periodo  text := COALESCE(nullif(btrim(p_periodo),''),
                              to_char(now() AT TIME ZONE 'America/Mexico_City','YYYY-MM'));
  v_concepto text;
  v_n        int := 0;
  rec        record;
BEGIN
  IF NOT mifracc.is_admin() THEN RAISE EXCEPTION 'Solo el comité puede generar cobros.'; END IF;
  SELECT cuota_mensual INTO v_cuota FROM mifracc.colonias WHERE id = v_col;
  IF v_cuota IS NULL OR v_cuota <= 0 THEN RAISE EXCEPTION 'La cuota mensual no está configurada.'; END IF;
  v_concepto := 'Mantenimiento ' || v_periodo;

  FOR rec IN
    WITH ins AS (
      INSERT INTO mifracc.transactions (colonia_id, house_id, tipo, monto, concepto, estado)
      SELECT v_col, h.id, 'cargo', v_cuota, v_concepto, 'aprobado'
      FROM mifracc.houses h
      WHERE h.colonia_id = v_col
        AND NOT EXISTS (
          SELECT 1 FROM mifracc.transactions t
          WHERE t.house_id = h.id AND t.concepto = v_concepto
        )
      RETURNING house_id
    )
    SELECT house_id FROM ins
  LOOP
    UPDATE mifracc.houses SET saldo = saldo + v_cuota WHERE id = rec.house_id;
    v_n := v_n + 1;
  END LOOP;

  -- recalcular estatus de la colonia
  UPDATE mifracc.houses
     SET estatus = CASE
       WHEN estatus = 'en_convenio' THEN 'en_convenio'::mifracc.estatus_casa
       WHEN saldo > 0 THEN 'con_adeudo'::mifracc.estatus_casa
       ELSE 'al_corriente'::mifracc.estatus_casa END
   WHERE colonia_id = v_col;

  RETURN jsonb_build_object('ok', true, 'periodo', v_periodo, 'cuota', v_cuota,
                            'casas_cobradas', v_n);
END $$;

-- ------------------------------------------------------------
-- (B) Aplicar recargos por pago tardío
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mifracc.aplicar_recargos(p_periodo text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
DECLARE
  v_col      uuid := mifracc.my_colonia_id();
  v_recargo  numeric;
  v_periodo  text := COALESCE(nullif(btrim(p_periodo),''),
                              to_char(now() AT TIME ZONE 'America/Mexico_City','YYYY-MM'));
  v_cuota_concepto text;
  v_rec_concepto   text;
  v_n        int := 0;
  rec        record;
BEGIN
  IF NOT mifracc.is_admin() THEN RAISE EXCEPTION 'Solo el comité puede aplicar recargos.'; END IF;
  SELECT recargo INTO v_recargo FROM mifracc.colonias WHERE id = v_col;
  IF v_recargo IS NULL OR v_recargo <= 0 THEN RAISE EXCEPTION 'El recargo no está configurado.'; END IF;
  v_cuota_concepto := 'Mantenimiento ' || v_periodo;
  v_rec_concepto   := 'Recargo ' || v_periodo;

  FOR rec IN
    WITH ins AS (
      INSERT INTO mifracc.transactions (colonia_id, house_id, tipo, monto, concepto, estado)
      SELECT v_col, h.id, 'cargo', v_recargo, v_rec_concepto, 'aprobado'
      FROM mifracc.houses h
      WHERE h.colonia_id = v_col
        AND h.saldo > 0                                   -- sigue debiendo
        AND EXISTS (SELECT 1 FROM mifracc.transactions t    -- se le cobró ese mes
                    WHERE t.house_id = h.id AND t.concepto = v_cuota_concepto)
        AND NOT EXISTS (SELECT 1 FROM mifracc.transactions t -- aún no tiene recargo del mes
                        WHERE t.house_id = h.id AND t.concepto = v_rec_concepto)
      RETURNING house_id
    )
    SELECT house_id FROM ins
  LOOP
    UPDATE mifracc.houses SET saldo = saldo + v_recargo WHERE id = rec.house_id;
    v_n := v_n + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'periodo', v_periodo, 'recargo', v_recargo,
                            'casas_recargadas', v_n);
END $$;

GRANT EXECUTE ON FUNCTION mifracc.generar_cobros_mensuales(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION mifracc.aplicar_recargos(text)         TO authenticated, service_role;
