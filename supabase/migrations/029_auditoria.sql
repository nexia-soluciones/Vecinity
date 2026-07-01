-- 029_auditoria.sql — Auditoría de abonos duplicados (validar administración histórica)
-- =============================================================================
-- Lista abonos que parecen contados dos veces (misma casa, mismo monto, mismo día,
-- mismo concepto) para que el comité los revise. Y una función para corregir uno
-- confirmado (borra el abono extra y revierte su efecto en el saldo).
-- Ambas gateadas por is_admin y por colonia. Solo lectura hasta que el comité decide.
-- =============================================================================

-- Lista de grupos duplicados de la colonia del que consulta.
CREATE OR REPLACE FUNCTION vecino.auditoria_abonos_duplicados()
RETURNS TABLE(casa text, concepto text, monto numeric, fecha date, veces bigint, ids uuid[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'vecino', 'auth'
AS $$
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;
  RETURN QUERY
    SELECT h.numero::text, t.concepto, t.monto,
           (t.created_at AT TIME ZONE 'America/Mexico_City')::date,
           count(*), array_agg(t.id ORDER BY t.created_at)
    FROM vecino.transactions t
    JOIN vecino.houses h ON h.id = t.house_id
    WHERE t.tipo = 'abono' AND t.estado = 'aprobado'
      AND h.colonia_id = vecino.my_colonia_id()
    GROUP BY h.numero, t.concepto, t.monto, (t.created_at AT TIME ZONE 'America/Mexico_City')::date
    HAVING count(*) > 1
    ORDER BY count(*) DESC, h.numero;
END $$;

-- Corrige un duplicado confirmado: borra ese abono y revierte su efecto en el saldo.
-- (Un abono aprobado bajó el saldo −monto; al borrarlo se le devuelve +monto a la deuda.)
CREATE OR REPLACE FUNCTION vecino.corregir_abono_duplicado(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'vecino', 'auth'
AS $$
DECLARE t vecino.transactions%ROWTYPE;
BEGIN
  IF NOT vecino.is_admin() THEN RAISE EXCEPTION 'Solo el comité.'; END IF;
  SELECT * INTO t FROM vecino.transactions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'La transacción no existe.'; END IF;
  IF t.colonia_id <> vecino.my_colonia_id() THEN RAISE EXCEPTION 'No es de tu colonia.'; END IF;
  IF t.tipo <> 'abono' THEN RAISE EXCEPTION 'Solo se pueden corregir abonos.'; END IF;

  IF t.estado = 'aprobado' THEN
    UPDATE vecino.houses SET saldo = saldo + t.monto WHERE id = t.house_id;
    UPDATE vecino.houses
       SET estatus = CASE
         WHEN estatus = 'en_convenio' THEN 'en_convenio'::vecino.estatus_casa
         WHEN saldo > 0 THEN 'con_adeudo'::vecino.estatus_casa
         ELSE 'al_corriente'::vecino.estatus_casa END
     WHERE id = t.house_id;
  END IF;

  DELETE FROM vecino.transactions WHERE id = p_id;
  RETURN jsonb_build_object('ok', true);
END $$;

GRANT EXECUTE ON FUNCTION vecino.auditoria_abonos_duplicados() TO authenticated;
GRANT EXECUTE ON FUNCTION vecino.corregir_abono_duplicado(uuid) TO authenticated;
