#!/usr/bin/env python3
"""Backfill de egresos históricos (Excel del comité) → vecino.colonia_expenses.

- Fuente: Dashboard_Financiero_Villa_Catania_2026.xlsx hoja 'Movimientos' (cargos).
- Los montos/saldos con formato fecha son seriales de Excel → se reconvierten.
- banco_hash = sha256(fecha|monto|concepto|saldo) con formato de número de JS
  (misma fórmula que la página de conciliación) → dedup si se re-sube el banco.
- Anti-duplicado con los 15 gastos manuales ya capturados: si hay match por
  monto EXACTO + fecha ±5 días (sin banco_hash), se ENLAZA (update) en vez de
  insertar — conserva la razón clara que escribió el comité.
- PROYECTO_BANCAS / PROYECTO_MANGUERA → proyectos reales + gastos ligados.
- Idempotente: ON CONFLICT / hash existente se salta. --dry-run para revisar.
"""
import hashlib, json, subprocess, sys
from datetime import datetime, timedelta

import openpyxl

XLSX = ("/Users/juangarces/Library/Mobile Documents/iCloud~md~obsidian/Documents/"
        "VillaCataniaVault/Catania/Administracion_Actual_2025-2027/03_Finanzas/"
        "Dashboard_Financiero_Villa_Catania_2026.xlsx")
COLONIA = "ce43b59c-529b-4960-8dd7-d975e43ac2fb"  # Villa Catania
BASE = "https://supabase.nexiasoluciones.com.mx/pg/query"
EPOCH = datetime(1899, 12, 30)  # base de seriales de Excel
DRY = "--dry-run" in sys.argv

PROYECTOS = {
    "PROYECTO_BANCAS": ("Bancas para áreas comunes", "Materiales"),
    "PROYECTO_MANGUERA": ("Manguera y aspersores para áreas verdes", "Materiales"),
}


def sk():
    for line in open("/Users/juangarces/dev/Vecinity/vecinity-app/.env.local"):
        if line.startswith("SUPABASE_SERVICE_ROLE_KEY"):
            return line.split("=", 1)[1].strip()
    raise SystemExit("sin service key")


KEY = sk()


def pg(query):
    body = json.dumps({"query": query})
    out = subprocess.run(
        ["curl", "-sS", "-X", "POST", BASE, "-H", f"apikey: {KEY}",
         "-H", f"Authorization: Bearer {KEY}", "-H", "Content-Type: application/json",
         "--data-binary", "@-"],
        input=body.encode(), capture_output=True, check=True)
    r = json.loads(out.stdout or b"[]")
    if isinstance(r, dict) and r.get("error"):
        raise SystemExit(f"PG ERROR: {r['error']}\n--- query:\n{query[:500]}")
    return r


def num(v):
    """Celda numérica que openpyxl pudo leer como datetime (serial con formato fecha)."""
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return round((v - EPOCH).total_seconds() / 86400, 2)
    try:
        return round(float(str(v).replace(",", "")), 2)
    except ValueError:
        return None


def fecha_serial(v):
    if isinstance(v, datetime):
        return v.date().isoformat()
    s = num(v)
    return (EPOCH + timedelta(days=int(s))).date().isoformat() if s else None


def js_num(x):
    """Cómo formatea JS el número en el template del hash (String(n))."""
    return str(int(x)) if float(x) == int(x) else repr(round(float(x), 2))


def esc(s):
    return str(s).replace("'", "''")


# ---- 1. Leer egresos del Excel ---------------------------------------------
wb = openpyxl.load_workbook(XLSX, data_only=True)
ws = wb["Movimientos"]
rows = []
for r in ws.iter_rows(min_row=3, values_only=True):
    fecha, concepto, cargo, _abono, saldo, _mes, _ym, cat = r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7]
    monto = num(cargo)
    if not monto or monto <= 0 or not concepto:
        continue
    f = fecha_serial(fecha)
    s = num(saldo) or 0
    concepto = str(concepto).strip()
    h = hashlib.sha256(f"{f}|{js_num(monto)}|{concepto}|{js_num(s)}".encode()).hexdigest()
    rows.append({"fecha": f, "concepto": concepto, "monto": monto,
                 "cat": str(cat or "Otros").strip(), "hash": h})

print(f"Egresos en Excel: {len(rows)}")

# ---- 2. Estado actual en BD -------------------------------------------------
exist = pg(f"""SELECT id, monto::numeric AS monto, fecha_pago::text AS fecha, banco_hash, concepto
               FROM vecino.colonia_expenses WHERE colonia_id = '{COLONIA}'""")
ya_hash = {e["banco_hash"] for e in exist if e["banco_hash"]}
manuales = [e for e in exist if not e["banco_hash"]]
print(f"En BD: {len(exist)} gastos ({len(manuales)} manuales sin banco_hash)")

# ---- 3. Clasificar cada fila: skip / enlazar / insertar ---------------------
def dias(a, b):
    return abs((datetime.fromisoformat(a) - datetime.fromisoformat(b)).days)

usados = set()
enlazar, insertar, revisar = [], [], []
for row in rows:
    if row["hash"] in ya_hash:
        continue  # ya importado (re-corrida idempotente)
    m = next((e for e in manuales
              if e["id"] not in usados
              and float(e["monto"]) == row["monto"]
              and dias(e["fecha"], row["fecha"]) <= 5), None)
    if m:
        usados.add(m["id"])
        enlazar.append((m, row, False))
        continue
    # casi-match (fecha ±5d, monto a <$1 = dedazo al transcribir): ENLAZA y
    # corrige el monto al del banco (el banco es la verdad). Se reporta.
    casi = next((e for e in manuales if e["id"] not in usados
                 and abs(float(e["monto"]) - row["monto"]) < 1
                 and dias(e["fecha"], row["fecha"]) <= 5), None)
    if casi:
        usados.add(casi["id"])
        enlazar.append((casi, row, True))
        revisar.append((casi, row))
        continue
    insertar.append(row)

print(f"\nPlan: enlazar {len(enlazar)} manuales · insertar {len(insertar)} nuevos · "
      f"{len(rows) - len(enlazar) - len(insertar)} ya importados")
for m, row, _fix in enlazar:
    print(f"  ENLAZA  {m['fecha']} ${float(m['monto']):>9.2f}  '{m['concepto'][:38]}'  ←  {row['concepto'][:38]}")
if revisar:
    print("\n⚠️  Casi-duplicados enlazados con monto corregido al del banco:")
    for m, row in revisar:
        print(f"  {m['fecha']} '{m['concepto'][:35]}' ${float(m['monto']):.2f} → ${row['monto']:.2f} (banco)")

from collections import Counter
print("\nInsertar por categoría:", dict(Counter(r["cat"] for r in insertar)))
if DRY:
    sys.exit(0)

# ---- 4. Proyectos Bancas/Manguera -------------------------------------------
proy_ids = {}
for excel_cat, (titulo, _cat) in PROYECTOS.items():
    r = pg(f"""WITH ins AS (
                 INSERT INTO vecino.improvement_projects (colonia_id, titulo, estado)
                 SELECT '{COLONIA}', '{esc(titulo)}', 'terminado'
                 WHERE NOT EXISTS (SELECT 1 FROM vecino.improvement_projects
                                   WHERE colonia_id='{COLONIA}' AND titulo='{esc(titulo)}')
                 RETURNING id)
               SELECT id::text FROM ins
               UNION ALL
               SELECT id::text FROM vecino.improvement_projects
               WHERE colonia_id='{COLONIA}' AND titulo='{esc(titulo)}' LIMIT 1""")
    proy_ids[excel_cat] = r[0]["id"]
print("Proyectos:", proy_ids)

# ---- 5. Enlazar manuales (conserva razón y categoría del comité) ------------
for m, row, fix_monto in enlazar:
    extra = f", monto={row['monto']}" if fix_monto else ""
    if row["cat"] in PROYECTOS:  # manual que pertenece a un proyecto → ligarlo
        extra += f", improvement_id='{proy_ids[row['cat']]}'"
    pg(f"""UPDATE vecino.colonia_expenses
           SET banco_hash='{row['hash']}', concepto_banco='{esc(row['concepto'])}'{extra}
           WHERE id='{m['id']}' AND banco_hash IS NULL""")
print(f"Enlazados: {len(enlazar)}")

# ---- 6. Insertar nuevos ------------------------------------------------------
vals = []
for r in insertar:
    if r["cat"] in PROYECTOS:
        cat, imp = PROYECTOS[r["cat"]][1], f"'{proy_ids[r['cat']]}'"
    else:
        cat, imp = r["cat"], "NULL"
    vals.append(f"('{COLONIA}','{esc(r['concepto'])}',{r['monto']},'{r['fecha']}',"
                f"'{esc(cat)}','clasificado','{esc(r['concepto'])}','{r['hash']}',{imp})")

CHUNK = 40
total = 0
for i in range(0, len(vals), CHUNK):
    q = ("INSERT INTO vecino.colonia_expenses (colonia_id, concepto, monto, fecha_pago, "
         "categoria, estado, concepto_banco, banco_hash, improvement_id) VALUES "
         + ",".join(vals[i:i + CHUNK])
         + " ON CONFLICT (colonia_id, banco_hash) WHERE banco_hash IS NOT NULL DO NOTHING")
    pg(q)
    total += len(vals[i:i + CHUNK])
print(f"Insertados (intentados): {total}")

chk = pg(f"""SELECT count(*) AS n, count(banco_hash) AS con_hash,
             sum(monto) AS total FROM vecino.colonia_expenses WHERE colonia_id='{COLONIA}'""")
print("Estado final BD:", chk[0])
