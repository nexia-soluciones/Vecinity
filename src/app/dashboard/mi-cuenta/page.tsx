"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { generarReciboAbono } from "../recibo-actions";
import { VerResolucionButton } from "../_components/VerResolucionButton";

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

const money = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);
const fecha = (iso: string) =>
  new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });

const MOV_COLS = "id, tipo, monto, concepto, estado, comprobante_url, recibo_pdf_url, created_at";
const esMulta = (m: Mov) => m.tipo === "cargo" && /^multa\b/i.test(m.concepto);
const esAbonoAprobado = (m: Mov) => m.tipo === "abono" && m.estado === "aprobado";

export default function MiCuentaPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [casa, setCasa] = useState<Casa | null>(null);
  const [movs, setMovs] = useState<Mov[]>([]);
  const [detErr, setDetErr] = useState<string | null>(null);
  const [recibo, setRecibo] = useState<string | null>(null); // id del abono generando

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

  // Descarga el recibo foliado; si aún no existe, lo genera al vuelo.
  async function descargarRecibo(m: Mov) {
    if (m.recibo_pdf_url) {
      window.open(m.recibo_pdf_url, "_blank", "noopener");
      return;
    }
    setDetErr(null);
    setRecibo(m.id);
    const token = (await supabaseBrowser.auth.getSession()).data.session?.access_token ?? "";
    const res = await generarReciboAbono(token, m.id);
    setRecibo(null);
    if (!res.ok) return setDetErr(res.error);
    setMovs((l) => l.map((x) => (x.id === m.id ? { ...x, recibo_pdf_url: res.url } : x)));
    window.open(res.url, "_blank", "noopener");
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
                      {m.comprobante_url && (
                        <a
                          href={m.comprobante_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-1.5 inline-flex items-center gap-1 text-xs text-brand-600 font-semibold underline"
                        >
                          📎 Ver comprobante
                        </a>
                      )}
                      {esMulta(m) && (
                        <div className="mt-1.5">
                          <VerResolucionButton transactionId={m.id} />
                        </div>
                      )}
                      {esAbonoAprobado(m) && (
                        <button
                          onClick={() => descargarRecibo(m)}
                          disabled={recibo === m.id}
                          className="mt-1.5 inline-flex items-center gap-1 rounded-lg bg-brand-600 text-white text-xs font-semibold px-3 py-1.5 hover:bg-brand-700 disabled:opacity-40"
                        >
                          {recibo === m.id ? "Generando…" : "🧾 Descargar recibo"}
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
    </main>
  );
}
