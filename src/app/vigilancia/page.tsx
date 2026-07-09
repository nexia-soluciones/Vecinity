"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Html5Qrcode as Html5QrcodeType } from "html5-qrcode";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { callRpc } from "@/lib/rpc";
import { leerPlaca } from "./actions";

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
  plate_detected: string | null;
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
type CasaDir = {
  id: string;
  numero: string;
  propietario: string | null;
  tel_1: string | null;
  tel_2: string | null;
  tel_3: string | null;
};
type Moroso = { id: string; numero: string; propietario: string | null; saldo: number };
type SosActivo = {
  id: string;
  lat: number | null;
  lng: number | null;
  mode: string | null;
  activated_at: string;
  attended_by: string | null;
  autor: { nombre: string } | null;
  casa: { numero: string } | null;
  atendio: { nombre: string } | null;
};

const GENERALES = [
  { key: "alberca", label: "Alberca", emoji: "🏊" },
  { key: "limpieza", label: "Limpieza", emoji: "🧹" },
  { key: "basura", label: "Basura", emoji: "🚛" },
  { key: "jardineria", label: "Jardinería", emoji: "🌿" },
];
const BUCKET_SVC = "vecino-evidencias";
// Umbral de adeudo para restringir servicios extra a una casa (pesos).
// Configurable por villa en colonias.umbral_servicios (panel Áreas). Este es el
// fallback si la villa aún no lo tiene definido.
const SALDO_RESTRINGIDO_DEFAULT = 1000;

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
  const [sosActivos, setSosActivos] = useState<SosActivo[]>([]);

  // Escáner de pase QR
  const [scanOpen, setScanOpen] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [scanVisit, setScanVisit] = useState<{
    id: string;
    nombre: string;
    estado: string;
    casa: string | null;
  } | null>(null);
  const [scanResidente, setScanResidente] = useState<{
    valida: boolean;
    motivo: string | null;
    nombre: string | null;
    casa: string | null;
    rol: string | null;
    placas: string[];
    tarjeta_emitida: boolean;
  } | null>(null);
  const [scanIne, setScanIne] = useState<File | null>(null);
  const [scanPlaca, setScanPlaca] = useState<File | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const scannerRef = useRef<Html5QrcodeType | null>(null);
  const editandoRef = useRef(false);

  // Registro manual de visita en caseta (walk-in)
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

  // Directorio de teléfonos (buscar casa → ver/editar tel_1/2/3)
  const [dirQ, setDirQ] = useState("");
  const [dirCasa, setDirCasa] = useState<CasaDir | null>(null);
  const [dirMsg, setDirMsg] = useState<string | null>(null);
  const [dirBusy, setDirBusy] = useState(false);

  // Morosos / servicios restringidos (casas con saldo > 0)
  const [morosos, setMorosos] = useState<Moroso[]>([]);
  // Umbral de adeudo (por villa) que restringe servicios extra
  const [umbralServicios, setUmbralServicios] = useState<number>(SALDO_RESTRINGIDO_DEFAULT);

  // Cono asignado a una visita al ingresar (se guarda en localStorage del dispositivo)
  const [conos, setConos] = useState<Record<string, string>>({});
  const [conoFor, setConoFor] = useState<string | null>(null);
  const [conoVal, setConoVal] = useState("");

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
    const manana = new Date(hoy);
    manana.setDate(manana.getDate() + 1);
    // Solo reservas de HOY: el guardia entrega/devuelve el día de la reserva.
    // Las de días futuros se ven en el calendario general, no aquí.
    const { data } = await supabaseBrowser
      .from("reservations")
      .select(
        "id, estado, fecha_hora_inicio, fecha_hora_fin, area:common_areas(nombre, icono), house:houses(numero)"
      )
      .in("estado", ["aprobada", "en_uso"])
      .gte("fecha_hora_inicio", hoy.toISOString())
      .lt("fecha_hora_inicio", manana.toISOString())
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
        "id, nombre, estado, fecha_hora_entrada, fecha_hora_salida, foto_identificacion_url, foto_placas_url, plate_detected, house:houses(numero)"
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

  const cargarSos = useCallback(async () => {
    const { data } = await supabaseBrowser
      .from("sos_events")
      .select(
        "id, lat, lng, mode, activated_at, attended_by, " +
          "autor:profiles!sos_events_profile_id_fkey(nombre), " +
          "casa:houses(numero), atendio:profiles!sos_events_attended_by_fkey(nombre)"
      )
      .eq("is_active", true)
      .order("activated_at", { ascending: false });
    setSosActivos((data as unknown as SosActivo[]) ?? []);
  }, []);

  async function atenderSos(id: string) {
    const res = await callRpc("atender_sos", { p_id: id });
    if (!res.ok) {
      alert(res.error);
      return;
    }
    await cargarSos();
  }

  async function cerrarSos(id: string) {
    // Cerrar apaga la alerta de pánico para toda la vigilancia: confirmar para evitar mistaps.
    if (!confirm("¿Cerrar esta alerta de SOS? Se marcará como atendida y desaparecerá del tablero.")) return;
    const res = await callRpc("cerrar_sos", { p_id: id });
    if (!res.ok) {
      alert(res.error);
      return;
    }
    await cargarSos();
  }

  // --- Escáner de pase QR ---
  // Tres tipos de QR: pase de visita (.../visita/<token>), credencial de
  // residente (.../r/<profile_id>) y tarjeta de visita frecuente (.../vf/<card_id>).
  function extraerToken(text: string): string | null {
    try {
      const u = new URL(text);
      const parts = u.pathname.split("/").filter(Boolean);
      const vf = parts.indexOf("vf");
      if (vf >= 0 && parts[vf + 1]) return `vfrecuente:${parts[vf + 1]}`;
      const r = parts.indexOf("r");
      if (r >= 0 && parts[r + 1]) return `residente:${parts[r + 1]}`;
      const i = parts.indexOf("visita");
      if (i >= 0 && parts[i + 1]) return parts[i + 1];
    } catch {
      /* no es URL */
    }
    return text.trim() || null;
  }

  async function pararScanner() {
    const inst = scannerRef.current;
    scannerRef.current = null;
    if (inst) {
      try {
        await inst.stop();
        inst.clear();
      } catch {
        /* ignore */
      }
    }
  }

  async function onScan(text: string) {
    const token = extraerToken(text);
    if (!token) return setScanMsg("QR no reconocido.");
    await pararScanner();

    // Credenciales PVC del módulo Credenciales: residente o visita frecuente
    if (token.startsWith("residente:") || token.startsWith("vfrecuente:")) {
      const esResidente = token.startsWith("residente:");
      const id = token.slice(token.indexOf(":") + 1);
      const res = esResidente
        ? await callRpc<typeof scanResidente>("verificar_credencial", { p_profile_id: id })
        : await callRpc<typeof scanResidente>("verificar_tarjeta_visita", { p_card_id: id });
      if (!res.ok) return setScanMsg(res.error);
      setScanMsg(null);
      const d = res.data as Omit<NonNullable<typeof scanResidente>, "placas" | "tarjeta_emitida"> & {
        placas?: string[];
        tarjeta_emitida?: boolean;
      };
      setScanResidente({ ...d, placas: d.placas ?? [], tarjeta_emitida: d.tarjeta_emitida ?? true });
      return;
    }

    const { data } = await supabaseBrowser
      .from("visitors")
      .select("id, nombre, estado, house:houses(numero)")
      .eq("token_acceso", token)
      .maybeSingle();
    const v = data as unknown as
      | { id: string; nombre: string; estado: string; house: { numero: string } | null }
      | null;
    if (!v) return setScanMsg("Ese pase no corresponde a ninguna visita registrada.");
    setScanMsg(null);
    setScanVisit({ id: v.id, nombre: v.nombre, estado: v.estado, casa: v.house?.numero ?? null });
  }

  function abrirScan() {
    setScanVisit(null);
    setScanResidente(null);
    setScanIne(null);
    setScanPlaca(null);
    setScanMsg(null);
    setScanOpen(true);
  }

  function cerrarScan() {
    pararScanner();
    setScanOpen(false);
    setScanVisit(null);
    setScanResidente(null);
    setScanIne(null);
    setScanPlaca(null);
    setScanMsg(null);
  }

  async function entradaDesdeScan() {
    if (!scanVisit) return;
    setScanMsg(null);
    setScanBusy(true);
    try {
      const ineUrl = scanIne ? await subirFoto(scanIne, "visitas") : null;
      const placaUrl = scanPlaca ? await subirFoto(scanPlaca, "visitas") : null;
      // Si se eligió una foto pero no se pudo subir, no marcar la entrada sin evidencia.
      if ((scanIne && !ineUrl) || (scanPlaca && !placaUrl)) {
        setScanMsg("No se pudo subir la foto. Revisa la conexión e inténtalo de nuevo.");
        return;
      }
      if (ineUrl || placaUrl) {
        const adj = await callRpc("adjuntar_fotos_visita", {
          p_id: scanVisit.id,
          p_foto_ine_url: ineUrl,
          p_foto_placa_url: placaUrl,
        });
        if (!adj.ok) {
          setScanMsg(adj.error);
          return;
        }
      }
      const ent = await callRpc("marcar_entrada_visita", { p_id: scanVisit.id });
      if (!ent.ok) {
        setScanMsg(ent.error);
        return; // no cerrar: la entrada NO se marcó
      }
      await Promise.all([cargarVisitas(), cargarHistorial()]);
      cerrarScan();
    } finally {
      setScanBusy(false);
    }
  }

  async function salidaDesdeScan() {
    if (!scanVisit) return;
    setScanBusy(true);
    try {
      await supabaseBrowser.rpc("marcar_salida_visita", { p_id: scanVisit.id });
      await Promise.all([cargarVisitas(), cargarHistorial()]);
      cerrarScan();
    } finally {
      setScanBusy(false);
    }
  }

  // Arranca la cámara cuando el escáner está abierto y aún no hay visita resuelta
  useEffect(() => {
    if (!scanOpen || scanVisit || scanResidente) return;
    let cancelado = false;
    (async () => {
      const { Html5Qrcode } = await import("html5-qrcode");
      if (cancelado) return;
      const inst = new Html5Qrcode("qr-reader");
      scannerRef.current = inst;
      try {
        await inst.start({ facingMode: "environment" }, { fps: 10, qrbox: 240 }, onScan, () => {});
      } catch {
        setScanMsg("No se pudo abrir la cámara. Revisa los permisos del navegador.");
      }
    })();
    return () => {
      cancelado = true;
      pararScanner();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanOpen, scanVisit, scanResidente]);

  const cargarMorosos = useCallback(async (umbral: number) => {
    // Un convenio SOLO protege si está FORMALIZADO: un payment_plan activo con sus
    // términos. Estar marcada "en_convenio" sin plan capturado no basta → la casa
    // sigue apareciendo como restringida hasta que se registre el convenio.
    const { data: planes } = await supabaseBrowser
      .from("payment_plans")
      .select("house_id")
      .eq("activo", true);
    const conConvenio = new Set(
      ((planes as unknown as { house_id: string }[]) ?? []).map((p) => p.house_id)
    );

    // Casas con adeudo arriba del umbral.
    const { data } = await supabaseBrowser
      .from("houses")
      .select("id, numero, propietario, saldo")
      .gt("saldo", umbral)
      .order("saldo", { ascending: false })
      .limit(60);
    const arr = (data as unknown as Moroso[]) ?? [];
    setMorosos(arr.filter((h) => !conConvenio.has(h.id)));
  }, []);

  // Hidratar los conos guardados en este dispositivo (localStorage; efecto para evitar mismatch de SSR)
  useEffect(() => {
    try {
      const raw = localStorage.getItem("vigilancia_conos");
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setConos(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }, []);

  function guardarCono() {
    if (!conoFor) return;
    setConos((prev) => {
      const next = { ...prev };
      const val = conoVal.trim();
      if (val) next[conoFor] = val;
      else delete next[conoFor];
      try {
        localStorage.setItem("vigilancia_conos", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
    setConoFor(null);
    setConoVal("");
  }

  function quitarCono() {
    if (!conoFor) return;
    const id = conoFor;
    setConos((prev) => {
      const next = { ...prev };
      delete next[id];
      try {
        localStorage.setItem("vigilancia_conos", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
    setConoFor(null);
    setConoVal("");
  }

  async function buscarDirectorio() {
    const q = dirQ.trim();
    setDirMsg(null);
    setDirCasa(null);
    if (!q) return;
    const { data } = await supabaseBrowser
      .from("houses")
      .select("id, numero, propietario, tel_1, tel_2, tel_3")
      .eq("numero", q)
      .maybeSingle();
    if (!data) {
      setDirMsg("No se encontró esa casa.");
      return;
    }
    setDirCasa(data as unknown as CasaDir);
  }

  async function guardarTelefonos() {
    if (!dirCasa) return;
    setDirBusy(true);
    setDirMsg(null);
    const { error } = await supabaseBrowser.rpc("actualizar_telefonos_casa", {
      p_house_id: dirCasa.id,
      p_tel_1: dirCasa.tel_1 ?? "",
      p_tel_2: dirCasa.tel_2 ?? "",
      p_tel_3: dirCasa.tel_3 ?? "",
    });
    setDirBusy(false);
    setDirMsg(error ? error.message : "Teléfonos guardados ✓");
  }

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

      // Umbral de servicios restringidos (por villa) — fallback al default si no está.
      let umbralSvc = SALDO_RESTRINGIDO_DEFAULT;
      if (p.colonia_id) {
        const { data: col } = await supabaseBrowser
          .from("colonias")
          .select("umbral_servicios")
          .eq("id", p.colonia_id)
          .maybeSingle();
        umbralSvc =
          (col as unknown as { umbral_servicios: number } | null)?.umbral_servicios ??
          SALDO_RESTRINGIDO_DEFAULT;
      }
      setUmbralServicios(umbralSvc);

      await Promise.all([
        cargarTurno(user.id),
        cargarVisitas(),
        cargarReservas(),
        cargarPaquetes(),
        cargarGenerales(),
        cargarRecurrentes(),
        cargarHistorial(),
        cargarMorosos(umbralSvc),
        cargarSos(),
      ]);
      setReady(true);
    })();
  }, [router, cargarTurno, cargarVisitas, cargarReservas, cargarPaquetes, cargarGenerales, cargarRecurrentes, cargarHistorial, cargarMorosos, cargarSos]);

  // SOS en vivo: realtime (instantáneo) + sondeo cada 20s como respaldo
  useEffect(() => {
    if (!coloniaId) return;
    const ch = supabaseBrowser
      .channel("sos-vigilancia")
      .on(
        "postgres_changes",
        { event: "*", schema: "vecino", table: "sos_events" },
        () => cargarSos()
      )
      .subscribe();
    const iv = setInterval(cargarSos, 20000);
    return () => {
      supabaseBrowser.removeChannel(ch);
      clearInterval(iv);
    };
  }, [coloniaId, cargarSos]);

  // ¿El guardia está a media captura? Entonces NO auto-refrescar (para no perder su trabajo).
  const editando =
    showAdd ||
    scanOpen ||
    conoFor !== null ||
    dirCasa !== null ||
    mvBusy ||
    scanBusy ||
    dirBusy ||
    mvNombre.trim() !== "" ||
    mvCasa.trim() !== "" ||
    mvPlaca.trim() !== "" ||
    npNombre.trim() !== "" ||
    npCasa.trim() !== "" ||
    pkgCasa.trim() !== "" ||
    pkgRem.trim() !== "" ||
    placaQ.trim() !== "" ||
    dirQ.trim() !== "" ||
    Object.keys(ineStaged).length > 0 ||
    Object.keys(staged).length > 0;

  useEffect(() => {
    editandoRef.current = editando;
  }, [editando]);

  // Auto-refresco del tablero: cada 25s trae visitas/reservas/paquetes nuevos SIN recargar la
  // página (React conserva los formularios). Se salta el tick si el guardia está capturando algo.
  useEffect(() => {
    if (!coloniaId) return;
    const iv = setInterval(() => {
      if (editandoRef.current) return;
      cargarVisitas();
      cargarReservas();
      cargarPaquetes();
      cargarRecurrentes();
      cargarHistorial();
    }, 25000);
    return () => clearInterval(iv);
  }, [coloniaId, cargarVisitas, cargarReservas, cargarPaquetes, cargarRecurrentes, cargarHistorial]);

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

  async function salir() {
    await supabaseBrowser.auth.signOut();
    router.replace("/login");
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
    const { data: regData, error } = await supabaseBrowser.rpc("registrar_visita_manual", {
      p_nombre: mvNombre.trim(),
      p_house_id: house.id,
      p_placa: mvPlaca.trim() || null,
      p_foto_ine_url: ineUrl,
      p_foto_placa_url: placaUrl,
    });
    if (error) {
      setMvBusy(false);
      return setMvMsg(error.message.replace(/^.*?:\s/, ""));
    }

    // OCR de la placa con IA (si hay foto de placas)
    const newId = (regData as { id?: string } | null)?.id;
    if (newId && placaUrl) {
      const token = (await supabaseBrowser.auth.getSession()).data.session?.access_token ?? "";
      const ocr = await leerPlaca(token, placaUrl);
      if (ocr.ok && ocr.plate) {
        await supabaseBrowser.rpc("set_visita_plate", {
          p_id: newId,
          p_plate: ocr.plate,
          p_confidence: ocr.conf,
        });
      }
    }
    setMvBusy(false);
    setMvNombre("");
    setMvCasa("");
    setMvPlaca("");
    setMvIne(null);
    setMvPlacaFoto(null);
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
      <div className="w-full max-w-md md:max-w-6xl mx-auto px-5 py-6 flex flex-col">
        <div className="flex items-center justify-between">
          <button
            onClick={() => router.push("/dashboard")}
            className="text-base text-slate-500 hover:text-slate-700"
          >
            ← Volver
          </button>
          <Image src="/brand/vecinity-logo.svg" alt="Vecinity" width={120} height={34} priority />
          <button
            onClick={salir}
            className="text-base text-slate-400 hover:text-slate-600"
          >
            Salir
          </button>
        </div>

        <h1 className="text-2xl font-bold text-slate-800 mt-4">Vigilancia</h1>
        <p className="text-xs text-slate-400 mt-0.5">
          {editando
            ? "⏸ Actualización en pausa mientras capturas"
            : "🔄 Se actualiza solo — no necesitas refrescar"}
        </p>

        {/* 🚨 SOS activos — banner prioritario hasta arriba */}
        {sosActivos.length > 0 && (
          <section className="mt-4 rounded-3xl bg-red-600 text-white p-4 shadow-xl ring-4 ring-red-300">
            <h2 className="text-xl font-extrabold flex items-center gap-2">
              🚨 SOS activo{sosActivos.length > 1 ? `s (${sosActivos.length})` : ""}
              <span className="text-xs font-bold bg-white/25 rounded-full px-2 py-0.5 animate-pulse">
                ● EN VIVO
              </span>
            </h2>
            <ul className="mt-3 flex flex-col gap-2">
              {sosActivos.map((s) => (
                <li key={s.id} className="bg-white/10 rounded-2xl p-3">
                  <p className="text-lg font-extrabold">
                    {s.autor?.nombre ?? "Un vecino"}
                    {s.casa?.numero ? ` · Casa ${s.casa.numero}` : ""}
                  </p>
                  <p className="text-base text-white/90">
                    {hora(s.activated_at)}
                    {s.mode === "silent" ? " · ⚠️ silencioso" : ""}
                    {s.atendio?.nombre ? ` · Atendiendo: ${s.atendio.nombre}` : ""}
                  </p>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {s.lat != null && s.lng != null && (
                      <a
                        href={`https://maps.google.com/?q=${s.lat},${s.lng}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-xl bg-white text-red-700 text-base font-bold px-4 py-2"
                      >
                        📍 Ver ubicación
                      </a>
                    )}
                    {!s.attended_by && (
                      <button
                        onClick={() => atenderSos(s.id)}
                        className="rounded-xl bg-amber-400 text-red-900 text-base font-bold px-4 py-2 hover:bg-amber-300"
                      >
                        Atender
                      </button>
                    )}
                    <button
                      onClick={() => cerrarSos(s.id)}
                      className="rounded-xl bg-white/20 text-white text-base font-bold px-4 py-2 hover:bg-white/30"
                    >
                      Cerrar
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Turno */}
        <div
          className={`mt-4 rounded-3xl p-5 text-white shadow-lg ${
            turnoId ? "bg-gradient-to-br from-brand-500 to-emerald-600" : "bg-gradient-to-br from-slate-600 to-slate-800"
          }`}
        >
          <p className="text-white/80 text-base">Turno</p>
          <p className="text-xl font-extrabold mt-1">
            {turnoId ? `En turno desde ${turnoDesde ? desde(turnoDesde) : ""}` : "Fuera de turno"}
          </p>
          <button
            onClick={() => turno(turnoId ? "cerrar" : "iniciar")}
            className="mt-3 rounded-xl bg-white/20 hover:bg-white/30 px-4 py-2 text-base font-semibold"
          >
            {turnoId ? "Cerrar turno" : "Iniciar turno"}
          </button>
        </div>

        {/* Escanear pase QR de una visita */}
        <button
          onClick={abrirScan}
          className="mt-4 w-full rounded-2xl bg-brand-500 text-white font-bold text-lg py-4 shadow-lg hover:bg-brand-600 active:scale-[0.99] transition flex items-center justify-center gap-2"
        >
          📷 Escanear pase QR
        </button>

        {/* Registrar visita en caseta — bloque independiente (lo más usado) */}
        <section className="mt-4 rounded-3xl bg-brand-50 ring-1 ring-brand-200 p-4 shadow-sm">
          <h2 className="text-lg font-bold text-brand-700 mb-1">🪪 Registrar visita en caseta</h2>
          <p className="text-base text-slate-500 mb-2">Para una visita que llega sin pase QR.</p>
          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <input
                value={mvNombre}
                onChange={(e) => setMvNombre(e.target.value)}
                placeholder="Nombre del visitante"
                className="flex-1 rounded-xl ring-1 ring-slate-200 px-3 py-2 text-base text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
              />
              <input
                value={mvCasa}
                onChange={(e) => setMvCasa(e.target.value)}
                placeholder="Casa"
                className="w-20 rounded-xl ring-1 ring-slate-200 px-3 py-2 text-base text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
              />
            </div>
            <input
              value={mvPlaca}
              onChange={(e) => setMvPlaca(e.target.value.toUpperCase())}
              placeholder="Placa (opcional)"
              className="w-full rounded-xl ring-1 ring-slate-200 px-3 py-2 text-base text-slate-800 uppercase outline-none focus:ring-2 focus:ring-brand-300"
            />
            <div className="grid grid-cols-2 gap-2">
              <label className="text-base text-slate-500">
                Foto INE
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={(e) => setMvIne(e.target.files?.[0] ?? null)}
                  className="mt-1 w-full text-base text-slate-600 file:mr-2 file:rounded-lg file:border-0 file:bg-brand-100 file:text-brand-700 file:px-2 file:py-1.5 file:font-semibold"
                />
              </label>
              <label className="text-base text-slate-500">
                Foto placas
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={(e) => setMvPlacaFoto(e.target.files?.[0] ?? null)}
                  className="mt-1 w-full text-base text-slate-600 file:mr-2 file:rounded-lg file:border-0 file:bg-brand-100 file:text-brand-700 file:px-2 file:py-1.5 file:font-semibold"
                />
              </label>
            </div>
            {mvMsg && <p className="text-base text-red-600">{mvMsg}</p>}
            <button
              onClick={registrarVisitaManual}
              disabled={mvBusy}
              className="rounded-xl bg-brand-500 text-white text-base font-bold py-3 hover:bg-brand-600 disabled:opacity-40"
            >
              {mvBusy ? "Registrando…" : "Registrar entrada"}
            </button>
          </div>
        </section>

        {/* Secciones en stack vertical; las tarjetas de cada sección llenan el ancho en tablet */}
        {/* Buscar placa */}
        <section className="mt-4 rounded-3xl bg-slate-100/70 ring-1 ring-slate-200 p-4">
          <h2 className="text-lg font-bold text-slate-700 mb-2">Buscar placa</h2>
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
              className="rounded-xl bg-slate-700 text-white text-base font-semibold px-4 py-2"
            >
              Buscar
            </button>
          </div>
          {placaHits.length > 0 && (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 mt-2">
              {placaHits.map((v) => (
                <li key={v.id} className="bg-white rounded-2xl p-3 ring-1 ring-slate-100">
                  <p className="text-lg font-semibold text-slate-800">
                    {v.placa} · Casa {v.house?.numero ?? "—"}
                  </p>
                  <p className="text-base text-slate-500">
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

        {/* Directorio de teléfonos */}
        <section className="mt-4 rounded-3xl bg-slate-100/70 ring-1 ring-slate-200 p-4">
          <h2 className="text-lg font-bold text-slate-700 mb-2">Directorio</h2>
          <div className="flex gap-2">
            <input
              value={dirQ}
              onChange={(e) => setDirQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && buscarDirectorio()}
              placeholder="N° de casa"
              className="flex-1 rounded-xl ring-1 ring-slate-200 px-3 py-2 text-base text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
            />
            <button
              onClick={buscarDirectorio}
              className="rounded-xl bg-slate-700 text-white text-base font-semibold px-4 py-2"
            >
              Buscar
            </button>
          </div>
          {dirCasa && (
            <div className="bg-white rounded-2xl ring-1 ring-slate-100 p-3 mt-2 flex flex-col gap-2">
              <p className="text-lg font-semibold text-slate-800">
                Casa {dirCasa.numero}
                {dirCasa.propietario ? ` · ${dirCasa.propietario}` : ""}
              </p>
              <input
                value={dirCasa.tel_1 ?? ""}
                onChange={(e) => setDirCasa({ ...dirCasa, tel_1: e.target.value })}
                placeholder="Teléfono 1"
                inputMode="tel"
                className="rounded-xl ring-1 ring-slate-200 px-3 py-2 text-base text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
              />
              <input
                value={dirCasa.tel_2 ?? ""}
                onChange={(e) => setDirCasa({ ...dirCasa, tel_2: e.target.value })}
                placeholder="Teléfono 2"
                inputMode="tel"
                className="rounded-xl ring-1 ring-slate-200 px-3 py-2 text-base text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
              />
              <input
                value={dirCasa.tel_3 ?? ""}
                onChange={(e) => setDirCasa({ ...dirCasa, tel_3: e.target.value })}
                placeholder="Teléfono 3"
                inputMode="tel"
                className="rounded-xl ring-1 ring-slate-200 px-3 py-2 text-base text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
              />
              <button
                onClick={guardarTelefonos}
                disabled={dirBusy}
                className="rounded-xl bg-brand-500 text-white text-base font-semibold py-2 hover:bg-brand-600 disabled:opacity-40"
              >
                {dirBusy ? "Guardando…" : "Guardar teléfonos"}
              </button>
            </div>
          )}
          {dirMsg && <p className="text-base text-slate-500 mt-1">{dirMsg}</p>}
        </section>

        {/* Visitas */}
        <section className="mt-4 rounded-3xl bg-slate-100/70 ring-1 ring-slate-200 p-4">
          <h2 className="text-lg font-bold text-slate-700 mb-2">
            Visitas en espera <span className="text-slate-400 font-medium">({visitas.length})</span>
          </h2>

          {visitas.length === 0 ? (
            <p className="text-slate-400 text-base bg-white rounded-2xl p-4 ring-1 ring-slate-100">
              Sin visitas en espera.
            </p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {visitas.map((v) => (
                <li
                  key={v.id}
                  className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <p className="text-lg font-semibold text-slate-800 truncate">{v.nombre}</p>
                    <p className="text-base text-slate-500">
                      Casa {v.house?.numero ?? "—"}
                      {v.fecha_programada ? ` · ${hora(v.fecha_programada)}` : ""}
                    </p>
                    {conos[v.id] ? (
                      <button
                        onClick={() => {
                          setConoFor(v.id);
                          setConoVal(conos[v.id] ?? "");
                        }}
                        className="mt-1 text-base font-bold text-amber-600"
                      >
                        🔶 Cono {conos[v.id]} · editar
                      </button>
                    ) : (
                      <button
                        onClick={() => {
                          setConoFor(v.id);
                          setConoVal("");
                        }}
                        className="mt-1 text-base text-slate-400 underline"
                      >
                        + Asignar cono
                      </button>
                    )}
                  </div>
                  {v.estado === "esperando" ? (
                    <div className="flex items-center gap-1.5 shrink-0">
                      <label
                        className={`text-3xl cursor-pointer ${ineStaged[v.id] ? "opacity-100" : "opacity-60"}`}
                        title="Foto del INE (opcional)"
                      >
                        📷
                        <input
                          type="file"
                          accept="image/*"
                    capture="environment"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) setIneStaged((s) => ({ ...s, [v.id]: f }));
                          }}
                        />
                      </label>
                      <button
                        onClick={() => visitaAccion(v.id, "entrada")}
                        className="rounded-xl bg-brand-500 text-white text-base font-semibold px-3 py-2 hover:bg-brand-600"
                      >
                        Entrada
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => visitaAccion(v.id, "salida")}
                      className="rounded-xl bg-slate-700 text-white text-base font-semibold px-3 py-2 hover:bg-slate-800 shrink-0"
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
        <section className="mt-4 rounded-3xl bg-slate-100/70 ring-1 ring-slate-200 p-4">
          <h2 className="text-lg font-bold text-slate-700 mb-2">
            Reservas de hoy <span className="text-slate-400 font-medium">({reservas.length})</span>
          </h2>
          {reservas.length === 0 ? (
            <p className="text-slate-400 text-base bg-white rounded-2xl p-4 ring-1 ring-slate-100">
              Sin reservas para entregar.
            </p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {reservas.map((r) => (
                <li
                  key={r.id}
                  className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <p className="text-lg font-semibold text-slate-800 truncate">
                      Casa {r.house?.numero ?? "—"} · {r.area?.icono} {r.area?.nombre}
                    </p>
                    <p className="text-base text-slate-500">
                      {hora(r.fecha_hora_inicio)}–{hora(r.fecha_hora_fin)}
                    </p>
                  </div>
                  {r.estado === "aprobada" ? (
                    <button
                      onClick={() => reservaAccion(r.id, "entregar")}
                      className="rounded-xl bg-brand-500 text-white text-base font-semibold px-3 py-2 hover:bg-brand-600 shrink-0"
                    >
                      Entregar
                    </button>
                  ) : (
                    <button
                      onClick={() => reservaAccion(r.id, "devolver")}
                      className="rounded-xl bg-slate-700 text-white text-base font-semibold px-3 py-2 hover:bg-slate-800 shrink-0"
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
        <section className="mt-4 rounded-3xl bg-slate-100/70 ring-1 ring-slate-200 p-4">
          <h2 className="text-lg font-bold text-slate-700 mb-2">Servicios de la villa</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
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
                    {abierto && <span className="text-sm font-bold">● DENTRO</span>}
                  </div>
                  <p className="text-base font-semibold mt-1">{g.label}</p>
                  <p className={`text-sm ${abierto ? "text-white/80" : "text-slate-400"}`}>
                    {abierto ? `Entró ${desde(abierto.entrada)} · tocar = salida` : "Tocar = entrada"}
                  </p>
                </button>
              );
            })}
          </div>
        </section>

        {/* Servicios recurrentes (domésticos) */}
        <section className="mt-4 rounded-3xl bg-slate-100/70 ring-1 ring-slate-200 p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-lg font-bold text-slate-700">
              Recurrentes <span className="text-slate-400 font-medium">({providers.length})</span>
            </h2>
            <button
              onClick={() => setShowAdd((v) => !v)}
              className="text-base text-brand-600 font-semibold"
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
                  className="flex-1 rounded-xl ring-1 ring-slate-200 px-3 py-2 text-base text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
                />
                <input
                  value={npCasa}
                  onChange={(e) => setNpCasa(e.target.value)}
                  placeholder="Casa"
                  className="w-20 rounded-xl ring-1 ring-slate-200 px-3 py-2 text-base text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
                />
              </div>
              <div className="flex gap-2">
                <select
                  value={npTipo}
                  onChange={(e) => setNpTipo(e.target.value)}
                  className="rounded-xl ring-1 ring-slate-200 px-2 py-2 text-base text-slate-800 bg-white outline-none focus:ring-2 focus:ring-brand-300"
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
                    capture="environment"
                  onChange={(e) => setNpFile(e.target.files?.[0] ?? null)}
                  className="flex-1 text-base text-slate-600 file:mr-2 file:rounded-lg file:border-0 file:bg-brand-50 file:text-brand-700 file:px-2 file:py-1.5 file:font-semibold"
                />
              </div>
              {npMsg && <p className="text-base text-red-600">{npMsg}</p>}
              <button
                onClick={agregarProveedor}
                className="rounded-xl bg-brand-500 text-white text-base font-semibold py-2 hover:bg-brand-600"
              >
                Guardar proveedor recurrente
              </button>
            </div>
          )}

          {providers.length === 0 ? (
            <p className="text-slate-400 text-base bg-white rounded-2xl p-4 ring-1 ring-slate-100">
              Sin proveedores recurrentes registrados.
            </p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
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
                      <p className="text-lg font-semibold text-slate-800 truncate">{pr.nombre}</p>
                      <p className="text-base text-slate-500 truncate">
                        <span className="font-bold text-slate-700">
                          Casa {pr.house?.numero ?? "—"}
                        </span>
                        {" · "}
                        {pr.tipo}
                        {dentro ? " · ● dentro" : ""}
                      </p>
                    </div>
                    {dentro ? (
                      <button
                        onClick={() => salirProveedor(dentro.id)}
                        className="rounded-xl bg-slate-700 text-white text-base font-semibold px-3 py-2 hover:bg-slate-800 shrink-0"
                      >
                        Salida
                      </button>
                    ) : (
                      <div className="flex items-center gap-1.5 shrink-0">
                        <label
                          className={`text-3xl cursor-pointer ${staged[pr.id] ? "opacity-100" : "opacity-60"}`}
                          title="Foto del día (opcional)"
                        >
                          📷
                          <input
                            type="file"
                            accept="image/*"
                    capture="environment"
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) setStaged((s) => ({ ...s, [pr.id]: f }));
                            }}
                          />
                        </label>
                        <button
                          onClick={() => ingresarProveedor(pr.id)}
                          className="rounded-xl bg-brand-500 text-white text-base font-semibold px-3 py-2 hover:bg-brand-600"
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
        <section className="mt-4 mb-4 rounded-3xl bg-slate-100/70 ring-1 ring-slate-200 p-4">
          <h2 className="text-lg font-bold text-slate-700 mb-2">
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
              className="rounded-xl bg-brand-500 text-white text-base font-semibold px-3 py-2 hover:bg-brand-600"
            >
              +
            </button>
          </div>
          {pkgMsg && <p className="text-base text-slate-500 mb-2">{pkgMsg}</p>}
          {paquetes.length > 0 && (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {paquetes.map((p) => (
                <li
                  key={p.id}
                  className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <p className="text-lg font-semibold text-slate-800 truncate">
                      Casa {p.house?.numero ?? "—"} · {p.remitente}
                    </p>
                    <p className="text-base text-slate-500">{p.estado}</p>
                  </div>
                  <button
                    onClick={() => entregarPaquete(p.id)}
                    className="rounded-xl bg-slate-700 text-white text-base font-semibold px-3 py-2 hover:bg-slate-800 shrink-0"
                  >
                    Entregar
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Historial de hoy */}
        <section className="mt-4 mb-6 rounded-3xl bg-slate-100/70 ring-1 ring-slate-200 p-4">
          <h2 className="text-lg font-bold text-slate-700 mb-2">
            Historial de hoy <span className="text-slate-400 font-medium">({historial.length})</span>
          </h2>
          {historial.length === 0 ? (
            <p className="text-slate-400 text-base bg-white rounded-2xl p-4 ring-1 ring-slate-100">
              Aún no hay entradas registradas hoy.
            </p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {historial.map((h) => (
                <li
                  key={h.id}
                  className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <p className="text-lg font-semibold text-slate-800 truncate">
                      Casa {h.house?.numero ?? "—"} · {h.nombre}
                    </p>
                    <p className="text-base text-slate-500">
                      {h.fecha_hora_entrada ? `Entró ${hora(h.fecha_hora_entrada)}` : "—"}
                      {h.fecha_hora_salida ? ` · Salió ${hora(h.fecha_hora_salida)}` : ""}
                      {h.plate_detected ? ` · 🚘 ${h.plate_detected}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {h.foto_identificacion_url && (
                      <a
                        href={h.foto_identificacion_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-2xl"
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
                        className="text-2xl"
                        title="Ver placas"
                      >
                        🚗
                      </a>
                    )}
                    <span
                      className={`text-sm font-semibold px-2 py-0.5 rounded-full ${
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

        {/* Servicios restringidos (morosos) — al final del dashboard */}
        {morosos.length > 0 && (
          <section className="mt-4 mb-6">
            <h2 className="text-lg font-bold text-red-700 mb-2">
              Servicios restringidos{" "}
              <span className="text-red-400 font-medium">({morosos.length})</span>
            </h2>
            <div className="bg-red-50 ring-1 ring-red-200 rounded-2xl p-3">
              <p className="text-base text-red-700 mb-2">
                Casas con adeudo mayor a ${umbralServicios.toLocaleString("es-MX")} — no permitir
                el ingreso de servicios extra (proveedores no esenciales).
              </p>
              <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {morosos.map((m) => (
                  <li
                    key={m.id}
                    className="bg-white rounded-xl p-2.5 ring-1 ring-red-100 flex items-center justify-between gap-2"
                  >
                    <span className="text-base font-semibold text-slate-800 truncate">
                      Casa {m.numero}
                      {m.propietario ? ` · ${m.propietario}` : ""}
                    </span>
                    <span className="text-base font-bold text-red-600 shrink-0">
                      ${Number(m.saldo).toLocaleString("es-MX")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}
      </div>

      {scanOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-5"
          onClick={cerrarScan}
        >
          <div
            className="bg-white rounded-2xl p-5 w-full max-w-md flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            {scanResidente ? (
              <>
                <div
                  className={`rounded-2xl p-4 text-center ${
                    scanResidente.valida ? "bg-emerald-50 ring-1 ring-emerald-200" : "bg-red-50 ring-1 ring-red-200"
                  }`}
                >
                  <p className={`text-2xl font-extrabold ${scanResidente.valida ? "text-emerald-700" : "text-red-600"}`}>
                    {scanResidente.valida
                      ? `✓ ${scanResidente.rol === "Visita frecuente" ? "VISITA FRECUENTE" : "RESIDENTE"} VÁLIDO`
                      : "✗ NO VÁLIDO"}
                  </p>
                  {scanResidente.motivo && (
                    <p className="text-sm text-red-600 mt-1">{scanResidente.motivo}</p>
                  )}
                </div>
                {scanResidente.nombre && (
                  <>
                    <h3 className="text-xl font-bold text-slate-800">{scanResidente.nombre}</h3>
                    <p className="text-base text-slate-500">
                      Casa {scanResidente.casa ?? "—"} · {scanResidente.rol}
                      {!scanResidente.tarjeta_emitida && " · ⚠️ tarjeta no registrada en el sistema"}
                    </p>
                    {scanResidente.placas.length > 0 && (
                      <p className="text-sm text-slate-500 bg-slate-50 rounded-xl px-3 py-2">
                        Placas de la casa: <b>{scanResidente.placas.join(" · ")}</b>
                      </p>
                    )}
                  </>
                )}
                <button
                  onClick={cerrarScan}
                  className="rounded-xl bg-slate-100 text-slate-600 text-base font-semibold py-2.5"
                >
                  Cerrar
                </button>
              </>
            ) : !scanVisit ? (
              <>
                <h3 className="text-xl font-bold text-slate-800">Escanear pase QR</h3>
                <p className="text-base text-slate-500">
                  Apunta la cámara al QR del visitante o a la credencial del residente.
                </p>
                <div id="qr-reader" className="w-full overflow-hidden rounded-xl bg-slate-900" />
                {scanMsg && <p className="text-base text-red-600">{scanMsg}</p>}
                <button
                  onClick={cerrarScan}
                  className="rounded-xl bg-slate-100 text-slate-600 text-base font-semibold py-2.5"
                >
                  Cancelar
                </button>
              </>
            ) : (
              <>
                <h3 className="text-xl font-bold text-slate-800">{scanVisit.nombre}</h3>
                <p className="text-base text-slate-500">
                  Casa {scanVisit.casa ?? "—"} · {scanVisit.estado}
                </p>
                {scanVisit.estado === "esperando" ? (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="text-base text-slate-500">
                        Foto INE
                        <input
                          type="file"
                          accept="image/*"
                          capture="environment"
                          onChange={(e) => setScanIne(e.target.files?.[0] ?? null)}
                          className="mt-1 w-full text-base text-slate-600 file:mr-2 file:rounded-lg file:border-0 file:bg-brand-50 file:text-brand-700 file:px-2 file:py-1.5 file:font-semibold"
                        />
                      </label>
                      <label className="text-base text-slate-500">
                        Foto placas
                        <input
                          type="file"
                          accept="image/*"
                          capture="environment"
                          onChange={(e) => setScanPlaca(e.target.files?.[0] ?? null)}
                          className="mt-1 w-full text-base text-slate-600 file:mr-2 file:rounded-lg file:border-0 file:bg-brand-50 file:text-brand-700 file:px-2 file:py-1.5 file:font-semibold"
                        />
                      </label>
                    </div>
                    <button
                      onClick={entradaDesdeScan}
                      disabled={scanBusy}
                      className="rounded-xl bg-brand-500 text-white text-base font-bold py-3 hover:bg-brand-600 disabled:opacity-40"
                    >
                      {scanBusy ? "Registrando…" : "✓ Marcar entrada"}
                    </button>
                  </>
                ) : scanVisit.estado === "adentro" ? (
                  <button
                    onClick={salidaDesdeScan}
                    disabled={scanBusy}
                    className="rounded-xl bg-slate-700 text-white text-base font-bold py-3 hover:bg-slate-800 disabled:opacity-40"
                  >
                    {scanBusy ? "Registrando…" : "Marcar salida"}
                  </button>
                ) : (
                  <p className="text-base text-slate-500 bg-slate-50 rounded-xl p-3">
                    Esta visita ya está finalizada.
                  </p>
                )}
                <button
                  onClick={cerrarScan}
                  className="rounded-xl bg-slate-100 text-slate-600 text-base font-semibold py-2.5"
                >
                  Cerrar
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {conoFor && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-5"
          onClick={() => setConoFor(null)}
        >
          <div
            className="bg-white rounded-2xl p-5 w-full max-w-sm flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-xl font-bold text-slate-800">Asignar cono</h3>
            <p className="text-base text-slate-500">
              Número o color del cono entregado al vehículo (se guarda solo en esta tablet).
            </p>
            <input
              value={conoVal}
              onChange={(e) => setConoVal(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && guardarCono()}
              autoFocus
              placeholder="Ej. 12 / rojo"
              className="rounded-xl ring-1 ring-slate-200 px-3 py-2.5 text-lg text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
            />
            <div className="flex gap-2">
              <button
                onClick={guardarCono}
                className="flex-1 rounded-xl bg-brand-500 text-white text-base font-semibold py-2.5 hover:bg-brand-600"
              >
                Guardar
              </button>
              <button
                onClick={quitarCono}
                className="rounded-xl bg-slate-100 text-slate-600 text-base font-semibold px-4 py-2.5 hover:bg-slate-200"
              >
                Quitar
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
