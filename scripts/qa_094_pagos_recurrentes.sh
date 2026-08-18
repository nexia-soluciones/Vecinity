#!/usr/bin/env bash
# QA de la migración 094 — pagos recurrentes.
# TODO corre dentro de una transacción con ROLLBACK: no deja rastro en producción.
# Uso: scripts/qa_094_pagos_recurrentes.sh [--mutar <n>]
#
# Mutaciones disponibles (para comprobar que las pruebas SÍ muerden):
#   1  quita el candado de frescura  → la prueba 3 debe ponerse en ROJO
#   2  quita el conteo de recibos    → la prueba 4 debe ponerse en ROJO
#   3  quita el motivo obligatorio   → la prueba 6 debe ponerse en ROJO
set -euo pipefail
if [[ "${1:-}" == "--mutar" ]]; then MUT="${2:-0}"; else MUT=0; fi   # con set -e, un && suelto aborta
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
set -a; . "$APP_DIR/.env.local"; set +a

COMITE='087b584a-469b-4787-abb5-9c2e2fbda315'   # José Miguel Rivera Rendón (rol comite, Villa Catania)

# La mutación REDEFINE la función dentro de la transacción (el ROLLBACK la deshace).
# Se construye a partir de la migración: si el texto que busca ya no está, aborta.
MUTACION=""
if [[ "$MUT" != "0" ]]; then
  MUTACION="$(python3 - "$MUT" "$APP_DIR/supabase/migrations/094_pagos_recurrentes.sql" <<'PYMUT'
import sys, re
mut, ruta = sys.argv[1], sys.argv[2]
sql = open(ruta).read()

def extraer(nombre):
    i = sql.index("CREATE OR REPLACE FUNCTION vecino." + nombre)
    j = sql.index("$$;", sql.index("AS $$", i) + 5) + 3   # las funciones cierran con END $$;
    return sql[i:j]

PATCHES = {
    # 1 — quita el candado de frescura → la prueba 3 debe ponerse en ROJO
    "1": ("_recurring_estado",
          "IF estado = 'vencido' AND (v_cob IS NULL OR proximo_esperado + b.gracia_dias > v_cob) THEN\n      estado := 'sin_dato';\n    END IF;",
          "-- MUTADO: sin candado de frescura"),
    # 2 — el techo del match vuelve a ser estricto → la prueba 5 (pago doble) en ROJO
    "2": ("_recurring_estado",
          "AND (b.monto_max IS NULL OR m.monto <= b.monto_max * 2.5)",
          "AND (b.monto_max IS NULL OR m.monto <= b.monto_max)"),
    # 3 — 'incompleto' vuelve a aplicar también al pago manual → la prueba 7 en ROJO
    "3": ("_recurring_estado",
          "IF estado = 'al_dia' AND origen = 'banco'",
          "IF estado = 'al_dia' AND ultimo_pago IS NOT NULL"),
    # 4 — quita el motivo obligatorio → la prueba 6 en ROJO
    "4": ("recurring_bill_marcar_pagado",
          "IF coalesce(btrim(p_motivo),'') = '' THEN\n    RAISE EXCEPTION 'Escribe por qué lo marcas pagado (efectivo, otra cuenta, etc.).';\n  END IF;",
          "-- MUTADO: sin motivo obligatorio"),
}
if mut not in PATCHES:
    sys.exit("Mutación desconocida: " + mut)
fn, viejo, nuevo = PATCHES[mut]
cuerpo = extraer(fn)
if viejo not in cuerpo:
    sys.exit("La mutación %s no encontró su texto en %s: el código cambió, revisa la mutación." % (mut, fn))
print(cuerpo.replace(viejo, nuevo))
PYMUT
)"
  echo "⚠️  MUTACIÓN $MUT aplicada — se espera que alguna prueba salga en ROJO."
fi

TMP="$(mktemp -t qa094)"
cat > "$TMP" <<'EOF'
BEGIN;
CREATE TEMP TABLE qa (n int, prueba text, esperado text, obtenido text, ok boolean) ON COMMIT DROP;
GRANT ALL ON qa TO authenticated;   -- las pruebas 6 y 7 corren como el comité real

-- Colonia desechable: no toca datos reales.
INSERT INTO vecino.colonias (id, nombre, slug) VALUES ('11111111-1111-1111-1111-111111111111','QA094','qa094') ON CONFLICT DO NOTHING;

-- Estado de cuenta simulado: cubre del 1-jun a HOY.
INSERT INTO vecino.bank_movs (colonia_id, fecha, tipo, monto, concepto, banco_hash, estado)
VALUES ('11111111-1111-1111-1111-111111111111', current_date - 78, 'cargo', 1, 'QA APERTURA', 'qa-open', 'pendiente');

INSERT INTO vecino.recurring_bills (colonia_id, nombre, categoria, patron, periodicidad, cargos_por_periodo, monto_min, monto_max, gracia_dias, aviso_dias_antes)
VALUES
 ('11111111-1111-1111-1111-111111111111','QA al dia',        'QA','QATIME',  'mensual',1, 100,1000, 3,3),
 ('11111111-1111-1111-1111-111111111111','QA vencido',       'QA','QALATE',  'mensual',1, 100,1000, 3,3),
 ('11111111-1111-1111-1111-111111111111','QA sin cobertura', 'QA','QAFRESH', 'mensual',1, 100,1000, 3,3),
 ('11111111-1111-1111-1111-111111111111','QA dos recibos',   'QA','QATWO',   'mensual',2, 100,1000, 3,3),
 ('11111111-1111-1111-1111-111111111111','QA doble',         'QA','QADOUBLE','mensual',1, 100,1000, 3,3);

-- Pagos simulados
INSERT INTO vecino.bank_movs (colonia_id, fecha, tipo, monto, concepto, banco_hash, estado) VALUES
 ('11111111-1111-1111-1111-111111111111', current_date - 2,  'cargo', 500, 'QATIME PAGO',   'qa-1','pendiente'),
 ('11111111-1111-1111-1111-111111111111', current_date - 45, 'cargo', 500, 'QALATE PAGO',   'qa-2','pendiente'),
 ('11111111-1111-1111-1111-111111111111', current_date - 3,  'cargo', 500, 'QATWO RECIBO A','qa-4','pendiente'),
 ('11111111-1111-1111-1111-111111111111', current_date - 40, 'cargo', 1400, 'QADOUBLE PAGO', 'qa-5','pendiente');
-- 'QA sin cobertura' y 'QA dos recibos' (2o recibo) a propósito SIN cargo.

__MUTACION__

-- 1) Pago reciente → al día
INSERT INTO qa SELECT 1,'pago reciente = al_dia','al_dia', estado, estado='al_dia'
  FROM vecino._recurring_estado('11111111-1111-1111-1111-111111111111') WHERE nombre='QA al dia';

-- 2) Pago viejo y el estado de cuenta llega a hoy → vencido de verdad
INSERT INTO qa SELECT 2,'pago viejo con cobertura = vencido','vencido', estado, estado='vencido'
  FROM vecino._recurring_estado('11111111-1111-1111-1111-111111111111') WHERE nombre='QA vencido';

-- 3) EL CANDADO: nunca hubo cargo, pero el vencimiento cae DESPUÉS de donde llega
--    el estado de cuenta → no se puede afirmar impago.
UPDATE vecino.bank_movs SET fecha = current_date - 60
 WHERE colonia_id='11111111-1111-1111-1111-111111111111' AND banco_hash='qa-open';
DELETE FROM vecino.bank_movs
 WHERE colonia_id='11111111-1111-1111-1111-111111111111' AND fecha > current_date - 55;
INSERT INTO qa SELECT 3,'sin cobertura NO dice vencido','sin_dato', estado, estado='sin_dato'
  FROM vecino._recurring_estado('11111111-1111-1111-1111-111111111111') WHERE nombre='QA sin cobertura';

-- Restablece el escenario para las que siguen
INSERT INTO vecino.bank_movs (colonia_id, fecha, tipo, monto, concepto, banco_hash, estado) VALUES
 ('11111111-1111-1111-1111-111111111111', current_date, 'cargo', 1, 'QA CIERRE', 'qa-close','pendiente'),
 ('11111111-1111-1111-1111-111111111111', current_date - 3, 'cargo', 500, 'QATWO RECIBO A','qa-4b','pendiente'),
 ('11111111-1111-1111-1111-111111111111', current_date - 40,'cargo', 1400, 'QADOUBLE PAGO','qa-5b','pendiente');

-- 4) Llegó 1 de 2 recibos → incompleto (CFE y JUMAPA son así)
INSERT INTO qa SELECT 4,'1 de 2 recibos = incompleto','incompleto', estado, estado='incompleto'
  FROM vecino._recurring_estado('11111111-1111-1111-1111-111111111111') WHERE nombre='QA dos recibos';

-- 5) Cargo casi al doble del máximo → marca pago doble
INSERT INTO qa SELECT 5,'cargo doble se marca','pago_doble', coalesce(alerta_monto,'(nada)'), alerta_monto='pago_doble'
  FROM vecino._recurring_estado('11111111-1111-1111-1111-111111111111') WHERE nombre='QA doble';

-- 6) Marcar pagado SIN motivo → tiene que fallar (se simula al comité real)
SELECT set_config('request.jwt.claims', json_build_object('sub','__COMITE__','role','authenticated')::text, true);
SELECT set_config('role','authenticated', true);
DO $$
DECLARE v_bill uuid; v_err text := '(no falló)';
BEGIN
  SELECT id INTO v_bill FROM vecino.recurring_bills WHERE nombre='Telmex' LIMIT 1;
  BEGIN
    PERFORM vecino.recurring_bill_marcar_pagado(v_bill, current_date, '   ');
  EXCEPTION WHEN OTHERS THEN v_err := 'rechazado';
  END;
  INSERT INTO qa VALUES (6,'marcar pagado sin motivo se rechaza','rechazado', v_err, v_err='rechazado');
END $$;

-- 7) Marcar pagado CON motivo → el servicio deja de estar vencido
DO $$
DECLARE v_bill uuid; v_est text;
BEGIN
  SELECT id INTO v_bill FROM vecino.recurring_bills WHERE nombre='Telmex' LIMIT 1;
  PERFORM vecino.recurring_bill_marcar_pagado(v_bill, current_date, 'QA: pagado en efectivo');
  SELECT estado INTO v_est FROM vecino.pagos_recurrentes_estado() WHERE bill_id = v_bill;
  INSERT INTO qa VALUES (7,'marcado a mano deja de estar vencido','al_dia', v_est, v_est='al_dia');
END $$;
RESET role;

-- 8) El cron en seco no manda nada y no marca avisos
DO $$
DECLARE v jsonb; v_antes int; v_despues int;
BEGIN
  SELECT count(*) INTO v_antes FROM vecino.recurring_bill_events WHERE ultimo_aviso_at IS NOT NULL;
  v := vecino.cron_pagos_recurrentes('vcn_cron_7Kp2qXm9', true);
  SELECT count(*) INTO v_despues FROM vecino.recurring_bill_events WHERE ultimo_aviso_at IS NOT NULL;
  INSERT INTO qa VALUES (8,'cron en seco no marca avisos', v_antes::text, v_despues::text, v_antes = v_despues);
END $$;

-- 9) Token malo → rechazo
DO $$
DECLARE v_err text := '(no falló)';
BEGIN
  BEGIN PERFORM vecino.cron_pagos_recurrentes('token-malo', true);
  EXCEPTION WHEN OTHERS THEN v_err := 'rechazado'; END;
  INSERT INTO qa VALUES (9,'cron con token malo se rechaza','rechazado', v_err, v_err='rechazado');
END $$;

SELECT n, prueba, esperado, obtenido, ok FROM qa ORDER BY n;
ROLLBACK;
EOF

# Sustituciones (el heredoc va citado para que el SQL llegue literal)
python3 - "$TMP" "$COMITE" "$MUTACION" <<'PY'
import sys
ruta, comite, mutacion = sys.argv[1], sys.argv[2], sys.argv[3]
sql = open(ruta).read().replace("__COMITE__", comite).replace("__MUTACION__", mutacion)
open(ruta, "w").write(sql)
PY

jq -n --rawfile q "$TMP" '{query:$q}' \
| curl -sS -X POST "$NEXT_PUBLIC_SUPABASE_URL/pg/query" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Content-Type: application/json" --data-binary @- \
| jq -r 'if type=="object" and has("error") then "ERROR SQL: \(.error)"
         else (.[] | "\(if .ok then "✅" else "❌" end) \(.n). \(.prueba) — esperado \(.esperado), obtenido \(.obtenido)") end'

rm -f "$TMP"
