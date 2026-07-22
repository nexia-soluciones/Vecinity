-- =============================================================================
-- VECINITY · 091 — Ayuda de acceso del comité ("olvidé mi correo / mi contraseña")
-- schema: vecino · Supabase self-hosted Nexia
--
-- Problema real (bitácora casas 130 y 145): el vecino olvida CON QUÉ CORREO se
-- registró y su contraseña. Hoy se resuelve a mano reactivando el código CAT-<casa>
-- → el vecino se registra OTRA VEZ y queda una cuenta huérfana con su historial.
--
-- Este módulo le da al comité, dentro de la app:
--   1. Buscar por casa / nombre / correo → ver las cuentas de esa casa, con qué
--      correo se registró cada una y cuándo entró por última vez.
--   2. Reactivar el código de invitación de la casa (último recurso).
--   3. Dar de baja una cuenta huérfana SIN perder su historial (no se borra nada:
--      solo deja de tener acceso y se libera su Telegram).
--   4. Bitácora de todo lo anterior + de los enlaces de contraseña que genera el
--      servidor (Server Action con service_role) — nadie toca una cuenta a escondidas.
--
-- El enlace de contraseña nueva NO se genera aquí: lo hace la Server Action
-- `generarEnlaceReset` con /auth/v1/admin/generate_link (canal token_hash, el
-- mismo de Caty — no depende del SITE_URL ni del allow-list de GoTrue).
-- =============================================================================

BEGIN;

-- ------------------------------------------------------------
-- 1) Bitácora de soporte de acceso
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vecino.soporte_acceso_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id        uuid NOT NULL REFERENCES vecino.colonias(id) ON DELETE CASCADE,
  actor_id          uuid REFERENCES vecino.profiles(id) ON DELETE SET NULL,
  actor_nombre      text,
  target_profile_id uuid REFERENCES vecino.profiles(id) ON DELETE SET NULL,
  target_nombre     text,
  target_email      text,
  house_id          uuid REFERENCES vecino.houses(id) ON DELETE SET NULL,
  casa              text,
  -- 'enlace_password' | 'cambio_correo' | 'reactivar_invitacion'
  -- | 'baja_cuenta'    | 'reactivar_cuenta'
  accion            text NOT NULL,
  detalle           text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_soporte_acceso_log_colonia
  ON vecino.soporte_acceso_log(colonia_id, created_at DESC);

ALTER TABLE vecino.soporte_acceso_log ENABLE ROW LEVEL SECURITY;

-- Solo el comité de la colonia lee la bitácora. Las escrituras entran por las
-- RPCs de abajo (SECURITY DEFINER) o por el service_role de las Server Actions.
DROP POLICY IF EXISTS soporte_acceso_log_admin_read ON vecino.soporte_acceso_log;
CREATE POLICY soporte_acceso_log_admin_read ON vecino.soporte_acceso_log
  FOR SELECT USING (colonia_id = vecino.my_colonia_id() AND vecino.is_admin());

GRANT SELECT ON vecino.soporte_acceso_log TO authenticated;
GRANT ALL    ON vecino.soporte_acceso_log TO service_role;

-- ------------------------------------------------------------
-- 2) Buscar cuentas por casa, nombre o correo
--    Devuelve, por casa: las cuentas ligadas (vive ∪ propietario) con el correo
--    de registro y el último acceso real (auth.users), y sus invitaciones.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.soporte_buscar_cuentas(p_texto text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE
  v_col uuid := vecino.my_colonia_id();
  v_q   text := btrim(coalesce(p_texto, ''));
  v_out jsonb;
BEGIN
  IF NOT vecino.is_admin() THEN
    RAISE EXCEPTION 'Solo el comité puede consultar cuentas.';
  END IF;
  IF v_q = '' THEN
    RAISE EXCEPTION 'Escribe un número de casa, un nombre o un correo.';
  END IF;

  WITH casas AS (
    SELECT h.id, h.numero, h.street
      FROM vecino.houses h
     WHERE h.colonia_id = v_col
       AND (
         h.numero ILIKE v_q
         OR h.numero ILIKE v_q || '%'
         OR EXISTS (
           SELECT 1
             FROM vecino.profiles p
            WHERE (
                    p.house_id = h.id
                    OR EXISTS (SELECT 1 FROM vecino.house_members hm
                                WHERE hm.house_id = h.id AND hm.profile_id = p.id)
                  )
              AND (p.nombre ILIKE '%' || v_q || '%' OR p.email ILIKE '%' || v_q || '%')
         )
       )
     ORDER BY lpad(regexp_replace(h.numero, '\D', '', 'g'), 8, '0'), h.numero
     LIMIT 15
  )
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'house_id', c.id,
      'casa',     c.numero,
      'calle',    c.street,
      'cuentas', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
                 'profile_id',    p.id,
                 'nombre',        p.nombre,
                 'email',         p.email,
                 'telefono',      p.telefono,
                 'role',          p.role,
                 'aprobacion',    p.approval_status,
                 'activa',        p.is_active,
                 'relacion',      CASE WHEN p.house_id = c.id THEN 'vive' ELSE 'propietario' END,
                 'telegram',      p.telegram_chat_id IS NOT NULL,
                 'ultimo_acceso', u.last_sign_in_at,
                 'creada',        p.created_at
               ) ORDER BY p.is_active DESC, u.last_sign_in_at DESC NULLS LAST), '[]'::jsonb)
          FROM vecino.profiles p
          LEFT JOIN auth.users u ON u.id = p.id
         WHERE p.house_id = c.id
            OR EXISTS (SELECT 1 FROM vecino.house_members hm
                        WHERE hm.house_id = c.id AND hm.profile_id = p.id)
      ),
      'invitaciones', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
                 'token',       i.token,
                 'relacion',    i.relacion,
                 'usada',       i.accepted_at IS NOT NULL,
                 'expires_at',  i.expires_at,
                 'vigente',     i.accepted_at IS NULL
                                AND (i.expires_at IS NULL OR i.expires_at > now())
               ) ORDER BY i.created_at DESC), '[]'::jsonb)
          FROM vecino.invitations i
         WHERE i.house_id = c.id
      )
    )
  ), '[]'::jsonb)
    INTO v_out
  FROM casas c;

  RETURN jsonb_build_object('ok', true, 'resultados', v_out);
END $$;

GRANT EXECUTE ON FUNCTION vecino.soporte_buscar_cuentas(text) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 3) Reactivar (o crear) el código de invitación CAT-<casa>
--    Último recurso: casa sin cuenta, o cuenta irrecuperable.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.soporte_reactivar_invitacion(p_house_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE
  h           vecino.houses%ROWTYPE;
  v_inv       vecino.invitations%ROWTYPE;
  v_token     text;
  v_base      text;
  v_k         int := 1;
  v_reactivada boolean := false;
  v_vence     timestamptz := now() + interval '30 days';
BEGIN
  IF NOT vecino.is_admin() THEN
    RAISE EXCEPTION 'Solo el comité puede reactivar códigos de invitación.';
  END IF;

  SELECT * INTO h FROM vecino.houses
   WHERE id = p_house_id AND colonia_id = vecino.my_colonia_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Esa casa no existe en tu colonia.';
  END IF;

  -- Invitación de residente (relacion NULL) más reciente de la casa: se reutiliza
  -- la MISMA fila para no multiplicar códigos por casa.
  SELECT * INTO v_inv FROM vecino.invitations
   WHERE house_id = h.id AND relacion IS NULL
   ORDER BY created_at DESC LIMIT 1;

  IF FOUND THEN
    UPDATE vecino.invitations
       SET accepted_at = NULL, expires_at = v_vence
     WHERE id = v_inv.id;
    v_token := v_inv.token;
    v_reactivada := true;
  ELSE
    v_base  := 'CAT-' || regexp_replace(h.numero, '[^0-9A-Za-z]', '', 'g');
    v_token := v_base;
    WHILE EXISTS (SELECT 1 FROM vecino.invitations WHERE token = v_token) LOOP
      v_k := v_k + 1;
      v_token := v_base || '-' || v_k;
    END LOOP;
    INSERT INTO vecino.invitations (colonia_id, house_id, role, token, invited_by, expires_at)
    VALUES (h.colonia_id, h.id, 'residente', v_token, auth.uid(), v_vence);
  END IF;

  INSERT INTO vecino.soporte_acceso_log
    (colonia_id, actor_id, actor_nombre, house_id, casa, accion, detalle)
  SELECT h.colonia_id, auth.uid(), p.nombre, h.id, h.numero, 'reactivar_invitacion',
         'Código ' || v_token || ' vigente hasta ' ||
         to_char(v_vence AT TIME ZONE 'America/Mexico_City', 'DD/MM/YYYY')
    FROM vecino.profiles p WHERE p.id = auth.uid();

  RETURN jsonb_build_object(
    'ok', true, 'token', v_token, 'reactivada', v_reactivada, 'expires_at', v_vence
  );
END $$;

GRANT EXECUTE ON FUNCTION vecino.soporte_reactivar_invitacion(uuid) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 4) Baja de cuenta huérfana — SIN perder historial
--    No borra nada: la cuenta deja de tener acceso (is_active=false,
--    approval_status='rechazado') y suelta su Telegram para que la persona pueda
--    ligar su cuenta buena. Sus pagos, multas, visitas y credenciales siguen
--    exactamente donde estaban, ligados a este perfil.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.soporte_baja_cuenta(p_profile_id uuid, p_motivo text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE
  t        vecino.profiles%ROWTYPE;
  v_casa   text;
  v_house  uuid;
  v_tenia_tg boolean;
BEGIN
  IF NOT vecino.is_admin() THEN
    RAISE EXCEPTION 'Solo el comité puede dar de baja una cuenta.';
  END IF;

  SELECT * INTO t FROM vecino.profiles
   WHERE id = p_profile_id AND colonia_id = vecino.my_colonia_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Esa cuenta no existe en tu colonia.';
  END IF;
  IF t.id = auth.uid() THEN
    RAISE EXCEPTION 'No puedes darte de baja a ti mismo.';
  END IF;
  IF t.role IN ('admin', 'comite') THEN
    RAISE EXCEPTION 'Las cuentas del comité no se dan de baja desde aquí.';
  END IF;
  IF NOT t.is_active THEN
    RAISE EXCEPTION 'Esa cuenta ya está dada de baja.';
  END IF;

  v_tenia_tg := t.telegram_chat_id IS NOT NULL;
  v_house := coalesce(t.house_id,
    (SELECT hm.house_id FROM vecino.house_members hm WHERE hm.profile_id = t.id LIMIT 1));
  SELECT numero INTO v_casa FROM vecino.houses WHERE id = v_house;

  -- Solo se corta el acceso. house_id, house_members y TODO su historial quedan.
  UPDATE vecino.profiles
     SET is_active = false,
         approval_status = 'rechazado',
         telegram_chat_id = NULL
   WHERE id = t.id;

  INSERT INTO vecino.soporte_acceso_log
    (colonia_id, actor_id, actor_nombre, target_profile_id, target_nombre, target_email,
     house_id, casa, accion, detalle)
  SELECT t.colonia_id, auth.uid(), p.nombre, t.id, t.nombre, t.email,
         v_house, v_casa, 'baja_cuenta',
         coalesce(nullif(btrim(coalesce(p_motivo, '')), ''), 'Cuenta duplicada / sin uso')
         || CASE WHEN v_tenia_tg THEN ' · Telegram liberado' ELSE '' END
         || ' · historial conservado'
    FROM vecino.profiles p WHERE p.id = auth.uid();

  RETURN jsonb_build_object('ok', true, 'nombre', t.nombre, 'email', t.email);
END $$;

GRANT EXECUTE ON FUNCTION vecino.soporte_baja_cuenta(uuid, text) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 5) Deshacer la baja (si fue un error)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.soporte_reactivar_cuenta(p_profile_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE t vecino.profiles%ROWTYPE;
BEGIN
  IF NOT vecino.is_admin() THEN
    RAISE EXCEPTION 'Solo el comité puede reactivar una cuenta.';
  END IF;

  SELECT * INTO t FROM vecino.profiles
   WHERE id = p_profile_id AND colonia_id = vecino.my_colonia_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Esa cuenta no existe en tu colonia.';
  END IF;
  IF t.is_active AND t.approval_status = 'aprobado' THEN
    RAISE EXCEPTION 'Esa cuenta ya está activa.';
  END IF;

  UPDATE vecino.profiles
     SET is_active = true, approval_status = 'aprobado'
   WHERE id = t.id;

  INSERT INTO vecino.soporte_acceso_log
    (colonia_id, actor_id, actor_nombre, target_profile_id, target_nombre, target_email,
     house_id, casa, accion, detalle)
  SELECT t.colonia_id, auth.uid(), p.nombre, t.id, t.nombre, t.email,
         t.house_id, (SELECT numero FROM vecino.houses WHERE id = t.house_id),
         'reactivar_cuenta', 'Baja deshecha por el comité'
    FROM vecino.profiles p WHERE p.id = auth.uid();

  RETURN jsonb_build_object('ok', true, 'nombre', t.nombre);
END $$;

GRANT EXECUTE ON FUNCTION vecino.soporte_reactivar_cuenta(uuid) TO authenticated, service_role;

COMMIT;

-- PostgREST no se entera solo de las funciones nuevas.
NOTIFY pgrst, 'reload schema';
