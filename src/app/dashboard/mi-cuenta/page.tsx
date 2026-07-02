"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { callRpc } from "@/lib/rpc";

type Mov = {
  id: string;
  tipo: string;
  monto: number;
  concepto: string;
  estado: string;
  comprobante_url: string | null;
  recibo_pdf_url: string | null;
  created_at: string;
};
type Casa = { numero: string; saldo: number; estatus: string | null };

type Resolucion = {
  incident_id: string;
  categoria: string;
  estado: string;
  monto: number;
  descripcion: string | null;
  evidencia_url: string | null;
  evidencia_capturada_at: string | null;
  evidencia_lat: number | null;
  evidencia_lng: number | null;
  placa: string | null;
  created_at: string;
  resuelto_at: string | null;
  resolucion_oficial: string | null;
  articulo: string | null;
  articulo_titulo: string | null;
  articulo_texto: string | null;
  articulo_snapshot: string | null;
};

const money = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);
const fecha = (iso: string) =>
  new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
const fechaHora = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("es-MX", {
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

const MOV_COLS = "id, tipo, monto, concepto, estado, comprobante_url, recibo_pdf_url, created_at";
const esMulta = (m: Mov) => m.tipo === "cargo" && /^multa\b/i.test(m.concepto);

export default function MiCuentaPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [casa, setCasa] = useState<Casa | null>(null);
  const [movs, setMovs] = useState<Mov[]>([]);
  const [detalle, setDetalle] = useState<Resolucion | null>(null);
  const [cargandoDet, setCargandoDet] = useState<string | null>(null);
  const [detErr, setDetErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabaseBrowser.auth.getUser();
      if (!user) return router.replace("/login");
      const { data: prof } = await supabaseBrowser
        .from("profiles")
        .select("role, approval_status, house_id")
        .eq("id", user.id)
        .maybeSingle();
      const p = prof as unknown as {
        role: string;
        approval_status: string;
        house_id: string | null;
      } | null;
      if (!p || p.approval_status !== "aprobado") return router.replace("/esperando");
      if (p.role === "guardia") return router.replace("/vigilancia");
      if (!p.house_id) {
        setReady(true);
        return;
      }
      const { data: h } = await supabaseBrowser
        .from("houses")
        .select("numero, saldo, estatus")
        .eq("id", p.house_id)
        .maybeSingle();
      const { data: t } = await supabaseBrowser
        .from("transactions")
        .select(MOV_COLS)
        .eq("house_id", p.house_id)
        .order("created_at", { ascending: true });
      setCasa((h as unknown as Casa) ?? null);
      setMovs((t as unknown as Mov[]) ?? []);
      setReady(true);
    })();
  }, [router]);

  async function verResolucion(transactionId: string) {
    setDetErr(null);
    setCargandoDet(transactionId);
    const res = await callRpc<Resolucion>("ver_resolucion_multa", {
      p_transaction_id: transactionId,
    });
    setCargandoDet(null);
    if (!res.ok) return setDetErr(res.error);
    setDetalle(res.data);
  }

  if (!ready)
    return (
      <main className="flex-1 flex items-center justify-center text-slate-400">Cargando…</main>
    );

  const conAdeudo = (casa?.saldo ?? 0) > 0;

  // Saldo corriente por fila (solo movimientos aprobados afectan el saldo).
  const filas = movs
    .map((m, i) => {
      const saldo = movs
        .slice(0, i + 1)
        .filter((x) => x.estado === "aprobado")
        .reduce((s, x) => s + (x.tipo === "cargo" ? Number(x.monto) : -Number(x.monto)), 0);
      return { m, saldo };
    })
    .reverse();

  return (
    <main className="flex-1 bg-gradient-to-b from-brand-50 via-white to-sky-50">
      <div className="w-full max-w-2xl mx-auto px-5 py-6 flex flex-col">
        <div className="flex items-center justify-between">
          <button
            onClick={() => router.push("/dashboard")}
            className="text-sm text-slate-500 hover:text-slate-700"
          >
            ← Volver
          </button>
          <Image src="/brand/vecinity-logo.svg" alt="Vecinity" width={120} height={34} priority />
        </div>

        <h1 className="text-2xl font-bold text-slate-800 mt-4">Mi estado de cuenta</h1>

        {casa && (
          <div
            className={`mt-3 rounded-3xl p-5 text-white shadow-lg ${
              conAdeudo
                ? "bg-gradient-to-br from-amber-500 to-orange-600"
                : "bg-gradient-to-br from-brand-500 to-emerald-600"
            }`}
          >
            <p className="text-white/80 text-sm">Casa {casa.numero}</p>
            <p className="text-3xl font-extrabold mt-1">{money(casa.saldo)}</p>
            <p className="text-white/90 text-sm mt-1">
              {conAdeudo ? "Saldo pendiente por pagar" : "Estás al corriente ✓"}
            </p>
          </div>
        )}

        <section className="mt-4">
          <h2 className="text-sm font-bold text-slate-700 mb-2">
            Movimientos <span className="text-slate-400 font-medium">({movs.length})</span>
          </h2>
          {detErr && (
            <p className="text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2 ring-1 ring-red-200 mb-2">
              {detErr}
            </p>
          )}
          {movs.length === 0 ? (
            <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
              Sin movimientos.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {filas.map(({ m, saldo }) => {
                const abono = m.tipo === "abono";
                return (
                  <li
                    key={m.id}
                    className={`bg-white rounded-2xl p-3.5 ring-1 flex items-center justify-between gap-3 ${
                      m.estado === "rechazado"
                        ? "ring-red-200"
                        : m.estado === "pendiente"
                        ? "ring-amber-200"
                        : "ring-slate-100"
                    }`}
                  >
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-800 truncate">{m.concepto}</p>
                      <p className="text-xs text-slate-500">
                        {fecha(m.created_at)}
                        {m.estado === "aprobado" ? ` · saldo ${money(saldo)}` : ` · ${m.estado}`}
                      </p>
                      {esMulta(m) && (
                        <button
                          onClick={() => verResolucion(m.id)}
                          disabled={cargandoDet === m.id}
                          className="mt-1.5 inline-flex items-center gap-1 rounded-lg bg-slate-700 text-white text-xs font-semibold px-3 py-1.5 hover:bg-slate-800 disabled:opacity-40"
                        >
                          {cargandoDet === m.id ? "Abriendo…" : "📄 Ver resolución"}
                        </button>
                      )}
                    </div>
                    <p
                      className={`font-bold shrink-0 ${
                        abono ? "text-emerald-600" : "text-slate-700"
                      } ${m.estado !== "aprobado" ? "opacity-40 line-through" : ""}`}
                    >
                      {abono ? "−" : "+"}
                      {money(m.monto)}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      {detalle && (
        <ResolucionModal r={detalle} onClose={() => setDetalle(null)} />
      )}
    </main>
  );
}

function ResolucionModal({ r, onClose }: { r: Resolucion; onClose: () => void }) {
  const mapsUrl =
    r.evidencia_lat != null && r.evidencia_lng != null
      ? `https://maps.google.com/?q=${r.evidencia_lat},${r.evidencia_lng}`
      : null;
  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-white w-full sm:max-w-lg sm:rounded-3xl rounded-t-3xl max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white/95 backdrop-blur px-5 py-3 flex items-center justify-between border-b border-slate-100">
          <h3 className="font-bold text-slate-800">Resolución oficial</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl">
            ✕
          </button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-4">
          <div className="rounded-2xl bg-slate-50 ring-1 ring-slate-100 p-4">
            <p className="text-lg font-bold text-slate-800">{r.categoria}</p>
            <p className="text-2xl font-extrabold text-amber-600 mt-1">{money(r.monto)}</p>
            <p className="text-xs text-slate-500 mt-1">
              Evidencia registrada: {fechaHora(r.evidencia_capturada_at ?? r.created_at)}
            </p>
            {r.placa && (
              <p className="text-xs text-slate-500">
                Placa detectada: <span className="font-semibold">{r.placa}</span>
              </p>
            )}
          </div>

          {/* Evidencia */}
          {r.evidencia_url && (
            <div>
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-1.5">
                Evidencia
              </p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={r.evidencia_url}
                alt="Evidencia de la infracción"
                className="w-full rounded-2xl ring-1 ring-slate-200 object-contain max-h-80 bg-slate-100"
              />
              <div className="flex gap-3 mt-1.5">
                <a
                  href={r.evidencia_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-brand-600 font-semibold underline"
                >
                  Ver foto completa
                </a>
                {mapsUrl && (
                  <a
                    href={mapsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-brand-600 font-semibold underline"
                  >
                    Ubicación en el mapa
                  </a>
                )}
              </div>
            </div>
          )}

          {/* Artículo del reglamento */}
          {r.articulo && (
            <div>
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-1.5">
                Fundamento — Reglamento interno
              </p>
              <div className="rounded-2xl bg-brand-50 ring-1 ring-brand-100 p-4">
                <p className="font-bold text-slate-800">
                  {r.articulo}
                  {r.articulo_titulo ? ` · ${r.articulo_titulo}` : ""}
                </p>
                {r.articulo_texto && (
                  <p className="text-sm text-slate-600 mt-1.5 leading-relaxed">
                    {r.articulo_texto}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Resolución oficial (IA) */}
          {r.resolucion_oficial ? (
            <div>
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-1.5">
                Resolución del Comité
              </p>
              <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed bg-white ring-1 ring-slate-100 rounded-2xl p-4">
                {r.resolucion_oficial}
              </p>
            </div>
          ) : (
            <p className="text-xs text-slate-400">
              La resolución formal se está preparando. El fundamento y la evidencia ya están
              disponibles arriba.
            </p>
          )}

          <p className="text-[11px] text-slate-400 leading-relaxed">
            Si consideras que esta multa es un error o deseas solicitar aclaración o condonación,
            contacta al Comité de Administración.
          </p>
        </div>
      </div>
    </div>
  );
}
