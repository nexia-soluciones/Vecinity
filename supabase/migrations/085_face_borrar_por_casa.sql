-- 085_face_borrar_por_casa.sql
-- =============================================================================
-- Antes el vecino sólo podía quitar un rostro 'recibida'/'rechazada'; si ya
-- estaba activo en la puerta ('aprobada'/'enrolada') le decía "pide al comité".
-- Ahora cada casa puede borrar a CUALQUIERA de sus personas en cualquier estado.
-- La baja física en la terminal la sigue ejecutando el poller de la Orin (plan
-- 'remove'), gracias a que el registro queda 'retirada' con terminal_removed_at NULL.
-- El comité conserva su poder de borrar cualquier rostro.
-- =============================================================================

CREATE OR REPLACE FUNCTION vecino.face_retire(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'vecino', 'public'
AS $function$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM vecino.face_enrollments WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Registro no encontrado.'; END IF;
  IF r.status = 'retirada' THEN RETURN jsonb_build_object('ok', true); END IF;
  -- El vecino puede borrar cualquier rostro DE SU CASA (en cualquier estado).
  IF NOT vecino.is_admin() THEN
    IF r.house_id NOT IN (
        SELECT house_id FROM vecino.profiles WHERE id = auth.uid()
        UNION SELECT house_id FROM vecino.house_members WHERE profile_id = auth.uid()) THEN
      RAISE EXCEPTION 'Ese rostro no es de tu casa.';
    END IF;
  END IF;
  UPDATE vecino.face_enrollments SET status = 'retirada' WHERE id = p_id;
  RETURN jsonb_build_object('ok', true,
    'pendiente_borrado', r.enrolled_at IS NOT NULL AND r.terminal_removed_at IS NULL);
END $function$;
