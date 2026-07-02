-- =============================================================================
-- 040_bienes_editar_gasto.sql — Bienes de la villa + reclasificar gastos
-- =============================================================================
-- Juan (2026-07-02): "hay gastos que son bienes ahora para la villa, ej. la
-- cafetera de Walmart ($899) para las sesiones" → flag es_bien marca el gasto
-- como patrimonio/inventario de la colonia (visible en transparencia).
-- Además clasificar_gasto ahora acepta es_bien y sirve también para RE-clasificar
-- gastos ya clasificados (asignar proyecto/razón después, ej. mano de obra bancas).
-- =============================================================================

ALTER TABLE vecino.colonia_expenses ADD COLUMN IF NOT EXISTS es_bien boolean NOT NULL DEFAULT false;

-- Firma nueva (+p_es_bien) → tirar la anterior para no dejar sobrecarga ambigua
DROP FUNCTION IF EXISTS vecino.clasificar_gasto(uuid,text,text,uuid,text,text,text);

CREATE OR REPLACE FUNCTION vecino.clasificar_gasto(
  p_id             uuid,
  p_concepto       text,
  p_categoria      text,
  p_improvement_id uuid DEFAULT NULL,
  p_descripcion    text DEFAULT NULL,
  p_keyword        text DEFAULT NULL,
  p_archivo_url    text DEFAULT NULL,
  p_es_bien        boolean DEFAULT NULL   -- NULL = no cambiar
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE
  v_col uuid := vecino.my_colonia_id();
  v_kw  text := upper(btrim(coalesce(p_keyword,'')));
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;
  IF coalesce(btrim(p_concepto),'') = '' THEN RAISE EXCEPTION 'Escribe la razón del gasto.'; END IF;
  IF coalesce(btrim(p_categoria),'') = '' THEN RAISE EXCEPTION 'Elige una categoría.'; END IF;
  IF p_improvement_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM vecino.improvement_projects
        WHERE id = p_improvement_id AND colonia_id = v_col) THEN
    RAISE EXCEPTION 'El proyecto no pertenece a tu colonia.';
  END IF;

  UPDATE vecino.colonia_expenses SET
    concepto       = btrim(p_concepto),
    categoria      = btrim(p_categoria),
    improvement_id = p_improvement_id,
    descripcion    = coalesce(nullif(btrim(p_descripcion),''), descripcion),
    archivo_principal_url = coalesce(p_archivo_url, archivo_principal_url),
    es_bien        = coalesce(p_es_bien, es_bien),
    estado         = 'clasificado'
  WHERE id = p_id AND colonia_id = v_col;
  IF NOT FOUND THEN RAISE EXCEPTION 'Gasto no encontrado.'; END IF;

  -- Aprender: proveedor → categoría (y proyecto como propuesta futura)
  IF length(v_kw) >= 4 THEN
    INSERT INTO vecino.expense_cat_map (colonia_id, keyword, categoria, improvement_id, origen)
    VALUES (v_col, v_kw, btrim(p_categoria), p_improvement_id, 'aprendido')
    ON CONFLICT (colonia_id, keyword)
      DO UPDATE SET categoria = EXCLUDED.categoria,
                    improvement_id = EXCLUDED.improvement_id,
                    veces = vecino.expense_cat_map.veces + 1,
                    updated_at = now();
  END IF;

  RETURN jsonb_build_object('ok', true);
END $$;
GRANT EXECUTE ON FUNCTION vecino.clasificar_gasto(uuid,text,text,uuid,text,text,text,boolean) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
