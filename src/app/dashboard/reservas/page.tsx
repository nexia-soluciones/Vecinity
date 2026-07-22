"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";

// ---------- tipos ----------
type Area = {
  id: string;
  nombre: string;
  descripcion: string | null;
  reglas: string | null;
  exclusiva: boolean;
  requiere_aforo: boolean;
  hora_apertura: string; // 'HH:MM:SS'
  hora_cierre: string;
  duracion_min_horas: number;
  duracion_max_horas: number;
  max_personas_casa: number | null;
  capacidad_personas: number;
  costo: number;
  deposito: number;
  color: string;
  icono: string | null;
};
type Slot = {
  id: string;
  fecha_hora_inicio: string;
  fecha_hora_fin: string;
  estado: string;
  cantidad_personas: number | null;
};
type MiReserva = Slot & { area: { nombre: string; icono: string | null } | null };

const money = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);
const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
const hourOf = (t: string) => parseInt(t.slice(0, 2), 10);

export default function ReservasPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [houseId, setHouseId] = useState<string | null>(null);
  const [saldo, setSaldo] = useState(0);
  const [umbral, setUmbral] = useState(0);
  const [areas, setAreas] = useState<Area[]>([]);
  const [area, setArea] = useState<Area | null>(null);

  // fecha seleccionada (Date a medianoche local)
  const [fecha, setFecha] = useState<Date>(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const [ocupadas, setOcupadas] = useState<Slot[]>([]);
  const [horaInicio, setHoraInicio] = useState<number | null>(null);
  const [duracion, setDuracion] = useState<number>(1);
  const [personas, setPersonas] = useState<number>(1);

  const [misReservas, setMisReservas] = useState<MiReserva[]>([]);
  const [msg, setMsg] = useState<{ tipo: "ok" | "err"; texto: string } | null>(null);
  const [enviando, setEnviando] = useState(false);

  const conAdeudo = saldo > umbral;

  // ---------- carga inicial ----------
  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabaseBrowser.auth.getUser();
      if (!user) return router.replace("/login");

      const { data: prof } = await supabaseBrowser
        .from("profiles")
        .select("house_id, colonia_id, approval_status")
        .eq("id", user.id)
        .maybeSingle();
      const p = prof as unknown as {
        house_id: string | null;
        colonia_id: string | null;
        approval_status: string;
      } | null;
      if (!p || p.approval_status !== "aprobado") return router.replace("/esperando");
      setHouseId(p.house_id);

      if (p.colonia_id) {
        const { data: col } = await supabaseBrowser
          .from("colonias")
          .select("umbral_reserva")
          .eq("id", p.colonia_id)
          .maybeSingle();
        setUmbral((col as unknown as { umbral_reserva: number } | null)?.umbral_reserva ?? 0);
      }

      if (p.house_id) {
        const { data: h } = await supabaseBrowser
          .from("houses")
          .select("saldo")
          .eq("id", p.house_id)
          .maybeSingle();
        setSaldo((h as unknown as { saldo: number } | null)?.saldo ?? 0);
      }

      const { data: a } = await supabaseBrowser
        .from("common_areas")
        .select(
          "id, nombre, descripcion, reglas, exclusiva, requiere_aforo, hora_apertura, hora_cierre, duracion_min_horas, duracion_max_horas, max_personas_casa, capacidad_personas, costo, deposito, color, icono"
        )
        .eq("reservable", true)
        .eq("activa", true)
        .order("orden");
      setAreas((a as unknown as Area[]) ?? []);

      setReady(true);
    })();
  }, [router]);

  const cargarMisReservas = useCallback(async () => {
    if (!houseId) return;
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    const { data } = await supabaseBrowser
      .from("reservations")
      .select(
        "id, fecha_hora_inicio, fecha_hora_fin, estado, cantidad_personas, area:common_areas(nombre, icono)"
      )
      .eq("house_id", houseId)
      .in("estado", ["pendiente", "aprobada", "en_uso"])
      .gte("fecha_hora_inicio", hoy.toISOString())
      .order("fecha_hora_inicio");
    setMisReservas((data as unknown as MiReserva[]) ?? []);
  }, [houseId]);

  useEffect(() => {
    if (ready) cargarMisReservas();
  }, [ready, cargarMisReservas]);

  // ---------- disponibilidad del día/área ----------
  const cargarDisponibilidad = useCallback(async () => {
    if (!area) return;
    const f = `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, "0")}-${String(
      fecha.getDate()
    ).padStart(2, "0")}`;
    const { data } = await supabaseBrowser.rpc("disponibilidad_area", {
      p_area_id: area.id,
      p_fecha: f,
    });
    setOcupadas((data as unknown as Slot[]) ?? []);
    setHoraInicio(null);
  }, [area, fecha]);

  useEffect(() => {
    if (area) cargarDisponibilidad();
  }, [area, fecha, cargarDisponibilidad]);

  // ---------- helpers de franja ----------
  const apertura = area ? hourOf(area.hora_apertura) : 8;
  const cierre = area ? hourOf(area.hora_cierre) : 20;

  // ocupación por hora (cuántas reservas activas cubren cada hora)
  const ocupacionPorHora = useMemo(() => {
    const map: Record<number, number> = {};
    for (const o of ocupadas) {
      const ini = new Date(o.fecha_hora_inicio);
      const fin = new Date(o.fecha_hora_fin);
      for (let h = ini.getHours(); h < fin.getHours() + (fin.getMinutes() > 0 ? 1 : 0); h++) {
        map[h] = (map[h] ?? 0) + 1;
      }
    }
    return map;
  }, [ocupadas]);

  // ¿la hora de inicio h con la duración actual choca? (solo áreas exclusivas)
  const horaBloqueada = useCallback(
    (h: number) => {
      if (!area) return true;
      if (h < apertura || h + duracion > cierre) return true;
      if (!area.exclusiva) return false; // compartida: nunca se bloquea
      for (let k = h; k < h + duracion; k++) {
        if ((ocupacionPorHora[k] ?? 0) >= 1) return true;
      }
      return false;
    },
    [area, apertura, cierre, duracion, ocupacionPorHora]
  );

  const horasDisponibles = useMemo(() => {
    const out: number[] = [];
    for (let h = apertura; h + (area?.duracion_min_horas ?? 1) <= cierre; h++) out.push(h);
    return out;
  }, [apertura, cierre, area]);

  function elegirArea(a: Area) {
    setArea(a);
    setDuracion(a.duracion_min_horas);
    setPersonas(a.requiere_aforo ? 1 : 0);
    setHoraInicio(null);
    setMsg(null);
  }

  async function confirmar() {
    if (!area || horaInicio === null) return;
    setEnviando(true);
    setMsg(null);
    const inicio = new Date(fecha);
    inicio.setHours(horaInicio, 0, 0, 0);
    const fin = new Date(inicio);
    fin.setHours(horaInicio + duracion, 0, 0, 0);

    const { data, error } = await supabaseBrowser.rpc("crear_reserva", {
      p_area_id: area.id,
      p_inicio: inicio.toISOString(),
      p_fin: fin.toISOString(),
      p_personas: area.requiere_aforo ? personas : null,
    });
    setEnviando(false);

    if (error) {
      setMsg({ tipo: "err", texto: error.message.replace(/^.*?:\s/, "") });
      return;
    }
    const res = data as unknown as { estado: string };
    setMsg({
      tipo: "ok",
      texto:
        res.estado === "aprobada"
          ? "¡Reserva confirmada! ✓"
          : "Reserva enviada. El comité la revisará.",
    });
    setHoraInicio(null);
    await Promise.all([cargarDisponibilidad(), cargarMisReservas()]);
  }

  async function cancelar(id: string) {
    const { error } = await supabaseBrowser.rpc("cancelar_reserva", { p_reservation_id: id });
    if (!error) {
      await Promise.all([cargarMisReservas(), area ? cargarDisponibilidad() : Promise.resolve()]);
    }
  }

  if (!ready)
    return (
      <main className="flex-1 flex items-center justify-center text-slate-400">Cargando…</main>
    );

  // próximos 14 días para la tira
  const dias = Array.from({ length: 14 }, (_, i) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + i);
    return d;
  });
  const totalEvento = area ? area.costo + area.deposito : 0;

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

        <h1 className="text-2xl font-bold text-slate-800 mt-4">Reservar áreas comunes</h1>

        {/* Gate adeudo */}
        {conAdeudo && (
          <div className="mt-4 rounded-2xl bg-amber-50 ring-1 ring-amber-200 p-4">
            <p className="text-amber-800 text-sm font-semibold">
              Tu casa tiene un adeudo de {money(saldo)}.
            </p>
            <p className="text-amber-700 text-sm mt-1">
              Debes estar al corriente para reservar áreas comunes
              {umbral > 0 ? ` (tolerancia de ${money(umbral)})` : ""}.
            </p>
          </div>
        )}

        {/* 1) Elegir área */}
        <section className="mt-5">
          <h2 className="text-sm font-bold text-slate-700 mb-2">¿Qué quieres reservar?</h2>
          <div className="grid grid-cols-2 gap-3">
            {areas.map((a) => (
              <button
                key={a.id}
                onClick={() => elegirArea(a)}
                className={`rounded-2xl p-4 text-left ring-1 transition ${
                  area?.id === a.id
                    ? "ring-2 ring-brand-400 bg-white"
                    : "ring-slate-100 bg-white hover:ring-brand-200"
                }`}
              >
                <span className="text-2xl">{a.icono ?? "📍"}</span>
                <p className="text-sm font-semibold text-slate-800 mt-2">{a.nombre}</p>
                {a.costo > 0 ? (
                  <p className="text-xs text-amber-600 mt-0.5">{money(a.costo)} + depósito</p>
                ) : (
                  <p className="text-xs text-emerald-600 mt-0.5">Gratis</p>
                )}
              </button>
            ))}
          </div>
        </section>

        {area && (
          <>
            {/* Reglas */}
            {area.reglas && (
              <p className="mt-4 text-xs text-slate-500 bg-white rounded-2xl p-3.5 ring-1 ring-slate-100 leading-relaxed">
                {area.reglas}
              </p>
            )}

            {/* 2) Día */}
            <section className="mt-5">
              <h2 className="text-sm font-bold text-slate-700 mb-2">Elige el día</h2>
              <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
                {dias.map((d) => {
                  const sel = d.toDateString() === fecha.toDateString();
                  return (
                    <button
                      key={d.toISOString()}
                      onClick={() => setFecha(d)}
                      className={`shrink-0 w-14 rounded-2xl py-2.5 text-center ring-1 transition ${
                        sel
                          ? "bg-brand-500 text-white ring-brand-500"
                          : "bg-white text-slate-600 ring-slate-100 hover:ring-brand-200"
                      }`}
                    >
                      <span className="block text-[10px] uppercase opacity-80">
                        {d.toLocaleDateString("es-MX", { weekday: "short" })}
                      </span>
                      <span className="block text-lg font-bold leading-tight">{d.getDate()}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* 3) Línea de tiempo del día */}
            <section className="mt-5">
              <h2 className="text-sm font-bold text-slate-700 mb-2">
                Disponibilidad ·{" "}
                {fecha.toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" })}
              </h2>
              <div className="bg-white rounded-2xl ring-1 ring-slate-100 p-3">
                {ocupadas.length === 0 ? (
                  <p className="text-xs text-emerald-600 mb-2">Todo el día libre ✓</p>
                ) : (
                  <p className="text-xs text-slate-500 mb-2">
                    {area.exclusiva ? "Franjas ocupadas:" : "Reservas ese día:"}{" "}
                    {ocupadas.map((o) => `${hhmm(o.fecha_hora_inicio)}–${hhmm(o.fecha_hora_fin)}`).join(", ")}
                  </p>
                )}
                <div className="grid grid-cols-6 gap-1.5">
                  {Array.from({ length: cierre - apertura }, (_, i) => apertura + i).map((h) => {
                    const ocupada = (ocupacionPorHora[h] ?? 0) >= 1 && area.exclusiva;
                    return (
                      <div
                        key={h}
                        className={`rounded-lg py-1.5 text-center text-[11px] font-medium ${
                          ocupada
                            ? "bg-red-100 text-red-400 line-through"
                            : "bg-emerald-50 text-emerald-700"
                        }`}
                      >
                        {String(h).padStart(2, "0")}h
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>

            {/* 4) Hora + duración + personas */}
            <section className="mt-5">
              <h2 className="text-sm font-bold text-slate-700 mb-2">Tu reserva</h2>

              <label className="text-xs text-slate-500">Duración</label>
              <div className="flex gap-2 mt-1 mb-3 flex-wrap">
                {Array.from(
                  { length: area.duracion_max_horas - area.duracion_min_horas + 1 },
                  (_, i) => area.duracion_min_horas + i
                ).map((d) => (
                  <button
                    key={d}
                    onClick={() => {
                      setDuracion(d);
                      setHoraInicio(null);
                    }}
                    className={`rounded-xl px-3.5 py-2 text-sm font-semibold ring-1 ${
                      duracion === d
                        ? "bg-brand-500 text-white ring-brand-500"
                        : "bg-white text-slate-600 ring-slate-200"
                    }`}
                  >
                    {d}h
                  </button>
                ))}
              </div>

              <label className="text-xs text-slate-500">Hora de inicio</label>
              <div className="grid grid-cols-4 gap-2 mt-1">
                {horasDisponibles.map((h) => {
                  const bloq = horaBloqueada(h);
                  const sel = horaInicio === h;
                  return (
                    <button
                      key={h}
                      disabled={bloq}
                      onClick={() => setHoraInicio(h)}
                      className={`rounded-xl py-2 text-sm font-semibold ring-1 transition ${
                        sel
                          ? "bg-brand-600 text-white ring-brand-600"
                          : bloq
                          ? "bg-slate-50 text-slate-300 ring-slate-100 cursor-not-allowed"
                          : "bg-white text-slate-700 ring-slate-200 hover:ring-brand-300"
                      }`}
                    >
                      {String(h).padStart(2, "0")}:00
                    </button>
                  );
                })}
              </div>

              {area.requiere_aforo && (
                <div className="mt-3">
                  <label className="text-xs text-slate-500">
                    Personas{" "}
                    {area.max_personas_casa
                      ? `(máx ${area.max_personas_casa} por casa)`
                      : `(aforo ${area.capacidad_personas})`}
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={area.max_personas_casa ?? area.capacidad_personas}
                    value={personas}
                    onChange={(e) => setPersonas(Math.max(1, parseInt(e.target.value || "1", 10)))}
                    className="mt-1 w-full rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 focus:ring-2 focus:ring-brand-300 outline-none"
                  />
                </div>
              )}

              {/* Resumen costo evento */}
              {area.costo > 0 && (
                <div className="mt-3 rounded-2xl bg-amber-50 ring-1 ring-amber-200 p-3 text-sm">
                  <div className="flex justify-between text-amber-800">
                    <span>Cuota de evento</span>
                    <span className="font-semibold">{money(area.costo)}</span>
                  </div>
                  <div className="flex justify-between text-amber-800">
                    <span>Depósito (reintegrable)</span>
                    <span className="font-semibold">{money(area.deposito)}</span>
                  </div>
                  <div className="flex justify-between text-amber-900 font-bold mt-1 pt-1 border-t border-amber-200">
                    <span>Total a entregar</span>
                    <span>{money(totalEvento)}</span>
                  </div>
                </div>
              )}

              {msg && (
                <p
                  className={`mt-3 text-sm rounded-xl px-3 py-2 ${
                    msg.tipo === "ok"
                      ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                      : "bg-red-50 text-red-600 ring-1 ring-red-200"
                  }`}
                >
                  {msg.texto}
                </p>
              )}

              <button
                onClick={confirmar}
                disabled={conAdeudo || horaInicio === null || enviando}
                className="mt-4 w-full rounded-2xl bg-gradient-to-br from-brand-500 to-emerald-600 text-white py-4 font-extrabold shadow-lg disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.99] transition"
              >
                {enviando
                  ? "Reservando…"
                  : horaInicio === null
                  ? "Elige una hora"
                  : `Reservar ${String(horaInicio).padStart(2, "0")}:00–${String(
                      horaInicio + duracion
                    ).padStart(2, "0")}:00`}
              </button>
            </section>
          </>
        )}

        {/* Mis reservas */}
        <section className="mt-8">
          <h2 className="text-sm font-bold text-slate-700 mb-2">
            Mis reservas <span className="text-slate-400 font-medium">({misReservas.length})</span>
          </h2>
          {misReservas.length === 0 ? (
            <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
              No tienes reservas próximas.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {misReservas.map((r) => (
                <li
                  key={r.id}
                  className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-800 truncate">
                      {r.area?.icono} {r.area?.nombre}
                    </p>
                    <p className="text-xs text-slate-500">
                      {new Date(r.fecha_hora_inicio).toLocaleDateString("es-MX", {
                        weekday: "short",
                        day: "numeric",
                        month: "short",
                      })}{" "}
                      · {hhmm(r.fecha_hora_inicio)}–{hhmm(r.fecha_hora_fin)}
                    </p>
                    <span
                      className={`inline-block mt-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                        r.estado === "aprobada"
                          ? "bg-emerald-50 text-emerald-700"
                          : r.estado === "pendiente"
                          ? "bg-amber-50 text-amber-700"
                          : "bg-sky-50 text-sky-700"
                      }`}
                    >
                      {r.estado === "en_uso" ? "en uso" : r.estado}
                    </span>
                  </div>
                  {r.estado !== "en_uso" && (
                    <button
                      onClick={() => cancelar(r.id)}
                      className="press-soft rounded-xl border border-slate-200 text-slate-500 text-xs font-semibold px-3 py-2 hover:bg-slate-50 shrink-0"
                    >
                      Cancelar
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
