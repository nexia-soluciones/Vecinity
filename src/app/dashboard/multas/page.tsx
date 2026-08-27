"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { callRpc } from "@/lib/rpc";
import { VerResolucionButton } from "../_components/VerResolucionButton";
import { generarResolucionOficial } from "../incidencias/resolucion-actions";

type Casa = { id: string; numero: string; saldo: number };
type Categoria = { id: string; nombre: string; monto_base: number };
type Multa = {
  id: string;
  descripcion: string | null;
  evidencia_url: string | null;
  estado: string;
  monto_multa: number;
  transaction_id: string | null;
  resolucion_admin: string | null;
  created_at: string;
  resolved_at: string | null;
  categoria: { nombre: string } | null;
  reportante: { numero: string } | null;
};

const money = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);
const fecha = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" })
    : "—";

const MULTA_COLS =
  "id, descripcion, evidencia_url, estado, monto_multa, transaction_id, resolucion_admin, created_at, resolved_at, " +
  "categoria:fine_categories(nombre), reportante:houses!reportante_house_id(numero)";

export default function MultasPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [num, setNum] = useState("");
  const [casa, setCasa] = useState<Casa | null>(null);
  const [multas, setMultas] = useState<Multa[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [verHistorial, setVerHistorial] = useState(false);
  const [categorias, setCategorias] = useState<Categoria[]>([]);

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabaseBrowser.auth.getUser();
      if (!user) return router.replace("/login");
      const { data: prof } = await supabaseBrowser
        .from("profiles")
        .select("role, approval_status, colonia_id")
        .eq("id", user.id)
        .maybeSingle();
      const p = prof as unknown as {
        role: string;
        approval_status: string;
        colonia_id: string | null;
      } | null;
      if (!p || p.approval_status !== "aprobado") return router.replace("/esperando");
      if (p.role !== "admin" && p.role !== "comite") return router.replace("/dashboard");
      // El filtro por colonia va explícito: si el perfil no trae colonia, la
      // lista sale VACÍA en vez de mostrar el catálogo de otra villa.
      const { data: cats } = await supabaseBrowser
        .from("fine_categories")
        .select("id, nombre, monto_base")
        .eq("colonia_id", p.colonia_id ?? "00000000-0000-0000-0000-000000000000")
        .order("nombre");
      setCategorias((cats as unknown as Categoria[]) ?? []);
      setReady(true);
    })();
  }, [router]);

  const cargarMultas = useCallback(async (houseId: string) => {
    const { data: h } = await supabaseBrowser
      .from("houses")
      .select("id, numero, saldo")
      .eq("id", houseId)
      .maybeSingle();
    const { data: m } = await supabaseBrowser
      .from("incident_reports")
      .select(MULTA_COLS)
      .eq("infractor_house_id", houseId)
      .order("created_at", { ascending: false });
    setCasa((h as unknown as Casa) ?? null);
    setMultas((m as unknown as Multa[]) ?? []);
  }, []);

  async function buscar() {
    setMsg(null);
    setCasa(null);
    setMultas([]);
    const n = num.trim();
    if (!n) return setMsg("Escribe el número de casa.");
    setBuscando(true);
    try {
      const { data: h } = await supabaseBrowser
        .from("houses")
        .select("id, numero, saldo")
        .eq("numero", n)
        .maybeSingle();
      const house = h as unknown as Casa | null;
      if (!house) return setMsg(`No encontré la casa ${n}.`);
      await cargarMultas(house.id);
    } finally {
      setBuscando(false);
    }
  }

  const activas = multas.filter((m) => m.estado === "multa");
  const historial = multas.filter((m) => m.estado !== "multa");

  if (!ready)
    return (
      <main className="flex-1 flex items-center justify-center text-slate-400">Cargando…</main>
    );

  return (
    <main className="flex-1 bg-gradient-to-b from-brand-50 via-white to-sky-50">
      <div className="w-full max-w-2xl mx-auto px-5 py-6 flex flex-col">
        <div className="flex items-center justify-between">
          <button
            onClick={() => router.push("/dashboard/comite")}
            className="text-sm text-slate-500 hover:text-slate-700"
          >
            ← Volver
          </button>
          <Image src="/brand/vecinity-logo.svg" alt="Vecinity" width={120} height={34} priority />
        </div>

        <h1 className="text-2xl font-bold text-slate-800 mt-4">Multas por casa</h1>
        <p className="text-sm text-slate-500 mt-1">
          Busca una casa para revisar sus multas, corregir montos o cancelar duplicadas.
        </p>

        <div className="mt-4 flex gap-2">
          <input
            value={num}
            onChange={(e) => setNum(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && buscar()}
            placeholder="Número de casa"
            inputMode="numeric"
            className="flex-1 rounded-xl ring-1 ring-slate-200 px-3 py-2.5 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300 bg-white"
          />
          <button
            onClick={buscar}
            disabled={buscando}
            className="press rounded-xl bg-brand-500 text-white text-sm font-semibold px-5 py-2.5 hover:bg-brand-600 disabled:opacity-40"
          >
            {buscando ? "Buscando…" : "Buscar"}
          </button>
        </div>

        {msg && (
          <p className="text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2 ring-1 ring-red-200 mt-3">
            {msg}
          </p>
        )}

        {casa && (
          <>
            <div className="mt-4 rounded-2xl bg-white ring-1 ring-slate-100 p-4 flex items-center justify-between">
              <div>
                <p className="font-bold text-slate-800">Casa {casa.numero}</p>
                <p className="text-xs text-slate-500">
                  {Number(casa.saldo) > 0
                    ? `Adeudo: ${money(Number(casa.saldo))}`
                    : Number(casa.saldo) < 0
                    ? `Saldo a favor: ${money(-Number(casa.saldo))}`
                    : "Al corriente"}
                </p>
              </div>
              <span className="text-xs font-semibold text-slate-500 bg-slate-50 rounded-full px-3 py-1">
                {activas.length} multa{activas.length === 1 ? "" : "s"} activa
                {activas.length === 1 ? "" : "s"}
              </span>
            </div>

            <LevantarMulta
              casa={casa}
              categorias={categorias}
              onDone={() => cargarMultas(casa.id)}
            />

            <section className="mt-4">
              <h2 className="text-sm font-bold text-slate-700 mb-2">Multas activas</h2>
              {activas.length === 0 ? (
                <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
                  Esta casa no tiene multas activas.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {activas.map((m) => (
                    <MultaItem
                      key={m.id}
                      m={m}
                      onDone={() => cargarMultas(casa.id)}
                    />
                  ))}
                </ul>
              )}
            </section>

            {historial.length > 0 && (
              <section className="mt-5 mb-4">
                <button
                  onClick={() => setVerHistorial((v) => !v)}
                  className="text-sm font-bold text-slate-700 mb-2"
                >
                  Historial (rechazadas / canceladas / otras) · {historial.length}{" "}
                  <span className="text-brand-600 font-semibold">
                    {verHistorial ? "ocultar" : "ver"}
                  </span>
                </button>
                {verHistorial && (
                  <ul className="flex flex-col gap-2">
                    {historial.map((m) => (
                      <li key={m.id} className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100 opacity-75">
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-semibold text-slate-700 text-sm truncate">
                            {m.categoria?.nombre ?? "Incidencia"}
                          </p>
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 shrink-0">
                            {m.estado}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 mt-1">
                          {fecha(m.created_at)}
                          {m.reportante?.numero ? ` · reportó casa ${m.reportante.numero}` : ""}
                        </p>
                        {m.descripcion && (
                          <p className="text-xs text-slate-500 mt-1 line-clamp-2">{m.descripcion}</p>
                        )}
                        {m.resolucion_admin && (
                          <p className="text-xs text-slate-400 mt-1 italic">{m.resolucion_admin}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}

// Levantar una multa que el comité vio con sus propios ojos, sin esperar a que
// alguien la reporte. Antes esto no existía y la única salida era escribir en la
// BD a mano: sin categoría, sin tope, sin resolución oficial y sin rastro.
// La RPC levantar_multa delega en reportar_incidencia + resolver_incidencia, o
// sea que el cargo y el tope los sigue calculando un solo lugar.
function LevantarMulta({
  casa,
  categorias,
  onDone,
}: {
  casa: Casa;
  categorias: Categoria[];
  onDone: () => Promise<void>;
}) {
  const [abierto, setAbierto] = useState(false);
  const [catId, setCatId] = useState("");
  const [monto, setMonto] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [nota, setNota] = useState("");
  const [sug, setSug] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Al elegir la categoría, el monto se pre-llena con lo que sugiere la BD
  // (base × reincidencias, topado). Es sugerencia: el comité lo puede cambiar.
  async function elegirCategoria(id: string) {
    setCatId(id);
    setErr(null);
    setSug(null);
    if (!id) return setMonto("");
    const base = categorias.find((c) => c.id === id)?.monto_base;
    setMonto(base != null ? String(base) : "");
    const res = await callRpc<{
      monto_sugerido: number | null;
      reincidencias: number | null;
      tope: number | null;
    }>("sugerir_multa", { p_infractor: casa.id, p_categoria: id });
    if (!res.ok || !res.data) return;
    const d = res.data;
    if (d.monto_sugerido != null) setMonto(String(d.monto_sugerido));
    const r = Number(d.reincidencias ?? 0);
    setSug(
      r > 0
        ? `Sugerido ${money(Number(d.monto_sugerido))} — es la reincidencia n.º ${r + 1} de esta casa en esta falta.`
        : `Sugerido ${money(Number(d.monto_sugerido))} — primera vez de esta casa en esta falta.`
    );
  }

  async function levantar() {
    if (busy) return; // evita doble-tap
    setErr(null);
    if (!catId) return setErr("Elige la categoría de la falta.");
    const n = parseFloat(monto);
    if (!Number.isFinite(n) || n <= 0) return setErr("El monto debe ser mayor a 0.");
    if (!descripcion.trim())
      return setErr("Escribe qué pasó: la multa se le va a cobrar a la casa y tiene que poder explicarse.");
    setBusy(true);
    const res = await callRpc<{ id: string }>("levantar_multa", {
      p_infractor: casa.id,
      p_categoria: catId,
      p_monto: n,
      p_descripcion: descripcion.trim(),
      p_nota: nota.trim() || null,
    });
    if (!res.ok) {
      setBusy(false);
      return setErr(res.error);
    }
    // La resolución oficial se genera igual que en las multas resueltas desde
    // incidencias; si falla, la multa ya quedó bien y se puede regenerar.
    try {
      const token = (await supabaseBrowser.auth.getSession()).data.session?.access_token ?? "";
      if (res.data?.id) await generarResolucionOficial(token, res.data.id);
    } catch {
      /* best-effort */
    }
    await onDone();
    setBusy(false);
    setAbierto(false);
    setCatId("");
    setMonto("");
    setDescripcion("");
    setNota("");
    setSug(null);
  }

  if (categorias.length === 0) {
    return (
      <p className="mt-4 text-xs text-slate-500 bg-amber-50 rounded-2xl px-3 py-2.5 ring-1 ring-amber-200">
        Esta villa no tiene categorías de falta capturadas, así que todavía no se puede levantar una
        multa. Captúralas primero en el catálogo de faltas.
      </p>
    );
  }

  return (
    <section className="mt-4">
      {!abierto ? (
        <button
          onClick={() => setAbierto(true)}
          className="press w-full rounded-2xl bg-white ring-1 ring-amber-200 px-4 py-3 text-sm font-semibold text-amber-700 hover:bg-amber-50 text-left"
        >
          ➕ Levantar una multa a la casa {casa.numero}
        </button>
      ) : (
        <div className="rounded-2xl bg-white ring-1 ring-amber-200 p-4 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-slate-800">
              Nueva multa · casa {casa.numero}
            </h2>
            <button
              onClick={() => {
                setAbierto(false);
                setErr(null);
              }}
              className="text-xs text-slate-400 hover:text-slate-600"
            >
              cerrar
            </button>
          </div>

          <select
            value={catId}
            onChange={(e) => elegirCategoria(e.target.value)}
            className="rounded-xl ring-1 ring-slate-200 px-3 py-2.5 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300 bg-white"
          >
            <option value="">Categoría de la falta…</option>
            {categorias.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nombre} · {money(Number(c.monto_base))}
              </option>
            ))}
          </select>

          <textarea
            value={descripcion}
            onChange={(e) => setDescripcion(e.target.value)}
            rows={2}
            placeholder="Qué pasó, cuándo y dónde (obligatorio)"
            className="rounded-xl ring-1 ring-slate-200 px-3 py-2.5 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300 bg-white resize-none"
          />

          <div className="flex gap-2">
            <input
              value={monto}
              onChange={(e) => setMonto(e.target.value)}
              type="number"
              min="1"
              placeholder="Monto"
              className="w-32 rounded-xl ring-1 ring-slate-200 px-3 py-2.5 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300 bg-white"
            />
            <input
              value={nota}
              onChange={(e) => setNota(e.target.value)}
              placeholder="Nota del comité (opcional)"
              className="flex-1 rounded-xl ring-1 ring-slate-200 px-3 py-2.5 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300 bg-white"
            />
          </div>

          {sug && <p className="text-[11px] text-slate-500">{sug}</p>}
          {err && <p className="text-xs text-red-600">{err}</p>}

          <button
            onClick={levantar}
            disabled={busy}
            className="press rounded-xl bg-amber-600 text-white text-sm font-semibold py-2.5 hover:bg-amber-700 disabled:opacity-40"
          >
            {busy ? "Aplicando…" : `Multar con ${money(parseFloat(monto) || 0)}`}
          </button>
          <p className="text-[11px] text-slate-400">
            Se crea el expediente y el cargo en un solo acto: el saldo de la casa sube{" "}
            {money(parseFloat(monto) || 0)} y el vecino puede ver la resolución con el motivo.
          </p>
        </div>
      )}
    </section>
  );
}

function MultaItem({ m, onDone }: { m: Multa; onDone: () => Promise<void> }) {
  const [modo, setModo] = useState<"" | "corregir" | "cancelar">("");
  const [monto, setMonto] = useState(String(m.monto_multa));
  const [nota, setNota] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function corregir() {
    if (busy) return; // evita doble-tap
    setErr(null);
    const nuevo = parseFloat(monto);
    if (!Number.isFinite(nuevo) || nuevo <= 0)
      return setErr("El monto debe ser mayor a 0. Para eliminarla usa Cancelar.");
    setBusy(true);
    const res = await callRpc("corregir_multa", {
      p_incident_id: m.id,
      p_nuevo_monto: nuevo,
      p_nota: nota.trim() || null,
    });
    if (!res.ok) {
      setBusy(false);
      return setErr(res.error);
    }
    await regen();
    await onDone();
    setBusy(false);
    setModo("");
    setNota("");
  }

  // La resolución oficial citaba el monto viejo — se regenera con el nuevo.
  async function regen() {
    try {
      const token = (await supabaseBrowser.auth.getSession()).data.session?.access_token ?? "";
      await generarResolucionOficial(token, m.id);
    } catch {
      /* best-effort */
    }
  }

  async function cancelar() {
    if (busy) return; // evita doble-tap
    setErr(null);
    if (!nota.trim()) return setErr("Escribe el motivo de la cancelación.");
    setBusy(true);
    const res = await callRpc("cancelar_multa", {
      p_incident_id: m.id,
      p_nota: nota.trim(),
    });
    setBusy(false);
    if (!res.ok) return setErr(res.error);
    await onDone();
  }

  return (
    <li className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-slate-800 truncate">
            {m.categoria?.nombre ?? "Incidencia"}
          </p>
          <p className="text-xs text-slate-500 mt-0.5">
            {fecha(m.created_at)}
            {m.reportante?.numero ? ` · reportó casa ${m.reportante.numero}` : ""}
          </p>
          {m.descripcion && <p className="text-xs text-slate-600 mt-1">{m.descripcion}</p>}
        </div>
        <p className="font-bold text-amber-600 shrink-0">{money(Number(m.monto_multa))}</p>
      </div>

      <div className="flex items-center gap-2 mt-2 flex-wrap">
        {m.evidencia_url && (
          <a
            href={m.evidencia_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-brand-600 font-semibold underline"
          >
            Ver evidencia
          </a>
        )}
        {m.transaction_id && (
          <VerResolucionButton
            transactionId={m.transaction_id}
            className="text-xs text-slate-500 font-semibold underline"
          />
        )}
        <span className="flex-1" />
        <button
          onClick={() => {
            setModo(modo === "corregir" ? "" : "corregir");
            setErr(null);
            setMonto(String(m.monto_multa));
          }}
          className="press-soft rounded-lg border border-slate-200 text-slate-600 text-xs font-semibold px-3 py-1.5 hover:bg-slate-50"
        >
          ✏️ Corregir monto
        </button>
        <button
          onClick={() => {
            setModo(modo === "cancelar" ? "" : "cancelar");
            setErr(null);
          }}
          className="rounded-lg border border-red-200 text-red-600 text-xs font-semibold px-3 py-1.5 hover:bg-red-50"
        >
          Cancelar multa
        </button>
      </div>

      {modo === "corregir" && (
        <div className="mt-2 rounded-xl bg-slate-50 ring-1 ring-slate-100 p-3 flex flex-col gap-2">
          <div className="flex gap-2">
            <input
              value={monto}
              onChange={(e) => setMonto(e.target.value)}
              type="number"
              min="1"
              placeholder="Nuevo monto"
              className="w-32 rounded-xl ring-1 ring-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300 bg-white"
            />
            <input
              value={nota}
              onChange={(e) => setNota(e.target.value)}
              placeholder="Nota (opcional)"
              className="flex-1 rounded-xl ring-1 ring-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300 bg-white"
            />
          </div>
          <button
            onClick={corregir}
            disabled={busy}
            className="press rounded-xl bg-brand-500 text-white text-sm font-semibold py-2 hover:bg-brand-600 disabled:opacity-40"
          >
            {busy ? "Aplicando…" : `Corregir a ${money(parseFloat(monto) || 0)}`}
          </button>
          <p className="text-[11px] text-slate-400">
            El cargo y el saldo de la casa se ajustan por la diferencia.
          </p>
        </div>
      )}

      {modo === "cancelar" && (
        <div className="mt-2 rounded-xl bg-red-50 ring-1 ring-red-100 p-3 flex flex-col gap-2">
          <input
            value={nota}
            onChange={(e) => setNota(e.target.value)}
            placeholder="Motivo de la cancelación (obligatorio)"
            className="rounded-xl ring-1 ring-red-200 px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-red-300 bg-white"
          />
          <button
            onClick={cancelar}
            disabled={busy}
            className="press rounded-xl bg-red-600 text-white text-sm font-semibold py-2 hover:bg-red-700 disabled:opacity-40"
          >
            {busy ? "Cancelando…" : `Cancelar multa de ${money(Number(m.monto_multa))}`}
          </button>
          <p className="text-[11px] text-red-500">
            El cargo se marca rechazado y el monto se descuenta del saldo de la casa. El vecino verá
            la cancelación y el motivo en su resolución.
          </p>
        </div>
      )}

      {err && <p className="text-xs text-red-600 mt-2">{err}</p>}
    </li>
  );
}
