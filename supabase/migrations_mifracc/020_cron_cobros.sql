-- ============================================================
-- VECINITY · 020 — Wrappers cron para n8n (cobros día 1 / recargos día 11)
-- schema: mifracc · Supabase self-hosted Nexia
--
-- n8n no tiene sesión de comité → no puede usar las RPC is_admin. Mismo
-- patrón que run_late_fee_notifications: funciones SECURITY DEFINER granted
-- solo a service_role; n8n las llama con la SERVICE KEY (credencial server-side).
-- Recorren TODAS las colonias. Idempotentes (no duplican el periodo).
-- La lógica de una colonia se factoriza en helpers reutilizados por el
-- botón del comité (is_admin) y por el cron (service_role).
-- ============================================================

-- ------------------------------------------------------------
-- Helpers por colonia (núcleo reutilizable)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mifracc._cobros_colonia(p_col uuid, p_periodo text)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
DECLARE v_cuota numeric; v_concepto text; v_n int := 0; rec record;
BEGIN
  SELECT cuota_mensual INTO v_cuota FROM mifracc.colonias WHERE id = p_col;
  IF v_cuota IS NULL OR v_cuota <= 0 THEN RETURN 0; END IF;
  v_concepto := 'Mantenimiento ' || p_periodo;
  FOR rec IN
    WITH ins AS (
      INSERT INTO mifracc.transactions (colonia_id, house_id, tipo, monto, concepto, estado)
      SELECT p_col, h.id, 'cargo', v_cuota, v_concepto, 'aprobado'
      FROM mifracc.houses h
      WHERE h.colonia_id = p_col
        AND NOT EXISTS (SELECT 1 FROM mifracc.transactions t
                        WHERE t.house_id = h.id AND t.concepto = v_concepto)
      RETURNING house_id
    ) SELECT house_id FROM ins
  LOOP
    UPDATE mifracc.houses SET saldo = saldo + v_cuota WHERE id = rec.house_id;
    v_n := v_n + 1;
  END LOOP;
  UPDATE mifracc.houses
     SET estatus = CASE
       WHEN estatus = 'en_convenio' THEN 'en_convenio'::mifracc.estatus_casa
       WHEN saldo > 0 THEN 'con_adeudo'::mifracc.estatus_casa
       ELSE 'al_corriente'::mifracc.estatus_casa END
   WHERE colonia_id = p_col;
  RETURN v_n;
END $$;

CREATE OR REPLACE FUNCTION mifracc._recargos_colonia(p_col uuid, p_periodo text)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
DECLARE v_recargo numeric; v_cuota_concepto text; v_rec_concepto text; v_n int := 0; rec record;
BEGIN
  SELECT recargo INTO v_recargo FROM mifracc.colonias WHERE id = p_col;
  IF v_recargo IS NULL OR v_recargo <= 0 THEN RETURN 0; END IF;
  v_cuota_concepto := 'Mantenimiento ' || p_periodo;
  v_rec_concepto   := 'Recargo ' || p_periodo;
  FOR rec IN
    WITH ins AS (
      INSERT INTO mifracc.transactions (colonia_id, house_id, tipo, monto, concepto, estado)
      SELECT p_col, h.id, 'cargo', v_recargo, v_rec_concepto, 'aprobado'
      FROM mifracc.houses h
      WHERE h.colonia_id = p_col AND h.saldo > 0
        AND EXISTS (SELECT 1 FROM mifracc.transactions t
                    WHERE t.house_id = h.id AND t.concepto = v_cuota_concepto)
        AND NOT EXISTS (SELECT 1 FROM mifracc.transactions t
                        WHERE t.house_id = h.id AND t.concepto = v_rec_concepto)
      RETURNING house_id
    ) SELECT house_id FROM ins
  LOOP
    UPDATE mifracc.houses SET saldo = saldo + v_recargo WHERE id = rec.house_id;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

-- ------------------------------------------------------------
-- RPC del comité (is_admin) reescritas para usar los helpers
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mifracc.generar_cobros_mensuales(p_periodo text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
DECLARE v_col uuid := mifracc.my_colonia_id(); v_periodo text; v_cuota numeric; v_n int;
BEGIN
  IF NOT mifracc.is_admin() THEN RAISE EXCEPTION 'Solo el comité puede generar cobros.'; END IF;
  v_periodo := COALESCE(nullif(btrim(p_periodo),''), to_char(now() AT TIME ZONE 'America/Mexico_City','YYYY-MM'));
  SELECT cuota_mensual INTO v_cuota FROM mifracc.colonias WHERE id = v_col;
  v_n := mifracc._cobros_colonia(v_col, v_periodo);
  RETURN jsonb_build_object('ok', true, 'periodo', v_periodo, 'cuota', v_cuota, 'casas_cobradas', v_n);
END $$;

CREATE OR REPLACE FUNCTION mifracc.aplicar_recargos(p_periodo text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
DECLARE v_col uuid := mifracc.my_colonia_id(); v_periodo text; v_recargo numeric; v_n int;
BEGIN
  IF NOT mifracc.is_admin() THEN RAISE EXCEPTION 'Solo el comité puede aplicar recargos.'; END IF;
  v_periodo := COALESCE(nullif(btrim(p_periodo),''), to_char(now() AT TIME ZONE 'America/Mexico_City','YYYY-MM'));
  SELECT recargo INTO v_recargo FROM mifracc.colonias WHERE id = v_col;
  v_n := mifracc._recargos_colonia(v_col, v_periodo);
  RETURN jsonb_build_object('ok', true, 'periodo', v_periodo, 'recargo', v_recargo, 'casas_recargadas', v_n);
END $$;

-- ------------------------------------------------------------
-- Wrappers CRON (token-gated; n8n los llama con ANON key + token,
-- mismo patrón que cron_late_fees). El token es un gate de baja
-- sensibilidad (también vive en el nodo n8n); repo privado.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mifracc.cron_generar_cobros(p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
DECLARE v_periodo text := to_char(now() AT TIME ZONE 'America/Mexico_City','YYYY-MM');
        c record; v_total int := 0; v_n int;
BEGIN
  IF p_token <> 'vcn_cron_7Kp2qXm9' THEN RAISE EXCEPTION 'Token inválido.'; END IF;
  FOR c IN SELECT id FROM mifracc.colonias LOOP
    v_n := mifracc._cobros_colonia(c.id, v_periodo);
    v_total := v_total + v_n;
    INSERT INTO mifracc.notifications(colonia_id, tipo, mensaje, canal, estado_envio, enviado_at)
    VALUES (c.id, 'cobros_mensuales', 'Cobros '||v_periodo||': '||v_n||' casas', 'telegram', 'enviado', now());
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'periodo', v_periodo, 'total', v_total);
END $$;

CREATE OR REPLACE FUNCTION mifracc.cron_aplicar_recargos(p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
DECLARE v_periodo text := to_char(now() AT TIME ZONE 'America/Mexico_City','YYYY-MM');
        c record; v_total int := 0; v_n int;
BEGIN
  IF p_token <> 'vcn_cron_7Kp2qXm9' THEN RAISE EXCEPTION 'Token inválido.'; END IF;
  FOR c IN SELECT id FROM mifracc.colonias LOOP
    v_n := mifracc._recargos_colonia(c.id, v_periodo);
    v_total := v_total + v_n;
    INSERT INTO mifracc.notifications(colonia_id, tipo, mensaje, canal, estado_envio, enviado_at)
    VALUES (c.id, 'recargos', 'Recargos '||v_periodo||': '||v_n||' casas', 'telegram', 'enviado', now());
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'periodo', v_periodo, 'total', v_total);
END $$;

-- los helpers internos solo service_role; el cron es SECURITY DEFINER (corre como owner)
REVOKE ALL ON FUNCTION mifracc._cobros_colonia(uuid,text)   FROM anon, authenticated;
REVOKE ALL ON FUNCTION mifracc._recargos_colonia(uuid,text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION mifracc._cobros_colonia(uuid,text)   TO service_role;
GRANT EXECUTE ON FUNCTION mifracc._recargos_colonia(uuid,text) TO service_role;
-- los wrappers cron: anon (n8n con anon key + token)
GRANT EXECUTE ON FUNCTION mifracc.cron_generar_cobros(text)   TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION mifracc.cron_aplicar_recargos(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION mifracc.generar_cobros_mensuales(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION mifracc.aplicar_recargos(text)         TO authenticated, service_role;
