-- 068: La puerta peatonal también la abren los VECINOS (para recibir visitas)
--
-- Decisión del Director (2026-07-15): cualquier perfil aprobado puede ver la
-- cámara y abrir — el control no es el rol sino la AUDITORÍA: cada apertura
-- queda en mifracc.door_commands con requested_by, fecha y resultado, y el
-- comité la consulta con door_log() (nombre + casa + rol de quien abrió).
--
-- La bitácora directa (SELECT sobre door_commands) sigue siendo solo de
-- admin/comité/guardia — el vecino abre, pero no ve el historial de otros.

-- 1. Gate: de "solo comité/guardia" a "cualquier perfil aprobado" -----------------
CREATE OR REPLACE FUNCTION mifracc.is_door_operator()
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = mifracc, auth AS $$
  SELECT EXISTS (SELECT 1 FROM mifracc.profiles
                 WHERE id = auth.uid()
                   AND approval_status = 'aprobado')
$$;

-- 2. Bitácora legible para el comité y los guardias -------------------------------
CREATE OR REPLACE FUNCTION mifracc.door_log(p_limit int DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = mifracc, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM mifracc.profiles
                 WHERE id = auth.uid()
                   AND role IN ('admin','comite','guardia')
                   AND approval_status = 'aprobado') THEN
    RAISE EXCEPTION 'Solo el comité y los guardias pueden ver la bitácora de la puerta.';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(to_jsonb(x)) FROM (
      SELECT d.requested_at, d.result, d.error,
             p.nombre AS nombre, p.role AS rol,
             h.numero AS casa
      FROM mifracc.door_commands d
      LEFT JOIN mifracc.profiles p ON p.id = d.requested_by
      LEFT JOIN mifracc.houses h ON h.id = p.house_id
      ORDER BY d.requested_at DESC
      LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100)
    ) x
  ), '[]'::jsonb);
END $$;

GRANT EXECUTE ON FUNCTION mifracc.door_log(int) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
