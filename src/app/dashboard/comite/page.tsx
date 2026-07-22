"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { callRpc } from "@/lib/rpc";
import AccesoRfid from "./AccesoRfid";
import AccesoPeatonal from "./AccesoPeatonal";
import CamaraPuerta from "@/app/_components/CamaraPuerta";
import AvisoPrivacidadAvance from "./AvisoPrivacidadAvance";

const money = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);

type Moroso = { numero: string; saldo: number };
type Vigilante = {
  id: string;
  estado: string;
  postulado_at: string;
  profile: { nombre: string; house: { numero: string } | null } | null;
};
type Convenio = {
  plan_id: string;
  casa: string;
  monto_semanal: number;
  monto_acordado: number | null;
  saldo_actual: number;
  semanas: number;
  esperado: number;
  abonado: number;
  al_dia: boolean;
};

const periodoActual = () =>
  new Date().toLocaleDateString("es-MX", { month: "long", year: "numeric" });

async function countOf(
  tabla: string,
  col: string,
  val: string
): Promise<number> {
  const { count } = await supabaseBrowser
    .from(tabla)
    .select("id", { count: "exact", head: true })
    .eq(col, val);
  return count ?? 0;
}

export default function PanelComite() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [pend, setPend] = useState({ abonos: 0, vehiculos: 0, incidencias: 0, vecinos: 0, credenciales: 0 });
  const [fin, setFin] = useState({ adeudo: 0, favor: 0, morosos: 0, alCorriente: 0 });
  const [topMorosos, setTopMorosos] = useState<Moroso[]>([]);
  const [cobrosMsg, setCobrosMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [convenios, setConvenios] = useState<Convenio[]>([]);
  const [cvCasa, setCvCasa] = useState("");
  const [cvSemanal, setCvSemanal] = useState("");
  const [cvNota, setCvNota] = useState("");
  const [cvMsg, setCvMsg] = useState<string | null>(null);
  const [showCv, setShowCv] = useState(false);
  const [cvBusy, setCvBusy] = useState(false);
  const [convMsg, setConvMsg] = useState<string | null>(null);
  const [cerrando, setCerrando] = useState<Set<string>>(new Set());
  const [propCasa, setPropCasa] = useState("");
  const [propMsg, setPropMsg] = useState<string | null>(null);
  const [propToken, setPropToken] = useState<string | null>(null);
  const [propBusy, setPropBusy] = useState(false);
  const [vigilantes, setVigilantes] = useState<Vigilante[]>([]);
  const [vigMsg, setVigMsg] = useState<string | null>(null);
  const [vigBusy, setVigBusy] = useState<Set<string>>(new Set());

  const cargarFinanzas = useCallback(async () => {
    const [abonos, vehiculos, incidencias, vecinos, credenciales] = await Promise.all([
      countOf("transactions", "estado", "pendiente"),
      countOf("vehicles", "estado", "pendiente"),
      countOf("incident_reports", "estado", "pendiente"),
      countOf("profiles", "approval_status", "pendiente"),
      countOf("card_requests", "estado", "solicitada"),
    ]);
    setPend({ abonos, vehiculos, incidencias, vecinos, credenciales });
    const { data: casas } = await supabaseBrowser.from("houses").select("numero, saldo");
    const arr = (casas as unknown as Moroso[]) ?? [];
    let adeudo = 0,
      favor = 0,
      morosos = 0,
      alCorriente = 0;
    for (const h of arr) {
      const s = Number(h.saldo) || 0;
      if (s > 0) {
        adeudo += s;
        morosos++;
      } else {
        favor += -s;
        alCorriente++;
      }
    }
    setFin({ adeudo, favor, morosos, alCorriente });
    setTopMorosos(
      arr
        .filter((h) => Number(h.saldo) > 0)
        .sort((a, b) => Number(b.saldo) - Number(a.saldo))
        .slice(0, 8)
    );
  }, []);

  const cargarConvenios = useCallback(async () => {
    const { data } = await supabaseBrowser.rpc("convenios_seguimiento");
    setConvenios((data as unknown as Convenio[]) ?? []);
  }, []);

  const cargarVigilantes = useCallback(async () => {
    const { data } = await supabaseBrowser
      .from("vigilantes")
      .select("id, estado, postulado_at, profile:profiles(nombre, house:houses(numero))")
      .in("estado", ["postulado", "aprobado"])
      .order("postulado_at", { ascending: false });
    setVigilantes((data as unknown as Vigilante[]) ?? []);
  }, []);

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabaseBrowser.auth.getUser();
      if (!user) return router.replace("/login");
      const { data: prof } = await supabaseBrowser
        .from("profiles")
        .select("role, approval_status")
        .eq("id", user.id)
        .maybeSingle();
      const p = prof as unknown as { role: string; approval_status: string } | null;
      if (!p || p.approval_status !== "aprobado") return router.replace("/esperando");
      if (p.role !== "admin" && p.role !== "comite") return router.replace("/dashboard");
      await Promise.all([cargarFinanzas(), cargarConvenios(), cargarVigilantes()]);
      setReady(true);
    })();
  }, [router, cargarFinanzas, cargarConvenios]);

  async function generarCobros() {
    setBusy(true);
    setCobrosMsg(null);
    const { data, error } = await supabaseBrowser.rpc("generar_cobros_mensuales", { p_periodo: null });
    setBusy(false);
    if (error) return setCobrosMsg(error.message.replace(/^.*?:\s/, ""));
    const r = data as unknown as { casas_cobradas: number; cuota: number };
    setCobrosMsg(`Cobros generados: ${r.casas_cobradas} casas × ${money(r.cuota)}.`);
    await cargarFinanzas();
  }

  async function aplicarRecargos() {
    setBusy(true);
    setCobrosMsg(null);
    const { data, error } = await supabaseBrowser.rpc("aplicar_recargos", { p_periodo: null });
    setBusy(false);
    if (error) return setCobrosMsg(error.message.replace(/^.*?:\s/, ""));
    const r = data as unknown as { casas_recargadas: number; recargo: number };
    setCobrosMsg(`Recargos aplicados: ${r.casas_recargadas} casas × ${money(r.recargo)}.`);
    await cargarFinanzas();
  }

  async function crearConvenio() {
    if (cvBusy) return; // evita doble-tap
    setCvMsg(null);
    if (!cvCasa.trim() || !cvSemanal.trim()) return setCvMsg("Casa y monto semanal son obligatorios.");
    const semanal = parseFloat(cvSemanal);
    if (!Number.isFinite(semanal) || semanal <= 0) return setCvMsg("El monto semanal debe ser mayor a 0.");
    setCvBusy(true);
    try {
      const { data: h } = await supabaseBrowser
        .from("houses")
        .select("id")
        .eq("numero", cvCasa.trim())
        .maybeSingle();
      const house = h as unknown as { id: string } | null;
      if (!house) return setCvMsg(`No encontré la casa ${cvCasa}.`);
      const res = await callRpc("crear_convenio", {
        p_house_id: house.id,
        p_monto_semanal: semanal,
        p_monto_acordado: null,
        p_nota: cvNota.trim() || null,
      });
      if (!res.ok) return setCvMsg(res.error);
      setCvCasa("");
      setCvSemanal("");
      setCvNota("");
      setShowCv(false);
      await Promise.all([cargarConvenios(), cargarFinanzas()]);
    } finally {
      setCvBusy(false);
    }
  }

  async function resolverVigilante(id: string, accion: "aprobar" | "baja") {
    if (vigBusy.has(id)) return; // evita doble-tap
    setVigMsg(null);
    setVigBusy((s) => new Set(s).add(id));
    const res = await callRpc("resolver_vigilante", { p_id: id, p_accion: accion });
    setVigBusy((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    if (!res.ok) return setVigMsg(res.error);
    await cargarVigilantes();
  }

  async function generarCodigoPropietario() {
    if (propBusy) return; // evita doble-tap
    setPropMsg(null);
    setPropToken(null);
    if (!propCasa.trim()) return setPropMsg("Escribe el número de casa.");
    setPropBusy(true);
    try {
      const { data: h } = await supabaseBrowser
        .from("houses")
        .select("id")
        .eq("numero", propCasa.trim())
        .maybeSingle();
      const house = h as unknown as { id: string } | null;
      if (!house) return setPropMsg(`No encontré la casa ${propCasa}.`);
      const { data, error } = await supabaseBrowser.rpc("crear_invitacion_propietario", {
        p_house_id: house.id,
      });
      if (error) return setPropMsg(error.message.replace(/^.*?:\s/, ""));
      const r = data as unknown as { ok: boolean; token: string; nueva: boolean };
      setPropToken(r.token);
      setPropMsg(
        r.nueva
          ? "Código generado. Compártelo con el dueño de la casa."
          : "Esta casa ya tenía un código vigente sin usar — es este."
      );
    } finally {
      setPropBusy(false);
    }
  }

  async function cerrarConvenio(id: string) {
    if (cerrando.has(id)) return; // evita doble-tap
    setConvMsg(null);
    setCerrando((s) => new Set(s).add(id));
    const res = await callRpc("cerrar_convenio", { p_id: id });
    setCerrando((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    if (!res.ok) return setConvMsg(res.error);
    await Promise.all([cargarConvenios(), cargarFinanzas()]);
  }

  if (!ready)
    return (
      <main className="flex-1 flex items-center justify-center text-slate-400">Cargando…</main>
    );

  const pendientes = [
    { label: "Abonos", n: pend.abonos, emoji: "💳", to: "/dashboard/pagos" },
    { label: "Vehículos", n: pend.vehiculos, emoji: "🚗", to: "/dashboard/vehiculos" },
    { label: "Incidencias", n: pend.incidencias, emoji: "📣", to: "/dashboard/incidencias" },
    { label: "Vecinos", n: pend.vecinos, emoji: "👤", to: "/dashboard" },
    { label: "Credenciales", n: pend.credenciales, emoji: "🪪", to: "/dashboard/credenciales" },
  ];

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

        <h1 className="text-2xl font-bold text-slate-800 mt-4">Panel del comité</h1>

        {/* Pendientes */}
        <section className="mt-5">
          <h2 className="text-sm font-bold text-slate-700 mb-2">Pendientes por revisar</h2>
          <div className="grid grid-cols-2 gap-3">
            {pendientes.map((c) => (
              <button
                key={c.label}
                onClick={() => router.push(c.to)}
                className="bg-white rounded-2xl p-4 ring-1 ring-slate-100 text-left hover:ring-brand-200 transition relative"
              >
                <span className="text-2xl">{c.emoji}</span>
                <p className="text-sm font-medium text-slate-600 mt-2">{c.label}</p>
                <p
                  className={`text-2xl font-extrabold ${
                    c.n > 0 ? "text-brand-600" : "text-slate-300"
                  }`}
                >
                  {c.n}
                </p>
              </button>
            ))}
          </div>
        </section>

        {/* Finanzas */}
        <section className="mt-6">
          <h2 className="text-sm font-bold text-slate-700 mb-2">Finanzas de la colonia</h2>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-2xl p-4 bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow">
              <p className="text-white/80 text-xs">Adeudo total</p>
              <p className="text-xl font-extrabold mt-1">{money(fin.adeudo)}</p>
              <p className="text-white/80 text-xs mt-1">{fin.morosos} casas con adeudo</p>
            </div>
            <div className="rounded-2xl p-4 bg-gradient-to-br from-brand-500 to-emerald-600 text-white shadow">
              <p className="text-white/80 text-xs">Saldo a favor</p>
              <p className="text-xl font-extrabold mt-1">{money(fin.favor)}</p>
              <p className="text-white/80 text-xs mt-1">{fin.alCorriente} al corriente</p>
            </div>
          </div>
          <button
            onClick={() => router.push("/dashboard/estado-cuenta")}
            className="mt-3 w-full rounded-2xl bg-white ring-1 ring-slate-100 p-3.5 flex items-center gap-3 text-left hover:ring-brand-200 transition shadow-sm"
          >
            <span className="text-2xl">📋</span>
            <span>
              <span className="block font-semibold text-slate-800 text-sm">Estado de cuenta por casa</span>
              <span className="block text-xs text-slate-500">Busca una casa y revisa sus cargos y pagos</span>
            </span>
            <span className="ml-auto text-brand-500 text-lg">›</span>
          </button>
          <button
            onClick={() => router.push("/dashboard/gastos")}
            className="mt-2 w-full rounded-2xl bg-white ring-1 ring-slate-100 p-3.5 flex items-center gap-3 text-left hover:ring-brand-200 transition shadow-sm"
          >
            <span className="text-2xl">🧾</span>
            <span>
              <span className="block font-semibold text-slate-800 text-sm">Gastos de la colonia</span>
              <span className="block text-xs text-slate-500">Registrar, desglose por categoría y export CSV</span>
            </span>
            <span className="ml-auto text-brand-500 text-lg">›</span>
          </button>
          <button
            onClick={() => router.push("/dashboard/conciliacion")}
            className="mt-2 w-full rounded-2xl bg-white ring-1 ring-slate-100 p-3.5 flex items-center gap-3 text-left hover:ring-brand-200 transition shadow-sm"
          >
            <span className="text-2xl">🏦</span>
            <span>
              <span className="block font-semibold text-slate-800 text-sm">Conciliación bancaria</span>
              <span className="block text-xs text-slate-500">Sube el estado de cuenta: pagos a casas y gastos</span>
            </span>
            <span className="ml-auto text-brand-500 text-lg">›</span>
          </button>
          <button
            onClick={() => router.push("/dashboard/proyectos")}
            className="mt-2 w-full rounded-2xl bg-white ring-1 ring-slate-100 p-3.5 flex items-center gap-3 text-left hover:ring-brand-200 transition shadow-sm"
          >
            <span className="text-2xl">📁</span>
            <span>
              <span className="block font-semibold text-slate-800 text-sm">Proyectos de mejora</span>
              <span className="block text-xs text-slate-500">Pagos, contratos y cotizaciones por proyecto</span>
            </span>
            <span className="ml-auto text-brand-500 text-lg">›</span>
          </button>
          <button
            onClick={() => router.push("/dashboard/auditoria")}
            className="mt-2 w-full rounded-2xl bg-white ring-1 ring-slate-100 p-3.5 flex items-center gap-3 text-left hover:ring-brand-200 transition shadow-sm"
          >
            <span className="text-2xl">🔎</span>
            <span>
              <span className="block font-semibold text-slate-800 text-sm">Auditoría de pagos</span>
              <span className="block text-xs text-slate-500">Detecta abonos duplicados para revisar</span>
            </span>
            <span className="ml-auto text-brand-500 text-lg">›</span>
          </button>
          <button
            onClick={() => router.push("/dashboard/multas")}
            className="mt-2 w-full rounded-2xl bg-white ring-1 ring-slate-100 p-3.5 flex items-center gap-3 text-left hover:ring-brand-200 transition shadow-sm"
          >
            <span className="text-2xl">🚨</span>
            <span>
              <span className="block font-semibold text-slate-800 text-sm">Multas por casa</span>
              <span className="block text-xs text-slate-500">Revisa, corrige el monto o cancela multas duplicadas</span>
            </span>
            <span className="ml-auto text-brand-500 text-lg">›</span>
          </button>
          <button
            onClick={() => router.push("/dashboard/reporte-multas")}
            className="mt-2 w-full rounded-2xl bg-white ring-1 ring-slate-100 p-3.5 flex items-center gap-3 text-left hover:ring-brand-200 transition shadow-sm"
          >
            <span className="text-2xl">✨</span>
            <span>
              <span className="block font-semibold text-slate-800 text-sm">Reporte de multas (IA)</span>
              <span className="block text-xs text-slate-500">Resumen mensual asistido con inteligencia artificial</span>
            </span>
            <span className="ml-auto text-brand-500 text-lg">›</span>
          </button>
        </section>

        {/* Cobros mensuales */}
        <section className="mt-6">
          <h2 className="text-sm font-bold text-slate-700 mb-2">Cobros del mes</h2>
          <div className="bg-white rounded-2xl ring-1 ring-slate-100 p-3.5">
            <p className="text-xs text-slate-500 mb-3 capitalize">
              Periodo: {periodoActual()} · cuota $750 · recargo $100 (después del día 10)
            </p>
            <div className="flex gap-2">
              <button
                onClick={generarCobros}
                disabled={busy}
                className="press flex-1 rounded-xl bg-brand-500 text-white text-sm font-semibold px-3 py-2.5 hover:bg-brand-600 disabled:opacity-40"
              >
                Generar cobros
              </button>
              <button
                onClick={aplicarRecargos}
                disabled={busy}
                className="press flex-1 rounded-xl bg-amber-500 text-white text-sm font-semibold px-3 py-2.5 hover:bg-amber-600 disabled:opacity-40"
              >
                Aplicar recargos
              </button>
            </div>
            {cobrosMsg && <p className="text-xs text-slate-600 mt-2">{cobrosMsg}</p>}
            <p className="text-[11px] text-slate-400 mt-2">
              Ambos son idempotentes: si ya se generaron este mes, no se duplican.
            </p>
          </div>
        </section>

        {/* Convenios de pago */}
        <section className="mt-6">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-bold text-slate-700">
              Convenios de pago{" "}
              <span className="text-slate-400 font-medium">({convenios.length})</span>
            </h2>
            <button onClick={() => setShowCv((v) => !v)} className="text-sm text-brand-600 font-semibold">
              {showCv ? "Cerrar" : "+ Nuevo"}
            </button>
          </div>

          {showCv && (
            <div className="bg-white rounded-2xl ring-1 ring-slate-100 p-3 mb-2 flex flex-col gap-2">
              <div className="flex gap-2">
                <input
                  value={cvCasa}
                  onChange={(e) => setCvCasa(e.target.value)}
                  placeholder="Casa"
                  className="w-24 rounded-xl ring-1 ring-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
                />
                <input
                  value={cvSemanal}
                  onChange={(e) => setCvSemanal(e.target.value)}
                  type="number"
                  placeholder="$ semanal"
                  className="flex-1 rounded-xl ring-1 ring-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
                />
              </div>
              <input
                value={cvNota}
                onChange={(e) => setCvNota(e.target.value)}
                placeholder="Nota (opcional)"
                className="rounded-xl ring-1 ring-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
              />
              {cvMsg && <p className="text-xs text-red-600">{cvMsg}</p>}
              <button
                onClick={crearConvenio}
                disabled={cvBusy}
                className="press rounded-xl bg-brand-500 text-white text-sm font-semibold py-2 hover:bg-brand-600 disabled:opacity-40"
              >
                {cvBusy ? "Creando…" : "Crear convenio"}
              </button>
            </div>
          )}

          {convMsg && (
            <p className="text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2 ring-1 ring-red-200 mb-2">
              {convMsg}
            </p>
          )}
          {convenios.length === 0 ? (
            <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
              Sin convenios activos.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {convenios.map((c) => {
                const pct =
                  c.esperado > 0 ? Math.min(100, Math.round((c.abonado / c.esperado) * 100)) : 100;
                return (
                  <li key={c.plan_id} className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold text-slate-800">
                          Casa {c.casa} · {money(c.monto_semanal)}/sem
                        </p>
                        <p className="text-xs text-slate-500">
                          {c.semanas} sem · abonado {money(c.abonado)} de {money(c.esperado)} esperado
                          · saldo {money(Number(c.saldo_actual))}
                        </p>
                      </div>
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${
                          c.al_dia ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"
                        }`}
                      >
                        {c.al_dia ? "al día" : "atrasado"}
                      </span>
                    </div>
                    <div className="mt-2 h-2 rounded-full bg-slate-100 overflow-hidden">
                      <div
                        className={`h-full ${c.al_dia ? "bg-emerald-500" : "bg-amber-500"}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <button
                      onClick={() => cerrarConvenio(c.plan_id)}
                      disabled={cerrando.has(c.plan_id)}
                      className="mt-2 text-xs text-slate-400 hover:text-slate-600 disabled:opacity-40"
                    >
                      {cerrando.has(c.plan_id) ? "Cerrando…" : "Cerrar convenio"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Ayuda de acceso (olvidó correo / contraseña) */}
        <section className="mt-6">
          <h2 className="text-sm font-bold text-slate-700 mb-2">Acceso de los vecinos</h2>
          <button
            onClick={() => router.push("/dashboard/acceso")}
            className="w-full rounded-2xl bg-white ring-1 ring-slate-100 p-3.5 flex items-center gap-3 text-left hover:ring-brand-200 transition shadow-sm"
          >
            <span className="text-2xl">🔑</span>
            <span>
              <span className="block font-semibold text-slate-800 text-sm">
                Ayuda de acceso
              </span>
              <span className="block text-xs text-slate-500">
                &quot;Olvidé mi correo o mi contraseña&quot;: busca por casa y mándale su enlace
              </span>
            </span>
            <span className="ml-auto text-brand-500 text-lg">›</span>
          </button>
        </section>

        {/* Código de propietario (casas rentadas) */}
        <section className="mt-6">
          <h2 className="text-sm font-bold text-slate-700 mb-2">Acceso para propietario</h2>
          <div className="bg-white rounded-2xl ring-1 ring-slate-100 p-3 flex flex-col gap-2">
            <p className="text-xs text-slate-500">
              Para casas rentadas: genera un código <b>PROP</b> para el dueño que no vive
              ahí. Solo le da acceso a pagos y estado de cuenta de su casa.
            </p>
            <div className="flex gap-2">
              <input
                value={propCasa}
                onChange={(e) => setPropCasa(e.target.value)}
                placeholder="Casa"
                className="w-24 rounded-xl ring-1 ring-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
              />
              <button
                onClick={generarCodigoPropietario}
                disabled={propBusy}
                className="press flex-1 rounded-xl bg-brand-500 text-white text-sm font-semibold py-2 hover:bg-brand-600 disabled:opacity-40"
              >
                {propBusy ? "Generando…" : "Generar código"}
              </button>
            </div>
            {propToken && (
              <button
                onClick={() => navigator.clipboard?.writeText(propToken)}
                className="press rounded-xl bg-slate-800 text-white font-mono text-lg py-2.5 tracking-wider"
                title="Toca para copiar"
              >
                {propToken}
              </button>
            )}
            {propMsg && <p className="text-xs text-slate-600">{propMsg}</p>}
          </div>
        </section>

        {/* Vecinos vigilantes */}
        <section className="mt-6">
          <h2 className="text-sm font-bold text-slate-700 mb-2">
            Vecinos vigilantes{" "}
            <span className="text-slate-400 font-medium">
              ({vigilantes.filter((v) => v.estado === "aprobado").length} activos ·{" "}
              {vigilantes.filter((v) => v.estado === "postulado").length} por revisar)
            </span>
          </h2>
          {vigMsg && (
            <p className="text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2 ring-1 ring-red-200 mb-2">
              {vigMsg}
            </p>
          )}
          {vigilantes.length === 0 ? (
            <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
              Nadie se ha postulado todavía. Los vigilantes reciben todos los SOS por Telegram.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {vigilantes.map((v) => (
                <li
                  key={v.id}
                  className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-800 truncate">
                      🛡️ {v.profile?.nombre ?? "—"}
                      {v.profile?.house?.numero ? ` · Casa ${v.profile.house.numero}` : ""}
                    </p>
                    <p className="text-xs text-slate-500">
                      {v.estado === "postulado" ? "Postulación pendiente" : "Vigilante activo"}
                    </p>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    {v.estado === "postulado" ? (
                      <>
                        <button
                          onClick={() => resolverVigilante(v.id, "aprobar")}
                          disabled={vigBusy.has(v.id)}
                          className="press rounded-xl bg-brand-500 text-white text-sm font-semibold px-3 py-2 hover:bg-brand-600 disabled:opacity-40"
                        >
                          {vigBusy.has(v.id) ? "…" : "Aprobar"}
                        </button>
                        <button
                          onClick={() => resolverVigilante(v.id, "baja")}
                          disabled={vigBusy.has(v.id)}
                          className="press-soft rounded-xl border border-slate-200 text-slate-500 text-sm font-semibold px-3 py-2 hover:bg-slate-50 disabled:opacity-40"
                        >
                          No
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => resolverVigilante(v.id, "baja")}
                        disabled={vigBusy.has(v.id)}
                        className="press-soft rounded-xl border border-slate-200 text-slate-500 text-xs font-semibold px-3 py-2 hover:bg-slate-50 disabled:opacity-40"
                      >
                        {vigBusy.has(v.id) ? "…" : "Dar de baja"}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Acceso RFID de la caseta */}
        <AccesoRfid />
        <AccesoPeatonal />
        <CamaraPuerta conBitacora />
        <AvisoPrivacidadAvance />

        {/* Top morosos */}
        <section className="mt-6 mb-4">
          <h2 className="text-sm font-bold text-slate-700 mb-2">
            Mayores adeudos <span className="text-slate-400 font-medium">(top {topMorosos.length})</span>
          </h2>
          {topMorosos.length === 0 ? (
            <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
              Nadie con adeudo 🎉
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {topMorosos.map((h) => (
                <li
                  key={h.numero}
                  className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100 flex items-center justify-between"
                >
                  <p className="font-semibold text-slate-800">Casa {h.numero}</p>
                  <p className="font-bold text-amber-600">{money(Number(h.saldo))}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
