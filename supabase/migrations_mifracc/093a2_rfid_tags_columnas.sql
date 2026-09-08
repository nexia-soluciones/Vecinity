-- ============================================================
-- MIFRACC · Columnas de mifracc.rfid_tags ausentes de las 97 migraciones
-- rastreadas. Confirmado (solo lectura, comparando vecino.rfid_tags vs
-- mifracc.rfid_tags vía MCP supabase-nexia) que estas 3 columnas existen en
-- vecino y se agregaron directo en la instancia, fuera del historial
-- versionado — mismo patrón que el trigger de auth.users (005) y los
-- ALTER TYPE sueltos (052b/093a). Se referencian ya desde 065/066/085/086/
-- 089/090/092/093b, dentro de cuerpos de función (por eso esas migraciones
-- aplicaron sin error pese a que las columnas no existían: un CREATE
-- FUNCTION no valida columnas, solo se valida al ejecutarse). El primer
-- fallo real ocurrió en 093b, que las usa en un INSERT directo.
-- ============================================================
ALTER TABLE mifracc.rfid_tags
  ADD COLUMN IF NOT EXISTS impresa_at timestamptz,
  ADD COLUMN IF NOT EXISTS enrolled_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
