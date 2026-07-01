"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
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
};
type Pend = Mov & { house: { numero: string } | null };

const money = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);
const fecha = (iso: string) =>
  new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });

const BUCKET = "vecino-comprobantes";
const MOV_COLS = "id, tipo, monto, concepto, estado, comprobante_url, created_at";

export default function PagosPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [houseId, setHouseId] = useState<string | null>(null);
  const [coloniaId, setColoniaId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [saldo, setSaldo] = useState(0);
  const [casaNum, setCasaNum] = useState<string | null>(null);

  const [monto, setMonto] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const [movs, setMovs] = useState<Mov[]>([]);
  const [pend, setPend] = useState<Pend[]>([]);
  const [resolviendo, setResolviendo] = useState<Set<string>>(new Set());
  const [pendErr, setPendErr] = useState<string | null>(null);

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
    const { data } = await supabaseBrowser
      .from("transactions")
      .select(`${MOV_COLS}, house:houses(numero)`)
      .eq("estado", "pendiente")
      .order("created_at");
    setPend((data as unknown as Pend[]) ?? []);
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
      setHouseId(p.house_id);
      setColoniaId(p.colonia_id);
      const admin = p.role === "admin" || p.role === "comite";
      setIsAdmin(admin);
      if (p.house_id) {
        await cargarSaldo(p.house_id);
        await cargarMovs(p.house_id);
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
      });
      if (error) throw new Error(error.message.replace(/^.*?:\s/, ""));
      // OCR del comprobante (best-effort): extrae la clave de rastreo para que el
      // banco lo concilie solo. No bloquea ni falla el abono si el OCR no jala.
      const nuevoId = (abData as { id?: string } | null)?.id;
      if (nuevoId && url) {
        try {
          const { data: sess } = await supabaseBrowser.auth.getSession();
          const token = sess.session?.access_token;
          if (token) {
            const oc = await leerComprobante(token, url);
            if (oc.ok) {
              const ref = oc.data.clave_rastreo || oc.data.folio || null;
              await supabaseBrowser.rpc("set_abono_ocr", {
                p_id: nuevoId,
                p_ocr: oc.data,
                p_ref: ref,
              });
            }
          }
        } catch {
          /* el OCR es opcional; el abono ya quedó registrado */
        }
      }
      setOk("Abono enviado. El comité lo revisará.");
      setMonto("");
      setFile(null);
      if (houseId) await cargarMovs(houseId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error al registrar el abono.");
    } finally {
      setEnviando(false);
    }
  }

  async function resolver(id: string, aprobar: boolean) {
    if (resolviendo.has(id)) return; // evita doble-tap
    setPendErr(null);
    setResolviendo((s) => new Set(s).add(id));
    const res = await callRpc("resolver_transaccion", { p_id: id, p_aprobar: aprobar });
    if (!res.ok) {
      setPendErr(res.error);
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
            disabled={enviando}
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
                {pend.map((t) => (
                  <li key={t.id} className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold text-slate-800 truncate">
                          {money(t.monto)} · Casa {t.house?.numero}
                        </p>
                        <p className="text-xs text-slate-500">
                          {t.concepto} · {fecha(t.created_at)}
                        </p>
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
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <button
                          onClick={() => resolver(t.id, true)}
                          disabled={resolviendo.has(t.id)}
                          className="rounded-xl bg-brand-500 text-white text-sm font-semibold px-3 py-2 hover:bg-brand-600 disabled:opacity-40"
                        >
                          {resolviendo.has(t.id) ? "…" : "Aprobar"}
                        </button>
                        <button
                          onClick={() => resolver(t.id, false)}
                          disabled={resolviendo.has(t.id)}
                          className="rounded-xl border border-slate-200 text-slate-500 text-sm font-semibold px-3 py-2 hover:bg-slate-50 disabled:opacity-40"
                        >
                          No
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
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
                return (
                  <li
                    key={t.id}
                    className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100 flex items-center justify-between gap-2"
                  >
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
