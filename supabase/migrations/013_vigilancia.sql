-- ============================================================
-- VECINITY · 013 — Vista vigilante (operación del guardia)
-- schema: vecino · Supabase self-hosted Nexia
--
-- El rol 'guardia' solo tiene _read en las tablas de operación; toda
-- escritura pasa por RPCs SECURITY DEFINER gateadas por is_guard().
-- Conecta visitas (entrada/salida, también por token QR), el ciclo de
-- llave de reservas (entrega/devolución) y paquetes.
-- ============================================================

-- ------------------------------------------------------------
-- Helper: ¿el usuario es vigilancia? (guardia, admin o comité)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.is_guard()
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = vecino, auth AS $$
  SELECT EXISTS (SELECT 1 FROM vecino.profiles
                 WHERE id = auth.uid() AND role IN ('guardia','admin','comite'))
$$;

-- ============================================================
-- TURNO
-- ============================================================
CREATE OR REPLACE FUNCTION vecino.iniciar_turno()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE v_id uuid; v_col uuid := vecino.my_colonia_id();
BEGIN
  IF NOT vecino.is_guard() THEN RAISE EXCEPTION 'Solo el personal de vigilancia.'; END IF;
  SELECT id INTO v_id FROM vecino.guard_shifts
    WHERE guardia_id = auth.uid() AND salida IS NULL ORDER BY entrada DESC LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'id', v_id, 'ya_abierto', true);
  END IF;
  INSERT INTO vecino.guard_shifts (colonia_id, guardia_id)
    VALUES (v_col, auth.uid()) RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

CREATE OR REPLACE FUNCTION vecino.cerrar_turno()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
BEGIN
  IF NOT vecino.is_guard() THEN RAISE EXCEPTION 'Solo el personal de vigilancia.'; END IF;
  UPDATE vecino.guard_shifts SET salida = now()
    WHERE guardia_id = auth.uid() AND salida IS NULL;
  RETURN jsonb_build_object('ok', true);
END $$;

-- ============================================================
-- VISITAS — entrada / salida (por id o por token QR)
-- ============================================================
CREATE OR REPLACE FUNCTION vecino.marcar_entrada_visita(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE v vecino.visitors%ROWTYPE;
BEGIN
  IF NOT vecino.is_guard() THEN RAISE EXCEPTION 'Solo el personal de vigilancia.'; END IF;
  SELECT * INTO v FROM vecino.visitors WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'La visita no existe.'; END IF;
  IF v.colonia_id <> vecino.my_colonia_id() THEN RAISE EXCEPTION 'La visita no es de tu colonia.'; END IF;
  IF v.estado <> 'esperando' THEN RAISE EXCEPTION 'La visita no está en espera.'; END IF;
  UPDATE vecino.visitors
     SET estado = 'adentro', guardia_entrada_id = auth.uid(), fecha_hora_entrada = now()
   WHERE id = p_id;
  RETURN jsonb_build_object('ok', true, 'estado', 'adentro');
END $$;

CREATE OR REPLACE FUNCTION vecino.marcar_salida_visita(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE v vecino.visitors%ROWTYPE;
BEGIN
  IF NOT vecino.is_guard() THEN RAISE EXCEPTION 'Solo el personal de vigilancia.'; END IF;
  SELECT * INTO v FROM vecino.visitors WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'La visita no existe.'; END IF;
  IF v.colonia_id <> vecino.my_colonia_id() THEN RAISE EXCEPTION 'La visita no es de tu colonia.'; END IF;
  IF v.estado <> 'adentro' THEN RAISE EXCEPTION 'La visita no está adentro.'; END IF;
  UPDATE vecino.visitors
     SET estado = 'completada', guardia_salida_id = auth.uid(), fecha_hora_salida = now()
   WHERE id = p_id;
  RETURN jsonb_build_object('ok', true, 'estado', 'completada');
END $$;

-- Acción por token (el guardia abre el pase QR y marca entrada/salida)
CREATE OR REPLACE FUNCTION vecino.marcar_visita_por_token(p_token text, p_accion text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE v vecino.visitors%ROWTYPE;
BEGIN
  IF NOT vecino.is_guard() THEN RAISE EXCEPTION 'Solo el personal de vigilancia.'; END IF;
  SELECT * INTO v FROM vecino.visitors WHERE token_acceso = p_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pase no válido.'; END IF;
  IF v.colonia_id <> vecino.my_colonia_id() THEN RAISE EXCEPTION 'La visita no es de tu colonia.'; END IF;
  IF p_accion = 'entrada' THEN
    RETURN vecino.marcar_entrada_visita(v.id);
  ELSIF p_accion = 'salida' THEN
    RETURN vecino.marcar_salida_visita(v.id);
  ELSE
    RAISE EXCEPTION 'Acción no válida.';
  END IF;
END $$;

-- ============================================================
-- RESERVAS — ciclo de llave (entrega / devolución)
-- ============================================================
CREATE OR REPLACE FUNCTION vecino.entregar_area(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE r vecino.reservations%ROWTYPE;
BEGIN
  IF NOT vecino.is_guard() THEN RAISE EXCEPTION 'Solo el personal de vigilancia.'; END IF;
  SELECT * INTO r FROM vecino.reservations WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'La reserva no existe.'; END IF;
  IF r.colonia_id <> vecino.my_colonia_id() THEN RAISE EXCEPTION 'La reserva no es de tu colonia.'; END IF;
  IF r.estado <> 'aprobada' THEN RAISE EXCEPTION 'La reserva no está aprobada / lista para entregar.'; END IF;
  UPDATE vecino.reservations
     SET estado = 'en_uso', guardia_entrega_id = auth.uid(), fecha_hora_entrega = now()
   WHERE id = p_id;
  RETURN jsonb_build_object('ok', true, 'estado', 'en_uso');
END $$;

CREATE OR REPLACE FUNCTION vecino.devolver_area(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE r vecino.reservations%ROWTYPE;
BEGIN
  IF NOT vecino.is_guard() THEN RAISE EXCEPTION 'Solo el personal de vigilancia.'; END IF;
  SELECT * INTO r FROM vecino.reservations WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'La reserva no existe.'; END IF;
  IF r.colonia_id <> vecino.my_colonia_id() THEN RAISE EXCEPTION 'La reserva no es de tu colonia.'; END IF;
  IF r.estado <> 'en_uso' THEN RAISE EXCEPTION 'La reserva no está en uso.'; END IF;
  UPDATE vecino.reservations
     SET estado = 'completada', guardia_devolucion_id = auth.uid(), fecha_hora_devolucion = now()
   WHERE id = p_id;
  RETURN jsonb_build_object('ok', true, 'estado', 'completada');
END $$;

-- ============================================================
-- PAQUETES — registrar llegada / entregar
-- ============================================================
CREATE OR REPLACE FUNCTION vecino.registrar_paquete(
  p_house_id    uuid,
  p_remitente   text,
  p_numero_guia text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE v_col uuid := vecino.my_colonia_id(); v_id uuid;
BEGIN
  IF NOT vecino.is_guard() THEN RAISE EXCEPTION 'Solo el personal de vigilancia.'; END IF;
  IF p_house_id IS NULL THEN RAISE EXCEPTION 'Selecciona la casa destino.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vecino.houses WHERE id = p_house_id AND colonia_id = v_col) THEN
    RAISE EXCEPTION 'La casa no pertenece a tu colonia.';
  END IF;
  INSERT INTO vecino.packages (colonia_id, house_id, remitente, numero_guia, estado, registrado_por, fecha_llegada)
  VALUES (v_col, p_house_id, coalesce(nullif(btrim(p_remitente),''),'Paquete'), nullif(btrim(p_numero_guia),''),
          'en_vigilancia', auth.uid(), now())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

CREATE OR REPLACE FUNCTION vecino.entregar_paquete(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE p vecino.packages%ROWTYPE;
BEGIN
  IF NOT vecino.is_guard() THEN RAISE EXCEPTION 'Solo el personal de vigilancia.'; END IF;
  SELECT * INTO p FROM vecino.packages WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'El paquete no existe.'; END IF;
  IF p.colonia_id <> vecino.my_colonia_id() THEN RAISE EXCEPTION 'El paquete no es de tu colonia.'; END IF;
  IF p.estado = 'entregado' THEN RAISE EXCEPTION 'El paquete ya fue entregado.'; END IF;
  UPDATE vecino.packages
     SET estado = 'entregado', entregado_por = auth.uid(), fecha_entrega = now()
   WHERE id = p_id;
  RETURN jsonb_build_object('ok', true);
END $$;

GRANT EXECUTE ON FUNCTION vecino.is_guard()                             TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.iniciar_turno()                        TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.cerrar_turno()                         TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.marcar_entrada_visita(uuid)            TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.marcar_salida_visita(uuid)             TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.marcar_visita_por_token(text,text)     TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.entregar_area(uuid)                    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.devolver_area(uuid)                    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.registrar_paquete(uuid,text,text)      TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.entregar_paquete(uuid)                 TO authenticated, service_role;
