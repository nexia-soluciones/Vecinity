-- ============================================================
-- VECINITY · 009 — Umbral de adeudo para reservar (configurable por villa)
-- El comité define cuánta tolerancia de saldo permite antes de bloquear
-- la reserva de áreas comunes. Default 0 = debe estar al corriente.
-- ============================================================

ALTER TABLE mifracc.colonias
  ADD COLUMN IF NOT EXISTS umbral_reserva numeric(10,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN mifracc.colonias.umbral_reserva IS
  'Tolerancia de saldo para reservar áreas comunes. saldo > umbral_reserva → bloqueado. 0 = al corriente estricto.';

-- ------------------------------------------------------------
-- crear_reserva: gate al-corriente usando el umbral de la villa
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mifracc.crear_reserva(
  p_area_id  uuid,
  p_inicio   timestamptz,
  p_fin      timestamptz,
  p_personas int DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
DECLARE
  v_house_id   uuid := mifracc.my_house_id();
  v_colonia_id uuid := mifracc.my_colonia_id();
  a            mifracc.common_areas%ROWTYPE;
  v_saldo      numeric;
  v_umbral     numeric;
  v_dur_horas  numeric;
  v_ini_local  time;
  v_fin_local  time;
  v_ini_dia    date;
  v_solapadas  int;
  v_estado     text;
BEGIN
  IF v_house_id IS NULL THEN
    RAISE EXCEPTION 'Tu perfil no está ligado a una casa todavía.';
  END IF;

  SELECT * INTO a FROM mifracc.common_areas WHERE id = p_area_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El área seleccionada no existe.';
  END IF;
  IF a.colonia_id <> v_colonia_id THEN
    RAISE EXCEPTION 'El área no pertenece a tu colonia.';
  END IF;
  IF NOT a.activa OR NOT a.reservable THEN
    RAISE EXCEPTION 'El área "%" no está disponible para reservar.', a.nombre;
  END IF;

  -- Gate AL CORRIENTE con tolerancia configurable por villa (Art. 67 + 97 quater)
  SELECT saldo INTO v_saldo FROM mifracc.houses WHERE id = v_house_id;
  SELECT COALESCE(umbral_reserva, 0) INTO v_umbral FROM mifracc.colonias WHERE id = v_colonia_id;
  IF v_saldo > v_umbral THEN
    RAISE EXCEPTION 'Tu casa tiene un adeudo de $%. Debes estar al corriente para reservar.',
      to_char(v_saldo,'FM999G999D00');
  END IF;

  -- Rango válido
  IF p_fin <= p_inicio THEN
    RAISE EXCEPTION 'La hora de fin debe ser posterior a la de inicio.';
  END IF;
  IF p_inicio < now() THEN
    RAISE EXCEPTION 'No puedes reservar en una fecha/hora pasada.';
  END IF;

  -- Horario del área (en hora local MX)
  v_ini_local := (p_inicio AT TIME ZONE 'America/Mexico_City')::time;
  v_fin_local := (p_fin    AT TIME ZONE 'America/Mexico_City')::time;
  v_ini_dia   := (p_inicio AT TIME ZONE 'America/Mexico_City')::date;
  IF v_ini_local < a.hora_apertura OR v_fin_local > a.hora_cierre THEN
    RAISE EXCEPTION 'El horario de "%" es de % a %.', a.nombre,
      to_char(a.hora_apertura,'HH24:MI'), to_char(a.hora_cierre,'HH24:MI');
  END IF;
  IF (p_fin AT TIME ZONE 'America/Mexico_City')::date <> v_ini_dia THEN
    RAISE EXCEPTION 'La reserva debe iniciar y terminar el mismo día.';
  END IF;

  -- Duración
  v_dur_horas := EXTRACT(EPOCH FROM (p_fin - p_inicio)) / 3600.0;
  IF v_dur_horas < a.duracion_min_horas THEN
    RAISE EXCEPTION 'La duración mínima en "%" es de % h.', a.nombre, a.duracion_min_horas;
  END IF;
  IF v_dur_horas > a.duracion_max_horas THEN
    RAISE EXCEPTION 'La duración máxima en "%" es de % h.', a.nombre, a.duracion_max_horas;
  END IF;

  -- Aforo
  IF a.requiere_aforo THEN
    IF p_personas IS NULL OR p_personas < 1 THEN
      RAISE EXCEPTION 'Indica cuántas personas asistirán.';
    END IF;
    IF a.max_personas_casa IS NOT NULL AND p_personas > a.max_personas_casa THEN
      RAISE EXCEPTION 'Máximo % personas por casa en "%".', a.max_personas_casa, a.nombre;
    END IF;
    IF p_personas > a.capacidad_personas THEN
      RAISE EXCEPTION 'El aforo de "%" es de % personas.', a.nombre, a.capacidad_personas;
    END IF;
  END IF;

  -- Choque de franja: solo áreas EXCLUSIVAS
  IF a.exclusiva THEN
    SELECT count(*) INTO v_solapadas
    FROM mifracc.reservations r
    WHERE r.area_id = p_area_id
      AND r.estado IN ('pendiente','aprobada','en_uso')
      AND r.fecha_hora_inicio < p_fin
      AND r.fecha_hora_fin    > p_inicio;
    IF v_solapadas >= a.cantidad_espacios THEN
      RAISE EXCEPTION 'Esa franja en "%" ya está ocupada. Elige otro horario.', a.nombre;
    END IF;
  END IF;

  v_estado := CASE WHEN a.aprobacion_automatica THEN 'aprobada' ELSE 'pendiente' END;

  INSERT INTO mifracc.reservations
    (colonia_id, area_id, house_id, fecha_hora_inicio, fecha_hora_fin, estado, cantidad_personas)
  VALUES
    (v_colonia_id, p_area_id, v_house_id, p_inicio, p_fin, v_estado, p_personas)
  RETURNING id INTO p_area_id;

  RETURN jsonb_build_object('ok', true, 'reservation_id', p_area_id, 'estado', v_estado);
END $$;

GRANT EXECUTE ON FUNCTION mifracc.crear_reserva(uuid,timestamptz,timestamptz,int) TO authenticated, service_role;
