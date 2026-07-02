"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { runOrError } from "@/lib/rpc";
import { COLOR_CATEGORIA, canon } from "@/lib/categorias";

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
  es_bien: boolean;
};

type Proyecto = { id: string; titulo: string; estado: string };
type Cat = { id: string; nombre: string; activa: boolean; orden: number };

// Edición en la bandeja "sin clasificar" y al RE-clasificar un gasto ya clasificado
type Clasif = {
  concepto: string;
  categoria: string;
  improvementId: string;
  keyword: string;
  esBien: boolean;
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
  const [filtro, setFiltro] = useState<string>(""); // "" = todas · categoría exacta · "__bien"
  // Catálogo de categorías administrable (tabla expense_categories, migr. 041)
  const [cats, setCats] = useState<Cat[]>([]);
  const [gestorOpen, setGestorOpen] = useState(false);
  const [nuevaCat, setNuevaCat] = useState("");
  const [catMsg, setCatMsg] = useState<string | null>(null);
  const [catBusy, setCatBusy] = useState(false);
  const [editCat, setEditCat] = useState<Record<string, string>>({});

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

  const cargarCategorias = useCallback(async () => {
    const { data } = await supabaseBrowser
      .from("expense_categories")
      .select("id, nombre, activa, orden")
      .order("orden", { ascending: true })
      .order("nombre", { ascending: true });
    setCats((data as unknown as Cat[]) ?? []);
  }, []);

  const cargarGastos = useCallback(async () => {
    const [{ data }, { data: pr }] = await Promise.all([
      supabaseBrowser
        .from("colonia_expenses")
        .select(
          "id, concepto, monto, categoria, fecha_pago, descripcion, archivo_principal_url, estado, concepto_banco, improvement_id, es_bien"
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
            esBien: false,
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
      await Promise.all([cargarGastos(), cargarCategorias()]);
      setReady(true);
    })();
  }, [router, cargarGastos, cargarCategorias]);

  // ---- Gestor de categorías (comité) ----------------------------------------
  async function crearCategoria() {
    const nombre = nuevaCat.trim();
    if (!nombre) return;
    setCatBusy(true);
    setCatMsg(null);
    const { data, error } = await supabaseBrowser.rpc("crear_categoria", { p_nombre: nombre });
    setCatBusy(false);
    if (error) return setCatMsg(error.message.replace(/^.*?:\s/, ""));
    setNuevaCat("");
    if ((data as { reactivada?: boolean })?.reactivada) setCatMsg("Esa categoría estaba desactivada — la reactivé.");
    await cargarCategorias();
  }

  async function renombrarCategoria(id: string) {
    const nombre = (editCat[id] ?? "").trim();
    if (!nombre) return;
    const { error } = await supabaseBrowser.rpc("renombrar_categoria", { p_id: id, p_nombre: nombre });
    if (error) return setCatMsg(error.message.replace(/^.*?:\s/, ""));
    setEditCat((m) => {
      const n = { ...m };
      delete n[id];
      return n;
    });
    await Promise.all([cargarCategorias(), cargarGastos()]);
  }

  async function toggleCategoria(id: string, activa: boolean) {
    const { error } = await supabaseBrowser.rpc("set_categoria_activa", { p_id: id, p_activa: activa });
    if (error) return setCatMsg(error.message.replace(/^.*?:\s/, ""));
    await cargarCategorias();
  }

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
      p_es_bien: c.esBien,
    });
    if (error) return setC(g.id, { busy: false, msg: error.message.replace(/^.*?:\s/, "") });
    setClasif((m) => {
      const n = { ...m };
      delete n[g.id];
      return n;
    });
    await cargarGastos();
  }

  // Abrir edición de un gasto YA clasificado (asignar proyecto/razón/bien después)
  function editarGasto(g: Gasto) {
    setClasif((m) => ({
      ...m,
      [g.id]: {
        concepto: g.concepto,
        categoria: canon(g.categoria),
        improvementId: g.improvement_id ?? "",
        keyword: "",
        esBien: g.es_bien,
      },
    }));
  }

  function cancelarEdicion(id: string) {
    setClasif((m) => {
      const n = { ...m };
      delete n[id];
      return n;
    });
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
  const clasificadosTodos = gastos.filter((g) => g.estado !== "sin_clasificar");
  const total = gastos.reduce((s, g) => s + Number(g.monto), 0);
  const porCat = Object.entries(
    clasificadosTodos.reduce<Record<string, number>>((acc, g) => {
      acc[canon(g.categoria)] = (acc[canon(g.categoria)] || 0) + Number(g.monto);
      return acc;
    }, {})
  ).sort((a, b) => b[1] - a[1]);
  // Lista visible según el filtro activo (categoría o bienes)
  const clasificados = clasificadosTodos.filter((g) =>
    filtro === "" ? true : filtro === "__bien" ? g.es_bien : canon(g.categoria) === filtro
  );
  const nBienes = clasificadosTodos.filter((g) => g.es_bien).length;
  const proyNombre = (id: string | null) => proyectos.find((p) => p.id === id)?.titulo ?? null;

  // Gasto por mes (todos los gastos, por fecha_pago) para la gráfica mensual
  const porMesMap = gastos.reduce<Record<string, number>>((acc, g) => {
    const ym = g.fecha_pago.slice(0, 7);
    acc[ym] = (acc[ym] || 0) + Number(g.monto);
    return acc;
  }, {});
  const porMes = Object.entries(porMesMap)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-8); // últimos 8 meses con actividad
  const maxMes = porMes.length ? Math.max(...porMes.map(([, v]) => v)) : 0;
  const promedioMes = porMes.length
    ? porMes.reduce((s, [, v]) => s + v, 0) / porMes.length
    : 0;
  const mesLabel = (ym: string) => {
    const M = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
    return M[parseInt(ym.slice(5), 10) - 1] ?? ym.slice(5);
  };

  // Categorías activas para los dropdowns. Incluye el valor actual aunque esté
  // desactivado (para no perder la selección al editar un gasto viejo).
  const catsActivas = cats.filter((c) => c.activa).map((c) => c.nombre);
  const opcionesCat = (actual?: string) =>
    actual && !catsActivas.includes(actual) ? [actual, ...catsActivas] : catsActivas;
  // Monto por categoría para el conteo de los chips
  const montoCat: Record<string, number> = Object.fromEntries(porCat);
  const countCat: Record<string, number> = {};
  for (const g of clasificadosTodos) countCat[canon(g.categoria)] = (countCat[canon(g.categoria)] || 0) + 1;

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
                        <select
                          value={c.categoria}
                          onChange={(e) => setC(g.id, { categoria: e.target.value })}
                          className="rounded-xl ring-1 ring-amber-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-amber-400"
                        >
                          <option value="">Categoría…</option>
                          {opcionesCat(c.categoria).map((cat) => (
                            <option key={cat} value={cat}>
                              {cat}
                            </option>
                          ))}
                        </select>
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
                      <label className="flex items-center gap-2 text-xs text-slate-600">
                        <input
                          type="checkbox"
                          checked={c.esBien}
                          onChange={(e) => setC(g.id, { esBien: e.target.checked })}
                          className="w-4 h-4 accent-amber-600"
                        />
                        🪑 Es un bien de la villa (queda en el inventario)
                      </label>
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

        {/* Gasto mensual + promedio del mes */}
        <div className="mt-4 rounded-3xl p-5 bg-gradient-to-br from-slate-700 to-slate-900 text-white shadow-lg">
          <div className="flex items-end justify-between">
            <div>
              <p className="text-white/70 text-sm">Promedio por mes</p>
              <p className="text-3xl font-extrabold mt-0.5">{money(promedioMes)}</p>
            </div>
            <div className="text-right">
              <p className="text-white/60 text-xs">Total · {gastos.length} gastos</p>
              <p className="text-lg font-bold text-white/90">{money(total)}</p>
            </div>
          </div>

          {/* Gráfica de barras por mes */}
          {porMes.length > 0 && (
            <div className="mt-4 flex items-end justify-between gap-1.5 h-28">
              {porMes.map(([ym, val]) => {
                const h = maxMes > 0 ? Math.max(6, (val / maxMes) * 100) : 6;
                const sobreProm = val > promedioMes;
                return (
                  <div key={ym} className="flex-1 flex flex-col items-center justify-end gap-1 min-w-0">
                    <span className="text-[9px] text-white/70 tabular-nums">
                      {val >= 1000 ? `${Math.round(val / 1000)}k` : Math.round(val)}
                    </span>
                    <div
                      className={`w-full rounded-t-md ${sobreProm ? "bg-amber-400" : "bg-emerald-400/80"}`}
                      style={{ height: `${h}%` }}
                      title={`${mesLabel(ym)} ${ym.slice(0, 4)}: ${money(val)}`}
                    />
                    <span className="text-[9px] text-white/70">{mesLabel(ym)}</span>
                  </div>
                );
              })}
            </div>
          )}
          <p className="text-[10px] text-white/50 mt-2">
            <span className="inline-block w-2 h-2 rounded-sm bg-amber-400 align-middle" /> sobre el
            promedio ·{" "}
            <span className="inline-block w-2 h-2 rounded-sm bg-emerald-400/80 align-middle" /> debajo
          </p>

          <div className="flex items-center gap-2 mt-3">
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

        {/* Desglose por categoría — gráfica de barras (foto visual del gasto) */}
        {porCat.length > 0 && (
          <section className="mt-5">
            <h2 className="text-sm font-bold text-slate-700 mb-2">Por categoría</h2>
            <ul className="flex flex-col gap-2.5 bg-white rounded-2xl ring-1 ring-slate-100 p-4">
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
                      className={`h-full ${COLOR_CATEGORIA[cat] ?? "bg-brand-500"}`}
                      style={{ width: `${porCat[0][1] > 0 ? (val / porCat[0][1]) * 100 : 0}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Filtro por categoría — CHIPS (una pastilla por categoría con monto) */}
        {porCat.length > 0 && (
          <section className="mt-5">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-bold text-slate-700">Filtrar por categoría</h2>
              {filtro !== "" && (
                <button
                  onClick={() => setFiltro("")}
                  className="text-xs font-semibold text-brand-600 hover:underline"
                >
                  ✕ Quitar filtro
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setFiltro("")}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold ring-1 transition ${
                  filtro === ""
                    ? "bg-brand-500 text-white ring-brand-500"
                    : "bg-white text-slate-600 ring-slate-200 hover:ring-brand-300"
                }`}
              >
                Todas ({clasificadosTodos.length})
              </button>
              {porCat.map(([cat]) => {
                const activo = filtro === cat;
                return (
                  <button
                    key={cat}
                    onClick={() => setFiltro(activo ? "" : cat)}
                    className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold ring-1 transition ${
                      activo
                        ? "bg-brand-500 text-white ring-brand-500"
                        : "bg-white text-slate-600 ring-slate-200 hover:ring-brand-300"
                    }`}
                  >
                    <span
                      className={`w-2 h-2 rounded-full ${COLOR_CATEGORIA[cat] ?? "bg-brand-400"}`}
                    />
                    {cat} ({countCat[cat] ?? 0})
                  </button>
                );
              })}
              {nBienes > 0 && (
                <button
                  onClick={() => setFiltro(filtro === "__bien" ? "" : "__bien")}
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold ring-1 transition ${
                    filtro === "__bien"
                      ? "bg-teal-500 text-white ring-teal-500"
                      : "bg-white text-teal-700 ring-teal-200 hover:ring-teal-300"
                  }`}
                >
                  🪑 Bienes ({nBienes})
                </button>
              )}
            </div>
            {filtro !== "" && filtro !== "__bien" && (
              <p className="mt-2 text-xs text-slate-500">
                {countCat[filtro] ?? 0} gastos · {money(montoCat[filtro] ?? 0)} en {filtro}
              </p>
            )}
          </section>
        )}

        {/* Gestor de categorías (comité): crear / renombrar / desactivar */}
        <section className="mt-4">
          <button
            onClick={() => setGestorOpen((v) => !v)}
            className="w-full flex items-center justify-between text-sm font-semibold text-slate-600 bg-white rounded-2xl ring-1 ring-slate-100 px-4 py-3 hover:ring-brand-200 transition"
          >
            <span>⚙️ Administrar categorías</span>
            <span className="text-slate-400">{gestorOpen ? "▲" : "▼"}</span>
          </button>
          {gestorOpen && (
            <div className="mt-2 bg-white rounded-2xl ring-1 ring-slate-100 p-4 flex flex-col gap-3">
              {/* Crear nueva */}
              <div className="flex gap-2">
                <input
                  value={nuevaCat}
                  onChange={(e) => setNuevaCat(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && crearCategoria()}
                  placeholder="Nueva categoría (ej. Insumos caseta)"
                  className="flex-1 rounded-xl ring-1 ring-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
                />
                <button
                  onClick={crearCategoria}
                  disabled={catBusy || !nuevaCat.trim()}
                  className="rounded-xl bg-brand-500 text-white text-sm font-bold px-4 disabled:opacity-40"
                >
                  ➕ Crear
                </button>
              </div>
              {catMsg && <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-2 py-1.5">{catMsg}</p>}
              {/* Lista administrable */}
              <ul className="flex flex-col gap-1.5">
                {cats.map((cat) => {
                  const editando = editCat[cat.id] !== undefined;
                  return (
                    <li
                      key={cat.id}
                      className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm ring-1 ${
                        cat.activa ? "bg-slate-50 ring-slate-100" : "bg-slate-100/60 ring-slate-200 opacity-60"
                      }`}
                    >
                      {editando ? (
                        <>
                          <input
                            value={editCat[cat.id]}
                            onChange={(e) => setEditCat((m) => ({ ...m, [cat.id]: e.target.value }))}
                            onKeyDown={(e) => e.key === "Enter" && renombrarCategoria(cat.id)}
                            className="flex-1 rounded-lg ring-1 ring-brand-300 px-2 py-1 text-sm outline-none"
                            autoFocus
                          />
                          <button
                            onClick={() => renombrarCategoria(cat.id)}
                            className="text-xs font-bold text-brand-600"
                          >
                            Guardar
                          </button>
                          <button
                            onClick={() => setEditCat((m) => { const n = { ...m }; delete n[cat.id]; return n; })}
                            className="text-xs text-slate-400"
                          >
                            ✕
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="flex-1 text-slate-700">
                            {cat.nombre}
                            {!cat.activa && <span className="text-[10px] text-slate-400"> · oculta</span>}
                          </span>
                          <button
                            onClick={() => setEditCat((m) => ({ ...m, [cat.id]: cat.nombre }))}
                            className="text-slate-400 hover:text-brand-600 px-1"
                            title="Renombrar"
                          >
                            ✎
                          </button>
                          <button
                            onClick={() => toggleCategoria(cat.id, !cat.activa)}
                            className="text-slate-400 hover:text-slate-700 px-1"
                            title={cat.activa ? "Ocultar del menú" : "Reactivar"}
                          >
                            {cat.activa ? "⊘" : "↺"}
                          </button>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
              <p className="text-[11px] text-slate-400">
                Renombrar arrastra los gastos que ya usaban ese nombre. Ocultar no borra nada:
                el histórico conserva su categoría, solo desaparece del menú al capturar.
              </p>
            </div>
          )}
        </section>

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
              <select
                value={categoria}
                onChange={(e) => setCategoria(e.target.value)}
                className="rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
              >
                <option value="">Categoría…</option>
                {opcionesCat(categoria).map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
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
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-bold text-slate-700">
              Movimientos{" "}
              <span className="text-slate-400 font-medium">({clasificados.length})</span>
            </h2>
            {filtro !== "" && (
              <span className="text-xs font-semibold text-brand-700 bg-brand-50 rounded-full px-2.5 py-0.5">
                {filtro === "__bien" ? "🪑 Bienes" : filtro}
                <button onClick={() => setFiltro("")} className="ml-1.5 text-brand-500">
                  ✕
                </button>
              </span>
            )}
          </div>
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
              {clasificados.map((g) => {
                const c = clasif[g.id]; // presente = editando este gasto
                return (
                  <li key={g.id} className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100">
                    <div className="flex items-center justify-between gap-2">
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
                        <div className="flex items-center gap-1 flex-wrap">
                          {proyNombre(g.improvement_id) && (
                            <span className="inline-block mt-1 text-[10px] font-semibold text-indigo-700 bg-indigo-50 rounded-full px-2 py-0.5">
                              📁 {proyNombre(g.improvement_id)}
                            </span>
                          )}
                          {g.es_bien && (
                            <span className="inline-block mt-1 text-[10px] font-semibold text-teal-700 bg-teal-50 rounded-full px-2 py-0.5">
                              🪑 bien de la villa
                            </span>
                          )}
                        </div>
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
                          onClick={() => (c ? cancelarEdicion(g.id) : editarGasto(g))}
                          className="text-slate-400 hover:text-brand-600 text-sm px-1"
                          title="Editar / asignar proyecto"
                        >
                          ✎
                        </button>
                        <button
                          onClick={() => eliminar(g.id)}
                          disabled={borrando.has(g.id)}
                          className="text-slate-300 hover:text-red-500 text-lg leading-none disabled:opacity-40 px-1"
                          title="Eliminar"
                        >
                          ×
                        </button>
                      </div>
                    </div>

                    {/* Edición inline: razón + categoría + proyecto + bien */}
                    {c && (
                      <div className="mt-3 border-t border-slate-100 pt-3 flex flex-col gap-2">
                        <input
                          value={c.concepto}
                          onChange={(e) => setC(g.id, { concepto: e.target.value })}
                          placeholder="Razón del gasto"
                          className="w-full rounded-xl ring-1 ring-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
                        />
                        <div className="grid grid-cols-2 gap-2">
                          <select
                            value={c.categoria}
                            onChange={(e) => setC(g.id, { categoria: e.target.value })}
                            className="rounded-xl ring-1 ring-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
                          >
                            <option value="">Categoría…</option>
                            {opcionesCat(c.categoria).map((cat) => (
                              <option key={cat} value={cat}>
                                {cat}
                              </option>
                            ))}
                          </select>
                          <select
                            value={c.improvementId}
                            onChange={(e) => setC(g.id, { improvementId: e.target.value })}
                            className="rounded-xl ring-1 ring-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
                          >
                            <option value="">Sin proyecto</option>
                            {proyectos.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.titulo}
                              </option>
                            ))}
                          </select>
                        </div>
                        <label className="flex items-center gap-2 text-xs text-slate-600">
                          <input
                            type="checkbox"
                            checked={c.esBien}
                            onChange={(e) => setC(g.id, { esBien: e.target.checked })}
                            className="w-4 h-4 accent-teal-600"
                          />
                          🪑 Es un bien de la villa (queda en el inventario)
                        </label>
                        {c.msg && (
                          <p className="text-xs text-red-600 bg-red-50 rounded-lg px-2 py-1.5 ring-1 ring-red-200">
                            {c.msg}
                          </p>
                        )}
                        <div className="flex gap-2">
                          <button
                            onClick={() => clasificar(g)}
                            disabled={c.busy}
                            className="flex-1 rounded-xl bg-brand-500 text-white text-sm font-bold py-2 disabled:opacity-40"
                          >
                            {c.busy ? "Guardando…" : "Guardar"}
                          </button>
                          <button
                            onClick={() => cancelarEdicion(g.id)}
                            className="rounded-xl bg-slate-100 text-slate-600 text-sm font-semibold px-4 py-2"
                          >
                            Cancelar
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
