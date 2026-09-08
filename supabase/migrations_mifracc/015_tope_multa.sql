-- ============================================================
-- VECINITY · 015 — Tope de multa por reincidencia (configurable por villa)
-- Regla: la multa escala por reincidencia (base × veces+1) pero NUNCA
-- supera el tope de la villa. Default $1,000 (reglamento Villa Catania).
-- ============================================================

ALTER TABLE mifracc.colonias
  ADD COLUMN IF NOT EXISTS tope_multa numeric(10,2) NOT NULL DEFAULT 1000;

COMMENT ON COLUMN mifracc.colonias.tope_multa IS
  'Monto máximo de una multa, sin importar la reincidencia.';

-- ------------------------------------------------------------
-- sugerir_multa: escala por reincidencia, capado al tope de la villa
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mifracc.sugerir_multa(p_infractor uuid, p_categoria uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = mifracc, auth AS $$
  SELECT jsonb_build_object(
    'monto_base', fc.monto_base,
    'reincidencias', reinc.n,
    'tope', tope.t,
    'monto_sugerido', LEAST(fc.monto_base * (1 + reinc.n), tope.t)
  )
  FROM mifracc.fine_categories fc
  CROSS JOIN LATERAL (
    SELECT count(*) AS n FROM mifracc.incident_reports r
    WHERE r.infractor_house_id = p_infractor
      AND r.categoria_id = p_categoria AND r.estado = 'multa'
  ) reinc
  CROSS JOIN LATERAL (
    SELECT COALESCE(c.tope_multa, 1000) AS t
    FROM mifracc.colonias c WHERE c.id = mifracc.my_colonia_id()
  ) tope
  WHERE fc.id = p_categoria
$$;

-- ------------------------------------------------------------
-- resolver_incidencia: igual que 014, pero enforce el tope al multar
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mifracc.resolver_incidencia(
  p_id     uuid,
  p_accion text,
  p_monto  numeric DEFAULT NULL,
  p_nota   text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = mifracc, auth AS $$
DECLARE
  r      mifracc.incident_reports%ROWTYPE;
  v_cat  text;
  v_tx   uuid;
  v_tope numeric;
BEGIN
  IF NOT mifracc.is_admin() THEN
    RAISE EXCEPTION 'Solo el comité puede resolver incidencias.';
  END IF;
  SELECT * INTO r FROM mifracc.incident_reports WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'La incidencia no existe.'; END IF;
  IF r.colonia_id <> mifracc.my_colonia_id() THEN
    RAISE EXCEPTION 'La incidencia no es de tu colonia.';
  END IF;
  IF r.estado <> 'pendiente' THEN
    RAISE EXCEPTION 'Esa incidencia ya fue resuelta.';
  END IF;

  IF p_accion = 'multar' THEN
    IF p_monto IS NULL OR p_monto <= 0 THEN
      RAISE EXCEPTION 'Indica el monto de la multa.';
    END IF;
    SELECT COALESCE(tope_multa, 1000) INTO v_tope FROM mifracc.colonias WHERE id = r.colonia_id;
    IF p_monto > v_tope THEN
      RAISE EXCEPTION 'La multa no puede exceder el tope de $%.', to_char(v_tope,'FM999G999D00');
    END IF;
    SELECT nombre INTO v_cat FROM mifracc.fine_categories WHERE id = r.categoria_id;
    INSERT INTO mifracc.transactions (colonia_id, house_id, tipo, monto, concepto, estado)
    VALUES (r.colonia_id, r.infractor_house_id, 'cargo', p_monto,
            'Multa: ' || coalesce(v_cat,'Incidencia'), 'aprobado')
    RETURNING id INTO v_tx;
    UPDATE mifracc.houses SET saldo = saldo + p_monto WHERE id = r.infractor_house_id;
    UPDATE mifracc.houses
       SET estatus = CASE
         WHEN estatus = 'en_convenio' THEN 'en_convenio'::mifracc.estatus_casa
         WHEN saldo > 0 THEN 'con_adeudo'::mifracc.estatus_casa
         ELSE 'al_corriente'::mifracc.estatus_casa END
     WHERE id = r.infractor_house_id;
    UPDATE mifracc.incident_reports
       SET estado = 'multa', monto_multa = p_monto, transaction_id = v_tx,
           resolucion_admin = nullif(btrim(p_nota),''), resolved_at = now(), resolved_by = auth.uid()
     WHERE id = p_id;
    RETURN jsonb_build_object('ok', true, 'estado', 'multa', 'transaction_id', v_tx);

  ELSIF p_accion = 'rechazar' THEN
    UPDATE mifracc.incident_reports
       SET estado = 'rechazado', resolucion_admin = nullif(btrim(p_nota),''),
           resolved_at = now(), resolved_by = auth.uid()
     WHERE id = p_id;
    RETURN jsonb_build_object('ok', true, 'estado', 'rechazado');

  ELSE
    RAISE EXCEPTION 'Acción no válida.';
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION mifracc.sugerir_multa(uuid,uuid)                     TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION mifracc.resolver_incidencia(uuid,text,numeric,text)  TO authenticated, service_role;
