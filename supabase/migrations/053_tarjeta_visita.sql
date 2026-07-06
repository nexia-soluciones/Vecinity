-- 053: Tarjeta de VISITA FRECUENTE (hijos/familiares que visitan seguido,
-- p.ej. de personas mayores). A nombre de la persona, ligada a la casa,
-- SIEMPRE con costo (nunca incluida). QR verificable en caseta: /vf/<request_id>.
-- Nota: el valor 'visita' del enum card_type se agregó en una llamada separada
-- (ALTER TYPE ADD VALUE no puede ir en la misma transacción que su primer uso).

ALTER TABLE vecino.card_requests
  ADD COLUMN IF NOT EXISTS beneficiario_nombre text;

ALTER TABLE vecino.card_requests DROP CONSTRAINT card_req_destino;
ALTER TABLE vecino.card_requests ADD CONSTRAINT card_req_destino CHECK (
  (tipo = 'vehicular' AND vehicle_id IS NOT NULL) OR
  (tipo = 'peatonal'  AND beneficiario_profile_id IS NOT NULL) OR
  (tipo = 'visita'    AND beneficiario_nombre IS NOT NULL)
);

-- Anti-duplicado: una tarjeta viva por casa + nombre de visita
CREATE UNIQUE INDEX card_req_unico_visita
  ON vecino.card_requests (house_id, lower(btrim(beneficiario_nombre)))
  WHERE tipo = 'visita' AND estado NOT IN ('rechazada','cancelada');

-- Firma nueva de solicitar_tarjeta → DROP de la vieja (evita sobrecarga
-- ambigua en PostgREST: gotcha conocido)
DROP FUNCTION vecino.solicitar_tarjeta(vecino.card_type, uuid, uuid, text);

CREATE FUNCTION vecino.solicitar_tarjeta(
  p_tipo vecino.card_type,
  p_vehicle_id uuid DEFAULT NULL,
  p_beneficiario uuid DEFAULT NULL,
  p_nota text DEFAULT NULL,
  p_beneficiario_nombre text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, public AS $$
DECLARE
  v_house   uuid := vecino.my_house_id();
  v_colonia uuid := vecino.my_colonia_id();
  v_benef   uuid := COALESCE(p_beneficiario, auth.uid());
  v_nombre  text := nullif(btrim(p_beneficiario_nombre), '');
  v_cot     jsonb;
  v_req     uuid;
BEGIN
  IF v_house IS NULL THEN RAISE EXCEPTION 'Tu perfil no tiene casa asignada.'; END IF;

  -- Serializa solicitudes de la misma casa (evita carrera por la incluida)
  PERFORM 1 FROM vecino.houses WHERE id = v_house FOR UPDATE;

  IF p_tipo = 'vehicular' THEN
    IF p_vehicle_id IS NULL THEN RAISE EXCEPTION 'Indica el vehículo.'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM vecino.vehicles
       WHERE id = p_vehicle_id AND house_id = v_house AND estado = 'aprobado'
    ) THEN
      RAISE EXCEPTION 'Ese vehículo no está aprobado o no pertenece a tu casa.';
    END IF;
    IF EXISTS (
      SELECT 1 FROM vecino.card_requests
       WHERE vehicle_id = p_vehicle_id AND estado NOT IN ('rechazada','cancelada')
    ) THEN
      RAISE EXCEPTION 'Ese vehículo ya tiene una tarjeta solicitada o emitida.';
    END IF;

  ELSIF p_tipo = 'peatonal' THEN
    IF NOT EXISTS (
      SELECT 1 FROM vecino.profiles
       WHERE id = v_benef AND house_id = v_house
         AND is_active AND approval_status = 'aprobado'
    ) THEN
      RAISE EXCEPTION 'El beneficiario debe ser un miembro aprobado de tu casa.';
    END IF;
    IF EXISTS (
      SELECT 1 FROM vecino.card_requests
       WHERE beneficiario_profile_id = v_benef AND tipo = 'peatonal'
         AND estado NOT IN ('rechazada','cancelada')
    ) THEN
      RAISE EXCEPTION 'Esa persona ya tiene una tarjeta peatonal solicitada o emitida.';
    END IF;

  ELSE -- visita frecuente
    IF v_nombre IS NULL THEN RAISE EXCEPTION 'Escribe el nombre de la visita.'; END IF;
    IF EXISTS (
      SELECT 1 FROM vecino.card_requests
       WHERE house_id = v_house AND tipo = 'visita'
         AND lower(btrim(beneficiario_nombre)) = lower(v_nombre)
         AND estado NOT IN ('rechazada','cancelada')
    ) THEN
      RAISE EXCEPTION 'Esa visita ya tiene una tarjeta solicitada o emitida para tu casa.';
    END IF;
  END IF;

  v_cot := vecino.cotizar_tarjeta(p_tipo);

  INSERT INTO vecino.card_requests
    (colonia_id, house_id, requested_by, tipo, vehicle_id, beneficiario_profile_id,
     beneficiario_nombre, costo_estimado, nota)
  VALUES
    (v_colonia, v_house, auth.uid(), p_tipo, p_vehicle_id,
     CASE WHEN p_tipo = 'peatonal' THEN v_benef END,
     CASE WHEN p_tipo = 'visita' THEN v_nombre END,
     (v_cot->>'costo')::numeric, nullif(btrim(p_nota),''))
  RETURNING id INTO v_req;

  RETURN jsonb_build_object('ok', true, 'id', v_req, 'costo_estimado', v_cot->>'costo');
END $$;

-- Payload: rama de visita frecuente (misma plantilla peatonal del bridge,
-- con rótulo propio y QR /vf/<request_id>)
CREATE OR REPLACE FUNCTION vecino._payload_tarjeta(p_req vecino.card_requests)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, public AS $$
DECLARE
  v jsonb;
BEGIN
  IF p_req.tipo = 'vehicular' THEN
    SELECT jsonb_build_object(
      'placa', ve.placa, 'color', ve.color,
      'marca', vb.nombre, 'modelo', vm.nombre,
      'casa', h.numero, 'propietario', h.propietario
    ) INTO v
    FROM vecino.vehicles ve
    JOIN vecino.houses h ON h.id = ve.house_id
    LEFT JOIN vecino.vehicle_brands vb ON vb.id = ve.brand_id
    LEFT JOIN vecino.vehicle_models vm ON vm.id = ve.model_id
    WHERE ve.id = p_req.vehicle_id;

  ELSIF p_req.tipo = 'peatonal' THEN
    SELECT jsonb_build_object(
      'nombre', p.nombre, 'casa', h.numero, 'calle', h.street,
      'rol', CASE p.role WHEN 'comite' THEN 'Comité' ELSE 'Residente' END,
      'telefono', p.telefono,
      'profileId', p.id,  -- el bridge arma el QR: DEFAULT_QR_URL/r/<profileId>
      'placas', COALESCE((
        SELECT jsonb_agg(ve.placa ORDER BY ve.placa)
        FROM vecino.vehicles ve
        WHERE ve.house_id = p_req.house_id AND ve.estado = 'aprobado' AND ve.placa IS NOT NULL
      ), '[]'::jsonb)
    ) INTO v
    FROM vecino.profiles p
    LEFT JOIN vecino.houses h ON h.id = p_req.house_id
    WHERE p.id = p_req.beneficiario_profile_id;

  ELSE -- visita frecuente
    SELECT jsonb_build_object(
      'nombre', p_req.beneficiario_nombre,
      'casa', h.numero, 'calle', h.street,
      'rol', 'Visita frecuente',
      'rotulo', 'VISITA FRECUENTE',
      'cardId', p_req.id  -- el bridge arma el QR: DEFAULT_QR_URL/vf/<cardId>
    ) INTO v
    FROM vecino.houses h
    WHERE h.id = p_req.house_id;
  END IF;

  IF v IS NULL THEN RAISE EXCEPTION 'No se pudo armar el payload de la tarjeta.'; END IF;
  RETURN v;
END $$;

-- Verificación en caseta del QR de visita frecuente (/vf/<request_id>)
CREATE OR REPLACE FUNCTION vecino.verificar_tarjeta_visita(p_card_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, public AS $$
DECLARE
  v_rol text;
  r vecino.card_requests%ROWTYPE;
  v_casa text;
BEGIN
  SELECT role INTO v_rol FROM vecino.profiles WHERE id = auth.uid();
  IF v_rol IS NULL OR v_rol NOT IN ('guardia','comite','admin') THEN
    RAISE EXCEPTION 'Solo vigilancia o comité pueden verificar credenciales.';
  END IF;

  SELECT * INTO r FROM vecino.card_requests
   WHERE id = p_card_id AND tipo = 'visita' AND colonia_id = vecino.my_colonia_id();
  IF NOT FOUND THEN
    RETURN jsonb_build_object('valida', false, 'motivo', 'El QR no corresponde a ninguna tarjeta de visita de esta colonia.');
  END IF;

  SELECT numero INTO v_casa FROM vecino.houses WHERE id = r.house_id;

  RETURN jsonb_build_object(
    'valida', r.estado IN ('impresa','entregada'),
    'motivo', CASE WHEN r.estado IN ('impresa','entregada') THEN NULL
                   ELSE 'La tarjeta no está vigente (estado: ' || r.estado || ').' END,
    'nombre', r.beneficiario_nombre,
    'casa', v_casa,
    'rol', 'Visita frecuente'
  );
END $$;

GRANT EXECUTE ON FUNCTION vecino.solicitar_tarjeta(vecino.card_type,uuid,uuid,text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.verificar_tarjeta_visita(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION vecino._payload_tarjeta(vecino.card_requests) FROM PUBLIC, authenticated, anon;
