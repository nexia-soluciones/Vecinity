-- 052: Verificación en caseta de la credencial peatonal (QR /r/<profile_id>)
-- Solo guardia/comité/admin pueden verificar. Devuelve lo mínimo necesario.

CREATE OR REPLACE FUNCTION vecino.verificar_credencial(p_profile_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vecino, public AS $$
DECLARE
  v_rol text;
  p vecino.profiles%ROWTYPE;
  v_casa text;
  v_placas jsonb;
  v_entregada boolean;
BEGIN
  SELECT role INTO v_rol FROM vecino.profiles WHERE id = auth.uid();
  IF v_rol IS NULL OR v_rol NOT IN ('guardia','comite','admin') THEN
    RAISE EXCEPTION 'Solo vigilancia o comité pueden verificar credenciales.';
  END IF;

  SELECT * INTO p FROM vecino.profiles
   WHERE id = p_profile_id AND colonia_id = vecino.my_colonia_id();
  IF NOT FOUND THEN
    RETURN jsonb_build_object('valida', false, 'motivo', 'El QR no corresponde a ningún residente de esta colonia.');
  END IF;

  SELECT h.numero INTO v_casa FROM vecino.houses h WHERE h.id = p.house_id;
  SELECT COALESCE(jsonb_agg(ve.placa ORDER BY ve.placa), '[]'::jsonb) INTO v_placas
    FROM vecino.vehicles ve
   WHERE ve.house_id = p.house_id AND ve.estado = 'aprobado' AND ve.placa IS NOT NULL;

  -- ¿La tarjeta fue emitida por el sistema? (informativo para el guardia)
  SELECT EXISTS (
    SELECT 1 FROM vecino.card_requests
     WHERE beneficiario_profile_id = p.id AND tipo = 'peatonal'
       AND estado IN ('impresa','entregada')
  ) INTO v_entregada;

  RETURN jsonb_build_object(
    'valida', (p.is_active AND p.approval_status = 'aprobado'),
    'motivo', CASE WHEN p.is_active AND p.approval_status = 'aprobado' THEN NULL
                   ELSE 'El residente está inactivo o no aprobado.' END,
    'nombre', p.nombre,
    'casa', v_casa,
    'rol', CASE p.role WHEN 'comite' THEN 'Comité' ELSE 'Residente' END,
    'placas', v_placas,
    'tarjeta_emitida', v_entregada
  );
END $$;

GRANT EXECUTE ON FUNCTION vecino.verificar_credencial(uuid) TO authenticated, service_role;
