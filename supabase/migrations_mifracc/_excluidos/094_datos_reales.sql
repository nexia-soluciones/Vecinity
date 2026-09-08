-- TODO(mifracc): pendiente de una colonia demo sintética. Esta siembra venía
-- originalmente en 094_pagos_recurrentes.sql (sección 5, líneas 339-371) y
-- registra 9 gastos recurrentes REALES de Villa Catania (CFE, JUMAPA, Telmex,
-- Basura, Vigilancia, Alberca, Contabilidad, Jardinería, Limpieza) con montos
-- y RFCs reales leídos del histórico de esa colonia. A diferencia de 069/070,
-- esto NO falla al aplicarse (filtra por c.nombre = 'Villa Catania', y como
-- mifracc no tiene ninguna colonia con ese nombre, el INSERT...SELECT no
-- inserta ninguna fila) — se excluye de todas formas porque sigue siendo dato
-- real de producción, no algo que deba vivir en un schema de desarrollo.
-- Cuando exista una colonia demo en mifracc, decidir si se siembra con estos
-- mismos patrones/montos (ajustando el WHERE al nombre de esa colonia) o con
-- datos sintéticos genéricos.

INSERT INTO mifracc.recurring_bills
  (colonia_id, nombre, categoria, patron, periodicidad, cargos_por_periodo,
   monto_min, monto_max, dia_esperado, gracia_dias, aviso_dias_antes, nota)
SELECT c.id, v.nombre, v.categoria, v.patron, v.periodicidad, v.cpp,
       v.mmin, v.mmax, v.dia, v.gracia, v.aviso, v.nota
  FROM mifracc.colonias c,
  (VALUES
    ('CFE (Luz)',      'CFE (Luz)',      'CFEDP|CFE/GUIA|CFE 370814QI0',        'mensual',   2,  1500,  9000,  6, 5, 3,
       'Dos recibos por periodo (dos medidores) pagados el mismo día. Monto muy variable: $2,184-$7,926.'),
    ('JUMAPA (Agua)',  'JUMAPA (Agua)',  'JUMAPA|JMA 840106356',                'mensual',   2,   150, 14000, 27, 5, 3,
       'Dos recibos por periodo. Monto muy variable: $211-$12,191.'),
    ('Telmex',         'Telmex',         'TELMEX|TME 840315KT6',                'mensual',   1,   400,   700,  4, 3, 3,
       'Fijo $549. Un cargo de $1,098 = dos meses juntos (venía atrasado).'),
    ('Basura',         'Basura',         'BASURA',                              'mensual',   1,  3500,  4500, 26, 4, 3,
       'Fijo $4,200 (enero fue $3,900).'),
    ('Vigilancia',     'Vigilancia',     'SPM080307N12|VIGILANCIA|SEGURIDAD',   'mensual',   1, 30000, 45000, 25, 4, 4,
       'Fijo $39,904. El gasto más grande de la colonia.'),
    ('Alberca',        'Alberca',        'GUMH9104139B6|ALBERCA',               'mensual',   1,  5000,  6000,  5, 4, 3,
       'Mantenimiento fijo $5,220.'),
    ('Contabilidad',   'Contabilidad',   'CONTABILIDAD|LAAT890723RQ6',          'mensual',   1,  1700,  1900,  6, 4, 3,
       'Fijo $1,850. El 4-ago pagó junio y julio juntos.'),
    ('Jardinería',     'Jardinería',     'MAOB920416NN0|JARDIN|PODA',           'quincenal', 1,  6500,  7100,  NULL, 4, 3,
       'Corte quincenal $6,960. Los extras (reparaciones, pasto) quedan fuera del rango a propósito.'),
    ('Limpieza',       'Limpieza',       'LIMPIEZA',                            'semanal',   1,   750,   900,  NULL, 3, 2,
       'Fijo $810 por semana.')
  ) AS v(nombre, categoria, patron, periodicidad, cpp, mmin, mmax, dia, gracia, aviso, nota)
 WHERE c.nombre = 'Villa Catania'
ON CONFLICT (colonia_id, nombre) DO NOTHING;
