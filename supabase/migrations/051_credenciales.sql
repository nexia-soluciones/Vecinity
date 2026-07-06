-- 051: Módulo Credenciales — solicitud → cobro → cola de impresión → entrega
-- Modelo: cada casa tiene 1 tarjeta VEHICULAR incluida (un carro); todo lo
-- adicional (2º carro, peatonales) se cobra al saldo de la casa.
-- La cola print_jobs la consume nexia-print-bridge (Mac con la Zebra ZC300).

-- ══ Config por colonia ══════════════════════════════════════════════════
ALTER TABLE vecino.colonias
  ADD COLUMN IF NOT EXISTS precio_tarjeta_adicional numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stock_tarjetas integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tarjeta_frente_url text;

-- Inventario físico inicial de Villa Catania (100 tarjetas PVC compradas)
UPDATE vecino.colonias SET stock_tarjetas = 100
 WHERE id = 'ce43b59c-529b-4960-8dd7-d975e43ac2fb' AND stock_tarjetas = 0;

-- ══ Tipos ═══════════════════════════════════════════════════════════════
CREATE TYPE vecino.card_type AS ENUM ('vehicular','peatonal');
CREATE TYPE vecino.card_request_status AS ENUM
  ('solicitada','rechazada','cancelada','en_cola','impresa','entregada');
CREATE TYPE vecino.print_job_status AS ENUM
  ('pendiente','imprimiendo','impresa','error','cancelado');

-- ══ Solicitudes de tarjeta ══════════════════════════════════════════════
CREATE TABLE vecino.card_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id    uuid NOT NULL REFERENCES vecino.colonias(id),
  house_id      uuid NOT NULL REFERENCES vecino.houses(id),
  requested_by  uuid NOT NULL REFERENCES vecino.profiles(id),
  tipo          vecino.card_type NOT NULL,
  -- vehicular: qué vehículo; peatonal: para qué miembro de la casa
  vehicle_id    uuid REFERENCES vecino.vehicles(id),
  beneficiario_profile_id uuid REFERENCES vecino.profiles(id),
  es_incluida   boolean NOT NULL DEFAULT false,  -- 1ª vehicular de la casa = sin costo
  costo_estimado numeric(10,2) NOT NULL DEFAULT 0, -- lo que vio el vecino al solicitar
  costo         numeric(10,2),                     -- definitivo, fijado al aprobar
  estado        vecino.card_request_status NOT NULL DEFAULT 'solicitada',
  transaction_id uuid REFERENCES vecino.transactions(id),
  print_job_id  uuid,
  nota          text,
  motivo_rechazo text,
  resolved_by   uuid REFERENCES vecino.profiles(id),
  resolved_at   timestamptz,
  delivered_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT card_req_destino CHECK (
    (tipo = 'vehicular' AND vehicle_id IS NOT NULL) OR
    (tipo = 'peatonal'  AND beneficiario_profile_id IS NOT NULL)
  )
);

-- Anti-duplicado: una solicitud VIVA por vehículo / por beneficiario
CREATE UNIQUE INDEX card_req_unico_vehiculo ON vecino.card_requests (vehicle_id)
  WHERE tipo = 'vehicular' AND estado NOT IN ('rechazada','cancelada');
CREATE UNIQUE INDEX card_req_unico_beneficiario ON vecino.card_requests (beneficiario_profile_id)
  WHERE tipo = 'peatonal' AND estado NOT IN ('rechazada','cancelada');
CREATE INDEX card_req_por_casa ON vecino.card_requests (house_id, estado);
CREATE INDEX card_req_pendientes ON vecino.card_requests (colonia_id) WHERE estado = 'solicitada';

ALTER TABLE vecino.card_requests ENABLE ROW LEVEL SECURITY;

-- Lectura: mi casa (o donde soy propietario) y el comité. Escritura: SOLO vía RPC.
CREATE POLICY card_req_select ON vecino.card_requests FOR SELECT
  USING (house_id IN (SELECT vecino.my_finance_house_ids()) OR vecino.is_admin());

-- ══ Cola de impresión (la consume el bridge con service_role) ═══════════
CREATE TABLE vecino.print_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id    uuid NOT NULL REFERENCES vecino.colonias(id),
  card_request_id uuid REFERENCES vecino.card_requests(id),
  tipo          vecino.card_type NOT NULL,
  payload       jsonb NOT NULL,      -- datos aplanados para la plantilla del bridge
  estado        vecino.print_job_status NOT NULL DEFAULT 'pendiente',
  attempts      integer NOT NULL DEFAULT 0,
  error         text,
  requested_by  uuid REFERENCES vecino.profiles(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  taken_at      timestamptz,
  printed_at    timestamptz
);
CREATE INDEX print_jobs_cola ON vecino.print_jobs (created_at) WHERE estado = 'pendiente';

ALTER TABLE vecino.print_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY print_jobs_select ON vecino.print_jobs FOR SELECT
  USING (vecino.is_admin());

-- ══ Cotizar (el vecino ve el costo ANTES de confirmar) ══════════════════
CREATE OR REPLACE FUNCTION vecino.cotizar_tarjeta(p_tipo vecino.card_type)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, public AS $$
DECLARE
  v_house  uuid := vecino.my_house_id();
  v_precio numeric;
  v_incluida_libre boolean;
BEGIN
  IF v_house IS NULL THEN RAISE EXCEPTION 'Tu perfil no tiene casa asignada.'; END IF;
  SELECT precio_tarjeta_adicional INTO v_precio
    FROM vecino.colonias WHERE id = vecino.my_colonia_id();
  -- ¿La casa aún tiene libre su tarjeta vehicular incluida?
  SELECT NOT EXISTS (
    SELECT 1 FROM vecino.card_requests
     WHERE house_id = v_house AND es_incluida
       AND estado IN ('solicitada','en_cola','impresa','entregada')
  ) INTO v_incluida_libre;
  RETURN jsonb_build_object(
    'precio_adicional', v_precio,
    'incluida_disponible', v_incluida_libre,
    'costo', CASE WHEN p_tipo = 'vehicular' AND v_incluida_libre THEN 0 ELSE v_precio END
  );
END $$;

-- ══ Solicitar tarjeta (vecino) ══════════════════════════════════════════
CREATE OR REPLACE FUNCTION vecino.solicitar_tarjeta(
  p_tipo vecino.card_type,
  p_vehicle_id uuid DEFAULT NULL,
  p_beneficiario uuid DEFAULT NULL,
  p_nota text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, public AS $$
DECLARE
  v_house   uuid := vecino.my_house_id();
  v_colonia uuid := vecino.my_colonia_id();
  v_benef   uuid := COALESCE(p_beneficiario, auth.uid());
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
  ELSE
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
  END IF;

  v_cot := vecino.cotizar_tarjeta(p_tipo);

  INSERT INTO vecino.card_requests
    (colonia_id, house_id, requested_by, tipo, vehicle_id, beneficiario_profile_id,
     costo_estimado, nota)
  VALUES
    (v_colonia, v_house, auth.uid(), p_tipo, p_vehicle_id,
     CASE WHEN p_tipo = 'peatonal' THEN v_benef END,
     (v_cot->>'costo')::numeric, nullif(btrim(p_nota),''))
  RETURNING id INTO v_req;

  RETURN jsonb_build_object('ok', true, 'id', v_req, 'costo_estimado', v_cot->>'costo');
END $$;

-- ══ Cancelar (vecino, solo si sigue en 'solicitada') ════════════════════
CREATE OR REPLACE FUNCTION vecino.cancelar_solicitud_tarjeta(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, public AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE vecino.card_requests
     SET estado = 'cancelada', resolved_at = now()
   WHERE id = p_id AND estado = 'solicitada'
     AND house_id = vecino.my_house_id();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RAISE EXCEPTION 'La solicitud no existe, no es de tu casa o ya fue procesada.'; END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- ══ Payload para la plantilla del bridge ════════════════════════════════
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
  ELSE
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
  END IF;
  IF v IS NULL THEN RAISE EXCEPTION 'No se pudo armar el payload de la tarjeta.'; END IF;
  RETURN v;
END $$;

-- ══ Aprobar / rechazar (comité) ═════════════════════════════════════════
-- Idempotente: FOR UPDATE + check de estado — doble clic no cobra dos veces.
CREATE OR REPLACE FUNCTION vecino.resolver_solicitud_tarjeta(
  p_id uuid,
  p_accion text,           -- 'aprobar' | 'rechazar'
  p_nota text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, public AS $$
DECLARE
  r        vecino.card_requests%ROWTYPE;
  v_precio numeric;
  v_incluida boolean := false;
  v_costo  numeric;
  v_tx     uuid;
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

  -- Inventario: no aprobar más de las tarjetas físicas disponibles
  SELECT stock_tarjetas, precio_tarjeta_adicional INTO v_stock, v_precio
    FROM vecino.colonias WHERE id = r.colonia_id FOR UPDATE;
  SELECT count(*) INTO v_pend FROM vecino.print_jobs
   WHERE colonia_id = r.colonia_id AND estado IN ('pendiente','imprimiendo');
  IF v_stock - v_pend < 1 THEN
    RAISE EXCEPTION 'Sin tarjetas físicas disponibles (stock % · % en cola). Registra más stock.', v_stock, v_pend;
  END IF;

  -- Regla de cupo: 1ª vehicular de la casa = incluida, sin costo
  PERFORM 1 FROM vecino.houses WHERE id = r.house_id FOR UPDATE;
  IF r.tipo = 'vehicular' THEN
    SELECT NOT EXISTS (
      SELECT 1 FROM vecino.card_requests
       WHERE house_id = r.house_id AND es_incluida
         AND estado IN ('en_cola','impresa','entregada')
    ) INTO v_incluida;
  END IF;
  v_costo := CASE WHEN v_incluida THEN 0 ELSE v_precio END;

  -- Cargo al saldo (patrón multa) — solo si hay costo
  IF v_costo > 0 THEN
    INSERT INTO vecino.transactions (colonia_id, house_id, tipo, monto, concepto, estado)
    VALUES (r.colonia_id, r.house_id, 'cargo', v_costo,
            'Tarjeta de acceso adicional (' || r.tipo || ')', 'aprobado')
    RETURNING id INTO v_tx;
    UPDATE vecino.houses SET saldo = saldo + v_costo WHERE id = r.house_id;
    UPDATE vecino.houses
       SET estatus = CASE
         WHEN estatus = 'en_convenio' THEN 'en_convenio'::vecino.estatus_casa
         WHEN saldo > 0 THEN 'con_adeudo'::vecino.estatus_casa
         ELSE 'al_corriente'::vecino.estatus_casa END
     WHERE id = r.house_id;
  END IF;

  -- A la cola de impresión
  INSERT INTO vecino.print_jobs (colonia_id, card_request_id, tipo, payload, requested_by)
  VALUES (r.colonia_id, r.id, r.tipo, vecino._payload_tarjeta(r), auth.uid())
  RETURNING id INTO v_job;

  UPDATE vecino.card_requests
     SET estado = 'en_cola', es_incluida = v_incluida, costo = v_costo,
         transaction_id = v_tx, print_job_id = v_job,
         resolved_by = auth.uid(), resolved_at = now()
   WHERE id = p_id;

  RETURN jsonb_build_object('ok', true, 'estado', 'en_cola',
                            'costo', v_costo, 'incluida', v_incluida, 'job', v_job);
END $$;

-- ══ Entregar (comité: la tarjeta impresa llegó a manos del vecino) ══════
CREATE OR REPLACE FUNCTION vecino.entregar_tarjeta(p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, public AS $$
DECLARE
  v_n integer;
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité puede entregar.'; END IF;
  UPDATE vecino.card_requests
     SET estado = 'entregada', delivered_at = now()
   WHERE id = p_request_id AND estado = 'impresa'
     AND colonia_id = vecino.my_colonia_id();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RAISE EXCEPTION 'La solicitud no está en estado impresa.'; END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- ══ RPCs del bridge (SOLO service_role: el bridge, nunca el navegador) ══
CREATE OR REPLACE FUNCTION vecino.print_take_jobs(p_limit integer DEFAULT 3)
RETURNS SETOF vecino.print_jobs LANGUAGE sql SECURITY DEFINER
SET search_path = vecino, public AS $$
  UPDATE vecino.print_jobs
     SET estado = 'imprimiendo', attempts = attempts + 1, taken_at = now()
   WHERE id IN (
     SELECT id FROM vecino.print_jobs
      WHERE estado = 'pendiente'
      ORDER BY created_at
      LIMIT greatest(1, least(p_limit, 10))
      FOR UPDATE SKIP LOCKED
   )
  RETURNING *;
$$;

CREATE OR REPLACE FUNCTION vecino.print_mark_job(p_id uuid, p_ok boolean, p_error text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, public AS $$
DECLARE
  j vecino.print_jobs%ROWTYPE;
BEGIN
  SELECT * INTO j FROM vecino.print_jobs WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job inexistente.'; END IF;
  IF j.estado <> 'imprimiendo' THEN RAISE EXCEPTION 'El job no está en impresión.'; END IF;

  IF p_ok THEN
    UPDATE vecino.print_jobs SET estado = 'impresa', printed_at = now(), error = NULL
     WHERE id = p_id;
    UPDATE vecino.colonias SET stock_tarjetas = greatest(0, stock_tarjetas - 1)
     WHERE id = j.colonia_id;
    IF j.card_request_id IS NOT NULL THEN
      UPDATE vecino.card_requests SET estado = 'impresa'
       WHERE id = j.card_request_id AND estado = 'en_cola';
    END IF;
  ELSE
    UPDATE vecino.print_jobs SET estado = 'error', error = left(coalesce(p_error,'error'), 500)
     WHERE id = p_id;
  END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- Reintentar un job en error (comité)
CREATE OR REPLACE FUNCTION vecino.print_retry_job(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, public AS $$
DECLARE
  v_n integer;
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité puede reintentar.'; END IF;
  UPDATE vecino.print_jobs SET estado = 'pendiente', error = NULL
   WHERE id = p_id AND estado = 'error' AND colonia_id = vecino.my_colonia_id();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RAISE EXCEPTION 'El job no está en error.'; END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- ══ Permisos ════════════════════════════════════════════════════════════
GRANT SELECT ON vecino.card_requests TO authenticated, service_role;
GRANT SELECT ON vecino.print_jobs TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.cotizar_tarjeta(vecino.card_type) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.solicitar_tarjeta(vecino.card_type,uuid,uuid,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.cancelar_solicitud_tarjeta(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.resolver_solicitud_tarjeta(uuid,text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.entregar_tarjeta(uuid) TO authenticated, service_role;
-- Los del bridge: SOLO service_role
REVOKE EXECUTE ON FUNCTION vecino.print_take_jobs(integer) FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION vecino.print_mark_job(uuid,boolean,text) FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION vecino._payload_tarjeta(vecino.card_requests) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION vecino.print_take_jobs(integer) TO service_role;
GRANT EXECUTE ON FUNCTION vecino.print_mark_job(uuid,boolean,text) TO service_role;
-- print_retry_job sí lo llama el comité
GRANT EXECUTE ON FUNCTION vecino.print_retry_job(uuid) TO authenticated, service_role;
