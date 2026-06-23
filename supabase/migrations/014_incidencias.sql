-- ============================================================
-- VECINITY · 014 — Incidencias / multas (reporte + resolución comité)
-- schema: vecino · Supabase self-hosted Nexia
--
-- Paridad del Django viejo (incident_reports: 131 pendientes reales).
-- Residente reporta contra otra casa (infractor resuelto por casa o PLACA).
-- Comité multa (crea CARGO aprobado + ajusta saldo) o rechaza. El monto
-- sugerido escala por reincidencia: monto_base × (multas previas + 1).
-- Bucket Storage `vecino-evidencias` creado aparte (014b).
-- ============================================================

-- ------------------------------------------------------------
-- RPC: sugerir multa (monto_base × reincidencia)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.sugerir_multa(p_infractor uuid, p_categoria uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = vecino, auth AS $$
  SELECT jsonb_build_object(
    'monto_base', fc.monto_base,
    'reincidencias', (
      SELECT count(*) FROM vecino.incident_reports r
      WHERE r.infractor_house_id = p_infractor
        AND r.categoria_id = p_categoria AND r.estado = 'multa'
    ),
    'monto_sugerido', fc.monto_base * (1 + (
      SELECT count(*) FROM vecino.incident_reports r
      WHERE r.infractor_house_id = p_infractor
        AND r.categoria_id = p_categoria AND r.estado = 'multa'
    ))
  )
  FROM vecino.fine_categories fc WHERE fc.id = p_categoria
$$;

-- ------------------------------------------------------------
-- RPC: reportar incidencia (residente). Infractor por casa (resuelto
-- en el cliente, también desde placa). Estado 'pendiente'.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.reportar_incidencia(
  p_infractor   uuid,
  p_categoria   uuid,
  p_descripcion text DEFAULT NULL,
  p_evidencia_url text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE
  v_col uuid := vecino.my_colonia_id();
  v_id  uuid;
BEGIN
  IF v_col IS NULL THEN RAISE EXCEPTION 'Tu perfil no está ligado a una colonia.'; END IF;
  IF p_infractor IS NULL THEN RAISE EXCEPTION 'Indica la casa infractora (número o placa).'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vecino.houses WHERE id = p_infractor AND colonia_id = v_col) THEN
    RAISE EXCEPTION 'La casa infractora no pertenece a tu colonia.';
  END IF;

  INSERT INTO vecino.incident_reports
    (colonia_id, reportante_house_id, infractor_house_id, categoria_id, descripcion, evidencia_url, estado)
  VALUES
    (v_col, vecino.my_house_id(), p_infractor, p_categoria, nullif(btrim(p_descripcion),''), p_evidencia_url, 'pendiente')
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

-- ------------------------------------------------------------
-- RPC: resolver incidencia (comité) — multar o rechazar
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.resolver_incidencia(
  p_id     uuid,
  p_accion text,            -- 'multar' | 'rechazar'
  p_monto  numeric DEFAULT NULL,
  p_nota   text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, auth AS $$
DECLARE
  r       vecino.incident_reports%ROWTYPE;
  v_cat   text;
  v_tx    uuid;
BEGIN
  IF NOT vecino.is_admin() THEN
    RAISE EXCEPTION 'Solo el comité puede resolver incidencias.';
  END IF;
  SELECT * INTO r FROM vecino.incident_reports WHERE id = p_id;
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
    SELECT nombre INTO v_cat FROM vecino.fine_categories WHERE id = r.categoria_id;
    -- CARGO aprobado ligado a la multa
    INSERT INTO vecino.transactions (colonia_id, house_id, tipo, monto, concepto, estado)
    VALUES (r.colonia_id, r.infractor_house_id, 'cargo', p_monto,
            'Multa: ' || coalesce(v_cat,'Incidencia'), 'aprobado')
    RETURNING id INTO v_tx;
    -- ajustar saldo + estatus de la casa infractora
    UPDATE vecino.houses SET saldo = saldo + p_monto WHERE id = r.infractor_house_id;
    UPDATE vecino.houses
       SET estatus = CASE
         WHEN estatus = 'en_convenio' THEN 'en_convenio'::vecino.estatus_casa
         WHEN saldo > 0 THEN 'con_adeudo'::vecino.estatus_casa
         ELSE 'al_corriente'::vecino.estatus_casa END
     WHERE id = r.infractor_house_id;
    -- cerrar la incidencia
    UPDATE vecino.incident_reports
       SET estado = 'multa', monto_multa = p_monto, transaction_id = v_tx,
           resolucion_admin = nullif(btrim(p_nota),''), resolved_at = now(), resolved_by = auth.uid()
     WHERE id = p_id;
    RETURN jsonb_build_object('ok', true, 'estado', 'multa', 'transaction_id', v_tx);

  ELSIF p_accion = 'rechazar' THEN
    UPDATE vecino.incident_reports
       SET estado = 'rechazado', resolucion_admin = nullif(btrim(p_nota),''),
           resolved_at = now(), resolved_by = auth.uid()
     WHERE id = p_id;
    RETURN jsonb_build_object('ok', true, 'estado', 'rechazado');

  ELSE
    RAISE EXCEPTION 'Acción no válida.';
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION vecino.sugerir_multa(uuid,uuid)                     TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.reportar_incidencia(uuid,uuid,text,text)     TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.resolver_incidencia(uuid,text,numeric,text)  TO authenticated, service_role;
