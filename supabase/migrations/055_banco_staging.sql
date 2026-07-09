-- =============================================================================
-- 055_banco_staging.sql — Estado de cuenta persistente + cobertura + dedup con
--                         contexto + palomita "encontrado en el banco"
-- (Vibe Check Juan 2026-07-09)
-- =============================================================================
-- Problemas que resuelve:
--   1. "Subo el estado de cuenta y siento que no se guarda": la página de
--      conciliación parseaba el Excel SOLO en el navegador — las filas no
--      conciliadas se perdían al salir. Ahora TODA fila del banco se persiste
--      en vecino.bank_movs al momento de subir (staging idempotente por hash).
--   2. Cobertura: cobertura_banco() dice hasta qué día está cargado el banco
--      y cuántos días faltan (zona MX) → la UI pide "sube más días".
--   3. Rebote con contexto: cuando un comprobante es duplicado (por clave de
--      rastreo o por hash de imagen), el vecino ve FECHA y CASA del original.
--   4. Palomita positiva: abonos_pendientes_comite() cruza cada abono pendiente
--      contra bank_movs (rastreo, o monto+fecha ±3d) → el comité aprueba con
--      evidencia; aprobar_abono_banco() liga la fila del banco al aprobar.
--
-- Todo aditivo. Triggers CON GUARD (WHEN banco_hash IS NOT NULL).
-- =============================================================================

-- --- 1. Registro de cortes subidos -------------------------------------------
CREATE TABLE IF NOT EXISTS vecino.bank_uploads (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id  uuid NOT NULL REFERENCES vecino.colonias(id) ON DELETE CASCADE,
  subido_por  uuid,                      -- auth.uid() del comité que subió
  archivo     text,                      -- nombre del archivo Excel
  fecha_min   date,
  fecha_max   date,
  total_filas int NOT NULL DEFAULT 0,
  nuevas      int NOT NULL DEFAULT 0,
  duplicadas  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE vecino.bank_uploads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bank_uploads_admin ON vecino.bank_uploads;
CREATE POLICY bank_uploads_admin ON vecino.bank_uploads FOR ALL
  USING (colonia_id = vecino.my_colonia_id() AND vecino.is_admin())
  WITH CHECK (colonia_id = vecino.my_colonia_id() AND vecino.is_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON vecino.bank_uploads TO authenticated, service_role;

-- --- 2. Staging: TODAS las filas del banco ------------------------------------
CREATE TABLE IF NOT EXISTS vecino.bank_movs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id  uuid NOT NULL REFERENCES vecino.colonias(id) ON DELETE CASCADE,
  upload_id   uuid REFERENCES vecino.bank_uploads(id) ON DELETE SET NULL,
  fecha       date NOT NULL,
  tipo        text NOT NULL CHECK (tipo IN ('abono','cargo')),
  monto       numeric NOT NULL CHECK (monto > 0),
  concepto    text NOT NULL DEFAULT '',
  banco_hash  text NOT NULL,
  estado      text NOT NULL DEFAULT 'pendiente'
              CHECK (estado IN ('pendiente','conciliado','gasto','descartado')),
  nota        text,                      -- motivo al descartar
  resuelto_id uuid,                      -- transaction/expense que la resolvió
  resuelto_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (colonia_id, banco_hash)
);
CREATE INDEX IF NOT EXISTS idx_bank_movs_pend
  ON vecino.bank_movs (colonia_id, estado, fecha) WHERE estado = 'pendiente';
ALTER TABLE vecino.bank_movs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bank_movs_admin ON vecino.bank_movs;
CREATE POLICY bank_movs_admin ON vecino.bank_movs FOR ALL
  USING (colonia_id = vecino.my_colonia_id() AND vecino.is_admin())
  WITH CHECK (colonia_id = vecino.my_colonia_id() AND vecino.is_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON vecino.bank_movs TO authenticated, service_role;

-- --- 3. subir_corte_banco: persiste el corte completo (idempotente) -----------
-- p_filas: [{fecha:'YYYY-MM-DD', tipo:'abono'|'cargo', monto:n, concepto:'', hash:''}]
-- Filas cuyo hash ya está en transactions/colonia_expenses entran ya resueltas
-- (conciliado/gasto) para no re-ofrecerlas como pendientes.
CREATE OR REPLACE FUNCTION vecino.subir_corte_banco(p_archivo text, p_filas jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE
  v_col    uuid := vecino.my_colonia_id();
  v_upload uuid;
  v_tot    int := 0;
  v_nuevas int := 0;
  v_dup    int := 0;
  v_min    date;
  v_max    date;
  r        record;
  v_estado text;
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;
  IF p_filas IS NULL OR jsonb_typeof(p_filas) <> 'array' OR jsonb_array_length(p_filas) = 0 THEN
    RAISE EXCEPTION 'No hay filas que guardar.';
  END IF;

  INSERT INTO vecino.bank_uploads (colonia_id, subido_por, archivo)
  VALUES (v_col, auth.uid(), nullif(btrim(coalesce(p_archivo,'')),''))
  RETURNING id INTO v_upload;

  FOR r IN
    SELECT * FROM jsonb_to_recordset(p_filas)
      AS x(fecha date, tipo text, monto numeric, concepto text, hash text)
  LOOP
    CONTINUE WHEN r.hash IS NULL OR btrim(r.hash) = ''
             OR r.fecha IS NULL OR coalesce(r.monto,0) <= 0
             OR r.tipo NOT IN ('abono','cargo');
    v_tot := v_tot + 1;
    v_min := least(coalesce(v_min, r.fecha), r.fecha);
    v_max := greatest(coalesce(v_max, r.fecha), r.fecha);

    -- si ya está resuelta en el sistema, entra marcada (no vuelve a pendientes)
    v_estado := CASE
      WHEN r.tipo = 'abono' AND EXISTS (
        SELECT 1 FROM vecino.transactions
         WHERE colonia_id = v_col AND banco_hash = r.hash) THEN 'conciliado'
      WHEN r.tipo = 'cargo' AND EXISTS (
        SELECT 1 FROM vecino.colonia_expenses
         WHERE colonia_id = v_col AND banco_hash = r.hash) THEN 'gasto'
      ELSE 'pendiente' END;

    INSERT INTO vecino.bank_movs
      (colonia_id, upload_id, fecha, tipo, monto, concepto, banco_hash, estado)
    VALUES (v_col, v_upload, r.fecha, r.tipo, r.monto,
            coalesce(btrim(r.concepto),''), r.hash, v_estado)
    ON CONFLICT (colonia_id, banco_hash) DO NOTHING;
    IF FOUND THEN v_nuevas := v_nuevas + 1; ELSE v_dup := v_dup + 1; END IF;
  END LOOP;

  UPDATE vecino.bank_uploads
     SET fecha_min = v_min, fecha_max = v_max,
         total_filas = v_tot, nuevas = v_nuevas, duplicadas = v_dup
   WHERE id = v_upload;

  RETURN jsonb_build_object('ok', true, 'upload_id', v_upload,
    'total', v_tot, 'nuevas', v_nuevas, 'ya_estaban', v_dup,
    'fecha_min', v_min, 'fecha_max', v_max);
END $$;
GRANT EXECUTE ON FUNCTION vecino.subir_corte_banco(text, jsonb) TO authenticated;

-- --- 4. cobertura_banco: ¿hasta qué día está cargado el banco? ----------------
-- Fallbacks para el arranque (staging vacío): fecha de gastos importados y la
-- fecha embebida en el concepto de abonos conciliados ("... banco YYYY-MM-DD").
CREATE OR REPLACE FUNCTION vecino.cobertura_banco()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE
  v_col  uuid := vecino.my_colonia_id();
  v_hoy  date := (now() AT TIME ZONE 'America/Mexico_City')::date;
  v_ult  date;
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;

  SELECT greatest(
    (SELECT max(fecha) FROM vecino.bank_movs WHERE colonia_id = v_col AND estado <> 'descartado'),
    (SELECT max(fecha_pago) FROM vecino.colonia_expenses
      WHERE colonia_id = v_col AND banco_hash IS NOT NULL),
    (SELECT max((substring(concepto FROM 'banco (\d{4}-\d{2}-\d{2})'))::date)
       FROM vecino.transactions
      WHERE colonia_id = v_col AND banco_hash IS NOT NULL
        AND concepto ~ 'banco \d{4}-\d{2}-\d{2}')
  ) INTO v_ult;

  RETURN jsonb_build_object(
    'ok', true,
    'hoy', v_hoy,
    'ultima_fecha', v_ult,
    'dias_atraso', CASE WHEN v_ult IS NULL THEN NULL ELSE v_hoy - v_ult END,
    'pendientes_abonos', (SELECT count(*) FROM vecino.bank_movs
       WHERE colonia_id = v_col AND estado = 'pendiente' AND tipo = 'abono'),
    'pendientes_cargos', (SELECT count(*) FROM vecino.bank_movs
       WHERE colonia_id = v_col AND estado = 'pendiente' AND tipo = 'cargo'));
END $$;
GRANT EXECUTE ON FUNCTION vecino.cobertura_banco() TO authenticated;

-- --- 5. Triggers: al ligar banco_hash, la fila staged queda resuelta ----------
-- CON GUARD (WHEN banco_hash IS NOT NULL). SECURITY DEFINER para poder marcar
-- bank_movs sin depender del rol que dispara. Cubre TODOS los caminos:
-- conciliar_abono, conciliar_auto, conciliar_confirmar, aprobar_abono_banco,
-- importar_gasto_banco — presentes y futuros.
CREATE OR REPLACE FUNCTION vecino._marcar_mov_banco_tx()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino AS $$
BEGIN
  UPDATE vecino.bank_movs
     SET estado = 'conciliado', resuelto_id = NEW.id, resuelto_at = now()
   WHERE colonia_id = NEW.colonia_id AND banco_hash = NEW.banco_hash
     AND estado = 'pendiente';
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_marcar_mov_banco ON vecino.transactions;
CREATE TRIGGER trg_marcar_mov_banco
  AFTER INSERT OR UPDATE OF banco_hash ON vecino.transactions
  FOR EACH ROW WHEN (NEW.banco_hash IS NOT NULL)
  EXECUTE FUNCTION vecino._marcar_mov_banco_tx();

CREATE OR REPLACE FUNCTION vecino._marcar_mov_banco_exp()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino AS $$
BEGIN
  UPDATE vecino.bank_movs
     SET estado = 'gasto', resuelto_id = NEW.id, resuelto_at = now()
   WHERE colonia_id = NEW.colonia_id AND banco_hash = NEW.banco_hash
     AND estado = 'pendiente';
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_marcar_mov_banco_exp ON vecino.colonia_expenses;
CREATE TRIGGER trg_marcar_mov_banco_exp
  AFTER INSERT OR UPDATE OF banco_hash ON vecino.colonia_expenses
  FOR EACH ROW WHEN (NEW.banco_hash IS NOT NULL)
  EXECUTE FUNCTION vecino._marcar_mov_banco_exp();

-- --- 6. descartar_mov_banco: sacar de pendientes lo que nunca se conciliará ---
CREATE OR REPLACE FUNCTION vecino.descartar_mov_banco(p_banco_hash text, p_nota text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE v_col uuid := vecino.my_colonia_id(); v_rows int;
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;
  UPDATE vecino.bank_movs
     SET estado = 'descartado', nota = nullif(btrim(coalesce(p_nota,'')),''), resuelto_at = now()
   WHERE colonia_id = v_col AND banco_hash = p_banco_hash AND estado = 'pendiente';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('ok', v_rows > 0);
END $$;
GRANT EXECUTE ON FUNCTION vecino.descartar_mov_banco(text, text) TO authenticated;

-- --- 7. registrar_abono v3: rebote por imagen con FECHA y CASA del original ---
-- Misma firma (CREATE OR REPLACE). Solo cambia el mensaje del candado 2.
CREATE OR REPLACE FUNCTION vecino.registrar_abono(
  p_monto            numeric,
  p_comprobante_url  text DEFAULT NULL,
  p_concepto         text DEFAULT 'Abono',
  p_comprobante_hash text DEFAULT NULL,
  p_house_id         uuid DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE
  v_house     uuid := coalesce(p_house_id, vecino.my_house_id());
  v_col       uuid;
  v_id        uuid;
  v_dup_casa  text;
  v_dup_fecha text;
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

  -- anti-duplicado 2: misma IMAGEN ya usada en la colonia → decir cuándo y quién
  IF p_comprobante_hash IS NOT NULL THEN
    SELECT h.numero,
           to_char(t.created_at AT TIME ZONE 'America/Mexico_City', 'DD/MM/YYYY')
      INTO v_dup_casa, v_dup_fecha
      FROM vecino.transactions t
      JOIN vecino.houses h ON h.id = t.house_id
     WHERE t.colonia_id = v_col AND t.comprobante_hash = p_comprobante_hash
       AND t.estado <> 'rechazado'
     ORDER BY t.created_at
     LIMIT 1;
    IF v_dup_casa IS NOT NULL THEN
      RAISE EXCEPTION 'Ese comprobante ya se subió el % por la casa %.',
        v_dup_fecha, v_dup_casa;
    END IF;
  END IF;

  INSERT INTO vecino.transactions
    (colonia_id, house_id, tipo, monto, concepto, comprobante_url, comprobante_hash, estado)
  VALUES
    (v_col, v_house, 'abono', p_monto,
     coalesce(nullif(btrim(p_concepto),''),'Abono'), p_comprobante_url, p_comprobante_hash, 'pendiente')
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

-- --- 8. set_abono_ocr v3: rebote por clave de rastreo con FECHA y CASA ---------
-- Misma firma. Al detectar duplicado devuelve fecha (OCR del original, o de
-- registro) y casa del comprobante original para avisarle al vecino.
CREATE OR REPLACE FUNCTION vecino.set_abono_ocr(p_id uuid, p_ocr jsonb, p_ref text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE
  v_ref       text := nullif(vecino._norm_ref(p_ref), '');
  v_col       uuid;
  v_rows      int;
  v_dup_casa  text;
  v_dup_fecha text;
BEGIN
  -- El abono debe ser de una de MIS casas (residente o propietario) y seguir pendiente.
  SELECT colonia_id INTO v_col
    FROM vecino.transactions
   WHERE id = p_id AND tipo = 'abono' AND estado = 'pendiente'
     AND house_id IN (SELECT vecino.my_finance_house_ids());
  IF v_col IS NULL THEN
    RETURN jsonb_build_object('ok', false);
  END IF;

  -- Dedup por clave de rastreo (única por transferencia real).
  IF v_ref IS NOT NULL AND length(v_ref) >= 6 THEN
    SELECT h.numero,
           coalesce(
             CASE WHEN (t.comprobante_ocr->>'fecha') ~ '^\d{4}-\d{2}-\d{2}$'
                  THEN to_char((t.comprobante_ocr->>'fecha')::date, 'DD/MM/YYYY') END,
             to_char(t.created_at AT TIME ZONE 'America/Mexico_City', 'DD/MM/YYYY'))
      INTO v_dup_casa, v_dup_fecha
      FROM vecino.transactions t
      JOIN vecino.houses h ON h.id = t.house_id
     WHERE t.colonia_id = v_col AND t.ref_rastreo = v_ref
       AND t.estado <> 'rechazado' AND t.id <> p_id
     ORDER BY t.created_at
     LIMIT 1;
    IF v_dup_casa IS NOT NULL THEN
      UPDATE vecino.transactions
         SET estado = 'rechazado',
             comprobante_ocr = p_ocr,
             ref_rastreo = v_ref,
             concepto = concepto || ' · rechazado: transferencia ya registrada'
       WHERE id = p_id;
      RETURN jsonb_build_object('ok', false, 'duplicado', true,
        'original_casa', v_dup_casa, 'original_fecha', v_dup_fecha);
    END IF;
  END IF;

  UPDATE vecino.transactions
     SET comprobante_ocr = p_ocr, ref_rastreo = v_ref
   WHERE id = p_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('ok', v_rows > 0, 'duplicado', false);
END $$;

-- --- 9. abonos_pendientes_comite: pendientes + palomita banco + monto OCR ------
-- Por cada transacción pendiente de la colonia, si es abono busca su mejor match
-- en bank_movs (1º clave de rastreo contenida en el concepto del banco; 2º monto
-- exacto + fecha ±3 días de la fecha OCR/registro). Devuelve también el monto
-- leído por OCR para compararlo contra lo que capturó el vecino.
CREATE OR REPLACE FUNCTION vecino.abonos_pendientes_comite()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE v_col uuid := vecino.my_colonia_id(); v_out jsonb;
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;

  SELECT coalesce(jsonb_agg(fila ORDER BY (fila->>'created_at')), '[]'::jsonb)
    INTO v_out
  FROM (
    SELECT jsonb_build_object(
      'id',              t.id,
      'tipo',            t.tipo,
      'monto',           t.monto,
      'concepto',        t.concepto,
      'estado',          t.estado,
      'comprobante_url', t.comprobante_url,
      'created_at',      t.created_at,
      'casa',            h.numero,
      'ocr_monto',       CASE WHEN (t.comprobante_ocr->>'monto') ~ '^-?\d+(\.\d+)?$'
                              THEN (t.comprobante_ocr->>'monto')::numeric END,
      'ocr_fecha',       nullif(t.comprobante_ocr->>'fecha',''),
      'en_banco',        (m.banco_hash IS NOT NULL),
      'banco_hash',      m.banco_hash,
      'banco_fecha',     m.fecha,
      'match_por',       m.match_por
    ) AS fila
    FROM vecino.transactions t
    JOIN vecino.houses h ON h.id = t.house_id
    LEFT JOIN LATERAL (
      SELECT b.banco_hash, b.fecha,
             CASE WHEN t.ref_rastreo IS NOT NULL AND length(t.ref_rastreo) >= 6
                       AND position(t.ref_rastreo IN vecino._norm_ref(b.concepto)) > 0
                  THEN 'rastreo' ELSE 'monto_fecha' END AS match_por
      FROM vecino.bank_movs b
      WHERE t.tipo = 'abono'
        AND b.colonia_id = v_col AND b.tipo = 'abono' AND b.estado = 'pendiente'
        AND (
          (t.ref_rastreo IS NOT NULL AND length(t.ref_rastreo) >= 6
             AND position(t.ref_rastreo IN vecino._norm_ref(b.concepto)) > 0)
          OR
          (b.monto = t.monto AND abs(b.fecha - coalesce(
             CASE WHEN (t.comprobante_ocr->>'fecha') ~ '^\d{4}-\d{2}-\d{2}$'
                  THEN (t.comprobante_ocr->>'fecha')::date END,
             (t.created_at AT TIME ZONE 'America/Mexico_City')::date)) <= 3)
        )
      ORDER BY
        CASE WHEN t.ref_rastreo IS NOT NULL AND length(t.ref_rastreo) >= 6
                  AND position(t.ref_rastreo IN vecino._norm_ref(b.concepto)) > 0
             THEN 0 ELSE 1 END,
        abs(b.fecha - coalesce(
          CASE WHEN (t.comprobante_ocr->>'fecha') ~ '^\d{4}-\d{2}-\d{2}$'
               THEN (t.comprobante_ocr->>'fecha')::date END,
          (t.created_at AT TIME ZONE 'America/Mexico_City')::date))
      LIMIT 1
    ) m ON true
    WHERE t.colonia_id = v_col AND t.estado = 'pendiente'
  ) q;

  RETURN v_out;
END $$;
GRANT EXECUTE ON FUNCTION vecino.abonos_pendientes_comite() TO authenticated;

-- --- 10. aprobar_abono_banco: aprobar + ligar la fila del banco de una vez -----
-- El comité aprueba un pendiente que SÍ apareció en el banco: liga banco_hash,
-- aprueba con resolver_transaccion (saldo/estatus) y el trigger marca bank_movs.
CREATE OR REPLACE FUNCTION vecino.aprobar_abono_banco(p_id uuid, p_banco_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE
  v_col   uuid := vecino.my_colonia_id();
  t       vecino.transactions%ROWTYPE;
  v_fecha date;
  v_num   text;
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;
  IF p_banco_hash IS NULL OR btrim(p_banco_hash) = '' THEN
    RAISE EXCEPTION 'Falta la fila del banco.';
  END IF;

  SELECT * INTO t FROM vecino.transactions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'El abono no existe.'; END IF;
  IF t.colonia_id <> v_col THEN RAISE EXCEPTION 'El abono no es de tu colonia.'; END IF;
  IF t.tipo <> 'abono' OR t.estado <> 'pendiente' THEN
    RAISE EXCEPTION 'Ese abono ya no está pendiente.';
  END IF;

  -- esa fila del banco no debe estar ligada ya a otra transacción
  IF EXISTS (SELECT 1 FROM vecino.transactions
              WHERE colonia_id = v_col AND banco_hash = p_banco_hash) THEN
    RETURN jsonb_build_object('ok', false, 'dup', true);
  END IF;

  SELECT fecha INTO v_fecha FROM vecino.bank_movs
   WHERE colonia_id = v_col AND banco_hash = p_banco_hash AND estado = 'pendiente'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ese movimiento del banco ya no está disponible (recarga la lista).';
  END IF;

  UPDATE vecino.transactions
     SET banco_hash = p_banco_hash,
         concepto = concepto || ' · conciliado banco ' || v_fecha::text
   WHERE id = p_id;
  PERFORM vecino.resolver_transaccion(p_id, true);  -- aprueba + saldo (el trigger marca bank_movs)

  SELECT numero INTO v_num FROM vecino.houses WHERE id = t.house_id;
  RETURN jsonb_build_object('ok', true, 'id', p_id, 'casa', v_num, 'banco_fecha', v_fecha);
END $$;
GRANT EXECUTE ON FUNCTION vecino.aprobar_abono_banco(uuid, text) TO authenticated;
