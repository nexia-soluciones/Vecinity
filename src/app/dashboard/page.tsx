"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { runOrError } from "@/lib/rpc";
import { SosModal, useSos } from "./sos";

type Profile = {
  id: string;
  nombre: string;
  role: string;
  colonia_id: string | null;
  house_id: string | null;
  approval_status: string;
  telegram_chat_id: string | null;
  colonia?: { nombre: string } | null;
};

// Bot de Telegram (Caty). Deep-link de vinculación: t.me/<bot>?start=vecino_<profileId>
const TELEGRAM_BOT = process.env.NEXT_PUBLIC_TELEGRAM_BOT;
type House = { numero: string; street: string | null; saldo: number };
// Casa donde NO vivo pero soy propietario (casa rentada) — solo finanzas
type CasaPropia = { id: string; numero: string; street: string | null; saldo: number };
type Pending = { id: string; nombre: string; email: string; created_at: string };

const money = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);

export default function Dashboard() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [house, setHouse] = useState<House | null>(null);
  const [casasPropias, setCasasPropias] = useState<CasaPropia[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const { sosState, holdPct, alerta, startHold, cancelHold, cerrar } = useSos();
  const [vigEstado, setVigEstado] = useState<string | null>(null);
  const [vigMsg, setVigMsg] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [tgChecking, setTgChecking] = useState(false);
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
          "id, nombre, role, colonia_id, house_id, approval_status, telegram_chat_id, colonia:colonias(nombre)"
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
      // Casas donde soy propietario sin vivir ahí (rentadas)
      const { data: hm } = await supabaseBrowser
        .from("house_members")
        .select("house_id, house:houses(numero, street, saldo)")
        .eq("profile_id", user.id);
      setCasasPropias(
        ((hm as unknown as {
          house_id: string;
          house: { numero: string; street: string | null; saldo: number } | null;
        }[]) ?? [])
          .filter((m) => m.house && m.house_id !== p.house_id)
          .map((m) => ({ id: m.house_id, ...m.house! }))
      );
      const esAdmin = p.role === "admin" || p.role === "comite";
      if (esAdmin) await loadPending();
      // estado de mi postulación como vecino vigilante (solo residentes con casa)
      if (p.house_id) {
        const { data: vig } = await supabaseBrowser
          .from("vigilantes")
          .select("estado")
          .eq("profile_id", p.id)
          .maybeSingle();
        setVigEstado((vig as { estado: string } | null)?.estado ?? null);
      }
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

  // Abre Caty en Telegram con el deep-link de vinculación (n8n liga el chat).
  function conectarCaty() {
    if (!profile || !TELEGRAM_BOT) return;
    window.open(`https://t.me/${TELEGRAM_BOT}?start=vecino_${profile.id}`, "_blank", "noopener");
  }
  // Re-consulta si ya quedó vinculado (n8n escribe telegram_chat_id de forma asíncrona).
  async function verificarCaty() {
    if (!profile) return;
    setTgChecking(true);
    const { data } = await supabaseBrowser
      .from("profiles")
      .select("telegram_chat_id")
      .eq("id", profile.id)
      .maybeSingle();
    const chat = (data as { telegram_chat_id: string | null } | null)?.telegram_chat_id ?? null;
    setProfile((p) => (p ? { ...p, telegram_chat_id: chat } : p));
    setTgChecking(false);
  }

  async function postularme() {
    setVigMsg(null);
    const { error } = await supabaseBrowser.rpc("postular_vigilante");
    if (error) return setVigMsg(error.message.replace(/^.*?:\s/, ""));
    setVigEstado("postulado");
    setVigMsg("¡Gracias! Tu postulación quedó en revisión del comité.");
  }

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
  // Dueño externo puro: no vive en la colonia, solo administra casas rentadas.
  // Ve finanzas de sus casas; sin visitas, reservas, vehículos, incidencias ni SOS.
  const soloPropietario = !profile?.house_id && casasPropias.length > 0;

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

        {/* Casas rentadas de las que soy dueño — solo finanzas */}
        {casasPropias.map((c) => {
          const debe = Number(c.saldo) > 0;
          return (
            <button
              key={c.id}
              onClick={() => router.push("/dashboard/pagos")}
              className={`mt-5 w-full text-left rounded-3xl p-5 text-white shadow-lg transition hover:brightness-105 ${
                debe
                  ? "bg-gradient-to-br from-amber-500 to-orange-600"
                  : "bg-gradient-to-br from-slate-600 to-slate-800"
              }`}
            >
              <p className="text-white/80 text-sm">
                Casa {c.numero}
                {c.street ? ` · ${c.street}` : ""} · <span className="font-semibold">tu propiedad</span>
              </p>
              <p className="text-3xl font-extrabold mt-1">{money(Number(c.saldo))}</p>
              <p className="text-white/90 text-sm mt-1 flex items-center justify-between">
                <span>{debe ? "Saldo pendiente por pagar" : "Al corriente ✓"}</span>
                <span className="text-white/90">Pagar ›</span>
              </p>
            </button>
          );
        })}

        {/* Conectar Caty (Telegram) — solo si el residente aún no está vinculado */}
        {profile && !profile.telegram_chat_id && TELEGRAM_BOT && (
          <div className="mt-5 w-full rounded-3xl bg-white ring-1 ring-sky-200 p-4 shadow-sm">
            <div className="flex items-center gap-3">
              <span className="text-3xl">💬</span>
              <div className="min-w-0">
                <p className="font-bold text-slate-800">Conecta con Caty en Telegram</p>
                <p className="text-xs text-slate-500">
                  Recibe avisos del comité, tu estado de cuenta y alertas directo en tu celular.
                </p>
              </div>
            </div>
            <div className="flex gap-2 mt-3">
              <button
                onClick={conectarCaty}
                className="press flex-1 rounded-xl bg-sky-500 text-white font-semibold text-sm px-4 py-2.5 hover:bg-sky-600"
              >
                Conectar con Caty
              </button>
              <button
                onClick={verificarCaty}
                disabled={tgChecking}
                className="rounded-xl ring-1 ring-slate-200 text-slate-600 font-semibold text-sm px-4 py-2.5 hover:bg-slate-50 disabled:opacity-40"
              >
                {tgChecking ? "…" : "Ya lo hice"}
              </button>
            </div>
          </div>
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

        {/* Reservar áreas comunes (función activa) — no aplica al dueño externo */}
        {!soloPropietario && (
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
        )}

        {/* Calendario general de reservas (solo lectura, para ver ocupación) */}
        {!soloPropietario && (
        <button
          onClick={() => router.push("/dashboard/reservas/calendario")}
          className="mt-3 w-full rounded-3xl bg-white ring-1 ring-sky-200 p-4 flex items-center gap-3 text-left hover:ring-sky-300 transition shadow-sm"
        >
          <span className="text-3xl">📅</span>
          <span>
            <span className="block font-bold text-slate-800">Calendario de reservas</span>
            <span className="block text-xs text-slate-500">Mira qué áreas están ocupadas y cuándo</span>
          </span>
          <span className="ml-auto text-sky-500 text-xl">›</span>
        </button>
        )}

        {/* Acciones rápidas */}
        <div className="grid grid-cols-2 gap-3 mt-3">
          <Action emoji="💳" label="Pagar / Subir comprobante" onClick={() => router.push("/dashboard/pagos")} />
          {!soloPropietario && (
            <>
              <Action emoji="🚗" label="Mis vehículos" onClick={() => router.push("/dashboard/vehiculos")} />
              <Action emoji="🪪" label="Credenciales de acceso" onClick={() => router.push("/dashboard/credenciales")} />
              <Action emoji="👮" label="Registrar visita" onClick={() => router.push("/dashboard/visitas")} />
              <Action emoji="📣" label="Reportar incidencia" onClick={() => router.push("/dashboard/incidencias")} />
            </>
          )}
          <Action emoji="📊" label="Finanzas de la colonia" onClick={() => router.push("/dashboard/finanzas")} />
        </div>

        {/* Botón SOS — mantener presionado para activar (no aplica al dueño externo) */}
        {!soloPropietario && (
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
        )}

        {/* Pantalla de emergencia post-SOS (datos para el 911) */}
        {alerta && <SosModal alerta={alerta} onClose={cerrar} />}

        {/* Vecino vigilante — postulación / estado */}
        {profile?.house_id && !isAdmin && (
          <div className="mt-4 w-full rounded-3xl bg-white ring-1 ring-slate-200 p-4 shadow-sm">
            {vigEstado === "aprobado" ? (
              <div className="flex items-center gap-3">
                <span className="text-3xl">🛡️</span>
                <div>
                  <p className="font-bold text-slate-800">Eres vecino vigilante</p>
                  <p className="text-xs text-slate-500">
                    Recibirás las alertas SOS de la colonia por Telegram para acudir a apoyar.
                  </p>
                </div>
              </div>
            ) : vigEstado === "postulado" ? (
              <div className="flex items-center gap-3">
                <span className="text-3xl">🛡️</span>
                <div>
                  <p className="font-bold text-slate-800">Postulación en revisión</p>
                  <p className="text-xs text-slate-500">El comité revisará tu solicitud de vecino vigilante.</p>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3">
                  <span className="text-3xl">🛡️</span>
                  <div className="min-w-0">
                    <p className="font-bold text-slate-800">¿Quieres ser vecino vigilante?</p>
                    <p className="text-xs text-slate-500">
                      Los vigilantes reciben las alertas SOS de los vecinos y acuden a apoyar
                      mientras llega ayuda.
                    </p>
                  </div>
                </div>
                <button
                  onClick={postularme}
                  className="press mt-3 w-full rounded-xl bg-slate-800 text-white text-sm font-semibold py-2.5 hover:bg-slate-700"
                >
                  Postularme
                </button>
              </>
            )}
            {vigMsg && <p className="text-xs text-slate-600 mt-2">{vigMsg}</p>}
          </div>
        )}

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
                        className="press rounded-xl bg-brand-500 text-white text-sm font-semibold px-3 py-2 hover:bg-brand-600 disabled:opacity-40"
                      >
                        {resolviendo.has(u.id) ? "…" : "Aprobar"}
                      </button>
                      <button
                        onClick={() => resolver(u.id, "rechazado")}
                        disabled={resolviendo.has(u.id)}
                        className="press-soft rounded-xl border border-slate-200 text-slate-500 text-sm font-semibold px-3 py-2 hover:bg-slate-50 disabled:opacity-40"
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
