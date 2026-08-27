-- seed_villa_demo_multas.sql — Villa Aurora (DEMO): catálogo de faltas
--
-- La demo de "incidencia → multa" no podía correr: Villa Aurora tenía CERO
-- categorías de multa (Catania tiene 7). Sin categoría no se puede ni reportar
-- una incidencia ni convertirla en multa, así que el módulo entero se veía
-- vacío sin que nada diera error.
--
-- Montos por debajo del tope de la villa (colonias.tope_multa = $2,000).
-- articulo_id queda NULL a propósito: Villa Aurora no tiene reglamento
-- capturado y la columna lo permite.
--
-- Idempotente: se puede volver a correr sin duplicar.
DO $$
DECLARE v_col uuid;
BEGIN
  SELECT id INTO v_col FROM vecino.colonias WHERE slug = 'villa-aurora-demo';
  IF v_col IS NULL THEN
    RAISE EXCEPTION 'No existe la colonia villa-aurora-demo.';
  END IF;

  INSERT INTO vecino.fine_categories (colonia_id, nombre, monto_base)
  SELECT v_col, x.nombre, x.monto
    FROM (VALUES
      ('Estacionamiento Prohibido',      300),
      ('Ruido Excesivo / Fiestas',       500),
      ('Mascotas (Heces / Sin Correa)',  250),
      ('Basura en Área Común',           200),
      ('Uso Indebido de Amenidades',     400),
      ('Exceso de Velocidad',            350),
      ('Fachada no Autorizada',         1000)
    ) AS x(nombre, monto)
   WHERE NOT EXISTS (
     SELECT 1 FROM vecino.fine_categories f
      WHERE f.colonia_id = v_col AND f.nombre = x.nombre
   );

  RAISE NOTICE 'Villa Aurora: % categorías de multa',
    (SELECT count(*) FROM vecino.fine_categories WHERE colonia_id = v_col);
END $$;
