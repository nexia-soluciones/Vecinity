#!/usr/bin/env python3
"""Compara dos fotos de saldos (scripts/snapshot_saldos.sh) y dice a quién se le movió el saldo.

Uso:  scripts/diff_saldos.py <antes.json> <despues.json> [--md salida.md]

Convención Vecinity: saldo > 0 = ADEUDO · saldo < 0 = A FAVOR.
Por eso un delta NEGATIVO le beneficia al vecino (le baja el adeudo) y uno POSITIVO le perjudica.
Solo lee archivos locales — no toca la BD.
"""
import json, sys
from decimal import Decimal

def cargar(ruta):
    with open(ruta) as f:
        d = json.load(f)
    casas = {c["house_id"]: c for c in d["casas"]}
    banco = {(b["colonia"], b["estado"]): b for b in d["banco"]}
    return d, casas, banco

def dec(x):
    return Decimal(x if x not in (None, "") else "0")

def money(x):
    s = f"{abs(x):,.2f}"
    return ("-$" if x < 0 else "$") + s

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    md_path = None
    if "--md" in sys.argv:
        md_path = sys.argv[sys.argv.index("--md") + 1]
    if len(args) != 2:
        print(__doc__); sys.exit(1)

    a, casas_a, banco_a = cargar(args[0])
    b, casas_b, banco_b = cargar(args[1])

    lineas = []
    def p(s=""):
        lineas.append(s)

    p(f"# Movimiento de saldos — {a['etiqueta']} → {b['etiqueta']}")
    p()
    p(f"- Foto **{a['etiqueta']}**: {a['sello']['local']} (hora local)")
    p(f"- Foto **{b['etiqueta']}**: {b['sello']['local']} (hora local)")
    p()
    p("> Convención: **saldo > 0 = adeudo**, **saldo < 0 = a favor**. "
      "Delta negativo = le bajó el adeudo (beneficio); positivo = le subió.")
    p()

    cambios, sin_saldo_pero_tx = [], []
    for hid, cb in casas_b.items():
        ca = casas_a.get(hid)
        if ca is None:
            continue
        d_saldo = dec(cb["saldo"]) - dec(ca["saldo"])
        d_tx = int(cb["n_tx"]) - int(ca["n_tx"])
        if d_saldo != 0:
            cambios.append((ca, cb, d_saldo, d_tx))
        elif d_tx != 0 or ca["estatus"] != cb["estatus"]:
            sin_saldo_pero_tx.append((ca, cb, d_tx))

    nuevas = [c for h, c in casas_b.items() if h not in casas_a]
    idas   = [c for h, c in casas_a.items() if h not in casas_b]

    tot_a = sum(dec(c["saldo"]) for c in casas_a.values())
    tot_b = sum(dec(c["saldo"]) for c in casas_b.values())
    baja  = sum(d for _, _, d, _ in cambios if d < 0)
    sube  = sum(d for _, _, d, _ in cambios if d > 0)

    p("## Resumen")
    p()
    p("| | |")
    p("|---|---|")
    p(f"| Casas con saldo movido | **{len(cambios)}** de {len(casas_b)} |")
    p(f"| Se les BAJÓ el adeudo (a favor del vecino) | {sum(1 for _,_,d,_ in cambios if d < 0)} casas · {money(baja)} |")
    p(f"| Se les SUBIÓ el adeudo (en contra) | {sum(1 for _,_,d,_ in cambios if d > 0)} casas · {money(sube)} |")
    p(f"| Saldo total de la cartera | {money(tot_a)} → {money(tot_b)} ({money(tot_b - tot_a)}) |")
    if nuevas: p(f"| Casas nuevas en la 2ª foto | {len(nuevas)} |")
    if idas:   p(f"| Casas que ya no aparecen | {len(idas)} |")
    p()

    if cambios:
        p("## Casas con saldo movido")
        p()
        p("| Colonia | Casa | Propietario | Antes | Después | Delta | Lectura | Tx nuevas |")
        p("|---|---|---|---:|---:|---:|---|---:|")
        for ca, cb, d, dtx in sorted(cambios, key=lambda x: x[2]):
            lectura = "🟢 le bajó el adeudo" if d < 0 else "🔴 le subió el adeudo"
            if dec(cb["saldo"]) < 0 <= dec(ca["saldo"]):
                lectura += " (queda a favor)"
            p(f"| {cb['colonia']} | {cb['casa']} | {cb['propietario'] or ''} | "
              f"{money(dec(ca['saldo']))} | {money(dec(cb['saldo']))} | {money(d)} | {lectura} | {dtx or ''} |")
        p()

    if sin_saldo_pero_tx:
        p("## Sin cambio de saldo pero con movimiento (revisar)")
        p()
        p("| Casa | Tx nuevas | Estatus |")
        p("|---|---:|---|")
        for ca, cb, dtx in sin_saldo_pero_tx:
            est = cb["estatus"] if ca["estatus"] == cb["estatus"] else f"{ca['estatus']} → {cb['estatus']}"
            p(f"| {cb['casa']} | {dtx or ''} | {est} |")
        p()

    for titulo, lista in (("Casas nuevas", nuevas), ("Casas que desaparecieron", idas)):
        if lista:
            p(f"## {titulo}")
            p()
            for c in lista:
                p(f"- {c['colonia']} casa {c['casa']} — saldo {money(dec(c['saldo']))}")
            p()

    p("## Banco (bank_movs)")
    p()
    p("| Colonia | Estado | Movs antes | Movs después | Δ movs | Monto antes | Monto después |")
    p("|---|---|---:|---:|---:|---:|---:|")
    for k in sorted(set(banco_a) | set(banco_b)):
        va, vb = banco_a.get(k), banco_b.get(k)
        na, nb = int(va["movs"]) if va else 0, int(vb["movs"]) if vb else 0
        ma, mb = dec(va["monto"]) if va else Decimal(0), dec(vb["monto"]) if vb else Decimal(0)
        marca = "" if na == nb else f"**{nb - na:+d}**"
        p(f"| {k[0]} | {k[1]} | {na} | {nb} | {marca} | {money(ma)} | {money(mb)} |")
    p()

    salida = "\n".join(lineas)
    print(salida)
    if md_path:
        with open(md_path, "w") as f:
            f.write(salida + "\n")
        print(f"\n→ {md_path}", file=sys.stderr)

if __name__ == "__main__":
    main()
