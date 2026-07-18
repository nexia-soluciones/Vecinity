"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { callRpc } from "@/lib/rpc";
import { leerComprobante } from "./actions";

type Mov = {
  id: string;
  tipo: string;
  monto: number;
  concepto: string;
  estado: string;
  comprobante_url: string | null;
  created_at: string;
  // Aclaración pedida por el comité sobre este movimiento (y la respuesta del vecino)
  aclaracion_solicitud?: string | null;
  aclaracion_respuesta?: string | null;
};
// Pendiente por aprobar (RPC abonos_pendientes_comite): incluye la palomita del
// banco (en_banco + banco_fecha/hash) y el monto leído por OCR del comprobante.
type Pend = Mov & {
  casa: string | null;
  ocr_monto: number | null;
  ocr_fecha: string | null;
  en_banco: boolean;
  banco_hash: string | null;
  banco_fecha: string | null;
  // rastreo/casa/aprendido/monto_fecha = match SEGURO (liga al aprobar);
  // monto_fecha_ambiguo = hay varios candidatos → NO liga (aprobar normal)
  match_por: "rastreo" | "casa" | "aprendido" | "monto_fecha" | "monto_fecha_ambiguo" | null;
  candidatos: number | null;
  aclaracion: string | null;
  aclaracion_respuesta: string | null;
};
// Casa cuyas finanzas puedo operar: donde vivo o donde soy propietario (casa rentada)
type CasaFin = { id: string; numero: string; propia: boolean };

// Fila del banco (bank_movs) aún sin conciliar — para revisarla/descartarla aquí mismo
type MovBanco = { fecha: string; monto: number; concepto: string; banco_hash: string };

const money = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);
const fecha = (iso: string) =>
  new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
// Para fechas-sin-hora del banco (YYYY-MM-DD): anclar a mediodía para que la
// zona horaria no la recorra un día hacia atrás.
const fechaDia = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString("es-MX", {
    day: "numeric",
    month: "short",
  });

const BUCKET = "vecino-comprobantes";
const MOV_COLS =
  "id, tipo, monto, concepto, estado, comprobante_url, created_at, aclaracion_solicitud, aclaracion_respuesta";

// Clave casa|monto|añoMes para cruzar un comprobante pendiente contra los abonos
// que ya se conciliaron con el banco (mismo mes) → detectar posible duplicado.
const claveConc = (numero: string, monto: number, iso: string) =>
  `${numero}|${monto}|${iso.slice(0, 7)}`;

export default function PagosPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [houseId, setHouseId] = useState<string | null>(null);
  const [casas, setCasas] = useState<CasaFin[]>([]);
  const [coloniaId, setColoniaId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [saldo, setSaldo] = useState(0);
  const [casaNum, setCasaNum] = useState<string | null>(null);

  const [monto, setMonto] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const [movs, setMovs] = useState<Mov[]>([]);
  const [pend, setPend] = useState<Pend[]>([]);
  const [conc, setConc] = useState<Set<string>>(new Set()); // casa|monto|añoMes ya en banco
  const [resolviendo, setResolviendo] = useState<Set<string>>(new Set());
  const [pendErr, setPendErr] = useState<string | null>(null);
  // Corrección de monto antes de aprobar (vecino capturó mal, ej. 750 vs 450)
  const [editId, setEditId] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  // Movimientos del banco sin conciliar + confirmación de descarte en dos taps
  const [movsBanco, setMovsBanco] = useState<MovBanco[]>([]);
  const [descartando, setDescartando] = useState<string | null>(null);
  // Enlace manual abono↔banco (con motivo que sirve de aprendizaje)
  const [linkId, setLinkId] = useState<string | null>(null);
  const [linkHash, setLinkHash] = useState<string | null>(null);
  const [linkMotivo, setLinkMotivo] = useState("");
  // Respuesta del vecino a una aclaración pedida por el comité
  const [respId, setRespId] = useState<string | null>(null);
  const [respFecha, setRespFecha] = useState("");
  const [respTexto, setRespTexto] = useState("");
  const [respMsg, setRespMsg] = useState<string | null>(null);

  const cargarSaldo = useCallback(async (hid: string) => {
    const { data } = await supabaseBrowser
      .from("houses")
      .select("numero, saldo")
      .eq("id", hid)
      .maybeSingle();
    const h = data as unknown as { numero: string; saldo: number } | null;
    setSaldo(h?.saldo ?? 0);
    setCasaNum(h?.numero ?? null);
  }, []);

  const cargarMovs = useCallback(async (hid: string) => {
    const { data } = await supabaseBrowser
      .from("transactions")
      .select(MOV_COLS)
      .eq("house_id", hid)
      .order("created_at", { ascending: false })
      .limit(50);
    setMovs((data as unknown as Mov[]) ?? []);
  }, []);

  const cargarPend = useCallback(async () => {
    // RPC: pendientes + cruce contra las filas del banco guardadas (bank_movs)
    // + monto OCR del comprobante para comparar contra lo capturado.
    const { data } = await supabaseBrowser.rpc("abonos_pendientes_comite");
    setPend((data as unknown as Pend[]) ?? []);

    // Ingresos del banco (staging) aún sin conciliar — para descartarlos aquí mismo
    const { data: mb } = await supabaseBrowser
      .from("bank_movs")
      .select("fecha, monto, concepto, banco_hash")
      .eq("estado", "pendiente")
      .eq("tipo", "abono")
      .order("fecha");
    setMovsBanco((mb as unknown as MovBanco[]) ?? []);

    // Abonos que YA se conciliaron con el banco (banco_hash) → para avisar cuando
    // un comprobante pendiente ya está cubierto por el banco (posible duplicado).
    const { data: yaBanco } = await supabaseBrowser
      .from("transactions")
      .select("monto, created_at, house:houses(numero)")
      .eq("tipo", "abono")
      .not("banco_hash", "is", null);
    const set = new Set<string>();
    for (const c of (yaBanco as unknown as {
      monto: number;
      created_at: string;
      house: { numero: string } | null;
    }[]) ?? [])
      if (c.house?.numero) set.add(claveConc(c.house.numero, c.monto, c.created_at));
    setConc(set);
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
        colonia_id: string | null;
        role: string;
        approval_status: string;
      } | null;
      if (!p || p.approval_status !== "aprobado") return router.replace("/esperando");
      setColoniaId(p.colonia_id);
      const admin = p.role === "admin" || p.role === "comite";
      setIsAdmin(admin);

      // Casas financieras: donde vivo + donde soy propietario (casas rentadas)
      const lista: CasaFin[] = [];
      if (p.house_id) {
        const { data: h } = await supabaseBrowser
          .from("houses")
          .select("id, numero")
          .eq("id", p.house_id)
          .maybeSingle();
        const mia = h as unknown as { id: string; numero: string } | null;
        if (mia) lista.push({ id: mia.id, numero: mia.numero, propia: true });
      }
      const { data: hm } = await supabaseBrowser
        .from("house_members")
        .select("house_id, house:houses(numero)")
        .eq("profile_id", user.id);
      for (const m of (hm as unknown as { house_id: string; house: { numero: string } | null }[]) ?? []) {
        if (!lista.some((c) => c.id === m.house_id))
          lista.push({ id: m.house_id, numero: m.house?.numero ?? "?", propia: false });
      }
      setCasas(lista);

      const inicial = lista[0]?.id ?? null;
      setHouseId(inicial);
      if (inicial) {
        await cargarSaldo(inicial);
        await cargarMovs(inicial);
      }
      if (admin) await cargarPend();
      setReady(true);
    })();
  }, [router, cargarSaldo, cargarMovs, cargarPend]);

  async function registrar() {
    setErr(null);
    setOk(null);
    const m = parseFloat(monto);
    if (!m || m <= 0) return setErr("Escribe un monto válido.");
    setEnviando(true);
    try {
      let url: string | null = null;
      let hash: string | null = null;
      if (file && houseId && coloniaId) {
        // hash del archivo para detectar el mismo comprobante subido dos veces
        const buf = await file.arrayBuffer();
        const digest = await crypto.subtle.digest("SHA-256", buf);
        hash = Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
        const path = `${coloniaId}/${houseId}/${crypto.randomUUID()}.${ext}`;
        const { error: upErr } = await supabaseBrowser.storage.from(BUCKET).upload(path, file);
        if (upErr) throw new Error("No se pudo subir el comprobante.");
        url = supabaseBrowser.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
      }
      const { data: abData, error } = await supabaseBrowser.rpc("registrar_abono", {
        p_monto: m,
        p_comprobante_url: url,
        p_concepto: "Abono",
        p_comprobante_hash: hash,
        p_house_id: houseId,
      });
      if (error) throw new Error(error.message.replace(/^.*?:\s/, ""));
      // OCR del comprobante (best-effort): extrae la clave de rastreo para que el
      // banco lo concilie solo y para evitar que el mismo pago se registre 2 veces.
      const nuevoId = (abData as { id?: string } | null)?.id;
      let duplicado = false;
      let dupDetalle = "";
      let avisoMonto = "";
      if (nuevoId && url) {
        try {
          const { data: sess } = await supabaseBrowser.auth.getSession();
          const token = sess.session?.access_token;
          if (token) {
            const oc = await leerComprobante(token, url);
            if (oc.ok) {
              const ref = oc.data.clave_rastreo || oc.data.folio || null;
              const { data: sr } = await supabaseBrowser.rpc("set_abono_ocr", {
                p_id: nuevoId,
                p_ocr: oc.data,
                p_ref: ref,
              });
              const r = sr as {
                duplicado?: boolean;
                original_casa?: string;
                original_fecha?: string;
              } | null;
              if (r?.duplicado) {
                duplicado = true;
                if (r.original_fecha && r.original_casa)
                  dupDetalle = ` Ese recibo se subió el ${r.original_fecha} por la casa ${r.original_casa}.`;
              }
              // El monto del comprobante no coincide con lo capturado → avisar
              // (no bloquea: el comité lo verá marcado al aprobar).
              if (!duplicado && oc.data.monto !== null && Math.abs(oc.data.monto - m) >= 0.01) {
                avisoMonto = ` Ojo: el comprobante dice ${money(oc.data.monto)} y capturaste ${money(m)} — el comité lo revisará.`;
              }
            }
          }
        } catch {
          /* el OCR es opcional; el abono ya quedó registrado */
        }
      }
      if (duplicado) {
        setErr(
          `Esta transferencia ya había sido registrada antes.${dupDetalle} No se duplicó tu pago.`
        );
      } else {
        setOk(`Abono enviado. El comité lo revisará.${avisoMonto}`);
      }
      setMonto("");
      setFile(null);
      // El <input type="file"> es no-controlado: setFile(null) no limpia lo que
      // muestra el navegador → hay que resetear el input nativo a mano.
      if (fileRef.current) fileRef.current.value = "";
      if (houseId) await cargarMovs(houseId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error al registrar el abono.");
    } finally {
      setEnviando(false);
    }
  }

  async function resolver(t: Pend, aprobar: boolean) {
    const id = t.id;
    if (resolviendo.has(id)) return; // evita doble-tap
    setPendErr(null);
    setResolviendo((s) => new Set(s).add(id));
    // Si el abono YA apareció en el estado de cuenta (palomita), aprobar también
    // liga la fila del banco (aprobar_abono_banco) → no se re-ofrece al conciliar.
    // SOLO con match seguro (rastreo/casa/1-a-1): un match ambiguo por monto+fecha
    // podría ligar la fila de OTRA casa (muchas pagan lo mismo el mismo día).
    const conBanco =
      aprobar && t.en_banco && !!t.banco_hash && t.match_por !== "monto_fecha_ambiguo";
    const res = conBanco
      ? await callRpc("aprobar_abono_banco", { p_id: id, p_banco_hash: t.banco_hash })
      : await callRpc("resolver_transaccion", { p_id: id, p_aprobar: aprobar });
    const dupBanco = res.ok && (res.data as { ok?: boolean; dup?: boolean } | null)?.dup;
    if (!res.ok || dupBanco) {
      setPendErr(
        !res.ok
          ? res.error
          : "Esa fila del banco ya se ligó a otro pago — recarga la página y revisa."
      );
      setResolviendo((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
      return; // NO se remueve: la transacción sigue pendiente en la BD
    }
    setPend((l) => l.filter((x) => x.id !== id));
    setResolviendo((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    if (houseId) {
      await cargarSaldo(houseId);
      await cargarMovs(houseId);
    }
    if (isAdmin) await cargarPend();
  }

  // Corrige el monto de un abono pendiente (queda auditado en el concepto) y
  // recarga la lista: si ahora cuadra con el banco, aparece la palomita.
  async function corregirMonto(t: Pend) {
    const v = parseFloat(editVal);
    if (!v || v <= 0) return setPendErr("Escribe un monto válido.");
    setPendErr(null);
    const res = await callRpc("corregir_monto_abono", { p_id: t.id, p_nuevo_monto: v });
    if (!res.ok) return setPendErr(res.error);
    setEditId(null);
    setEditVal("");
    await cargarPend();
  }

  // Candidatos del banco para enlazar un abono: SOLO mismo monto (el servidor lo
  // exige — si el monto está mal, primero se corrige), ordenados por cercanía de fecha.
  function candidatosBanco(t: Pend): MovBanco[] {
    const base = new Date(`${(t.ocr_fecha ?? t.created_at).slice(0, 10)}T12:00:00`).getTime();
    return movsBanco
      .filter((m) => Math.abs(Number(m.monto) - t.monto) < 0.01)
      .sort(
        (a, b) =>
          Math.abs(new Date(`${a.fecha}T12:00:00`).getTime() - base) -
          Math.abs(new Date(`${b.fecha}T12:00:00`).getTime() - base)
      );
  }

  // Enlaza el abono a la fila del banco elegida y lo aprueba. El motivo queda
  // auditado y la referencia del banco se APRENDE (bank_ref_map) → el próximo
  // mes ese vecino sale con palomita solo.
  async function enlazar(t: Pend) {
    if (!linkHash || resolviendo.has(t.id)) return;
    setPendErr(null);
    setResolviendo((s) => new Set(s).add(t.id));
    const res = await callRpc("enlazar_abono_banco", {
      p_id: t.id,
      p_banco_hash: linkHash,
      p_motivo: linkMotivo.trim() || null,
    });
    const dup = res.ok && (res.data as { dup?: boolean } | null)?.dup;
    setResolviendo((s) => {
      const n = new Set(s);
      n.delete(t.id);
      return n;
    });
    if (!res.ok || dup) {
      setPendErr(!res.ok ? res.error : "Esa fila del banco ya se ligó a otro pago — recarga.");
      return;
    }
    setLinkId(null);
    setLinkHash(null);
    setLinkMotivo("");
    await cargarPend();
    if (houseId) {
      await cargarSaldo(houseId);
      await cargarMovs(houseId);
    }
  }

  // Pide al vecino los datos que faltan del comprobante (mensaje formal automático
  // según lo que no se pudo leer). Le llega por Telegram (si lo tiene ligado) y
  // como banner sobre su movimiento en la app.
  async function pedirDatos(t: Pend) {
    if (resolviendo.has(t.id)) return;
    setPendErr(null);
    setResolviendo((s) => new Set(s).add(t.id));
    const res = await callRpc("solicitar_aclaracion_abono", { p_id: t.id });
    setResolviendo((s) => {
      const n = new Set(s);
      n.delete(t.id);
      return n;
    });
    if (!res.ok) return setPendErr(res.error);
    await cargarPend();
  }

  // El vecino responde la aclaración: su fecha alimenta la conciliación.
  async function responderAclaracion(mov: Mov) {
    setRespMsg(null);
    if (!respFecha && !respTexto.trim()) return setRespMsg("Indica la fecha o escribe el concepto.");
    const res = await callRpc("responder_aclaracion_abono", {
      p_id: mov.id,
      p_fecha: respFecha || null,
      p_texto: respTexto.trim() || null,
    });
    if (!res.ok) return setRespMsg(res.error);
    setRespId(null);
    setRespFecha("");
    setRespTexto("");
    if (houseId) await cargarMovs(houseId);
  }

  // Descarta una fila del banco que no es pago de vecino (traspaso, interés…).
  // Dos taps: el primero pide confirmar, el segundo descarta.
  async function descartarBanco(hash: string) {
    if (descartando !== hash) {
      setDescartando(hash);
      return;
    }
    setDescartando(null);
    const res = await callRpc("descartar_mov_banco", { p_banco_hash: hash });
    if (!res.ok) return setPendErr(res.error);
    // recargar: sin esa fila cambian también las palomitas/ambigüedades
    await cargarPend();
  }

  if (!ready)
    return (
      <main className="flex-1 flex items-center justify-center text-slate-400">Cargando…</main>
    );

  const conAdeudo = saldo > 0;

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

        <h1 className="text-2xl font-bold text-slate-800 mt-4">Pagos</h1>

        {/* Selector de casa (dueño con 2+ casas o dueño que también vive aquí) */}
        {casas.length > 1 && (
          <div className="mt-3 flex gap-2 flex-wrap">
            {casas.map((c) => (
              <button
                key={c.id}
                onClick={async () => {
                  setHouseId(c.id);
                  await cargarSaldo(c.id);
                  await cargarMovs(c.id);
                }}
                className={`rounded-xl px-3 py-1.5 text-sm font-semibold ring-1 transition ${
                  houseId === c.id
                    ? "bg-brand-500 text-white ring-brand-500"
                    : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50"
                }`}
              >
                Casa {c.numero}
                {!c.propia && <span className="ml-1 text-[10px] opacity-80">dueño</span>}
              </button>
            ))}
          </div>
        )}

        {/* Saldo */}
        {casaNum && (
          <div
            className={`mt-4 rounded-3xl p-5 text-white shadow-lg ${
              conAdeudo
                ? "bg-gradient-to-br from-amber-500 to-orange-600"
                : "bg-gradient-to-br from-brand-500 to-emerald-600"
            }`}
          >
            <p className="text-white/80 text-sm">Casa {casaNum}</p>
            <p className="text-3xl font-extrabold mt-1">{money(saldo)}</p>
            <p className="text-white/90 text-sm mt-1">
              {conAdeudo ? "Saldo pendiente por pagar" : "Estás al corriente ✓"}
            </p>
          </div>
        )}

        {/* Registrar abono */}
        <section className="mt-5 bg-white rounded-2xl ring-1 ring-slate-100 p-4 flex flex-col gap-3">
          <h2 className="text-sm font-bold text-slate-700">Registrar abono</h2>
          <label className="text-xs text-slate-500">
            Monto
            <input
              type="number"
              inputMode="decimal"
              value={monto}
              onChange={(e) => setMonto(e.target.value)}
              placeholder="0.00"
              className="mt-1 w-full rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
            />
          </label>
          <label className="text-xs text-slate-500">
            Comprobante (foto del recibo / transferencia)
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="mt-1 w-full text-sm text-slate-600 file:mr-3 file:rounded-xl file:border-0 file:bg-brand-50 file:text-brand-700 file:px-3 file:py-2 file:font-semibold"
            />
          </label>
          {err && (
            <p className="text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2 ring-1 ring-red-200">{err}</p>
          )}
          {ok && (
            <p className="text-sm text-emerald-700 bg-emerald-50 rounded-xl px-3 py-2 ring-1 ring-emerald-200">
              {ok}
            </p>
          )}
          <button
            onClick={registrar}
            disabled={enviando || !(parseFloat(monto) > 0)}
            className="rounded-2xl bg-gradient-to-br from-brand-500 to-emerald-600 text-white py-3.5 font-extrabold shadow-lg disabled:opacity-40 active:scale-[0.99] transition"
          >
            {enviando ? "Enviando…" : "Enviar abono"}
          </button>
        </section>

        {/* Comité: por aprobar */}
        {isAdmin && (
          <section className="mt-7">
            <h2 className="text-sm font-bold text-slate-700 mb-2">
              Abonos por aprobar <span className="text-slate-400 font-medium">({pend.length})</span>
            </h2>
            {pendErr && (
              <p className="text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2 ring-1 ring-red-200 mb-2">
                {pendErr}
              </p>
            )}
            {pend.length === 0 ? (
              <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
                No hay abonos pendientes 🎉
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {pend.map((t) => {
                  const montoOk = t.ocr_monto !== null && Math.abs(Number(t.ocr_monto) - t.monto) < 0.01;
                  return (
                    <li key={t.id} className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-semibold text-slate-800 truncate">
                            {money(t.monto)} · Casa {t.casa}
                          </p>
                          <p className="text-xs text-slate-500">
                            {t.concepto} · {fecha(t.created_at)}
                          </p>
                          <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                            {/* Palomita VERDE solo con match seguro; ámbar si es ambiguo */}
                            {t.en_banco && t.banco_fecha && t.match_por !== "monto_fecha_ambiguo" && (
                              <span className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">
                                ✓ encontrado en el banco ({fechaDia(t.banco_fecha)}
                                {t.match_por === "rastreo"
                                  ? " · por clave de rastreo"
                                  : t.match_por === "casa"
                                  ? " · el banco menciona la casa"
                                  : t.match_por === "aprendido"
                                  ? " · referencia aprendida"
                                  : " · único que cuadra por monto y fecha"})
                              </span>
                            )}
                            {t.en_banco && t.match_por === "monto_fecha_ambiguo" && (
                              <span className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 ring-1 ring-amber-200">
                                🟡 hay {t.candidatos ?? "varios"} pagos con este monto en esas fechas — al
                                aprobar NO se liga al banco; concílialo en Conciliación
                              </span>
                            )}
                            {/* Monto del comprobante (OCR) vs lo que capturó el vecino */}
                            {t.ocr_monto !== null &&
                              (montoOk ? (
                                <span className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">
                                  ✓ comprobante {money(Number(t.ocr_monto))}
                                </span>
                              ) : (
                                <span className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full bg-red-50 text-red-700 ring-1 ring-red-200">
                                  ⚠️ comprobante dice {money(Number(t.ocr_monto))}, capturó {money(t.monto)}
                                </span>
                              ))}
                            {/* Posible duplicado: ya hay un abono conciliado igual este mes */}
                            {t.casa && conc.has(claveConc(t.casa, t.monto, t.created_at)) && (
                              <span className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full bg-sky-50 text-sky-700 ring-1 ring-sky-200">
                                ⚠️ ya hay uno igual conciliado · revisa duplicado
                              </span>
                            )}
                          </div>
                          <div className="mt-1 flex items-center gap-3">
                            {t.comprobante_url && (
                              <a
                                href={t.comprobante_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-brand-600 font-semibold underline"
                              >
                                Ver comprobante
                              </a>
                            )}
                            {editId !== t.id && (
                              <button
                                onClick={() => {
                                  setEditId(t.id);
                                  // pre-llenar con el monto del comprobante si difiere
                                  setEditVal(String(!montoOk && t.ocr_monto !== null ? t.ocr_monto : t.monto));
                                }}
                                className="text-xs text-slate-500 font-semibold underline hover:text-slate-700"
                              >
                                ✏️ Corregir monto
                              </button>
                            )}
                            {linkId !== t.id && movsBanco.length > 0 && (
                              <button
                                onClick={() => {
                                  setLinkId(t.id);
                                  setLinkHash(candidatosBanco(t)[0]?.banco_hash ?? null);
                                  setLinkMotivo("");
                                }}
                                className="text-xs text-slate-500 font-semibold underline hover:text-slate-700"
                              >
                                🔗 Enlazar al banco
                              </button>
                            )}
                            {!t.aclaracion && (
                              <button
                                onClick={() => pedirDatos(t)}
                                disabled={resolviendo.has(t.id)}
                                className="text-xs text-slate-500 font-semibold underline hover:text-slate-700 disabled:opacity-40"
                                title="Le llega por Telegram y en su app: pide fecha/concepto del comprobante"
                              >
                                ✉️ Pedir datos
                              </button>
                            )}
                          </div>
                          {t.aclaracion && !t.aclaracion_respuesta && (
                            <p className="mt-1 text-[10px] font-semibold text-sky-700">
                              ✉️ Aclaración pedida al vecino — esperando respuesta
                            </p>
                          )}
                          {t.aclaracion_respuesta && (
                            <p className="mt-1 text-[11px] text-emerald-800 bg-emerald-50 ring-1 ring-emerald-200 rounded-lg px-2 py-1">
                              💬 Vecino respondió: {t.aclaracion_respuesta}
                            </p>
                          )}
                          {/* Enlace manual: elegir la fila del banco + motivo (aprendizaje) */}
                          {linkId === t.id && (
                            <div className="mt-2 rounded-xl bg-slate-50 ring-1 ring-slate-200 p-2">
                              {candidatosBanco(t).length === 0 ? (
                                <p className="text-[11px] text-slate-600">
                                  No hay movimientos del banco por {money(t.monto)} sin conciliar.
                                  Si el monto está mal, usa ✏️ Corregir monto primero.
                                </p>
                              ) : (
                                <>
                                  <p className="text-[11px] font-semibold text-slate-600 mb-1">
                                    ¿Cuál movimiento del banco es este pago?
                                  </p>
                                  <div className="flex flex-col gap-1 max-h-44 overflow-y-auto">
                                    {candidatosBanco(t).map((m) => (
                                      <label
                                        key={m.banco_hash}
                                        className={`flex items-start gap-2 rounded-lg px-2 py-1.5 cursor-pointer ring-1 ${
                                          linkHash === m.banco_hash
                                            ? "bg-brand-50 ring-brand-300"
                                            : "bg-white ring-slate-200"
                                        }`}
                                      >
                                        <input
                                          type="radio"
                                          name={`link-${t.id}`}
                                          checked={linkHash === m.banco_hash}
                                          onChange={() => setLinkHash(m.banco_hash)}
                                          className="mt-0.5 accent-brand-500"
                                        />
                                        <span className="min-w-0 text-[11px] text-slate-700">
                                          <span className="font-bold">{money(Number(m.monto))}</span> ·{" "}
                                          {fechaDia(m.fecha)}
                                          <span className="block text-slate-500 truncate" title={m.concepto}>
                                            {m.concepto}
                                          </span>
                                        </span>
                                      </label>
                                    ))}
                                  </div>
                                  <input
                                    value={linkMotivo}
                                    onChange={(e) => setLinkMotivo(e.target.value)}
                                    placeholder="¿Cómo lo identificaste? (opcional — ayuda a aprender)"
                                    className="mt-2 w-full rounded-lg ring-1 ring-slate-200 px-2 py-1.5 text-xs text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
                                  />
                                  <p className="mt-1 text-[10px] text-slate-400">
                                    Al enlazar, la referencia del banco se aprende para esta casa: el
                                    próximo mes saldrá con palomita solo.
                                  </p>
                                </>
                              )}
                              <div className="mt-2 flex items-center gap-2">
                                {candidatosBanco(t).length > 0 && (
                                  <button
                                    onClick={() => enlazar(t)}
                                    disabled={!linkHash || resolviendo.has(t.id)}
                                    className="rounded-lg bg-emerald-600 text-white text-xs font-semibold px-3 py-1.5 hover:opacity-90 disabled:opacity-40"
                                  >
                                    {resolviendo.has(t.id) ? "…" : "Enlazar y aprobar"}
                                  </button>
                                )}
                                <button
                                  onClick={() => {
                                    setLinkId(null);
                                    setLinkHash(null);
                                    setLinkMotivo("");
                                  }}
                                  className="rounded-lg bg-slate-100 text-slate-600 text-xs font-semibold px-3 py-1.5 hover:bg-slate-200"
                                >
                                  Cancelar
                                </button>
                              </div>
                            </div>
                          )}
                          {editId === t.id && (
                            <div className="mt-2 flex items-center gap-2">
                              <input
                                type="number"
                                inputMode="decimal"
                                value={editVal}
                                onChange={(e) => setEditVal(e.target.value)}
                                className="w-24 rounded-lg ring-1 ring-slate-200 px-2 py-1.5 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
                              />
                              <button
                                onClick={() => corregirMonto(t)}
                                className="rounded-lg bg-emerald-600 text-white text-xs font-semibold px-3 py-1.5 hover:opacity-90"
                              >
                                Guardar
                              </button>
                              <button
                                onClick={() => {
                                  setEditId(null);
                                  setEditVal("");
                                }}
                                className="rounded-lg bg-slate-100 text-slate-600 text-xs font-semibold px-3 py-1.5 hover:bg-slate-200"
                              >
                                Cancelar
                              </button>
                            </div>
                          )}
                        </div>
                        <div className="flex gap-2 shrink-0">
                          <button
                            onClick={() => resolver(t, true)}
                            disabled={resolviendo.has(t.id)}
                            className="rounded-xl bg-brand-500 text-white text-sm font-semibold px-3 py-2 hover:bg-brand-600 disabled:opacity-40"
                          >
                            {resolviendo.has(t.id) ? "…" : "Aprobar"}
                          </button>
                          <button
                            onClick={() => resolver(t, false)}
                            disabled={resolviendo.has(t.id)}
                            className="rounded-xl border border-slate-200 text-slate-500 text-sm font-semibold px-3 py-2 hover:bg-slate-50 disabled:opacity-40"
                          >
                            No
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {/* Comité: ingresos del banco aún sin conciliar (staging) */}
        {isAdmin && movsBanco.length > 0 && (
          <section className="mt-7">
            <h2 className="text-sm font-bold text-slate-700 mb-1">
              Banco: ingresos sin conciliar{" "}
              <span className="text-slate-400 font-medium">({movsBanco.length})</span>
            </h2>
            <p className="text-xs text-slate-500 mb-2">
              Filas del estado de cuenta que aún no se ligan a ninguna casa. Asígnalas en{" "}
              <button
                onClick={() => router.push("/dashboard/conciliacion")}
                className="underline font-semibold text-brand-600"
              >
                Conciliación
              </button>{" "}
              o descarta las que no son pagos de vecinos (traspasos, intereses…).
            </p>
            <ul className="flex flex-col gap-2">
              {movsBanco.map((m) => (
                <li
                  key={m.banco_hash}
                  className="bg-white rounded-2xl p-3 ring-1 ring-slate-100 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-800">
                      {money(m.monto)}{" "}
                      <span className="text-xs font-medium text-slate-500">
                        · {fechaDia(m.fecha)}
                      </span>
                    </p>
                    <p className="text-xs text-slate-500 truncate" title={m.concepto}>
                      {m.concepto}
                    </p>
                  </div>
                  <button
                    onClick={() => descartarBanco(m.banco_hash)}
                    onBlur={() => setDescartando((d) => (d === m.banco_hash ? null : d))}
                    className={`shrink-0 rounded-xl text-xs font-semibold px-3 py-2 transition ${
                      descartando === m.banco_hash
                        ? "bg-red-600 text-white"
                        : "border border-slate-200 text-slate-500 hover:bg-slate-50"
                    }`}
                  >
                    {descartando === m.banco_hash ? "¿Seguro? Descartar" : "Descartar"}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Mis movimientos */}
        <section className="mt-7">
          <h2 className="text-sm font-bold text-slate-700 mb-2">Mis movimientos</h2>
          {movs.length === 0 ? (
            <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
              Sin movimientos.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {movs.map((t) => {
                const esAbono = t.tipo === "abono";
                const pideAclaracion =
                  t.estado === "pendiente" && !!t.aclaracion_solicitud && !t.aclaracion_respuesta;
                return (
                  <li key={t.id} className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold text-slate-800 truncate">{t.concepto}</p>
                        <p className="text-xs text-slate-500">{fecha(t.created_at)}</p>
                        <span
                          className={`inline-block mt-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                            t.estado === "aprobado"
                              ? "bg-emerald-50 text-emerald-700"
                              : t.estado === "pendiente"
                              ? "bg-amber-50 text-amber-700"
                              : "bg-red-50 text-red-600"
                          }`}
                        >
                          {t.estado}
                        </span>
                      </div>
                      <p
                        className={`font-bold shrink-0 ${esAbono ? "text-emerald-600" : "text-slate-700"}`}
                      >
                        {esAbono ? "−" : "+"}
                        {money(t.monto)}
                      </p>
                    </div>

                    {/* El comité pidió datos de este comprobante → responder aquí */}
                    {pideAclaracion && (
                      <div className="mt-2 rounded-xl bg-sky-50 ring-1 ring-sky-200 p-2.5">
                        <p className="text-[11px] text-sky-900">📩 {t.aclaracion_solicitud}</p>
                        {respId === t.id ? (
                          <div className="mt-2 flex flex-col gap-2">
                            <label className="text-[11px] text-slate-600">
                              Fecha en que hiciste la transferencia
                              <input
                                type="date"
                                value={respFecha}
                                onChange={(e) => setRespFecha(e.target.value)}
                                className="mt-0.5 w-full rounded-lg ring-1 ring-slate-200 px-2 py-1.5 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-sky-300"
                              />
                            </label>
                            <input
                              value={respTexto}
                              onChange={(e) => setRespTexto(e.target.value)}
                              placeholder="Concepto que colocaste / comentarios"
                              className="w-full rounded-lg ring-1 ring-slate-200 px-2 py-1.5 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-sky-300"
                            />
                            {respMsg && <p className="text-[11px] text-red-600">{respMsg}</p>}
                            <div className="flex gap-2">
                              <button
                                onClick={() => responderAclaracion(t)}
                                className="rounded-lg bg-sky-600 text-white text-xs font-semibold px-3 py-1.5 hover:opacity-90"
                              >
                                Enviar respuesta
                              </button>
                              <button
                                onClick={() => {
                                  setRespId(null);
                                  setRespMsg(null);
                                }}
                                className="rounded-lg bg-slate-100 text-slate-600 text-xs font-semibold px-3 py-1.5 hover:bg-slate-200"
                              >
                                Cancelar
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            onClick={() => {
                              setRespId(t.id);
                              setRespFecha("");
                              setRespTexto("");
                              setRespMsg(null);
                            }}
                            className="mt-2 rounded-lg bg-sky-600 text-white text-xs font-semibold px-3 py-1.5 hover:opacity-90"
                          >
                            Responder
                          </button>
                        )}
                      </div>
                    )}
                    {t.aclaracion_respuesta && t.estado === "pendiente" && (
                      <p className="mt-2 text-[11px] text-emerald-800 bg-emerald-50 ring-1 ring-emerald-200 rounded-lg px-2 py-1">
                        ✓ Respondiste: {t.aclaracion_respuesta}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
