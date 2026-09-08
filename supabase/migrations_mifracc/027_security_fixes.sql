-- 027_security_fixes.sql — Correcciones de seguridad y correctitud (post review E2E 2026-07-01)
-- =============================================================================
-- Basado en las DEFINICIONES VIVAS de producción (no solo en los .sql previos).
-- Cada bloque es idempotente y NO toca datos históricos.
--
-- ⚠️ APLICAR EN ESTE ORDEN, revisado antes por el Director. Todo corre en una
--    sola transacción vía /pg/query (un error = rollback total).
--
-- Cubre:
--   #1  Escalación de privilegios en mifracc.profiles (CRÍTICO, confirmado en vivo)
--   #3a Doble aplicación de saldo por carrera (resolver_transaccion / _incidencia / votar_resolucion)
--   #3b Idempotencia real de cobros/recargos (índice UNIQUE acotado + ON CONFLICT + advisory lock)
--   #5  Endurecer link_telegram (no sobrescribir un chat ya ligado)
--   #7  Acotar lecturas colonia-wide de bajo riesgo (profiles / transactions / sos_events)
--
-- NO cubre (van en Fase 2, requieren cambio de frontend acoplado — ver plan):
--   #2  Buckets Storage a privado + signed URLs (rompe imágenes si no va con el frontend)
--   #7b houses / incident_reports / vehicles (requieren RPC para el lookup del residente)
--   #4  Rotar tokens committeados (bot Telegram + cron) — acción manual con Daniel
-- =============================================================================

BEGIN;

-- =============================================================================
-- #1 · Bloquear escalación de privilegios en mifracc.profiles
-- -----------------------------------------------------------------------------
-- La policy profiles_self_write permite al usuario UPDATE de su propia fila sin
-- restringir columnas. Un residente podía hacerse role='admin'/approval='aprobado'.
-- Este trigger CONGELA role/approval_status/colonia_id/house_id cuando quien edita
-- es el propio dueño de la fila y NO es admin. No afecta:
--   · al comité aprobando a otros (auth.uid() <> OLD.id)
--   · a service_role en onboarding (auth.uid() IS NULL → condición falsa)
--   · a link_telegram vía anon (auth.uid() IS NULL)
-- Silencioso (no lanza): ignora el cambio prohibido sin romper updates legítimos.
-- =============================================================================
CREATE OR REPLACE FUNCTION mifracc.guard_profile_self_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'mifracc', 'auth'
AS $$
BEGIN
  IF auth.uid() = OLD.id AND NOT mifracc.is_admin() THEN
    NEW.role            := OLD.role;
    NEW.approval_status := OLD.approval_status;
    NEW.colonia_id      := OLD.colonia_id;
    NEW.house_id        := OLD.house_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_profile_self_update ON mifracc.profiles;
CREATE TRIGGER trg_guard_profile_self_update
  BEFORE UPDATE ON mifracc.profiles
  FOR EACH ROW EXECUTE FUNCTION mifracc.guard_profile_self_update();

-- =============================================================================
-- #3a · Doble aplicación de saldo por carrera
-- -----------------------------------------------------------------------------
-- Se agrega SELECT ... FOR UPDATE (bloqueo de fila) + UPDATE guardado por estado
-- con chequeo de ROW_COUNT. Un doble-tap concurrente ya no aplica el saldo 2 veces.
-- Firmas idénticas a las vivas (no cambia el contrato con el frontend).
-- =============================================================================

CREATE OR REPLACE FUNCTION mifracc.resolver_transaccion(p_id uuid, p_aprobar boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'mifracc', 'auth'
AS $$
DECLARE
  t       mifracc.transactions%ROWTYPE;
  v_delta numeric;
  v_rows  int;
BEGIN
  IF NOT mifracc.is_admin() THEN
    RAISE EXCEPTION 'Solo el comité puede resolver transacciones.';
  END IF;
  SELECT * INTO t FROM mifracc.transactions WHERE id = p_id FOR UPDATE;  -- ← bloqueo
  IF NOT FOUND THEN RAISE EXCEPTION 'La transacción no existe.'; END IF;
  IF t.colonia_id <> mifracc.my_colonia_id() THEN
    RAISE EXCEPTION 'La transacción no es de tu colonia.';
  END IF;
  IF t.estado <> 'pendiente' THEN
    RAISE EXCEPTION 'Esa transacción ya fue resuelta.';
  END IF;

  IF p_aprobar THEN
    UPDATE mifracc.transactions SET estado = 'aprobado'
     WHERE id = p_id AND estado = 'pendiente';   -- ← guardado por estado
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN RAISE EXCEPTION 'Esa transacción ya fue resuelta.'; END IF;

    v_delta := CASE t.tipo WHEN 'abono' THEN -t.monto ELSE t.monto END;
    UPDATE mifracc.houses SET saldo = saldo + v_delta WHERE id = t.house_id;
    UPDATE mifracc.houses
       SET estatus = CASE
         WHEN estatus = 'en_convenio' THEN 'en_convenio'::mifracc.estatus_casa
         WHEN saldo > 0 THEN 'con_adeudo'::mifracc.estatus_casa
         ELSE 'al_corriente'::mifracc.estatus_casa END
     WHERE id = t.house_id;
  ELSE
    UPDATE mifracc.transactions SET estado = 'rechazado'
     WHERE id = p_id AND estado = 'pendiente';
  END IF;

  RETURN jsonb_build_object('ok', true);
END $$;

CREATE OR REPLACE FUNCTION mifracc.resolver_incidencia(p_id uuid, p_accion text, p_monto numeric DEFAULT NULL::numeric, p_nota text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'mifracc', 'auth'
AS $$
DECLARE
  r      mifracc.incident_reports%ROWTYPE;
  v_cat  text;
  v_tx   uuid;
  v_tope numeric;
  v_rows int;
BEGIN
  IF NOT mifracc.is_admin() THEN
    RAISE EXCEPTION 'Solo el comité puede resolver incidencias.';
  END IF;
  SELECT * INTO r FROM mifracc.incident_reports WHERE id = p_id FOR UPDATE;  -- ← bloqueo
  IF NOT FOUND THEN RAISE EXCEPTION 'La incidencia no existe.'; END IF;
  IF r.colonia_id <> mifracc.my_colonia_id() THEN
    RAISE EXCEPTION 'La incidencia no es de tu colonia.';
  END IF;
  IF r.estado <> 'pendiente' THEN
    RAISE EXCEPTION 'Esa incidencia ya fue resuelta.';
  END IF;

  IF p_accion = 'multar' THEN
    IF p_monto IS NULL OR p_monto <= 0 THEN
      RAISE EXCEPTION 'Indica el monto de la multa.';
    END IF;
    SELECT COALESCE(tope_multa, 1000) INTO v_tope FROM mifracc.colonias WHERE id = r.colonia_id;
    IF p_monto > v_tope THEN
      RAISE EXCEPTION 'La multa no puede exceder el tope de $%.', to_char(v_tope,'FM999G999D00');
    END IF;

    UPDATE mifracc.incident_reports SET estado = 'multa'
     WHERE id = p_id AND estado = 'pendiente';   -- ← guardado por estado
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN RAISE EXCEPTION 'Esa incidencia ya fue resuelta.'; END IF;

    SELECT nombre INTO v_cat FROM mifracc.fine_categories WHERE id = r.categoria_id;
    INSERT INTO mifracc.transactions (colonia_id, house_id, tipo, monto, concepto, estado)
    VALUES (r.colonia_id, r.infractor_house_id, 'cargo', p_monto,
            'Multa: ' || coalesce(v_cat,'Incidencia'), 'aprobado')
    RETURNING id INTO v_tx;
    UPDATE mifracc.houses SET saldo = saldo + p_monto WHERE id = r.infractor_house_id;
    UPDATE mifracc.houses
       SET estatus = CASE
         WHEN estatus = 'en_convenio' THEN 'en_convenio'::mifracc.estatus_casa
         WHEN saldo > 0 THEN 'con_adeudo'::mifracc.estatus_casa
         ELSE 'al_corriente'::mifracc.estatus_casa END
     WHERE id = r.infractor_house_id;
    UPDATE mifracc.incident_reports
       SET monto_multa = p_monto, transaction_id = v_tx,
           resolucion_admin = nullif(btrim(p_nota),''), resolved_at = now(), resolved_by = auth.uid()
     WHERE id = p_id;
    RETURN jsonb_build_object('ok', true, 'estado', 'multa', 'transaction_id', v_tx);

  ELSIF p_accion = 'rechazar' THEN
    UPDATE mifracc.incident_reports
       SET estado = 'rechazado', resolucion_admin = nullif(btrim(p_nota),''),
           resolved_at = now(), resolved_by = auth.uid()
     WHERE id = p_id AND estado = 'pendiente';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN RAISE EXCEPTION 'Esa incidencia ya fue resuelta.'; END IF;
    RETURN jsonb_build_object('ok', true, 'estado', 'rechazado');

  ELSE
    RAISE EXCEPTION 'Acción no válida.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION mifracc.votar_resolucion(p_id uuid, p_aprobar boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'mifracc', 'auth'
AS $$
DECLARE r mifracc.incident_reports%ROWTYPE; v_cat text; v_tx uuid; v_msg text; v_rows int;
BEGIN
  IF NOT mifracc.is_admin() THEN RAISE EXCEPTION 'Solo el comité puede votar.'; END IF;
  SELECT * INTO r FROM mifracc.incident_reports WHERE id = p_id FOR UPDATE;  -- ← bloqueo
  IF NOT FOUND THEN RAISE EXCEPTION 'La incidencia no existe.'; END IF;
  IF r.colonia_id <> mifracc.my_colonia_id() THEN RAISE EXCEPTION 'No es de tu colonia.'; END IF;
  IF r.estado <> 'propuesta' THEN RAISE EXCEPTION 'No es una propuesta pendiente de voto.'; END IF;

  IF p_aprobar THEN
    UPDATE mifracc.incident_reports SET estado = 'multa'
     WHERE id = p_id AND estado = 'propuesta';   -- ← guardado por estado
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN RAISE EXCEPTION 'Esa propuesta ya fue resuelta.'; END IF;

    SELECT nombre INTO v_cat FROM mifracc.fine_categories WHERE id = r.categoria_id;
    INSERT INTO mifracc.transactions (colonia_id, house_id, tipo, monto, concepto, estado)
    VALUES (r.colonia_id, r.infractor_house_id, 'cargo', r.monto_multa,
            'Multa: ' || coalesce(v_cat, 'Incidencia'), 'aprobado')
    RETURNING id INTO v_tx;
    UPDATE mifracc.houses SET saldo = saldo + r.monto_multa WHERE id = r.infractor_house_id;
    UPDATE mifracc.houses
       SET estatus = CASE
         WHEN estatus = 'en_convenio' THEN 'en_convenio'::mifracc.estatus_casa
         WHEN saldo > 0 THEN 'con_adeudo'::mifracc.estatus_casa
         ELSE 'al_corriente'::mifracc.estatus_casa END
     WHERE id = r.infractor_house_id;
    UPDATE mifracc.incident_reports
       SET transaction_id = v_tx, voto_por = auth.uid(), voto_at = now(),
           resolved_at = now(), resolved_by = auth.uid()
     WHERE id = p_id;
    v_msg := '⚠️ Multa aplicada — ' || coalesce(v_cat, 'Incidencia') ||
             ' por reincidencia. Monto: $' || to_char(r.monto_multa, 'FM999G999') ||
             '. Se cargó a tu estado de cuenta.';
    PERFORM mifracc._notify_infractor(r.infractor_house_id, v_msg);
    RETURN jsonb_build_object('ok', true, 'estado', 'multa', 'transaction_id', v_tx);
  ELSE
    UPDATE mifracc.incident_reports
       SET estado = 'rechazado', voto_por = auth.uid(), voto_at = now(),
           resolved_at = now(), resolved_by = auth.uid(),
           resolucion_admin = coalesce(resolucion_admin, '') || ' · Rechazada por el comité.'
     WHERE id = p_id AND estado = 'propuesta';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN RAISE EXCEPTION 'Esa propuesta ya fue resuelta.'; END IF;
    RETURN jsonb_build_object('ok', true, 'estado', 'rechazado');
  END IF;
END $$;

-- =============================================================================
-- #3b · Idempotencia real de cobros/recargos
-- -----------------------------------------------------------------------------
-- El histórico usa nombres sucios ('Mantenimiento Noviembre 2025', typos, dups).
-- Los crons/botón generan SIEMPRE el formato estricto 'Mantenimiento YYYY-MM' /
-- 'Recargo YYYY-MM'. Verificado en vivo: 0 filas usan ese formato hoy → el índice
-- UNIQUE acotado NO colisiona con el pasado y blinda TODO cobro automático futuro.
-- =============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS transactions_cobro_periodo_uq
  ON mifracc.transactions (house_id, concepto)
  WHERE concepto ~ '^(Mantenimiento|Recargo) \d{4}-\d{2}$';

-- Helpers de cobro: advisory lock por (colonia, periodo) + ON CONFLICT DO NOTHING
-- (RETURNING solo devuelve las filas realmente insertadas → saldo nunca se dobla).
CREATE OR REPLACE FUNCTION mifracc._cobros_colonia(p_col uuid, p_periodo text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'mifracc', 'auth'
AS $$
DECLARE v_cuota numeric; v_concepto text; v_n int := 0; rec record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('cobros:' || p_col::text || ':' || p_periodo));
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
      ON CONFLICT (house_id, concepto)
        WHERE concepto ~ '^(Mantenimiento|Recargo) \d{4}-\d{2}$' DO NOTHING
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
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'mifracc', 'auth'
AS $$
DECLARE v_recargo numeric; v_cuota_concepto text; v_rec_concepto text; v_n int := 0; rec record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('recargos:' || p_col::text || ':' || p_periodo));
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
      ON CONFLICT (house_id, concepto)
        WHERE concepto ~ '^(Mantenimiento|Recargo) \d{4}-\d{2}$' DO NOTHING
      RETURNING house_id
    ) SELECT house_id FROM ins
  LOOP
    UPDATE mifracc.houses SET saldo = saldo + v_recargo WHERE id = rec.house_id;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

-- =============================================================================
-- #5 · Endurecer link_telegram — no permitir secuestrar un chat ya ligado
-- -----------------------------------------------------------------------------
-- Antes: UPDATE ... WHERE id = p_id (sobrescribía el chat de cualquier perfil).
-- Ahora: solo liga si el perfil aún no tiene chat (telegram_chat_id IS NULL) y el
-- chat no está usado por otro perfil. Devuelve NULL si no pudo ligar (ya ligado).
-- El re-enlace (cambio de teléfono) lo hace el comité/admin poniendo el chat a NULL.
-- Nota: el fix completo (token de un solo uso en el deep-link) va en Fase 2.
-- =============================================================================
CREATE OR REPLACE FUNCTION mifracc.link_telegram(p_id uuid, p_chat text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'mifracc'
AS $$
DECLARE n text;
BEGIN
  IF EXISTS (SELECT 1 FROM mifracc.profiles WHERE telegram_chat_id = p_chat AND id <> p_id) THEN
    RETURN NULL;  -- ese chat ya pertenece a otro vecino
  END IF;
  UPDATE mifracc.profiles
     SET telegram_chat_id = p_chat, updated_at = now()
   WHERE id = p_id AND telegram_chat_id IS NULL   -- ← no sobrescribe uno ya ligado
   RETURNING nombre INTO n;
  RETURN n;
END $$;

-- =============================================================================
-- #7 · Acotar lecturas colonia-wide de BAJO RIESGO (verificadas contra el frontend)
-- -----------------------------------------------------------------------------
-- Solo se tocan 3 policies cuyo acotamiento NO rompe ninguna pantalla:
--   · profiles_self_read: todas las páginas leen SU propio perfil (id=auth.uid());
--     la única lectura colonia-wide es la bandeja de aprobaciones del comité (is_admin).
--     → se cierra la fuga del directorio (email, teléfono, telegram_chat_id, pin) a residentes.
--   · transactions_read: residente lee solo su casa (pagos); comité vía is_admin.
--   · sos_events_read: solo vigilancia (is_guard) lista SOS; el residente nunca los lee.
-- houses / incident_reports / vehicles NO se tocan aquí (el residente los necesita
-- para resolver al infractor por número/placa → requiere RPC, va en Fase 2).
-- =============================================================================
DROP POLICY IF EXISTS profiles_self_read ON mifracc.profiles;
CREATE POLICY profiles_self_read ON mifracc.profiles
  FOR SELECT USING (id = auth.uid() OR mifracc.is_admin());

DROP POLICY IF EXISTS transactions_read ON mifracc.transactions;
CREATE POLICY transactions_read ON mifracc.transactions
  FOR SELECT USING (house_id = mifracc.my_house_id() OR mifracc.is_admin());

DROP POLICY IF EXISTS sos_events_read ON mifracc.sos_events;
CREATE POLICY sos_events_read ON mifracc.sos_events
  FOR SELECT USING (
    profile_id = auth.uid()
    OR (colonia_id = mifracc.my_colonia_id() AND mifracc.is_guard())
  );

COMMIT;

-- =============================================================================
-- POST-CHECK (correr por separado tras el COMMIT, solo lectura):
--   -- #1: un residente NO puede escalar (debe seguir con su role):
--   --     probar en la app con una cuenta residente el update malicioso → sin efecto.
--   -- #3b: el índice existe:
--   SELECT indexname FROM pg_indexes WHERE schemaname='mifracc'
--     AND indexname='transactions_cobro_periodo_uq';
--   -- #7: policies nuevas:
--   SELECT policyname, qual FROM pg_policies WHERE schemaname='mifracc'
--     AND policyname IN ('profiles_self_read','transactions_read','sos_events_read');
-- =============================================================================
