-- ============================================================
-- MIFRACC · 093a — split de 093_tarjetas_visita_rfid.sql
-- Solo el ALTER TYPE: debe correr en su propia transacción, ANTES del
-- backfill/funciones de 093b (Postgres no permite usar un valor de enum
-- recién agregado en la misma transacción que lo agrega). Mismo patrón
-- que 052b/053.
-- ============================================================
ALTER TYPE mifracc.tag_type ADD VALUE IF NOT EXISTS 'visita';
