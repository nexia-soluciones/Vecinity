-- ============================================================
-- VECINITY · 014b — Storage: bucket de evidencias de incidencias
-- Bucket público con paths `colonia/uuid.ext` (URL solo vía filas RLS por colonia).
-- ============================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('vecino-evidencias', 'vecino-evidencias', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "vecino_evid_insert" ON storage.objects;
CREATE POLICY "vecino_evid_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'vecino-evidencias');

DROP POLICY IF EXISTS "vecino_evid_read" ON storage.objects;
CREATE POLICY "vecino_evid_read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'vecino-evidencias');
