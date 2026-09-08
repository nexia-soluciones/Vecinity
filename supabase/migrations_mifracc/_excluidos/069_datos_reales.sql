-- TODO(mifracc): pendiente de una colonia demo sintética. Este backfill venía
-- originalmente en 069_puerta_por_colonia.sql (sección 1, líneas 15-17) y
-- asigna el dispositivo de cámara/puerta 'peatonal' al UUID real de Villa
-- Catania. mifracc no tiene esa colonia (ni ninguna real) sembrada, así que
-- el UPDATE viola la FK camera_state_colonia_id_fkey. Cuando exista una
-- colonia demo en mifracc, reemplazar el UUID de abajo por el id de esa
-- colonia demo y aplicar esto por separado.

UPDATE mifracc.camera_state
   SET colonia_id = 'ce43b59c-529b-4960-8dd7-d975e43ac2fb'  -- Villa Catania
 WHERE camera = 'peatonal' AND colonia_id IS NULL;
