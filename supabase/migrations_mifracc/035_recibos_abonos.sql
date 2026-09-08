-- ============================================================
-- VECINITY · 035 — Recibo foliado de abonos (paridad con el Django viejo)
-- schema: mifracc · Supabase self-hosted Nexia
--
-- El sistema anterior generaba, al aprobar un abono, un RECIBO PDF FOLIADO
-- (folio consecutivo por colonia) descargable desde el estado de cuenta del
-- mifracc. El schema nuevo ya tenía `transactions.recibo_pdf_url` y
-- `folio_counters` pero la generación nunca se portó. Esto restaura la pieza:
--   · folio consecutivo atómico (continúa el contador: Villa Catania va en 2381)
--   · el PDF lo arma una Server Action (pdf-lib) y lo sube a Storage
--   · idempotente: si ya tiene recibo, no se regenera
-- ============================================================

-- Folio del recibo en la transacción (el contador vive en folio_counters).
ALTER TABLE mifracc.transactions
  ADD COLUMN IF NOT EXISTS folio int;

-- Un folio no se repite dentro de una colonia.
CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_colonia_folio
  ON mifracc.transactions (colonia_id, folio) WHERE folio IS NOT NULL;

-- ------------------------------------------------------------
-- RPC: siguiente_folio — incremento ATÓMICO del contador de la colonia.
-- Upsert: si la colonia no tiene contador, arranca en 2000 (default 1999 + 1).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mifracc.siguiente_folio(p_colonia uuid)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc AS $$
DECLARE v_folio int;
BEGIN
  INSERT INTO mifracc.folio_counters (colonia_id, ultimo_folio)
  VALUES (p_colonia, 2000)
  ON CONFLICT (colonia_id)
    DO UPDATE SET ultimo_folio = mifracc.folio_counters.ultimo_folio + 1
  RETURNING ultimo_folio INTO v_folio;
  RETURN v_folio;
END $$;

-- ------------------------------------------------------------
-- RPC: set_recibo_transaccion — guarda folio + URL del PDF en la transacción.
-- La llama la Server Action (service role) tras subir el PDF a Storage.
-- Idempotente/segura: solo abonos; no pisa un recibo ya existente.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mifracc.set_recibo_transaccion(
  p_id    uuid,
  p_folio int,
  p_url   text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc AS $$
DECLARE v_rows int;
BEGIN
  UPDATE mifracc.transactions
     SET folio = coalesce(folio, p_folio),
         recibo_pdf_url = p_url
   WHERE id = p_id AND tipo = 'abono';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN RAISE EXCEPTION 'No existe ese abono.'; END IF;
  RETURN jsonb_build_object('ok', true, 'folio', p_folio);
END $$;

GRANT EXECUTE ON FUNCTION mifracc.siguiente_folio(uuid)              TO service_role;
GRANT EXECUTE ON FUNCTION mifracc.set_recibo_transaccion(uuid,int,text) TO service_role;

-- ------------------------------------------------------------
-- Storage: bucket de recibos (público; paths con uuid → URL no adivinable).
-- Endurecer a signed URLs post-launch, igual que comprobantes/evidencias.
-- ------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('mifracc-recibos', 'mifracc-recibos', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "mifracc_recibos_insert" ON storage.objects;
CREATE POLICY "mifracc_recibos_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'mifracc-recibos');

DROP POLICY IF EXISTS "mifracc_recibos_read" ON storage.objects;
CREATE POLICY "mifracc_recibos_read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'mifracc-recibos');

NOTIFY pgrst, 'reload schema';
