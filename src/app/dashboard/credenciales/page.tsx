"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { callRpc, runOrError } from "@/lib/rpc";
import { comprimirFoto } from "@/lib/draftGuardia";
import AccesoPeatonal from "../_components/AccesoPeatonal";

/**
 * Credenciales de acceso (tarjetas PVC impresas en la Zebra).
 * Vecino: solicita tarjetas (1 vehicular incluida por casa; adicionales con costo).
 * Comité: aprueba (genera cargo + trabajo de impresión), controla inventario y entrega.
 */

type Veh = { id: string; placa: string; brand: { nombre: string } | null };
type Miembro = { id: string; nombre: string };
type Solicitud = {
  id: string;
  tipo: "vehicular" | "peatonal" | "visita";
  estado: string;
  es_incluida: boolean;
  personalizada: boolean;
  costo: number | null;
  costo_estimado: number;
  pago_estado: "no_requerido" | "pendiente" | "en_revision" | "aprobado" | "rechazado";
  comprobante_url: string | null;
  pago_motivo_rechazo: string | null;
  motivo_rechazo: string | null;
  created_at: string;
  print_job_id: string | null;
  vehicle: { placa: string } | null;
  beneficiario: { nombre: string } | null;
  beneficiario_nombre: string | null;
  house?: { numero: string } | null;
};
type Job = {
  id: string;
  tipo: string;
  estado: string;
  error: string | null;
  created_at: string;
  payload: { placa?: string; nombre?: string; casa?: string };
};
type Colonia = {
  stock_tarjetas: number;
  precio_tarjeta_adicional: number;
  precio_personalizacion: number;
};

const ESTADO: Record<string, { label: string; cls: string }> = {
  solicitada: { label: "En revisión", cls: "bg-amber-50 text-amber-700" },
  en_cola: { label: "En impresión", cls: "bg-sky-50 text-sky-700" },
  impresa: { label: "Lista para recoger", cls: "bg-emerald-50 text-emerald-700" },
  entregada: { label: "Entregada", cls: "bg-slate-100 text-slate-500" },
  rechazada: { label: "Rechazada", cls: "bg-red-50 text-red-600" },
  cancelada: { label: "Cancelada", cls: "bg-slate-100 text-slate-400" },
};

const SOL_COLS = `id, tipo, estado, es_incluida, personalizada, costo, costo_estimado,
  pago_estado, comprobante_url, pago_motivo_rechazo, motivo_rechazo, created_at,
  print_job_id, beneficiario_nombre,
  vehicle:vehicles(placa),
  beneficiario:profiles!card_requests_beneficiario_profile_id_fkey(nombre)`;

const TIPO_EMOJI: Record<string, string> = { vehicular: "🚗", peatonal: "🚶", visita: "🧑‍🤝‍🧑" };
const titular = (s: Solicitud) =>
  s.tipo === "vehicular"
    ? s.vehicle?.placa ?? "Vehículo"
    : s.tipo === "peatonal"
      ? s.beneficiario?.nombre ?? "Residente"
      : s.beneficiario_nombre ?? "Visita";

const mxn = (n: number | null | undefined) =>
  `$${Number(n ?? 0).toLocaleString("es-MX", { minimumFractionDigits: 0 })}`;

const PAGO: Record<string, { label: string; cls: string }> = {
  pendiente: { label: "Pago pendiente", cls: "bg-amber-50 text-amber-700" },
  en_revision: { label: "Comprobante en revisión", cls: "bg-sky-50 text-sky-700" },
  aprobado: { label: "Pagada", cls: "bg-emerald-50 text-emerald-700" },
  rechazado: { label: "Pago rechazado", cls: "bg-red-50 text-red-600" },
};

const BUCKET_COMPROBANTES = "vecino-comprobantes";

export default function CredencialesPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [houseId, setHouseId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  // Vecino
  const [precio, setPrecio] = useState(0);
  const [incluidaLibre, setIncluidaLibre] = useState(false);
  const [vehiculos, setVehiculos] = useState<Veh[]>([]);
  const [miembros, setMiembros] = useState<Miembro[]>([]);
  const [vehId, setVehId] = useState("");
  const [benefId, setBenefId] = useState("");
  const [visitaNombre, setVisitaNombre] = useState("");
  const [mias, setMias] = useState<Solicitud[]>([]);

  // Comité
  const [colonia, setColonia] = useState<Colonia | null>(null);
  const [coloniaId, setColoniaId] = useState<string | null>(null);
  const [pendientes, setPendientes] = useState<Solicitud[]>([]);
  const [porEntregar, setPorEntregar] = useState<Solicitud[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);

  const conBusy = (id: string, on: boolean) =>
    setBusy((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const cargarVecino = useCallback(async (hid: string) => {
    const [cot, vehs, membs, sols] = await Promise.all([
      callRpc<{
        precio_adicional: number;
        precio_personalizacion: number;
        incluida_disponible: boolean;
      }>("cotizar_tarjeta", { p_tipo: "vehicular" }),
      supabaseBrowser
        .from("vehicles")
        .select("id, placa, brand:vehicle_brands(nombre)")
        .eq("house_id", hid)
        .eq("estado", "aprobado")
        .order("placa"),
      supabaseBrowser
        .from("profiles")
        .select("id, nombre")
        .eq("house_id", hid)
        .eq("approval_status", "aprobado")
        .eq("is_active", true)
        .order("nombre"),
      supabaseBrowser
        .from("card_requests")
        .select(SOL_COLS)
        .eq("house_id", hid)
        .order("created_at", { ascending: false }),
    ]);
    if (cot.ok) {
      setPrecio(Number(cot.data.precio_adicional ?? 0));
      setIncluidaLibre(!!cot.data.incluida_disponible);
    }
    setVehiculos((vehs.data as unknown as Veh[]) ?? []);
    setMiembros((membs.data as unknown as Miembro[]) ?? []);
    setMias((sols.data as unknown as Solicitud[]) ?? []);
  }, []);

  const cargarComite = useCallback(async (cid: string) => {
    const [col, pend, entr, jbs] = await Promise.all([
      supabaseBrowser
        .from("colonias")
        .select("stock_tarjetas, precio_tarjeta_adicional, precio_personalizacion")
        .eq("id", cid)
        .maybeSingle(),
      supabaseBrowser
        .from("card_requests")
        .select(`${SOL_COLS}, house:houses(numero)`)
        .eq("estado", "solicitada")
        .order("created_at"),
      supabaseBrowser
        .from("card_requests")
        .select(`${SOL_COLS}, house:houses(numero)`)
        .eq("estado", "impresa")
        .order("created_at"),
      supabaseBrowser
        .from("print_jobs")
        .select("id, tipo, estado, error, created_at, payload")
        .in("estado", ["pendiente", "imprimiendo", "error"])
        .order("created_at"),
    ]);
    setColonia((col.data as unknown as Colonia) ?? null);
    setPendientes((pend.data as unknown as Solicitud[]) ?? []);
    setPorEntregar((entr.data as unknown as Solicitud[]) ?? []);
    setJobs((jbs.data as unknown as Job[]) ?? []);
  }, []);

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabaseBrowser.auth.getUser();
      if (!user) return router.replace("/login");
      const { data: prof } = await supabaseBrowser
        .from("profiles")
        .select("house_id, colonia_id, role, approval_status")
        .eq("id", user.id)
        .maybeSingle();
      const p = prof as unknown as {
        house_id: string | null;
        colonia_id: string;
        role: string;
        approval_status: string;
      } | null;
      if (!p || p.approval_status !== "aprobado") return router.replace("/esperando");
      setHouseId(p.house_id);
      setColoniaId(p.colonia_id);
      const admin = p.role === "admin" || p.role === "comite";
      setIsAdmin(admin);
      if (p.house_id) await cargarVecino(p.house_id);
      if (admin) await cargarComite(p.colonia_id);
      setReady(true);
    })();
  }, [router, cargarVecino, cargarComite]);

  const recargar = useCallback(async () => {
    if (houseId) await cargarVecino(houseId);
    if (isAdmin && coloniaId) await cargarComite(coloniaId);
  }, [houseId, isAdmin, coloniaId, cargarVecino, cargarComite]);

  // Vehículos que aún no tienen tarjeta viva
  const vehSinTarjeta = vehiculos.filter(
    (v) => !mias.some((s) => s.tipo === "vehicular" && s.vehicle?.placa === v.placa && !["rechazada", "cancelada"].includes(s.estado))
  );
  const miembrosSinTarjeta = miembros.filter(
    (m) => !mias.some((s) => s.tipo === "peatonal" && s.beneficiario?.nombre === m.nombre && !["rechazada", "cancelada"].includes(s.estado))
  );

  async function solicitar(tipo: "vehicular" | "peatonal" | "visita") {
    setMsg(null);
    const costo = tipo === "vehicular" && incluidaLibre ? 0 : precio;
    if (tipo === "vehicular" && !vehId) return setMsg("Elige el vehículo.");
    if (tipo === "peatonal" && !benefId) return setMsg("Elige para quién es.");
    if (tipo === "visita" && !visitaNombre.trim()) return setMsg("Escribe el nombre de la visita.");
    const texto =
      costo > 0
        ? `Esta tarjeta cuesta ${mxn(costo)}. El pago es por transferencia: después de solicitarla, sube aquí tu comprobante para que el comité la apruebe. ¿Continuar?`
        : "Esta tarjeta está incluida para tu casa (sin costo). ¿Solicitar?";
    if (!confirm(texto)) return;
    conBusy("solicitar", true);
    const res = await callRpc("solicitar_tarjeta", {
      p_tipo: tipo,
      p_vehicle_id: tipo === "vehicular" ? vehId : null,
      p_beneficiario: tipo === "peatonal" ? benefId : null,
      p_beneficiario_nombre: tipo === "visita" ? visitaNombre.trim() : null,
      p_personalizada: tipo === "vehicular",
    });
    conBusy("solicitar", false);
    if (!res.ok) return setMsg(res.error);
    setVehId("");
    setBenefId("");
    setVisitaNombre("");
    await recargar();
  }

  async function subirComprobante(s: Solicitud, file: File | null) {
    if (!file || busy.has(s.id) || !houseId) return;
    setMsg(null);
    conBusy(s.id, true);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
      const path = `tarjetas/${houseId}/${s.id}-${Date.now()}.${ext}`;
      const up = await supabaseBrowser.storage.from(BUCKET_COMPROBANTES).upload(path, file);
      if (up.error) return setMsg("No se pudo subir el comprobante. Inténtalo de nuevo.");
      const url = supabaseBrowser.storage.from(BUCKET_COMPROBANTES).getPublicUrl(path).data.publicUrl;
      const res = await callRpc("subir_comprobante_tarjeta", { p_id: s.id, p_url: url });
      if (!res.ok) return setMsg(res.error);
      await recargar();
    } finally {
      conBusy(s.id, false);
    }
  }

  async function validarPago(s: Solicitud, aprobar: boolean) {
    if (busy.has(s.id)) return;
    setMsg(null);
    let nota: string | null = null;
    if (!aprobar) {
      nota = prompt("Motivo del rechazo del pago (lo verá el vecino):");
      if (!nota?.trim()) return;
    } else if (!confirm(`¿Confirmar que el pago de ${mxn(s.costo_estimado)} ya está en la cuenta?`)) {
      return;
    }
    conBusy(s.id, true);
    const res = await callRpc("validar_pago_tarjeta", {
      p_id: s.id,
      p_aprobar: aprobar,
      p_nota: nota,
    });
    conBusy(s.id, false);
    if (!res.ok) return setMsg(res.error);
    await recargar();
  }

  async function cancelar(id: string) {
    if (busy.has(id)) return;
    conBusy(id, true);
    const res = await callRpc("cancelar_solicitud_tarjeta", { p_id: id });
    conBusy(id, false);
    if (!res.ok) return setMsg(res.error);
    await recargar();
  }

  async function resolver(s: Solicitud, accion: "aprobar" | "rechazar") {
    if (busy.has(s.id)) return;
    setMsg(null);
    if (accion === "aprobar") {
      const costoTxt = s.costo_estimado > 0 ? `Se cobrarán ${mxn(s.costo_estimado)} a la casa.` : "Sin costo (tarjeta incluida).";
      if (!confirm(`¿Aprobar y mandar a impresión? ${costoTxt}`)) return;
    }
    conBusy(s.id, true);
    const res = await callRpc("resolver_solicitud_tarjeta", { p_id: s.id, p_accion: accion });
    conBusy(s.id, false);
    if (!res.ok) return setMsg(res.error);
    await recargar();
  }

  // Entrega con firma: el vecino firma de recibido en este teléfono (la fecha
  // la sella el servidor). Sustituye al "marcar entregada" sin evidencia.
  const [entregaSol, setEntregaSol] = useState<Solicitud | null>(null);
  const [entregasAbierto, setEntregasAbierto] = useState(false); // sección abatible

  async function reintentar(id: string) {
    if (busy.has(id)) return;
    conBusy(id, true);
    const res = await callRpc("print_retry_job", { p_id: id });
    conBusy(id, false);
    if (!res.ok) return setMsg(res.error);
    await recargar();
  }

  async function guardarConfig(
    campo: "precio_tarjeta_adicional" | "stock_tarjetas" | "precio_personalizacion",
    valor: number
  ) {
    if (!coloniaId || Number.isNaN(valor) || valor < 0) return;
    const res = await runOrError(() =>
      supabaseBrowser.from("colonias").update({ [campo]: valor }).eq("id", coloniaId)
    );
    if (!res.ok) return setMsg(res.error);
    await recargar();
  }

  if (!ready)
    return <main className="flex-1 flex items-center justify-center text-slate-400">Cargando…</main>;

  const solVivas = mias.filter((s) => !["cancelada", "rechazada"].includes(s.estado));
  const solCerradas = mias.filter((s) => ["cancelada", "rechazada"].includes(s.estado));

  return (
    <main className="flex-1 bg-gradient-to-b from-brand-50 via-white to-sky-50">
      <div className="w-full max-w-md mx-auto px-5 py-6 flex flex-col">
        <div className="flex items-center justify-between">
          <button onClick={() => router.push("/dashboard")} className="text-sm text-slate-500 hover:text-slate-700">
            ← Volver
          </button>
          <Image src="/brand/vecinity-logo.svg" alt="Vecinity" width={120} height={34} priority />
        </div>

        <h1 className="text-2xl font-bold text-slate-800 mt-4">Credenciales de acceso</h1>
        <p className="text-sm text-slate-500">
          Tu casa tiene <b>1 tarjeta vehicular incluida</b>.{" "}
          {precio > 0 ? (
            <>
              Las adicionales cuestan <b>{mxn(precio)}</b> (personalizada incluida), pagadas por
              transferencia — subes tu comprobante aquí mismo, no se carga a tu saldo de
              mantenimiento.
            </>
          ) : (
            <>El comité aún no define el precio de las adicionales.</>
          )}
        </p>

        {msg && (
          <p className="mt-3 text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2 ring-1 ring-red-200">{msg}</p>
        )}

        {/* Solicitar */}
        {houseId && (
          <section className="mt-5 bg-white rounded-2xl ring-1 ring-slate-100 p-4 flex flex-col gap-4">
            <div>
              <p className="text-sm font-bold text-slate-700">
                🚗 Tarjeta vehicular{" "}
                <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${incluidaLibre ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                  {incluidaLibre ? "incluida disponible" : `adicional · ${mxn(precio)}`}
                </span>
              </p>
              <div className="flex gap-2 mt-2">
                <select
                  value={vehId}
                  onChange={(e) => setVehId(e.target.value)}
                  className="flex-1 rounded-xl ring-1 ring-slate-200 px-2 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300 bg-white"
                >
                  <option value="">— Elige el vehículo —</option>
                  {vehSinTarjeta.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.placa}
                      {v.brand?.nombre ? ` · ${v.brand.nombre}` : ""}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => solicitar("vehicular")}
                  disabled={busy.has("solicitar") || !vehId}
                  className="rounded-xl bg-brand-500 text-white text-sm font-semibold px-3 py-2 hover:bg-brand-600 disabled:opacity-40"
                >
                  Solicitar
                </button>
              </div>
              {vehSinTarjeta.length === 0 && (
                <p className="text-xs text-slate-400 mt-1">Todos tus vehículos aprobados ya tienen tarjeta o solicitud.</p>
              )}
              {vehSinTarjeta.length > 0 && (
                <p className="text-xs text-slate-500 mt-2">
                  🎨 Todas las tarjetas vehiculares vienen <b>personalizadas</b>: diseño de la villa
                  al frente y los datos de tu vehículo (marca, modelo, placas y casa) al reverso.
                </p>
              )}
            </div>

            {/* Peatonal: sin tarjeta — la puerta abre con reconocimiento de rostro.
                El registro completo vive en la sección "Acceso peatonal" de abajo. */}
            <div className="border-t border-slate-100 pt-3">
              <p className="text-sm font-bold text-slate-700">
                🚶 Acceso peatonal{" "}
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
                  incluido · sin tarjeta
                </span>
              </p>
              <p className="text-xs text-slate-400 mt-1">
                La puerta peatonal abre con <b>reconocimiento de rostro</b>. Registra a las
                personas de tu casa en la sección de abajo ↓
              </p>
            </div>

            <div className="border-t border-slate-100 pt-3">
              <p className="text-sm font-bold text-slate-700">
                🧑‍🤝‍🧑 Tarjeta para visita frecuente{" "}
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">
                  adicional · {mxn(precio)}
                </span>
              </p>
              <p className="text-xs text-slate-400 mt-0.5">
                Para familiares que vienen seguido (hijos, cuidadores). Va a nombre de la persona.
              </p>
              <div className="flex gap-2 mt-2">
                <input
                  value={visitaNombre}
                  onChange={(e) => setVisitaNombre(e.target.value)}
                  placeholder="Nombre completo de la visita"
                  className="flex-1 rounded-xl ring-1 ring-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
                />
                <button
                  onClick={() => solicitar("visita")}
                  disabled={busy.has("solicitar") || !visitaNombre.trim()}
                  className="rounded-xl bg-brand-500 text-white text-sm font-semibold px-3 py-2 hover:bg-brand-600 disabled:opacity-40"
                >
                  Solicitar
                </button>
              </div>
            </div>
          </section>
        )}

        {houseId && <AccesoPeatonal houseId={houseId} />}

        {/* Mis solicitudes */}
        <section className="mt-7">
          <h2 className="text-sm font-bold text-slate-700 mb-2">
            Tarjetas de mi casa <span className="text-slate-400 font-medium">({solVivas.length})</span>
          </h2>
          {solVivas.length === 0 ? (
            <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
              Aún no hay tarjetas solicitadas.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {solVivas.map((s) => (
                <li key={s.id} className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-800 truncate">
                        {TIPO_EMOJI[s.tipo]} {titular(s)}
                        {s.personalizada && <span className="ml-1">🎨</span>}
                      </p>
                      <p className="text-xs text-slate-500">
                        {Number(s.costo ?? s.costo_estimado) === 0
                          ? "Incluida (sin costo)"
                          : `Adicional · ${mxn(s.costo ?? s.costo_estimado)}`}
                      </p>
                      <span className={`inline-block mt-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${ESTADO[s.estado]?.cls ?? "bg-slate-100 text-slate-500"}`}>
                        {ESTADO[s.estado]?.label ?? s.estado}
                      </span>
                      {s.pago_estado !== "no_requerido" && (
                        <span className={`inline-block mt-1 ml-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${PAGO[s.pago_estado]?.cls ?? "bg-slate-100 text-slate-500"}`}>
                          {PAGO[s.pago_estado]?.label ?? s.pago_estado}
                        </span>
                      )}
                    </div>
                    {s.estado === "solicitada" && (
                      <button
                        onClick={() => cancelar(s.id)}
                        disabled={busy.has(s.id)}
                        className="rounded-xl border border-slate-200 text-slate-500 text-xs font-semibold px-3 py-2 hover:bg-slate-50 shrink-0 disabled:opacity-40"
                      >
                        Cancelar
                      </button>
                    )}
                  </div>
                  {s.estado === "solicitada" &&
                    (s.pago_estado === "pendiente" || s.pago_estado === "rechazado") && (
                      <div className="mt-2 border-t border-slate-100 pt-2">
                        {s.pago_estado === "rechazado" && s.pago_motivo_rechazo && (
                          <p className="text-xs text-red-600 mb-1.5">
                            El comité rechazó tu comprobante: “{s.pago_motivo_rechazo}”. Sube uno nuevo.
                          </p>
                        )}
                        <p className="text-xs text-slate-500 mb-1.5">
                          Transfiere {mxn(s.costo_estimado)} a la cuenta de la colonia (la misma del
                          mantenimiento) y sube tu comprobante:
                        </p>
                        <label className="inline-block rounded-xl bg-brand-500 text-white text-xs font-semibold px-3 py-2 hover:bg-brand-600 cursor-pointer">
                          {busy.has(s.id) ? "Subiendo…" : "📎 Subir comprobante"}
                          <input
                            type="file"
                            accept="image/*,.pdf"
                            className="hidden"
                            disabled={busy.has(s.id)}
                            onChange={(e) => subirComprobante(s, e.target.files?.[0] ?? null)}
                          />
                        </label>
                      </div>
                    )}
                </li>
              ))}
            </ul>
          )}
          {solCerradas.length > 0 && (
            <details className="mt-2">
              <summary className="text-xs text-slate-400 cursor-pointer">Historial ({solCerradas.length})</summary>
              <ul className="flex flex-col gap-1 mt-2">
                {solCerradas.map((s) => (
                  <li key={s.id} className="text-xs text-slate-500 bg-white rounded-xl px-3 py-2 ring-1 ring-slate-100">
                    {titular(s)} — {ESTADO[s.estado]?.label ?? s.estado}
                    {s.motivo_rechazo ? ` · ${s.motivo_rechazo}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>

        {/* ═══ Comité ═══ */}
        {isAdmin && colonia && (
          <>
            <section className="mt-8 bg-white rounded-2xl ring-1 ring-slate-100 p-4">
              <h2 className="text-sm font-bold text-slate-700">Inventario y precio</h2>
              <div className="grid grid-cols-2 gap-3 mt-2">
                <label className="text-xs text-slate-500">
                  Tarjetas físicas en stock
                  <input
                    type="number"
                    min={0}
                    defaultValue={colonia.stock_tarjetas}
                    onBlur={(e) => {
                      const v = parseInt(e.target.value, 10);
                      if (v !== colonia.stock_tarjetas) guardarConfig("stock_tarjetas", v);
                    }}
                    className="mt-1 w-full rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
                  />
                </label>
                <label className="text-xs text-slate-500">
                  Precio tarjeta adicional ($)
                  <input
                    type="number"
                    min={0}
                    defaultValue={colonia.precio_tarjeta_adicional}
                    onBlur={(e) => {
                      const v = parseFloat(e.target.value);
                      if (v !== colonia.precio_tarjeta_adicional) guardarConfig("precio_tarjeta_adicional", v);
                    }}
                    className="mt-1 w-full rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
                  />
                </label>
              </div>
              <p className="text-xs text-slate-400 mt-2">
                El precio incluye la personalización (diseño de la villa + datos del vehículo).
              </p>
              {colonia.precio_tarjeta_adicional === 0 && (
                <p className="text-xs text-amber-600 bg-amber-50 rounded-xl px-3 py-2 ring-1 ring-amber-200 mt-2">
                  ⚠️ Precio en $0: las tarjetas adicionales se aprobarán sin cargo hasta que definas el precio.
                </p>
              )}
            </section>

            <section className="mt-6">
              <h2 className="text-sm font-bold text-slate-700 mb-2">
                Solicitudes por aprobar <span className="text-slate-400 font-medium">({pendientes.length})</span>
              </h2>
              {pendientes.length === 0 ? (
                <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
                  No hay solicitudes pendientes 🎉
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {pendientes.map((s) => {
                    const pagoListo = s.pago_estado === "no_requerido" || s.pago_estado === "aprobado";
                    return (
                      <li key={s.id} className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100">
                        <p className="font-semibold text-slate-800">
                          {TIPO_EMOJI[s.tipo]} {titular(s)} · Casa {s.house?.numero}
                          {s.personalizada && <span className="ml-1">🎨</span>}
                          {s.tipo === "visita" && <span className="ml-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-600">visita frecuente</span>}
                        </p>
                        <p className="text-xs text-slate-500 mt-0.5">
                          {s.costo_estimado > 0
                            ? `Adicional — ${mxn(s.costo_estimado)}`
                            : "Incluida — sin costo"}
                          {s.personalizada ? " · personalizada" : ""}
                        </p>
                        {s.pago_estado !== "no_requerido" && (
                          <p className="mt-1">
                            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${PAGO[s.pago_estado]?.cls}`}>
                              {PAGO[s.pago_estado]?.label}
                            </span>
                            {s.comprobante_url && (
                              <a
                                href={s.comprobante_url}
                                target="_blank"
                                rel="noreferrer"
                                className="ml-2 text-xs font-semibold text-brand-600 underline underline-offset-2"
                              >
                                Ver comprobante
                              </a>
                            )}
                          </p>
                        )}
                        {s.pago_estado === "en_revision" ? (
                          <div className="flex gap-2 mt-2.5">
                            <button
                              onClick={() => validarPago(s, true)}
                              disabled={busy.has(s.id)}
                              className="flex-1 rounded-xl bg-emerald-600 text-white text-sm font-semibold px-3 py-2 hover:bg-emerald-700 disabled:opacity-40"
                            >
                              {busy.has(s.id) ? "…" : "Pago recibido ✓"}
                            </button>
                            <button
                              onClick={() => validarPago(s, false)}
                              disabled={busy.has(s.id)}
                              className="rounded-xl border border-slate-200 text-slate-500 text-sm font-semibold px-3 py-2 hover:bg-slate-50 disabled:opacity-40"
                            >
                              Rechazar pago
                            </button>
                          </div>
                        ) : (
                          <div className="flex gap-2 mt-2.5">
                            <button
                              onClick={() => resolver(s, "aprobar")}
                              disabled={busy.has(s.id) || !pagoListo}
                              title={pagoListo ? "" : "Falta que el vecino pague y el comité valide el comprobante"}
                              className="flex-1 rounded-xl bg-brand-500 text-white text-sm font-semibold px-3 py-2 hover:bg-brand-600 disabled:opacity-40"
                            >
                              {busy.has(s.id) ? "…" : pagoListo ? "Aprobar e imprimir" : "Esperando pago del vecino"}
                            </button>
                            <button
                              onClick={() => resolver(s, "rechazar")}
                              disabled={busy.has(s.id)}
                              className="rounded-xl border border-slate-200 text-slate-500 text-sm font-semibold px-3 py-2 hover:bg-slate-50 disabled:opacity-40"
                            >
                              Rechazar
                            </button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {jobs.length > 0 && (
              <section className="mt-6">
                <h2 className="text-sm font-bold text-slate-700 mb-2">
                  Cola de impresión <span className="text-slate-400 font-medium">({jobs.length})</span>
                </h2>
                <ul className="flex flex-col gap-2">
                  {jobs.map((j) => (
                    <li key={j.id} className="bg-white rounded-2xl p-3 ring-1 ring-slate-100 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-800 truncate">
                          {j.tipo === "vehicular" ? `🚗 ${j.payload?.placa ?? ""}` : `🚶 ${j.payload?.nombre ?? ""}`}
                          {j.payload?.casa ? ` · Casa ${j.payload.casa}` : ""}
                        </p>
                        <p className={`text-xs ${j.estado === "error" ? "text-red-600" : "text-slate-500"}`}>
                          {j.estado}
                          {j.error ? ` — ${j.error}` : ""}
                        </p>
                      </div>
                      {j.estado === "error" && (
                        <button
                          onClick={() => reintentar(j.id)}
                          disabled={busy.has(j.id)}
                          className="rounded-xl border border-slate-200 text-slate-600 text-xs font-semibold px-3 py-2 hover:bg-slate-50 shrink-0 disabled:opacity-40"
                        >
                          Reintentar
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="text-[11px] text-slate-400 mt-1.5">
                  Las tarjetas se imprimen en la Mac del comité (debe estar encendida con el puente activo).
                </p>
              </section>
            )}

            {porEntregar.length > 0 && (
              <section className="mt-6">
                <button
                  onClick={() => setEntregasAbierto((v) => !v)}
                  className="w-full flex items-center justify-between mb-2"
                >
                  <h2 className="text-sm font-bold text-slate-700">
                    Impresas, por entregar <span className="text-slate-400 font-medium">({porEntregar.length})</span>
                  </h2>
                  <span className="text-slate-400 text-lg leading-none">{entregasAbierto ? "▾" : "▸"}</span>
                </button>
                {entregasAbierto && (
                <ul className="flex flex-col gap-2">
                  {porEntregar.map((s) => (
                    <li key={s.id} className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100 flex items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-slate-800 truncate">
                        {TIPO_EMOJI[s.tipo]} {titular(s)}
                        {" · Casa "}
                        {s.house?.numero}
                      </p>
                      <button
                        onClick={() => setEntregaSol(s)}
                        disabled={busy.has(s.id) || !s.print_job_id}
                        className="rounded-xl bg-emerald-600 text-white text-xs font-semibold px-3 py-2 hover:bg-emerald-700 shrink-0 disabled:opacity-40"
                      >
                        Entregar con firma ✍︎
                      </button>
                    </li>
                  ))}
                </ul>
                )}
              </section>
            )}
          </>
        )}

        {entregaSol && (
          <FirmaEntrega
            sol={entregaSol}
            onClose={() => setEntregaSol(null)}
            onDone={async () => {
              setEntregaSol(null);
              await recargar();
            }}
          />
        )}
      </div>
    </main>
  );
}

/** Modal de entrega: el vecino firma de recibido con el dedo. La fecha queda
 *  sellada por el servidor (entregar_tarjeta_firmada). */
function FirmaEntrega({
  sol,
  onClose,
  onDone,
}: {
  sol: Solicitud;
  onClose: () => void;
  onDone: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const trazando = useRef(false);
  const [firmante, setFirmante] = useState(titular(sol));
  const [hayFirma, setHayFirma] = useState(false);
  const [ineFile, setIneFile] = useState<File | null>(null);
  const [serial, setSerial] = useState("");
  const [serialSistema, setSerialSistema] = useState(false); // ya asignado al imprimir
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Si el sistema asignó serial al imprimir, se muestra fijo; si la tarjeta es
  // histórica (sin serial), el comité captura el número impreso en la tarjeta.
  useEffect(() => {
    (async () => {
      if (!sol.print_job_id) return;
      const { data } = await supabaseBrowser
        .from("card_inventory")
        .select("serial")
        .eq("print_job_id", sol.print_job_id)
        .maybeSingle();
      const s = (data as unknown as { serial: string } | null)?.serial;
      if (s) {
        setSerial(s);
        setSerialSistema(true);
      }
    })();
  }, [sol.print_job_id]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.width = c.offsetWidth * 2; // 2x para nitidez en pantallas retina
    c.height = 320;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }, []);

  const punto = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * c.width,
      y: ((e.clientY - r.top) / r.height) * c.height,
    };
  };

  const empezar = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    trazando.current = true;
    const p = punto(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  };
  const mover = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!trazando.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const p = punto(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    setHayFirma(true);
  };
  const terminar = () => {
    trazando.current = false;
  };

  const limpiar = () => {
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    setHayFirma(false);
  };

  const guardar = async () => {
    if (!sol.print_job_id) return setError("Esta tarjeta no tiene trabajo de impresión ligado.");
    if (!firmante.trim()) return setError("Escribe el nombre de quien recibe.");
    if (!ineFile) return setError("Falta la foto del INE de quien recibe.");
    if (!hayFirma) return setError("Falta la firma del vecino.");
    setGuardando(true);
    setError(null);

    // INE → bucket PRIVADO (identificación oficial: nunca URL pública).
    // Si la foto no sube, NO se registra la entrega sin evidencia.
    const foto = await comprimirFoto(ineFile);
    const inePath = `${sol.id}/${crypto.randomUUID()}.jpg`;
    const up = await supabaseBrowser.storage.from("vecino-ine").upload(inePath, foto);
    if (up.error) {
      setGuardando(false);
      return setError("No se pudo subir la foto del INE. Revisa la conexión e inténtalo de nuevo.");
    }

    const firma = canvasRef.current!.toDataURL("image/png");
    const res = await callRpc<{ delivered_at: string }>("entregar_tarjeta_firmada", {
      p_job: sol.print_job_id,
      p_firmante: firmante.trim(),
      p_firma_b64: firma,
      p_ine_path: inePath,
      p_serial: serial.trim() || null,
    });
    setGuardando(false);
    if (!res.ok) return setError(res.error);
    onDone();
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-end sm:items-center justify-center p-3">
      <div className="bg-white rounded-2xl w-full max-w-md p-4 shadow-xl">
        <h3 className="text-sm font-bold text-slate-800">
          Entrega de tarjeta — {TIPO_EMOJI[sol.tipo]} {titular(sol)}
          {sol.house?.numero ? ` · Casa ${sol.house.numero}` : ""}
        </h3>
        <label className="block text-xs font-semibold text-slate-500 mt-3 mb-1">
          Recibe (nombre completo)
        </label>
        <input
          value={firmante}
          onChange={(e) => setFirmante(e.target.value)}
          className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
        />
        {sol.tipo === "vehicular" && (
          <>
            <label className="block text-xs font-semibold text-slate-500 mt-3 mb-1">
              N° de tarjeta (serial RFID impreso en la tarjeta)
              {serialSistema && <span className="text-emerald-600 font-bold"> ✓ asignado al imprimir</span>}
            </label>
            <input
              value={serial}
              onChange={(e) => setSerial(e.target.value)}
              readOnly={serialSistema}
              inputMode="numeric"
              placeholder="ej. 14840505"
              className={`w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-mono ${serialSistema ? "bg-slate-50 text-slate-500" : ""}`}
            />
            <p className="text-[11px] text-slate-400 mt-1">
              Con este número la tarjeta queda ligada al acceso de la puerta (caseta).
            </p>
          </>
        )}
        <label className="block text-xs font-semibold text-slate-500 mt-3 mb-1">
          Foto del INE de quien recibe {ineFile && <span className="text-emerald-600 font-bold">✓ lista</span>}
        </label>
        <input
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(e) => setIneFile(e.target.files?.[0] ?? null)}
          className="w-full text-sm text-slate-600 file:mr-2 file:rounded-lg file:border-0 file:bg-emerald-50 file:text-emerald-700 file:px-3 file:py-2 file:font-semibold"
        />
        <p className="text-[11px] text-slate-400 mt-1">
          Registro oficial del responsable de la casa — se guarda en almacenamiento privado.
        </p>
        <label className="block text-xs font-semibold text-slate-500 mt-3 mb-1">
          Firma del vecino (con el dedo)
        </label>
        <canvas
          ref={canvasRef}
          onPointerDown={empezar}
          onPointerMove={mover}
          onPointerUp={terminar}
          onPointerCancel={terminar}
          className="w-full h-40 rounded-xl border border-slate-300 bg-white"
          style={{ touchAction: "none" }}
        />
        {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
        <div className="flex gap-2 mt-3">
          <button
            onClick={limpiar}
            className="rounded-xl border border-slate-200 text-slate-600 text-xs font-semibold px-3 py-2 hover:bg-slate-50"
          >
            Limpiar
          </button>
          <button
            onClick={onClose}
            className="rounded-xl border border-slate-200 text-slate-600 text-xs font-semibold px-3 py-2 hover:bg-slate-50"
          >
            Cancelar
          </button>
          <button
            onClick={guardar}
            disabled={guardando}
            className="flex-1 rounded-xl bg-emerald-600 text-white text-xs font-semibold px-3 py-2 hover:bg-emerald-700 disabled:opacity-40"
          >
            {guardando ? "Guardando…" : "Guardar entrega ✍︎"}
          </button>
        </div>
        <p className="text-[11px] text-slate-400 mt-2">
          La fecha y hora de entrega las sella el servidor al guardar.
        </p>
      </div>
    </div>
  );
}
