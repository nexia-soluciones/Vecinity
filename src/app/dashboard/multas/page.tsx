"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { callRpc } from "@/lib/rpc";
import { VerResolucionButton } from "../_components/VerResolucionButton";
import { generarResolucionOficial } from "../incidencias/resolucion-actions";

type Casa = { id: string; numero: string; saldo: number };
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
