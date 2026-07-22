"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { callRpc } from "@/lib/rpc";
import { generarEnlaceReset, cambiarCorreoCuenta } from "./actions";

type Cuenta = {
  profile_id: string;
  nombre: string;
  email: string;
  telefono: string | null;
  role: string;
  aprobacion: string;
  activa: boolean;
  relacion: "vive" | "propietario";
  telegram: boolean;
  ultimo_acceso: string | null;
  creada: string;
};

type Invitacion = {
  token: string;
  relacion: string | null;
  usada: boolean;
  expires_at: string | null;
  vigente: boolean;
};

type Resultado = {
  house_id: string;
  casa: string;
  calle: string | null;
  cuentas: Cuenta[];
  invitaciones: Invitacion[];
};

type Bitacora = {
  id: string;
  actor_nombre: string | null;
  target_nombre: string | null;
  casa: string | null;
  accion: string;
  detalle: string | null;
  created_at: string;
};

const ACCION_LABEL: Record<string, string> = {
  enlace_password: "🔐 Enlace de contraseña",
  cambio_correo: "✉️ Correo corregido",
  reactivar_invitacion: "🎟️ Código reactivado",
  baja_cuenta: "🚫 Cuenta dada de baja",
  reactivar_cuenta: "↩️ Baja deshecha",
};

const fecha = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("es-MX", { day: "2-digit", month: "short", year: "numeric" })
    : "nunca";

const fechaHora = (iso: string) =>
  new Date(iso).toLocaleString("es-MX", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/** Arma el enlace de WhatsApp: al teléfono del vecino si lo tenemos, si no al selector. */
function ligaWhatsApp(telefono: string | null, texto: string): string {
  const digitos = (telefono ?? "").replace(/\D/g, "");
  const destino = digitos.length === 10 ? `52${digitos}` : digitos.length > 10 ? digitos : "";
  return `https://wa.me/${destino}?text=${encodeURIComponent(texto)}`;
}

export default function AyudaDeAcceso() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [texto, setTexto] = useState("");
  const [buscando, setBuscando] = useState(false);
  const [buscado, setBuscado] = useState(false);
  const [resultados, setResultados] = useState<Resultado[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Enlace de contraseña generado, por cuenta
  const [enlace, setEnlace] = useState<{ profileId: string; url: string; email: string } | null>(null);
  const [copiado, setCopiado] = useState(false);
  // Edición de correo, por cuenta
  const [editando, setEditando] = useState<string | null>(null);
  const [correoNuevo, setCorreoNuevo] = useState("");
  // Baja: confirmación en dos pasos
  const [confirmandoBaja, setConfirmandoBaja] = useState<string | null>(null);
  const [motivoBaja, setMotivoBaja] = useState("");
  // Código de invitación por casa
  const [codigos, setCodigos] = useState<Record<string, string>>({});

  const [bitacora, setBitacora] = useState<Bitacora[]>([]);

  const cargarBitacora = useCallback(async () => {
    const { data } = await supabaseBrowser
      .from("soporte_acceso_log")
      .select("id, actor_nombre, target_nombre, casa, accion, detalle, created_at")
      .order("created_at", { ascending: false })
      .limit(15);
    setBitacora((data as unknown as Bitacora[]) ?? []);
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
      await cargarBitacora();
      setReady(true);
    })();
  }, [router, cargarBitacora]);

  async function buscar() {
    if (buscando) return;
    setMsg(null);
    setEnlace(null);
    setEditando(null);
    setConfirmandoBaja(null);
    if (!texto.trim()) return setMsg("Escribe un número de casa, un nombre o un correo.");
    setBuscando(true);
    const res = await callRpc<{ ok: boolean; resultados: Resultado[] }>("soporte_buscar_cuentas", {
      p_texto: texto.trim(),
    });
    setBuscando(false);
    setBuscado(true);
    if (!res.ok) return setMsg(res.error);
    setResultados(res.data?.resultados ?? []);
  }

  async function accessToken(): Promise<string> {
    return (await supabaseBrowser.auth.getSession()).data.session?.access_token ?? "";
  }

  async function generarEnlace(c: Cuenta) {
    if (busyId) return;
    setMsg(null);
    setEnlace(null);
    setBusyId(c.profile_id);
    const res = await generarEnlaceReset(await accessToken(), c.profile_id);
    setBusyId(null);
    if (!res.ok) return setMsg(res.error);
    setEnlace({ profileId: c.profile_id, url: res.url, email: res.email });
    setCopiado(false);
    await cargarBitacora();
  }

  async function guardarCorreo(c: Cuenta) {
    if (busyId) return;
    setMsg(null);
    setBusyId(c.profile_id);
    const res = await cambiarCorreoCuenta(await accessToken(), c.profile_id, correoNuevo);
    setBusyId(null);
    if (!res.ok) return setMsg(res.error);
    setEditando(null);
    setCorreoNuevo("");
    setMsg(`Correo actualizado a ${res.email}. Ahora genera el enlace de contraseña.`);
    await Promise.all([buscar(), cargarBitacora()]);
  }

  async function darDeBaja(c: Cuenta) {
    if (busyId) return;
    setMsg(null);
    setBusyId(c.profile_id);
    const res = await callRpc("soporte_baja_cuenta", {
      p_profile_id: c.profile_id,
      p_motivo: motivoBaja.trim() || null,
    });
    setBusyId(null);
    if (!res.ok) return setMsg(res.error);
    setConfirmandoBaja(null);
    setMotivoBaja("");
    setMsg(`${c.nombre} ya no tiene acceso. Su historial quedó intacto.`);
    await Promise.all([buscar(), cargarBitacora()]);
  }

  async function reactivarCuenta(c: Cuenta) {
    if (busyId) return;
    setMsg(null);
    setBusyId(c.profile_id);
    const res = await callRpc("soporte_reactivar_cuenta", { p_profile_id: c.profile_id });
    setBusyId(null);
    if (!res.ok) return setMsg(res.error);
    setMsg(`${c.nombre} recuperó su acceso.`);
    await Promise.all([buscar(), cargarBitacora()]);
  }

  async function reactivarCodigo(r: Resultado) {
    if (busyId) return;
    setMsg(null);
    setBusyId(r.house_id);
    const res = await callRpc<{ ok: boolean; token: string; reactivada: boolean }>(
      "soporte_reactivar_invitacion",
      { p_house_id: r.house_id }
    );
    setBusyId(null);
    if (!res.ok) return setMsg(res.error);
    const token = res.data?.token ?? "";
    setCodigos((prev) => ({ ...prev, [r.house_id]: token }));
    await Promise.all([buscar(), cargarBitacora()]);
  }

  if (!ready)
    return <main className="flex-1 flex items-center justify-center text-slate-400">Cargando…</main>;

  return (
    <main className="flex-1 bg-gradient-to-b from-brand-50 via-white to-sky-50">
      <div className="w-full max-w-md mx-auto px-5 py-6 flex flex-col">
        <div className="flex items-center justify-between">
          <button
            onClick={() => router.push("/dashboard/comite")}
            className="text-sm text-slate-500 hover:text-slate-700"
          >
            ← Panel del comité
          </button>
          <Image src="/brand/vecinity-logo.svg" alt="Vecinity" width={120} height={34} priority />
        </div>

        <h1 className="text-2xl font-bold text-slate-800 mt-4">Ayuda de acceso</h1>
        <p className="text-sm text-slate-500 mt-1">
          Para el vecino que no recuerda su correo o su contraseña. Todo lo que hagas aquí
          queda registrado abajo.
        </p>

        {/* Buscador */}
        <section className="mt-5">
          <div className="bg-white rounded-2xl ring-1 ring-slate-100 p-3 flex gap-2">
            <input
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && buscar()}
              placeholder="Casa, nombre o correo"
              className="flex-1 rounded-xl ring-1 ring-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
            />
            <button
              onClick={buscar}
              disabled={buscando}
              className="rounded-xl bg-brand-500 text-white text-sm font-semibold px-4 py-2 hover:bg-brand-600 disabled:opacity-40"
            >
              {buscando ? "…" : "Buscar"}
            </button>
          </div>
        </section>

        {msg && (
          <p className="mt-3 text-sm text-slate-700 bg-amber-50 rounded-xl px-3 py-2 ring-1 ring-amber-200">
            {msg}
          </p>
        )}

        {buscado && resultados.length === 0 && (
          <p className="mt-4 text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
            No encontré ninguna casa ni cuenta con eso. Prueba con el número de casa.
          </p>
        )}

        {/* Resultados */}
        {resultados.map((r) => (
          <section key={r.house_id} className="mt-5">
            <h2 className="text-sm font-bold text-slate-700 mb-2">
              Casa {r.casa}
              {r.calle ? <span className="text-slate-400 font-medium"> · {r.calle}</span> : null}
            </h2>

            {r.cuentas.length === 0 ? (
              <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
                Esta casa no tiene ninguna cuenta todavía. Dale el código de invitación de abajo.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {r.cuentas.map((c) => (
                  <li key={c.profile_id} className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold text-slate-800 truncate">{c.nombre}</p>
                        <button
                          onClick={() => navigator.clipboard?.writeText(c.email)}
                          className="text-sm text-brand-700 font-medium break-all text-left hover:underline"
                          title="Toca para copiar el correo"
                        >
                          {c.email}
                        </button>
                        <p className="text-xs text-slate-500 mt-1">
                          {c.relacion === "propietario" ? "Dueño (no vive ahí)" : "Vive en la casa"}
                          {" · "}último acceso: {fecha(c.ultimo_acceso)}
                          {c.telegram ? " · Telegram ✓" : ""}
                        </p>
                      </div>
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${
                          !c.activa || c.aprobacion === "rechazado"
                            ? "bg-slate-100 text-slate-500"
                            : c.aprobacion === "pendiente"
                              ? "bg-amber-50 text-amber-700"
                              : "bg-emerald-50 text-emerald-700"
                        }`}
                      >
                        {!c.activa || c.aprobacion === "rechazado"
                          ? "de baja"
                          : c.aprobacion === "pendiente"
                            ? "por aprobar"
                            : "activa"}
                      </span>
                    </div>

                    {/* Acciones */}
                    {c.activa && c.aprobacion !== "rechazado" ? (
                      <div className="flex flex-wrap gap-2 mt-3">
                        <button
                          onClick={() => generarEnlace(c)}
                          disabled={busyId === c.profile_id}
                          className="rounded-xl bg-brand-500 text-white text-sm font-semibold px-3 py-2 hover:bg-brand-600 disabled:opacity-40"
                        >
                          {busyId === c.profile_id ? "…" : "🔐 Enlace de contraseña"}
                        </button>
                        <button
                          onClick={() => {
                            setEditando(editando === c.profile_id ? null : c.profile_id);
                            setCorreoNuevo("");
                            setConfirmandoBaja(null);
                          }}
                          className="rounded-xl border border-slate-200 text-slate-600 text-sm font-semibold px-3 py-2 hover:bg-slate-50"
                        >
                          ✉️ Corregir correo
                        </button>
                        <button
                          onClick={() => {
                            setConfirmandoBaja(
                              confirmandoBaja === c.profile_id ? null : c.profile_id
                            );
                            setMotivoBaja("");
                            setEditando(null);
                          }}
                          className="rounded-xl border border-slate-200 text-slate-500 text-sm font-semibold px-3 py-2 hover:bg-slate-50"
                        >
                          🚫 Dar de baja
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => reactivarCuenta(c)}
                        disabled={busyId === c.profile_id}
                        className="mt-3 rounded-xl border border-slate-200 text-slate-600 text-sm font-semibold px-3 py-2 hover:bg-slate-50 disabled:opacity-40"
                      >
                        {busyId === c.profile_id ? "…" : "↩️ Deshacer la baja"}
                      </button>
                    )}

                    {/* Enlace generado */}
                    {enlace?.profileId === c.profile_id && (
                      <div className="mt-3 rounded-xl bg-brand-50 ring-1 ring-brand-200 p-3">
                        <p className="text-xs text-slate-600">
                          Enlace de un solo uso para <b>{enlace.email}</b>. Mándaselo al vecino;
                          al abrirlo crea su contraseña nueva.
                        </p>
                        <p className="mt-2 text-[11px] text-slate-500 break-all bg-white rounded-lg p-2 ring-1 ring-slate-100">
                          {enlace.url}
                        </p>
                        <div className="flex gap-2 mt-2">
                          <button
                            onClick={async () => {
                              await navigator.clipboard?.writeText(enlace.url);
                              setCopiado(true);
                            }}
                            className="flex-1 rounded-xl bg-slate-800 text-white text-sm font-semibold py-2"
                          >
                            {copiado ? "¡Copiado!" : "Copiar enlace"}
                          </button>
                          <a
                            href={ligaWhatsApp(
                              c.telefono,
                              `Hola ${c.nombre}, soy del comité. Para entrar a Vecinity tu correo es ${enlace.email}. Abre este enlace para crear tu contraseña nueva (es de un solo uso): ${enlace.url}`
                            )}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex-1 rounded-xl bg-emerald-500 text-white text-sm font-semibold py-2 text-center"
                          >
                            WhatsApp
                          </a>
                        </div>
                        <p className="text-[11px] text-slate-400 mt-2">
                          Si el vecino tarda, genera uno nuevo: el enlace caduca.
                        </p>
                      </div>
                    )}

                    {/* Corregir correo */}
                    {editando === c.profile_id && (
                      <div className="mt-3 rounded-xl bg-slate-50 ring-1 ring-slate-200 p-3">
                        <p className="text-xs text-slate-600 mb-2">
                          Cambia el correo con el que entra a la app. Úsalo cuando lo escribió mal
                          o ya no tiene acceso a ese correo — así no se crea una cuenta nueva.
                        </p>
                        <input
                          value={correoNuevo}
                          onChange={(e) => setCorreoNuevo(e.target.value)}
                          placeholder="Correo nuevo"
                          inputMode="email"
                          type="email"
                          className="w-full rounded-xl ring-1 ring-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
                        />
                        <button
                          onClick={() => guardarCorreo(c)}
                          disabled={busyId === c.profile_id}
                          className="w-full mt-2 rounded-xl bg-brand-500 text-white text-sm font-semibold py-2 hover:bg-brand-600 disabled:opacity-40"
                        >
                          {busyId === c.profile_id ? "Guardando…" : "Guardar correo"}
                        </button>
                      </div>
                    )}

                    {/* Baja en dos pasos */}
                    {confirmandoBaja === c.profile_id && (
                      <div className="mt-3 rounded-xl bg-red-50 ring-1 ring-red-200 p-3">
                        <p className="text-xs text-slate-700">
                          <b>{c.nombre}</b> dejará de entrar a la app y soltará su Telegram.
                          <b> No se borra nada</b>: sus pagos, multas, visitas y credenciales
                          siguen en el historial de la casa, y puedes deshacerlo.
                        </p>
                        <input
                          value={motivoBaja}
                          onChange={(e) => setMotivoBaja(e.target.value)}
                          placeholder="Motivo (opcional): cuenta duplicada…"
                          className="w-full mt-2 rounded-xl ring-1 ring-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
                        />
                        <div className="flex gap-2 mt-2">
                          <button
                            onClick={() => darDeBaja(c)}
                            disabled={busyId === c.profile_id}
                            className="flex-1 rounded-xl bg-red-500 text-white text-sm font-semibold py-2 hover:bg-red-600 disabled:opacity-40"
                          >
                            {busyId === c.profile_id ? "…" : "Sí, dar de baja"}
                          </button>
                          <button
                            onClick={() => setConfirmandoBaja(null)}
                            className="flex-1 rounded-xl border border-slate-200 text-slate-600 text-sm font-semibold py-2 hover:bg-white"
                          >
                            Cancelar
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {/* Código de invitación de la casa */}
            <div className="mt-2 bg-white rounded-2xl ring-1 ring-slate-100 p-3">
              {r.invitaciones.filter((i) => i.vigente).length > 0 ? (
                <p className="text-xs text-slate-600">
                  Código vigente:{" "}
                  <b className="font-mono">
                    {r.invitaciones.filter((i) => i.vigente)[0].token}
                  </b>{" "}
                  · vence {fecha(r.invitaciones.filter((i) => i.vigente)[0].expires_at)}
                </p>
              ) : (
                <p className="text-xs text-slate-500">
                  Sin código vigente. Reactívalo solo si la cuenta no se puede recuperar: el
                  vecino se registrará de nuevo y quedará una cuenta vieja que conviene dar de baja.
                </p>
              )}
              <button
                onClick={() => reactivarCodigo(r)}
                disabled={busyId === r.house_id}
                className="w-full mt-2 rounded-xl border border-slate-200 text-slate-600 text-sm font-semibold py-2 hover:bg-slate-50 disabled:opacity-40"
              >
                {busyId === r.house_id ? "…" : "🎟️ Reactivar código de invitación"}
              </button>
              {codigos[r.house_id] && (
                <button
                  onClick={() => navigator.clipboard?.writeText(codigos[r.house_id])}
                  className="w-full mt-2 rounded-xl bg-slate-800 text-white font-mono text-lg py-2.5 tracking-wider active:scale-[0.99]"
                  title="Toca para copiar"
                >
                  {codigos[r.house_id]}
                </button>
              )}
            </div>
          </section>
        ))}

        {/* Bitácora */}
        <section className="mt-7 mb-4">
          <h2 className="text-sm font-bold text-slate-700 mb-2">Últimos movimientos</h2>
          {bitacora.length === 0 ? (
            <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
              Todavía no se ha usado esta pantalla.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {bitacora.map((b) => (
                <li key={b.id} className="bg-white rounded-2xl p-3 ring-1 ring-slate-100">
                  <p className="text-sm font-semibold text-slate-800">
                    {ACCION_LABEL[b.accion] ?? b.accion}
                    {b.casa ? <span className="text-slate-400"> · Casa {b.casa}</span> : null}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {b.target_nombre ? `${b.target_nombre} · ` : ""}
                    {fechaHora(b.created_at)} · por {b.actor_nombre ?? "—"}
                  </p>
                  {b.detalle && <p className="text-xs text-slate-400 mt-0.5">{b.detalle}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
