-- ============================================================
-- VECINITY · 010 — Visitas (registro residente + pase público QR/token)
-- schema: mifracc · Supabase self-hosted Nexia
--
-- Paridad del flujo de visitas del Django viejo (3957 visitantes reales).
-- Esta fase: el residente registra una visita y obtiene un pase con
-- token/QR compartible. La captura de fotos (INE/placas) y el marcado
-- de entrada/salida por el guardia van en la fase "vista vigilante".
-- ============================================================

-- token único (cuando exista)
CREATE UNIQUE INDEX IF NOT EXISTS idx_visitors_token
  ON mifracc.visitors(token_acceso) WHERE token_acceso IS NOT NULL;

-- ------------------------------------------------------------
-- RPC: registrar una visita (residente). Genera token de acceso.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mifracc.registrar_visita(
  p_nombre           text,
  p_fecha_programada timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
DECLARE
  v_house_id   uuid := mifracc.my_house_id();
  v_colonia_id uuid := mifracc.my_colonia_id();
  v_token      text;
  v_id         uuid;
BEGIN
  IF v_house_id IS NULL THEN
    RAISE EXCEPTION 'Tu perfil no está ligado a una casa todavía.';
  END IF;
  IF coalesce(btrim(p_nombre),'') = '' THEN
    RAISE EXCEPTION 'Indica el nombre del visitante.';
  END IF;

  -- token de 32 hex (sin extensión): dos uuids sin guiones
  v_token := replace(gen_random_uuid()::text,'-','') ||
             substr(replace(gen_random_uuid()::text,'-',''),1,8);

  INSERT INTO mifracc.visitors
    (colonia_id, house_id, nombre, token_acceso, fecha_programada, estado, origen_registro)
  VALUES
    (v_colonia_id, v_house_id, btrim(p_nombre), v_token, p_fecha_programada, 'esperando', 'vecino')
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id, 'token', v_token);
END $$;

-- ------------------------------------------------------------
-- RPC: cancelar una visita propia (aún esperando)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mifracc.cancelar_visita(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
DECLARE r mifracc.visitors%ROWTYPE;
BEGIN
  SELECT * INTO r FROM mifracc.visitors WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'La visita no existe.'; END IF;
  IF r.house_id <> mifracc.my_house_id() THEN
    RAISE EXCEPTION 'Solo puedes cancelar visitas de tu casa.';
  END IF;
  IF r.estado <> 'esperando' THEN
    RAISE EXCEPTION 'No puedes cancelar una visita que ya ingresó.';
  END IF;
  DELETE FROM mifracc.visitors WHERE id = p_id;
  RETURN jsonb_build_object('ok', true);
END $$;

-- ------------------------------------------------------------
-- RPC pública: datos del pase por token (SIN login, granted a anon)
-- Devuelve solo campos seguros para mostrar el pase.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mifracc.get_visita_publica(p_token text)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = mifracc, auth AS $$
  SELECT jsonb_build_object(
    'nombre',           v.nombre,
    'estado',           v.estado,
    'fecha_programada', v.fecha_programada,
    'casa',             h.numero,
    'colonia',          c.nombre,
    'logo_url',         c.logo_url
  )
  FROM mifracc.visitors v
  JOIN mifracc.houses   h ON h.id = v.house_id
  JOIN mifracc.colonias c ON c.id = v.colonia_id
  WHERE v.token_acceso = p_token
$$;

GRANT EXECUTE ON FUNCTION mifracc.registrar_visita(text,timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION mifracc.cancelar_visita(uuid)              TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION mifracc.get_visita_publica(text)           TO anon, authenticated, service_role;
