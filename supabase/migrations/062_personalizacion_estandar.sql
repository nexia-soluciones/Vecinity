-- 062: Personalización estándar (decisión del comité 2026-07-13)
-- Toda tarjeta VEHICULAR sale personalizada (diseño de la villa + datos del
-- carro al reverso — seguridad). El precio de la adicional sube a $150 con la
-- personalización INCLUIDA; la tarjeta incluida de cada casa sigue siendo $0
-- (también personalizada). Ya no hay cargo extra por personalizar.

-- 1. Personalización incluida en el precio (el checkbox de la UI se retira)
UPDATE vecino.colonias SET precio_personalizacion = 0;

-- 2. solicitar_tarjeta: personalizada deja de ser opcional — se fuerza en
--    vehiculares (p_personalizada se conserva en la firma por compatibilidad
--    pero se ignora). Misma firma → CREATE OR REPLACE sin DROP.
CREATE OR REPLACE FUNCTION vecino.solicitar_tarjeta(
  p_tipo vecino.card_type, p_vehicle_id uuid, p_beneficiario uuid,
  p_nota text, p_beneficiario_nombre text, p_personalizada boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE
  v_house   uuid := vecino.my_house_id();
  v_colonia uuid := vecino.my_colonia_id();
  v_benef   uuid := COALESCE(p_beneficiario, auth.uid());
  v_nombre  text := nullif(btrim(p_beneficiario_nombre), '');
  v_cot     jsonb;
  v_costo   numeric;
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

  v_cot := vecino.cotizar_tarjeta(p_tipo, false);
  v_costo := (v_cot->>'costo')::numeric;

  INSERT INTO vecino.card_requests
    (colonia_id, house_id, requested_by, tipo, vehicle_id, beneficiario_profile_id,
     beneficiario_nombre, es_incluida, personalizada, costo_estimado, pago_estado, nota)
  VALUES
    (v_colonia, v_house, auth.uid(), p_tipo, p_vehicle_id,
     CASE WHEN p_tipo = 'peatonal' THEN v_benef END,
     CASE WHEN p_tipo = 'visita' THEN v_nombre END,
     p_tipo = 'vehicular' AND (v_cot->>'incluida_disponible')::boolean,
     p_tipo = 'vehicular',  -- estándar: toda vehicular sale personalizada
     v_costo,
     CASE WHEN v_costo > 0 THEN 'pendiente' ELSE 'no_requerido' END,
     nullif(btrim(p_nota),''))
  RETURNING id INTO v_req;

  RETURN jsonb_build_object('ok', true, 'id', v_req, 'costo_estimado', v_costo,
                            'requiere_pago', v_costo > 0);
END $$;

-- 3. Solicitudes vivas de la campaña: nuevas condiciones
--    (0 comprobantes en revisión al momento de esta migración — verificado)
UPDATE vecino.card_requests
   SET personalizada = (tipo = 'vehicular')
 WHERE estado = 'solicitada';

UPDATE vecino.card_requests
   SET costo_estimado = 150
 WHERE estado = 'solicitada' AND NOT es_incluida
   AND costo_estimado = 100
   AND pago_estado IN ('pendiente','rechazado');
