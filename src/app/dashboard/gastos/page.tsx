"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { runOrError } from "@/lib/rpc";

type Gasto = {
  id: string;
  concepto: string;
  monto: number;
  categoria: string;
  fecha_pago: string;
  descripcion: string | null;
  archivo_principal_url: string | null;
  estado: string;
  concepto_banco: string | null;
  improvement_id: string | null;
};

type Proyecto = { id: string; titulo: string; estado: string };

// Edición en la bandeja "sin clasificar" (una por gasto)
type Clasif = {
  concepto: string;
  categoria: string;
  improvementId: string;
  keyword: string;
  busy?: boolean;
  msg?: string;
};

const BUCKET = "vecino-evidencias";

const money = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);
const fecha = (d: string) =>
  new Date(d + "T00:00:00").toLocaleDateString("es-MX", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
const hoyISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
};

// Colores fijos por categoría conocida (cae a gris si no está)
const COLOR: Record<string, string> = {
  Vigilancia_Insumos: "bg-slate-600",
  Vigilancia: "bg-slate-600",
  CFE: "bg-amber-500",
  "CFE (Luz)": "bg-amber-500",
  Jardineria: "bg-emerald-500",
  Jardinería: "bg-emerald-500",
  Alberca: "bg-sky-500",
  Fumigacion: "bg-lime-600",
  Fumigación: "bg-lime-600",
  SAT: "bg-red-500",
  "Impuestos (SAT)": "bg-red-500",
  Basura: "bg-orange-500",
  Limpieza: "bg-cyan-600",
  "JUMAPA (Agua)": "bg-blue-500",
  Otros: "bg-purple-500",
};

// Deriva la "firma" del proveedor del concepto del banco, para que el sistema
// aprenda proveedor→categoría (expense_cat_map). Es un substring LITERAL que
// reaparecerá en pagos futuros al mismo proveedor. El admin puede editarla.
const STOPWORDS = new Set([
  "SPEI", "ENVIADO", "RECIBIDO", "PAGO", "CUENTA", "TERCERO", "BNET", "TRASPASO",
  "MTTO", "CORTE", "1ER", "2O", "2DO", "3ER", "LIQUID", "ARREGLO", "REP",
  "ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC",
  "ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO", "JULIO", "AGOSTO",
  "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE",
  "BBVA", "BANORTE", "SANTANDER", "BANAMEX", "INBURSA", "AZTECA", "BANCOPPEL",
  "BANREGIO", "HSBC", "SCOTIABANK", "AUT", "REF", "GUIA", "CIE", "FOLIO",
]);

function derivarKeyword(conceptoBanco: string | null): string {
  const c = String(conceptoBanco ?? "").toUpperCase();
  if (!c) return "";
  // 1) RFC del proveedor (identifica al comercio aunque cambie el texto libre)
  const rfc = c.match(/RFC[:.]?\s*([A-Z&Ñ]{3,4}\s?\d{6}[A-Z0-9]{0,3})/);
  if (rfc) return rfc[1].trim();
  // 2) Comercio antes de "/" (pagos con tarjeta/servicio), si no es genérico
  const prefix = c.split("/")[0].trim();
  if (
    prefix.length >= 4 &&
    !/^(SPEI|PAGO|TRASPASO|RETIRO|SERV|IVA|COM)/.test(prefix) &&
    /[A-Z]{4,}/.test(prefix)
  )
    return prefix.slice(0, 30);
  // 3) Transferencias: primeras palabras significativas del texto libre
  const words = c
    .replace(/[^A-ZÑ ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  return words.slice(0, 2).join(" ");
}

export default function GastosPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [coloniaId, setColoniaId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [gastos, setGastos] = useState<Gasto[]>([]);
  const [proyectos, setProyectos] = useState<Proyecto[]>([]);
  const [clasif, setClasif] = useState<Record<string, Clasif>>({});

  const [concepto, setConcepto] = useState("");
  const [monto, setMonto] = useState("");
  const [categoria, setCategoria] = useState("");
  const [proyectoId, setProyectoId] = useState("");
  const [fechaPago, setFechaPago] = useState(hoyISO());
  const [descripcion, setDescripcion] = useState("");
  const [archivo, setArchivo] = useState<File | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [listMsg, setListMsg] = useState<string | null>(null);
  const [borrando, setBorrando] = useState<Set<string>>(new Set());

  const cargarGastos = useCallback(async () => {
    const [{ data }, { data: pr }] = await Promise.all([
      supabaseBrowser
        .from("colonia_expenses")
        .select(
          "id, concepto, monto, categoria, fecha_pago, descripcion, archivo_principal_url, estado, concepto_banco, improvement_id"
        )
        .order("fecha_pago", { ascending: false })
        .limit(200),
      supabaseBrowser
        .from("improvement_projects")
        .select("id, titulo, estado")
        .neq("estado", "cancelado")
        .order("created_at", { ascending: false }),
    ]);
    const list = (data as unknown as Gasto[]) ?? [];
    setGastos(list);
    setProyectos((pr as unknown as Proyecto[]) ?? []);
    // Pre-llenar la edición de la bandeja (sin pisar lo que el admin ya escribió)
    setClasif((prev) => {
      const next = { ...prev };
      for (const g of list) {
        if (g.estado === "sin_clasificar" && !next[g.id]) {
          next[g.id] = {
            concepto: "",
            categoria: g.categoria !== "Otros" ? g.categoria : "",
            improvementId: g.improvement_id ?? "",
            keyword: derivarKeyword(g.concepto_banco ?? g.concepto),
          };
        }
      }
      return next;
    });
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
      setUserId(user.id);
      await cargarGastos();
      setReady(true);
    })();
  }, [router, cargarGastos]);

  async function subirArchivo(file: File): Promise<string | null> {
    if (!coloniaId) return null;
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const path = `${coloniaId}/gastos/${crypto.randomUUID()}.${ext}`;
    const { error } = await supabaseBrowser.storage.from(BUCKET).upload(path, file);
    if (error) return null;
    return supabaseBrowser.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  }

  function setC(id: string, patch: Partial<Clasif>) {
    setClasif((m) => ({ ...m, [id]: { ...m[id], ...patch } }));
  }

  // Clasificar un gasto de la bandeja: razón + categoría + proyecto. El servidor
  // APRENDE la firma del proveedor para autosugerir la próxima vez.
  async function clasificar(g: Gasto) {
    const c = clasif[g.id];
    if (!c) return;
    if (!c.concepto.trim()) return setC(g.id, { msg: "Escribe la razón del gasto." });
    if (!c.categoria.trim()) return setC(g.id, { msg: "Elige una categoría." });
    setC(g.id, { busy: true, msg: undefined });
    const { error } = await supabaseBrowser.rpc("clasificar_gasto", {
      p_id: g.id,
      p_concepto: c.concepto.trim(),
      p_categoria: c.categoria.trim(),
      p_improvement_id: c.improvementId || null,
      p_keyword: c.keyword.trim() || null,
    });
    if (error) return setC(g.id, { busy: false, msg: error.message.replace(/^.*?:\s/, "") });
    setClasif((m) => {
      const n = { ...m };
      delete n[g.id];
      return n;
    });
    await cargarGastos();
  }

  async function registrar() {
    setMsg(null);
    if (!concepto.trim()) return setMsg("Escribe el concepto.");
    const m = parseFloat(monto);
    if (!m || m <= 0) return setMsg("El monto debe ser mayor a 0.");
    if (!categoria.trim()) return setMsg("Elige o escribe una categoría.");
    if (!coloniaId) return setMsg("Sin colonia.");
    setBusy(true);
    const url = archivo ? await subirArchivo(archivo) : null;
    if (archivo && !url) {
      setBusy(false);
      return setMsg("No se pudo subir el comprobante. Revisa tu conexión e intenta de nuevo.");
    }
    const { error } = await supabaseBrowser.from("colonia_expenses").insert({
      colonia_id: coloniaId,
      concepto: concepto.trim(),
      monto: m,
      categoria: categoria.trim(),
      fecha_pago: fechaPago,
      descripcion: descripcion.trim() || null,
      archivo_principal_url: url,
      improvement_id: proyectoId || null,
      registrado_por: userId,
    });
    setBusy(false);
    if (error) return setMsg(error.message.replace(/^.*?:\s/, ""));
    setConcepto("");
    setMonto("");
    setCategoria("");
    setProyectoId("");
    setDescripcion("");
    setArchivo(null);
    setFechaPago(hoyISO());
    await cargarGastos();
  }

  async function eliminar(id: string) {
    if (borrando.has(id)) return;
    if (!confirm("¿Eliminar este gasto? Esta acción no se puede deshacer.")) return;
    setListMsg(null);
    setBorrando((s) => new Set(s).add(id));
    const res = await runOrError(() =>
      supabaseBrowser.from("colonia_expenses").delete().eq("id", id)
    );
    setBorrando((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    if (!res.ok) return setListMsg(res.error);
    await cargarGastos();
  }

  function exportarCSV() {
    const cell = (v: string | number | null) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const proyNombre = (id: string | null) => proyectos.find((p) => p.id === id)?.titulo ?? "";
    const header = ["Fecha", "Categoría", "Concepto", "Monto", "Proyecto", "Descripción"];
    const lines = gastos.map((g) =>
      [g.fecha_pago, g.categoria, g.concepto, g.monto, proyNombre(g.improvement_id), g.descripcion]
        .map(cell)
        .join(",")
    );
    const csv = [header.map(cell).join(","), ...lines].join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `gastos-${hoyISO()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (!ready)
    return (
      <main className="flex-1 flex items-center justify-center text-slate-400">Cargando…</main>
    );

  const bandeja = gastos.filter((g) => g.estado === "sin_clasificar");
  const clasificados = gastos.filter((g) => g.estado !== "sin_clasificar");
  const total = gastos.reduce((s, g) => s + Number(g.monto), 0);
  const porCat = Object.entries(
    clasificados.reduce<Record<string, number>>((acc, g) => {
      acc[g.categoria] = (acc[g.categoria] || 0) + Number(g.monto);
      return acc;
    }, {})
  ).sort((a, b) => b[1] - a[1]);
  const maxCat = porCat.length ? porCat[0][1] : 0;
  const sugerencias = Array.from(
    new Set([...Object.keys(COLOR), ...gastos.map((g) => g.categoria)])
  );
  const proyNombre = (id: string | null) => proyectos.find((p) => p.id === id)?.titulo ?? null;

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

        <h1 className="text-2xl font-bold text-slate-800 mt-4">Gastos de la colonia</h1>

        {/* ===== Bandeja: gastos del banco sin clasificar ===== */}
        {bandeja.length > 0 && (
          <section className="mt-4">
            <h2 className="text-sm font-bold text-amber-800 mb-2">
              🗂 Por clasificar{" "}
              <span className="text-amber-600 font-medium">({bandeja.length})</span>
            </h2>
            <ul className="flex flex-col gap-3">
              {bandeja.map((g) => {
                const c = clasif[g.id] ?? {
                  concepto: "",
                  categoria: "",
                  improvementId: "",
                  keyword: "",
                };
                return (
                  <li key={g.id} className="bg-amber-50 rounded-2xl ring-1 ring-amber-200 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs text-slate-500">{fecha(g.fecha_pago)}</p>
                      <p className="font-bold text-slate-800">−{money(Number(g.monto))}</p>
                    </div>
                    <p
                      className="text-xs text-slate-600 mt-1 break-all"
                      title="Concepto original del banco"
                    >
                      🏦 {g.concepto_banco ?? g.concepto}
                    </p>
                    <div className="mt-3 flex flex-col gap-2">
                      <input
                        value={c.concepto}
                        onChange={(e) => setC(g.id, { concepto: e.target.value })}
                        placeholder="Razón del gasto (ej. Reparación sistema de riego)"
                        className="w-full rounded-xl ring-1 ring-amber-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-amber-400"
                      />
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          value={c.categoria}
                          onChange={(e) => setC(g.id, { categoria: e.target.value })}
                          list="cats"
                          placeholder="Categoría"
                          className="rounded-xl ring-1 ring-amber-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-amber-400"
                        />
                        <select
                          value={c.improvementId}
                          onChange={(e) => setC(g.id, { improvementId: e.target.value })}
                          className="rounded-xl ring-1 ring-amber-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-amber-400"
                        >
                          <option value="">Sin proyecto</option>
                          {proyectos.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.titulo}
                            </option>
                          ))}
                        </select>
                      </div>
                      {g.improvement_id && c.improvementId === g.improvement_id && (
                        <p className="text-[11px] text-amber-700">
                          💡 Proyecto sugerido por pagos anteriores al mismo proveedor — confirma
                          o cámbialo.
                        </p>
                      )}
                      <label className="text-[11px] text-slate-500">
                        El sistema aprenderá esta firma del proveedor →{" "}
                        <input
                          value={c.keyword}
                          onChange={(e) => setC(g.id, { keyword: e.target.value })}
                          placeholder="(no aprender)"
                          className="mt-1 w-full rounded-lg ring-1 ring-amber-200 bg-white px-2 py-1 text-xs text-slate-700 outline-none focus:ring-2 focus:ring-amber-400"
                        />
                      </label>
                      {c.msg && (
                        <p className="text-xs text-red-600 bg-red-50 rounded-lg px-2 py-1.5 ring-1 ring-red-200">
                          {c.msg}
                        </p>
                      )}
                      <button
                        onClick={() => clasificar(g)}
                        disabled={c.busy}
                        className="rounded-xl bg-amber-600 text-white text-sm font-bold py-2.5 hover:opacity-90 disabled:opacity-40"
                      >
                        {c.busy ? "Guardando…" : "Clasificar"}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {/* Total + export */}
        <div className="mt-4 rounded-3xl p-5 bg-gradient-to-br from-slate-700 to-slate-900 text-white shadow-lg">
          <p className="text-white/70 text-sm">Total registrado</p>
          <p className="text-3xl font-extrabold mt-1">{money(total)}</p>
          <div className="flex items-center justify-between mt-1">
            <p className="text-white/70 text-sm">{gastos.length} gastos</p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => router.push("/dashboard/proyectos")}
                className="rounded-xl bg-white/20 hover:bg-white/30 px-3 py-1.5 text-xs font-semibold"
              >
                📁 Proyectos
              </button>
              <button
                onClick={exportarCSV}
                disabled={gastos.length === 0}
                className="rounded-xl bg-white/20 hover:bg-white/30 px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
              >
                ⬇ Exportar CSV
              </button>
            </div>
          </div>
        </div>

        {/* Desglose por categoría */}
        {porCat.length > 0 && (
          <section className="mt-5">
            <h2 className="text-sm font-bold text-slate-700 mb-2">Por categoría</h2>
            <ul className="flex flex-col gap-2.5">
              {porCat.map(([cat, val]) => (
                <li key={cat}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-700 font-medium">{cat}</span>
                    <span className="text-slate-500">
                      {money(val)} · {Math.round((val / total) * 100)}%
                    </span>
                  </div>
                  <div className="mt-1 h-2.5 rounded-full bg-slate-100 overflow-hidden">
                    <div
                      className={`h-full ${COLOR[cat] ?? "bg-brand-500"}`}
                      style={{ width: `${maxCat > 0 ? (val / maxCat) * 100 : 0}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Registrar gasto */}
        <section className="mt-6">
          <h2 className="text-sm font-bold text-slate-700 mb-2">Registrar gasto (efectivo/manual)</h2>
          <div className="bg-white rounded-2xl ring-1 ring-slate-100 p-4 flex flex-col gap-3">
            <input
              value={concepto}
              onChange={(e) => setConcepto(e.target.value)}
              placeholder="Concepto (ej. Pago de luz CFE)"
              className="w-full rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                value={monto}
                onChange={(e) => setMonto(e.target.value)}
                type="number"
                placeholder="$ Monto"
                className="rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
              />
              <input
                value={fechaPago}
                onChange={(e) => setFechaPago(e.target.value)}
                type="date"
                className="rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input
                value={categoria}
                onChange={(e) => setCategoria(e.target.value)}
                list="cats"
                placeholder="Categoría"
                className="rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
              />
              <select
                value={proyectoId}
                onChange={(e) => setProyectoId(e.target.value)}
                className="rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
              >
                <option value="">Sin proyecto</option>
                {proyectos.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.titulo}
                  </option>
                ))}
              </select>
            </div>
            <datalist id="cats">
              {sugerencias.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            <input
              value={descripcion}
              onChange={(e) => setDescripcion(e.target.value)}
              placeholder="Descripción (opcional)"
              className="w-full rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
            />
            <label className="text-xs text-slate-500">
              Comprobante (opcional)
              <input
                type="file"
                accept="image/*,application/pdf"
                onChange={(e) => setArchivo(e.target.files?.[0] ?? null)}
                className="mt-1 w-full text-xs text-slate-600 file:mr-2 file:rounded-lg file:border-0 file:bg-brand-50 file:text-brand-700 file:px-2 file:py-1.5 file:font-semibold"
              />
            </label>
            {msg && (
              <p className="text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2 ring-1 ring-red-200">
                {msg}
              </p>
            )}
            <button
              onClick={registrar}
              disabled={busy}
              className="rounded-2xl bg-gradient-to-br from-brand-500 to-emerald-600 text-white py-3 font-extrabold shadow-lg disabled:opacity-40 active:scale-[0.99] transition"
            >
              {busy ? "Guardando…" : "Guardar gasto"}
            </button>
          </div>
        </section>

        {/* Lista de gastos */}
        <section className="mt-6 mb-6">
          <h2 className="text-sm font-bold text-slate-700 mb-2">
            Movimientos <span className="text-slate-400 font-medium">({gastos.length})</span>
          </h2>
          {listMsg && (
            <p className="text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2 ring-1 ring-red-200 mb-2">
              {listMsg}
            </p>
          )}
          {gastos.length === 0 ? (
            <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
              Aún no hay gastos registrados.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {clasificados.map((g) => (
                <li
                  key={g.id}
                  className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <p
                      className="font-semibold text-slate-800 truncate"
                      title={g.concepto_banco ?? undefined}
                    >
                      {g.concepto}
                    </p>
                    <p className="text-xs text-slate-500 truncate">
                      {g.categoria} · {fecha(g.fecha_pago)}
                      {g.descripcion ? ` · ${g.descripcion}` : ""}
                    </p>
                    {proyNombre(g.improvement_id) && (
                      <span className="inline-block mt-1 text-[10px] font-semibold text-indigo-700 bg-indigo-50 rounded-full px-2 py-0.5">
                        📁 {proyNombre(g.improvement_id)}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {g.archivo_principal_url && (
                      <a
                        href={g.archivo_principal_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-base"
                        title="Ver comprobante"
                      >
                        📎
                      </a>
                    )}
                    <span className="font-bold text-slate-700">{money(Number(g.monto))}</span>
                    <button
                      onClick={() => eliminar(g.id)}
                      disabled={borrando.has(g.id)}
                      className="text-slate-300 hover:text-red-500 text-lg leading-none disabled:opacity-40 px-1"
                      title="Eliminar"
                    >
                      ×
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
