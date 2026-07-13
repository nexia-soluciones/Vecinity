-- 060: Panel comité de acceso RFID — override por casa + umbral editable + heartbeat Orin
-- La Orin pollea (rfid_reconcile_plan); el comité gobierna desde la app vía estas piezas.
-- Override por casa: 'auto' (regla de mora) · 'forzar_activo' (exenta) · 'forzar_suspendido'.

-- 1. Override por casa -------------------------------------------------------
ALTER TABLE vecino.houses
  ADD COLUMN IF NOT EXISTS rfid_override text NOT NULL DEFAULT 'auto'
    CHECK (rfid_override IN ('auto','forzar_activo','forzar_suspendido')),
  ADD COLUMN IF NOT EXISTS rfid_override_motivo text,
  ADD COLUMN IF NOT EXISTS rfid_override_by uuid,
  ADD COLUMN IF NOT EXISTS rfid_override_at timestamptz;

-- 2. Singleton de servicio: heartbeat de la Orin ------------------------------
CREATE TABLE IF NOT EXISTS vecino.rfid_service (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  orin_last_seen_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO vecino.rfid_service (id) VALUES (1) ON CONFLICT DO NOTHING;
ALTER TABLE vecino.rfid_service ENABLE ROW LEVEL SECURITY;
-- Sin policies: solo RPCs SECURITY DEFINER la tocan.

-- 3. Bitácora de cambios del panel --------------------------------------------
CREATE TABLE IF NOT EXISTS vecino.rfid_panel_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo text NOT NULL CHECK (tipo IN ('override','umbral')),
  house_id uuid REFERENCES vecino.houses(id),
  colonia_id uuid REFERENCES vecino.colonias(id),
  valor_anterior text,
  valor_nuevo text NOT NULL,
  motivo text,
  changed_by uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE vecino.rfid_panel_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rfid_panel_log_comite ON vecino.rfid_panel_log;
CREATE POLICY rfid_panel_log_comite ON vecino.rfid_panel_log
  FOR SELECT USING (vecino.is_admin());

-- 4. RPC: fijar override de una casa (comité) ---------------------------------
CREATE OR REPLACE FUNCTION vecino.rfid_set_override(
  p_house_id uuid, p_override text, p_motivo text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE v_old text; v_numero text;
BEGIN
  IF NOT vecino.is_admin() THEN
    RAISE EXCEPTION 'Solo el comité puede cambiar el acceso RFID.';
  END IF;
  IF p_override NOT IN ('auto','forzar_activo','forzar_suspendido') THEN
    RAISE EXCEPTION 'Estado inválido: %', p_override;
  END IF;
  IF p_override <> 'auto' AND COALESCE(btrim(p_motivo), '') = '' THEN
    RAISE EXCEPTION 'Indica el motivo del cambio.';
  END IF;
  SELECT rfid_override, numero INTO v_old, v_numero
    FROM vecino.houses WHERE id = p_house_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Casa no encontrada.';
  END IF;
  UPDATE vecino.houses
     SET rfid_override = p_override,
         rfid_override_motivo = CASE WHEN p_override = 'auto' THEN NULL ELSE btrim(p_motivo) END,
         rfid_override_by = auth.uid(),
         rfid_override_at = now()
   WHERE id = p_house_id;
  INSERT INTO vecino.rfid_panel_log (tipo, house_id, valor_anterior, valor_nuevo, motivo, changed_by)
  VALUES ('override', p_house_id, v_old, p_override, btrim(p_motivo), auth.uid());
  RETURN jsonb_build_object('ok', true, 'casa', v_numero,
                            'anterior', v_old, 'nuevo', p_override);
END $$;

-- 5. RPC: fijar umbral de suspensión por colonia (comité) ---------------------
CREATE OR REPLACE FUNCTION vecino.rfid_set_umbral(p_colonia_id uuid, p_umbral numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE v_old numeric; v_nombre text;
BEGIN
  IF NOT vecino.is_admin() THEN
    RAISE EXCEPTION 'Solo el comité puede cambiar el umbral.';
  END IF;
  IF p_umbral IS NULL OR p_umbral <= 0 OR p_umbral > 1000000 THEN
    RAISE EXCEPTION 'Umbral inválido: debe ser mayor a $0.';
  END IF;
  SELECT umbral_suspension_rfid, nombre INTO v_old, v_nombre
    FROM vecino.colonias WHERE id = p_colonia_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Colonia no encontrada.';
  END IF;
  UPDATE vecino.colonias SET umbral_suspension_rfid = p_umbral WHERE id = p_colonia_id;
  INSERT INTO vecino.rfid_panel_log (tipo, colonia_id, valor_anterior, valor_nuevo, changed_by)
  VALUES ('umbral', p_colonia_id, v_old::text, p_umbral::text, auth.uid());
  RETURN jsonb_build_object('ok', true, 'colonia', v_nombre,
                            'anterior', v_old, 'nuevo', p_umbral);
END $$;

-- 6. RPC: datos del panel (comité) --------------------------------------------
CREATE OR REPLACE FUNCTION vecino.rfid_panel_data()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
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
               (h.saldo <= -c.umbral_suspension_rfid
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
END $$;

-- 7. RPC: heartbeat de la Orin (token de bot, mismo gate que el poller) --------
CREATE OR REPLACE FUNCTION vecino.rfid_heartbeat(p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vecino.bot_config WHERE token = p_token) THEN
    RAISE EXCEPTION 'token invalido';
  END IF;
  UPDATE vecino.rfid_service SET orin_last_seen_at = now(), updated_at = now() WHERE id = 1;
  RETURN jsonb_build_object('ok', true);
END $$;

-- 8. rfid_mark ahora acepta motivo (mora|manual). DROP primero: agregar un
--    parámetro con DEFAULT dejaría la firma vieja viva → sobrecarga ambigua
--    en PostgREST (gotcha documentado en MEMORY).
DROP FUNCTION IF EXISTS vecino.rfid_mark(text, uuid, text);
CREATE OR REPLACE FUNCTION vecino.rfid_mark(
  p_token text, p_tag_id uuid, p_action text, p_motivo text DEFAULT 'mora')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE v_rows int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vecino.bot_config WHERE token = p_token) THEN
    RAISE EXCEPTION 'token invalido';
  END IF;
  IF p_action = 'suspend' THEN
    IF p_motivo NOT IN ('mora','manual') THEN
      RAISE EXCEPTION 'motivo invalido: %', p_motivo;
    END IF;
    UPDATE vecino.rfid_tags
       SET status = 'suspendido', motivo = p_motivo,
           suspended_at = now(), reactivated_at = NULL
     WHERE id = p_tag_id AND status = 'activo';
  ELSIF p_action = 'reactivate' THEN
    -- Reactivamos solo lo que nosotros suspendimos (mora o manual);
    -- otros motivos (p. ej. tarjeta perdida) no se tocan.
    UPDATE vecino.rfid_tags
       SET status = 'activo', motivo = NULL, reactivated_at = now()
     WHERE id = p_tag_id AND status = 'suspendido' AND motivo IN ('mora','manual');
  ELSE
    RAISE EXCEPTION 'accion invalida: %', p_action;
  END IF;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('updated', v_rows);
END $$;

-- 9. rfid_reconcile_plan con override por casa --------------------------------
--    Prioridad: forzar_* del comité gana a la regla de mora. En 'auto', la
--    regla de saldo gobierna también los tags suspendidos manualmente (si la
--    casa está bien, se reactivan; si está en mora, se re-etiquetan al ciclo
--    en que la regla los tome).
CREATE OR REPLACE FUNCTION vecino.rfid_reconcile_plan(p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE v_plan jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vecino.bot_config WHERE token = p_token) THEN
    RAISE EXCEPTION 'token invalido';
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb) INTO v_plan FROM (
    -- SUSPENDER por mora: override 'auto', casa en mora (umbral de su colonia) sin convenio
    SELECT t.id AS tag_id, t.codigo_tag, 'suspend' AS action, 'mora' AS motivo,
           h.numero AS casa, h.saldo
    FROM vecino.rfid_tags t
    JOIN vecino.houses h ON h.id = t.house_id
    JOIN vecino.colonias c ON c.id = h.colonia_id
    WHERE t.status = 'activo'
      AND h.rfid_override = 'auto'
      AND h.saldo <= -c.umbral_suspension_rfid
      AND NOT EXISTS (SELECT 1 FROM vecino.payment_plans pp
                      WHERE pp.house_id = h.id AND pp.activo)
    UNION ALL
    -- SUSPENDER manual: el comité forzó la suspensión de la casa
    SELECT t.id, t.codigo_tag, 'suspend', 'manual', h.numero, h.saldo
    FROM vecino.rfid_tags t
    JOIN vecino.houses h ON h.id = t.house_id
    WHERE t.status = 'activo'
      AND h.rfid_override = 'forzar_suspendido'
    UNION ALL
    -- REACTIVAR: tag suspendido por nosotros (mora o manual) cuando el comité
    -- fuerza activo, o en 'auto' la casa ya no cumple la condición de mora
    SELECT t.id, t.codigo_tag, 'reactivate', t.motivo, h.numero, h.saldo
    FROM vecino.rfid_tags t
    JOIN vecino.houses h ON h.id = t.house_id
    JOIN vecino.colonias c ON c.id = h.colonia_id
    WHERE t.status = 'suspendido'
      AND t.motivo IN ('mora','manual')
      AND (
        h.rfid_override = 'forzar_activo'
        OR (h.rfid_override = 'auto'
            AND NOT (h.saldo <= -c.umbral_suspension_rfid
                     AND NOT EXISTS (SELECT 1 FROM vecino.payment_plans pp
                                     WHERE pp.house_id = h.id AND pp.activo)))
      )
  ) x;
  RETURN v_plan;
END $$;
