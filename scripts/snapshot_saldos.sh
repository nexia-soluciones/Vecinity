#!/usr/bin/env bash
# Foto del estado de saldos por casa (read-only) — Vecinity
# Uso:  scripts/snapshot_saldos.sh <etiqueta>       ej: antes | despues
# Sale: docs/snapshots/saldos_<etiqueta>_<sello>.json  (+ .csv)
# NO escribe nada en la BD. Solo SELECT.
set -euo pipefail

ETIQUETA="${1:-}"
if [[ -z "$ETIQUETA" ]]; then echo "Uso: $0 <etiqueta>   (ej: antes, despues)"; exit 1; fi

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
set -a; . "$APP_DIR/.env.local"; set +a

pg() {  # $1 = SQL (una sola sentencia que devuelve filas)
  jq -n --arg q "$1" '{query:$q}' | curl -sS -X POST "$NEXT_PUBLIC_SUPABASE_URL/pg/query" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Content-Type: application/json" --data-binary @-
}

# Sello de hora tomado de la BD (corre en UTC) convertido a hora local.
SELLO_JSON=$(pg "SELECT to_char(now() AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI:SS') AS local,
                        to_char(now(),'YYYY-MM-DD HH24:MI:SS') AS utc")
SELLO_LOCAL=$(echo "$SELLO_JSON" | jq -r '.[0].local')
STAMP=$(echo "$SELLO_LOCAL" | tr -d ':-' | tr ' ' '-' | cut -c1-13)

CASAS=$(pg "SELECT c.nombre AS colonia, h.numero AS casa, h.propietario, h.saldo::text AS saldo,
                   h.estatus::text AS estatus, h.id::text AS house_id,
                   (SELECT count(*) FROM vecino.transactions t WHERE t.house_id = h.id) AS n_tx,
                   (SELECT count(*) FROM vecino.transactions t WHERE t.house_id = h.id AND t.estado::text = 'pendiente') AS n_tx_pendientes,
                   (SELECT max(t.created_at) FROM vecino.transactions t WHERE t.house_id = h.id)::text AS ultima_tx
              FROM vecino.houses h
              JOIN vecino.colonias c ON c.id = h.colonia_id
             ORDER BY c.nombre, lpad(regexp_replace(h.numero,'[^0-9]','','g'),6,'0'), h.numero")

BANCO=$(pg "SELECT c.nombre AS colonia, b.estado::text AS estado, count(*) AS movs, sum(b.monto)::text AS monto
              FROM vecino.bank_movs b JOIN vecino.colonias c ON c.id = b.colonia_id
             GROUP BY 1,2 ORDER BY 1,2")

OUT="$APP_DIR/docs/snapshots/saldos_${ETIQUETA}_${STAMP}"
jq -n --arg etiqueta "$ETIQUETA" --argjson sello "$SELLO_JSON" \
      --argjson casas "$CASAS" --argjson banco "$BANCO" \
      '{etiqueta:$etiqueta, sello:$sello[0], casas:$casas, banco:$banco}' > "$OUT.json"

{ echo "colonia,casa,propietario,saldo,estatus,n_tx,n_tx_pendientes,ultima_tx"
  echo "$CASAS" | jq -r '.[] | [.colonia,.casa,.propietario,.saldo,.estatus,.n_tx,.n_tx_pendientes,.ultima_tx] | @csv'
} > "$OUT.csv"

echo "━━ FOTO '$ETIQUETA' — sello $SELLO_LOCAL (hora local) ━━"
echo "$CASAS" | jq -r 'group_by(.colonia)[] | "\(.[0].colonia): \(length) casas · saldo total \(map(.saldo|tonumber)|add)"'
echo "Banco (bank_movs):"
echo "$BANCO" | jq -r '.[] | "  \(.colonia) · \(.estado): \(.movs) movs · $\(.monto)"'
echo "→ $OUT.json"
echo "→ $OUT.csv"
