-- =============================================================================
-- 041_expense_categories.sql — Catálogo de categorías administrable por el comité
-- =============================================================================
-- Juan (2026-07-02): "¿dónde creo una categoría nueva, ej. Insumos caseta?"
-- → el catálogo pasa de constante en código a TABLA por colonia que el comité
-- administra desde la app (+Nueva, renombrar, activar/desactivar). Los dropdowns
-- leen esta tabla; siguen siendo cerrados (typo-safe) pero ahora self-serve.
-- Semilla = las 21 canónicas de src/lib/categorias.ts + "Insumos caseta".
-- =============================================================================

CREATE TABLE IF NOT EXISTS vecino.expense_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id uuid NOT NULL REFERENCES vecino.colonias(id) ON DELETE CASCADE,
  nombre     text NOT NULL,
  activa     boolean NOT NULL DEFAULT true,
  orden      int NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Anti-duplicado case-insensitive por colonia (evita "Basura" y "basura")
CREATE UNIQUE INDEX IF NOT EXISTS expense_categories_uq
  ON vecino.expense_categories (colonia_id, lower(nombre));

ALTER TABLE vecino.expense_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS expense_categories_read  ON vecino.expense_categories;
DROP POLICY IF EXISTS expense_categories_admin ON vecino.expense_categories;
CREATE POLICY expense_categories_read ON vecino.expense_categories FOR SELECT
  USING (colonia_id = vecino.my_colonia_id());
CREATE POLICY expense_categories_admin ON vecino.expense_categories FOR ALL
  USING (colonia_id = vecino.my_colonia_id() AND vecino.is_admin())
  WITH CHECK (colonia_id = vecino.my_colonia_id() AND vecino.is_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON vecino.expense_categories TO authenticated, service_role;

-- Semilla: 21 canónicas (orden = posición) + Insumos caseta, para cada colonia
INSERT INTO vecino.expense_categories (colonia_id, nombre, orden)
SELECT c.id, s.nombre, s.orden
FROM vecino.colonias c
CROSS JOIN (VALUES
  ('Vigilancia',1),('Jardinería',2),('JUMAPA (Agua)',3),('Alberca',4),
  ('Basura',5),('Limpieza',6),('CFE (Luz)',7),('Telmex',8),
  ('Impuestos (SAT)',9),('Comisiones Bancarias',10),('Contabilidad',11),
  ('Fumigación',12),('Materiales',13),('Mano de obra',14),('Compras Menores',15),
  ('Reparaciones',16),('Cámaras/Equipo',17),('Seguridad',18),('Retiros Cajero',19),
  ('INFONAVIT',20),('Insumos caseta',21),('Otros',99)
) AS s(nombre, orden)
ON CONFLICT (colonia_id, lower(nombre)) DO NOTHING;

-- --- RPC: crear categoría (o reactivar si existía desactivada) ---------------
CREATE OR REPLACE FUNCTION vecino.crear_categoria(p_nombre text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE v_col uuid := vecino.my_colonia_id(); v_id uuid; v_react boolean := false;
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;
  IF coalesce(btrim(p_nombre),'') = '' THEN RAISE EXCEPTION 'Escribe el nombre de la categoría.'; END IF;

  SELECT id, NOT activa INTO v_id, v_react FROM vecino.expense_categories
   WHERE colonia_id = v_col AND lower(nombre) = lower(btrim(p_nombre));
  IF v_id IS NOT NULL THEN
    UPDATE vecino.expense_categories SET activa = true, nombre = btrim(p_nombre) WHERE id = v_id;
    RETURN jsonb_build_object('ok', true, 'id', v_id, 'reactivada', v_react);
  END IF;

  INSERT INTO vecino.expense_categories (colonia_id, nombre, orden)
  VALUES (v_col, btrim(p_nombre), 50)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'reactivada', false);
END $$;
GRANT EXECUTE ON FUNCTION vecino.crear_categoria(text) TO authenticated, service_role;

-- --- RPC: renombrar (arrastra los gastos y el mapa aprendido a la vez) -------
CREATE OR REPLACE FUNCTION vecino.renombrar_categoria(p_id uuid, p_nombre text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE v_col uuid := vecino.my_colonia_id(); v_old text; v_new text := btrim(p_nombre);
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;
  IF v_new = '' THEN RAISE EXCEPTION 'Escribe el nombre.'; END IF;

  SELECT nombre INTO v_old FROM vecino.expense_categories
   WHERE id = p_id AND colonia_id = v_col;
  IF v_old IS NULL THEN RAISE EXCEPTION 'Categoría no encontrada.'; END IF;
  IF lower(v_new) <> lower(v_old) AND EXISTS (
       SELECT 1 FROM vecino.expense_categories
        WHERE colonia_id = v_col AND lower(nombre) = lower(v_new) AND id <> p_id) THEN
    RAISE EXCEPTION 'Ya existe una categoría con ese nombre.';
  END IF;

  UPDATE vecino.expense_categories SET nombre = v_new WHERE id = p_id;
  -- arrastrar el histórico y el mapa aprendido para que todo quede consistente
  UPDATE vecino.colonia_expenses SET categoria = v_new
   WHERE colonia_id = v_col AND categoria = v_old;
  UPDATE vecino.expense_cat_map SET categoria = v_new
   WHERE colonia_id = v_col AND categoria = v_old;
  RETURN jsonb_build_object('ok', true);
END $$;
GRANT EXECUTE ON FUNCTION vecino.renombrar_categoria(uuid,text) TO authenticated, service_role;

-- --- RPC: activar / desactivar (no borra: el histórico conserva su categoría) -
CREATE OR REPLACE FUNCTION vecino.set_categoria_activa(p_id uuid, p_activa boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE v_col uuid := vecino.my_colonia_id();
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;
  UPDATE vecino.expense_categories SET activa = coalesce(p_activa,true)
   WHERE id = p_id AND colonia_id = v_col;
  IF NOT FOUND THEN RAISE EXCEPTION 'Categoría no encontrada.'; END IF;
  RETURN jsonb_build_object('ok', true);
END $$;
GRANT EXECUTE ON FUNCTION vecino.set_categoria_activa(uuid,boolean) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
