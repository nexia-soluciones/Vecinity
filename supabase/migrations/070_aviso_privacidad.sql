-- 070: Aviso de Privacidad por colonia — con registro de aceptación (LFPDPPP)
--
-- Multi-tenant: cada colonia publica su aviso (versionado); al entrar a la app,
-- el usuario ve el modal hasta que acepte ("Aceptar ahora"). "Aceptar después"
-- solo pospone (vuelve a aparecer en la siguiente sesión). La aceptación queda
-- registrada con usuario, versión y fecha — y el comité ve el avance.
--
-- Publicar una versión NUEVA (activo=true, version+1) vuelve a pedir aceptación
-- a todos: el status busca aceptación de LA versión activa.

-- 1. Avisos ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vecino.privacy_notices (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colonia_id uuid NOT NULL REFERENCES vecino.colonias(id) ON DELETE CASCADE,
  version    int  NOT NULL DEFAULT 1,
  titulo     text NOT NULL,
  contenido  text NOT NULL,           -- markdown ligero (## secciones)
  activo     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (colonia_id, version)
);
-- Un solo aviso activo por colonia
CREATE UNIQUE INDEX IF NOT EXISTS idx_privacy_notices_activo
  ON vecino.privacy_notices (colonia_id) WHERE activo;

ALTER TABLE vecino.privacy_notices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS privacy_notices_select ON vecino.privacy_notices;
CREATE POLICY privacy_notices_select ON vecino.privacy_notices
  FOR SELECT USING (
    colonia_id IN (SELECT colonia_id FROM vecino.profiles WHERE id = auth.uid())
  );

-- 2. Aceptaciones -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vecino.privacy_acceptances (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_id   uuid NOT NULL REFERENCES vecino.privacy_notices(id) ON DELETE CASCADE,
  profile_id  uuid NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (notice_id, profile_id)
);
ALTER TABLE vecino.privacy_acceptances ENABLE ROW LEVEL SECURITY;
-- Lectura: la propia, o admin/comité de la colonia. Escritura: solo RPC.
DROP POLICY IF EXISTS privacy_acceptances_select ON vecino.privacy_acceptances;
CREATE POLICY privacy_acceptances_select ON vecino.privacy_acceptances
  FOR SELECT USING (
    profile_id = auth.uid()
    OR EXISTS (SELECT 1 FROM vecino.profiles p
               JOIN vecino.privacy_notices n ON n.id = notice_id
               WHERE p.id = auth.uid() AND p.role IN ('admin','comite')
                 AND p.colonia_id = n.colonia_id)
  );

-- 3. RPC: ¿tengo un aviso pendiente? ------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.privacy_status()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE n record;
BEGIN
  SELECT pn.id, pn.titulo, pn.contenido, pn.version INTO n
  FROM vecino.privacy_notices pn
  JOIN vecino.profiles p ON p.colonia_id = pn.colonia_id
  WHERE p.id = auth.uid()
    AND p.approval_status = 'aprobado'
    AND pn.activo
    AND NOT EXISTS (SELECT 1 FROM vecino.privacy_acceptances a
                    WHERE a.notice_id = pn.id AND a.profile_id = auth.uid());
  IF NOT FOUND THEN
    RETURN jsonb_build_object('pendiente', false);
  END IF;
  RETURN jsonb_build_object('pendiente', true, 'id', n.id,
    'titulo', n.titulo, 'contenido', n.contenido, 'version', n.version);
END $$;

-- 4. RPC: aceptar ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.privacy_accept(p_notice_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
BEGIN
  IF NOT EXISTS (
      SELECT 1 FROM vecino.privacy_notices n
      JOIN vecino.profiles p ON p.colonia_id = n.colonia_id
      WHERE n.id = p_notice_id AND n.activo AND p.id = auth.uid()) THEN
    RAISE EXCEPTION 'Aviso no encontrado para tu colonia.';
  END IF;
  INSERT INTO vecino.privacy_acceptances (notice_id, profile_id)
  VALUES (p_notice_id, auth.uid())
  ON CONFLICT (notice_id, profile_id) DO NOTHING;
  RETURN jsonb_build_object('ok', true);
END $$;

-- 5. RPC: avance para el comité --------------------------------------------------------
CREATE OR REPLACE FUNCTION vecino.privacy_report()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = vecino, public AS $$
DECLARE v_col uuid; v_notice record;
BEGIN
  SELECT colonia_id INTO v_col FROM vecino.profiles
   WHERE id = auth.uid() AND role IN ('admin','comite') AND approval_status = 'aprobado';
  IF v_col IS NULL THEN
    RAISE EXCEPTION 'Solo el comité puede ver el avance del aviso de privacidad.';
  END IF;
  SELECT id, version, titulo INTO v_notice
  FROM vecino.privacy_notices WHERE colonia_id = v_col AND activo;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('hay_aviso', false);
  END IF;
  RETURN jsonb_build_object(
    'hay_aviso', true, 'version', v_notice.version, 'titulo', v_notice.titulo,
    'aceptados', (SELECT count(*) FROM vecino.privacy_acceptances
                  WHERE notice_id = v_notice.id),
    'total', (SELECT count(*) FROM vecino.profiles
              WHERE colonia_id = v_col AND approval_status = 'aprobado'),
    'lista', COALESCE((
      SELECT jsonb_agg(to_jsonb(x)) FROM (
        SELECT p.nombre, h.numero AS casa, a.accepted_at
        FROM vecino.privacy_acceptances a
        JOIN vecino.profiles p ON p.id = a.profile_id
        LEFT JOIN vecino.houses h ON h.id = p.house_id
        WHERE a.notice_id = v_notice.id
        ORDER BY a.accepted_at DESC
      ) x), '[]'::jsonb));
END $$;

GRANT EXECUTE ON FUNCTION vecino.privacy_status() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.privacy_accept(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vecino.privacy_report() TO authenticated, service_role;

-- 6. Sembrar el Aviso de Privacidad Integral de Villa Catania ---------------------------
INSERT INTO vecino.privacy_notices (colonia_id, version, titulo, contenido, activo)
SELECT 'ce43b59c-529b-4960-8dd7-d975e43ac2fb', 1,
  'Aviso de Privacidad Integral',
$aviso$## 1. Identidad y Domicilio del Responsable

El Condominio del Fraccionamiento Villa Catania (en adelante, el "Responsable"), ubicado en Celaya, Guanajuato, México, es el responsable del uso, tratamiento y protección de sus datos personales, en estricto cumplimiento de la Ley Federal de Protección de Datos Personales en Posesión de los Particulares (LFPDPPP).

## 2. Datos Personales que se Recabarán

Para cumplir con las finalidades señaladas en el presente aviso, se tratarán las siguientes categorías de datos:

- Datos de identificación y contacto: Nombre completo, firma, número de casa/lote, teléfono particular o celular, y correo electrónico.
- Datos patrimoniales y financieros: Historial y estado de cuenta de cuotas de mantenimiento (saldos y adeudos).
- Datos de control e infraestructura tecnológica: Registros de vehículos (placas, marca, modelo), códigos de identificación de tags RFID, tarjetas de proximidad y registros de auditoría (logs) de accesos vehiculares y peatonales.

## 3. Finalidades del Tratamiento

Los datos personales serán utilizados para las siguientes finalidades primarias, las cuales son necesarias para la existencia, mantenimiento y cumplimiento de la relación jurídica entre el residente/visitante y el Responsable:

- Garantizar la seguridad, vigilancia y control de accesos al condominio.
- Operar, administrar y gestionar el control de entradas y salidas de residentes, visitas y proveedores.
- Gestionar la cobranza, registro y control del pago de cuotas ordinarias, extraordinarias y penalizaciones vigentes aprobadas por la Asamblea.
- Emitir avisos de administración y notificaciones sobre el estado operativo del condominio.

## 4. Transferencia de Datos

Le informamos que el Responsable no vende ni comercializa sus datos. Sin embargo, los datos son transferidos a Nexia Soluciones, en su carácter estricto de Encargado tecnológico, para la prestación de los servicios de infraestructura en la nube, soporte técnico y mantenimiento del software de administración condominal Vecinity. Dicha transferencia se realiza bajo estrictas medidas de seguridad técnica y confidencialidad y no requiere de su consentimiento en términos del artículo 37 de la LFPDPPP.

## 5. Uso de Infraestructura y Herramientas Tecnológicas

Para la operación y almacenamiento de la información, el Encargado utiliza la infraestructura en la nube provista por Supabase, asegurando que los repositorios de datos y bases de datos cuenten con los estándares de cifrado y seguridad de la información adecuados para la protección de los datos.

## 6. Mecanismos para Ejercer los Derechos ARCO

Usted tiene derecho a conocer qué datos personales tenemos de usted, para qué los utilizamos y las condiciones del uso que les damos (Acceso). Asimismo, es su derecho solicitar la corrección de su información personal en caso de que esté desactualizada, sea inexacta o incompleta (Rectificación); que la eliminemos de nuestros registros o bases de datos cuando considere que la misma no está siendo utilizada conforme a los principios, deberes y obligaciones previstas en la normativa (Cancelación); así como oponerse al uso de sus datos personales para fines específicos (Oposición).

Para el ejercicio de cualquiera de los derechos ARCO, usted deberá presentar la solicitud respectiva a través de un correo electrónico dirigido a la Mesa Directiva / Administración en la dirección oficial del comité.$aviso$,
  true
WHERE NOT EXISTS (
  SELECT 1 FROM vecino.privacy_notices
  WHERE colonia_id = 'ce43b59c-529b-4960-8dd7-d975e43ac2fb' AND version = 1
);

NOTIFY pgrst, 'reload schema';
