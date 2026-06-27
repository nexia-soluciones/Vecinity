"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";

type Visita = {
  id: string;
  nombre: string;
  estado: string;
  fecha_programada: string | null;
  house: { numero: string } | null;
};
type HistVisita = {
  id: string;
  nombre: string;
  estado: string;
  fecha_hora_entrada: string | null;
  fecha_hora_salida: string | null;
  foto_identificacion_url: string | null;
  foto_placas_url: string | null;
  house: { numero: string } | null;
};
type Reserva = {
  id: string;
  estado: string;
  fecha_hora_inicio: string;
  fecha_hora_fin: string;
  area: { nombre: string; icono: string | null } | null;
  house: { numero: string } | null;
};
type Paquete = {
  id: string;
  remitente: string;
  numero_guia: string | null;
  estado: string;
  house: { numero: string } | null;
};
type PlacaHit = {
  id: string;
  placa: string;
  color: string | null;
  estado: string;
  brand: { nombre: string } | null;
  model: { nombre: string } | null;
  house: { numero: string } | null;
};
type Gen = { id: string; tipo: string; entrada: string };
type Provider = {
  id: string;
  nombre: string;
  tipo: string;
  foto_url: string | null;
  house: { numero: string } | null;
};
type ExtSvc = { id: string; provider_id: string | null; house: { numero: string } | null };

const GENERALES = [
  { key: "alberca", label: "Alberca", emoji: "🏊" },
  { key: "limpieza", label: "Limpieza", emoji: "🧹" },
  { key: "basura", label: "Basura", emoji: "🚛" },
  { key: "jardineria", label: "Jardinería", emoji: "🌿" },
];
const BUCKET_SVC = "vecino-evidencias";

const hora = (iso: string) =>
  new Date(iso).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
const desde = (iso: string) =>
  new Date(iso).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });

export default function VigilanciaPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [coloniaId, setColoniaId] = useState<string | null>(null);
  const [turnoId, setTurnoId] = useState<string | null>(null);
  const [turnoDesde, setTurnoDesde] = useState<string | null>(null);

  const [visitas, setVisitas] = useState<Visita[]>([]);
  const [reservas, setReservas] = useState<Reserva[]>([]);
  const [paquetes, setPaquetes] = useState<Paquete[]>([]);
  const [historial, setHistorial] = useState<HistVisita[]>([]);

  // Registro manual de visita en caseta (walk-in)
  const [mvOpen, setMvOpen] = useState(false);
  const [mvNombre, setMvNombre] = useState("");
  const [mvCasa, setMvCasa] = useState("");
  const [mvPlaca, setMvPlaca] = useState("");
  const [mvIne, setMvIne] = useState<File | null>(null);
  const [mvPlacaFoto, setMvPlacaFoto] = useState<File | null>(null);
  const [mvMsg, setMvMsg] = useState<string | null>(null);
  const [mvBusy, setMvBusy] = useState(false);
  // Foto INE preparada para una visita por pase QR antes de marcar entrada
  const [ineStaged, setIneStaged] = useState<Record<string, File>>({});

  const [placaQ, setPlacaQ] = useState("");
  const [placaHits, setPlacaHits] = useState<PlacaHit[]>([]);

  const [pkgCasa, setPkgCasa] = useState("");
  const [pkgRem, setPkgRem] = useState("");
  const [pkgMsg, setPkgMsg] = useState<string | null>(null);

  const [generales, setGenerales] = useState<Gen[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [activos, setActivos] = useState<ExtSvc[]>([]);
  const [staged, setStaged] = useState<Record<string, File>>({});
  const [showAdd, setShowAdd] = useState(false);
  const [npNombre, setNpNombre] = useState("");
  const [npTipo, setNpTipo] = useState("limpieza");
  const [npCasa, setNpCasa] = useState("");
  const [npFile, setNpFile] = useState<File | null>(null);
  const [npMsg, setNpMsg] = useState<string | null>(null);

  const cargarTurno = useCallback(async (uid: string) => {
    const { data } = await supabaseBrowser
      .from("guard_shifts")
      .select("id, entrada")
      .eq("guardia_id", uid)
      .is("salida", null)
      .order("entrada", { ascending: false })
      .limit(1)
      .maybeSingle();
    const t = data as unknown as { id: string; entrada: string } | null;
    setTurnoId(t?.id ?? null);
    setTurnoDesde(t?.entrada ?? null);
  }, []);

  const cargarVisitas = useCallback(async () => {
    const { data } = await supabaseBrowser
      .from("visitors")
      .select("id, nombre, estado, fecha_programada, house:houses(numero)")
      .in("estado", ["esperando", "adentro"])
      .order("fecha_programada", { nullsFirst: false })
      .limit(50);
    setVisitas((data as unknown as Visita[]) ?? []);
  }, []);

  const cargarReservas = useCallback(async () => {
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    const { data } = await supabaseBrowser
      .from("reservations")
      .select(
        "id, estado, fecha_hora_inicio, fecha_hora_fin, area:common_areas(nombre, icono), house:houses(numero)"
      )
      .in("estado", ["aprobada", "en_uso"])
      .gte("fecha_hora_inicio", hoy.toISOString())
      .order("fecha_hora_inicio")
      .limit(40);
    setReservas((data as unknown as Reserva[]) ?? []);
  }, []);

  const cargarPaquetes = useCallback(async () => {
    const { data } = await supabaseBrowser
      .from("packages")
      .select("id, remitente, numero_guia, estado, house:houses(numero)")
      .in("estado", ["en_vigilancia", "esperando_llegada"])
      .order("fecha_llegada", { ascending: false })
      .limit(40);
    setPaquetes((data as unknown as Paquete[]) ?? []);
  }, []);

  const cargarHistorial = useCallback(async () => {
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    const { data } = await supabaseBrowser
      .from("visitors")
      .select(
        "id, nombre, estado, fecha_hora_entrada, fecha_hora_salida, foto_identificacion_url, foto_placas_url, house:houses(numero)"
      )
      .gte("fecha_hora_entrada", hoy.toISOString())
      .order("fecha_hora_entrada", { ascending: false })
      .limit(40);
    setHistorial((data as unknown as HistVisita[]) ?? []);
  }, []);

  const cargarGenerales = useCallback(async () => {
    const { data } = await supabaseBrowser
      .from("general_services")
      .select("id, tipo, entrada")
      .is("salida", null);
    setGenerales((data as unknown as Gen[]) ?? []);
  }, []);

  const cargarRecurrentes = useCallback(async () => {
    const { data: provs } = await supabaseBrowser
      .from("service_providers")
      .select("id, nombre, tipo, foto_url, house:houses(numero)")
      .eq("activo", true)
      .order("nombre");
    setProviders((provs as unknown as Provider[]) ?? []);
    const { data: act } = await supabaseBrowser
      .from("external_services")
      .select("id, provider_id, house:houses(numero)")
      .is("fecha_salida", null);
    setActivos((act as unknown as ExtSvc[]) ?? []);
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
      if (!p || p.approval_status !== "aprobado") return router.replace("/esperando");
      if (!["guardia", "admin", "comite"].includes(p.role)) return router.replace("/dashboard");
      setColoniaId(p.colonia_id);
      await Promise.all([
        cargarTurno(user.id),
        cargarVisitas(),
        cargarReservas(),
        cargarPaquetes(),
        cargarGenerales(),
        cargarRecurrentes(),
        cargarHistorial(),
      ]);
      setReady(true);
    })();
  }, [router, cargarTurno, cargarVisitas, cargarReservas, cargarPaquetes, cargarGenerales, cargarRecurrentes, cargarHistorial]);

  async function subirFoto(file: File, sub: string): Promise<string | null> {
    if (!coloniaId) return null;
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const path = `${coloniaId}/${sub}/${crypto.randomUUID()}.${ext}`;
    const { error } = await supabaseBrowser.storage.from(BUCKET_SVC).upload(path, file);
    if (error) return null;
    return supabaseBrowser.storage.from(BUCKET_SVC).getPublicUrl(path).data.publicUrl;
  }

  async function toggleGeneral(tipo: string) {
    const abierto = generales.find((g) => g.tipo === tipo);
    if (abierto) {
      await supabaseBrowser.rpc("cerrar_servicio_general", { p_id: abierto.id });
    } else {
      await supabaseBrowser.rpc("iniciar_servicio_general", { p_tipo: tipo });
    }
    await cargarGenerales();
  }

  async function ingresarProveedor(providerId: string) {
    const file = staged[providerId];
    const url = file ? await subirFoto(file, "proveedores") : null;
    await supabaseBrowser.rpc("ingresar_proveedor", { p_provider_id: providerId, p_foto_url: url });
    setStaged((s) => {
      const n = { ...s };
      delete n[providerId];
      return n;
    });
    await cargarRecurrentes();
  }

  async function salirProveedor(extId: string) {
    await supabaseBrowser.rpc("salir_proveedor", { p_id: extId });
    await cargarRecurrentes();
  }

  async function agregarProveedor() {
    setNpMsg(null);
    if (!npNombre.trim()) return setNpMsg("Escribe el nombre.");
    if (!npCasa.trim()) return setNpMsg("Indica la casa.");
    const { data: h } = await supabaseBrowser
      .from("houses")
      .select("id")
      .eq("numero", npCasa.trim())
      .maybeSingle();
    const house = h as unknown as { id: string } | null;
    if (!house) return setNpMsg(`No encontré la casa ${npCasa}.`);
    const url = npFile ? await subirFoto(npFile, "proveedores") : null;
    const { error } = await supabaseBrowser.rpc("crear_proveedor", {
      p_nombre: npNombre.trim(),
      p_tipo: npTipo,
      p_house_id: house.id,
      p_foto_url: url,
    });
    if (error) return setNpMsg(error.message.replace(/^.*?:\s/, ""));
    setNpNombre("");
    setNpCasa("");
    setNpFile(null);
    setShowAdd(false);
    await cargarRecurrentes();
  }

  async function turno(accion: "iniciar" | "cerrar") {
    await supabaseBrowser.rpc(accion === "iniciar" ? "iniciar_turno" : "cerrar_turno");
    const {
      data: { user },
    } = await supabaseBrowser.auth.getUser();
    if (user) await cargarTurno(user.id);
  }

  async function visitaAccion(id: string, accion: "entrada" | "salida") {
    // Si hay una foto de INE preparada para esta visita, súbela y adjúntala antes de entrar.
    if (accion === "entrada" && ineStaged[id]) {
      const url = await subirFoto(ineStaged[id], "visitas");
      if (url) await supabaseBrowser.rpc("adjuntar_fotos_visita", { p_id: id, p_foto_ine_url: url });
      setIneStaged((s) => {
        const n = { ...s };
        delete n[id];
        return n;
      });
    }
    await supabaseBrowser.rpc(
      accion === "entrada" ? "marcar_entrada_visita" : "marcar_salida_visita",
      { p_id: id }
    );
    await Promise.all([cargarVisitas(), cargarHistorial()]);
  }

  async function registrarVisitaManual() {
    setMvMsg(null);
    if (!mvNombre.trim()) return setMvMsg("Escribe el nombre del visitante.");
    if (!mvCasa.trim()) return setMvMsg("Indica la casa destino.");
    setMvBusy(true);
    const { data: h } = await supabaseBrowser
      .from("houses")
      .select("id")
      .eq("numero", mvCasa.trim())
      .maybeSingle();
    const house = h as unknown as { id: string } | null;
    if (!house) {
      setMvBusy(false);
      return setMvMsg(`No encontré la casa ${mvCasa}.`);
    }
    const ineUrl = mvIne ? await subirFoto(mvIne, "visitas") : null;
    const placaUrl = mvPlacaFoto ? await subirFoto(mvPlacaFoto, "visitas") : null;
    const { error } = await supabaseBrowser.rpc("registrar_visita_manual", {
      p_nombre: mvNombre.trim(),
      p_house_id: house.id,
      p_placa: mvPlaca.trim() || null,
      p_foto_ine_url: ineUrl,
      p_foto_placa_url: placaUrl,
    });
    setMvBusy(false);
    if (error) return setMvMsg(error.message.replace(/^.*?:\s/, ""));
    setMvNombre("");
    setMvCasa("");
    setMvPlaca("");
    setMvIne(null);
    setMvPlacaFoto(null);
    setMvOpen(false);
    await Promise.all([cargarVisitas(), cargarHistorial()]);
  }

  async function reservaAccion(id: string, accion: "entregar" | "devolver") {
    await supabaseBrowser.rpc(accion === "entregar" ? "entregar_area" : "devolver_area", {
      p_id: id,
    });
    await cargarReservas();
  }

  async function buscarPlaca() {
    const q = placaQ.trim();
    if (!q) return setPlacaHits([]);
    const { data } = await supabaseBrowser
      .from("vehicles")
      .select("id, placa, color, estado, brand:vehicle_brands(nombre), model:vehicle_models(nombre), house:houses(numero)")
      .ilike("placa", `%${q.toUpperCase()}%`)
      .limit(10);
    setPlacaHits((data as unknown as PlacaHit[]) ?? []);
  }

  async function registrarPaquete() {
    setPkgMsg(null);
    const num = pkgCasa.trim();
    if (!num) return setPkgMsg("Escribe el número de casa.");
    const { data: h } = await supabaseBrowser
      .from("houses")
      .select("id")
      .eq("numero", num)
      .maybeSingle();
    const house = h as unknown as { id: string } | null;
    if (!house) return setPkgMsg(`No encontré la casa ${num}.`);
    const { error } = await supabaseBrowser.rpc("registrar_paquete", {
      p_house_id: house.id,
      p_remitente: pkgRem.trim() || "Paquete",
      p_numero_guia: null,
    });
    if (error) return setPkgMsg(error.message.replace(/^.*?:\s/, ""));
    setPkgCasa("");
    setPkgRem("");
    setPkgMsg("Paquete registrado ✓");
    await cargarPaquetes();
  }

  async function entregarPaquete(id: string) {
    await supabaseBrowser.rpc("entregar_paquete", { p_id: id });
    await cargarPaquetes();
  }

  if (!ready)
    return (
      <main className="flex-1 flex items-center justify-center text-slate-400">Cargando…</main>
    );

  return (
    <main className="flex-1 bg-gradient-to-b from-slate-50 via-white to-sky-50">
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

        <h1 className="text-2xl font-bold text-slate-800 mt-4">Vigilancia</h1>

        {/* Turno */}
        <div
          className={`mt-4 rounded-3xl p-5 text-white shadow-lg ${
            turnoId ? "bg-gradient-to-br from-brand-500 to-emerald-600" : "bg-gradient-to-br from-slate-600 to-slate-800"
          }`}
        >
          <p className="text-white/80 text-sm">Turno</p>
          <p className="text-xl font-extrabold mt-1">
            {turnoId ? `En turno desde ${turnoDesde ? desde(turnoDesde) : ""}` : "Fuera de turno"}
          </p>
          <button
            onClick={() => turno(turnoId ? "cerrar" : "iniciar")}
            className="mt-3 rounded-xl bg-white/20 hover:bg-white/30 px-4 py-2 text-sm font-semibold"
          >
            {turnoId ? "Cerrar turno" : "Iniciar turno"}
          </button>
        </div>

        {/* Buscar placa */}
        <section className="mt-5">
          <h2 className="text-sm font-bold text-slate-700 mb-2">Buscar placa</h2>
          <div className="flex gap-2">
            <input
              value={placaQ}
              onChange={(e) => setPlacaQ(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && buscarPlaca()}
              placeholder="ABC-123"
              className="flex-1 rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 uppercase outline-none focus:ring-2 focus:ring-brand-300"
            />
            <button
              onClick={buscarPlaca}
              className="rounded-xl bg-slate-700 text-white text-sm font-semibold px-4 py-2"
            >
              Buscar
            </button>
          </div>
          {placaHits.length > 0 && (
            <ul className="flex flex-col gap-2 mt-2">
              {placaHits.map((v) => (
                <li key={v.id} className="bg-white rounded-2xl p-3 ring-1 ring-slate-100">
                  <p className="font-semibold text-slate-800">
                    {v.placa} · Casa {v.house?.numero ?? "—"}
                  </p>
                  <p className="text-xs text-slate-500">
                    {[v.brand?.nombre, v.model?.nombre, v.color].filter(Boolean).join(" · ") || "—"} ·{" "}
                    <span className={v.estado === "aprobado" ? "text-emerald-600" : "text-amber-600"}>
                      {v.estado}
                    </span>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Visitas */}
        <section className="mt-6">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-bold text-slate-700">
              Visitas <span className="text-slate-400 font-medium">({visitas.length})</span>
            </h2>
            <button
              onClick={() => setMvOpen((v) => !v)}
              className="text-sm text-brand-600 font-semibold"
            >
              {mvOpen ? "Cerrar" : "+ En caseta"}
            </button>
          </div>

          {mvOpen && (
            <div className="bg-white rounded-2xl ring-1 ring-slate-100 p-3 mb-2 flex flex-col gap-2">
              <p className="text-xs text-slate-500">Registrar visita que llega sin pase</p>
              <div className="flex gap-2">
                <input
                  value={mvNombre}
                  onChange={(e) => setMvNombre(e.target.value)}
                  placeholder="Nombre del visitante"
                  className="flex-1 rounded-xl ring-1 ring-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
                />
                <input
                  value={mvCasa}
                  onChange={(e) => setMvCasa(e.target.value)}
                  placeholder="Casa"
                  className="w-20 rounded-xl ring-1 ring-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
                />
              </div>
              <input
                value={mvPlaca}
                onChange={(e) => setMvPlaca(e.target.value.toUpperCase())}
                placeholder="Placa (opcional)"
                className="w-full rounded-xl ring-1 ring-slate-200 px-3 py-2 text-sm text-slate-800 uppercase outline-none focus:ring-2 focus:ring-brand-300"
              />
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs text-slate-500">
                  Foto INE
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => setMvIne(e.target.files?.[0] ?? null)}
                    className="mt-1 w-full text-xs text-slate-600 file:mr-2 file:rounded-lg file:border-0 file:bg-brand-50 file:text-brand-700 file:px-2 file:py-1.5 file:font-semibold"
                  />
                </label>
                <label className="text-xs text-slate-500">
                  Foto placas
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => setMvPlacaFoto(e.target.files?.[0] ?? null)}
                    className="mt-1 w-full text-xs text-slate-600 file:mr-2 file:rounded-lg file:border-0 file:bg-brand-50 file:text-brand-700 file:px-2 file:py-1.5 file:font-semibold"
                  />
                </label>
              </div>
              {mvMsg && <p className="text-xs text-red-600">{mvMsg}</p>}
              <button
                onClick={registrarVisitaManual}
                disabled={mvBusy}
                className="rounded-xl bg-brand-500 text-white text-sm font-semibold py-2 hover:bg-brand-600 disabled:opacity-40"
              >
                {mvBusy ? "Registrando…" : "Registrar entrada"}
              </button>
            </div>
          )}

          {visitas.length === 0 ? (
            <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
              Sin visitas en espera.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {visitas.map((v) => (
                <li
                  key={v.id}
                  className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-800 truncate">{v.nombre}</p>
                    <p className="text-xs text-slate-500">
                      Casa {v.house?.numero ?? "—"}
                      {v.fecha_programada ? ` · ${hora(v.fecha_programada)}` : ""}
                    </p>
                  </div>
                  {v.estado === "esperando" ? (
                    <div className="flex items-center gap-1.5 shrink-0">
                      <label
                        className={`text-lg cursor-pointer ${ineStaged[v.id] ? "opacity-100" : "opacity-40"}`}
                        title="Foto del INE (opcional)"
                      >
                        📷
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) setIneStaged((s) => ({ ...s, [v.id]: f }));
                          }}
                        />
                      </label>
                      <button
                        onClick={() => visitaAccion(v.id, "entrada")}
                        className="rounded-xl bg-brand-500 text-white text-sm font-semibold px-3 py-2 hover:bg-brand-600"
                      >
                        Entrada
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => visitaAccion(v.id, "salida")}
                      className="rounded-xl bg-slate-700 text-white text-sm font-semibold px-3 py-2 hover:bg-slate-800 shrink-0"
                    >
                      Salida
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Reservas (ciclo de llave) */}
        <section className="mt-6">
          <h2 className="text-sm font-bold text-slate-700 mb-2">
            Reservas de hoy <span className="text-slate-400 font-medium">({reservas.length})</span>
          </h2>
          {reservas.length === 0 ? (
            <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
              Sin reservas para entregar.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {reservas.map((r) => (
                <li
                  key={r.id}
                  className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-800 truncate">
                      {r.area?.icono} {r.area?.nombre} · Casa {r.house?.numero ?? "—"}
                    </p>
                    <p className="text-xs text-slate-500">
                      {hora(r.fecha_hora_inicio)}–{hora(r.fecha_hora_fin)}
                    </p>
                  </div>
                  {r.estado === "aprobada" ? (
                    <button
                      onClick={() => reservaAccion(r.id, "entregar")}
                      className="rounded-xl bg-brand-500 text-white text-sm font-semibold px-3 py-2 hover:bg-brand-600 shrink-0"
                    >
                      Entregar
                    </button>
                  ) : (
                    <button
                      onClick={() => reservaAccion(r.id, "devolver")}
                      className="rounded-xl bg-slate-700 text-white text-sm font-semibold px-3 py-2 hover:bg-slate-800 shrink-0"
                    >
                      Devolución
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Servicios de la villa */}
        <section className="mt-6">
          <h2 className="text-sm font-bold text-slate-700 mb-2">Servicios de la villa</h2>
          <div className="grid grid-cols-2 gap-2">
            {GENERALES.map((g) => {
              const abierto = generales.find((x) => x.tipo === g.key);
              return (
                <button
                  key={g.key}
                  onClick={() => toggleGeneral(g.key)}
                  className={`rounded-2xl p-3.5 text-left ring-1 transition ${
                    abierto
                      ? "bg-emerald-500 text-white ring-emerald-500"
                      : "bg-white text-slate-700 ring-slate-100 hover:ring-brand-200"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xl">{g.emoji}</span>
                    {abierto && <span className="text-[10px] font-bold">● DENTRO</span>}
                  </div>
                  <p className="text-sm font-semibold mt-1">{g.label}</p>
                  <p className={`text-[11px] ${abierto ? "text-white/80" : "text-slate-400"}`}>
                    {abierto ? `Entró ${desde(abierto.entrada)} · tocar = salida` : "Tocar = entrada"}
                  </p>
                </button>
              );
            })}
          </div>
        </section>

        {/* Servicios recurrentes (domésticos) */}
        <section className="mt-6">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-bold text-slate-700">
              Recurrentes <span className="text-slate-400 font-medium">({providers.length})</span>
            </h2>
            <button
              onClick={() => setShowAdd((v) => !v)}
              className="text-sm text-brand-600 font-semibold"
            >
              {showAdd ? "Cerrar" : "+ Nuevo"}
            </button>
          </div>

          {showAdd && (
            <div className="bg-white rounded-2xl ring-1 ring-slate-100 p-3 mb-2 flex flex-col gap-2">
              <div className="flex gap-2">
                <input
                  value={npNombre}
                  onChange={(e) => setNpNombre(e.target.value)}
                  placeholder="Nombre (ej. María)"
                  className="flex-1 rounded-xl ring-1 ring-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
                />
                <input
                  value={npCasa}
                  onChange={(e) => setNpCasa(e.target.value)}
                  placeholder="Casa"
                  className="w-20 rounded-xl ring-1 ring-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
                />
              </div>
              <div className="flex gap-2">
                <select
                  value={npTipo}
                  onChange={(e) => setNpTipo(e.target.value)}
                  className="rounded-xl ring-1 ring-slate-200 px-2 py-2 text-sm text-slate-800 bg-white outline-none focus:ring-2 focus:ring-brand-300"
                >
                  <option value="limpieza">Limpieza</option>
                  <option value="jardineria">Jardinería</option>
                  <option value="niñera">Niñera</option>
                  <option value="cocina">Cocina</option>
                  <option value="otro">Otro</option>
                </select>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => setNpFile(e.target.files?.[0] ?? null)}
                  className="flex-1 text-xs text-slate-600 file:mr-2 file:rounded-lg file:border-0 file:bg-brand-50 file:text-brand-700 file:px-2 file:py-1.5 file:font-semibold"
                />
              </div>
              {npMsg && <p className="text-xs text-red-600">{npMsg}</p>}
              <button
                onClick={agregarProveedor}
                className="rounded-xl bg-brand-500 text-white text-sm font-semibold py-2 hover:bg-brand-600"
              >
                Guardar proveedor recurrente
              </button>
            </div>
          )}

          {providers.length === 0 ? (
            <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
              Sin proveedores recurrentes registrados.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {providers.map((pr) => {
                const dentro = activos.find((a) => a.provider_id === pr.id);
                return (
                  <li
                    key={pr.id}
                    className="bg-white rounded-2xl p-3 ring-1 ring-slate-100 flex items-center gap-3"
                  >
                    {pr.foto_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={pr.foto_url}
                        alt={pr.nombre}
                        className="w-10 h-10 rounded-full object-cover ring-1 ring-slate-200"
                      />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center text-slate-400">
                        👤
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-slate-800 truncate">{pr.nombre}</p>
                      <p className="text-xs text-slate-500 truncate">
                        {pr.tipo} · Casa {pr.house?.numero ?? "—"}
                        {dentro ? " · ● dentro" : ""}
                      </p>
                    </div>
                    {dentro ? (
                      <button
                        onClick={() => salirProveedor(dentro.id)}
                        className="rounded-xl bg-slate-700 text-white text-sm font-semibold px-3 py-2 hover:bg-slate-800 shrink-0"
                      >
                        Salida
                      </button>
                    ) : (
                      <div className="flex items-center gap-1.5 shrink-0">
                        <label
                          className={`text-lg cursor-pointer ${staged[pr.id] ? "opacity-100" : "opacity-40"}`}
                          title="Foto del día (opcional)"
                        >
                          📷
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) setStaged((s) => ({ ...s, [pr.id]: f }));
                            }}
                          />
                        </label>
                        <button
                          onClick={() => ingresarProveedor(pr.id)}
                          className="rounded-xl bg-brand-500 text-white text-sm font-semibold px-3 py-2 hover:bg-brand-600"
                        >
                          Entrada
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Paquetes */}
        <section className="mt-6 mb-4">
          <h2 className="text-sm font-bold text-slate-700 mb-2">
            Paquetes <span className="text-slate-400 font-medium">({paquetes.length})</span>
          </h2>
          <div className="bg-white rounded-2xl ring-1 ring-slate-100 p-3 flex gap-2 mb-2">
            <input
              value={pkgCasa}
              onChange={(e) => setPkgCasa(e.target.value)}
              placeholder="Casa"
              className="w-20 rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
            />
            <input
              value={pkgRem}
              onChange={(e) => setPkgRem(e.target.value)}
              placeholder="Remitente (Amazon…)"
              className="flex-1 rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
            />
            <button
              onClick={registrarPaquete}
              className="rounded-xl bg-brand-500 text-white text-sm font-semibold px-3 py-2 hover:bg-brand-600"
            >
              +
            </button>
          </div>
          {pkgMsg && <p className="text-xs text-slate-500 mb-2">{pkgMsg}</p>}
          {paquetes.length > 0 && (
            <ul className="flex flex-col gap-2">
              {paquetes.map((p) => (
                <li
                  key={p.id}
                  className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-800 truncate">
                      Casa {p.house?.numero ?? "—"} · {p.remitente}
                    </p>
                    <p className="text-xs text-slate-500">{p.estado}</p>
                  </div>
                  <button
                    onClick={() => entregarPaquete(p.id)}
                    className="rounded-xl bg-slate-700 text-white text-sm font-semibold px-3 py-2 hover:bg-slate-800 shrink-0"
                  >
                    Entregar
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Historial de hoy */}
        <section className="mt-6 mb-6">
          <h2 className="text-sm font-bold text-slate-700 mb-2">
            Historial de hoy <span className="text-slate-400 font-medium">({historial.length})</span>
          </h2>
          {historial.length === 0 ? (
            <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
              Aún no hay entradas registradas hoy.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {historial.map((h) => (
                <li
                  key={h.id}
                  className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-800 truncate">
                      {h.nombre} · Casa {h.house?.numero ?? "—"}
                    </p>
                    <p className="text-xs text-slate-500">
                      {h.fecha_hora_entrada ? `Entró ${hora(h.fecha_hora_entrada)}` : "—"}
                      {h.fecha_hora_salida ? ` · Salió ${hora(h.fecha_hora_salida)}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {h.foto_identificacion_url && (
                      <a
                        href={h.foto_identificacion_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-base"
                        title="Ver INE"
                      >
                        🪪
                      </a>
                    )}
                    {h.foto_placas_url && (
                      <a
                        href={h.foto_placas_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-base"
                        title="Ver placas"
                      >
                        🚗
                      </a>
                    )}
                    <span
                      className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                        h.estado === "adentro"
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-slate-100 text-slate-500"
                      }`}
                    >
                      {h.estado}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
