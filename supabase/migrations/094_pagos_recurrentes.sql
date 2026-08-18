-- 094_pagos_recurrentes.sql — Alertas de pagos recurrentes para el comité
-- Re-aplicable: tablas IF NOT EXISTS, funciones CREATE OR REPLACE, semilla ON CONFLICT
-- DO NOTHING. No hay migración posterior que redefina estas funciones (si la hubiera,
-- re-aplicar este archivo la revertiría en silencio).
--
-- Problema: el recibo del proveedor muchas veces NO llega, y hoy nadie se entera
-- de que un servicio quedó sin pagar hasta que se corta. De los 156 gastos
-- registrados, CERO tienen recibo adjunto — pero el estado de cuenta SÍ se sube
-- cada 3-4 días. Entonces la señal de "ya se pagó" es el CARGO EN EL BANCO,
-- no el recibo.
--
-- Regla de honestidad (la más importante de este archivo): que no aparezca el
-- cargo NO prueba que no se pagó. Si el estado de cuenta no cubre todavía la
-- fecha de vencimiento, el estado es 'sin_dato' — nunca 'vencido'. Ausencia de
-- dato no es cero.

-- ─────────────────────────────────────────────────────────────
-- 1. Catálogo de pagos recurrentes
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vecino.recurring_bills (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id          uuid NOT NULL REFERENCES vecino.colonias(id) ON DELETE CASCADE,
  nombre              text NOT NULL,
  categoria           text NOT NULL,              -- empata con colonia_expenses.categoria
  patron              text NOT NULL,              -- regex sobre upper(bank_movs.concepto); de preferencia el RFC
  periodicidad        text NOT NULL CHECK (periodicidad IN ('semanal','quincenal','mensual','bimestral')),
  cargos_por_periodo  int  NOT NULL DEFAULT 1 CHECK (cargos_por_periodo > 0),
  monto_min           numeric,                    -- rango histórico; acota el match (luz y agua varían 3x y 58x)
  monto_max           numeric,
  dia_esperado        int CHECK (dia_esperado BETWEEN 1 AND 31),  -- informativo: "suele pagarse el día N"
  gracia_dias         int  NOT NULL DEFAULT 3,    -- después de esto se pone rojo
  aviso_dias_antes    int  NOT NULL DEFAULT 3,    -- antes de esto ya está ámbar
  activo              boolean NOT NULL DEFAULT true,
  nota                text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (colonia_id, nombre)
);

-- Un renglón por vencimiento: aquí vive el anti-spam del aviso y el "ya se pagó
-- fuera del banco" del comité (con motivo obligatorio, igual que anular).
CREATE TABLE IF NOT EXISTS vecino.recurring_bill_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id            uuid NOT NULL REFERENCES vecino.recurring_bills(id) ON DELETE CASCADE,
  periodo            text NOT NULL,               -- 'YYYY-MM-DD' del vencimiento estimado
  avisos             int  NOT NULL DEFAULT 0,
  ultimo_aviso_at    timestamptz,
  fecha_pago_manual  date,
  marcado_por        uuid REFERENCES vecino.profiles(id),
  marcado_at         timestamptz,
  motivo             text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bill_id, periodo)
);

CREATE INDEX IF NOT EXISTS idx_recurring_bills_colonia ON vecino.recurring_bills(colonia_id) WHERE activo;
CREATE INDEX IF NOT EXISTS idx_recurring_events_bill   ON vecino.recurring_bill_events(bill_id);

ALTER TABLE vecino.recurring_bills       ENABLE ROW LEVEL SECURITY;
ALTER TABLE vecino.recurring_bill_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS recurring_bills_admin  ON vecino.recurring_bills;
DROP POLICY IF EXISTS recurring_events_admin ON vecino.recurring_bill_events;

-- Solo comité/admin: es información de tesorería, no transparencia al vecino.
CREATE POLICY recurring_bills_admin ON vecino.recurring_bills
  FOR ALL USING (colonia_id = vecino.my_colonia_id() AND vecino.is_admin())
  WITH CHECK (colonia_id = vecino.my_colonia_id() AND vecino.is_admin());

CREATE POLICY recurring_events_admin ON vecino.recurring_bill_events
  FOR ALL USING (EXISTS (SELECT 1 FROM vecino.recurring_bills b
                          WHERE b.id = bill_id AND b.colonia_id = vecino.my_colonia_id())
                 AND vecino.is_admin())
  WITH CHECK (EXISTS (SELECT 1 FROM vecino.recurring_bills b
                       WHERE b.id = bill_id AND b.colonia_id = vecino.my_colonia_id())
              AND vecino.is_admin());

GRANT SELECT, INSERT, UPDATE ON vecino.recurring_bills, vecino.recurring_bill_events TO authenticated;

-- ─────────────────────────────────────────────────────────────
-- 2. Motor de estado (interno, sin auth: lo usan el wrapper y el cron)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION vecino._recurring_estado(p_colonia uuid)
RETURNS TABLE (
  bill_id uuid, nombre text, categoria text, periodicidad text,
  cargos_por_periodo int, cargos_ultimo_ciclo int,
  ultimo_pago date, origen text, monto_ultimo numeric,
  monto_min numeric, monto_max numeric,
  proximo_esperado date, dias_atraso int,
  estado text, alerta_monto text,
  cobertura_hasta date, dias_sin_estado_cuenta int
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'vecino','auth' AS $$
DECLARE
  v_hoy date := (now() AT TIME ZONE 'America/Mexico_City')::date;
  v_cob date;      -- hasta dónde llega el estado de cuenta cargado
  v_ini date;      -- desde dónde
  b    record;
  v_dias int;
BEGIN
  SELECT max(fecha), min(fecha) INTO v_cob, v_ini
    FROM vecino.bank_movs WHERE colonia_id = p_colonia;

  FOR b IN SELECT * FROM vecino.recurring_bills
            WHERE colonia_id = p_colonia AND activo ORDER BY nombre
  LOOP
    v_dias := CASE b.periodicidad WHEN 'semanal' THEN 7 WHEN 'quincenal' THEN 15
                                  WHEN 'mensual' THEN 30 ELSE 60 END;

    bill_id := b.id; nombre := b.nombre; categoria := b.categoria;
    periodicidad := b.periodicidad; cargos_por_periodo := b.cargos_por_periodo;
    monto_min := b.monto_min; monto_max := b.monto_max;
    cobertura_hasta := v_cob;
    dias_sin_estado_cuenta := CASE WHEN v_cob IS NULL THEN NULL ELSE v_hoy - v_cob END;

    -- Último cargo del banco que empata firma + rango de monto
    SELECT m.fecha, m.monto INTO ultimo_pago, monto_ultimo
      FROM vecino.bank_movs m
     WHERE m.colonia_id = p_colonia AND m.tipo = 'cargo'
       AND upper(m.concepto) ~ upper(b.patron)
       AND (b.monto_min IS NULL OR m.monto >= b.monto_min)
       -- El techo del match va HOLGADO (2.5x) a propósito: un pago que cubre dos
       -- periodos rebasa el rango normal, y si lo filtramos aquí el servicio se
       -- ve "sin pagar" el día que justamente se pagó doble. Se acepta y se marca.
       AND (b.monto_max IS NULL OR m.monto <= b.monto_max * 2.5)
     ORDER BY m.fecha DESC, m.monto DESC LIMIT 1;

    origen := CASE WHEN ultimo_pago IS NULL THEN NULL ELSE 'banco' END;

    -- ¿El comité marcó un pago fuera del banco más reciente? Ese manda.
    DECLARE v_manual date;
    BEGIN
      SELECT max(e.fecha_pago_manual) INTO v_manual
        FROM vecino.recurring_bill_events e WHERE e.bill_id = b.id;
      IF v_manual IS NOT NULL AND (ultimo_pago IS NULL OR v_manual > ultimo_pago) THEN
        ultimo_pago := v_manual; origen := 'manual'; monto_ultimo := NULL;
      END IF;
    END;

    -- Cargos alrededor del último pago: CFE y JUMAPA traen DOS recibos por
    -- periodo (dos medidores) y se pagan el mismo día.
    SELECT count(*) INTO cargos_ultimo_ciclo
      FROM vecino.bank_movs m
     WHERE m.colonia_id = p_colonia AND m.tipo = 'cargo'
       AND upper(m.concepto) ~ upper(b.patron)
       AND ultimo_pago IS NOT NULL
       AND m.fecha BETWEEN ultimo_pago - 5 AND ultimo_pago + 5;

    -- Sin ningún pago conocido, el reloj corre desde donde empieza el estado de cuenta.
    proximo_esperado := coalesce(ultimo_pago, v_ini) + v_dias;
    dias_atraso := v_hoy - proximo_esperado;

    estado := CASE
      WHEN proximo_esperado IS NULL                          THEN 'sin_dato'
      WHEN v_hoy <  proximo_esperado - b.aviso_dias_antes    THEN 'al_dia'
      WHEN v_hoy <= proximo_esperado + b.gracia_dias         THEN 'por_vencer'
      ELSE 'vencido' END;

    -- 🔒 El candado honesto: no puedo decir "vencido" si el estado de cuenta
    -- todavía no cubre la fecha de vencimiento. Eso es "no se sabe".
    IF estado = 'vencido' AND (v_cob IS NULL OR proximo_esperado + b.gracia_dias > v_cob) THEN
      estado := 'sin_dato';
    END IF;

    -- Pagó, pero faltó uno de los dos recibos del periodo.
    IF estado = 'al_dia' AND origen = 'banco'
       AND cargos_ultimo_ciclo < b.cargos_por_periodo THEN
      estado := 'incompleto';   -- solo aplica al banco: un pago a mano no trae recibos
    END IF;

    alerta_monto := CASE
      WHEN monto_ultimo IS NULL OR b.monto_max IS NULL OR b.monto_min IS NULL THEN NULL
      WHEN monto_ultimo >= 1.8 * ((b.monto_min + b.monto_max) / 2) THEN 'pago_doble'  -- Telmex $1,098 = dos meses
      WHEN monto_ultimo >  b.monto_max                             THEN 'fuera_de_rango'
      ELSE NULL END;

    RETURN NEXT;
  END LOOP;
END $$;

-- Wrapper para el UI del comité
CREATE OR REPLACE FUNCTION vecino.pagos_recurrentes_estado()
RETURNS TABLE (
  bill_id uuid, nombre text, categoria text, periodicidad text,
  cargos_por_periodo int, cargos_ultimo_ciclo int,
  ultimo_pago date, origen text, monto_ultimo numeric,
  monto_min numeric, monto_max numeric,
  proximo_esperado date, dias_atraso int,
  estado text, alerta_monto text,
  cobertura_hasta date, dias_sin_estado_cuenta int
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'vecino','auth' AS $$
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;
  RETURN QUERY SELECT * FROM vecino._recurring_estado(vecino.my_colonia_id());
END $$;

-- ─────────────────────────────────────────────────────────────
-- 3. "Ya se pagó, pero fuera del banco" — con motivo obligatorio
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION vecino.recurring_bill_marcar_pagado(
  p_bill uuid, p_fecha date, p_motivo text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'vecino','auth' AS $$
DECLARE v_col uuid := vecino.my_colonia_id(); v_periodo text; v_hoy date;
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vecino.recurring_bills WHERE id = p_bill AND colonia_id = v_col) THEN
    RAISE EXCEPTION 'Ese pago recurrente no es de tu colonia.';
  END IF;
  IF coalesce(btrim(p_motivo),'') = '' THEN
    RAISE EXCEPTION 'Escribe por qué lo marcas pagado (efectivo, otra cuenta, etc.).';
  END IF;
  v_hoy := (now() AT TIME ZONE 'America/Mexico_City')::date;
  IF p_fecha IS NULL OR p_fecha > v_hoy THEN RAISE EXCEPTION 'La fecha de pago no puede ser futura.'; END IF;

  SELECT to_char(proximo_esperado,'YYYY-MM-DD') INTO v_periodo
    FROM vecino._recurring_estado(v_col) WHERE bill_id = p_bill;

  INSERT INTO vecino.recurring_bill_events (bill_id, periodo, fecha_pago_manual, marcado_por, marcado_at, motivo)
  VALUES (p_bill, coalesce(v_periodo, to_char(p_fecha,'YYYY-MM-DD')), p_fecha, auth.uid(), now(), btrim(p_motivo))
  ON CONFLICT (bill_id, periodo) DO UPDATE
    SET fecha_pago_manual = EXCLUDED.fecha_pago_manual,
        marcado_por = EXCLUDED.marcado_por, marcado_at = now(), motivo = EXCLUDED.motivo;

  RETURN jsonb_build_object('ok', true);
END $$;

-- ─────────────────────────────────────────────────────────────
-- 4. Cron diario → aviso al comité por Telegram
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION vecino.cron_pagos_recurrentes(p_token text, p_dry boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'vecino','auth' AS $$
DECLARE
  c        record;
  r        record;
  v_lineas text;
  v_msg    text;
  v_n      int;
  v_total  int := 0;
  v_avisos int := 0;
  v_previa jsonb := '[]'::jsonb;   -- en seco: los mensajes tal cual saldrían
  v_stale  int;
  v_chat   record;
BEGIN
  IF p_token <> 'vcn_cron_7Kp2qXm9' THEN RAISE EXCEPTION 'Token inválido.'; END IF;

  FOR c IN SELECT id, nombre FROM vecino.colonias LOOP
    v_lineas := ''; v_n := 0; v_stale := NULL;

    FOR r IN SELECT * FROM vecino._recurring_estado(c.id)
              WHERE estado IN ('vencido','por_vencer','incompleto')
              ORDER BY CASE estado WHEN 'vencido' THEN 1 WHEN 'incompleto' THEN 2 ELSE 3 END,
                       dias_atraso DESC
    LOOP
      v_stale := coalesce(v_stale, r.dias_sin_estado_cuenta);

      -- Un aviso por vencimiento; recordatorio cada 7 días mientras siga abierto.
      -- En seco NO se escribe nada: el ensayo tiene que poder correrse cuantas
      -- veces haga falta sin dejar rastro en producción.
      IF NOT p_dry THEN
        INSERT INTO vecino.recurring_bill_events (bill_id, periodo)
        VALUES (r.bill_id, to_char(r.proximo_esperado,'YYYY-MM-DD'))
        ON CONFLICT (bill_id, periodo) DO NOTHING;
      END IF;

      CONTINUE WHEN EXISTS (
        SELECT 1 FROM vecino.recurring_bill_events e
         WHERE e.bill_id = r.bill_id AND e.periodo = to_char(r.proximo_esperado,'YYYY-MM-DD')
           AND (e.fecha_pago_manual IS NOT NULL
                OR (e.ultimo_aviso_at IS NOT NULL AND e.ultimo_aviso_at > now() - interval '7 days')));

      v_lineas := v_lineas || CASE r.estado
                    WHEN 'vencido'    THEN '🔴 '
                    WHEN 'incompleto' THEN '🟡 '
                    ELSE '🟠 ' END
        || r.nombre
        || CASE WHEN r.estado = 'vencido' AND r.ultimo_pago IS NULL
                  THEN ' — NUNCA ha aparecido un cargo de este proveedor'
                WHEN r.estado = 'vencido'
                  THEN ' — sin cargo desde hace ' || (r.dias_atraso + CASE r.periodicidad
                         WHEN 'semanal' THEN 7 WHEN 'quincenal' THEN 15
                         WHEN 'mensual' THEN 30 ELSE 60 END) || ' días (último: '
                       || to_char(r.ultimo_pago,'DD/Mon') || ')'
                WHEN r.estado = 'incompleto'
                  THEN ' — apareció ' || r.cargos_ultimo_ciclo || ' de ' || r.cargos_por_periodo || ' recibos'
                ELSE ' — vence ' || to_char(r.proximo_esperado,'DD/Mon') END
        || CASE WHEN r.alerta_monto = 'pago_doble'
                  THEN ' (el último cargo fue doble: venía atrasado)' ELSE '' END
        || E'\n';
      v_n := v_n + 1;

      IF NOT p_dry THEN
        UPDATE vecino.recurring_bill_events
           SET avisos = avisos + 1, ultimo_aviso_at = now()
         WHERE bill_id = r.bill_id AND periodo = to_char(r.proximo_esperado,'YYYY-MM-DD');
      END IF;
    END LOOP;

    CONTINUE WHEN v_n = 0;
    v_total := v_total + v_n;

    v_msg := '💳 *Pagos por revisar* — ' || c.nombre || E'\n\n' || v_lineas
          || E'\nSe detecta por el cargo en el banco, no por el recibo.';

    -- Si el estado de cuenta está atrasado, lo digo ANTES: sin él no puedo
    -- afirmar que algo no se pagó.
    IF v_stale IS NULL THEN
      v_msg := v_msg || E'\n⚠️ No hay estado de cuenta cargado: esto es lo que se sabe, no lo que pasó.';
    ELSIF v_stale > 5 THEN
      v_msg := v_msg || E'\n⚠️ El estado de cuenta lleva ' || v_stale ||
               ' días sin subirse — puede que ya estén pagados y no se vea.';
    END IF;

    v_previa := v_previa || to_jsonb(v_msg);

    IF NOT p_dry THEN
      FOR v_chat IN SELECT p.id, p.telegram_chat_id FROM vecino.profiles p
                     WHERE p.colonia_id = c.id AND p.role = 'comite'
                       AND p.telegram_chat_id IS NOT NULL
      LOOP
        PERFORM vecino.tg_send(v_chat.telegram_chat_id, v_msg);
        INSERT INTO vecino.notifications (colonia_id, profile_id, tipo, mensaje, canal, estado_envio, enviado_at)
        VALUES (c.id, v_chat.id, 'pagos_recurrentes', v_msg, 'telegram', 'enviado', now());
        v_avisos := v_avisos + 1;
      END LOOP;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'pagos_en_alerta', v_total,
                            'avisos_enviados', v_avisos, 'dry', p_dry,
                            'mensajes', CASE WHEN p_dry THEN v_previa ELSE NULL END);
END $$;

GRANT EXECUTE ON FUNCTION vecino.pagos_recurrentes_estado()                        TO authenticated;
GRANT EXECUTE ON FUNCTION vecino.recurring_bill_marcar_pagado(uuid, date, text)    TO authenticated;
GRANT EXECUTE ON FUNCTION vecino.cron_pagos_recurrentes(text, boolean)             TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────
-- 5. Semilla — Villa Catania. Firmas leídas del histórico real (ene-jul 2026),
--    de preferencia el RFC del proveedor: es lo único estable del concepto.
-- ─────────────────────────────────────────────────────────────
INSERT INTO vecino.recurring_bills
  (colonia_id, nombre, categoria, patron, periodicidad, cargos_por_periodo,
   monto_min, monto_max, dia_esperado, gracia_dias, aviso_dias_antes, nota)
SELECT c.id, v.nombre, v.categoria, v.patron, v.periodicidad, v.cpp,
       v.mmin, v.mmax, v.dia, v.gracia, v.aviso, v.nota
  FROM vecino.colonias c,
  (VALUES
    ('CFE (Luz)',      'CFE (Luz)',      'CFEDP|CFE/GUIA|CFE 370814QI0',        'mensual',   2,  1500,  9000,  6, 5, 3,
       'Dos recibos por periodo (dos medidores) pagados el mismo día. Monto muy variable: $2,184-$7,926.'),
    ('JUMAPA (Agua)',  'JUMAPA (Agua)',  'JUMAPA|JMA 840106356',                'mensual',   2,   150, 14000, 27, 5, 3,
       'Dos recibos por periodo. Monto muy variable: $211-$12,191.'),
    ('Telmex',         'Telmex',         'TELMEX|TME 840315KT6',                'mensual',   1,   400,   700,  4, 3, 3,
       'Fijo $549. Un cargo de $1,098 = dos meses juntos (venía atrasado).'),
    ('Basura',         'Basura',         'BASURA',                              'mensual',   1,  3500,  4500, 26, 4, 3,
       'Fijo $4,200 (enero fue $3,900).'),
    ('Vigilancia',     'Vigilancia',     'SPM080307N12|VIGILANCIA|SEGURIDAD',   'mensual',   1, 30000, 45000, 25, 4, 4,
       'Fijo $39,904. El gasto más grande de la colonia.'),
    ('Alberca',        'Alberca',        'GUMH9104139B6|ALBERCA',               'mensual',   1,  5000,  6000,  5, 4, 3,
       'Mantenimiento fijo $5,220.'),
    ('Contabilidad',   'Contabilidad',   'CONTABILIDAD|LAAT890723RQ6',          'mensual',   1,  1700,  1900,  6, 4, 3,
       'Fijo $1,850. El 4-ago pagó junio y julio juntos.'),
    ('Jardinería',     'Jardinería',     'MAOB920416NN0|JARDIN|PODA',           'quincenal', 1,  6500,  7100,  NULL, 4, 3,
       'Corte quincenal $6,960. Los extras (reparaciones, pasto) quedan fuera del rango a propósito.'),
    ('Limpieza',       'Limpieza',       'LIMPIEZA',                            'semanal',   1,   750,   900,  NULL, 3, 2,
       'Fijo $810 por semana.')
  ) AS v(nombre, categoria, patron, periodicidad, cpp, mmin, mmax, dia, gracia, aviso, nota)
 WHERE c.nombre = 'Villa Catania'
ON CONFLICT (colonia_id, nombre) DO NOTHING;

NOTIFY pgrst, 'reload schema';
