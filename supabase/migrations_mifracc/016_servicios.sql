-- ============================================================
-- VECINITY · 016 — Servicios (generales de villa + recurrentes domésticos)
-- schema: mifracc · Supabase self-hosted Nexia
--
-- (A) Servicios generales de la villa (alberca, limpieza, basura, jardinería):
--     el guardia marca entrada/salida. Tabla general_services.
-- (B) Mejora: proveedores recurrentes (señora de la limpieza, etc.) — se
--     registran UNA vez con foto y luego el ingreso diario es un tap, con
--     foto del día opcional. Tabla service_providers + external_services.
-- ============================================================

-- ============================================================
-- (A) SERVICIOS GENERALES DE LA VILLA
-- ============================================================
CREATE OR REPLACE FUNCTION mifracc.iniciar_servicio_general(p_tipo text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
DECLARE v_id uuid; v_col uuid := mifracc.my_colonia_id();
BEGIN
  IF NOT mifracc.is_guard() THEN RAISE EXCEPTION 'Solo el personal de vigilancia.'; END IF;
  IF coalesce(btrim(p_tipo),'') = '' THEN RAISE EXCEPTION 'Indica el tipo de servicio.'; END IF;
  -- idempotente: si ya hay uno abierto de ese tipo, devuélvelo
  SELECT id INTO v_id FROM mifracc.general_services
    WHERE colonia_id = v_col AND tipo = p_tipo AND salida IS NULL
    ORDER BY entrada DESC LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'id', v_id, 'ya_abierto', true);
  END IF;
  INSERT INTO mifracc.general_services (colonia_id, tipo, registrado_por, entrada)
    VALUES (v_col, p_tipo, auth.uid(), now()) RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

CREATE OR REPLACE FUNCTION mifracc.cerrar_servicio_general(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
BEGIN
  IF NOT mifracc.is_guard() THEN RAISE EXCEPTION 'Solo el personal de vigilancia.'; END IF;
  UPDATE mifracc.general_services SET salida = now()
    WHERE id = p_id AND colonia_id = mifracc.my_colonia_id() AND salida IS NULL;
  RETURN jsonb_build_object('ok', true);
END $$;

-- ============================================================
-- (B) PROVEEDORES RECURRENTES (domésticos) + bitácora diaria
-- ============================================================
CREATE TABLE IF NOT EXISTS mifracc.service_providers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id  uuid NOT NULL REFERENCES mifracc.colonias(id) ON DELETE CASCADE,
  house_id    uuid NOT NULL REFERENCES mifracc.houses(id) ON DELETE CASCADE,
  nombre      text NOT NULL,
  tipo        text NOT NULL DEFAULT 'limpieza',   -- limpieza, jardinería, niñera, etc.
  foto_url    text,
  activo      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE mifracc.external_services
  ADD COLUMN IF NOT EXISTS provider_id uuid REFERENCES mifracc.service_providers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS foto_url    text;

ALTER TABLE mifracc.service_providers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_providers_read  ON mifracc.service_providers;
DROP POLICY IF EXISTS service_providers_admin ON mifracc.service_providers;
CREATE POLICY service_providers_read ON mifracc.service_providers FOR SELECT
  USING (colonia_id = mifracc.my_colonia_id());
CREATE POLICY service_providers_admin ON mifracc.service_providers FOR ALL
  USING (colonia_id = mifracc.my_colonia_id() AND mifracc.is_admin())
  WITH CHECK (colonia_id = mifracc.my_colonia_id() AND mifracc.is_admin());

CREATE INDEX IF NOT EXISTS idx_providers_colonia ON mifracc.service_providers(colonia_id, activo);
CREATE INDEX IF NOT EXISTS idx_extsvc_open ON mifracc.external_services(colonia_id, fecha_salida);

-- registrar un proveedor recurrente (guardia, o el residente para su casa)
CREATE OR REPLACE FUNCTION mifracc.crear_proveedor(
  p_nombre text, p_tipo text, p_house_id uuid, p_foto_url text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
DECLARE v_col uuid := mifracc.my_colonia_id(); v_id uuid;
BEGIN
  IF coalesce(btrim(p_nombre),'') = '' THEN RAISE EXCEPTION 'Escribe el nombre del proveedor.'; END IF;
  IF p_house_id IS NULL THEN RAISE EXCEPTION 'Indica la casa.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM mifracc.houses WHERE id = p_house_id AND colonia_id = v_col) THEN
    RAISE EXCEPTION 'La casa no pertenece a tu colonia.';
  END IF;
  -- guardia puede para cualquier casa; un residente solo para la suya
  IF NOT mifracc.is_guard() AND p_house_id <> mifracc.my_house_id() THEN
    RAISE EXCEPTION 'Solo puedes registrar proveedores de tu casa.';
  END IF;
  INSERT INTO mifracc.service_providers (colonia_id, house_id, nombre, tipo, foto_url)
    VALUES (v_col, p_house_id, btrim(p_nombre), coalesce(nullif(btrim(p_tipo),''),'limpieza'), p_foto_url)
    RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

-- ingreso del proveedor (guardia) → abre bitácora diaria, foto del día opcional
CREATE OR REPLACE FUNCTION mifracc.ingresar_proveedor(p_provider_id uuid, p_foto_url text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
DECLARE sp mifracc.service_providers%ROWTYPE; v_id uuid;
BEGIN
  IF NOT mifracc.is_guard() THEN RAISE EXCEPTION 'Solo el personal de vigilancia.'; END IF;
  SELECT * INTO sp FROM mifracc.service_providers WHERE id = p_provider_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'El proveedor no existe.'; END IF;
  IF sp.colonia_id <> mifracc.my_colonia_id() THEN RAISE EXCEPTION 'El proveedor no es de tu colonia.'; END IF;
  -- evita doble ingreso si ya está adentro
  IF EXISTS (SELECT 1 FROM mifracc.external_services
             WHERE provider_id = p_provider_id AND fecha_salida IS NULL) THEN
    RAISE EXCEPTION 'Ese proveedor ya está adentro.';
  END IF;
  INSERT INTO mifracc.external_services
    (colonia_id, house_id, tipo_servicio, fecha_entrada, guardia_id, provider_id, foto_url)
  VALUES
    (sp.colonia_id, sp.house_id, sp.tipo, now(), auth.uid(), p_provider_id, p_foto_url)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

-- salida de un servicio externo (guardia)
CREATE OR REPLACE FUNCTION mifracc.salir_proveedor(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
BEGIN
  IF NOT mifracc.is_guard() THEN RAISE EXCEPTION 'Solo el personal de vigilancia.'; END IF;
  UPDATE mifracc.external_services SET fecha_salida = now()
    WHERE id = p_id AND colonia_id = mifracc.my_colonia_id() AND fecha_salida IS NULL;
  RETURN jsonb_build_object('ok', true);
END $$;

GRANT ALL ON mifracc.service_providers TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION mifracc.iniciar_servicio_general(text)        TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION mifracc.cerrar_servicio_general(uuid)         TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION mifracc.crear_proveedor(text,text,uuid,text)  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION mifracc.ingresar_proveedor(uuid,text)         TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION mifracc.salir_proveedor(uuid)                 TO authenticated, service_role;
