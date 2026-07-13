-- 061: Cobro real de tarjetas de acceso
-- (1) Fix: la tarjeta incluida se reclama AL SOLICITAR (antes es_incluida nunca
--     se marcaba en el INSERT → toda tarjeta cotizaba $0 y nadie veía el aviso).
-- (2) Personalizada: impresión a color con datos del carro al reverso (+$50).
-- (3) Pago por transferencia con comprobante propio en card_requests —
--     SEPARADO del saldo de mantenimiento (se elimina el cargo a transactions).
--     Sin opción de efectivo (decisión del Director 2026-07-13).

-- 1. Config de la colonia -----------------------------------------------------
ALTER TABLE vecino.colonias
  ADD COLUMN IF NOT EXISTS precio_personalizacion numeric NOT NULL DEFAULT 50;

-- 2. card_requests: personalización + estado de pago propio -------------------
ALTER TABLE vecino.card_requests
  ADD COLUMN IF NOT EXISTS personalizada boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS comprobante_url text,
  ADD COLUMN IF NOT EXISTS pago_estado text NOT NULL DEFAULT 'no_requerido'
    CHECK (pago_estado IN ('no_requerido','pendiente','en_revision','aprobado','rechazado')),
  ADD COLUMN IF NOT EXISTS pago_validado_by uuid,
  ADD COLUMN IF NOT EXISTS pago_validado_at timestamptz,
  ADD COLUMN IF NOT EXISTS pago_motivo_rechazo text;

-- 3. cotizar_tarjeta v2 (con personalización) ---------------------------------
--    DROP: cambia la firma → la vieja quedaría como sobrecarga ambigua en PostgREST.
DROP FUNCTION IF EXISTS vecino.cotizar_tarjeta(vecino.card_type);
CREATE OR REPLACE FUNCTION vecino.cotizar_tarjeta(
  p_tipo vecino.card_type, p_personalizada boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE
  v_house  uuid := vecino.my_house_id();
  v_precio numeric;
  v_pers   numeric;
  v_incluida_libre boolean;
  v_base   numeric;
  v_extra  numeric;
BEGIN
  IF v_house IS NULL THEN RAISE EXCEPTION 'Tu perfil no tiene casa asignada.'; END IF;
  SELECT precio_tarjeta_adicional, precio_personalizacion INTO v_precio, v_pers
    FROM vecino.colonias WHERE id = vecino.my_colonia_id();
  -- ¿La casa aún tiene libre su tarjeta vehicular incluida?
  SELECT NOT EXISTS (
    SELECT 1 FROM vecino.card_requests
     WHERE house_id = v_house AND es_incluida
       AND estado IN ('solicitada','en_cola','impresa','entregada')
  ) INTO v_incluida_libre;
  v_base  := CASE WHEN p_tipo = 'vehicular' AND v_incluida_libre THEN 0 ELSE v_precio END;
  v_extra := CASE WHEN p_personalizada AND p_tipo = 'vehicular' THEN v_pers ELSE 0 END;
  RETURN jsonb_build_object(
    'precio_adicional', v_precio,
    'precio_personalizacion', v_pers,
    'incluida_disponible', v_incluida_libre,
    'base', v_base,
    'personalizacion', v_extra,
    'costo', v_base + v_extra
  );
END $$;

-- 4. solicitar_tarjeta v2 ------------------------------------------------------
--    Reclama la incluida AL INSERTAR (es_incluida) y deja el pago pendiente si
--    hay costo. DROP por cambio de firma.
DROP FUNCTION IF EXISTS vecino.solicitar_tarjeta(vecino.card_type, uuid, uuid, text, text);
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
  IF p_personalizada AND p_tipo <> 'vehicular' THEN
    RAISE EXCEPTION 'La personalización solo aplica a tarjetas vehiculares.';
  END IF;

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

  v_cot := vecino.cotizar_tarjeta(p_tipo, p_personalizada);
  v_costo := (v_cot->>'costo')::numeric;

  INSERT INTO vecino.card_requests
    (colonia_id, house_id, requested_by, tipo, vehicle_id, beneficiario_profile_id,
     beneficiario_nombre, es_incluida, personalizada, costo_estimado, pago_estado, nota)
  VALUES
    (v_colonia, v_house, auth.uid(), p_tipo, p_vehicle_id,
     CASE WHEN p_tipo = 'peatonal' THEN v_benef END,
     CASE WHEN p_tipo = 'visita' THEN v_nombre END,
     p_tipo = 'vehicular' AND (v_cot->>'incluida_disponible')::boolean,
     p_personalizada,
     v_costo,
     CASE WHEN v_costo > 0 THEN 'pendiente' ELSE 'no_requerido' END,
     nullif(btrim(p_nota),''))
  RETURNING id INTO v_req;

  RETURN jsonb_build_object('ok', true, 'id', v_req, 'costo_estimado', v_costo,
                            'requiere_pago', v_costo > 0);
END $$;

-- 5. Subir comprobante de pago (vecino de la casa) -----------------------------
CREATE OR REPLACE FUNCTION vecino.subir_comprobante_tarjeta(p_id uuid, p_url text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE v_n int;
BEGIN
  IF COALESCE(btrim(p_url), '') = '' THEN
    RAISE EXCEPTION 'Falta el comprobante.';
  END IF;
  UPDATE vecino.card_requests
     SET comprobante_url = p_url, pago_estado = 'en_revision',
         pago_motivo_rechazo = NULL
   WHERE id = p_id AND house_id = vecino.my_house_id()
     AND estado = 'solicitada'
     AND pago_estado IN ('pendiente','rechazado');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'La solicitud no admite comprobante (no es de tu casa, ya fue procesada o no requiere pago).';
  END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- 6. Validar pago (comité) — SOLO transferencia, sin opción de efectivo --------
CREATE OR REPLACE FUNCTION vecino.validar_pago_tarjeta(
  p_id uuid, p_aprobar boolean, p_nota text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE r vecino.card_requests%ROWTYPE;
BEGIN
  IF NOT vecino.is_admin() THEN
    RAISE EXCEPTION 'Solo el comité puede validar pagos.';
  END IF;
  SELECT * INTO r FROM vecino.card_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR r.colonia_id <> vecino.my_colonia_id() THEN
    RAISE EXCEPTION 'La solicitud no existe o no es de tu colonia.';
  END IF;
  IF r.pago_estado <> 'en_revision' THEN
    RAISE EXCEPTION 'Esta solicitud no tiene un comprobante por revisar.';
  END IF;
  IF NOT p_aprobar AND COALESCE(btrim(p_nota), '') = '' THEN
    RAISE EXCEPTION 'Indica el motivo del rechazo del pago.';
  END IF;
  UPDATE vecino.card_requests
     SET pago_estado = CASE WHEN p_aprobar THEN 'aprobado' ELSE 'rechazado' END,
         pago_validado_by = auth.uid(), pago_validado_at = now(),
         pago_motivo_rechazo = CASE WHEN p_aprobar THEN NULL ELSE btrim(p_nota) END
   WHERE id = p_id;
  RETURN jsonb_build_object('ok', true,
                            'pago_estado', CASE WHEN p_aprobar THEN 'aprobado' ELSE 'rechazado' END);
END $$;

-- 7. resolver_solicitud_tarjeta v2 ---------------------------------------------
--    SIN cargo al saldo de mantenimiento (el pago ya viene validado por
--    comprobante) + guard: no aprobar sin pago validado.
CREATE OR REPLACE FUNCTION vecino.resolver_solicitud_tarjeta(
  p_id uuid, p_accion text, p_nota text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE
  r        vecino.card_requests%ROWTYPE;
  v_job    uuid;
  v_stock  integer;
  v_pend   integer;
BEGIN
  IF NOT vecino.is_admin() THEN
    RAISE EXCEPTION 'Solo el comité puede resolver solicitudes.';
  END IF;

  SELECT * INTO r FROM vecino.card_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'La solicitud no existe.'; END IF;
  IF r.colonia_id <> vecino.my_colonia_id() THEN
    RAISE EXCEPTION 'La solicitud no es de tu colonia.';
  END IF;
  IF r.estado <> 'solicitada' THEN
    RAISE EXCEPTION 'Esa solicitud ya fue procesada.';
  END IF;

  IF p_accion = 'rechazar' THEN
    UPDATE vecino.card_requests
       SET estado = 'rechazada', motivo_rechazo = nullif(btrim(p_nota),''),
           resolved_by = auth.uid(), resolved_at = now()
     WHERE id = p_id;
    RETURN jsonb_build_object('ok', true, 'estado', 'rechazada');
  END IF;

  IF p_accion <> 'aprobar' THEN RAISE EXCEPTION 'Acción no válida.'; END IF;

  -- Sin pago validado no se imprime (transferencia con comprobante, sin efectivo)
  IF r.pago_estado NOT IN ('no_requerido','aprobado') THEN
    RAISE EXCEPTION 'El pago de esta tarjeta (%) aún no está validado. Revisa el comprobante primero.',
      to_char(COALESCE(r.costo_estimado, 0), 'FM$999,990');
  END IF;

  -- Inventario: no aprobar más de las tarjetas físicas disponibles
  SELECT stock_tarjetas INTO v_stock
    FROM vecino.colonias WHERE id = r.colonia_id FOR UPDATE;
  SELECT count(*) INTO v_pend FROM vecino.print_jobs
   WHERE colonia_id = r.colonia_id AND estado IN ('pendiente','imprimiendo');
  IF v_stock - v_pend < 1 THEN
    RAISE EXCEPTION 'Sin tarjetas físicas disponibles (stock % · % en cola). Registra más stock.', v_stock, v_pend;
  END IF;

  -- A la cola de impresión (el costo quedó fijado al solicitar/pagar)
  INSERT INTO vecino.print_jobs (colonia_id, card_request_id, tipo, payload, requested_by)
  VALUES (r.colonia_id, r.id, r.tipo, vecino._payload_tarjeta(r), auth.uid())
  RETURNING id INTO v_job;

  UPDATE vecino.card_requests
     SET estado = 'en_cola', costo = COALESCE(costo_estimado, 0),
         print_job_id = v_job,
         resolved_by = auth.uid(), resolved_at = now()
   WHERE id = p_id;

  RETURN jsonb_build_object('ok', true, 'estado', 'en_cola',
                            'costo', COALESCE(r.costo_estimado, 0),
                            'incluida', r.es_incluida, 'job', v_job);
END $$;

-- 8. Payload de impresión: incluir bandera de personalización -------------------
--    (el bridge decide el diseño: personalizada = plantilla a color con datos
--    del carro al reverso; normal = tarjeta blanca)
CREATE OR REPLACE FUNCTION vecino._payload_tarjeta(p_req vecino.card_requests)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = vecino, public AS $$
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
  RETURN v || jsonb_build_object('personalizada', p_req.personalizada);
END $$;

-- 9. Retro-fix de las solicitudes ya capturadas en campaña ----------------------
--    La vehicular más antigua de cada casa = su incluida ($0); el resto queda
--    como adicional al precio de su colonia con pago pendiente.
WITH primera AS (
  SELECT DISTINCT ON (house_id) id
  FROM vecino.card_requests
  WHERE estado = 'solicitada' AND tipo = 'vehicular'
  ORDER BY house_id, created_at
)
UPDATE vecino.card_requests
   SET es_incluida = true, costo_estimado = 0, pago_estado = 'no_requerido'
 WHERE id IN (SELECT id FROM primera);

UPDATE vecino.card_requests cr
   SET costo_estimado = c.precio_tarjeta_adicional,
       pago_estado = CASE WHEN c.precio_tarjeta_adicional > 0 THEN 'pendiente' ELSE 'no_requerido' END
  FROM vecino.colonias c
 WHERE c.id = cr.colonia_id
   AND cr.estado = 'solicitada'
   AND NOT cr.es_incluida;
