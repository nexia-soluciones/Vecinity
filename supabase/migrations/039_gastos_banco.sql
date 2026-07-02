-- =============================================================================
-- 039_gastos_banco.sql — Control de gastos estandarizado (Vibe Check Juan 2026-07-02)
-- =============================================================================
-- Visión: el admin sube el estado de cuenta diario; los ABONOS ya se concilian
-- a casa (022/036/037). Esta migración agrega el lado de los CARGOS (gastos):
--   1. Dedup por banco_hash en colonia_expenses (mismo patrón que transactions).
--   2. Auto-categorización de gastos recurrentes (jardinería, alberca, basura…)
--      vía expense_cat_map: semillas extraídas del Excel REAL de Villa Catania
--      (Dashboard_Financiero_2026, 151 egresos categorizados a mano) + mapa
--      APRENDIDO: al clasificar un gasto una vez, se recuerda el proveedor.
--   3. Bandeja "sin clasificar": todo cargo del banco entra con el concepto
--      crudo del banco (concepto_banco); el admin le pone la razón clara,
--      categoría y lo liga a un proyecto (improvement_projects, FK ya existía).
--   4. project_documents: contrato / cotización / factura por proyecto.
-- Patrón 036: lo aprendido con proyecto NO se auto-aplica — se PROPONE y el
-- admin confirma en la bandeja. Solo la categoría de recurrentes se auto-aplica.
-- =============================================================================

-- --- 1. colonia_expenses: origen banco + dedup + estado -----------------------
ALTER TABLE vecino.colonia_expenses ADD COLUMN IF NOT EXISTS banco_hash text;
ALTER TABLE vecino.colonia_expenses ADD COLUMN IF NOT EXISTS concepto_banco text;
ALTER TABLE vecino.colonia_expenses ADD COLUMN IF NOT EXISTS estado text NOT NULL DEFAULT 'clasificado';
ALTER TABLE vecino.colonia_expenses DROP CONSTRAINT IF EXISTS colonia_expenses_estado_chk;
ALTER TABLE vecino.colonia_expenses ADD CONSTRAINT colonia_expenses_estado_chk
  CHECK (estado IN ('sin_clasificar','clasificado'));
CREATE UNIQUE INDEX IF NOT EXISTS colonia_expenses_banco_hash_uq
  ON vecino.colonia_expenses (colonia_id, banco_hash) WHERE banco_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_exp_estado
  ON vecino.colonia_expenses (colonia_id, estado) WHERE estado = 'sin_clasificar';
CREATE INDEX IF NOT EXISTS idx_exp_improvement
  ON vecino.colonia_expenses (improvement_id) WHERE improvement_id IS NOT NULL;

-- --- 2. Mapa concepto→categoría (semillas + aprendido) ------------------------
-- keyword se busca con position() en el concepto del banco (normalizado UPPER).
-- La más LARGA gana (más específica). origen='semilla' = del Excel real;
-- 'aprendido' = el admin clasificó un gasto y el sistema lo recordó.
CREATE TABLE IF NOT EXISTS vecino.expense_cat_map (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id     uuid NOT NULL REFERENCES vecino.colonias(id) ON DELETE CASCADE,
  keyword        text NOT NULL,
  categoria      text NOT NULL,
  improvement_id uuid REFERENCES vecino.improvement_projects(id) ON DELETE SET NULL,
  origen         text NOT NULL DEFAULT 'aprendido' CHECK (origen IN ('semilla','aprendido')),
  veces          int  NOT NULL DEFAULT 1,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (colonia_id, keyword)
);
ALTER TABLE vecino.expense_cat_map ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS expense_cat_map_read  ON vecino.expense_cat_map;
DROP POLICY IF EXISTS expense_cat_map_admin ON vecino.expense_cat_map;
CREATE POLICY expense_cat_map_read ON vecino.expense_cat_map FOR SELECT
  USING (colonia_id = vecino.my_colonia_id());
CREATE POLICY expense_cat_map_admin ON vecino.expense_cat_map FOR ALL
  USING (colonia_id = vecino.my_colonia_id() AND vecino.is_admin())
  WITH CHECK (colonia_id = vecino.my_colonia_id() AND vecino.is_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON vecino.expense_cat_map TO authenticated, service_role;

-- Semillas (patrones verificados en los 151 egresos reales de Villa Catania).
-- Se insertan para TODAS las colonias existentes; ON CONFLICT = idempotente.
INSERT INTO vecino.expense_cat_map (colonia_id, keyword, categoria, origen)
SELECT c.id, s.keyword, s.categoria, 'semilla'
FROM vecino.colonias c
CROSS JOIN (VALUES
  ('JARDINER',            'Jardinería'),
  ('ALBERCA',             'Alberca'),
  ('BASURA',              'Basura'),
  ('LIMPIEZA',            'Limpieza'),
  ('VIGILANCIA',          'Vigilancia'),
  ('SPM080307N12',        'Vigilancia'),        -- RFC de la empresa de vigilancia
  ('JUMAPA',              'JUMAPA (Agua)'),
  ('CFE',                 'CFE (Luz)'),
  ('TELMEX',              'Telmex'),
  ('SAT/GUIA',            'Impuestos (SAT)'),
  ('INFONAVIT',           'INFONAVIT'),
  ('RETIRO CAJERO',       'Retiros Cajero'),
  ('SERV BANCA INTERNET', 'Comisiones Bancarias'),
  ('IVA COM SERV',        'Comisiones Bancarias'),
  ('OXXO',                'Compras Menores'),
  ('HOME DEPOT',          'Materiales'),
  ('OFFICE DEPOT',        'Materiales'),
  ('STEREN',              'Cámaras/Equipo'),
  ('CONTABILIDAD',        'Contabilidad'),
  ('FUMIGA',              'Fumigación')
) AS s(keyword, categoria)
ON CONFLICT (colonia_id, keyword) DO NOTHING;

-- --- 3. Documentos por proyecto (contrato, cotización, factura) ---------------
CREATE TABLE IF NOT EXISTS vecino.project_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES vecino.improvement_projects(id) ON DELETE CASCADE,
  tipo        text NOT NULL DEFAULT 'otro' CHECK (tipo IN ('contrato','cotizacion','factura','otro')),
  nombre      text NOT NULL,
  url         text NOT NULL,
  subido_por  uuid REFERENCES vecino.profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE vecino.project_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS project_documents_read  ON vecino.project_documents;
DROP POLICY IF EXISTS project_documents_admin ON vecino.project_documents;
-- Transparencia: cualquier residente de la colonia VE los documentos.
CREATE POLICY project_documents_read ON vecino.project_documents FOR SELECT
  USING (EXISTS (SELECT 1 FROM vecino.improvement_projects p
                 WHERE p.id = project_id AND p.colonia_id = vecino.my_colonia_id()));
CREATE POLICY project_documents_admin ON vecino.project_documents FOR ALL
  USING (EXISTS (SELECT 1 FROM vecino.improvement_projects p
                 WHERE p.id = project_id AND p.colonia_id = vecino.my_colonia_id())
         AND vecino.is_admin())
  WITH CHECK (EXISTS (SELECT 1 FROM vecino.improvement_projects p
                 WHERE p.id = project_id AND p.colonia_id = vecino.my_colonia_id())
         AND vecino.is_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON vecino.project_documents TO authenticated, service_role;

-- --- 4. RPC: importar un CARGO del estado de cuenta ---------------------------
-- Dedup por banco_hash; auto-categoría por el mapa (keyword más larga gana).
-- Si el match viene con proyecto (aprendido), se PROPONE: queda sin_clasificar
-- con improvement_id prellenado para que el admin confirme en la bandeja.
CREATE OR REPLACE FUNCTION vecino.importar_gasto_banco(
  p_fecha      date,
  p_monto      numeric,
  p_concepto   text,
  p_banco_hash text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE
  v_col uuid := vecino.my_colonia_id();
  v_id  uuid;
  v_cat text;
  v_imp uuid;
  v_estado text;
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;
  IF coalesce(p_monto,0) <= 0 THEN RAISE EXCEPTION 'El monto debe ser mayor a 0.'; END IF;
  IF p_banco_hash IS NULL OR btrim(p_banco_hash) = '' THEN
    RAISE EXCEPTION 'Falta el hash del banco.';
  END IF;

  -- Dedup: esa fila del banco ya se importó (mismo patrón que conciliar_abono)
  IF EXISTS (SELECT 1 FROM vecino.colonia_expenses
              WHERE colonia_id = v_col AND banco_hash = p_banco_hash) THEN
    RETURN jsonb_build_object('ok', false, 'dup', true);
  END IF;

  -- Auto-categoría: keyword más larga (más específica) que aparezca en el concepto
  SELECT m.categoria, m.improvement_id INTO v_cat, v_imp
  FROM vecino.expense_cat_map m
  WHERE m.colonia_id = v_col
    AND position(m.keyword IN upper(coalesce(p_concepto,''))) > 0
  ORDER BY length(m.keyword) DESC, m.veces DESC
  LIMIT 1;

  -- Recurrente conocido sin proyecto → clasificado automático.
  -- Con proyecto propuesto o desconocido → a la bandeja.
  v_estado := CASE WHEN v_cat IS NOT NULL AND v_imp IS NULL
                   THEN 'clasificado' ELSE 'sin_clasificar' END;

  INSERT INTO vecino.colonia_expenses
    (colonia_id, concepto, monto, fecha_pago, categoria, estado,
     concepto_banco, banco_hash, improvement_id, registrado_por)
  VALUES
    (v_col, coalesce(nullif(btrim(p_concepto),''),'Gasto del banco'), p_monto,
     coalesce(p_fecha, current_date), coalesce(v_cat, 'Otros'), v_estado,
     p_concepto, p_banco_hash, v_imp, auth.uid())
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id,
                            'categoria', coalesce(v_cat,'Otros'),
                            'estado', v_estado,
                            'improvement_id', v_imp);
END $$;
GRANT EXECUTE ON FUNCTION vecino.importar_gasto_banco(date,numeric,text,text) TO authenticated, service_role;

-- --- 5. RPC: clasificar un gasto (razón + categoría + proyecto) + APRENDER ----
-- p_keyword (opcional, lo deriva el cliente del concepto del banco): si viene,
-- el sistema recuerda proveedor→categoría(→proyecto) para autosugerir después.
CREATE OR REPLACE FUNCTION vecino.clasificar_gasto(
  p_id             uuid,
  p_concepto       text,
  p_categoria      text,
  p_improvement_id uuid DEFAULT NULL,
  p_descripcion    text DEFAULT NULL,
  p_keyword        text DEFAULT NULL,
  p_archivo_url    text DEFAULT NULL
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
GRANT EXECUTE ON FUNCTION vecino.clasificar_gasto(uuid,text,text,uuid,text,text,text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
