-- 090: Corrige signo de la condición de mora RFID.
-- Convención del sistema: saldo > 0 = adeudo, saldo < 0 = a favor
-- (igual que crear_reserva, notify_saldo y la consola de caseta).
-- rfid_reconcile_plan y rfid_panel_data usaban saldo <= -umbral,
-- que suspendía/bloqueaba a casas CON SALDO A FAVOR (103, 234) y
-- habría dejado pasar a morosos reales. Mora = saldo >= umbral.
-- Incluye la versión viva del plan (rama revoke del 2026-07-21 que
-- no estaba en ninguna migración).

CREATE OR REPLACE FUNCTION vecino.rfid_reconcile_plan(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'vecino', 'public'
AS $function$
DECLARE v_plan jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vecino.bot_config WHERE token = p_token) THEN
    RAISE EXCEPTION 'token invalido';
  END IF;
  -- 'prio' ordena el plan (UNION ALL no garantiza orden) y se quita del JSON
  -- que ve la Orin: la baja de la vieja va antes del alta de la nueva.
  SELECT COALESCE(jsonb_agg(to_jsonb(x) - 'prio' ORDER BY x.prio), '[]'::jsonb)
    INTO v_plan FROM (
    -- BAJA: tarjeta reemplazada o perdida que el panel todavía conoce.
    SELECT 0 AS prio, t.id AS tag_id, t.codigo_tag, 'revoke' AS action,
           COALESCE(t.motivo, 'reemplazo') AS motivo, h.numero AS casa, h.saldo
    FROM vecino.rfid_tags t
    JOIN vecino.houses h ON h.id = t.house_id
    WHERE t.status = 'baja'
      AND t.enrolled_at IS NOT NULL
    UNION ALL
    -- ALTA en panel: tag vehicular activo aún sin enrolar (tarjeta nueva del
    -- sistema). Las casas en mora o forzadas a suspensión NO se enrolan:
    -- sin alta el panel niega el paso (mismo efecto que suspendida) y al
    -- regularizarse el ciclo la enrola solo.
    SELECT 1, t.id AS tag_id, t.codigo_tag, 'enroll' AS action, 'alta' AS motivo,
           h.numero AS casa, h.saldo
    FROM vecino.rfid_tags t
    JOIN vecino.houses h ON h.id = t.house_id
    JOIN vecino.colonias c ON c.id = h.colonia_id
    WHERE t.tipo = 'vehiculo'
      AND t.status = 'activo'
      AND t.enrolled_at IS NULL
      AND h.rfid_override <> 'forzar_suspendido'
      AND NOT (h.rfid_override = 'auto'
               AND h.saldo >= c.umbral_suspension_rfid
               AND NOT EXISTS (SELECT 1 FROM vecino.payment_plans pp
                               WHERE pp.house_id = h.id AND pp.activo))
    UNION ALL
    -- SUSPENDER por mora: override 'auto', casa en mora (umbral de su colonia) sin convenio
    SELECT 2, t.id AS tag_id, t.codigo_tag, 'suspend' AS action, 'mora' AS motivo,
           h.numero AS casa, h.saldo
    FROM vecino.rfid_tags t
    JOIN vecino.houses h ON h.id = t.house_id
    JOIN vecino.colonias c ON c.id = h.colonia_id
    WHERE t.status = 'activo'
      AND t.enrolled_at IS NOT NULL      -- solo lo que el panel ya conoce
      AND h.rfid_override = 'auto'
      AND h.saldo >= c.umbral_suspension_rfid
      AND NOT EXISTS (SELECT 1 FROM vecino.payment_plans pp
                      WHERE pp.house_id = h.id AND pp.activo)
    UNION ALL
    -- SUSPENDER manual: el comité forzó la suspensión de la casa
    SELECT 2, t.id, t.codigo_tag, 'suspend', 'manual', h.numero, h.saldo
    FROM vecino.rfid_tags t
    JOIN vecino.houses h ON h.id = t.house_id
    WHERE t.status = 'activo'
      AND t.enrolled_at IS NOT NULL      -- solo lo que el panel ya conoce
      AND h.rfid_override = 'forzar_suspendido'
    UNION ALL
    -- REACTIVAR: tag suspendido por nosotros (mora o manual) cuando el comité
    -- fuerza activo, o en 'auto' la casa ya no cumple la condición de mora
    SELECT 3, t.id, t.codigo_tag, 'reactivate', t.motivo, h.numero, h.saldo
    FROM vecino.rfid_tags t
    JOIN vecino.houses h ON h.id = t.house_id
    JOIN vecino.colonias c ON c.id = h.colonia_id
    WHERE t.status = 'suspendido'
      AND t.motivo IN ('mora','manual')
      AND (
        h.rfid_override = 'forzar_activo'
        OR (h.rfid_override = 'auto'
            AND NOT (h.saldo >= c.umbral_suspension_rfid
                     AND NOT EXISTS (SELECT 1 FROM vecino.payment_plans pp
                                     WHERE pp.house_id = h.id AND pp.activo)))
      )
  ) x;
  RETURN v_plan;
END $function$

;

CREATE OR REPLACE FUNCTION vecino.rfid_panel_data()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'vecino', 'public'
AS $function$
BEGIN
  IF NOT vecino.is_admin() THEN
    RAISE EXCEPTION 'Solo el comité puede ver este panel.';
  END IF;
  RETURN jsonb_build_object(
    'orin_last_seen_at', (SELECT orin_last_seen_at FROM vecino.rfid_service WHERE id = 1),
    'colonias', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', c.id, 'nombre', c.nombre, 'umbral', c.umbral_suspension_rfid)
               ORDER BY c.nombre), '[]'::jsonb)
      FROM vecino.colonias c
    ),
    'casas', (
      SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.numero), '[]'::jsonb) FROM (
        SELECT h.id, h.numero, h.street, h.saldo,
               h.rfid_override, h.rfid_override_motivo, h.rfid_override_at,
               (h.saldo >= c.umbral_suspension_rfid
                AND NOT EXISTS (SELECT 1 FROM vecino.payment_plans pp
                                WHERE pp.house_id = h.id AND pp.activo)) AS en_mora,
               (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                        'id', t.id, 'codigo_tag', t.codigo_tag, 'status', t.status,
                        'motivo', t.motivo, 'suspended_at', t.suspended_at)
                        ORDER BY t.codigo_tag), '[]'::jsonb)
                FROM vecino.rfid_tags t WHERE t.house_id = h.id) AS tags
        FROM vecino.houses h
        JOIN vecino.colonias c ON c.id = h.colonia_id
        WHERE h.rfid_override <> 'auto'
           OR EXISTS (SELECT 1 FROM vecino.rfid_tags t WHERE t.house_id = h.id)
      ) x
    ),
    'log', (
      SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.changed_at DESC), '[]'::jsonb) FROM (
        SELECT pl.tipo, pl.valor_anterior, pl.valor_nuevo, pl.motivo, pl.changed_at,
               h.numero AS casa, c.nombre AS colonia, pr.nombre AS quien
        FROM vecino.rfid_panel_log pl
        LEFT JOIN vecino.houses h ON h.id = pl.house_id
        LEFT JOIN vecino.colonias c ON c.id = pl.colonia_id
        LEFT JOIN vecino.profiles pr ON pr.id = pl.changed_by
        ORDER BY pl.changed_at DESC LIMIT 20
      ) l
    )
  );
END $function$

;

NOTIFY pgrst, 'reload schema';
