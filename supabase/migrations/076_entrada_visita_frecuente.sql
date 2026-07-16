-- 076 — Registro de ENTRADA de visita frecuente desde la tarjeta escaneada
-- El guardia escanea el QR de la tarjeta (/vf/<card_id>): además de verificar,
-- puede registrar la entrada con un botón — se crea una fila en vecino.visitors
-- (mismo historial y flujo de salida que cualquier visita) ligada a la tarjeta.

ALTER TABLE vecino.visitors
  ADD COLUMN IF NOT EXISTS card_request_id uuid REFERENCES vecino.card_requests(id);
CREATE INDEX IF NOT EXISTS visitors_card ON vecino.visitors (card_request_id)
  WHERE card_request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION vecino.entrada_visita_frecuente(p_card_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE
  r vecino.card_requests%ROWTYPE;
  v_adentro vecino.visitors%ROWTYPE;
  v_casa text;
  v_id uuid;
BEGIN
  IF NOT vecino.is_guard() THEN RAISE EXCEPTION 'Solo el personal de vigilancia.'; END IF;

  SELECT * INTO r FROM vecino.card_requests
   WHERE id = p_card_id AND tipo = 'visita' AND colonia_id = vecino.my_colonia_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'El QR no corresponde a ninguna tarjeta de visita de esta colonia.'; END IF;
  IF r.estado NOT IN ('impresa','entregada') THEN
    RAISE EXCEPTION 'La tarjeta no está vigente (estado: %).', r.estado;
  END IF;

  SELECT numero INTO v_casa FROM vecino.houses WHERE id = r.house_id;

  -- Si ya hay una visita ADENTRO con esta tarjeta, no duplicar: el guardia
  -- puede marcar la salida (el botón de la UI cambia a eso).
  SELECT * INTO v_adentro FROM vecino.visitors
   WHERE card_request_id = p_card_id AND estado = 'adentro'
   ORDER BY fecha_hora_entrada DESC LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', false, 'ya_adentro', true,
      'visitor_id', v_adentro.id, 'nombre', v_adentro.nombre, 'casa', v_casa,
      'desde', v_adentro.fecha_hora_entrada);
  END IF;

  INSERT INTO vecino.visitors
    (colonia_id, house_id, nombre, estado, guardia_entrada_id,
     fecha_hora_entrada, origen_registro, card_request_id)
  VALUES
    (r.colonia_id, r.house_id, coalesce(r.beneficiario_nombre, 'Visita frecuente'),
     'adentro', auth.uid(), now(), 'vigilante', p_card_id)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'visitor_id', v_id,
    'nombre', coalesce(r.beneficiario_nombre, 'Visita frecuente'), 'casa', v_casa);
END $$;

GRANT EXECUTE ON FUNCTION vecino.entrada_visita_frecuente(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
