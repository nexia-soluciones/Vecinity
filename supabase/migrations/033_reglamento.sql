-- ============================================================
-- VECINITY · 033 — Reglamento consultable + mapeo categoría→artículo
-- schema: vecino · Supabase self-hosted Nexia
--
-- El reglamento interno (Villa Catania 2026) se guarda estructurado por
-- artículo para que: (1) sea consultable en la app, (2) cada categoría de
-- multa apunte al artículo que sanciona, y (3) la resolución oficial que
-- genera la IA cite el TEXTO LITERAL del artículo (sin inventar).
-- El seed de los 113 artículos va en 033b_reglamento_seed.sql.
-- ============================================================

CREATE TABLE IF NOT EXISTS vecino.reglamento (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id      uuid NOT NULL REFERENCES vecino.colonias(id) ON DELETE CASCADE,
  articulo        text NOT NULL,           -- "Artículo 97 sexies" | "Anexo A"
  num             text NOT NULL,           -- "97 sexies" | "Anexo A" (clave de referencia)
  titulo          text,                    -- título del capítulo/anexo
  texto           text NOT NULL,
  capitulo        text,                    -- "VIII" | "Anexos"
  bitacora        text,                    -- nota de asamblea (📌), si aplica
  orden           int  NOT NULL DEFAULT 0,
  activo          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_reglamento_colonia_num
  ON vecino.reglamento (colonia_id, num);
CREATE INDEX IF NOT EXISTS idx_reglamento_colonia ON vecino.reglamento (colonia_id);

-- Cada categoría de multa apunta al artículo que sanciona (nullable: no toda
-- categoría tiene un artículo exacto).
ALTER TABLE vecino.fine_categories
  ADD COLUMN IF NOT EXISTS articulo_id uuid REFERENCES vecino.reglamento(id) ON DELETE SET NULL;

-- ------------------------------------------------------------
-- RLS: el reglamento es público para los vecinos de la colonia (lo consultan);
-- solo el comité lo edita.
-- ------------------------------------------------------------
ALTER TABLE vecino.reglamento ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reglamento_read  ON vecino.reglamento;
DROP POLICY IF EXISTS reglamento_admin ON vecino.reglamento;

CREATE POLICY reglamento_read ON vecino.reglamento FOR SELECT
  USING (colonia_id = vecino.my_colonia_id());
CREATE POLICY reglamento_admin ON vecino.reglamento FOR ALL
  USING (colonia_id = vecino.my_colonia_id() AND vecino.is_admin())
  WITH CHECK (colonia_id = vecino.my_colonia_id() AND vecino.is_admin());

GRANT SELECT ON vecino.reglamento TO authenticated;
GRANT ALL    ON vecino.reglamento TO service_role;

-- Tabla nueva en schema ya expuesto → recargar el cache de PostgREST.
NOTIFY pgrst, 'reload schema';
