"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import * as XLSX from "xlsx";
import { supabaseBrowser } from "@/lib/supabase/browser";

type Ingreso = {
  key: string; // id local
  fecha: string;
  concepto: string;
  monto: number;
  refKey: string;
  hash: string;
  casa: string; // número de casa (editable)
  sugerida: boolean; // vino del mapa aprendido
  incluir: boolean;
  dup: boolean;
  estado: "" | "ok" | "dup" | "error";
  errorMsg?: string;
};

const money = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);

const normRef = (s: string) => s.toUpperCase().replace(/\s+/g, " ").trim();

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const fmtFecha = (v: unknown): string => {
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(
      v.getDate()
    ).padStart(2, "0")}`;
  }
  return String(v ?? "").slice(0, 10);
};

const toNum = (v: unknown): number => {
  if (typeof v === "number") return v;
  const n = parseFloat(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return isNaN(n) ? 0 : n;
};

export default function ConciliacionPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [coloniaId, setColoniaId] = useState<string | null>(null);
  const [casas, setCasas] = useState<Record<string, string>>({}); // numero -> id
  const [refMap, setRefMap] = useState<Record<string, string>>({}); // refKey -> numero
  const [ingresos, setIngresos] = useState<Ingreso[]>([]);
  const [fileMsg, setFileMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resumen, setResumen] = useState<string | null>(null);

  const cargarMapas = useCallback(async () => {
    const { data: hs } = await supabaseBrowser.from("houses").select("id, numero");
    const casasDict: Record<string, string> = {};
    for (const h of (hs as unknown as { id: string; numero: string }[]) ?? [])
      casasDict[String(h.numero)] = h.id;
    setCasas(casasDict);

    const { data: rm } = await supabaseBrowser.from("bank_ref_map").select("ref_key, house_id");
    const idToNum: Record<string, string> = {};
    for (const [num, id] of Object.entries(casasDict)) idToNum[id] = num;
    const map: Record<string, string> = {};
    for (const r of (rm as unknown as { ref_key: string; house_id: string }[]) ?? [])
      if (idToNum[r.house_id]) map[r.ref_key] = idToNum[r.house_id];
    setRefMap(map);
  }, []);

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabaseBrowser.auth.getUser();
      if (!user) return router.replace("/login");
      const { data: prof } = await supabaseBrowser
        .from("profiles")
        .select("role, colonia_id, approval_status")
        .eq("id", user.id)
        .maybeSingle();
      const p = prof as unknown as {
        role: string;
        colonia_id: string | null;
        approval_status: string;
      } | null;
      if (!p || p.approval_status !== "aprobado") return router.replace("/esperando");
      if (p.role !== "admin" && p.role !== "comite") return router.replace("/dashboard");
      setColoniaId(p.colonia_id);
      await cargarMapas();
      setReady(true);
    })();
  }, [router, cargarMapas]);

  async function onFile(file: File) {
    setFileMsg(null);
    setResumen(null);
    setIngresos([]);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false });

      // localizar fila de encabezado (contiene Abono y Cargo/Concepto)
      let hi = -1;
      for (let i = 0; i < Math.min(rows.length, 30); i++) {
        const cells = (rows[i] || []).map((c) => String(c ?? "").toLowerCase());
        if (cells.some((c) => c.includes("abono")) &&
            cells.some((c) => c.includes("cargo") || c.includes("concepto") || c.includes("referencia"))) {
          hi = i;
          break;
        }
      }
      if (hi < 0) {
        setFileMsg("No encontré las columnas del banco (Fecha · Concepto · Cargo · Abono · Saldo).");
        return;
      }
      const head = (rows[hi] as unknown[]).map((c) => String(c ?? "").toLowerCase());
      const col = (...names: string[]) =>
        head.findIndex((h) => names.some((n) => h.includes(n)));
      const iFecha = col("día", "dia", "fecha");
      const iConcepto = col("concepto", "referencia");
      const iAbono = col("abono");
      const iSaldo = col("saldo");

      // hashes ya importados (para marcar duplicados)
      const { data: existentes } = await supabaseBrowser
        .from("transactions")
        .select("banco_hash")
        .not("banco_hash", "is", null);
      const yaImportados = new Set(
        ((existentes as unknown as { banco_hash: string }[]) ?? []).map((e) => e.banco_hash)
      );

      const out: Ingreso[] = [];
      for (let i = hi + 1; i < rows.length; i++) {
        const r = rows[i] as unknown[];
        if (!r || r.length === 0) continue;
        const monto = toNum(r[iAbono]);
        if (monto <= 0) continue; // solo ingresos
        const concepto = String(r[iConcepto] ?? "").trim();
        const fecha = fmtFecha(r[iFecha]);
        const saldo = iSaldo >= 0 ? toNum(r[iSaldo]) : 0;
        const refKey = normRef(concepto);
        const hash = await sha256(`${fecha}|${monto}|${concepto}|${saldo}`);
        const sugeridaNum = refMap[refKey] ?? "";
        const dup = yaImportados.has(hash);
        out.push({
          key: `${i}-${hash.slice(0, 8)}`,
          fecha,
          concepto,
          monto,
          refKey,
          hash,
          casa: sugeridaNum,
          sugerida: !!sugeridaNum,
          incluir: !dup,
          dup,
          estado: dup ? "dup" : "",
        });
      }
      if (out.length === 0) {
        setFileMsg("No encontré ingresos (abonos) en el archivo.");
        return;
      }
      setIngresos(out);
      const nuevos = out.filter((o) => !o.dup).length;
      const conSug = out.filter((o) => o.sugerida && !o.dup).length;
      setFileMsg(`${out.length} ingresos · ${nuevos} nuevos · ${conSug} con casa sugerida · ${out.length - nuevos} ya importados.`);
    } catch (e) {
      setFileMsg("No pude leer el archivo. ¿Es el Excel del banco?");
      console.error(e);
    }
  }

  function setRow(key: string, patch: Partial<Ingreso>) {
    setIngresos((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  async function conciliar() {
    setBusy(true);
    setResumen(null);
    let ok = 0,
      dup = 0,
      err = 0,
      sinCasa = 0;
    const updated = [...ingresos];
    for (let i = 0; i < updated.length; i++) {
      const row = updated[i];
      if (!row.incluir || row.estado === "ok") continue;
      const casaId = casas[row.casa.trim()];
      if (!row.casa.trim() || !casaId) {
        sinCasa++;
        updated[i] = { ...row, estado: "error", errorMsg: "Casa inválida" };
        continue;
      }
      const { data, error } = await supabaseBrowser.rpc("conciliar_abono", {
        p_house_id: casaId,
        p_monto: row.monto,
        p_concepto: `Pago banco ${row.fecha} · ${row.concepto}`.slice(0, 200),
        p_banco_hash: row.hash,
        p_ref_key: row.refKey,
      });
      if (error) {
        err++;
        updated[i] = { ...row, estado: "error", errorMsg: error.message.replace(/^.*?:\s/, "") };
      } else if ((data as { dup?: boolean })?.dup) {
        dup++;
        updated[i] = { ...row, estado: "dup", incluir: false };
      } else {
        ok++;
        updated[i] = { ...row, estado: "ok", incluir: false };
      }
    }
    setIngresos(updated);
    setBusy(false);
    setResumen(
      `Conciliados: ${ok} · ya importados: ${dup} · sin casa válida: ${sinCasa} · errores: ${err}.`
    );
    await cargarMapas();
  }

  if (!ready)
    return (
      <main className="flex-1 flex items-center justify-center text-slate-400">Cargando…</main>
    );

  const seleccion = ingresos.filter((r) => r.incluir && r.estado !== "ok");
  const totalSel = seleccion.reduce((s, r) => s + r.monto, 0);

  return (
    <main className="flex-1 bg-gradient-to-b from-brand-50 via-white to-sky-50">
      <div className="w-full max-w-md mx-auto px-5 py-6 flex flex-col">
        <div className="flex items-center justify-between">
          <button
            onClick={() => router.push("/dashboard/comite")}
            className="text-sm text-slate-500 hover:text-slate-700"
          >
            ← Volver
          </button>
          <Image src="/brand/vecinity-logo.svg" alt="Vecinity" width={120} height={34} priority />
        </div>

        <h1 className="text-2xl font-bold text-slate-800 mt-4">Conciliación bancaria</h1>
        <p className="text-sm text-slate-500">
          Sube el estado de cuenta del banco (Excel) y asigna cada pago a su casa.
        </p>

        {/* Subir archivo */}
        <section className="mt-4 bg-white rounded-2xl ring-1 ring-slate-100 p-4">
          <label className="text-sm font-semibold text-slate-700">
            Estado de cuenta (.xlsx)
            <input
              type="file"
              accept=".xlsx,.xls"
              onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
              className="mt-2 w-full text-sm text-slate-600 file:mr-2 file:rounded-lg file:border-0 file:bg-brand-50 file:text-brand-700 file:px-3 file:py-2 file:font-semibold"
            />
          </label>
          {fileMsg && <p className="text-xs text-slate-600 mt-2">{fileMsg}</p>}
        </section>

        {ingresos.length > 0 && (
          <>
            {/* Acción */}
            <div className="mt-4 sticky top-2 z-10 bg-gradient-to-br from-brand-500 to-emerald-600 text-white rounded-2xl p-4 shadow-lg">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-white/80 text-xs">Seleccionados</p>
                  <p className="text-xl font-extrabold">
                    {seleccion.length} · {money(totalSel)}
                  </p>
                </div>
                <button
                  onClick={conciliar}
                  disabled={busy || seleccion.length === 0}
                  className="rounded-xl bg-white/20 hover:bg-white/30 px-4 py-2.5 text-sm font-bold disabled:opacity-40"
                >
                  {busy ? "Conciliando…" : "Conciliar seleccionados"}
                </button>
              </div>
              {resumen && <p className="text-xs text-white/90 mt-2">{resumen}</p>}
            </div>

            {/* Lista de ingresos */}
            <section className="mt-4 mb-6">
              <ul className="flex flex-col gap-2">
                {ingresos.map((r) => (
                  <li
                    key={r.key}
                    className={`rounded-2xl p-3 ring-1 ${
                      r.estado === "ok"
                        ? "bg-emerald-50 ring-emerald-200"
                        : r.estado === "dup"
                        ? "bg-slate-50 ring-slate-200 opacity-70"
                        : r.estado === "error"
                        ? "bg-red-50 ring-red-200"
                        : "bg-white ring-slate-100"
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={r.incluir}
                        disabled={r.estado === "ok" || r.estado === "dup"}
                        onChange={(e) => setRow(r.key, { incluir: e.target.checked })}
                        className="mt-1 w-4 h-4 accent-brand-500"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs text-slate-500">{r.fecha}</p>
                          <p className="font-bold text-slate-800">{money(r.monto)}</p>
                        </div>
                        <p className="text-sm text-slate-700 truncate" title={r.concepto}>
                          {r.concepto}
                        </p>
                        <div className="flex items-center gap-2 mt-2">
                          <span className="text-xs text-slate-500">Casa</span>
                          <input
                            value={r.casa}
                            onChange={(e) => setRow(r.key, { casa: e.target.value })}
                            disabled={r.estado === "ok" || r.estado === "dup"}
                            placeholder="N°"
                            className="w-20 rounded-lg ring-1 ring-slate-200 px-2 py-1 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
                          />
                          {r.sugerida && r.estado === "" && (
                            <span className="text-[10px] font-semibold text-brand-600 bg-brand-50 rounded-full px-2 py-0.5">
                              sugerida
                            </span>
                          )}
                          {r.estado === "ok" && (
                            <span className="text-[10px] font-semibold text-emerald-700">✓ conciliado</span>
                          )}
                          {r.estado === "dup" && (
                            <span className="text-[10px] font-semibold text-slate-500">ya importado</span>
                          )}
                          {r.estado === "error" && (
                            <span className="text-[10px] font-semibold text-red-600">{r.errorMsg}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
