#!/bin/zsh
# qa_095_096_mutaciones.sh — revertir un guard tiene que poner el arnés en ROJO.
#
# El DDL en Postgres es transaccional: cada mutación se aplica DENTRO del
# BEGIN…ROLLBACK del propio arnés, así que se ejercita la función mutada sobre
# datos reales y al terminar no queda nada — ni la mutación ni las filas.
set -e
cd "$(dirname "$0")/.."
set -a && . ./.env.local && set +a

corre() {  # $1 = archivo de mutación (o vacío = sin mutar)
  python3 - "$1" <<'PY' > /tmp/_qa_payload.json
import json,sys
qa = open('scripts/qa_095_096.sql').read()
mut = open(sys.argv[1]).read() if sys.argv[1] else ''
# La mutación entra JUSTO después del BEGIN; del arnés. Se exige que el ancla
# aparezca exactamente una vez: un ancla que empata 0 veces se lee igual que
# "la mutación no muerde".
veces = qa.count('\nBEGIN;\n')
assert veces == 1, f'el ancla BEGIN; empata {veces} veces (debe ser 1)'
sql = qa.replace('\nBEGIN;\n', '\nBEGIN;\n' + mut + '\n', 1)
print(json.dumps({'query': sql}))
PY
  curl -sS -X POST "$NEXT_PUBLIC_SUPABASE_URL/pg/query" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Content-Type: application/json" --data-binary @/tmp/_qa_payload.json
}

veredicto() {  # lee el JSON de la corrida → verde | rojo | abortó
  python3 -c '
import sys,json
raw=sys.stdin.read()
try: d=json.loads(raw)
except Exception: print("abortó|no devolvió JSON"); raise SystemExit
if isinstance(d,dict):
    print("abortó|"+str(d.get("message") or raw)[:160]); raise SystemExit
if not d: print("abortó|sin aserciones"); raise SystemExit
mal=[x["caso"] for x in d if x["r"].strip()!="OK"]
print(("rojo|"+"; ".join(mal)) if mal else "verde|")'
}

echo "\nBase (sin mutar)"
BASE=$(corre "" | veredicto)
echo "  → ${BASE%%|*}"
[[ "${BASE%%|*}" == "verde" ]] || { echo "  la base no está verde, no tiene caso mutar"; exit 1; }

echo "\nMutaciones"
MALAS=0
for f in scripts/mut/m*.sql; do
  ESPERA=rojo; [[ "$f" == *control* ]] && ESPERA=verde
  R=$(corre "$f" | veredicto)
  EST="${R%%|*}"; DET="${R#*|}"
  if [[ "$EST" == "$ESPERA" ]]; then
    echo "  ✓ $(basename $f) → $EST"
    [[ -n "$DET" ]] && echo "      mordió en: $DET"
  else
    echo "  ✗ $(basename $f) → $EST (se esperaba $ESPERA) $DET"
    MALAS=$((MALAS+1))
  fi
done

echo "\n$([[ $MALAS -eq 0 ]] && echo 'MUTACIONES OK' || echo 'MUTACIONES CON PROBLEMA') — $MALAS sin morder\n"
exit $MALAS
