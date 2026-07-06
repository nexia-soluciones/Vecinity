-- 049 — Calendario general de reservas + guard de fecha en entrega de áreas.
-- Aplicado en producción vía /pg/query el 2026-07-06 (este archivo documenta el cambio).

-- 1) Guard de fecha en entregar_area: el guardia no puede marcar entrega de una
--    reserva ANTES de su día (bug: se cerraban reservas futuras por error).
CREATE OR REPLACE FUNCTION vecino.entregar_area(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'vecino', 'auth'
AS $function$
DECLARE r vecino.reservations%ROWTYPE;
BEGIN
  IF NOT vecino.is_guard() THEN RAISE EXCEPTION 'Solo el personal de vigilancia.'; END IF;
  SELECT * INTO r FROM vecino.reservations WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'La reserva no existe.'; END IF;
  IF r.colonia_id <> vecino.my_colonia_id() THEN RAISE EXCEPTION 'La reserva no es de tu colonia.'; END IF;
  IF r.estado <> 'aprobada' THEN RAISE EXCEPTION 'La reserva no está aprobada / lista para entregar.'; END IF;
  -- Guard de fecha: no se puede entregar un área antes del día de la reserva
  IF (r.fecha_hora_inicio AT TIME ZONE 'America/Mexico_City')::date
       > (now() AT TIME ZONE 'America/Mexico_City')::date THEN
    RAISE EXCEPTION 'Esta reserva es para el %. Solo puedes entregarla el día de la reserva.',
      to_char(r.fecha_hora_inicio AT TIME ZONE 'America/Mexico_City', 'DD/MM/YYYY');
  END IF;
  UPDATE vecino.reservations
     SET estado = 'en_uso', guardia_entrega_id = auth.uid(), fecha_hora_entrega = now()
   WHERE id = p_id;
  RETURN jsonb_build_object('ok', true, 'estado', 'en_uso');
END $function$;

-- 2) Calendario general de reservas de la colonia (visible para cualquier residente).
--    Muestra "lo que está ocupado" (mismos estados que disponibilidad_area).
CREATE OR REPLACE FUNCTION vecino.calendario_reservas(p_desde date, p_hasta date)
 RETURNS TABLE(
   reserva_id uuid,
   area_id uuid,
   area_nombre text,
   area_color text,
   area_icono text,
   area_exclusiva boolean,
   casa_numero text,
   es_mia boolean,
   inicio timestamptz,
   fin timestamptz,
   estado text,
   cantidad_personas integer
 )
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'vecino', 'auth'
AS $function$
  SELECT
    r.id, a.id, a.nombre, a.color, a.icono, a.exclusiva,
    h.numero::text,
    (r.house_id = vecino.my_house_id()) AS es_mia,
    r.fecha_hora_inicio, r.fecha_hora_fin, r.estado, r.cantidad_personas
  FROM vecino.reservations r
  JOIN vecino.common_areas a ON a.id = r.area_id
  LEFT JOIN vecino.houses h ON h.id = r.house_id
  WHERE a.colonia_id = vecino.my_colonia_id()
    AND r.estado IN ('pendiente','aprobada','en_uso')
    AND (r.fecha_hora_inicio AT TIME ZONE 'America/Mexico_City')::date
          BETWEEN p_desde AND p_hasta
  ORDER BY r.fecha_hora_inicio;
$function$;

GRANT EXECUTE ON FUNCTION vecino.calendario_reservas(date, date) TO authenticated;
