#!/usr/bin/env bash
# Deploy hot del cerebro de Caty (n8n/caty_bot.js) al workflow "Vecinity - Telegram (Caty)".
# Sustituye placeholders desde .env.local + BD y publica por API (PUT + reactivate).
# Uso: ./scripts/push_caty.sh
set -euo pipefail

WF_ID="QcbjAUiwnW28lXLw"
N8N="https://n8n.nexiasoluciones.com.mx"
SB="https://supabase.nexiasoluciones.com.mx"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENVF="$DIR/.env.local"
SRC="$DIR/n8n/caty_bot.js"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

val() { grep "^$1=" "$ENVF" | cut -d= -f2-; }

TG=$(val TELEGRAM_BOT_TOKEN)
AN=$(val NEXT_PUBLIC_SUPABASE_ANON_KEY)
SR=$(val SUPABASE_SERVICE_ROLE_KEY)
AK=$(val ANTHROPIC_API_KEY)
KEY=$(jq -r '.mcpServers["n8n-nexia"].env.N8N_API_KEY' ~/.claude.json)

# token del bot desde la BD (vecino.bot_config)
BT=$(curl -sS -X POST "$SB/pg/query" \
  -H "apikey: $SR" -H "Authorization: Bearer $SR" -H "Content-Type: application/json" \
  -d '{"query":"SELECT token FROM vecino.bot_config"}' | jq -r '.[0].token')

sed -e "s|__TELEGRAM_TOKEN__|$TG|" -e "s|__ANON_KEY__|$AN|" -e "s|__SERVICE_KEY__|$SR|" \
    -e "s|__ANTHROPIC_KEY__|$AK|" -e "s|__BOT_DB_TOKEN__|$BT|" "$SRC" > "$TMP/final.js"

if grep -qE '__(TELEGRAM_TOKEN|ANON_KEY|SERVICE_KEY|ANTHROPIC_KEY|BOT_DB_TOKEN)__' "$TMP/final.js"; then
  echo "❌ Quedaron placeholders sin sustituir"; exit 1
fi

# validar sintaxis (wrapped: el node corre con await top-level)
{ echo '(async function(){ const $input={first:()=>({json:{}})};'; cat "$TMP/final.js"; echo '})();'; } > "$TMP/check.js"
node --check "$TMP/check.js"

jq -Rs '{code: .}' "$TMP/final.js" > "$TMP/code.json"
curl -sS "$N8N/api/v1/workflows/$WF_ID" -H "X-N8N-API-KEY: $KEY" > "$TMP/wf.json"
jq --slurpfile c "$TMP/code.json" \
  '{name: .name, nodes: (.nodes | map(if .name=="Caty" then (.parameters.jsCode = $c[0].code) else . end)), connections: .connections, settings: .settings}' \
  "$TMP/wf.json" > "$TMP/put.json"

curl -sS -X PUT "$N8N/api/v1/workflows/$WF_ID" -H "X-N8N-API-KEY: $KEY" \
  -H "Content-Type: application/json" -d @"$TMP/put.json" | jq -r '"PUT ok · " + .updatedAt'
# republish (modelo draft/publish)
curl -sS -X POST "$N8N/api/v1/workflows/$WF_ID/deactivate" -H "X-N8N-API-KEY: $KEY" > /dev/null
curl -sS -X POST "$N8N/api/v1/workflows/$WF_ID/activate" -H "X-N8N-API-KEY: $KEY" | jq -r '"activo: " + (.active|tostring)'
echo "✅ Caty desplegada"
