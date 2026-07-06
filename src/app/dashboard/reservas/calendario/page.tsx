"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";

// ---------- tipos ----------
type Area = {
  id: string;
  nombre: string;
  icono: string | null;
  hora_apertura: string; // 'HH:MM:SS'
  hora_cierre: string;
  exclusiva: boolean;
};
type CalRow = {
  reserva_id: string;
  area_id: string;
  area_nombre: string;
  area_color: string | null;
  area_icono: string | null;
  area_exclusiva: boolean;
  casa_numero: string | null;
  es_mia: boolean;
  inicio: string;
  fin: string;
  estado: string;
  cantidad_personas: number | null;
};

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
const hourOf = (t: string) => parseInt(t.slice(0, 2), 10);
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const estadoBadge: Record<string, string> = {
  aprobada: "bg-emerald-50 text-emerald-700",
  pendiente: "bg-amber-50 text-amber-700",
  en_uso: "bg-sky-50 text-sky-700",
  completada: "bg-slate-100 text-slate-500",
};
const estadoTexto: Record<string, string> = {
  aprobada: "confirmada",
  pendiente: "por aprobar",
  en_uso: "en uso",
  completada: "finalizada",
};

export default function CalendarioReservasPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [areas, setAreas] = useState<Area[]>([]);
  const [filas, setFilas] = useState<CalRow[]>([]);
  const [fecha, setFecha] = useState<Date>(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });

  // próximos 14 días para la tira
  const dias = useMemo(
    () =>
      Array.from({ length: 14 }, (_, i) => {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() + i);
        return d;
      }),
    []
  );

  // ---------- carga inicial ----------
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

      const { data: a } = await supabaseBrowser
        .from("common_areas")
        .select("id, nombre, icono, hora_apertura, hora_cierre, exclusiva")
        .eq("reservable", true)
        .eq("activa", true)
        .order("orden");
      setAreas((a as unknown as Area[]) ?? []);

      // ventana completa de 14 días en una sola llamada
      const desde = ymd(dias[0]);
      const hasta = ymd(dias[dias.length - 1]);
      const { data: rows } = await supabaseBrowser.rpc("calendario_reservas", {
        p_desde: desde,
        p_hasta: hasta,
      });
      setFilas((rows as unknown as CalRow[]) ?? []);

      setReady(true);
    })();
  }, [router, dias]);

  const recargar = useCallback(async () => {
    const desde = ymd(dias[0]);
    const hasta = ymd(dias[dias.length - 1]);
    const { data: rows } = await supabaseBrowser.rpc("calendario_reservas", {
      p_desde: desde,
      p_hasta: hasta,
    });
    setFilas((rows as unknown as CalRow[]) ?? []);
  }, [dias]);

  // reservas del día seleccionado, agrupadas por área
  const filasDelDia = useMemo(() => {
    const clave = ymd(fecha);
    return filas.filter((r) => ymd(new Date(r.inicio)) === clave);
  }, [filas, fecha]);

  // conteo por día (para el punto en la tira)
  const conteoPorDia = useMemo(() => {
    const map: Record<string, number> = {};
    for (const r of filas) {
      const k = ymd(new Date(r.inicio));
      map[k] = (map[k] ?? 0) + 1;
    }
    return map;
  }, [filas]);

  if (!ready)
    return (
      <main className="flex-1 flex items-center justify-center text-slate-400">Cargando…</main>
    );

  return (
    <main className="flex-1 bg-gradient-to-b from-brand-50 via-white to-sky-50">
      <div className="w-full max-w-md mx-auto px-5 py-6 flex flex-col">
        {/* Top bar */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => router.push("/dashboard")}
            className="text-sm text-slate-500 hover:text-slate-700"
          >
            ← Volver
          </button>
          <Image src="/brand/vecinity-logo.svg" alt="Vecinity" width={120} height={34} priority />
        </div>

        <h1 className="text-2xl font-bold text-slate-800 mt-4">Calendario de reservas</h1>
        <p className="text-sm text-slate-500 mt-1">
          Mira qué áreas comunes están ocupadas antes de reservar.
        </p>

        {/* Tira de días */}
        <section className="mt-5">
          <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
            {dias.map((d) => {
              const sel = d.toDateString() === fecha.toDateString();
              const n = conteoPorDia[ymd(d)] ?? 0;
              return (
                <button
                  key={d.toISOString()}
                  onClick={() => setFecha(d)}
                  className={`shrink-0 w-14 rounded-2xl py-2.5 text-center ring-1 transition relative ${
                    sel
                      ? "bg-brand-500 text-white ring-brand-500"
                      : "bg-white text-slate-600 ring-slate-100 hover:ring-brand-200"
                  }`}
                >
                  <span className="block text-[10px] uppercase opacity-80">
                    {d.toLocaleDateString("es-MX", { weekday: "short" })}
                  </span>
                  <span className="block text-lg font-bold leading-tight">{d.getDate()}</span>
                  {n > 0 && (
                    <span
                      className={`block mx-auto mt-0.5 h-1.5 w-1.5 rounded-full ${
                        sel ? "bg-white" : "bg-brand-400"
                      }`}
                      aria-label={`${n} reservas`}
                    />
                  )}
                </button>
              );
            })}
          </div>
        </section>

        <h2 className="text-sm font-bold text-slate-700 mt-6 mb-2 capitalize">
          {fecha.toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" })}
        </h2>

        {/* Agenda del día, por área */}
        <section className="flex flex-col gap-3">
          {areas.map((area) => {
            const reservasArea = filasDelDia
              .filter((r) => r.area_id === area.id)
              .sort((a, b) => a.inicio.localeCompare(b.inicio));
            const apertura = hourOf(area.hora_apertura);
            const cierre = hourOf(area.hora_cierre);
            // horas ocupadas (para la mini-línea de tiempo)
            const ocupada = new Set<number>();
            for (const r of reservasArea) {
              const ini = new Date(r.inicio);
              const fin = new Date(r.fin);
              for (
                let h = ini.getHours();
                h < fin.getHours() + (fin.getMinutes() > 0 ? 1 : 0);
                h++
              )
                ocupada.add(h);
            }
            return (
              <div key={area.id} className="bg-white rounded-2xl ring-1 ring-slate-100 p-4">
                <div className="flex items-center justify-between">
                  <p className="font-bold text-slate-800">
                    {area.icono ?? "📍"} {area.nombre}
                  </p>
                  <span className="text-[11px] text-slate-400">
                    {String(apertura).padStart(2, "0")}–{String(cierre).padStart(2, "0")}h
                  </span>
                </div>

                {reservasArea.length === 0 ? (
                  <p className="text-xs text-emerald-600 mt-2">Libre todo el día ✓</p>
                ) : (
                  <>
                    {/* Mini línea de tiempo */}
                    <div className="grid grid-cols-6 gap-1.5 mt-3">
                      {Array.from({ length: cierre - apertura }, (_, i) => apertura + i).map((h) => (
                        <div
                          key={h}
                          className={`rounded-lg py-1 text-center text-[10px] font-medium ${
                            ocupada.has(h)
                              ? "bg-red-100 text-red-500"
                              : "bg-emerald-50 text-emerald-700"
                          }`}
                        >
                          {String(h).padStart(2, "0")}h
                        </div>
                      ))}
                    </div>
                    {/* Detalle por reserva */}
                    <ul className="flex flex-col gap-1.5 mt-3">
                      {reservasArea.map((r) => (
                        <li
                          key={r.reserva_id}
                          className={`flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-sm ring-1 ${
                            r.es_mia
                              ? "bg-brand-50 ring-brand-200"
                              : "bg-slate-50 ring-slate-100"
                          }`}
                        >
                          <div className="min-w-0">
                            <p className="font-semibold text-slate-800">
                              {hhmm(r.inicio)}–{hhmm(r.fin)}
                            </p>
                            <p className="text-xs text-slate-500 truncate">
                              {r.es_mia ? "Tu reserva" : `Casa ${r.casa_numero ?? "?"}`}
                              {r.cantidad_personas ? ` · ${r.cantidad_personas} pers.` : ""}
                            </p>
                          </div>
                          <span
                            className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                              estadoBadge[r.estado] ?? "bg-slate-100 text-slate-500"
                            }`}
                          >
                            {estadoTexto[r.estado] ?? r.estado}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            );
          })}

          {areas.length === 0 && (
            <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
              No hay áreas comunes reservables.
            </p>
          )}
        </section>

        {/* CTA reservar */}
        <button
          onClick={() => router.push("/dashboard/reservas")}
          className="mt-6 w-full rounded-2xl bg-gradient-to-br from-brand-500 to-emerald-600 text-white py-4 font-extrabold shadow-lg active:scale-[0.99] transition"
        >
          Reservar un área
        </button>

        <button
          onClick={recargar}
          className="mt-3 w-full text-sm text-slate-500 hover:text-slate-700"
        >
          ↻ Actualizar
        </button>
      </div>
    </main>
  );
}
