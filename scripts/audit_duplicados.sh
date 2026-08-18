#!/usr/bin/env bash
# Busca el doble conteo del mismo dinero: un abono creado desde el BANCO (sin foto)
# y otro subido por el VECINO (con foto, sin ligar al banco), misma casa, mismo monto,
# dentro de N días. Es la firma exacta del incidente que corrigió la migración 037.
# Uso: scripts/audit_duplicados.sh [dias]   (default 5)
# Solo SELECT — no escribe nada.
#
# ALCANCE (dilo cuando pases la lista): solo caza pares con MONTO IDÉNTICO. Si el vecino
# subió $710 y el banco trae $700, este reporte NO lo ve. Tampoco distingue un pago doble
# legítimo (dos meses) de un duplicado: cada par se revisa a mano.
set -euo pipefail
DIAS="${1:-5}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
set -a; . "$APP_DIR/.env.local"; set +a

SQL="
WITH a AS (
  SELECT t.id, h.numero AS casa, t.monto,
         (t.created_at AT TIME ZONE 'America/Mexico_City')::date AS f,
         t.banco_hash, t.comprobante_url, t.concepto
    FROM vecino.transactions t
    JOIN vecino.houses h  ON h.id = t.house_id
    JOIN vecino.colonias c ON c.id = h.colonia_id
   WHERE c.nombre = 'Villa Catania' AND t.tipo = 'abono' AND t.estado = 'aprobado')
SELECT banco.casa, banco.monto::text AS monto,
       banco.f::text AS fecha_banco, vec.f::text AS fecha_vecino,
       left(banco.concepto, 55) AS concepto_banco,
       banco.id::text AS tx_banco, vec.id::text AS tx_vecino
  FROM a banco
  JOIN a vec ON banco.casa = vec.casa AND banco.monto = vec.monto
            AND banco.id <> vec.id AND abs(banco.f - vec.f) <= $DIAS
 WHERE banco.banco_hash IS NOT NULL AND banco.comprobante_url IS NULL
   AND vec.banco_hash   IS NULL     AND vec.comprobante_url IS NOT NULL
 ORDER BY banco.f DESC"

jq -n --arg q "$SQL" '{query:$q}' \
| curl -sS -X POST "$NEXT_PUBLIC_SUPABASE_URL/pg/query" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Content-Type: application/json" --data-binary @- \
| jq -r 'if length == 0 then "Sin pares sospechosos (ventana '"$DIAS"' días)."
         else (.[] | "casa \(.casa) · $\(.monto) | banco \(.fecha_banco) vs vecino \(.fecha_vecino) | \(.concepto_banco)\n    tx banco  \(.tx_banco)\n    tx vecino \(.tx_vecino)") end'
