"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";

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
type Casa = {
  id: string;
  numero: string;
  propietario: string | null;
  estatus: string | null;
  saldo: number;
};

const money = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);
const fecha = (iso: string) =>
  new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });

const MOV_COLS = "id, tipo, monto, concepto, estado, comprobante_url, recibo_pdf_url, created_at";

export default function EstadoCuentaPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [q, setQ] = useState("");
  const [casa, setCasa] = useState<Casa | null>(null);
  const [movs, setMovs] = useState<Mov[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [buscando, setBuscando] = useState(false);

  // Solo admin/comité
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

  async function cargarCasa(hid: string) {
    const { data: h } = await supabaseBrowser
      .from("houses")
      .select("id, numero, propietario, estatus, saldo")
      .eq("id", hid)
      .maybeSingle();
    const { data: t } = await supabaseBrowser
      .from("transactions")
      .select(MOV_COLS)
      .eq("house_id", hid)
      .order("created_at", { ascending: true });
    setCasa((h as unknown as Casa) ?? null);
    setMovs((t as unknown as Mov[]) ?? []);
  }

  async function buscar() {
    const numero = q.trim();
    setMsg(null);
    setCasa(null);
    setMovs([]);
    if (!numero) return;
    setBuscando(true);
    try {
      const { data } = await supabaseBrowser
        .from("houses")
        .select("id")
        .eq("numero", numero)
        .maybeSingle();
      const found = data as unknown as { id: string } | null;
      if (!found) {
        setMsg(`No se encontró la casa ${numero}.`);
        return;
      }
      await cargarCasa(found.id);
    } finally {
      setBuscando(false);
    }
  }

  async function resolver(id: string, aprobar: boolean) {
    await supabaseBrowser.rpc("resolver_transaccion", { p_id: id, p_aprobar: aprobar });
    if (casa) await cargarCasa(casa.id);
  }

  if (!ready)
    return (
      <main className="flex-1 flex items-center justify-center text-slate-400">Cargando…</main>
    );

  // Resumen + saldo corriente (solo los movimientos aprobados afectan el saldo)
  const totCargos = movs
    .filter((m) => m.tipo === "cargo" && m.estado === "aprobado")
    .reduce((s, m) => s + Number(m.monto), 0);
  const totAbonos = movs
    .filter((m) => m.tipo === "abono" && m.estado === "aprobado")
    .reduce((s, m) => s + Number(m.monto), 0);
  const pendientes = movs.filter((m) => m.estado === "pendiente");
  const rechazados = movs.filter((m) => m.estado === "rechazado");

  // Saldo corriente por fila: suma de los movimientos aprobados hasta esa fila (cargo +, abono −).
  // Se calcula en orden cronológico y luego se muestra al revés (lo más reciente primero).
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
      <div className="w-full max-w-3xl mx-auto px-5 py-6 flex flex-col">
        <div className="flex items-center justify-between">
          <button
            onClick={() => router.push("/dashboard")}
            className="text-sm text-slate-500 hover:text-slate-700"
          >
            ← Volver
          </button>
          <Image src="/brand/vecinity-logo.svg" alt="Vecinity" width={120} height={34} priority />
        </div>

        <h1 className="text-2xl font-bold text-slate-800 mt-4">Estado de cuenta por casa</h1>
        <p className="text-sm text-slate-500 mt-1">
          Busca una casa para ver su desglose de cargos y pagos.
        </p>

        {/* Buscar casa */}
        <div className="flex gap-2 mt-4">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && buscar()}
            placeholder="Número de casa (ej. 178)"
            inputMode="numeric"
            className="flex-1 rounded-xl ring-1 ring-slate-200 px-3 py-2.5 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
          />
          <button
            onClick={buscar}
            disabled={buscando}
            className="rounded-xl bg-slate-700 text-white font-semibold px-5 py-2.5 disabled:opacity-40"
          >
            {buscando ? "…" : "Buscar"}
          </button>
        </div>
        {msg && <p className="text-sm text-slate-500 mt-2">{msg}</p>}

        {casa && (
          <>
            {/* Encabezado de la casa */}
            <div
              className={`mt-4 rounded-3xl p-5 text-white shadow-lg ${
                casa.saldo > 0
                  ? "bg-gradient-to-br from-amber-500 to-orange-600"
                  : "bg-gradient-to-br from-brand-500 to-emerald-600"
              }`}
            >
              <p className="text-white/80 text-sm">
                Casa {casa.numero}
                {casa.propietario && casa.propietario !== "nan" ? ` · ${casa.propietario}` : ""}
              </p>
              <p className="text-3xl font-extrabold mt-1">{money(casa.saldo)}</p>
              <p className="text-white/90 text-sm mt-1">
                {casa.saldo > 0 ? "Saldo pendiente por pagar" : "Al corriente ✓"}
                {casa.estatus ? ` · ${casa.estatus.replace(/_/g, " ")}` : ""}
              </p>
            </div>

            {/* Resumen */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
              <div className="bg-white rounded-2xl ring-1 ring-slate-100 p-3">
                <p className="text-xs text-slate-400">Cargos</p>
                <p className="text-lg font-bold text-slate-700">{money(totCargos)}</p>
              </div>
              <div className="bg-white rounded-2xl ring-1 ring-slate-100 p-3">
                <p className="text-xs text-slate-400">Pagos aplicados</p>
                <p className="text-lg font-bold text-emerald-600">{money(totAbonos)}</p>
              </div>
              <div
                className={`rounded-2xl ring-1 p-3 ${
                  pendientes.length ? "bg-amber-50 ring-amber-200" : "bg-white ring-slate-100"
                }`}
              >
                <p className="text-xs text-slate-400">Pendientes</p>
                <p className="text-lg font-bold text-amber-600">{pendientes.length}</p>
              </div>
              <div
                className={`rounded-2xl ring-1 p-3 ${
                  rechazados.length ? "bg-red-50 ring-red-200" : "bg-white ring-slate-100"
                }`}
              >
                <p className="text-xs text-slate-400">Rechazados</p>
                <p className="text-lg font-bold text-red-600">{rechazados.length}</p>
              </div>
            </div>

            {(pendientes.length > 0 || rechazados.length > 0) && (
              <p className="text-sm text-amber-700 bg-amber-50 rounded-xl px-3 py-2 ring-1 ring-amber-200 mt-3">
                ⚠️ Esta casa tiene pagos pendientes o rechazados — suele ser la causa de que &ldquo;no
                le cuadre&rdquo; al vecino. Revísalos abajo.
              </p>
            )}

            {/* Movimientos */}
            <section className="mt-4">
              <h2 className="text-sm font-bold text-slate-700 mb-2">
                Movimientos <span className="text-slate-400 font-medium">({movs.length})</span>
              </h2>
              {movs.length === 0 ? (
                <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
                  Sin movimientos.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {filas.map(({ m, saldo }) => {
                    const esAbono = m.tipo === "abono";
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
                            {m.estado === "aprobado" ? ` · saldo ${money(saldo)}` : ""}
                          </p>
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            <span
                              className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                                m.estado === "aprobado"
                                  ? "bg-emerald-50 text-emerald-700"
                                  : m.estado === "pendiente"
                                  ? "bg-amber-50 text-amber-700"
                                  : "bg-red-50 text-red-600"
                              }`}
                            >
                              {m.estado}
                            </span>
                            {m.comprobante_url && (
                              <a
                                href={m.comprobante_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-brand-600 font-semibold underline"
                              >
                                Comprobante
                              </a>
                            )}
                            {m.recibo_pdf_url && (
                              <a
                                href={m.recibo_pdf_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-slate-500 font-semibold underline"
                              >
                                Recibo
                              </a>
                            )}
                          </div>
                          {esAbono && m.estado === "pendiente" && (
                            <div className="flex gap-2 mt-2">
                              <button
                                onClick={() => resolver(m.id, true)}
                                className="rounded-lg bg-brand-500 text-white text-xs font-semibold px-3 py-1.5 hover:bg-brand-600"
                              >
                                Aprobar
                              </button>
                              <button
                                onClick={() => resolver(m.id, false)}
                                className="rounded-lg border border-slate-200 text-slate-500 text-xs font-semibold px-3 py-1.5 hover:bg-slate-50"
                              >
                                Rechazar
                              </button>
                            </div>
                          )}
                        </div>
                        <p
                          className={`font-bold shrink-0 ${
                            esAbono ? "text-emerald-600" : "text-slate-700"
                          } ${m.estado !== "aprobado" ? "opacity-40 line-through" : ""}`}
                        >
                          {esAbono ? "−" : "+"}
                          {money(m.monto)}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
