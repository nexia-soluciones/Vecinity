-- ============================================================
-- VECINITY · 021 — Caseta: registro manual de visita + fotos INE/placas
-- schema: vecino · Supabase self-hosted Nexia
--
-- Cierra la paridad con el Django viejo en la operación de caseta:
--   1) El guardia registra una visita que llega SIN pase (walk-in).
--   2) Captura foto de INE y/o placas (a Storage), tanto en walk-in
--      como al marcar la entrada de un pase QR.
-- El historial del día es solo lectura (el guardia ya tiene _read en
-- visitors por colonia) → no requiere RPC.
--
-- Patrón idéntico a 013: RPCs SECURITY DEFINER gateadas por is_guard().
-- Nota: origen_registro tiene CHECK IN ('vecino','vigilante') → se usa
-- 'vigilante' para los registros hechos en caseta.
-- ============================================================

-- ------------------------------------------------------------
-- Registro manual (walk-in): visita que llega sin pase previo.
-- Entra directo como 'adentro' (el guardia la deja pasar al registrarla).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.registrar_visita_manual(
  p_nombre         text,
  p_house_id       uuid,
  p_placa          text DEFAULT NULL,
  p_foto_ine_url   text DEFAULT NULL,
  p_foto_placa_url text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE v_col uuid := vecino.my_colonia_id(); v_id uuid;
BEGIN
  IF NOT vecino.is_guard() THEN RAISE EXCEPTION 'Solo el personal de vigilancia.'; END IF;
  IF coalesce(btrim(p_nombre),'') = '' THEN RAISE EXCEPTION 'Escribe el nombre del visitante.'; END IF;
  IF p_house_id IS NULL THEN RAISE EXCEPTION 'Selecciona la casa destino.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vecino.houses WHERE id = p_house_id AND colonia_id = v_col) THEN
    RAISE EXCEPTION 'La casa no pertenece a tu colonia.';
  END IF;

  INSERT INTO vecino.visitors
    (colonia_id, house_id, nombre, estado, origen_registro,
     plate_detected, foto_identificacion_url, foto_placas_url,
     guardia_entrada_id, fecha_hora_entrada)
  VALUES
    (v_col, p_house_id, btrim(p_nombre), 'adentro', 'vigilante',
     nullif(upper(btrim(p_placa)),''), p_foto_ine_url, p_foto_placa_url,
     auth.uid(), now())
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

-- ------------------------------------------------------------
-- Adjuntar fotos (INE / placas) a una visita existente.
-- Úsalo al marcar la entrada de un pase QR (no pisa fotos previas).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.adjuntar_fotos_visita(
  p_id             uuid,
  p_foto_ine_url   text DEFAULT NULL,
  p_foto_placa_url text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE v vecino.visitors%ROWTYPE;
BEGIN
  IF NOT vecino.is_guard() THEN RAISE EXCEPTION 'Solo el personal de vigilancia.'; END IF;
  SELECT * INTO v FROM vecino.visitors WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'La visita no existe.'; END IF;
  IF v.colonia_id <> vecino.my_colonia_id() THEN RAISE EXCEPTION 'La visita no es de tu colonia.'; END IF;

  UPDATE vecino.visitors
     SET foto_identificacion_url = coalesce(p_foto_ine_url, foto_identificacion_url),
         foto_placas_url         = coalesce(p_foto_placa_url, foto_placas_url)
   WHERE id = p_id;

  RETURN jsonb_build_object('ok', true);
END $$;

GRANT EXECUTE ON FUNCTION vecino.registrar_visita_manual(text,uuid,text,text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.adjuntar_fotos_visita(uuid,text,text)             TO authenticated, service_role;
