-- ============================================================
-- VECINITY · 034 — Resolución oficial de multa + anonimato del reportante
-- schema: vecino · Supabase self-hosted Nexia
--
-- Cierra el flujo que pidió Juan (2026-07-02):
--   · El infractor entra a la RESOLUCIÓN OFICIAL desde su estado de cuenta:
--     ve el artículo del reglamento que falló + la foto de evidencia.
--   · NUNCA ve quién lo reportó.
--
-- Tres piezas:
--   1) Columnas de resolución oficial en incident_reports.
--   2) RLS anti-fuga: un residente ya NO puede leer las filas donde es
--      infractor (donde vería reportante_house_id). El detalle lo obtiene
--      por el RPC enmascarado ver_resolucion_multa, que jamás devuelve el
--      reportante. El comité (admin) sigue viendo todo de su colonia.
--   3) Tope de multa CONFIGURABLE: NULL = sin límite (Art. 101 bis Villa
--      Catania: la multa progresiva no tiene tope superior).
-- ============================================================

-- ------------------------------------------------------------
-- 1) Columnas de resolución oficial
-- ------------------------------------------------------------
ALTER TABLE vecino.incident_reports
  ADD COLUMN IF NOT EXISTS resolucion_oficial     text,        -- documento formal (IA) que ve el infractor
  ADD COLUMN IF NOT EXISTS resolucion_generada_at timestamptz,
  ADD COLUMN IF NOT EXISTS articulo_snapshot      text;        -- artículo citado, congelado (inmutable)

-- ------------------------------------------------------------
-- 2) RLS anti-fuga en incident_reports
--    ANTES: FOR SELECT USING (colonia_id = my_colonia_id())  → cualquier
--    residente podía leer reportante_house_id de CUALQUIER fila (incl. donde
--    es infractor). El "anónimo" era solo visual.
--    AHORA: el residente solo lee las filas que ÉL levantó; como infractor
--    no puede leer la fila (usa el RPC enmascarado). El comité ve su colonia.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS incident_reports_read ON vecino.incident_reports;
CREATE POLICY incident_reports_read ON vecino.incident_reports FOR SELECT
  USING (
    (colonia_id = vecino.my_colonia_id() AND vecino.is_admin())
    OR reportante_house_id = vecino.my_house_id()
  );

-- ------------------------------------------------------------
-- RPC: ver_resolucion_multa — detalle para el infractor (o el comité).
-- Enmascara al reportante: el jsonb NUNCA incluye reportante_house_id.
-- Se localiza por el transaction_id del cargo que ve el residente en su
-- estado de cuenta.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.ver_resolucion_multa(p_transaction_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = vecino, auth AS $$
DECLARE
  r   vecino.incident_reports%ROWTYPE;
  a   vecino.reglamento%ROWTYPE;
  v_cat text;
BEGIN
  SELECT * INTO r FROM vecino.incident_reports WHERE transaction_id = p_transaction_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'No existe una multa ligada a ese movimiento.'; END IF;

  -- Solo el infractor de esa casa o el comité de la colonia.
  IF NOT ( r.infractor_house_id = vecino.my_house_id()
           OR (vecino.is_admin() AND r.colonia_id = vecino.my_colonia_id()) ) THEN
    RAISE EXCEPTION 'No tienes acceso a esta resolución.';
  END IF;

  SELECT nombre INTO v_cat FROM vecino.fine_categories WHERE id = r.categoria_id;
  SELECT rg.* INTO a
    FROM vecino.fine_categories fc
    LEFT JOIN vecino.reglamento rg ON rg.id = fc.articulo_id
   WHERE fc.id = r.categoria_id;

  RETURN jsonb_build_object(
    'incident_id',            r.id,
    'categoria',              coalesce(v_cat, 'Incidencia'),
    'estado',                 r.estado,
    'monto',                  r.monto_multa,
    'descripcion',            r.descripcion,
    'evidencia_url',          r.evidencia_url,
    'evidencia_capturada_at', r.evidencia_capturada_at,
    'evidencia_lat',          r.evidencia_lat,
    'evidencia_lng',          r.evidencia_lng,
    'placa',                  coalesce(r.plate_detected, r.placa_reportada),
    'created_at',             r.created_at,
    'resuelto_at',            r.resolved_at,
    'resolucion_oficial',     r.resolucion_oficial,
    'articulo',               a.articulo,
    'articulo_titulo',        a.titulo,
    'articulo_texto',         a.texto,
    'articulo_snapshot',      r.articulo_snapshot
    -- NOTA: reportante_house_id se OMITE deliberadamente. Anonimato del reportante.
  );
END $$;

-- ------------------------------------------------------------
-- RPC: set_resolucion_oficial — la escribe la Server Action (service role)
-- tras generar el texto con IA. Solo service_role puede invocarla (el
-- residente jamás la llama). Es el SISTEMA guardando la resolución.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.set_resolucion_oficial(
  p_incident_id uuid,
  p_texto       text,
  p_articulo    text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino AS $$
DECLARE v_rows int;
BEGIN
  UPDATE vecino.incident_reports
     SET resolucion_oficial = nullif(btrim(p_texto), ''),
         articulo_snapshot  = coalesce(nullif(btrim(p_articulo), ''), articulo_snapshot),
         resolucion_generada_at = now()
   WHERE id = p_incident_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN RAISE EXCEPTION 'La incidencia no existe.'; END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- ------------------------------------------------------------
-- 3) Tope de multa CONFIGURABLE (NULL = sin límite)
-- ------------------------------------------------------------
ALTER TABLE vecino.colonias ALTER COLUMN tope_multa DROP NOT NULL;
ALTER TABLE vecino.colonias ALTER COLUMN tope_multa DROP DEFAULT;
COMMENT ON COLUMN vecino.colonias.tope_multa IS
  'Monto máximo de una multa. NULL = sin límite (multa progresiva sin tope, p.ej. Art. 101 bis Villa Catania).';

-- Villa Catania: sin tope, conforme al Art. 101 bis del reglamento.
UPDATE vecino.colonias SET tope_multa = NULL WHERE id = 'ce43b59c-529b-4960-8dd7-d975e43ac2fb';

-- sugerir_multa: escala por reincidencia; capa SOLO si la villa tiene tope.
CREATE OR REPLACE FUNCTION vecino.sugerir_multa(p_infractor uuid, p_categoria uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = vecino, auth AS $$
  SELECT jsonb_build_object(
    'monto_base', fc.monto_base,
    'reincidencias', reinc.n,
    'tope', tope.t,
    'monto_sugerido',
      CASE WHEN tope.t IS NULL
           THEN fc.monto_base * (1 + reinc.n)
           ELSE LEAST(fc.monto_base * (1 + reinc.n), tope.t) END
  )
  FROM vecino.fine_categories fc
  CROSS JOIN LATERAL (
    SELECT count(*) AS n FROM vecino.incident_reports r
    WHERE r.infractor_house_id = p_infractor
      AND r.categoria_id = p_categoria AND r.estado = 'multa'
  ) reinc
  CROSS JOIN LATERAL (
    SELECT c.tope_multa AS t
    FROM vecino.colonias c WHERE c.id = vecino.my_colonia_id()
  ) tope
  WHERE fc.id = p_categoria
$$;

-- resolver_incidencia: igual que 027, pero el tope se aplica SOLO si NO es NULL.
CREATE OR REPLACE FUNCTION vecino.resolver_incidencia(p_id uuid, p_accion text, p_monto numeric DEFAULT NULL::numeric, p_nota text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'vecino', 'auth'
AS $$
DECLARE
  r      vecino.incident_reports%ROWTYPE;
  v_cat  text;
  v_tx   uuid;
  v_tope numeric;
  v_rows int;
BEGIN
  IF NOT vecino.is_admin() THEN
    RAISE EXCEPTION 'Solo el comité puede resolver incidencias.';
  END IF;
  SELECT * INTO r FROM vecino.incident_reports WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'La incidencia no existe.'; END IF;
  IF r.colonia_id <> vecino.my_colonia_id() THEN
    RAISE EXCEPTION 'La incidencia no es de tu colonia.';
  END IF;
  IF r.estado <> 'pendiente' THEN
    RAISE EXCEPTION 'Esa incidencia ya fue resuelta.';
  END IF;

  IF p_accion = 'multar' THEN
    IF p_monto IS NULL OR p_monto <= 0 THEN
      RAISE EXCEPTION 'Indica el monto de la multa.';
    END IF;
    SELECT tope_multa INTO v_tope FROM vecino.colonias WHERE id = r.colonia_id;
    IF v_tope IS NOT NULL AND p_monto > v_tope THEN
      RAISE EXCEPTION 'La multa no puede exceder el tope de $%.', to_char(v_tope,'FM999G999D00');
    END IF;

    UPDATE vecino.incident_reports SET estado = 'multa'
     WHERE id = p_id AND estado = 'pendiente';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN RAISE EXCEPTION 'Esa incidencia ya fue resuelta.'; END IF;

    SELECT nombre INTO v_cat FROM vecino.fine_categories WHERE id = r.categoria_id;
    INSERT INTO vecino.transactions (colonia_id, house_id, tipo, monto, concepto, estado)
    VALUES (r.colonia_id, r.infractor_house_id, 'cargo', p_monto,
            'Multa: ' || coalesce(v_cat,'Incidencia'), 'aprobado')
    RETURNING id INTO v_tx;
    UPDATE vecino.houses SET saldo = saldo + p_monto WHERE id = r.infractor_house_id;
    UPDATE vecino.houses
       SET estatus = CASE
         WHEN estatus = 'en_convenio' THEN 'en_convenio'::vecino.estatus_casa
         WHEN saldo > 0 THEN 'con_adeudo'::vecino.estatus_casa
         ELSE 'al_corriente'::vecino.estatus_casa END
     WHERE id = r.infractor_house_id;
    UPDATE vecino.incident_reports
       SET monto_multa = p_monto, transaction_id = v_tx,
           resolucion_admin = nullif(btrim(p_nota),''), resolved_at = now(), resolved_by = auth.uid()
     WHERE id = p_id;
    RETURN jsonb_build_object('ok', true, 'estado', 'multa', 'transaction_id', v_tx);

  ELSIF p_accion = 'rechazar' THEN
    UPDATE vecino.incident_reports
       SET estado = 'rechazado', resolucion_admin = nullif(btrim(p_nota),''),
           resolved_at = now(), resolved_by = auth.uid()
     WHERE id = p_id AND estado = 'pendiente';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN RAISE EXCEPTION 'Esa incidencia ya fue resuelta.'; END IF;
    RETURN jsonb_build_object('ok', true, 'estado', 'rechazado');

  ELSE
    RAISE EXCEPTION 'Acción no válida.';
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION vecino.ver_resolucion_multa(uuid)            TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.set_resolucion_oficial(uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION vecino.sugerir_multa(uuid,uuid)              TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.resolver_incidencia(uuid,text,numeric,text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
