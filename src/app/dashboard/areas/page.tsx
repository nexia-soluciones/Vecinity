"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { runOrError } from "@/lib/rpc";

type Area = {
  id: string;
  colonia_id: string;
  nombre: string;
  descripcion: string | null;
  reglas: string | null;
  activa: boolean;
  reservable: boolean;
  exclusiva: boolean;
  requiere_aforo: boolean;
  hora_apertura: string;
  hora_cierre: string;
  duracion_min_horas: number;
  duracion_max_horas: number;
  max_personas_casa: number | null;
  capacidad_personas: number;
  costo: number;
  deposito: number;
  aprobacion_automatica: boolean;
  color: string;
  icono: string | null;
  orden: number;
};
type Pendiente = {
  id: string;
  fecha_hora_inicio: string;
  fecha_hora_fin: string;
  cantidad_personas: number | null;
  area: { nombre: string; icono: string | null } | null;
  house: { numero: string } | null;
};

const AREA_COLS =
  "id, colonia_id, nombre, descripcion, reglas, activa, reservable, exclusiva, requiere_aforo, hora_apertura, hora_cierre, duracion_min_horas, duracion_max_horas, max_personas_casa, capacidad_personas, costo, deposito, aprobacion_automatica, color, icono, orden";

const hhmm = (iso: string) =>
  new Date(iso).toLocaleString("es-MX", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

export default function AreasAdminPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [coloniaId, setColoniaId] = useState<string | null>(null);
  const [umbral, setUmbral] = useState<number>(0);
  const [umbralGuardado, setUmbralGuardado] = useState(false);
  const [tope, setTope] = useState<number>(1000);
  const [topeGuardado, setTopeGuardado] = useState(false);
  const [servicios, setServicios] = useState<number>(1000);
  const [serviciosGuardado, setServiciosGuardado] = useState(false);
  const [areas, setAreas] = useState<Area[]>([]);
  const [pendientes, setPendientes] = useState<Pendiente[]>([]);
  const [editId, setEditId] = useState<string | null>(null);
  const [nuevoNombre, setNuevoNombre] = useState("");
  const [cfgErr, setCfgErr] = useState<string | null>(null);
  const [areaMsg, setAreaMsg] = useState<string | null>(null);
  const [pendErr, setPendErr] = useState<string | null>(null);
  const [resolviendo, setResolviendo] = useState<Set<string>>(new Set());

  const cargarAreas = useCallback(async () => {
    const { data } = await supabaseBrowser
      .from("common_areas")
      .select(AREA_COLS)
      .order("orden");
    setAreas((data as unknown as Area[]) ?? []);
  }, []);

  const cargarPendientes = useCallback(async () => {
    const { data } = await supabaseBrowser
      .from("reservations")
      .select(
        "id, fecha_hora_inicio, fecha_hora_fin, cantidad_personas, area:common_areas(nombre, icono), house:houses(numero)"
      )
      .eq("estado", "pendiente")
      .order("fecha_hora_inicio");
    setPendientes((data as unknown as Pendiente[]) ?? []);
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
      if (!p || (p.role !== "admin" && p.role !== "comite")) return router.replace("/dashboard");
      setColoniaId(p.colonia_id);
      if (p.colonia_id) {
        const { data: col } = await supabaseBrowser
          .from("colonias")
          .select("umbral_reserva, tope_multa, umbral_servicios")
          .eq("id", p.colonia_id)
          .maybeSingle();
        const c = col as unknown as {
          umbral_reserva: number;
          tope_multa: number;
          umbral_servicios: number;
        } | null;
        setUmbral(c?.umbral_reserva ?? 0);
        setTope(c?.tope_multa ?? 1000);
        setServicios(c?.umbral_servicios ?? 1000);
      }
      await Promise.all([cargarAreas(), cargarPendientes()]);
      setReady(true);
    })();
  }, [router, cargarAreas, cargarPendientes]);

  async function guardar(a: Area) {
    setAreaMsg(null);
    const { id, colonia_id: _c, ...campos } = a;
    void _c;
    const res = await runOrError(() =>
      supabaseBrowser.from("common_areas").update(campos).eq("id", id)
    );
    if (!res.ok) return setAreaMsg(res.error);
    setEditId(null);
    await cargarAreas();
  }

  async function crearArea() {
    if (!nuevoNombre.trim() || !coloniaId) return;
    setAreaMsg(null);
    const res = await runOrError(() =>
      supabaseBrowser.from("common_areas").insert({
        colonia_id: coloniaId,
        nombre: nuevoNombre.trim(),
        reservable: true,
        activa: true,
        orden: areas.length + 1,
      })
    );
    if (!res.ok) return setAreaMsg(res.error);
    setNuevoNombre("");
    await cargarAreas();
  }

  async function guardarUmbral() {
    if (!coloniaId) return;
    setCfgErr(null);
    const res = await runOrError(() =>
      supabaseBrowser.from("colonias").update({ umbral_reserva: umbral }).eq("id", coloniaId)
    );
    if (!res.ok) return setCfgErr(res.error);
    setUmbralGuardado(true);
    setTimeout(() => setUmbralGuardado(false), 2500);
  }

  async function guardarTope() {
    if (!coloniaId) return;
    setCfgErr(null);
    const res = await runOrError(() =>
      supabaseBrowser.from("colonias").update({ tope_multa: tope }).eq("id", coloniaId)
    );
    if (!res.ok) return setCfgErr(res.error);
    setTopeGuardado(true);
    setTimeout(() => setTopeGuardado(false), 2500);
  }

  async function guardarServicios() {
    if (!coloniaId) return;
    setCfgErr(null);
    const res = await runOrError(() =>
      supabaseBrowser.from("colonias").update({ umbral_servicios: servicios }).eq("id", coloniaId)
    );
    if (!res.ok) return setCfgErr(res.error);
    setServiciosGuardado(true);
    setTimeout(() => setServiciosGuardado(false), 2500);
  }

  async function resolverReserva(id: string, estado: "aprobada" | "rechazada") {
    if (resolviendo.has(id)) return; // evita doble-tap
    setPendErr(null);
    setResolviendo((s) => new Set(s).add(id));
    const res = await runOrError(() =>
      supabaseBrowser.from("reservations").update({ estado }).eq("id", id)
    );
    if (!res.ok) {
      setPendErr(res.error);
      setResolviendo((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
      return; // NO se remueve: la reserva sigue pendiente en la BD
    }
    setPendientes((l) => l.filter((x) => x.id !== id));
    setResolviendo((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
  }

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

        <h1 className="text-2xl font-bold text-slate-800 mt-4">Áreas comunes</h1>
        <p className="text-sm text-slate-500">Gestiona reglas, horarios y aprobaciones.</p>

        {/* Umbral de adeudo para reservar (por villa) */}
        <section className="mt-6">
          <h2 className="text-sm font-bold text-slate-700 mb-2">Tolerancia de adeudo para reservar</h2>
          <div className="bg-white rounded-2xl ring-1 ring-slate-100 p-3.5">
            <p className="text-xs text-slate-500 mb-2">
              Una casa puede reservar si su saldo es ≤ este monto. Déjalo en $0 para exigir estar
              totalmente al corriente.
            </p>
            <div className="flex items-center gap-2">
              <span className="text-slate-400">$</span>
              <input
                type="number"
                min={0}
                step={50}
                value={umbral}
                onChange={(e) => setUmbral(Math.max(0, Number(e.target.value)))}
                className="flex-1 rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
              />
              <button
                onClick={guardarUmbral}
                className="rounded-xl bg-brand-500 text-white text-sm font-semibold px-4 py-2 hover:bg-brand-600"
              >
                {umbralGuardado ? "Guardado ✓" : "Guardar"}
              </button>
            </div>
            {cfgErr && (
              <p className="text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2 ring-1 ring-red-200 mt-2">
                {cfgErr}
              </p>
            )}
          </div>
        </section>

        {/* Tope de multas (por villa) */}
        <section className="mt-5">
          <h2 className="text-sm font-bold text-slate-700 mb-2">Tope de multas</h2>
          <div className="bg-white rounded-2xl ring-1 ring-slate-100 p-3.5">
            <p className="text-xs text-slate-500 mb-2">
              La multa escala por reincidencia (base × veces) pero nunca supera este tope.
            </p>
            <div className="flex items-center gap-2">
              <span className="text-slate-400">$</span>
              <input
                type="number"
                min={0}
                step={100}
                value={tope}
                onChange={(e) => setTope(Math.max(0, Number(e.target.value)))}
                className="flex-1 rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
              />
              <button
                onClick={guardarTope}
                className="rounded-xl bg-brand-500 text-white text-sm font-semibold px-4 py-2 hover:bg-brand-600"
              >
                {topeGuardado ? "Guardado ✓" : "Guardar"}
              </button>
            </div>
          </div>
        </section>

        {/* Umbral de adeudo que restringe servicios extra (vigilancia) */}
        <section className="mt-5">
          <h2 className="text-sm font-bold text-slate-700 mb-2">Adeudo que restringe servicios</h2>
          <div className="bg-white rounded-2xl ring-1 ring-slate-100 p-3.5">
            <p className="text-xs text-slate-500 mb-2">
              En el panel de vigilancia, las casas con saldo mayor a este monto aparecen como
              &quot;servicios restringidos&quot;. Las casas con convenio de pago no se restringen.
            </p>
            <div className="flex items-center gap-2">
              <span className="text-slate-400">$</span>
              <input
                type="number"
                min={0}
                step={100}
                value={servicios}
                onChange={(e) => setServicios(Math.max(0, Number(e.target.value)))}
                className="flex-1 rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
              />
              <button
                onClick={guardarServicios}
                className="rounded-xl bg-brand-500 text-white text-sm font-semibold px-4 py-2 hover:bg-brand-600"
              >
                {serviciosGuardado ? "Guardado ✓" : "Guardar"}
              </button>
            </div>
          </div>
        </section>

        {/* Bandeja de aprobación */}
        <section className="mt-6">
          <h2 className="text-sm font-bold text-slate-700 mb-2">
            Reservas por aprobar{" "}
            <span className="text-slate-400 font-medium">({pendientes.length})</span>
          </h2>
          {pendErr && (
            <p className="text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2 ring-1 ring-red-200 mb-2">
              {pendErr}
            </p>
          )}
          {pendientes.length === 0 ? (
            <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
              No hay reservas pendientes 🎉
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {pendientes.map((r) => (
                <li
                  key={r.id}
                  className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-800 truncate">
                      {r.area?.icono} {r.area?.nombre} · Casa {r.house?.numero}
                    </p>
                    <p className="text-xs text-slate-500">
                      {hhmm(r.fecha_hora_inicio)}–
                      {new Date(r.fecha_hora_fin).toLocaleTimeString("es-MX", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                      {r.cantidad_personas ? ` · ${r.cantidad_personas} pers.` : ""}
                    </p>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button
                      onClick={() => resolverReserva(r.id, "aprobada")}
                      disabled={resolviendo.has(r.id)}
                      className="rounded-xl bg-brand-500 text-white text-sm font-semibold px-3 py-2 hover:bg-brand-600 disabled:opacity-40"
                    >
                      {resolviendo.has(r.id) ? "…" : "Aprobar"}
                    </button>
                    <button
                      onClick={() => resolverReserva(r.id, "rechazada")}
                      disabled={resolviendo.has(r.id)}
                      className="rounded-xl border border-slate-200 text-slate-500 text-sm font-semibold px-3 py-2 hover:bg-slate-50 disabled:opacity-40"
                    >
                      No
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Lista de áreas */}
        <section className="mt-7">
          <h2 className="text-sm font-bold text-slate-700 mb-2">Áreas</h2>
          {areaMsg && (
            <p className="text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2 ring-1 ring-red-200 mb-2">
              {areaMsg}
            </p>
          )}
          <ul className="flex flex-col gap-2">
            {areas.map((a) => (
              <li key={a.id} className="bg-white rounded-2xl ring-1 ring-slate-100 overflow-hidden">
                <div className="p-3.5 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-800 truncate">
                      {a.icono ?? "📍"} {a.nombre}
                    </p>
                    <p className="text-xs text-slate-500">
                      {a.reservable ? "Reservable" : "No reservable"}
                      {!a.activa ? " · inactiva" : ""} ·{" "}
                      {a.exclusiva ? "exclusiva" : "compartida"} ·{" "}
                      {a.aprobacion_automatica ? "auto" : "requiere aprobación"}
                    </p>
                  </div>
                  <button
                    onClick={() => setEditId(editId === a.id ? null : a.id)}
                    className="text-sm text-brand-600 font-semibold shrink-0"
                  >
                    {editId === a.id ? "Cerrar" : "Editar"}
                  </button>
                </div>
                {editId === a.id && (
                  <AreaEditor area={a} onSave={guardar} />
                )}
              </li>
            ))}
          </ul>

          {/* Nueva área */}
          <div className="mt-3 flex gap-2">
            <input
              value={nuevoNombre}
              onChange={(e) => setNuevoNombre(e.target.value)}
              placeholder="Nueva área (ej. Salón de usos múltiples)"
              className="flex-1 rounded-xl ring-1 ring-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
            />
            <button
              onClick={crearArea}
              disabled={!nuevoNombre.trim()}
              className="rounded-xl bg-brand-500 text-white text-sm font-semibold px-4 py-2 disabled:opacity-40"
            >
              Agregar
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}

function AreaEditor({ area, onSave }: { area: Area; onSave: (a: Area) => void }) {
  const [a, setA] = useState<Area>(area);
  const set = <K extends keyof Area>(k: K, v: Area[K]) => setA((prev) => ({ ...prev, [k]: v }));
  const Toggle = ({ k, label }: { k: keyof Area; label: string }) => (
    <button
      onClick={() => set(k, !a[k] as Area[keyof Area])}
      className={`rounded-xl px-3 py-2 text-xs font-semibold ring-1 ${
        a[k] ? "bg-brand-500 text-white ring-brand-500" : "bg-white text-slate-500 ring-slate-200"
      }`}
    >
      {label}
    </button>
  );
  const Num = ({ k, label }: { k: keyof Area; label: string }) => (
    <label className="text-xs text-slate-500">
      {label}
      <input
        type="number"
        value={(a[k] as number) ?? 0}
        onChange={(e) => set(k, Number(e.target.value) as Area[keyof Area])}
        className="mt-1 w-full rounded-lg ring-1 ring-slate-200 px-2 py-1.5 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
      />
    </label>
  );

  return (
    <div className="px-3.5 pb-4 pt-1 border-t border-slate-100 flex flex-col gap-3">
      <div className="flex flex-wrap gap-2 mt-2">
        <Toggle k="activa" label="Activa" />
        <Toggle k="reservable" label="Reservable" />
        <Toggle k="exclusiva" label="Exclusiva" />
        <Toggle k="requiere_aforo" label="Pide aforo" />
        <Toggle k="aprobacion_automatica" label="Auto-aprobar" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-slate-500">
          Apertura
          <input
            type="time"
            value={a.hora_apertura.slice(0, 5)}
            onChange={(e) => set("hora_apertura", `${e.target.value}:00`)}
            className="mt-1 w-full rounded-lg ring-1 ring-slate-200 px-2 py-1.5 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
          />
        </label>
        <label className="text-xs text-slate-500">
          Cierre
          <input
            type="time"
            value={a.hora_cierre.slice(0, 5)}
            onChange={(e) => set("hora_cierre", `${e.target.value}:00`)}
            className="mt-1 w-full rounded-lg ring-1 ring-slate-200 px-2 py-1.5 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
          />
        </label>
        <Num k="duracion_min_horas" label="Duración mín (h)" />
        <Num k="duracion_max_horas" label="Duración máx (h)" />
        <Num k="capacidad_personas" label="Aforo total" />
        <Num k="costo" label="Cuota ($)" />
        <Num k="deposito" label="Depósito ($)" />
        <label className="text-xs text-slate-500">
          Ícono
          <input
            value={a.icono ?? ""}
            onChange={(e) => set("icono", e.target.value)}
            className="mt-1 w-full rounded-lg ring-1 ring-slate-200 px-2 py-1.5 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
          />
        </label>
      </div>
      <label className="text-xs text-slate-500">
        Reglas
        <textarea
          value={a.reglas ?? ""}
          onChange={(e) => set("reglas", e.target.value)}
          rows={3}
          className="mt-1 w-full rounded-lg ring-1 ring-slate-200 px-2 py-1.5 text-slate-800 text-sm outline-none focus:ring-2 focus:ring-brand-300"
        />
      </label>
      <button
        onClick={() => onSave(a)}
        className="rounded-xl bg-gradient-to-br from-brand-500 to-emerald-600 text-white py-2.5 font-bold"
      >
        Guardar cambios
      </button>
    </div>
  );
}
