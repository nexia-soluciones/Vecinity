-- 073 — Diseño de frente POR TIPO de tarjeta
-- Las tarjetas de visita recurrente llevan su propio diseño (azul) distinto al
-- de residentes (vehicular/peatonal). El bridge elige:
--   visita  → tarjeta_frente_visita_url (si existe; si no, cae al general)
--   resto   → tarjeta_frente_url

ALTER TABLE vecino.colonias
  ADD COLUMN IF NOT EXISTS tarjeta_frente_visita_url text;

-- Villa Catania: diseños subidos al bucket público vecino-tarjetas (2026-07-16)
UPDATE vecino.colonias SET
  tarjeta_frente_url        = 'https://supabase.nexiasoluciones.com.mx/storage/v1/object/public/vecino-tarjetas/villa-catania/frente.png',
  tarjeta_frente_visita_url = 'https://supabase.nexiasoluciones.com.mx/storage/v1/object/public/vecino-tarjetas/villa-catania/frente-visita.png'
WHERE id = 'ce43b59c-529b-4960-8dd7-d975e43ac2fb';

NOTIFY pgrst, 'reload schema';
