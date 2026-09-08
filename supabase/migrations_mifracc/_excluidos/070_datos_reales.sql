-- TODO(mifracc): pendiente de una colonia demo sintética. Esta siembra venía
-- originalmente en 070_aviso_privacidad.sql (sección 6, líneas 125-167) y es
-- el Aviso de Privacidad Integral REAL de Villa Catania — texto legal LFPDPPP
-- citado textual, ligado al UUID real de esa colonia. mifracc no tiene esa
-- colonia (ni ninguna real) sembrada, así que el INSERT viola la FK
-- privacy_notices_colonia_id_fkey. Cuando exista una colonia demo en mifracc,
-- reemplazar el UUID de abajo y decidir si se usa este mismo texto legal
-- (revisar si aplica tal cual a un fraccionamiento ficticio) o uno genérico
-- de ejemplo.

INSERT INTO mifracc.privacy_notices (colonia_id, version, titulo, contenido, activo)
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
  SELECT 1 FROM mifracc.privacy_notices
  WHERE colonia_id = 'ce43b59c-529b-4960-8dd7-d975e43ac2fb' AND version = 1
);
