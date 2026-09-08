-- 073 — Diseño de frente POR TIPO de tarjeta
-- Las tarjetas de visita recurrente llevan su propio diseño (azul) distinto al
-- de residentes (vehicular/peatonal). El bridge elige:
--   visita  → tarjeta_frente_visita_url (si existe; si no, cae al general)
--   resto   → tarjeta_frente_url
--
-- NOTA (mifracc): el UPDATE original (siembra de URLs reales de Villa
-- Catania en el bucket vecino-tarjetas) se movió a
-- _excluidos/073_frente_por_tipo.sql — no aplica a un fraccionamiento
-- sintético/demo. Este archivo solo agrega la columna.

ALTER TABLE mifracc.colonias
  ADD COLUMN IF NOT EXISTS tarjeta_frente_visita_url text;

NOTIFY pgrst, 'reload schema';
