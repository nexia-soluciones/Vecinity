-- =============================================================================
-- VECINITY · 047 — Mejor búsqueda de reglamento para Caty
-- schema: vecino · Supabase self-hosted Nexia
--
-- Con el reglamento completo ingestado (114 registros, Consolidado 2026) el
-- fallback ILIKE devolvía 6 filas SIN ranking (orden arbitrario). Ahora rankea
-- por cuántas palabras de la pregunta pegan en cada artículo. La expansión de
-- sinónimos (perro→mascota/animales, etc.) vive en Caty (caty_bot.js).
-- =============================================================================

CREATE OR REPLACE FUNCTION vecino.bot_reglamento_buscar(p_token text, p_chat text, p_q text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE p vecino.profiles%ROWTYPE; v jsonb;
BEGIN
  p := vecino._bot_perfil(p_token, p_chat);
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'articulo', r.articulo, 'titulo', r.titulo,
           'texto', left(r.texto, 1400))), '[]'::jsonb)
    INTO v
    FROM (
      SELECT * FROM vecino.reglamento
       WHERE colonia_id = p.colonia_id AND activo
         AND to_tsvector('spanish', coalesce(titulo,'') || ' ' || texto)
             @@ plainto_tsquery('spanish', p_q)
       ORDER BY ts_rank(to_tsvector('spanish', coalesce(titulo,'') || ' ' || texto),
                        plainto_tsquery('spanish', p_q)) DESC
       LIMIT 6
    ) r;
  -- respaldo: sin match FTS (AND estricto), rankear por # de palabras que pegan
  IF v = '[]'::jsonb THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'articulo', r.articulo, 'titulo', r.titulo,
             'texto', left(r.texto, 1400))), '[]'::jsonb)
      INTO v
      FROM (
        SELECT rg.articulo, rg.titulo, rg.texto, count(*) AS hits
          FROM vecino.reglamento rg,
               unnest(regexp_split_to_array(lower(p_q), '[^a-záéíóúüñ0-9]+')) w
         WHERE rg.colonia_id = p.colonia_id AND rg.activo
           AND length(w) > 3 AND (rg.texto ILIKE '%'||w||'%' OR rg.titulo ILIKE '%'||w||'%')
         GROUP BY rg.id, rg.articulo, rg.titulo, rg.texto, rg.orden
         ORDER BY hits DESC, rg.orden
         LIMIT 6
      ) r;
  END IF;
  RETURN jsonb_build_object('ok', true, 'articulos', v);
END $$;

NOTIFY pgrst, 'reload schema';
