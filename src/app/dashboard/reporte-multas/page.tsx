"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { generarReporteMultas, type FilaMulta } from "./actions";

type Multa = {
  id: string;
  monto_multa: number;
  descripcion: string | null;
  resolved_at: string | null;
  evidencia_capturada_at: string | null;
  evidencia_lat: number | null;
  evidencia_lng: number | null;
  categoria: { nombre: string } | null;
  infractor: { numero: string } | null;
};

const money = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);

const mesActual = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const labelMes = (m: string) => {
  const [y, mm] = m.split("-").map(Number);
  return new Date(y, mm - 1, 1).toLocaleDateString("es-MX", { month: "long", year: "numeric" });
};

export default function ReporteMultasPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [colonia, setColonia] = useState("Tu colonia");
  const [periodo, setPeriodo] = useState(mesActual());
  const [multas, setMultas] = useState<Multa[]>([]);
  const [cargando, setCargando] = useState(false);
  const [reporte, setReporte] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [generando, setGenerando] = useState(false);

  const cargar = useCallback(async (mes: string) => {
    setCargando(true);
    setReporte(null);
    setErr(null);
    const [y, m] = mes.split("-").map(Number);
    const desde = new Date(y, m - 1, 1).toISOString();
    const hasta = new Date(y, m, 1).toISOString();
    const { data } = await supabaseBrowser
      .from("incident_reports")
      .select(
        "id, monto_multa, descripcion, resolved_at, evidencia_capturada_at, evidencia_lat, evidencia_lng, categoria:fine_categories(nombre), infractor:houses!infractor_house_id(numero)"
      )
      .eq("estado", "multa")
      .gte("resolved_at", desde)
      .lt("resolved_at", hasta)
      .order("resolved_at");
    setMultas((data as unknown as Multa[]) ?? []);
    setCargando(false);
  }, []);

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabaseBrowser.auth.getUser();
      if (!user) return router.replace("/login");
      const { data: prof } = await supabaseBrowser
        .from("profiles")
        .select("role, approval_status, colonia:colonias(nombre)")
        .eq("id", user.id)
        .maybeSingle();
      const p = prof as unknown as {
        role: string;
        approval_status: string;
        colonia?: { nombre: string } | null;
      } | null;
      if (!p || p.approval_status !== "aprobado") return router.replace("/esperando");
      if (p.role !== "admin" && p.role !== "comite") return router.replace("/dashboard");
      if (p.colonia?.nombre) setColonia(p.colonia.nombre);
      await cargar(periodo);
      setReady(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  async function generar() {
    setGenerando(true);
    setErr(null);
    setReporte(null);
    const filas: FilaMulta[] = multas.map((m) => ({
      fecha: (m.resolved_at ?? "").slice(0, 10),
      categoria: m.categoria?.nombre ?? "Incidencia",
      casa: m.infractor?.numero ?? "—",
      monto: Number(m.monto_multa) || 0,
      capturada_at: m.evidencia_capturada_at
        ? new Date(m.evidencia_capturada_at).toLocaleString("es-MX")
        : null,
      lat: m.evidencia_lat,
      lng: m.evidencia_lng,
      descripcion: m.descripcion,
    }));
    const token = (await supabaseBrowser.auth.getSession()).data.session?.access_token ?? "";
    const res = await generarReporteMultas(token, labelMes(periodo), colonia, filas);
    setGenerando(false);
    if (res.ok) setReporte(res.reporte);
    else setErr(res.error);
  }

  async function copiar() {
    if (reporte) await navigator.clipboard.writeText(reporte);
  }

  if (!ready)
    return (
      <main className="flex-1 flex items-center justify-center text-slate-400">Cargando…</main>
    );

  const total = multas.reduce((s, m) => s + Number(m.monto_multa), 0);

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

        <h1 className="text-2xl font-bold text-slate-800 mt-4">Reporte de multas</h1>
        <p className="text-sm text-slate-500">Resumen mensual asistido con IA.</p>

        {/* Periodo */}
        <section className="mt-4 bg-white rounded-2xl ring-1 ring-slate-100 p-4 flex items-end gap-2">
          <label className="text-xs text-slate-500 flex-1">
            Periodo
            <input
              type="month"
              value={periodo}
              onChange={(e) => {
                setPeriodo(e.target.value);
                cargar(e.target.value);
              }}
              className="mt-1 w-full rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
            />
          </label>
        </section>

        {/* Resumen del periodo */}
        <div className="mt-4 rounded-3xl p-5 bg-gradient-to-br from-red-500 to-orange-600 text-white shadow-lg">
          <p className="text-white/80 text-sm capitalize">{labelMes(periodo)}</p>
          <p className="text-3xl font-extrabold mt-1">{money(total)}</p>
          <p className="text-white/90 text-sm mt-1">{multas.length} multas aplicadas</p>
        </div>

        <button
          onClick={generar}
          disabled={generando || cargando || multas.length === 0}
          className="mt-4 rounded-2xl bg-gradient-to-br from-brand-500 to-emerald-600 text-white py-3.5 font-extrabold shadow-lg disabled:opacity-40 active:scale-[0.99] transition"
        >
          {generando ? "Generando con IA…" : "✨ Generar reporte con IA"}
        </button>

        {err && (
          <p className="mt-3 text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2 ring-1 ring-red-200">
            {err}
          </p>
        )}

        {/* Reporte generado */}
        {reporte && (
          <section className="mt-5">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-bold text-slate-700">Reporte</h2>
              <button onClick={copiar} className="text-xs text-brand-600 font-semibold">
                Copiar
              </button>
            </div>
            <div className="bg-white rounded-2xl ring-1 ring-slate-100 p-4 text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">
              {reporte}
            </div>
          </section>
        )}

        {/* Detalle de multas */}
        <section className="mt-6 mb-6">
          <h2 className="text-sm font-bold text-slate-700 mb-2">
            Multas del periodo <span className="text-slate-400 font-medium">({multas.length})</span>
          </h2>
          {cargando ? (
            <p className="text-slate-400 text-sm">Cargando…</p>
          ) : multas.length === 0 ? (
            <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
              No hay multas en este periodo.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {multas.map((m) => (
                <li
                  key={m.id}
                  className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-800 truncate">
                      {m.categoria?.nombre ?? "Incidencia"} · Casa {m.infractor?.numero ?? "—"}
                    </p>
                    <p className="text-xs text-slate-500">
                      {m.evidencia_capturada_at
                        ? new Date(m.evidencia_capturada_at).toLocaleString("es-MX", {
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : m.resolved_at?.slice(0, 10) ?? ""}
                    </p>
                  </div>
                  <p className="font-bold text-red-600 shrink-0">{money(Number(m.monto_multa))}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
