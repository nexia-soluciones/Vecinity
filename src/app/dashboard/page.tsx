"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { runOrError } from "@/lib/rpc";

type Profile = {
  id: string;
  nombre: string;
  role: string;
  colonia_id: string | null;
  house_id: string | null;
  approval_status: string;
  colonia?: { nombre: string } | null;
};
type House = { numero: string; street: string | null; saldo: number };
type Pending = { id: string; nombre: string; email: string; created_at: string };

const money = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);

// Tiempo que hay que mantener presionado el SOS para activarlo (evita disparos accidentales)
const SOS_HOLD_MS = 2500;

// Captura la ubicación del dispositivo; si se niega o no hay GPS, devuelve null (no bloquea la alerta)
function getCoords(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
    );
  });
}

export default function Dashboard() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [house, setHouse] = useState<House | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [sosState, setSosState] = useState<"idle" | "holding" | "sending" | "sent" | "error">(
    "idle"
  );
  const [holdPct, setHoldPct] = useState(0);
  const holdTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const holdStart = useRef(0);
  const [ready, setReady] = useState(false);
  const [resolviendo, setResolviendo] = useState<Set<string>>(new Set());
  const [pendErr, setPendErr] = useState<string | null>(null);
  const [noLeidos, setNoLeidos] = useState(0);

  const isAdmin = profile?.role === "admin" || profile?.role === "comite";

  const loadPending = useCallback(async () => {
    const { data } = await supabaseBrowser
      .from("profiles")
      .select("id, nombre, email, created_at")
      .eq("approval_status", "pendiente")
      .order("created_at", { ascending: false });
    setPending(data ?? []);
  }, []);

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabaseBrowser.auth.getUser();
      if (!user) return router.replace("/login");

      const { data: prof } = await supabaseBrowser
        .from("profiles")
        .select(
          "id, nombre, role, colonia_id, house_id, approval_status, colonia:colonias(nombre)"
        )
        .eq("id", user.id)
        .maybeSingle();

      const p = prof as unknown as Profile | null;
      if (!p) return router.replace("/esperando");
      if (p.approval_status !== "aprobado") return router.replace("/esperando");
      if (p.role === "guardia") return router.replace("/vigilancia");
      setProfile(p);

      if (p.house_id) {
        const { data: h } = await supabaseBrowser
          .from("houses")
          .select("numero, street, saldo")
          .eq("id", p.house_id)
          .maybeSingle();
        setHouse(h as unknown as House | null);
      }
      const esAdmin = p.role === "admin" || p.role === "comite";
      if (esAdmin) await loadPending();
      // Badge de no leídos: solo para el residente (sus comunicados dirigidos).
      // El comité redacta, no recibe, así que no le mostramos conteo.
      if (!esAdmin && p.house_id) {
        const { count } = await supabaseBrowser
          .from("comunicados")
          .select("id", { count: "exact", head: true })
          .is("leido_at", null)
          .eq("house_id", p.house_id);
        setNoLeidos(count ?? 0);
      }
      setReady(true);
    })();
  }, [router, loadPending]);

  const dispararSOS = useCallback(async () => {
    // Sin colonia ligada no se puede enviar: mostrar error en vez de quedar colgado en "holding"
    if (!profile?.colonia_id) {
      setSosState("error");
      return;
    }
    setSosState("sending");
    const coords = await getCoords();
    const { error } = await supabaseBrowser.from("sos_events").insert({
      colonia_id: profile.colonia_id,
      profile_id: profile.id,
      house_id: profile.house_id,
      mode: "loud",
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
    });
    if (error) {
      setSosState("error");
      return;
    }
    setSosState("sent");
    setTimeout(() => setSosState("idle"), 6000);
  }, [profile]);

  function clearHold() {
    if (holdTimer.current) {
      clearInterval(holdTimer.current);
      holdTimer.current = null;
    }
  }

  function startHold() {
    if (sosState === "sending" || sosState === "sent") return;
    setSosState("holding");
    setHoldPct(0);
    holdStart.current = Date.now();
    holdTimer.current = setInterval(() => {
      const pct = Math.min(100, ((Date.now() - holdStart.current) / SOS_HOLD_MS) * 100);
      setHoldPct(pct);
      if (pct >= 100) {
        clearHold();
        setHoldPct(0);
        dispararSOS();
      }
    }, 50);
  }

  function cancelHold() {
    clearHold();
    setSosState((s) => (s === "holding" ? "idle" : s));
    setHoldPct(0);
  }

  // Limpia el temporizador si el componente se desmonta a medio hold
  useEffect(() => () => clearHold(), []);

  async function resolver(id: string, status: "aprobado" | "rechazado") {
    if (resolviendo.has(id)) return; // evita doble-tap
    setPendErr(null);
    setResolviendo((s) => new Set(s).add(id));
    const res = await runOrError(() =>
      supabaseBrowser.from("profiles").update({ approval_status: status }).eq("id", id)
    );
    setResolviendo((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    if (!res.ok) {
      setPendErr(res.error);
      return; // NO se remueve: la solicitud sigue pendiente en la BD
    }
    setPending((list) => list.filter((x) => x.id !== id));
  }

  async function salir() {
    await supabaseBrowser.auth.signOut();
    router.replace("/login");
  }

  if (!ready)
    return (
      <main className="flex-1 flex items-center justify-center text-slate-400">
        Cargando…
      </main>
    );

  const saldo = house?.saldo ?? 0;
  const conAdeudo = saldo > 0;

  return (
    <main className="flex-1 bg-gradient-to-b from-brand-50 via-white to-sky-50">
      <div className="w-full max-w-md mx-auto px-5 py-6 flex flex-col">
        {/* Top bar */}
        <div className="flex items-center justify-between">
          <Image src="/brand/vecinity-logo.svg" alt="Vecinity" width={150} height={43} priority />
          <button
            onClick={salir}
            className="text-xs text-slate-400 hover:text-slate-600"
          >
            Salir
          </button>
        </div>

        {/* Saludo */}
        <div className="mt-5">
          <p className="text-slate-500 text-sm">
            {profile?.colonia?.nombre ?? "Tu colonia"}
          </p>
          <h1 className="text-2xl font-bold text-slate-800">
            Hola, {profile?.nombre?.split(" ")[0]} 👋
          </h1>
          {isAdmin && (
            <span className="inline-block mt-1 text-[11px] font-semibold tracking-wide text-nexia bg-purple-50 rounded-full px-2.5 py-0.5">
              {profile?.role === "admin" ? "ADMINISTRADOR" : "COMITÉ"}
            </span>
          )}
        </div>

        {/* Saldo — abre el estado de cuenta del residente */}
        {house && (
          <button
            onClick={() => router.push("/dashboard/mi-cuenta")}
            className={`mt-5 w-full text-left rounded-3xl p-5 text-white shadow-lg transition hover:brightness-105 ${
              conAdeudo
                ? "bg-gradient-to-br from-amber-500 to-orange-600"
                : "bg-gradient-to-br from-brand-500 to-emerald-600"
            }`}
          >
            <p className="text-white/80 text-sm">
              Casa {house.numero}
              {house.street ? ` · ${house.street}` : ""}
            </p>
            <p className="text-3xl font-extrabold mt-1">{money(saldo)}</p>
            <p className="text-white/90 text-sm mt-1 flex items-center justify-between">
              <span>{conAdeudo ? "Saldo pendiente por pagar" : "Estás al corriente ✓"}</span>
              <span className="text-white/90">Ver detalle ›</span>
            </p>
          </button>
        )}

        {/* Comunicados */}
        <button
          onClick={() => router.push("/dashboard/comunicados")}
          className="mt-5 w-full rounded-3xl bg-white ring-1 ring-purple-200 p-4 flex items-center gap-3 text-left hover:ring-purple-300 transition shadow-sm"
        >
          <span className="text-3xl">📣</span>
          <span>
            <span className="block font-bold text-slate-800">Comunicados</span>
            <span className="block text-xs text-slate-500">Avisos del comité y de Caty</span>
          </span>
          {noLeidos > 0 ? (
            <span className="ml-auto bg-red-500 text-white text-xs font-bold rounded-full px-2.5 py-1">
              {noLeidos}
            </span>
          ) : (
            <span className="ml-auto text-nexia text-xl">›</span>
          )}
        </button>

        {/* Reservar áreas comunes (función activa) */}
        <button
          onClick={() => router.push("/dashboard/reservas")}
          className="mt-5 w-full rounded-3xl bg-white ring-1 ring-brand-200 p-4 flex items-center gap-3 text-left hover:ring-brand-300 transition shadow-sm"
        >
          <span className="text-3xl">🏖️</span>
          <span>
            <span className="block font-bold text-slate-800">Reservar áreas comunes</span>
            <span className="block text-xs text-slate-500">Alberca y terraza · disponibilidad en vivo</span>
          </span>
          <span className="ml-auto text-brand-500 text-xl">›</span>
        </button>

        {/* Acciones rápidas */}
        <div className="grid grid-cols-2 gap-3 mt-3">
          <Action emoji="💳" label="Pagar / Subir comprobante" onClick={() => router.push("/dashboard/pagos")} />
          <Action emoji="🚗" label="Mis vehículos" onClick={() => router.push("/dashboard/vehiculos")} />
          <Action emoji="👮" label="Registrar visita" onClick={() => router.push("/dashboard/visitas")} />
          <Action emoji="📣" label="Reportar incidencia" onClick={() => router.push("/dashboard/incidencias")} />
        </div>

        {/* Botón SOS — mantener presionado para activar */}
        <button
          onPointerDown={startHold}
          onPointerUp={cancelHold}
          onPointerLeave={cancelHold}
          onPointerCancel={cancelHold}
          onContextMenu={(e) => e.preventDefault()}
          disabled={sosState === "sending" || sosState === "sent"}
          className="relative overflow-hidden mt-5 rounded-3xl bg-gradient-to-br from-red-500 to-red-600 text-white py-5 font-extrabold text-lg shadow-lg select-none touch-none active:scale-[0.99] transition disabled:opacity-95"
        >
          {sosState === "holding" && (
            <span
              className="absolute inset-y-0 left-0 bg-red-800/50"
              style={{ width: `${holdPct}%` }}
              aria-hidden
            />
          )}
          <span className="relative">
            {sosState === "sent"
              ? "🚨 SOS enviado — viene ayuda"
              : sosState === "sending"
              ? "Enviando alerta…"
              : sosState === "error"
              ? "⚠️ No se envió — mantén presionado de nuevo"
              : sosState === "holding"
              ? "Sigue presionando para enviar…"
              : "🆘 Botón de pánico — mantén presionado"}
          </span>
        </button>

        {/* Panel comité — aprobaciones */}
        {isAdmin && (
          <section className="mt-7">
            <button
              onClick={() => router.push("/dashboard/comite")}
              className="mb-3 w-full rounded-2xl bg-gradient-to-br from-brand-500 to-emerald-600 p-3.5 flex items-center gap-3 text-left shadow hover:opacity-95 transition"
            >
              <span className="text-2xl">📊</span>
              <span className="block font-semibold text-white text-sm">
                Panel del comité
                <span className="block text-xs text-white/80 font-normal">
                  Pendientes, finanzas y mayores adeudos
                </span>
              </span>
              <span className="ml-auto text-white/80 text-lg">›</span>
            </button>
            <button
              onClick={() => router.push("/vigilancia")}
              className="mb-3 w-full rounded-2xl bg-slate-800 ring-1 ring-slate-700 p-3.5 flex items-center gap-3 text-left hover:bg-slate-700 transition"
            >
              <span className="text-2xl">🛡️</span>
              <span className="block font-semibold text-white text-sm">
                Vigilancia
                <span className="block text-xs text-slate-300 font-normal">
                  Turno, visitas, reservas, placas y paquetes
                </span>
              </span>
              <span className="ml-auto text-slate-300 text-lg">›</span>
            </button>
            <button
              onClick={() => router.push("/dashboard/areas")}
              className="mb-3 w-full rounded-2xl bg-purple-50 ring-1 ring-purple-100 p-3.5 flex items-center gap-3 text-left hover:ring-purple-200 transition"
            >
              <span className="text-2xl">🏖️</span>
              <span className="block font-semibold text-slate-800 text-sm">
                Gestionar áreas comunes
                <span className="block text-xs text-slate-500 font-normal">
                  Reglas, horarios y aprobación de reservas
                </span>
              </span>
              <span className="ml-auto text-nexia text-lg">›</span>
            </button>
            <h2 className="text-sm font-bold text-slate-700 mb-2">
              Solicitudes pendientes{" "}
              <span className="text-slate-400 font-medium">({pending.length})</span>
            </h2>
            {pendErr && (
              <p className="text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2 ring-1 ring-red-200 mb-2">
                {pendErr}
              </p>
            )}
            {pending.length === 0 ? (
              <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
                No hay solicitudes por revisar 🎉
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {pending.map((u) => (
                  <li
                    key={u.id}
                    className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100 flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-800 truncate">{u.nombre}</p>
                      <p className="text-xs text-slate-400 truncate">{u.email}</p>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button
                        onClick={() => resolver(u.id, "aprobado")}
                        disabled={resolviendo.has(u.id)}
                        className="rounded-xl bg-brand-500 text-white text-sm font-semibold px-3 py-2 hover:bg-brand-600 disabled:opacity-40"
                      >
                        {resolviendo.has(u.id) ? "…" : "Aprobar"}
                      </button>
                      <button
                        onClick={() => resolver(u.id, "rechazado")}
                        disabled={resolviendo.has(u.id)}
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
        )}

        <footer className="mt-10 mb-2 flex justify-center">
          <Image
            src="/brand/powered-by-nexia.svg"
            alt="Powered by NexIA"
            width={140}
            height={28}
            className="opacity-80"
          />
        </footer>
      </div>
    </main>
  );
}

function Action({
  emoji,
  label,
  onClick,
}: {
  emoji: string;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="bg-white rounded-2xl p-4 ring-1 ring-slate-100 text-left hover:ring-brand-200 transition"
    >
      <span className="text-2xl">{emoji}</span>
      <p className="text-sm font-medium text-slate-700 mt-2 leading-tight">{label}</p>
    </button>
  );
}
