-- =============================================================================
-- VECINITY · 044 — Dueños que no habitan su casa (casas rentadas)
-- schema: vecino · Supabase self-hosted Nexia
--
-- ~30% de las casas están rentadas: el inquilino vive ahí (usó el código CAT),
-- pero el MANTENIMIENTO lo paga el dueño, que hoy no existe en el sistema.
--
-- Diseño: profiles.house_id sigue siendo "la casa donde VIVO" (NULL para el
-- dueño externo). El vínculo dueño↔casa vive en vecino.house_members. El
-- alcance del dueño se limita a FINANZAS en la BD: solo las policies/RPCs
-- financieras usan my_finance_house_ids(); visitas, reservas, vehículos,
-- incidencias y SOS siguen con my_house_id() → el dueño no tiene casa ahí.
-- =============================================================================

-- ------------------------------------------------------------
-- 1) Vínculo persona↔casa por relación (hoy solo 'propietario';
--    extensible a 'administrador', 'familiar', etc. sin tocar el modelo)
-- ------------------------------------------------------------
CREATE TYPE vecino.house_relacion AS ENUM ('propietario');

CREATE TABLE vecino.house_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id  uuid NOT NULL REFERENCES vecino.colonias(id) ON DELETE CASCADE,
  house_id    uuid NOT NULL REFERENCES vecino.houses(id)   ON DELETE CASCADE,
  profile_id  uuid NOT NULL REFERENCES vecino.profiles(id) ON DELETE CASCADE,
  relacion    vecino.house_relacion NOT NULL DEFAULT 'propietario',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (house_id, profile_id, relacion)
);

CREATE INDEX idx_house_members_profile ON vecino.house_members(profile_id);
CREATE INDEX idx_house_members_house   ON vecino.house_members(house_id);

ALTER TABLE vecino.house_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY house_members_self_read ON vecino.house_members FOR SELECT
  USING (profile_id = auth.uid());
CREATE POLICY house_members_admin ON vecino.house_members FOR ALL
  USING (colonia_id = vecino.my_colonia_id() AND vecino.is_admin())
  WITH CHECK (colonia_id = vecino.my_colonia_id() AND vecino.is_admin());

GRANT ALL ON vecino.house_members TO anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 2) Helper: casas cuyas FINANZAS puedo ver/operar
--    (donde vivo ∪ donde soy propietario). SOLO para superficies financieras.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.my_finance_house_ids()
RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = vecino, auth AS $$
  SELECT house_id FROM vecino.profiles
   WHERE id = auth.uid() AND house_id IS NOT NULL
  UNION
  SELECT house_id FROM vecino.house_members
   WHERE profile_id = auth.uid()
$$;

GRANT EXECUTE ON FUNCTION vecino.my_finance_house_ids() TO anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 3) Invitación con relación: PROP-<casa> reutiliza vecino.invitations
--    (relacion NULL = invitación de residente normal, como hasta hoy)
-- ------------------------------------------------------------
ALTER TABLE vecino.invitations
  ADD COLUMN IF NOT EXISTS relacion vecino.house_relacion;

-- RPC del comité: genera (o recupera, idempotente) el código PROP de una casa.
CREATE OR REPLACE FUNCTION vecino.crear_invitacion_propietario(p_house_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE
  h       vecino.houses%ROWTYPE;
  v_token text;
  v_base  text;
  v_k     int := 1;
BEGIN
  IF NOT vecino.is_admin() THEN
    RAISE EXCEPTION 'Solo el comité puede generar códigos de propietario.';
  END IF;
  SELECT * INTO h FROM vecino.houses
   WHERE id = p_house_id AND colonia_id = vecino.my_colonia_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Esa casa no existe en tu colonia.';
  END IF;

  -- Si ya hay una invitación de propietario vigente y sin usar → reutilizarla
  SELECT token INTO v_token FROM vecino.invitations
   WHERE house_id = p_house_id AND relacion = 'propietario'
     AND accepted_at IS NULL AND (expires_at IS NULL OR expires_at > now())
   ORDER BY created_at DESC LIMIT 1;
  IF v_token IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'token', v_token, 'nueva', false);
  END IF;

  v_base  := 'PROP-' || regexp_replace(h.numero, '[^0-9A-Za-z]', '', 'g');
  v_token := v_base;
  WHILE EXISTS (SELECT 1 FROM vecino.invitations WHERE token = v_token) LOOP
    v_k := v_k + 1;
    v_token := v_base || '-' || v_k;
  END LOOP;

  INSERT INTO vecino.invitations (colonia_id, house_id, role, relacion, token, invited_by, expires_at)
  VALUES (h.colonia_id, h.id, 'residente', 'propietario', v_token, auth.uid(), now() + interval '60 days');

  RETURN jsonb_build_object('ok', true, 'token', v_token, 'nueva', true);
END $$;

GRANT EXECUTE ON FUNCTION vecino.crear_invitacion_propietario(uuid) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 4) Lectura de movimientos: residente de la casa ∪ propietario ∪ comité
--    (reemplaza transactions_read de 027)
-- ------------------------------------------------------------
DROP POLICY IF EXISTS transactions_read ON vecino.transactions;
CREATE POLICY transactions_read ON vecino.transactions
  FOR SELECT USING (
    house_id IN (SELECT vecino.my_finance_house_ids()) OR vecino.is_admin()
  );

-- ------------------------------------------------------------
-- 5) registrar_abono ahora acepta la casa destino (dueño con 2+ casas).
--    Sin p_house_id se comporta idéntico a antes (casa donde vivo).
--    DROP obligatorio: agregar un parámetro con default crearía una
--    sobrecarga ambigua para PostgREST.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS vecino.registrar_abono(numeric, text, text, text);

CREATE OR REPLACE FUNCTION vecino.registrar_abono(
  p_monto            numeric,
  p_comprobante_url  text DEFAULT NULL,
  p_concepto         text DEFAULT 'Abono',
  p_comprobante_hash text DEFAULT NULL,
  p_house_id         uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE
  v_house uuid := coalesce(p_house_id, vecino.my_house_id());
  v_col   uuid;
  v_id    uuid;
BEGIN
  IF v_house IS NULL THEN
    RAISE EXCEPTION 'Tu perfil no está ligado a una casa todavía.';
  END IF;
  -- La casa debe ser mía: donde vivo o donde soy propietario
  IF v_house NOT IN (SELECT vecino.my_finance_house_ids()) THEN
    RAISE EXCEPTION 'No puedes registrar pagos de esa casa.';
  END IF;
  IF p_monto IS NULL OR p_monto <= 0 THEN
    RAISE EXCEPTION 'El monto debe ser mayor a cero.';
  END IF;

  -- Colonia de la CASA (no del perfil: el dueño externo podría no coincidir)
  SELECT colonia_id INTO v_col FROM vecino.houses WHERE id = v_house;

  -- anti-duplicado 1: mismo monto en los últimos 10 minutos
  IF EXISTS (
    SELECT 1 FROM vecino.transactions
    WHERE house_id = v_house AND tipo = 'abono' AND monto = p_monto
      AND created_at > now() - interval '10 minutes'
  ) THEN
    RAISE EXCEPTION 'Ya registraste un abono por ese monto hace unos minutos.';
  END IF;

  -- anti-duplicado 2: mismo COMPROBANTE (imagen) ya usado en la colonia
  IF p_comprobante_hash IS NOT NULL AND EXISTS (
    SELECT 1 FROM vecino.transactions
    WHERE colonia_id = v_col AND comprobante_hash = p_comprobante_hash
      AND estado <> 'rechazado'
  ) THEN
    RAISE EXCEPTION 'Ese comprobante ya fue registrado antes.';
  END IF;

  INSERT INTO vecino.transactions
    (colonia_id, house_id, tipo, monto, concepto, comprobante_url, comprobante_hash, estado)
  VALUES
    (v_col, v_house, 'abono', p_monto,
     coalesce(nullif(btrim(p_concepto),''),'Abono'), p_comprobante_url, p_comprobante_hash, 'pendiente')
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

GRANT EXECUTE ON FUNCTION vecino.registrar_abono(numeric,text,text,text,uuid) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 6) set_abono_ocr: el abono puede ser de cualquiera de mis casas financieras
--    (misma firma → CREATE OR REPLACE directo; lógica de dedup intacta)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.set_abono_ocr(p_id uuid, p_ocr jsonb, p_ref text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'vecino', 'auth'
AS $$
DECLARE
  v_ref   text := nullif(vecino._norm_ref(p_ref), '');
  v_col   uuid;
  v_rows  int;
BEGIN
  -- El abono debe ser de una de MIS casas (residente o propietario) y seguir pendiente.
  SELECT colonia_id INTO v_col
    FROM vecino.transactions
   WHERE id = p_id AND tipo = 'abono' AND estado = 'pendiente'
     AND house_id IN (SELECT vecino.my_finance_house_ids());
  IF v_col IS NULL THEN
    RETURN jsonb_build_object('ok', false);
  END IF;

  -- Dedup por clave de rastreo (única por transferencia). Aunque re-fotografíe
  -- el recibo, la clave es la misma → esa transferencia ya se registró.
  IF v_ref IS NOT NULL AND length(v_ref) >= 6 AND EXISTS (
       SELECT 1 FROM vecino.transactions
        WHERE colonia_id = v_col AND ref_rastreo = v_ref
          AND estado <> 'rechazado' AND id <> p_id
     ) THEN
    UPDATE vecino.transactions
       SET estado = 'rechazado',
           comprobante_ocr = p_ocr,
           ref_rastreo = v_ref,
           concepto = concepto || ' · rechazado: transferencia ya registrada'
     WHERE id = p_id;
    RETURN jsonb_build_object('ok', false, 'duplicado', true);
  END IF;

  UPDATE vecino.transactions
     SET comprobante_ocr = p_ocr, ref_rastreo = v_ref
   WHERE id = p_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('ok', v_rows > 0, 'duplicado', false);
END $$;

-- ------------------------------------------------------------
-- 7) Nag de saldo: avisa a TODOS los ligados a la casa con Telegram
--    (residentes que viven ahí + dueños externos — el dueño es quien paga)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.notify_saldo()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE v_umbral numeric; v_msg text; r record; v_sent boolean := false;
BEGIN
  SELECT umbral_saldo_alerta INTO v_umbral FROM vecino.colonias WHERE id = NEW.colonia_id;
  IF NEW.saldo > COALESCE(v_umbral, 0) AND NEW.saldo > COALESCE(OLD.saldo, 0) THEN
    v_msg := '💸 *Aviso de saldo*' || E'\n' ||
             'Tu casa ' || NEW.numero || ' tiene un saldo pendiente de $' ||
             to_char(NEW.saldo, 'FM999,999.00') ||
             '. Te recomendamos revisar tus pagos para evitar recargos.';
    FOR r IN
      SELECT DISTINCT p.telegram_chat_id
        FROM vecino.profiles p
       WHERE p.telegram_chat_id IS NOT NULL
         AND (p.house_id = NEW.id
              OR p.id IN (SELECT hm.profile_id FROM vecino.house_members hm
                           WHERE hm.house_id = NEW.id))
    LOOP
      PERFORM vecino.tg_send(r.telegram_chat_id, v_msg);
      v_sent := true;
    END LOOP;
    IF v_sent THEN
      INSERT INTO vecino.notifications(colonia_id, house_id, tipo, mensaje, canal, estado_envio, ref_tabla, ref_id, enviado_at)
      VALUES (NEW.colonia_id, NEW.id, 'saldo_alto', v_msg, 'telegram', 'enviado', 'houses', NEW.id, now());
    END IF;
  END IF;
  RETURN NEW;
END $fn$;

NOTIFY pgrst, 'reload schema';
