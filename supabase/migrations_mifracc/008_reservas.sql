-- ============================================================
-- VECINITY · 008 — Reservas de áreas comunes (paridad + mejora)
-- schema: mifracc · Supabase self-hosted Nexia
--
-- Rescata el flujo del Django viejo (calendario + ciclo con guardia)
-- y lo mejora: config de áreas gobernada por el comité, disponibilidad
-- real por franja, gate al-corriente y aprobación automática si está
-- dentro de rango. Escritura vía RPC SECURITY DEFINER (RLS-safe).
-- ============================================================

-- ------------------------------------------------------------
-- 1) Helper: house_id del usuario actual (SECURITY DEFINER, sin recursión)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mifracc.my_house_id()
RETURNS uuid LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = mifracc, auth AS $$
  SELECT house_id FROM mifracc.profiles WHERE id = auth.uid()
$$;

-- ------------------------------------------------------------
-- 2) Config de áreas comunes (gobernada por el comité)
-- ------------------------------------------------------------
ALTER TABLE mifracc.common_areas
  ADD COLUMN IF NOT EXISTS activa               boolean      NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS reservable           boolean      NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS exclusiva            boolean      NOT NULL DEFAULT true,  -- true = la reserva toma toda el área
  ADD COLUMN IF NOT EXISTS requiere_aforo       boolean      NOT NULL DEFAULT false, -- pedir cantidad_personas
  ADD COLUMN IF NOT EXISTS hora_apertura        time         NOT NULL DEFAULT '08:00',
  ADD COLUMN IF NOT EXISTS hora_cierre          time         NOT NULL DEFAULT '20:00',
  ADD COLUMN IF NOT EXISTS duracion_min_horas   int          NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS duracion_max_horas   int          NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS max_personas_casa    int,                                 -- aforo por casa (alberca = 5)
  ADD COLUMN IF NOT EXISTS costo                numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deposito             numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS aprobacion_automatica boolean     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS reglas               text,
  ADD COLUMN IF NOT EXISTS color                text         NOT NULL DEFAULT '#3b82f6',
  ADD COLUMN IF NOT EXISTS icono                text,
  ADD COLUMN IF NOT EXISTS orden                int          NOT NULL DEFAULT 0;

-- residentes pueden LEER el catálogo de áreas (ya hay _read por colonia en 004);
-- la escritura del catálogo queda en manos del comité/admin (_admin de 004).

-- ------------------------------------------------------------
-- 3) Índice para choques de franja
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_resv_area_rango
  ON mifracc.reservations(area_id, fecha_hora_inicio, fecha_hora_fin);

-- ------------------------------------------------------------
-- 4) RPC: disponibilidad de un área en una fecha
--    Devuelve las reservas activas de ese día (para pintar franjas ocupadas).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mifracc.disponibilidad_area(p_area_id uuid, p_fecha date)
RETURNS TABLE (
  id uuid,
  fecha_hora_inicio timestamptz,
  fecha_hora_fin    timestamptz,
  estado            text,
  cantidad_personas int
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = mifracc, auth AS $$
  SELECT r.id, r.fecha_hora_inicio, r.fecha_hora_fin, r.estado, r.cantidad_personas
  FROM mifracc.reservations r
  JOIN mifracc.common_areas a ON a.id = r.area_id
  WHERE r.area_id = p_area_id
    -- aislamiento por colonia del usuario
    AND a.colonia_id = mifracc.my_colonia_id()
    AND r.estado IN ('pendiente','aprobada','en_uso')
    AND (r.fecha_hora_inicio AT TIME ZONE 'America/Mexico_City')::date = p_fecha
  ORDER BY r.fecha_hora_inicio
$$;

-- ------------------------------------------------------------
-- 5) RPC: crear reserva (gate + validaciones + auto-aprobación)
--    Devuelve jsonb { ok, reservation_id, estado } o lanza EXCEPTION.
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

  -- Gate AL CORRIENTE (Art. 67 + 97 quater): saldo > 0 = con adeudo → bloqueado
  SELECT saldo INTO v_saldo FROM mifracc.houses WHERE id = v_house_id;
  IF v_saldo > 0 THEN
    RAISE EXCEPTION 'Tu casa tiene un adeudo de $%. Debes estar al corriente para reservar.', to_char(v_saldo,'FM999G999D00');
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
  -- Misma fecha (evita reservas que cruzan medianoche; el reglamento limita por día)
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

  -- Choque de franja: solo para áreas EXCLUSIVAS (evento toma toda el área).
  -- Las áreas compartidas (p.ej. alberca) no bloquean por solape.
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

  -- Auto-aprobación si está dentro de rango
  v_estado := CASE WHEN a.aprobacion_automatica THEN 'aprobada' ELSE 'pendiente' END;

  INSERT INTO mifracc.reservations
    (colonia_id, area_id, house_id, fecha_hora_inicio, fecha_hora_fin, estado, cantidad_personas)
  VALUES
    (v_colonia_id, p_area_id, v_house_id, p_inicio, p_fin, v_estado, p_personas)
  RETURNING id INTO p_area_id;  -- reutilizo var para devolver el id

  RETURN jsonb_build_object('ok', true, 'reservation_id', p_area_id, 'estado', v_estado);
END $$;

-- ------------------------------------------------------------
-- 6) RPC: cancelar una reserva propia (futura)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mifracc.cancelar_reserva(p_reservation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
DECLARE
  r mifracc.reservations%ROWTYPE;
BEGIN
  SELECT * INTO r FROM mifracc.reservations WHERE id = p_reservation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La reserva no existe.';
  END IF;
  IF r.house_id <> mifracc.my_house_id() THEN
    RAISE EXCEPTION 'Solo puedes cancelar reservas de tu casa.';
  END IF;
  IF r.estado IN ('en_uso','completada') THEN
    RAISE EXCEPTION 'No puedes cancelar una reserva en uso o completada.';
  END IF;
  UPDATE mifracc.reservations SET estado = 'rechazada' WHERE id = p_reservation_id;
  RETURN jsonb_build_object('ok', true);
END $$;

GRANT EXECUTE ON FUNCTION mifracc.my_house_id()                     TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION mifracc.disponibilidad_area(uuid,date)    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION mifracc.crear_reserva(uuid,timestamptz,timestamptz,int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION mifracc.cancelar_reserva(uuid)            TO authenticated, service_role;

-- ------------------------------------------------------------
-- 7) Seed de config + depuración (Villa Catania)
--    Reservables reales: Alberca (compartida) y Terraza (evento exclusivo).
-- ------------------------------------------------------------
-- Alberca: compartida, 8–20, máx 5 personas/casa, gratis, auto.
UPDATE mifracc.common_areas SET
  activa = true, reservable = true, exclusiva = false, requiere_aforo = true,
  hora_apertura = '08:00', hora_cierre = '20:00',
  duracion_min_horas = 1, duracion_max_horas = 3,
  max_personas_casa = 5, capacidad_personas = 5,
  costo = 0, deposito = 0, aprobacion_automatica = true,
  color = '#0ea5e9', icono = '🏊', orden = 1,
  reglas = 'Horario 8:00–20:00. Máximo 5 personas por casa. Uso compartido y gratuito. La llave se recoge en caseta con registro. Solo casas al corriente.'
WHERE nombre = 'Alberca';

-- Terraza: evento exclusivo (toda el área), 8–22, aforo 25, cuota + depósito, auto.
UPDATE mifracc.common_areas SET
  activa = true, reservable = true, exclusiva = true, requiere_aforo = true,
  hora_apertura = '08:00', hora_cierre = '22:00',
  duracion_min_horas = 1, duracion_max_horas = 8,
  max_personas_casa = NULL, capacidad_personas = 25, cantidad_espacios = 1,
  costo = 3000, deposito = 3000, aprobacion_automatica = true,
  color = '#f59e0b', icono = '🌅', orden = 2,
  reglas = 'Reserva de evento: toma toda la terraza. Aforo máximo 25 personas, límite 22:00. Cuota $3,000 + depósito $3,000 (reintegrable si no hay daños). Sin inflables. El uso ordinario (sin evento) no requiere reserva. Solo casas al corriente.'
WHERE nombre = 'Terraza';

-- Depurar: estas no se reservan por este módulo.
UPDATE mifracc.common_areas SET activa = false, reservable = false WHERE nombre = 'Escalera';
UPDATE mifracc.common_areas SET reservable = false, icono = '🅿️' WHERE nombre = 'Estacionamiento de Visitas';
