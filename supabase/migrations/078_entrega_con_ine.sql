-- 078 — Entrega de tarjetas con FOTO DEL INE del responsable de la casa
-- En la sesión de entrega (tablet del comité): foto del INE + firma del vecino.
-- La foto es identificación oficial → bucket PRIVADO (no URL pública); en la
-- entrega se guarda la RUTA del objeto y se consulta con signed URLs.

ALTER TABLE vecino.card_deliveries
  ADD COLUMN IF NOT EXISTS ine_path text;  -- ruta en el bucket privado vecino-ine

-- Bucket privado para las fotos de INE.
INSERT INTO storage.buckets (id, name, public)
VALUES ('vecino-ine', 'vecino-ine', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS vecino_ine_insert ON storage.objects;
CREATE POLICY vecino_ine_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'vecino-ine');
DROP POLICY IF EXISTS vecino_ine_select ON storage.objects;
CREATE POLICY vecino_ine_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'vecino-ine');

-- Param nuevo con DEFAULT = sobrecarga ambigua en PostgREST → DROP de la firma vieja.
DROP FUNCTION IF EXISTS vecino.entregar_tarjeta_firmada(uuid, text, text);

CREATE OR REPLACE FUNCTION vecino.entregar_tarjeta_firmada(
  p_job uuid, p_firmante text, p_firma_b64 text, p_ine_path text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, public AS $$
DECLARE
  j vecino.print_jobs%ROWTYPE;
  v_at timestamptz;
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité puede entregar tarjetas.'; END IF;
  IF coalesce(trim(p_firmante), '') = '' THEN RAISE EXCEPTION 'Falta el nombre de quien recibe.'; END IF;
  IF coalesce(p_firma_b64, '') = '' THEN RAISE EXCEPTION 'Falta la firma.'; END IF;
  IF length(p_firma_b64) > 500000 THEN RAISE EXCEPTION 'La firma es demasiado pesada.'; END IF;

  SELECT * INTO j FROM vecino.print_jobs
   WHERE id = p_job AND colonia_id = vecino.my_colonia_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tarjeta inexistente o de otra colonia.'; END IF;
  IF j.estado <> 'impresa' THEN RAISE EXCEPTION 'Solo se entrega una tarjeta ya impresa.'; END IF;

  INSERT INTO vecino.card_deliveries
    (print_job_id, card_request_id, colonia_id, firmante, firma_b64, ine_path, delivered_by)
  VALUES (p_job, j.card_request_id, j.colonia_id, trim(p_firmante), p_firma_b64,
          nullif(trim(coalesce(p_ine_path, '')), ''),
          auth.uid())  -- vecino.profiles.id = auth.uid() en este schema
  RETURNING delivered_at INTO v_at;

  IF j.card_request_id IS NOT NULL THEN
    UPDATE vecino.card_requests SET estado = 'entregada', delivered_at = v_at
     WHERE id = j.card_request_id AND estado IN ('en_cola','impresa');
  END IF;
  RETURN jsonb_build_object('ok', true, 'delivered_at', v_at);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'Esa tarjeta ya tiene entrega firmada.';
END $$;

GRANT EXECUTE ON FUNCTION vecino.entregar_tarjeta_firmada(uuid, text, text, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
