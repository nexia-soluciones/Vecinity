-- 072 — Reimpresión de tarjetas históricas (consola de operador Nexia)
-- Las tarjetas impresas ANTES de la cola (lotes manuales) viven como
-- card_requests entregadas sin print_job. Para reimprimirlas, el operador
-- las re-encola: se crea un print_job nuevo con el payload armado desde los
-- datos vivos de la BD (_payload_tarjeta) y sale por el flujo normal de la
-- consola (aparece en "Por imprimir", descuenta stock al imprimir).
-- SOLO service_role (el bridge server-side).

CREATE OR REPLACE FUNCTION vecino.print_encolar_reimpresion(p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, public AS $$
DECLARE
  r vecino.card_requests%ROWTYPE;
  v_job uuid;
BEGIN
  SELECT * INTO r FROM vecino.card_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Solicitud inexistente.'; END IF;
  IF r.estado NOT IN ('impresa','entregada') THEN
    RAISE EXCEPTION 'Solo se reimprime una tarjeta ya impresa o entregada.';
  END IF;
  IF EXISTS (SELECT 1 FROM vecino.print_jobs
              WHERE card_request_id = p_request_id
                AND estado IN ('pendiente','imprimiendo')) THEN
    RAISE EXCEPTION 'Esa tarjeta ya tiene una reimpresión esperando en la cola.';
  END IF;

  INSERT INTO vecino.print_jobs (colonia_id, card_request_id, tipo, payload)
  VALUES (r.colonia_id, r.id, r.tipo, vecino._payload_tarjeta(r))
  RETURNING id INTO v_job;

  -- Nota: al imprimirse, print_mark_job solo asciende card_requests que estén
  -- 'en_cola' — una entregada se queda entregada. Correcto para reimpresión.
  RETURN jsonb_build_object('ok', true, 'job', v_job);
END $$;

REVOKE EXECUTE ON FUNCTION vecino.print_encolar_reimpresion(uuid) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION vecino.print_encolar_reimpresion(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
