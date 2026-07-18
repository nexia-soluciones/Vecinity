-- 087: El pago de la tarjeta se desacopla del estado de la tarjeta.
--
-- Problema real (2026-07-17): varias tarjetas se imprimieron/entregaron en la
-- campaña ANTES de validar el pago. El comprobante que sube el vecino queda
-- 'en_revision' pero:
--   (a) el vecino con tarjeta ya impresa NO podía subir comprobante (la RPC
--       exigía estado='solicitada'), y
--   (b) el comité no tenía dónde aprobar esos comprobantes (el panel solo
--       mostraba validación en la lista estado='solicitada').
--
-- Fix BD: permitir subir comprobante mientras el PAGO esté pendiente/rechazado
-- sin importar el estado de la tarjeta (mientras no esté cancelada/rechazada).
-- validar_pago_tarjeta ya opera con cualquier estado (solo checa
-- pago_estado='en_revision' + is_admin) → NO se toca.

CREATE OR REPLACE FUNCTION vecino.subir_comprobante_tarjeta(p_id uuid, p_url text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE v_n int;
BEGIN
  IF COALESCE(btrim(p_url), '') = '' THEN
    RAISE EXCEPTION 'Falta el comprobante.';
  END IF;
  UPDATE vecino.card_requests
     SET comprobante_url = p_url, pago_estado = 'en_revision',
         pago_motivo_rechazo = NULL
   WHERE id = p_id AND house_id = vecino.my_house_id()
     -- La tarjeta puede estar en cualquier punto vivo del ciclo (solicitada,
     -- en_cola, impresa, entregada). Solo se excluyen las muertas.
     AND estado NOT IN ('cancelada', 'rechazada')
     AND pago_estado IN ('pendiente', 'rechazado');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'La solicitud no admite comprobante (no es de tu casa, fue cancelada o el pago ya no está pendiente).';
  END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

NOTIFY pgrst, 'reload schema';
