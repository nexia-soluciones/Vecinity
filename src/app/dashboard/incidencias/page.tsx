"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";

type Cat = { id: string; nombre: string; monto_base: number };
type Reporte = {
  id: string;
  descripcion: string | null;
  evidencia_url: string | null;
  estado: string;
  monto_multa: number;
  created_at: string;
  infractor: { numero: string } | null;
  categoria: { nombre: string; monto_base: number } | null;
  reportante: { numero: string } | null;
};

const money = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);
const fecha = (iso: string) =>
  new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "short" });

const REP_COLS =
  "id, descripcion, evidencia_url, estado, monto_multa, created_at, " +
  "infractor:houses!infractor_house_id(numero), categoria:fine_categories(nombre, monto_base), " +
  "reportante:houses!reportante_house_id(numero)";
const BUCKET = "vecino-evidencias";

export default function IncidenciasPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [houseId, setHouseId] = useState<string | null>(null);
  const [coloniaId, setColoniaId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [cats, setCats] = useState<Cat[]>([]);

  // form
  const [catId, setCatId] = useState("");
  const [casaNum, setCasaNum] = useState("");
  const [placa, setPlaca] = useState("");
  const [desc, setDesc] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [resuelta, setResuelta] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const [mios, setMios] = useState<Reporte[]>([]);
  const [pend, setPend] = useState<Reporte[]>([]);
  const [pendTotal, setPendTotal] = useState(0);

  const cargarMios = useCallback(async (hid: string) => {
    const { data } = await supabaseBrowser
      .from("incident_reports")
      .select(REP_COLS)
      .eq("reportante_house_id", hid)
      .order("created_at", { ascending: false })
      .limit(30);
    setMios((data as unknown as Reporte[]) ?? []);
  }, []);

  const cargarPend = useCallback(async () => {
    const { data, count } = await supabaseBrowser
      .from("incident_reports")
      .select(REP_COLS, { count: "exact" })
      .eq("estado", "pendiente")
      .order("created_at", { ascending: false })
      .limit(50);
    setPend((data as unknown as Reporte[]) ?? []);
    setPendTotal(count ?? 0);
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
      const { data: c } = await supabaseBrowser
        .from("fine_categories")
        .select("id, nombre, monto_base")
        .order("nombre");
      setCats((c as unknown as Cat[]) ?? []);
      if (p.house_id) await cargarMios(p.house_id);
      if (admin) await cargarPend();
      setReady(true);
    })();
  }, [router, cargarMios, cargarPend]);

  // resolver casa infractora por placa o número
  async function resolverInfractor(): Promise<{ id: string; numero: string } | null> {
    if (placa.trim()) {
      const { data } = await supabaseBrowser
        .from("vehicles")
        .select("house:houses(id, numero)")
        .ilike("placa", `%${placa.trim().toUpperCase()}%`)
        .limit(1)
        .maybeSingle();
      const h = (data as unknown as { house: { id: string; numero: string } | null } | null)?.house;
      return h ?? null;
    }
    if (casaNum.trim()) {
      const { data } = await supabaseBrowser
        .from("houses")
        .select("id, numero")
        .eq("numero", casaNum.trim())
        .maybeSingle();
      return (data as unknown as { id: string; numero: string } | null) ?? null;
    }
    return null;
  }

  async function reportar() {
    setErr(null);
    setOk(null);
    setResuelta(null);
    if (!catId) return setErr("Elige el tipo de incidencia.");
    if (!placa.trim() && !casaNum.trim()) return setErr("Indica la casa infractora (número o placa).");
    setEnviando(true);
    try {
      const infr = await resolverInfractor();
      if (!infr) throw new Error("No encontré la casa infractora con esos datos.");
      setResuelta(`Casa ${infr.numero}`);
      let url: string | null = null;
      if (file && coloniaId) {
        const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
        const path = `${coloniaId}/${crypto.randomUUID()}.${ext}`;
        const { error: upErr } = await supabaseBrowser.storage.from(BUCKET).upload(path, file);
        if (upErr) throw new Error("No se pudo subir la evidencia.");
        url = supabaseBrowser.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
      }
      const { error } = await supabaseBrowser.rpc("reportar_incidencia", {
        p_infractor: infr.id,
        p_categoria: catId,
        p_descripcion: desc.trim() || null,
        p_evidencia_url: url,
      });
      if (error) throw new Error(error.message.replace(/^.*?:\s/, ""));
      setOk(`Reporte enviado contra casa ${infr.numero}. El comité lo revisará.`);
      setCatId("");
      setCasaNum("");
      setPlaca("");
      setDesc("");
      setFile(null);
      if (houseId) await cargarMios(houseId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error al reportar.");
    } finally {
      setEnviando(false);
    }
  }

  if (!ready)
    return (
      <main className="flex-1 flex items-center justify-center text-slate-400">Cargando…</main>
    );

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

        <h1 className="text-2xl font-bold text-slate-800 mt-4">Incidencias</h1>
        <p className="text-sm text-slate-500">
          Reporta una falta de otra casa. El reporte es anónimo para el infractor.
        </p>

        {/* Reportar */}
        <section className="mt-5 bg-white rounded-2xl ring-1 ring-slate-100 p-4 flex flex-col gap-3">
          <label className="text-xs text-slate-500">
            Tipo de incidencia
            <select
              value={catId}
              onChange={(e) => setCatId(e.target.value)}
              className="mt-1 w-full rounded-xl ring-1 ring-slate-200 px-2 py-2 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300 bg-white"
            >
              <option value="">— elige —</option>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nombre} ({money(c.monto_base)})
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-slate-500">
              Casa infractora
              <input
                value={casaNum}
                onChange={(e) => {
                  setCasaNum(e.target.value);
                  if (e.target.value) setPlaca("");
                }}
                placeholder="N° de casa"
                className="mt-1 w-full rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
              />
            </label>
            <label className="text-xs text-slate-500">
              …o por placa
              <input
                value={placa}
                onChange={(e) => {
                  setPlaca(e.target.value.toUpperCase());
                  if (e.target.value) setCasaNum("");
                }}
                placeholder="ABC-123"
                className="mt-1 w-full rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 uppercase outline-none focus:ring-2 focus:ring-brand-300"
              />
            </label>
          </div>
          <label className="text-xs text-slate-500">
            Descripción
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              rows={2}
              placeholder="¿Qué pasó?"
              className="mt-1 w-full rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 text-sm outline-none focus:ring-2 focus:ring-brand-300"
            />
          </label>
          <label className="text-xs text-slate-500">
            Evidencia (foto, opcional)
            <input
              type="file"
              accept="image/*"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="mt-1 w-full text-sm text-slate-600 file:mr-3 file:rounded-xl file:border-0 file:bg-brand-50 file:text-brand-700 file:px-3 file:py-2 file:font-semibold"
            />
          </label>
          {resuelta && <p className="text-xs text-slate-500">Infractor: {resuelta}</p>}
          {err && (
            <p className="text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2 ring-1 ring-red-200">{err}</p>
          )}
          {ok && (
            <p className="text-sm text-emerald-700 bg-emerald-50 rounded-xl px-3 py-2 ring-1 ring-emerald-200">
              {ok}
            </p>
          )}
          <button
            onClick={reportar}
            disabled={enviando}
            className="rounded-2xl bg-gradient-to-br from-brand-500 to-emerald-600 text-white py-3.5 font-extrabold shadow-lg disabled:opacity-40 active:scale-[0.99] transition"
          >
            {enviando ? "Enviando…" : "Reportar incidencia"}
          </button>
        </section>

        {/* Comité: por resolver */}
        {isAdmin && (
          <section className="mt-7">
            <h2 className="text-sm font-bold text-slate-700 mb-2">
              Por resolver{" "}
              <span className="text-slate-400 font-medium">
                ({pendTotal}
                {pendTotal > pend.length ? `, mostrando ${pend.length}` : ""})
              </span>
            </h2>
            {pend.length === 0 ? (
              <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
                No hay incidencias pendientes 🎉
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {pend.map((r) => (
                  <ResolverItem
                    key={r.id}
                    r={r}
                    onDone={(id) => {
                      setPend((l) => l.filter((x) => x.id !== id));
                      setPendTotal((n) => Math.max(0, n - 1));
                    }}
                  />
                ))}
              </ul>
            )}
          </section>
        )}

        {/* Mis reportes */}
        <section className="mt-7">
          <h2 className="text-sm font-bold text-slate-700 mb-2">Mis reportes</h2>
          {mios.length === 0 ? (
            <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
              No has reportado incidencias.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {mios.map((r) => (
                <li key={r.id} className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100">
                  <p className="font-semibold text-slate-800 truncate">
                    {r.categoria?.nombre ?? "Incidencia"} · Casa {r.infractor?.numero ?? "—"}
                  </p>
                  <p className="text-xs text-slate-500">{fecha(r.created_at)}</p>
                  <span
                    className={`inline-block mt-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                      r.estado === "multa"
                        ? "bg-red-50 text-red-600"
                        : r.estado === "pendiente"
                        ? "bg-amber-50 text-amber-700"
                        : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    {r.estado === "multa" ? `multa ${money(r.monto_multa)}` : r.estado}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

function ResolverItem({ r, onDone }: { r: Reporte; onDone: (id: string) => void }) {
  const [monto, setMonto] = useState<string>(String(r.categoria?.monto_base ?? 0));
  const [nota, setNota] = useState("");
  const [placas, setPlacas] = useState<string[]>([]);
  const [reinc, setReinc] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  async function cargarContexto() {
    // placas del infractor + sugerencia por reincidencia (vía RPC con ids reales)
    const { data: rep } = await supabaseBrowser
      .from("incident_reports")
      .select("infractor_house_id, categoria_id")
      .eq("id", r.id)
      .maybeSingle();
    const ref = rep as unknown as { infractor_house_id: string; categoria_id: string } | null;
    if (!ref) return;
    const { data: vs } = await supabaseBrowser
      .from("vehicles")
      .select("placa")
      .eq("house_id", ref.infractor_house_id);
    setPlacas(((vs as unknown as { placa: string }[]) ?? []).map((v) => v.placa));
    const { data: sug } = await supabaseBrowser.rpc("sugerir_multa", {
      p_infractor: ref.infractor_house_id,
      p_categoria: ref.categoria_id,
    });
    const s = sug as unknown as { monto_sugerido: number; reincidencias: number } | null;
    if (s) {
      setReinc(s.reincidencias);
      setMonto(String(s.monto_sugerido));
    }
  }

  useEffect(() => {
    cargarContexto();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function resolver(accion: "multar" | "rechazar") {
    setBusy(true);
    await supabaseBrowser.rpc("resolver_incidencia", {
      p_id: r.id,
      p_accion: accion,
      p_monto: accion === "multar" ? parseFloat(monto) : null,
      p_nota: nota.trim() || null,
    });
    onDone(r.id);
  }

  return (
    <li className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100">
      <p className="font-semibold text-slate-800">
        {r.categoria?.nombre ?? "Incidencia"} · Casa {r.infractor?.numero ?? "—"}
      </p>
      <p className="text-xs text-slate-500">
        Reporta casa {r.reportante?.numero ?? "—"} · {fecha(r.created_at)}
        {reinc !== null && reinc > 0 ? ` · ${reinc} reincidencia(s)` : ""}
      </p>
      {r.descripcion && <p className="text-sm text-slate-600 mt-1">{r.descripcion}</p>}
      {placas.length > 0 && (
        <p className="text-xs text-slate-500 mt-1">
          Placas del infractor: <span className="font-semibold">{placas.join(", ")}</span>
        </p>
      )}
      {r.evidencia_url && (
        <a
          href={r.evidencia_url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-brand-600 font-semibold underline"
        >
          Ver evidencia
        </a>
      )}
      <div className="flex gap-2 mt-2.5">
        <div className="flex items-center gap-1 flex-1">
          <span className="text-slate-400 text-sm">$</span>
          <input
            type="number"
            value={monto}
            onChange={(e) => setMonto(e.target.value)}
            className="w-full rounded-xl ring-1 ring-slate-200 px-2 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
          />
        </div>
        <button
          onClick={() => resolver("multar")}
          disabled={busy}
          className="rounded-xl bg-red-500 text-white text-sm font-semibold px-3 py-2 hover:bg-red-600 disabled:opacity-40"
        >
          Multar
        </button>
        <button
          onClick={() => resolver("rechazar")}
          disabled={busy}
          className="rounded-xl border border-slate-200 text-slate-500 text-sm font-semibold px-3 py-2 hover:bg-slate-50 disabled:opacity-40"
        >
          Rechazar
        </button>
      </div>
    </li>
  );
}
