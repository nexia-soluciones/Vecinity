"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { COLOR_CATEGORIA, canon } from "@/lib/categorias";

// Transparencia financiera — visible para TODO residente aprobado.
// Tanto las entradas como los gastos tienen una razón: los ingresos ya vienen
// conciliados a su casa, los gastos traen su categoría/razón y los proyectos
// muestran cuánto costaron y con qué documentos (contrato, cotización).
// Solo lectura: el RLS de vecino.* permite SELECT colonia-wide; escribir sigue
// siendo exclusivo del comité.

type Ingreso = { monto: number; created_at: string };
type Gasto = {
  id: string;
  concepto: string;
  monto: number;
  categoria: string;
  fecha_pago: string;
  estado: string;
  archivo_principal_url: string | null;
  improvement_id: string | null;
  es_bien: boolean;
};
type Proyecto = {
  id: string;
  titulo: string;
  descripcion: string | null;
  presupuesto: number;
  estado: string;
};
type Doc = { id: string; project_id: string; tipo: string; nombre: string; url: string };

const money = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);
const fechaCorta = (d: string) =>
  new Date(d + "T00:00:00").toLocaleDateString("es-MX", { day: "numeric", month: "short" });

// Mes en hora MX (los pagos cerca de medianoche UTC caen en el día correcto)
const mesMX = (iso: string) => {
  const d = new Date(iso);
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(d);
  const y = p.find((x) => x.type === "year")?.value;
  const m = p.find((x) => x.type === "month")?.value;
  return `${y}-${m}`;
};

const MES_LABEL: Record<string, string> = {
  "01": "Ene", "02": "Feb", "03": "Mar", "04": "Abr", "05": "May", "06": "Jun",
  "07": "Jul", "08": "Ago", "09": "Sep", "10": "Oct", "11": "Nov", "12": "Dic",
};
const labelMes = (ym: string) => `${MES_LABEL[ym.slice(5)] ?? ym.slice(5)} ${ym.slice(0, 4)}`;

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

export default function FinanzasPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [ingresos, setIngresos] = useState<Ingreso[]>([]);
  const [gastos, setGastos] = useState<Gasto[]>([]);
  const [proyectos, setProyectos] = useState<Proyecto[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [mes, setMes] = useState(() => mesMX(new Date().toISOString()));
  const [proyAbierto, setProyAbierto] = useState<string | null>(null);
  const [filtroCat, setFiltroCat] = useState<string>(""); // "" = todas

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabaseBrowser.auth.getUser();
      if (!user) return router.replace("/login");
      const { data: prof } = await supabaseBrowser
        .from("profiles")
        .select("approval_status")
        .eq("id", user.id)
        .maybeSingle();
      const p = prof as unknown as { approval_status: string } | null;
      if (!p || p.approval_status !== "aprobado") return router.replace("/esperando");

      const [{ data: ins }, { data: gs }, { data: pr }, { data: dd }] = await Promise.all([
        supabaseBrowser
          .from("transactions")
          .select("monto, created_at")
          .eq("tipo", "abono")
          .eq("estado", "aprobado"),
        supabaseBrowser
          .from("colonia_expenses")
          .select(
            "id, concepto, monto, categoria, fecha_pago, estado, archivo_principal_url, improvement_id, es_bien"
          )
          .order("fecha_pago", { ascending: false }),
        supabaseBrowser
          .from("improvement_projects")
          .select("id, titulo, descripcion, presupuesto, estado")
          .neq("estado", "cancelado")
          .order("created_at", { ascending: false }),
        supabaseBrowser.from("project_documents").select("id, project_id, tipo, nombre, url"),
      ]);
      setIngresos((ins as unknown as Ingreso[]) ?? []);
      setGastos((gs as unknown as Gasto[]) ?? []);
      setProyectos((pr as unknown as Proyecto[]) ?? []);
      setDocs((dd as unknown as Doc[]) ?? []);
      setReady(true);
    })();
  }, [router]);

  // Meses disponibles (últimos 6 con actividad, más el actual)
  const meses = useMemo(() => {
    const set = new Set<string>([mesMX(new Date().toISOString())]);
    for (const i of ingresos) set.add(mesMX(i.created_at));
    for (const g of gastos) set.add(g.fecha_pago.slice(0, 7));
    return Array.from(set).sort().reverse().slice(0, 6);
  }, [ingresos, gastos]);

  const ingresosMes = useMemo(
    () => ingresos.filter((i) => mesMX(i.created_at) === mes).reduce((s, i) => s + Number(i.monto), 0),
    [ingresos, mes]
  );
  const gastosMes = useMemo(() => gastos.filter((g) => g.fecha_pago.slice(0, 7) === mes), [gastos, mes]);
  const gastosMesTotal = gastosMes.reduce((s, g) => s + Number(g.monto), 0);

  const porCat = useMemo(() => {
    const acc: Record<string, number> = {};
    for (const g of gastosMes) acc[canon(g.categoria)] = (acc[canon(g.categoria)] || 0) + Number(g.monto);
    return Object.entries(acc).sort((a, b) => b[1] - a[1]);
  }, [gastosMes]);
  const maxCat = porCat.length ? porCat[0][1] : 0;
  const gastosMesFiltrados = useMemo(
    () => (filtroCat ? gastosMes.filter((g) => canon(g.categoria) === filtroCat) : gastosMes),
    [gastosMes, filtroCat]
  );

  const proyNombre = (id: string | null) => proyectos.find((p) => p.id === id)?.titulo ?? null;
  const gastadoDe = (id: string) =>
    gastos.filter((g) => g.improvement_id === id).reduce((s, g) => s + Number(g.monto), 0);

  if (!ready)
    return (
      <main className="flex-1 flex items-center justify-center text-slate-400">Cargando…</main>
    );

  return (
    <main className="flex-1 bg-gradient-to-b from-brand-50 via-white to-sky-50">
      <div className="w-full max-w-md mx-auto px-5 py-6 flex flex-col">
        <div className="flex items-center justify-between">
          <button
            onClick={() => router.push("/dashboard")}
            className="text-sm text-slate-500 hover:text-slate-700"
          >
            ← Volver
          </button>
          <Image src="/brand/vecinity-logo.svg" alt="Vecinity" width={120} height={34} priority />
        </div>

        <h1 className="text-2xl font-bold text-slate-800 mt-4">Finanzas de la colonia</h1>
        <p className="text-sm text-slate-500">
          En qué se usa el dinero: cada entrada y cada gasto con su razón.
        </p>

        {/* Selector de mes */}
        <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
          {meses.map((m) => (
            <button
              key={m}
              onClick={() => setMes(m)}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-bold ring-1 transition ${
                m === mes
                  ? "bg-brand-500 text-white ring-brand-500"
                  : "bg-white text-slate-600 ring-slate-200 hover:ring-brand-300"
              }`}
            >
              {labelMes(m)}
            </button>
          ))}
        </div>

        {/* Resumen del mes */}
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div className="rounded-2xl p-4 bg-gradient-to-br from-emerald-500 to-emerald-700 text-white shadow">
            <p className="text-white/80 text-xs">Entradas</p>
            <p className="text-lg font-extrabold mt-0.5">{money(ingresosMes)}</p>
            <p className="text-white/70 text-[10px] mt-0.5">pagos conciliados a su casa</p>
          </div>
          <div className="rounded-2xl p-4 bg-gradient-to-br from-slate-600 to-slate-800 text-white shadow">
            <p className="text-white/80 text-xs">Gastos</p>
            <p className="text-lg font-extrabold mt-0.5">{money(gastosMesTotal)}</p>
            <p className="text-white/70 text-[10px] mt-0.5">{gastosMes.length} movimientos</p>
          </div>
        </div>

        {/* Gastos por categoría — clic filtra el detalle de abajo */}
        {porCat.length > 0 && (
          <section className="mt-5">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-bold text-slate-700">Gastos por categoría</h2>
              {filtroCat !== "" && (
                <button
                  onClick={() => setFiltroCat("")}
                  className="text-xs font-semibold text-brand-600 hover:underline"
                >
                  ✕ Quitar filtro
                </button>
              )}
            </div>
            <ul className="flex flex-col gap-2.5 bg-white rounded-2xl ring-1 ring-slate-100 p-4">
              {porCat.map(([cat, val]) => {
                const activo = filtroCat === cat;
                return (
                  <li key={cat}>
                    <button
                      onClick={() => setFiltroCat(activo ? "" : cat)}
                      className={`w-full text-left rounded-lg px-1.5 py-1 transition ${
                        activo ? "bg-brand-50 ring-1 ring-brand-200" : "hover:bg-slate-50"
                      }`}
                    >
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-700 font-medium">
                          {activo && "▸ "}
                          {cat}
                        </span>
                        <span className="text-slate-500">{money(val)}</span>
                      </div>
                      <div className="mt-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                        <div
                          className={`h-full ${COLOR_CATEGORIA[cat] ?? "bg-brand-500"}`}
                          style={{ width: `${maxCat > 0 ? (val / maxCat) * 100 : 0}%` }}
                        />
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {/* Detalle de gastos del mes */}
        <section className="mt-5">
          <h2 className="text-sm font-bold text-slate-700 mb-2">
            Detalle de gastos{" "}
            <span className="text-slate-400 font-medium">({gastosMesFiltrados.length})</span>
            {filtroCat && <span className="text-brand-600 font-medium"> · {filtroCat}</span>}
          </h2>
          {gastosMesFiltrados.length === 0 ? (
            <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
              Sin gastos {filtroCat ? `de ${filtroCat}` : "registrados"} este mes.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {gastosMesFiltrados.map((g) => (
                <li
                  key={g.id}
                  className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-800 truncate">{g.concepto}</p>
                    <p className="text-xs text-slate-500">
                      {g.categoria} · {fechaCorta(g.fecha_pago)}
                    </p>
                    <div className="flex items-center gap-1 mt-1 flex-wrap">
                      {proyNombre(g.improvement_id) && (
                        <span className="text-[10px] font-semibold text-indigo-700 bg-indigo-50 rounded-full px-2 py-0.5">
                          📁 {proyNombre(g.improvement_id)}
                        </span>
                      )}
                      {g.es_bien && (
                        <span className="text-[10px] font-semibold text-teal-700 bg-teal-50 rounded-full px-2 py-0.5">
                          🪑 bien de la villa
                        </span>
                      )}
                      {g.estado === "sin_clasificar" && (
                        <span className="text-[10px] font-semibold text-amber-700 bg-amber-50 rounded-full px-2 py-0.5">
                          en revisión del comité
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
                        title="Ver comprobante"
                      >
                        📎
                      </a>
                    )}
                    <span className="font-bold text-slate-700">{money(Number(g.monto))}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Bienes de la villa (inventario — histórico, no depende del mes) */}
        {gastos.some((g) => g.es_bien) && (
          <section className="mt-6">
            <h2 className="text-sm font-bold text-slate-700 mb-2">🪑 Bienes de la villa</h2>
            <p className="text-xs text-slate-500 mb-2">
              Cosas que ahora son patrimonio de todos (compradas con el fondo común).
            </p>
            <ul className="flex flex-col gap-2">
              {gastos
                .filter((g) => g.es_bien)
                .map((g) => (
                  <li
                    key={g.id}
                    className="bg-teal-50/60 rounded-2xl p-3.5 ring-1 ring-teal-100 flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-800 truncate">{g.concepto}</p>
                      <p className="text-xs text-slate-500">{fechaCorta(g.fecha_pago)}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {g.archivo_principal_url && (
                        <a
                          href={g.archivo_principal_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Ver comprobante"
                        >
                          📎
                        </a>
                      )}
                      <span className="font-bold text-slate-700">{money(Number(g.monto))}</span>
                    </div>
                  </li>
                ))}
            </ul>
          </section>
        )}

        {/* Proyectos */}
        <section className="mt-6 mb-6">
          <h2 className="text-sm font-bold text-slate-700 mb-2">Proyectos de mejora</h2>
          {proyectos.length === 0 ? (
            <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
              Aún no hay proyectos registrados.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {proyectos.map((p) => {
                const gastado = gastadoDe(p.id);
                const pDocs = docs.filter((d) => d.project_id === p.id);
                const pGastos = gastos.filter((g) => g.improvement_id === p.id);
                const open = proyAbierto === p.id;
                return (
                  <li key={p.id} className="bg-white rounded-2xl ring-1 ring-slate-100 p-4">
                    <button
                      onClick={() => setProyAbierto(open ? null : p.id)}
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
                          {pGastos.length} pagos · {pDocs.length} documentos
                        </p>
                        <p className="text-sm font-bold text-slate-700">{money(gastado)}</p>
                      </div>
                    </button>
                    {open && (
                      <div className="mt-3 border-t border-slate-100 pt-3 flex flex-col gap-3">
                        {p.descripcion && <p className="text-xs text-slate-600">{p.descripcion}</p>}
                        {pGastos.length > 0 && (
                          <div>
                            <p className="text-[11px] font-bold text-slate-500 uppercase">Pagos</p>
                            <ul className="mt-1 flex flex-col gap-1">
                              {pGastos.map((g) => (
                                <li
                                  key={g.id}
                                  className="flex items-center justify-between text-xs bg-slate-50 rounded-lg px-2 py-1.5"
                                >
                                  <span className="text-slate-600 truncate">
                                    {fechaCorta(g.fecha_pago)} · {g.concepto}
                                  </span>
                                  <span className="font-bold text-slate-700 shrink-0 ml-2">
                                    {money(Number(g.monto))}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {pDocs.length > 0 && (
                          <div>
                            <p className="text-[11px] font-bold text-slate-500 uppercase">
                              Documentos
                            </p>
                            <ul className="mt-1 flex flex-col gap-1">
                              {pDocs.map((d) => (
                                <li key={d.id} className="text-xs bg-slate-50 rounded-lg px-2 py-1.5">
                                  <a
                                    href={d.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-brand-600 font-semibold underline"
                                  >
                                    {TIPO_DOC[d.tipo] ?? d.tipo} · {d.nombre}
                                  </a>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
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
