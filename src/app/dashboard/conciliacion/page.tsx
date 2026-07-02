"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import * as XLSX from "xlsx";
import { supabaseBrowser } from "@/lib/supabase/browser";

// Candidato de match por monto+fecha contra un comprobante que subió el vecino.
type Propuesta = {
  abonoId: string;
  casa: string;
  comprobanteUrl: string | null;
  fechaOcr: string | null;
};

type Ingreso = {
  key: string; // id local
  fecha: string;
  concepto: string;
  monto: number;
  refKey: string;
  hash: string;
  casa: string; // número de casa (editable)
  sugerida: boolean; // vino del mapa aprendido o del concepto
  conf: "alta" | "media" | null; // confianza de la casa extraída del concepto
  incluir: boolean;
  dup: boolean;
  estado: "" | "ok" | "dup" | "error" | "propuesta";
  errorMsg?: string;
  // Propuestas por monto+fecha (comprobantes de vecinos que cuadran). El comité
  // aprueba una antes de aplicarla — nada se concilia solo por esta vía.
  propuestas?: Propuesta[];
  propuestaSel?: string; // abonoId elegido cuando hay varios candidatos
};

const money = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);

const normRef = (s: string) => s.toUpperCase().replace(/\s+/g, " ").trim();

// Extrae el número de casa del concepto del banco (los vecinos escriben C152,
// CASA 220, "mtto casa 184", o el número al final). Valida SIEMPRE contra las
// casas reales (todas de 3 dígitos, 100-258), así los números de cuenta/rastreo
// (10 díg.) y los códigos de banco (014, 002…) nunca cuelan.
//   conf 'alta'  = patrón explícito C###/CASA### → seguro para auto-conciliar.
//   conf 'media' = número de casa válido suelto en el texto → sugerencia a confirmar.
function extraerCasa(concepto: string, casasSet: Set<string>): { casa: string | null; conf: "alta" | "media" | null } {
  const limpio = String(concepto || "").toUpperCase().replace(/\d{4,}/g, " "); // quita cuentas/rastreo largos
  const valida = (n: string) => {
    const k = String(parseInt(n, 10));
    return casasSet.has(k) ? k : null;
  };
  const m = limpio.match(/\bCASA\s*(\d{1,3})\b/) || limpio.match(/\bC\s*(\d{1,3})\b/);
  if (m) {
    const k = valida(m[1]);
    if (k) return { casa: k, conf: "alta" };
  }
  let last: string | null = null;
  for (const n of limpio.match(/\b\d{1,3}\b/g) || []) {
    const k = valida(n);
    if (k) last = k;
  }
  if (last) return { casa: last, conf: "media" };
  return { casa: null, conf: null };
}

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
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoResumen, setAutoResumen] = useState<string | null>(null);
  // Corte: solo procesar movimientos DESDE esta fecha (evita re-contar lo histórico ya migrado).
  const [desde, setDesde] = useState("2026-07-01");

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

      const casasSet = new Set(Object.keys(casas));
      const out: Ingreso[] = [];
      let saltadasPorFecha = 0;
      for (let i = hi + 1; i < rows.length; i++) {
        const r = rows[i] as unknown[];
        if (!r || r.length === 0) continue;
        const monto = toNum(r[iAbono]);
        if (monto <= 0) continue; // solo ingresos
        const concepto = String(r[iConcepto] ?? "").trim();
        const fecha = fmtFecha(r[iFecha]);
        // Corte: ignora movimientos anteriores a "desde" (histórico ya migrado)
        if (desde && fecha && fecha < desde) {
          saltadasPorFecha++;
          continue;
        }
        const saldo = iSaldo >= 0 ? toNum(r[iSaldo]) : 0;
        const refKey = normRef(concepto);
        const hash = await sha256(`${fecha}|${monto}|${concepto}|${saldo}`);
        // Casa: primero por el concepto del banco (C###/CASA###), luego el mapa aprendido.
        const ext = extraerCasa(concepto, casasSet);
        const sugeridaNum = ext.casa ?? refMap[refKey] ?? "";
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
          conf: ext.conf,
          incluir: !dup,
          dup,
          estado: dup ? "dup" : "",
        });
      }
      if (out.length === 0) {
        setFileMsg(
          saltadasPorFecha > 0
            ? `No hay ingresos desde ${desde} (${saltadasPorFecha} anteriores ignorados por el corte).`
            : "No encontré ingresos (abonos) en el archivo."
        );
        return;
      }
      setIngresos(out);
      const nuevos = out.filter((o) => !o.dup).length;
      const conSug = out.filter((o) => o.sugerida && !o.dup).length;
      const corte = saltadasPorFecha > 0 ? ` · ${saltadasPorFecha} anteriores a ${desde} ignorados` : "";
      setFileMsg(`${out.length} ingresos · ${nuevos} nuevos · ${conSug} con casa sugerida · ${out.length - nuevos} ya importados${corte}.`);
    } catch (e) {
      setFileMsg("No pude leer el archivo. ¿Es el Excel del banco?");
      console.error(e);
    }
  }

  function setRow(key: string, patch: Partial<Ingreso>) {
    setIngresos((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  // Auto-conciliación: cruza cada fila del banco contra los comprobantes con OCR
  // (por clave de rastreo). Lo que cuadra se auto-aprueba y reconoce la casa solo;
  // lo demás queda para asignar a mano abajo.
  async function autoConciliar() {
    setAutoBusy(true);
    setAutoResumen(null);
    let auto = 0,
      porComprobante = 0,
      propuestos = 0,
      pendientes = 0,
      dup = 0;
    const updated = [...ingresos];
    for (let i = 0; i < updated.length; i++) {
      const row = updated[i];
      if (!row.incluir || row.estado === "ok" || row.estado === "dup" || row.estado === "propuesta")
        continue;

      // 1) match por comprobante que subió el vecino (clave de rastreo). Aprueba SU abono.
      const { data, error } = await supabaseBrowser.rpc("conciliar_auto", {
        p_banco_hash: row.hash,
        p_banco_concepto: row.concepto,
        p_monto: row.monto,
        p_fecha: row.fecha || null,
      });
      const r = data as { dup?: boolean; matched?: boolean; casa?: string } | null;
      if (!error && r?.dup) {
        dup++;
        updated[i] = { ...row, estado: "dup", incluir: false };
        continue;
      }
      if (!error && r?.matched) {
        porComprobante++;
        updated[i] = { ...row, estado: "ok", incluir: false, casa: r.casa ?? row.casa, sugerida: false };
        continue;
      }

      // 2) sin comprobante: si el concepto del banco identifica la casa con alta
      //    confianza (C###/CASA###), crea y aprueba el abono para esa casa.
      const casaId = casas[row.casa.trim()];
      if (row.conf === "alta" && casaId) {
        const { error: e2, data: d2 } = await supabaseBrowser.rpc("conciliar_abono", {
          p_house_id: casaId,
          p_monto: row.monto,
          p_concepto: `Pago banco ${row.fecha} · ${row.concepto}`.slice(0, 200),
          p_banco_hash: row.hash,
          p_ref_key: row.refKey,
          p_fecha: row.fecha || null,
        });
        if (!e2 && !(d2 as { dup?: boolean })?.dup) {
          auto++;
          updated[i] = { ...row, estado: "ok", incluir: false };
          continue;
        }
      }

      // 3) respaldo por MONTO + FECHA: busca comprobantes de vecinos que cuadren.
      //    NO se aplica solo — queda como propuesta para que el comité apruebe.
      const { data: dSug } = await supabaseBrowser.rpc("sugerir_abono", {
        p_monto: row.monto,
        p_fecha: row.fecha || null,
        p_banco_hash: row.hash,
      });
      const sug = dSug as {
        dup?: boolean;
        candidatos?: {
          abono_id: string;
          casa: string;
          comprobante_url: string | null;
          fecha_ocr: string | null;
        }[];
      } | null;
      if (sug?.dup) {
        dup++;
        updated[i] = { ...row, estado: "dup", incluir: false };
        continue;
      }
      const cands = sug?.candidatos ?? [];
      if (cands.length > 0) {
        propuestos++;
        const propuestas: Propuesta[] = cands.map((c) => ({
          abonoId: c.abono_id,
          casa: c.casa,
          comprobanteUrl: c.comprobante_url,
          fechaOcr: c.fecha_ocr,
        }));
        updated[i] = {
          ...row,
          estado: "propuesta",
          incluir: false,
          propuestas,
          propuestaSel: propuestas[0].abonoId,
          casa: propuestas[0].casa,
        };
        continue;
      }

      // 4) casa media/dudosa → queda pre-llenada para que el comité confirme
      pendientes++;
    }
    setIngresos(updated);
    setAutoBusy(false);
    setAutoResumen(
      `Auto-conciliados: ${auto + porComprobante} (${porComprobante} por comprobante, ${auto} por concepto) · ` +
        `propuestas por monto+fecha: ${propuestos} · por confirmar a mano: ${pendientes} · ya importados: ${dup}.`
    );
    await cargarMapas();
  }

  // Aprueba una propuesta monto+fecha: liga la fila del banco al abono del vecino.
  async function aprobarPropuesta(key: string) {
    const row = ingresos.find((r) => r.key === key);
    if (!row || row.estado !== "propuesta") return;
    const abonoId = row.propuestaSel ?? row.propuestas?.[0]?.abonoId;
    if (!abonoId) return;
    setRow(key, { errorMsg: undefined });
    const { data, error } = await supabaseBrowser.rpc("conciliar_confirmar", {
      p_abono_id: abonoId,
      p_banco_hash: row.hash,
      p_fecha: row.fecha || null,
    });
    if (error) {
      setRow(key, { estado: "error", errorMsg: error.message.replace(/^.*?:\s/, "") });
      return;
    }
    const r = data as { ok?: boolean; dup?: boolean; casa?: string } | null;
    if (r?.dup) {
      setRow(key, { estado: "dup", incluir: false, propuestas: undefined });
    } else {
      setRow(key, {
        estado: "ok",
        incluir: false,
        casa: r?.casa ?? row.casa,
        propuestas: undefined,
      });
    }
    await cargarMapas();
  }

  // Descarta las propuestas → la fila vuelve a "asignar a mano".
  function descartarPropuesta(key: string) {
    setRow(key, { estado: "", incluir: true, propuestas: undefined, propuestaSel: undefined });
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
        p_fecha: row.fecha || null,
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
          <label className="mt-3 block text-xs text-slate-500">
            Procesar solo movimientos desde
            <input
              type="date"
              value={desde}
              onChange={(e) => setDesde(e.target.value)}
              className="mt-1 w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
            />
            <span className="block mt-1 text-[11px] text-slate-400">
              Ignora lo anterior (ya está en el sistema por la migración). Evita doble conteo.
            </span>
          </label>
          {fileMsg && <p className="text-xs text-slate-600 mt-2">{fileMsg}</p>}
        </section>

        {ingresos.length > 0 && (
          <>
            {/* Auto-conciliación por comprobante (OCR) */}
            <section className="mt-3 bg-purple-50 ring-1 ring-purple-100 rounded-2xl p-4">
              <p className="text-sm font-semibold text-slate-700">✨ Auto-conciliar</p>
              <p className="text-xs text-slate-500 mt-0.5">
                Identifica la casa por el concepto del banco (C152, casa 220…) y por los
                comprobantes que subieron los vecinos. Lo seguro se aprueba solo; las casas
                sugeridas quedan pre-llenadas abajo para que las confirmes.
              </p>
              <button
                onClick={autoConciliar}
                disabled={autoBusy}
                className="mt-2 rounded-xl bg-nexia text-white text-sm font-semibold px-4 py-2 hover:opacity-90 disabled:opacity-40"
              >
                {autoBusy ? "Conciliando…" : "Auto-conciliar"}
              </button>
              {autoResumen && <p className="text-xs text-slate-600 mt-2">{autoResumen}</p>}
            </section>

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
                        : r.estado === "propuesta"
                        ? "bg-amber-50 ring-amber-200"
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
                            disabled={r.estado === "ok" || r.estado === "dup" || r.estado === "propuesta"}
                            placeholder="N°"
                            className="w-20 rounded-lg ring-1 ring-slate-200 px-2 py-1 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
                          />
                          {r.sugerida && r.estado === "" && (
                            <span className="text-[10px] font-semibold text-brand-600 bg-brand-50 rounded-full px-2 py-0.5">
                              sugerida
                            </span>
                          )}
                          {r.estado === "propuesta" && (
                            <span className="text-[10px] font-semibold text-amber-700 bg-amber-100 rounded-full px-2 py-0.5">
                              propuesta · monto+fecha
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

                        {/* Propuesta por monto+fecha: comprobante del vecino que cuadra */}
                        {r.estado === "propuesta" && r.propuestas && (
                          <div className="mt-2 rounded-xl bg-white ring-1 ring-amber-200 p-2">
                            <p className="text-[11px] text-amber-800 font-semibold">
                              Coincide con {r.propuestas.length === 1 ? "un comprobante" : `${r.propuestas.length} comprobantes`} de vecino
                            </p>
                            {r.propuestas.length > 1 && (
                              <select
                                value={r.propuestaSel}
                                onChange={(e) => setRow(r.key, { propuestaSel: e.target.value, casa: r.propuestas!.find((p) => p.abonoId === e.target.value)?.casa ?? r.casa })}
                                className="mt-1 w-full rounded-lg ring-1 ring-amber-200 px-2 py-1 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-amber-300"
                              >
                                {r.propuestas.map((p) => (
                                  <option key={p.abonoId} value={p.abonoId}>
                                    Casa {p.casa}{p.fechaOcr ? ` · ${p.fechaOcr}` : ""}
                                  </option>
                                ))}
                              </select>
                            )}
                            {(() => {
                              const sel = r.propuestas!.find((p) => p.abonoId === r.propuestaSel) ?? r.propuestas![0];
                              return (
                                <div className="mt-2 flex items-center gap-2">
                                  {sel.comprobanteUrl ? (
                                    <a href={sel.comprobanteUrl} target="_blank" rel="noopener noreferrer" className="shrink-0">
                                      {/* comprobante del vecino — Storage remoto, sin config next/image */}
                                      {/* eslint-disable-next-line @next/next/no-img-element */}
                                      <img
                                        src={sel.comprobanteUrl}
                                        alt="Comprobante"
                                        className="w-12 h-12 rounded-lg object-cover ring-1 ring-amber-200"
                                      />
                                    </a>
                                  ) : (
                                    <span className="w-12 h-12 rounded-lg bg-amber-100 grid place-items-center text-amber-500 text-lg shrink-0">🧾</span>
                                  )}
                                  <div className="min-w-0 flex-1">
                                    <p className="text-xs text-slate-600">
                                      Casa <span className="font-bold">{sel.casa}</span>
                                      {sel.fechaOcr ? ` · comprobante ${sel.fechaOcr}` : ""}
                                    </p>
                                  </div>
                                </div>
                              );
                            })()}
                            <div className="mt-2 flex items-center gap-2">
                              <button
                                onClick={() => aprobarPropuesta(r.key)}
                                className="rounded-lg bg-emerald-600 text-white text-xs font-semibold px-3 py-1.5 hover:opacity-90"
                              >
                                Aprobar
                              </button>
                              <button
                                onClick={() => descartarPropuesta(r.key)}
                                className="rounded-lg bg-slate-100 text-slate-600 text-xs font-semibold px-3 py-1.5 hover:bg-slate-200"
                              >
                                Descartar
                              </button>
                            </div>
                          </div>
                        )}
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
