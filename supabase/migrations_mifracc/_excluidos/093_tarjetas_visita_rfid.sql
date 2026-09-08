-- TODO(mifracc): archivo original dividido en 093a_tag_type_visita.sql (el
-- ALTER TYPE, aplicado por separado, en su propia transacción) y
-- 093b_tarjetas_visita_rfid.sql (el resto: backfill + funciones + trigger).
-- Movido aquí para que no se aplique dos veces por accidente — ver
-- docs/PLAN_SCHEMA_MIFRACC.md / la conversación de handle_new_user para el
-- porqué del split (Postgres no permite usar un valor de enum recién
-- agregado en la misma transacción que lo agrega).

-- 093 — Tarjetas de VISITA en el ciclo RFID completo (aplicada en prod 2026-08-05)
--
-- Bug de fondo: el flujo de entrega de tarjetas de visita nunca creaba la fila
-- en mifracc.rfid_tags, y rfid_reconcile_plan solo enrolaba tipo='vehiculo'.
-- Resultado: tarjeta pagada/impresa/entregada que el panel DS-K2812 no conocía
-- ("tarjeta no existe" → no abre). 8 de 11 visitas entregadas estaban muertas;
-- las 3 vivas eran INSERTs manuales disfrazados de 'vehiculo'.
--
-- NOTA: el ALTER TYPE debe correr en su propia transacción, ANTES del resto.
ALTER TYPE mifracc.tag_type ADD VALUE IF NOT EXISTS 'visita';

-- ── Backfill: visitas entregadas sin tag ─────────────────────────────────────
INSERT INTO mifracc.rfid_tags (colonia_id, house_id, codigo_tag, tipo, status, impresa_at)
SELECT cr.colonia_id, cr.house_id, ci.serial,
       'visita'::mifracc.tag_type, 'activo'::mifracc.tag_status, cr.delivered_at
FROM mifracc.card_requests cr
JOIN mifracc.card_inventory ci ON ci.card_request_id = cr.id
WHERE cr.tipo = 'visita'
  AND cr.estado = 'entregada'
  AND NOT EXISTS (SELECT 1 FROM mifracc.rfid_tags rt
                  WHERE rt.colonia_id = cr.colonia_id AND rt.codigo_tag = ci.serial)
ON CONFLICT (colonia_id, codigo_tag) DO NOTHING;

-- ── Plan de reconciliación: enrola visita además de vehiculo, y expone
--    tipo + beneficiario (visitas) para el aviso de Telegram del poller.
--    El DS-K2812 ignora byName en el record de tarjeta (verificado 2026-08-05),
--    así que la identidad visible para humanos viaja en el aviso, no en el panel.
CREATE OR REPLACE FUNCTION mifracc.rfid_reconcile_plan(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'mifracc', 'public'
AS $function$
DECLARE v_plan jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM mifracc.bot_config WHERE token = p_token) THEN
    RAISE EXCEPTION 'token invalido';
  END IF;
  -- 'prio' ordena el plan (UNION ALL no garantiza orden) y se quita del JSON
  -- que ve la Orin: la baja de la vieja va antes del alta de la nueva.
  SELECT COALESCE(jsonb_agg(to_jsonb(x) - 'prio' ORDER BY x.prio), '[]'::jsonb)
    INTO v_plan FROM (
    -- BAJA: tarjeta reemplazada o perdida que el panel todavía conoce.
    SELECT 0 AS prio, t.id AS tag_id, t.codigo_tag, 'revoke' AS action,
           COALESCE(t.motivo, 'reemplazo') AS motivo, h.numero AS casa, h.saldo,
           t.tipo::text AS tipo, NULL::text AS beneficiario
    FROM mifracc.rfid_tags t
    JOIN mifracc.houses h ON h.id = t.house_id
    WHERE t.status = 'baja'
      AND t.enrolled_at IS NOT NULL
    UNION ALL
    -- ALTA en panel: tag vehicular o de visita activo aún sin enrolar
    -- (tarjeta nueva del sistema). Las casas en mora o forzadas a suspensión
    -- NO se enrolan: sin alta el panel niega el paso (mismo efecto que
    -- suspendida) y al regularizarse el ciclo la enrola solo.
    -- 'beneficiario' (solo visitas): a quién se emitió, para el aviso.
    SELECT 1, t.id AS tag_id, t.codigo_tag, 'enroll' AS action, 'alta' AS motivo,
           h.numero AS casa, h.saldo, t.tipo::text AS tipo, ben.beneficiario
    FROM mifracc.rfid_tags t
    JOIN mifracc.houses h ON h.id = t.house_id
    JOIN mifracc.colonias c ON c.id = h.colonia_id
    LEFT JOIN LATERAL (
      SELECT cr.beneficiario_nombre AS beneficiario
      FROM mifracc.card_inventory ci
      JOIN mifracc.card_requests cr ON cr.id = ci.card_request_id
      WHERE ci.colonia_id = t.colonia_id AND ci.serial = t.codigo_tag
      LIMIT 1
    ) ben ON t.tipo = 'visita'
    WHERE t.tipo IN ('vehiculo', 'visita')
      AND t.status = 'activo'
      AND t.enrolled_at IS NULL
      AND h.rfid_override <> 'forzar_suspendido'
      AND NOT (h.rfid_override = 'auto'
               AND h.saldo >= c.umbral_suspension_rfid
               AND NOT EXISTS (SELECT 1 FROM mifracc.payment_plans pp
                               WHERE pp.house_id = h.id AND pp.activo))
    UNION ALL
    -- SUSPENDER por mora: override 'auto', casa en mora (umbral de su colonia) sin convenio
    SELECT 2, t.id AS tag_id, t.codigo_tag, 'suspend' AS action, 'mora' AS motivo,
           h.numero AS casa, h.saldo, t.tipo::text, NULL::text
    FROM mifracc.rfid_tags t
    JOIN mifracc.houses h ON h.id = t.house_id
    JOIN mifracc.colonias c ON c.id = h.colonia_id
    WHERE t.status = 'activo'
      AND t.enrolled_at IS NOT NULL      -- solo lo que el panel ya conoce
      AND h.rfid_override = 'auto'
      AND h.saldo >= c.umbral_suspension_rfid
      AND NOT EXISTS (SELECT 1 FROM mifracc.payment_plans pp
                      WHERE pp.house_id = h.id AND pp.activo)
    UNION ALL
    -- SUSPENDER manual: el comité forzó la suspensión de la casa
    SELECT 2, t.id, t.codigo_tag, 'suspend', 'manual', h.numero, h.saldo,
           t.tipo::text, NULL::text
    FROM mifracc.rfid_tags t
    JOIN mifracc.houses h ON h.id = t.house_id
    WHERE t.status = 'activo'
      AND t.enrolled_at IS NOT NULL      -- solo lo que el panel ya conoce
      AND h.rfid_override = 'forzar_suspendido'
    UNION ALL
    -- REACTIVAR: tag suspendido por nosotros (mora o manual) cuando el comité
    -- fuerza activo, o en 'auto' la casa ya no cumple la condición de mora
    SELECT 3, t.id, t.codigo_tag, 'reactivate', t.motivo, h.numero, h.saldo,
           t.tipo::text, NULL::text
    FROM mifracc.rfid_tags t
    JOIN mifracc.houses h ON h.id = t.house_id
    JOIN mifracc.colonias c ON c.id = h.colonia_id
    WHERE t.status = 'suspendido'
      AND t.motivo IN ('mora','manual')
      AND (
        h.rfid_override = 'forzar_activo'
        OR (h.rfid_override = 'auto'
            AND NOT (h.saldo >= c.umbral_suspension_rfid
                     AND NOT EXISTS (SELECT 1 FROM mifracc.payment_plans pp
                                     WHERE pp.house_id = h.id AND pp.activo)))
      )
  ) x;
  RETURN v_plan;
END $function$;

-- ── Corrección de fondo: entregar una tarjeta de visita crea su rfid_tag en
--    la misma transacción — sin esta fila la Orin nunca la enrola.
CREATE OR REPLACE FUNCTION mifracc.card_delivery_create_tag()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'mifracc', 'public'
AS $$
BEGIN
  INSERT INTO mifracc.rfid_tags (colonia_id, house_id, codigo_tag, tipo, status, impresa_at)
  SELECT cr.colonia_id, cr.house_id, NEW.serial,
         'visita'::mifracc.tag_type, 'activo'::mifracc.tag_status, NEW.delivered_at
  FROM mifracc.card_requests cr
  WHERE cr.id = NEW.card_request_id
    AND cr.tipo = 'visita'
  ON CONFLICT (colonia_id, codigo_tag) DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_card_delivery_create_tag ON mifracc.card_deliveries;
CREATE TRIGGER trg_card_delivery_create_tag
  AFTER INSERT ON mifracc.card_deliveries
  FOR EACH ROW
  EXECUTE FUNCTION mifracc.card_delivery_create_tag();

NOTIFY pgrst, 'reload schema';
