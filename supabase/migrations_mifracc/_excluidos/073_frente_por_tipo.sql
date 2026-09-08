-- TODO(mifracc): pendiente de una colonia demo sintética. Esta UPDATE venía
-- originalmente en 073_frente_por_tipo.sql y apunta a URLs REALES de
-- producción (bucket vecino-tarjetas, imágenes ya subidas de Villa Catania).
-- No aplica a un fraccionamiento sintético/demo. El ADD COLUMN de la misma
-- migración original (tarjeta_frente_visita_url) SÍ se replicó en el set
-- principal — ver supabase/migrations_mifracc/073_frente_por_tipo.sql.
-- Pendiente: decidir si mifracc necesita su propio diseño de tarjeta y
-- bucket, o si esta siembra simplemente no debe replicarse.

-- Villa Catania: diseños subidos al bucket público vecino-tarjetas (2026-07-16)
UPDATE mifracc.colonias SET
  tarjeta_frente_url        = 'https://supabase.nexiasoluciones.com.mx/storage/v1/object/public/vecino-tarjetas/villa-catania/frente.png',
  tarjeta_frente_visita_url = 'https://supabase.nexiasoluciones.com.mx/storage/v1/object/public/vecino-tarjetas/villa-catania/frente-visita.png'
WHERE id = 'ce43b59c-529b-4960-8dd7-d975e43ac2fb';
