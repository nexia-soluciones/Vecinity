-- 071 — Consola de operador Nexia (nexia-print-bridge)
-- El operador (Nexia, junto a la Zebra) selecciona QUÉ jobs imprimir en vez de
-- consumir siempre los más viejos, registra reimpresiones y actualiza el stock
-- físico de tarjetas por colonia.
-- RPCs SOLO service_role: las llama el bridge server-side, nunca el navegador.

-- 1. Tomar jobs ESPECÍFICOS (selección del operador). Acepta 'pendiente' y
--    también 'error' (reintento directo desde la consola, sin pasar por el
--    print_retry_job del comité que exige my_colonia_id).
CREATE OR REPLACE FUNCTION vecino.print_take_selected(p_ids uuid[])
RETURNS SETOF vecino.print_jobs LANGUAGE sql SECURITY DEFINER
SET search_path = vecino, public AS $$
  UPDATE vecino.print_jobs
     SET estado = 'imprimiendo', attempts = attempts + 1, taken_at = now()
   WHERE id IN (
     SELECT id FROM vecino.print_jobs
      WHERE id = ANY(p_ids) AND estado IN ('pendiente','error')
      ORDER BY created_at
      LIMIT 50
      FOR UPDATE SKIP LOCKED
   )
  RETURNING *;
$$;

-- 2. Registrar una REIMPRESIÓN de un job ya impreso: gasta otra tarjeta física
--    (descuenta stock) y re-sella printed_at. El render lo hace el bridge con
--    el payload que ya vive en el job.
CREATE OR REPLACE FUNCTION vecino.print_reprint(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, public AS $$
DECLARE
  j vecino.print_jobs%ROWTYPE;
BEGIN
  SELECT * INTO j FROM vecino.print_jobs WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job inexistente.'; END IF;
  IF j.estado <> 'impresa' THEN RAISE EXCEPTION 'Solo se reimprime un job ya impreso.'; END IF;
  UPDATE vecino.print_jobs SET printed_at = now() WHERE id = p_id;
  UPDATE vecino.colonias SET stock_tarjetas = greatest(0, stock_tarjetas - 1)
   WHERE id = j.colonia_id;
  RETURN jsonb_build_object('ok', true);
END $$;

-- 3. Actualizar el stock físico de tarjetas de una colonia (llegaron más).
CREATE OR REPLACE FUNCTION vecino.print_set_stock(p_colonia uuid, p_stock integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, public AS $$
BEGIN
  IF p_stock IS NULL OR p_stock < 0 THEN
    RAISE EXCEPTION 'El stock no puede ser negativo.';
  END IF;
  UPDATE vecino.colonias SET stock_tarjetas = p_stock WHERE id = p_colonia;
  IF NOT FOUND THEN RAISE EXCEPTION 'Colonia inexistente.'; END IF;
  RETURN jsonb_build_object('ok', true, 'stock', p_stock);
END $$;

-- Permisos: solo el bridge (service_role).
REVOKE EXECUTE ON FUNCTION vecino.print_take_selected(uuid[]) FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION vecino.print_reprint(uuid) FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION vecino.print_set_stock(uuid, integer) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION vecino.print_take_selected(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION vecino.print_reprint(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION vecino.print_set_stock(uuid, integer) TO service_role;

NOTIFY pgrst, 'reload schema';
