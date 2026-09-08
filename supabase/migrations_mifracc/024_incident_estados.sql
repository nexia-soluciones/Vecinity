-- ============================================================
-- VECINITY · 024 — Nuevos estados de incidencia (amonestación, propuesta)
-- schema: mifracc · Supabase self-hosted Nexia
--
-- Va en su PROPIA migración (transacción aparte): ALTER TYPE ... ADD VALUE
-- no puede usarse en la misma transacción donde se agrega. La 025 (que sí
-- usa estos valores en RPCs) corre después.
--   amonestacion → aviso de 1ª vez, sin monto (auto).
--   propuesta    → multa auto-generada por reincidencia, espera 1 voto del comité.
-- ============================================================

ALTER TYPE mifracc.incident_status ADD VALUE IF NOT EXISTS 'amonestacion';
ALTER TYPE mifracc.incident_status ADD VALUE IF NOT EXISTS 'propuesta';
