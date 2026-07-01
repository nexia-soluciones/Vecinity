-- 031_comunicados.sql — Zona de comunicados (comité/Caty → residentes)
-- =============================================================================
-- Mensajes del comité (o de "Caty") a los residentes. Dos modos:
--   · house_id NULL  → público (toda la colonia).
--   · house_id set   → dirigido (solo esa casa; privado por RLS).
-- Push opcional por Telegram (a quien tenga chat ligado). Reusa tg_send.
-- =============================================================================

CREATE TABLE IF NOT EXISTS vecino.comunicados (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id        uuid NOT NULL REFERENCES vecino.colonias(id) ON DELETE CASCADE,
  house_id          uuid REFERENCES vecino.houses(id) ON DELETE CASCADE,  -- NULL = público
  titulo            text NOT NULL,
  mensaje           text NOT NULL,
  autor             text NOT NULL DEFAULT 'comite' CHECK (autor IN ('comite','caty')),
  verificado_comite boolean NOT NULL DEFAULT false,
  tipo              text NOT NULL DEFAULT 'aviso' CHECK (tipo IN ('aviso','discrepancia','cobro')),
  leido_at          timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid
);
CREATE INDEX IF NOT EXISTS idx_comunicados_colonia ON vecino.comunicados(colonia_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comunicados_house ON vecino.comunicados(house_id) WHERE house_id IS NOT NULL;

ALTER TABLE vecino.comunicados ENABLE ROW LEVEL SECURITY;

-- Lectura: el residente ve los públicos de su colonia + los dirigidos a su casa; el comité ve todos.
DROP POLICY IF EXISTS comunicados_read ON vecino.comunicados;
CREATE POLICY comunicados_read ON vecino.comunicados FOR SELECT USING (
  colonia_id = vecino.my_colonia_id()
  AND (house_id IS NULL OR house_id = vecino.my_house_id() OR vecino.is_admin())
);

-- Escritura directa: solo admin (además hay RPC). Update para marcar leído va por RPC.
DROP POLICY IF EXISTS comunicados_admin ON vecino.comunicados;
CREATE POLICY comunicados_admin ON vecino.comunicados FOR ALL USING (
  colonia_id = vecino.my_colonia_id() AND vecino.is_admin()
) WITH CHECK (colonia_id = vecino.my_colonia_id() AND vecino.is_admin());

GRANT SELECT ON vecino.comunicados TO authenticated;
GRANT ALL ON vecino.comunicados TO service_role;

-- Crear comunicado (+ push Telegram a quien tenga chat ligado).
CREATE OR REPLACE FUNCTION vecino.crear_comunicado(
  p_house_id uuid,
  p_titulo text,
  p_mensaje text,
  p_autor text DEFAULT 'comite',
  p_verificado boolean DEFAULT false,
  p_tipo text DEFAULT 'aviso'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'vecino', 'auth', 'net'
AS $$
DECLARE
  v_col   uuid := vecino.my_colonia_id();
  v_id    uuid;
  v_msg   text;
  v_firma text;
  v_sent  int := 0;
  rec     record;
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;
  IF coalesce(btrim(p_titulo),'')='' OR coalesce(btrim(p_mensaje),'')='' THEN
    RAISE EXCEPTION 'Título y mensaje son obligatorios.';
  END IF;
  IF p_house_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM vecino.houses WHERE id=p_house_id AND colonia_id=v_col) THEN
    RAISE EXCEPTION 'La casa no es de tu colonia.';
  END IF;

  INSERT INTO vecino.comunicados (colonia_id, house_id, titulo, mensaje, autor, verificado_comite, tipo, created_by)
  VALUES (v_col, p_house_id, btrim(p_titulo), btrim(p_mensaje),
          CASE WHEN p_autor='caty' THEN 'caty' ELSE 'comite' END,
          coalesce(p_verificado,false),
          CASE WHEN p_tipo IN ('aviso','discrepancia','cobro') THEN p_tipo ELSE 'aviso' END,
          auth.uid())
  RETURNING id INTO v_id;

  -- Mensaje Telegram
  v_firma := CASE WHEN p_autor='caty'
    THEN (CASE WHEN p_verificado THEN '_— Caty · revisado por el comité_' ELSE '_— Caty (asistente Vecinity)_' END)
    ELSE '_— Comité Villa Catania_' END;
  v_msg := '*' || btrim(p_titulo) || '*' || E'\n\n' || btrim(p_mensaje) || E'\n\n' || v_firma;

  FOR rec IN
    SELECT p.telegram_chat_id FROM vecino.profiles p
     WHERE p.colonia_id = v_col AND p.telegram_chat_id IS NOT NULL
       AND (p_house_id IS NULL OR p.house_id = p_house_id)
  LOOP
    PERFORM vecino.tg_send(rec.telegram_chat_id, v_msg);
    v_sent := v_sent + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'id', v_id, 'telegram_enviados', v_sent);
END $$;

-- Marcar leído (el residente, sobre lo que le corresponde).
CREATE OR REPLACE FUNCTION vecino.marcar_comunicado_leido(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'vecino', 'auth'
AS $$
DECLARE v_rows int;
BEGIN
  UPDATE vecino.comunicados
     SET leido_at = coalesce(leido_at, now())
   WHERE id = p_id
     AND colonia_id = vecino.my_colonia_id()
     AND (house_id = vecino.my_house_id() OR house_id IS NULL);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('ok', v_rows > 0);
END $$;

GRANT EXECUTE ON FUNCTION vecino.crear_comunicado(uuid,text,text,text,boolean,text) TO authenticated;
GRANT EXECUTE ON FUNCTION vecino.marcar_comunicado_leido(uuid) TO authenticated;
