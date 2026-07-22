"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { runOrError } from "@/lib/rpc";

// Proyectos de mejora de la colonia (improvement_projects, migr. 002) con sus
// documentos (contrato/cotización/factura, migr. 039) y el gastado REAL =
// suma de los gastos ligados (colonia_expenses.improvement_id).

type Proyecto = {
  id: string;
  titulo: string;
  descripcion: string | null;
  presupuesto: number;
  estado: string;
  fecha_inicio: string | null;
  fecha_fin: string | null;
};

type Doc = {
  id: string;
  project_id: string;
  tipo: string;
  nombre: string;
  url: string;
};

type GastoLigado = {
  id: string;
  concepto: string;
  monto: number;
  fecha_pago: string;
  improvement_id: string | null;
};

const BUCKET = "vecino-evidencias";
const ESTADOS = ["planeado", "en_curso", "terminado", "cancelado"] as const;
const ESTADO_LABEL: Record<string, string> = {
  planeado: "Planeado",
  en_curso: "En curso",
  terminado: "Terminado",
  cancelado: "Cancelado",
};
const ESTADO_STYLE: Record<string, string> = {
  planeado: "bg-slate-100 text-slate-600",
  en_curso: "bg-sky-100 text-sky-700",
  terminado: "bg-emerald-100 text-emerald-700",
  cancelado: "bg-red-100 text-red-600",
};
const TIPO_DOC: Record<string, string> = {
  contrato: "📜 Contrato",
  cotizacion: "🧮 Cotización",
  factura: "🧾 Factura",
  otro: "📎 Documento",
};

const money = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);
const fecha = (d: string) =>
  new Date(d + "T00:00:00").toLocaleDateString("es-MX", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

export default function ProyectosPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [coloniaId, setColoniaId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [proyectos, setProyectos] = useState<Proyecto[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [gastos, setGastos] = useState<GastoLigado[]>([]);
  const [abierto, setAbierto] = useState<string | null>(null);

  // Alta de proyecto
  const [nuevoOpen, setNuevoOpen] = useState(false);
  const [titulo, setTitulo] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [presupuesto, setPresupuesto] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Subida de documento (por proyecto)
  const [docTipo, setDocTipo] = useState("cotizacion");
  const [docBusy, setDocBusy] = useState(false);
  const [docMsg, setDocMsg] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    const [{ data: pr }, { data: dd }, { data: gg }] = await Promise.all([
      supabaseBrowser
        .from("improvement_projects")
        .select("id, titulo, descripcion, presupuesto, estado, fecha_inicio, fecha_fin")
        .order("created_at", { ascending: false }),
      supabaseBrowser
        .from("project_documents")
        .select("id, project_id, tipo, nombre, url")
        .order("created_at", { ascending: true }),
      supabaseBrowser
        .from("colonia_expenses")
        .select("id, concepto, monto, fecha_pago, improvement_id")
        .not("improvement_id", "is", null)
        .order("fecha_pago", { ascending: false }),
    ]);
    setProyectos((pr as unknown as Proyecto[]) ?? []);
    setDocs((dd as unknown as Doc[]) ?? []);
    setGastos((gg as unknown as GastoLigado[]) ?? []);
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
      await cargar();
      setReady(true);
    })();
  }, [router, cargar]);

  async function crearProyecto() {
    setMsg(null);
    if (!titulo.trim()) return setMsg("Escribe el nombre del proyecto.");
    if (!coloniaId) return setMsg("Sin colonia.");
    setBusy(true);
    const { error } = await supabaseBrowser.from("improvement_projects").insert({
      colonia_id: coloniaId,
      titulo: titulo.trim(),
      descripcion: descripcion.trim() || null,
      presupuesto: parseFloat(presupuesto) || 0,
      estado: "planeado",
    });
    setBusy(false);
    if (error) return setMsg(error.message.replace(/^.*?:\s/, ""));
    setTitulo("");
    setDescripcion("");
    setPresupuesto("");
    setNuevoOpen(false);
    await cargar();
  }

  async function cambiarEstado(id: string, estado: string) {
    const res = await runOrError(() =>
      supabaseBrowser.from("improvement_projects").update({ estado }).eq("id", id)
    );
    if (res.ok) await cargar();
  }

  async function subirDoc(projectId: string, file: File) {
    if (!coloniaId) return;
    setDocBusy(true);
    setDocMsg(null);
    const ext = (file.name.split(".").pop() || "pdf").toLowerCase();
    const path = `${coloniaId}/proyectos/${projectId}/${crypto.randomUUID()}.${ext}`;
    const { error: upErr } = await supabaseBrowser.storage.from(BUCKET).upload(path, file);
    if (upErr) {
      setDocBusy(false);
      return setDocMsg("No se pudo subir el archivo. Intenta de nuevo.");
    }
    const url = supabaseBrowser.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
    const { error } = await supabaseBrowser.from("project_documents").insert({
      project_id: projectId,
      tipo: docTipo,
      nombre: file.name,
      url,
      subido_por: userId,
    });
    setDocBusy(false);
    if (error) return setDocMsg(error.message.replace(/^.*?:\s/, ""));
    await cargar();
  }

  async function borrarDoc(id: string) {
    if (!confirm("¿Quitar este documento del proyecto?")) return;
    const res = await runOrError(() =>
      supabaseBrowser.from("project_documents").delete().eq("id", id)
    );
    if (res.ok) await cargar();
  }

  if (!ready)
    return (
      <main className="flex-1 flex items-center justify-center text-slate-400">Cargando…</main>
    );

  const gastadoDe = (id: string) =>
    gastos.filter((g) => g.improvement_id === id).reduce((s, g) => s + Number(g.monto), 0);

  return (
    <main className="flex-1 bg-gradient-to-b from-brand-50 via-white to-sky-50">
      <div className="w-full max-w-md mx-auto px-5 py-6 flex flex-col">
        <div className="flex items-center justify-between">
          <button
            onClick={() => router.push("/dashboard/gastos")}
            className="text-sm text-slate-500 hover:text-slate-700"
          >
            ← Gastos
          </button>
          <Image src="/brand/vecinity-logo.svg" alt="Vecinity" width={120} height={34} priority />
        </div>

        <h1 className="text-2xl font-bold text-slate-800 mt-4">Proyectos de la colonia</h1>
        <p className="text-sm text-slate-500">
          Cada proyecto junta sus pagos, contrato y cotización — la razón detrás del gasto.
        </p>

        {/* Nuevo proyecto */}
        <section className="mt-4">
          {!nuevoOpen ? (
            <button
              onClick={() => setNuevoOpen(true)}
              className="w-full rounded-2xl bg-gradient-to-br from-brand-500 to-emerald-600 text-white py-3 font-extrabold shadow-lg active:scale-[0.99] transition"
            >
              + Nuevo proyecto
            </button>
          ) : (
            <div className="bg-white rounded-2xl ring-1 ring-slate-100 p-4 flex flex-col gap-3">
              <input
                value={titulo}
                onChange={(e) => setTitulo(e.target.value)}
                placeholder="Nombre (ej. Sistema RFID de acceso)"
                className="w-full rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
              />
              <input
                value={descripcion}
                onChange={(e) => setDescripcion(e.target.value)}
                placeholder="Descripción (opcional)"
                className="w-full rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
              />
              <input
                value={presupuesto}
                onChange={(e) => setPresupuesto(e.target.value)}
                type="number"
                placeholder="$ Presupuesto (opcional)"
                className="w-full rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
              />
              {msg && (
                <p className="text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2 ring-1 ring-red-200">
                  {msg}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={crearProyecto}
                  disabled={busy}
                  className="press flex-1 rounded-xl bg-brand-500 text-white py-2.5 font-bold disabled:opacity-40"
                >
                  {busy ? "Creando…" : "Crear"}
                </button>
                <button
                  onClick={() => setNuevoOpen(false)}
                  className="rounded-xl bg-slate-100 text-slate-600 px-4 py-2.5 font-semibold"
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Lista de proyectos */}
        <section className="mt-5 mb-6">
          {proyectos.length === 0 ? (
            <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
              Aún no hay proyectos. Crea el primero (ej. el sistema RFID).
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {proyectos.map((p) => {
                const gastado = gastadoDe(p.id);
                const pDocs = docs.filter((d) => d.project_id === p.id);
                const pGastos = gastos.filter((g) => g.improvement_id === p.id);
                const open = abierto === p.id;
                const pct =
                  Number(p.presupuesto) > 0
                    ? Math.min(100, Math.round((gastado / Number(p.presupuesto)) * 100))
                    : null;
                return (
                  <li key={p.id} className="bg-white rounded-2xl ring-1 ring-slate-100 p-4">
                    <button
                      onClick={() => setAbierto(open ? null : p.id)}
                      className="w-full text-left"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-bold text-slate-800 truncate">{p.titulo}</p>
                        <span
                          className={`shrink-0 text-[10px] font-semibold rounded-full px-2 py-0.5 ${ESTADO_STYLE[p.estado] ?? "bg-slate-100 text-slate-600"}`}
                        >
                          {ESTADO_LABEL[p.estado] ?? p.estado}
                        </span>
                      </div>
                      <div className="flex items-center justify-between mt-1">
                        <p className="text-xs text-slate-500">
                          {pGastos.length} pagos · {pDocs.length} docs
                        </p>
                        <p className="text-sm font-bold text-slate-700">{money(gastado)}</p>
                      </div>
                      {pct !== null && (
                        <>
                          <div className="mt-1.5 h-2 rounded-full bg-slate-100 overflow-hidden">
                            <div
                              className={`h-full ${pct >= 100 ? "bg-red-500" : "bg-brand-500"}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <p className="text-[10px] text-slate-400 mt-0.5">
                            {pct}% del presupuesto ({money(Number(p.presupuesto))})
                          </p>
                        </>
                      )}
                    </button>

                    {open && (
                      <div className="mt-3 border-t border-slate-100 pt-3 flex flex-col gap-3">
                        {p.descripcion && (
                          <p className="text-xs text-slate-600">{p.descripcion}</p>
                        )}

                        {/* Estado */}
                        <label className="text-[11px] text-slate-500">
                          Estado
                          <select
                            value={p.estado}
                            onChange={(e) => cambiarEstado(p.id, e.target.value)}
                            className="mt-1 w-full rounded-lg ring-1 ring-slate-200 px-2 py-1.5 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
                          >
                            {ESTADOS.map((s) => (
                              <option key={s} value={s}>
                                {ESTADO_LABEL[s]}
                              </option>
                            ))}
                          </select>
                        </label>

                        {/* Pagos ligados */}
                        <div>
                          <p className="text-[11px] font-bold text-slate-500 uppercase">Pagos</p>
                          {pGastos.length === 0 ? (
                            <p className="text-xs text-slate-400 mt-1">
                              Sin pagos ligados. Liga gastos desde la bandeja de Gastos.
                            </p>
                          ) : (
                            <ul className="mt-1 flex flex-col gap-1">
                              {pGastos.map((g) => (
                                <li
                                  key={g.id}
                                  className="flex items-center justify-between text-xs bg-slate-50 rounded-lg px-2 py-1.5"
                                >
                                  <span className="text-slate-600 truncate">
                                    {fecha(g.fecha_pago)} · {g.concepto}
                                  </span>
                                  <span className="font-bold text-slate-700 shrink-0 ml-2">
                                    {money(Number(g.monto))}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>

                        {/* Documentos */}
                        <div>
                          <p className="text-[11px] font-bold text-slate-500 uppercase">
                            Documentos
                          </p>
                          {pDocs.length > 0 && (
                            <ul className="mt-1 flex flex-col gap-1">
                              {pDocs.map((d) => (
                                <li
                                  key={d.id}
                                  className="flex items-center justify-between text-xs bg-slate-50 rounded-lg px-2 py-1.5"
                                >
                                  <a
                                    href={d.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-brand-600 font-semibold truncate underline"
                                  >
                                    {TIPO_DOC[d.tipo] ?? d.tipo} · {d.nombre}
                                  </a>
                                  <button
                                    onClick={() => borrarDoc(d.id)}
                                    className="text-slate-300 hover:text-red-500 ml-2 shrink-0"
                                    title="Quitar"
                                  >
                                    ×
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                          <div className="mt-2 flex items-center gap-2">
                            <select
                              value={docTipo}
                              onChange={(e) => setDocTipo(e.target.value)}
                              className="rounded-lg ring-1 ring-slate-200 px-2 py-1.5 text-xs text-slate-700 outline-none"
                            >
                              <option value="cotizacion">Cotización</option>
                              <option value="contrato">Contrato</option>
                              <option value="factura">Factura</option>
                              <option value="otro">Otro</option>
                            </select>
                            <label className="flex-1 rounded-lg bg-brand-50 text-brand-700 text-xs font-semibold px-2 py-1.5 text-center cursor-pointer">
                              {docBusy ? "Subiendo…" : "+ Subir archivo"}
                              <input
                                type="file"
                                accept="image/*,application/pdf"
                                disabled={docBusy}
                                onChange={(e) => {
                                  const f = e.target.files?.[0];
                                  if (f) subirDoc(p.id, f);
                                  e.target.value = "";
                                }}
                                className="hidden"
                              />
                            </label>
                          </div>
                          {docMsg && <p className="text-xs text-red-600 mt-1">{docMsg}</p>}
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
