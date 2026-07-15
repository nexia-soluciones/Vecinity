-- seed_villa_demo.sql — Villa Aurora (DEMO): colonia ficticia para demostraciones
-- de venta. Datos 100% inventados; aislada por RLS (colonia propia) y SIN
-- dispositivo físico (la puerta/cámara real es de Villa Catania — migr. 069).
-- Idempotente: se puede re-correr; usa el slug como ancla.
--
-- Cuentas (auth ya creadas por admin API, metadata app='interno'):
--   vecino.demo@vecinity.app   → residente, casa D-01 (al corriente)
--   comite.demo@vecinity.app   → comité
--   guardia.demo@vecinity.app  → guardia
--   solicitud.demo@vecinity.app→ residente PENDIENTE (para demo de aprobación)

DO $$
DECLARE
  v_col uuid;
  v_zona uuid;
  v_casa uuid;
  v_saldos numeric[] := ARRAY[0, 800, 3200, -500, 1600, 0, 800, 0, 2400, 0];
  i int;
BEGIN
  -- 1. Colonia
  SELECT id INTO v_col FROM vecino.colonias WHERE slug = 'villa-aurora-demo';
  IF v_col IS NULL THEN
    INSERT INTO vecino.colonias (nombre, slug, direccion, cuota_mensual,
      dia_limite_pago, recargo, umbral_suspension_rfid, tope_multa)
    VALUES ('Villa Aurora (DEMO)', 'villa-aurora-demo',
      'Av. Aurora 100, Ciudad Demo', 800, 10, 80, 2400, 2000)
    RETURNING id INTO v_col;
  END IF;

  -- 2. Zona
  SELECT id INTO v_zona FROM vecino.zones WHERE colonia_id = v_col LIMIT 1;
  IF v_zona IS NULL THEN
    INSERT INTO vecino.zones (colonia_id, nombre, codigo, color)
    VALUES (v_col, 'Zona Centro', 'ZC', '#0ea5e9') RETURNING id INTO v_zona;
  END IF;

  -- 3. Casas D-01..D-10 con saldos variados
  FOR i IN 1..10 LOOP
    IF NOT EXISTS (SELECT 1 FROM vecino.houses
                   WHERE colonia_id = v_col AND numero = 'D-' || lpad(i::text, 2, '0')) THEN
      INSERT INTO vecino.houses (colonia_id, zone_id, numero, street,
        propietario, saldo, estatus)
      VALUES (v_col, v_zona, 'D-' || lpad(i::text, 2, '0'), 'Av. Aurora',
        (ARRAY['Valeria Ríos','Marco Peña','Lucía Torres','Andrés Gil',
               'Paola Vega','Diego Lara','Carmen Soto','Raúl Ibarra',
               'Elena Cano','Bruno Díaz'])[i],
        v_saldos[i], CASE WHEN v_saldos[i] > 0 THEN 'con_adeudo'::vecino.estatus_casa ELSE 'al_corriente' END);
    END IF;
  END LOOP;

  -- 4. Perfiles demo (los auth users ya existen)
  SELECT id INTO v_casa FROM vecino.houses WHERE colonia_id = v_col AND numero = 'D-01';
  INSERT INTO vecino.profiles (id, colonia_id, house_id, nombre, email, role, approval_status)
  VALUES
    ('d26da822-1c64-4f8a-96e6-b6a67201725a', v_col, v_casa,
     'Valeria Demo', 'vecino.demo@vecinity.app', 'residente', 'aprobado'),
    ('426e21f0-82e1-4906-a41e-13bd00f91ccc', v_col, NULL,
     'Carlos Demo', 'comite.demo@vecinity.app', 'comite', 'aprobado'),
    ('a5670432-942f-4dda-904d-1289683799e6', v_col, NULL,
     'Gustavo Demo', 'guardia.demo@vecinity.app', 'guardia', 'aprobado')
  ON CONFLICT (id) DO UPDATE SET colonia_id = EXCLUDED.colonia_id,
    house_id = EXCLUDED.house_id, role = EXCLUDED.role,
    approval_status = EXCLUDED.approval_status;

  -- Solicitud pendiente (para demo de aprobación del comité)
  INSERT INTO vecino.profiles (id, colonia_id, house_id, nombre, email, role, approval_status)
  SELECT '89e9903f-1b54-4acf-9b2f-b4299ee2f231', v_col,
         (SELECT id FROM vecino.houses WHERE colonia_id = v_col AND numero = 'D-06'),
         'Sofía Solicitud', 'solicitud.demo@vecinity.app', 'residente', 'pendiente'
  ON CONFLICT (id) DO UPDATE SET approval_status = 'pendiente';

  -- 5. Historial de la casa del vecino demo (D-01): 3 meses cuota+abono, al corriente
  IF NOT EXISTS (SELECT 1 FROM vecino.transactions WHERE colonia_id = v_col) THEN
    FOR i IN REVERSE 3..1 LOOP
      INSERT INTO vecino.transactions (colonia_id, house_id, tipo, monto, concepto, estado, created_at)
      VALUES (v_col, v_casa, 'cargo', 800,
        'Mantenimiento ' || to_char(now() - (i || ' months')::interval, 'YYYY-MM'),
        'aprobado', date_trunc('month', now() - (i || ' months')::interval) + interval '1 day');
      INSERT INTO vecino.transactions (colonia_id, house_id, tipo, monto, concepto, estado, created_at)
      VALUES (v_col, v_casa, 'abono', 800, 'Transferencia SPEI', 'aprobado',
        date_trunc('month', now() - (i || ' months')::interval) + interval '5 days');
    END LOOP;

    -- Casa morosa D-03: 4 cuotas sin pagar (explica su saldo 3,200)
    FOR i IN REVERSE 4..1 LOOP
      INSERT INTO vecino.transactions (colonia_id, house_id, tipo, monto, concepto, estado, created_at)
      SELECT v_col, id, 'cargo', 800,
        'Mantenimiento ' || to_char(now() - (i || ' months')::interval, 'YYYY-MM'),
        'aprobado', date_trunc('month', now() - (i || ' months')::interval) + interval '1 day'
      FROM vecino.houses WHERE colonia_id = v_col AND numero = 'D-03';
    END LOOP;

    -- Abono PENDIENTE de la casa D-02 → bandeja del comité en la demo
    INSERT INTO vecino.transactions (colonia_id, house_id, tipo, monto, concepto, estado)
    SELECT v_col, id, 'abono', 800, 'Depósito en ventanilla (demo)', 'pendiente'
    FROM vecino.houses WHERE colonia_id = v_col AND numero = 'D-02';
  END IF;

  -- 6. Áreas comunes
  IF NOT EXISTS (SELECT 1 FROM vecino.common_areas WHERE colonia_id = v_col) THEN
    INSERT INTO vecino.common_areas (colonia_id, nombre, descripcion, reservable,
      activa, costo, deposito, aprobacion_automatica, hora_apertura, hora_cierre,
      duracion_min_horas, duracion_max_horas, icono, orden)
    VALUES
      (v_col, 'Alberca', 'Uso compartido, sin costo', true, true, 0, 0, true,
       '09:00', '21:00', 1, 4, '🏊', 1),
      (v_col, 'Terraza de eventos', 'Eventos privados con depósito', true, true,
       500, 500, false, '10:00', '23:00', 2, 8, '🌅', 2);
  END IF;

  -- 7. Comunicados
  IF NOT EXISTS (SELECT 1 FROM vecino.comunicados WHERE colonia_id = v_col) THEN
    INSERT INTO vecino.comunicados (colonia_id, titulo, mensaje, autor)
    VALUES
      (v_col, '¡Bienvenidos a Vecinity! 🏡',
       'Villa Aurora ya administra pagos, reservas, visitas y seguridad desde la app. Cualquier duda, el comité está para ayudarte.',
       'comite'),
      (v_col, 'Mantenimiento de la alberca',
       'Este jueves de 8:00 a 12:00 la alberca estará cerrada por limpieza profunda. Gracias por su comprensión.',
       'comite');
  END IF;

  -- 8. Invitación libre para demo de onboarding (código AURORA-08, casa D-08)
  IF NOT EXISTS (SELECT 1 FROM vecino.invitations WHERE token = 'AURORA-08') THEN
    INSERT INTO vecino.invitations (colonia_id, house_id, role, token, expires_at)
    SELECT v_col, id, 'residente', 'AURORA-08', now() + interval '2 years'
    FROM vecino.houses WHERE colonia_id = v_col AND numero = 'D-08';
  END IF;
END $$;

SELECT jsonb_build_object(
  'colonia', (SELECT id FROM vecino.colonias WHERE slug='villa-aurora-demo'),
  'casas', (SELECT count(*) FROM vecino.houses h JOIN vecino.colonias c ON c.id=h.colonia_id WHERE c.slug='villa-aurora-demo'),
  'perfiles', (SELECT count(*) FROM vecino.profiles p JOIN vecino.colonias c ON c.id=p.colonia_id WHERE c.slug='villa-aurora-demo'),
  'movs', (SELECT count(*) FROM vecino.transactions t JOIN vecino.colonias c ON c.id=t.colonia_id WHERE c.slug='villa-aurora-demo'),
  'areas', (SELECT count(*) FROM vecino.common_areas a JOIN vecino.colonias c ON c.id=a.colonia_id WHERE c.slug='villa-aurora-demo'),
  'comunicados', (SELECT count(*) FROM vecino.comunicados m JOIN vecino.colonias c ON c.id=m.colonia_id WHERE c.slug='villa-aurora-demo')
) AS resumen;
