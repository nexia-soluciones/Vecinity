-- ============================================================
-- MIFRACC · Columna huérfana de mifracc.colonias
-- Confirmado (solo lectura, comparando vecino.colonias vs mifracc.colonias
-- vía MCP supabase-nexia) que umbral_servicios existe en vecino y no
-- aparece en ninguna de las 97 migraciones rastreadas ni en _excluidos/ —
-- se agregó directo en la instancia, fuera del historial versionado.
-- ============================================================
ALTER TABLE mifracc.colonias ADD COLUMN IF NOT EXISTS umbral_servicios numeric DEFAULT 1000;
