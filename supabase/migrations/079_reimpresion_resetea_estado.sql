-- 079 — La reimpresión regresa la solicitud al flujo real de entrega
-- Contexto: las ~96 tarjetas de la campaña vieja quedaron 'entregada' en BD,
-- pero físicamente NADIE ha recibido tarjeta (la evidencia real de entrega es
-- ahora card_deliveries con firma + INE, y está vacía). Al re-encolar una
-- tarjeta, la solicitud vuelve a 'en_cola' con su print_job nuevo: al
-- imprimirse pasa a 'impresa' (aparece en "por entregar" del comité) y solo
-- la firma del vecino la vuelve 'entregada'.

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

  -- La solicitud vuelve al flujo real: en cola → (imprime) impresa → (firma) entregada.
  UPDATE vecino.card_requests
     SET estado = 'en_cola', delivered_at = NULL, print_job_id = v_job
   WHERE id = p_request_id;

  RETURN jsonb_build_object('ok', true, 'job', v_job);
END $$;

NOTIFY pgrst, 'reload schema';
