-- ============================================================
-- 096 — Levantar una multa directa (comité), sin incidencia previa
--
-- Hasta hoy una multa SÓLO podía nacer de una incidencia que alguien
-- reportara: el comité que ve la falta con sus propios ojos no tenía por
-- dónde. Sin esta puerta, la salida real es escribir en la BD a mano — y
-- entonces se vuelve el camino de siempre, sin categoría, sin tope, sin
-- resolución oficial y sin rastro.
--
-- Regla que se respeta aquí: NO se duplican las mecánicas. La multa directa
-- DELEGA en las dos funciones que ya existen —
--   reportar_incidencia()  crea el expediente
--   resolver_incidencia()  cobra, respeta el tope, mueve saldo y estatus
-- — para que el cargo, el tope por colonia y la resolución oficial vivan en
-- un solo lugar. Si mañana cambia la regla del cobro, cambia para las dos
-- puertas o no cambia para ninguna.
--
-- Todo corre en una sola transacción: si el monto se pasa del tope, el
-- expediente tampoco se crea.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- De dónde salió el expediente. Informativo: NADIE filtra por él, así que un
-- lector que no lo conozca sigue viendo la incidencia como siempre. Las 247
-- filas que ya existen quedan etiquetadas como 'reporte', que es lo que son.
-- ------------------------------------------------------------
ALTER TABLE mifracc.incident_reports
  ADD COLUMN IF NOT EXISTS origen text NOT NULL DEFAULT 'reporte';

COMMENT ON COLUMN mifracc.incident_reports.origen IS
  '''reporte'' = lo levantó un vecino/guardia y el comité lo resolvió. '
  '''comite'' = el comité lo levantó y multó en un solo acto (levantar_multa). '
  'Informativo: ningún filtro de negocio depende de este campo.';

-- ------------------------------------------------------------
-- levantar_multa — el comité multa lo que vio, en un solo acto
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mifracc.levantar_multa(
  p_infractor     uuid,
  p_categoria     uuid,
  p_monto         numeric,
  p_descripcion   text DEFAULT NULL,
  p_evidencia_url text DEFAULT NULL,
  p_nota          text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'mifracc', 'auth'
AS $$
DECLARE
  v_col uuid := mifracc.my_colonia_id();
  v_rep jsonb;
  v_id  uuid;
  v_res jsonb;
BEGIN
  IF NOT mifracc.is_admin() THEN
    RAISE EXCEPTION 'Solo el comité puede levantar una multa.';
  END IF;
  IF p_categoria IS NULL THEN
    RAISE EXCEPTION 'Elige la categoría de la falta.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM mifracc.fine_categories
     WHERE id = p_categoria AND colonia_id = v_col
  ) THEN
    RAISE EXCEPTION 'Esa categoría no es de tu colonia.';
  END IF;
  -- Una multa sin relato es un cargo sin sustento: quien la reciba no puede
  -- ni aclararla ni defenderse. El texto es obligatorio por eso, no por forma.
  IF nullif(btrim(coalesce(p_descripcion, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Escribe qué pasó: la multa se le va a cobrar a una casa y tiene que poder explicarse.';
  END IF;

  -- 1) El expediente nace por la MISMA puerta que las del vecino
  --    (valida que la casa sea de tu colonia y sella la hora de la evidencia).
  v_rep := mifracc.reportar_incidencia(
             p_infractor, p_categoria, p_descripcion, p_evidencia_url, NULL, NULL);
  v_id  := (v_rep->>'id')::uuid;

  UPDATE mifracc.incident_reports SET origen = 'comite' WHERE id = v_id;

  -- 2) Y se cobra por la MISMA puerta que resuelve el comité: tope, cargo,
  --    saldo y estatus los sigue calculando un solo lugar.
  v_res := mifracc.resolver_incidencia(v_id, 'multar', p_monto, p_nota);

  RETURN jsonb_build_object(
    'ok', true,
    'id', v_id,
    'transaction_id', v_res->>'transaction_id'
  );
END $$;

REVOKE ALL ON FUNCTION mifracc.levantar_multa(uuid,uuid,numeric,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mifracc.levantar_multa(uuid,uuid,numeric,text,text,text)
  TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
