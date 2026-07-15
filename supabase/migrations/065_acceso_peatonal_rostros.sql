-- 065: Acceso peatonal por rostro — terminal facial DS-K1T342 en la puerta peatonal
--
-- Flujo: el vecino sube foto de su cara (fondo blanco) desde la app → el comité
-- la aprueba → la Orin (poller del access-bridge) la enrola en la terminal por
-- ISAPI. La mora suspende el rostro igual que las tarjetas vehiculares (misma
-- regla de saldo/umbral/convenio y mismo override por casa houses.rfid_override).
--
-- La foto vive EN LA BD (photo_b64, JPEG comprimido ~100 KB): así la Orin la
-- baja con el mismo token de bot_config que ya usa, sin service key ni bucket
-- público (biometría no va en un bucket con getPublicUrl). Las listas NUNCA
-- seleccionan photo_b64; se pide por id vía face_photo().

-- 1. Tabla ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vecino.face_enrollments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- employeeNo en la terminal (numérico corto; arranca en 1001 para no chocar
  -- con usuarios manuales del instalador tipo '00000001')
  enroll_no    int GENERATED ALWAYS AS IDENTITY (START WITH 1001) UNIQUE,
  house_id     uuid NOT NULL REFERENCES vecino.houses(id) ON DELETE CASCADE,
  profile_id   uuid REFERENCES vecino.profiles(id) ON DELETE SET NULL,
  nombre       text NOT NULL CHECK (btrim(nombre) <> ''),
  photo_b64    text NOT NULL,
  status       text NOT NULL DEFAULT 'recibida'
               CHECK (status IN ('recibida','aprobada','enrolada','suspendida',
                                 'rechazada','retirada')),
  -- suspendida: 'mora'|'manual' · rechazada: texto libre del comité
  motivo       text,
  approved_by  uuid,
  approved_at  timestamptz,
  enrolled_at  timestamptz,
  suspended_at timestamptz,
  reactivated_at timestamptz,
  -- retirada ya enrolada: pendiente de borrar en la terminal hasta que la Orin marque
  terminal_removed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_face_enrollments_house ON vecino.face_enrollments(house_id);
CREATE INDEX IF NOT EXISTS idx_face_enrollments_status ON vecino.face_enrollments(status);

ALTER TABLE vecino.face_enrollments ENABLE ROW LEVEL SECURITY;
-- Solo SELECT directo (listas de la casa / comité). Escrituras: solo RPCs.
DROP POLICY IF EXISTS face_enrollments_select ON vecino.face_enrollments;
CREATE POLICY face_enrollments_select ON vecino.face_enrollments
  FOR SELECT USING (
    vecino.is_admin()
    OR house_id IN (SELECT house_id FROM vecino.profiles WHERE id = auth.uid())
    OR house_id IN (SELECT house_id FROM vecino.house_members WHERE profile_id = auth.uid())
  );

-- 2. RPC: el vecino manda una foto ----------------------------------------------
CREATE OR REPLACE FUNCTION vecino.face_submit(
  p_nombre text, p_photo_b64 text, p_house_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE v_house uuid; v_id uuid; v_activos int;
BEGIN
  -- Casa: la del perfil, o una explícita si el perfil está ligado a ella
  SELECT house_id INTO v_house FROM vecino.profiles
   WHERE id = auth.uid() AND approval_status = 'aprobado';
  IF p_house_id IS NOT NULL THEN
    IF p_house_id <> v_house AND NOT EXISTS (
        SELECT 1 FROM vecino.house_members
        WHERE profile_id = auth.uid() AND house_id = p_house_id) THEN
      RAISE EXCEPTION 'No estás ligado a esa casa.';
    END IF;
    v_house := p_house_id;
  END IF;
  IF v_house IS NULL THEN
    RAISE EXCEPTION 'Tu cuenta no tiene casa asignada.';
  END IF;
  IF COALESCE(btrim(p_nombre), '') = '' THEN
    RAISE EXCEPTION 'Escribe el nombre de la persona.';
  END IF;
  -- ~400 KB base64 ≈ 300 KB JPEG: más que eso no es una foto comprimida por la app
  IF p_photo_b64 IS NULL OR length(p_photo_b64) < 1000 OR length(p_photo_b64) > 400000 THEN
    RAISE EXCEPTION 'La foto no es válida. Tómala de nuevo desde la app.';
  END IF;
  SELECT count(*) INTO v_activos FROM vecino.face_enrollments
   WHERE house_id = v_house AND status NOT IN ('rechazada','retirada');
  IF v_activos >= 10 THEN
    RAISE EXCEPTION 'Esta casa ya tiene 10 rostros registrados. Retira alguno antes de agregar otro.';
  END IF;
  INSERT INTO vecino.face_enrollments (house_id, profile_id, nombre, photo_b64)
  VALUES (v_house, auth.uid(), btrim(p_nombre), p_photo_b64)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

-- 3. RPC: retirar un rostro ------------------------------------------------------
--    Vecino: solo los suyos y solo si aún no está en la terminal.
--    Comité: cualquiera; si ya estaba enrolado queda pendiente de borrado físico.
CREATE OR REPLACE FUNCTION vecino.face_retire(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM vecino.face_enrollments WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Registro no encontrado.'; END IF;
  IF r.status = 'retirada' THEN RETURN jsonb_build_object('ok', true); END IF;
  IF NOT vecino.is_admin() THEN
    IF r.house_id NOT IN (
        SELECT house_id FROM vecino.profiles WHERE id = auth.uid()
        UNION SELECT house_id FROM vecino.house_members WHERE profile_id = auth.uid()) THEN
      RAISE EXCEPTION 'Ese rostro no es de tu casa.';
    END IF;
    IF r.status NOT IN ('recibida','rechazada') THEN
      RAISE EXCEPTION 'Ese rostro ya está activo en la puerta; pide al comité retirarlo.';
    END IF;
  END IF;
  UPDATE vecino.face_enrollments SET status = 'retirada' WHERE id = p_id;
  RETURN jsonb_build_object('ok', true,
    'pendiente_borrado', r.enrolled_at IS NOT NULL AND r.terminal_removed_at IS NULL);
END $$;

-- 4. RPC: el comité aprueba o rechaza -------------------------------------------
CREATE OR REPLACE FUNCTION vecino.face_review(p_id uuid, p_aprobar boolean, p_motivo text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE r record;
BEGIN
  IF NOT vecino.is_admin() THEN
    RAISE EXCEPTION 'Solo el comité puede revisar rostros.';
  END IF;
  SELECT * INTO r FROM vecino.face_enrollments WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Registro no encontrado.'; END IF;
  IF r.status <> 'recibida' THEN
    RAISE EXCEPTION 'Este rostro ya fue revisado (estado: %).', r.status;
  END IF;
  IF p_aprobar THEN
    UPDATE vecino.face_enrollments
       SET status = 'aprobada', approved_by = auth.uid(), approved_at = now(), motivo = NULL
     WHERE id = p_id;
  ELSE
    IF COALESCE(btrim(p_motivo), '') = '' THEN
      RAISE EXCEPTION 'Indica el motivo del rechazo (el vecino lo verá).';
    END IF;
    UPDATE vecino.face_enrollments
       SET status = 'rechazada', approved_by = auth.uid(), approved_at = now(),
           motivo = btrim(p_motivo)
     WHERE id = p_id;
  END IF;
  RETURN jsonb_build_object('ok', true, 'status',
    CASE WHEN p_aprobar THEN 'aprobada' ELSE 'rechazada' END);
END $$;

-- 5. RPC: foto individual (comité o miembros de la casa) -------------------------
CREATE OR REPLACE FUNCTION vecino.face_photo(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE r record;
BEGIN
  SELECT house_id, photo_b64 INTO r FROM vecino.face_enrollments WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Registro no encontrado.'; END IF;
  IF NOT vecino.is_admin() AND r.house_id NOT IN (
      SELECT house_id FROM vecino.profiles WHERE id = auth.uid()
      UNION SELECT house_id FROM vecino.house_members WHERE profile_id = auth.uid()) THEN
    RAISE EXCEPTION 'Ese rostro no es de tu casa.';
  END IF;
  RETURN jsonb_build_object('ok', true, 'photo_b64', r.photo_b64);
END $$;

-- 6. RPC: plan de sincronización para la Orin (token de bot, patrón rfid) --------
--    enroll: aprobadas (incluye la foto) · suspend/reactivate: misma regla de
--    mora + override que rfid_reconcile_plan · remove: retiradas ya enroladas.
CREATE OR REPLACE FUNCTION vecino.face_sync_plan(p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE v_plan jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vecino.bot_config WHERE token = p_token) THEN
    RAISE EXCEPTION 'token invalido';
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb) INTO v_plan FROM (
    -- ENROLAR: aprobada por el comité, aún no en la terminal
    SELECT f.id, f.enroll_no, f.nombre, 'enroll' AS action, NULL::text AS motivo,
           h.numero AS casa, h.saldo, f.photo_b64
    FROM vecino.face_enrollments f
    JOIN vecino.houses h ON h.id = f.house_id
    WHERE f.status = 'aprobada'
    UNION ALL
    -- SUSPENDER por mora (override auto) — misma condición que las tarjetas
    SELECT f.id, f.enroll_no, f.nombre, 'suspend', 'mora', h.numero, h.saldo, NULL
    FROM vecino.face_enrollments f
    JOIN vecino.houses h ON h.id = f.house_id
    JOIN vecino.colonias c ON c.id = h.colonia_id
    WHERE f.status = 'enrolada'
      AND h.rfid_override = 'auto'
      AND h.saldo <= -c.umbral_suspension_rfid
      AND NOT EXISTS (SELECT 1 FROM vecino.payment_plans pp
                      WHERE pp.house_id = h.id AND pp.activo)
    UNION ALL
    -- SUSPENDER manual: el comité forzó la casa
    SELECT f.id, f.enroll_no, f.nombre, 'suspend', 'manual', h.numero, h.saldo, NULL
    FROM vecino.face_enrollments f
    JOIN vecino.houses h ON h.id = f.house_id
    WHERE f.status = 'enrolada'
      AND h.rfid_override = 'forzar_suspendido'
    UNION ALL
    -- REACTIVAR: suspendida por nosotros y la casa ya no cumple la condición
    SELECT f.id, f.enroll_no, f.nombre, 'reactivate', f.motivo, h.numero, h.saldo, NULL
    FROM vecino.face_enrollments f
    JOIN vecino.houses h ON h.id = f.house_id
    JOIN vecino.colonias c ON c.id = h.colonia_id
    WHERE f.status = 'suspendida'
      AND f.motivo IN ('mora','manual')
      AND (
        h.rfid_override = 'forzar_activo'
        OR (h.rfid_override = 'auto'
            AND NOT (h.saldo <= -c.umbral_suspension_rfid
                     AND NOT EXISTS (SELECT 1 FROM vecino.payment_plans pp
                                     WHERE pp.house_id = h.id AND pp.activo)))
      )
    UNION ALL
    -- BORRAR de la terminal: retirada que sí llegó a enrolarse
    SELECT f.id, f.enroll_no, f.nombre, 'remove', NULL, h.numero, h.saldo, NULL
    FROM vecino.face_enrollments f
    JOIN vecino.houses h ON h.id = f.house_id
    WHERE f.status = 'retirada'
      AND f.enrolled_at IS NOT NULL
      AND f.terminal_removed_at IS NULL
  ) x;
  RETURN v_plan;
END $$;

-- 7. RPC: la Orin marca lo que SÍ aplicó en la terminal ---------------------------
CREATE OR REPLACE FUNCTION vecino.face_mark(
  p_token text, p_id uuid, p_action text, p_motivo text DEFAULT 'mora')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE v_rows int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vecino.bot_config WHERE token = p_token) THEN
    RAISE EXCEPTION 'token invalido';
  END IF;
  IF p_action = 'enroll' THEN
    UPDATE vecino.face_enrollments
       SET status = 'enrolada', enrolled_at = now()
     WHERE id = p_id AND status = 'aprobada';
  ELSIF p_action = 'suspend' THEN
    IF p_motivo NOT IN ('mora','manual') THEN
      RAISE EXCEPTION 'motivo invalido: %', p_motivo;
    END IF;
    UPDATE vecino.face_enrollments
       SET status = 'suspendida', motivo = p_motivo,
           suspended_at = now(), reactivated_at = NULL
     WHERE id = p_id AND status = 'enrolada';
  ELSIF p_action = 'reactivate' THEN
    UPDATE vecino.face_enrollments
       SET status = 'enrolada', motivo = NULL, reactivated_at = now()
     WHERE id = p_id AND status = 'suspendida' AND motivo IN ('mora','manual');
  ELSIF p_action = 'remove' THEN
    UPDATE vecino.face_enrollments
       SET terminal_removed_at = now()
     WHERE id = p_id AND status = 'retirada';
  ELSE
    RAISE EXCEPTION 'accion invalida: %', p_action;
  END IF;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('updated', v_rows);
END $$;

-- 8. RPC: datos del panel del comité (sin fotos; la foto se pide por id) ----------
CREATE OR REPLACE FUNCTION vecino.face_panel_data()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
BEGIN
  IF NOT vecino.is_admin() THEN
    RAISE EXCEPTION 'Solo el comité puede ver este panel.';
  END IF;
  RETURN jsonb_build_object(
    'pendientes', (
      SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.created_at), '[]'::jsonb) FROM (
        SELECT f.id, f.nombre, f.created_at, h.numero AS casa,
               pr.nombre AS subido_por
        FROM vecino.face_enrollments f
        JOIN vecino.houses h ON h.id = f.house_id
        LEFT JOIN vecino.profiles pr ON pr.id = f.profile_id
        WHERE f.status = 'recibida'
      ) p
    ),
    'activos', (
      SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.casa, a.nombre), '[]'::jsonb) FROM (
        SELECT f.id, f.enroll_no, f.nombre, f.status, f.motivo,
               f.enrolled_at, f.suspended_at, h.numero AS casa
        FROM vecino.face_enrollments f
        JOIN vecino.houses h ON h.id = f.house_id
        WHERE f.status IN ('aprobada','enrolada','suspendida')
      ) a
    ),
    'pendiente_borrado', (
      SELECT count(*) FROM vecino.face_enrollments
      WHERE status = 'retirada' AND enrolled_at IS NOT NULL AND terminal_removed_at IS NULL
    )
  );
END $$;

-- 9. GRANTs -----------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION vecino.face_submit(text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION vecino.face_retire(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION vecino.face_review(uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION vecino.face_photo(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION vecino.face_panel_data() TO authenticated;
-- Las de la Orin viajan con anon key + token de bot (mismo patrón que rfid_*)
GRANT EXECUTE ON FUNCTION vecino.face_sync_plan(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.face_mark(text, uuid, text, text) TO anon, authenticated, service_role;
