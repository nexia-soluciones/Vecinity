"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { callRpc, runOrError } from "@/lib/rpc";

type Cat = { id: string; nombre: string };
type Vehiculo = {
  id: string;
  placa: string;
  color: string | null;
  estado: string;
  tarjeta_rfid: string | null;
  brand: { nombre: string } | null;
  model: { nombre: string } | null;
};
type Pendiente = Vehiculo & { house: { numero: string } | null };

const ESTADO: Record<string, string> = {
  aprobado: "bg-emerald-50 text-emerald-700",
  pendiente: "bg-amber-50 text-amber-700",
  rechazado: "bg-red-50 text-red-600",
};

const VEH_COLS = "id, placa, color, estado, tarjeta_rfid, brand:vehicle_brands(nombre), model:vehicle_models(nombre)";

export default function VehiculosPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [houseId, setHouseId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  const [brands, setBrands] = useState<Cat[]>([]);
  const [models, setModels] = useState<Cat[]>([]);
  const [brandId, setBrandId] = useState("");
  const [modelId, setModelId] = useState("");
  const [placa, setPlaca] = useState("");
  const [color, setColor] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const [mios, setMios] = useState<Vehiculo[]>([]);
  const [pendientes, setPendientes] = useState<Pendiente[]>([]);
  const [resolviendo, setResolviendo] = useState<Set<string>>(new Set());
  const [pendErr, setPendErr] = useState<string | null>(null);

  // Comité: búsqueda y baja de vehículos de cualquier casa
  const [busqueda, setBusqueda] = useState("");
  const [buscando, setBuscando] = useState(false);
  const [resultados, setResultados] = useState<Pendiente[] | null>(null);
  const [bajaMsg, setBajaMsg] = useState<string | null>(null);
  const [bajaErr, setBajaErr] = useState<string | null>(null);

  const cargarMios = useCallback(async (hid: string) => {
    const { data } = await supabaseBrowser
      .from("vehicles")
      .select(VEH_COLS)
      .eq("house_id", hid)
      .order("created_at", { ascending: false });
    setMios((data as unknown as Vehiculo[]) ?? []);
  }, []);

  const cargarPendientes = useCallback(async () => {
    const { data } = await supabaseBrowser
      .from("vehicles")
      .select(`${VEH_COLS}, house:houses(numero)`)
      .eq("estado", "pendiente")
      .order("created_at");
    setPendientes((data as unknown as Pendiente[]) ?? []);
  }, []);

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabaseBrowser.auth.getUser();
      if (!user) return router.replace("/login");
      const { data: prof } = await supabaseBrowser
        .from("profiles")
        .select("house_id, role, approval_status")
        .eq("id", user.id)
        .maybeSingle();
      const p = prof as unknown as {
        house_id: string | null;
        role: string;
        approval_status: string;
      } | null;
      if (!p || p.approval_status !== "aprobado") return router.replace("/esperando");
      setHouseId(p.house_id);
      const admin = p.role === "admin" || p.role === "comite";
      setIsAdmin(admin);

      const { data: b } = await supabaseBrowser
        .from("vehicle_brands")
        .select("id, nombre")
        .order("nombre");
      setBrands((b as unknown as Cat[]) ?? []);

      if (p.house_id) await cargarMios(p.house_id);
      if (admin) await cargarPendientes();
      setReady(true);
    })();
  }, [router, cargarMios, cargarPendientes]);

  async function onBrand(id: string) {
    setBrandId(id);
    setModelId("");
    setModels([]);
    if (!id) return;
    const { data } = await supabaseBrowser
      .from("vehicle_models")
      .select("id, nombre")
      .eq("brand_id", id)
      .order("nombre");
    setModels((data as unknown as Cat[]) ?? []);
  }

  async function agregar() {
    setErr(null);
    if (!placa.trim()) return setErr("Escribe la placa.");
    setEnviando(true);
    const res = await callRpc("agregar_vehiculo", {
      p_placa: placa.trim(),
      p_brand_id: brandId || null,
      p_model_id: modelId || null,
      p_color: color.trim() || null,
    });
    setEnviando(false);
    if (!res.ok) return setErr(res.error);
    setPlaca("");
    setColor("");
    setBrandId("");
    setModelId("");
    setModels([]);
    if (houseId) await cargarMios(houseId);
  }

  async function eliminar(id: string) {
    if (resolviendo.has(id)) return;
    setPendErr(null);
    setResolviendo((s) => new Set(s).add(id));
    const res = await runOrError(() =>
      supabaseBrowser.rpc("eliminar_vehiculo", { p_id: id })
    );
    setResolviendo((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    if (!res.ok) return setPendErr(res.error);
    if (houseId) await cargarMios(houseId);
  }

  async function buscar() {
    const q = busqueda.trim();
    setBajaMsg(null);
    setBajaErr(null);
    if (!q) return setResultados(null);
    setBuscando(true);
    const porCasa = supabaseBrowser
      .from("vehicles")
      .select(`${VEH_COLS}, house:houses!inner(numero)`)
      .eq("house.numero", q)
      .order("created_at");
    const porPlaca = supabaseBrowser
      .from("vehicles")
      .select(`${VEH_COLS}, house:houses(numero)`)
      .ilike("placa", `%${q}%`)
      .order("created_at");
    const [rc, rp] = await Promise.all([porCasa, porPlaca]);
    setBuscando(false);
    if (rc.error && rp.error) return setBajaErr("No se pudo buscar. Inténtalo de nuevo.");
    const vistos = new Set<string>();
    const lista = [
      ...((rc.data as unknown as Pendiente[]) ?? []),
      ...((rp.data as unknown as Pendiente[]) ?? []),
    ].filter((v) => (vistos.has(v.id) ? false : (vistos.add(v.id), true)));
    setResultados(lista);
  }

  async function darDeBaja(v: Pendiente) {
    if (resolviendo.has(v.id)) return;
    const ok = window.confirm(
      `¿Dar de baja el vehículo ${v.placa} de la casa ${v.house?.numero ?? "?"}? Esta acción es definitiva.`
    );
    if (!ok) return;
    setBajaMsg(null);
    setBajaErr(null);
    setResolviendo((s) => new Set(s).add(v.id));
    const res = await callRpc<{ ok: boolean; placa: string; casa: string; aviso_rfid: string | null }>(
      "baja_vehiculo_comite",
      { p_id: v.id }
    );
    setResolviendo((s) => {
      const n = new Set(s);
      n.delete(v.id);
      return n;
    });
    if (!res.ok) return setBajaErr(res.error);
    setResultados((l) => (l ? l.filter((x) => x.id !== v.id) : l));
    setPendientes((l) => l.filter((x) => x.id !== v.id));
    setBajaMsg(
      `Vehículo ${res.data.placa} (casa ${res.data.casa}) dado de baja.` +
        (res.data.aviso_rfid ? ` ⚠️ ${res.data.aviso_rfid}` : "")
    );
    if (houseId) await cargarMios(houseId);
  }

  async function resolver(id: string, estado: "aprobado" | "rechazado", rfid?: string) {
    if (resolviendo.has(id)) return; // evita doble-tap
    setPendErr(null);
    setResolviendo((s) => new Set(s).add(id));
    const res = await runOrError(() =>
      supabaseBrowser
        .from("vehicles")
        .update({ estado, tarjeta_rfid: rfid?.trim() || null })
        .eq("id", id)
    );
    if (!res.ok) {
      setPendErr(res.error);
      setResolviendo((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
      return; // NO se remueve: el vehículo sigue pendiente en la BD
    }
    setPendientes((l) => l.filter((x) => x.id !== id));
    setResolviendo((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    if (houseId) await cargarMios(houseId);
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

        <h1 className="text-2xl font-bold text-slate-800 mt-4">Mis vehículos</h1>
        <p className="text-sm text-slate-500">Da de alta tus autos. El comité los aprueba.</p>

        {/* Alta */}
        <section className="mt-5 bg-white rounded-2xl ring-1 ring-slate-100 p-4 flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-slate-500">
              Marca
              <select
                value={brandId}
                onChange={(e) => onBrand(e.target.value)}
                className="mt-1 w-full rounded-xl ring-1 ring-slate-200 px-2 py-2 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300 bg-white"
              >
                <option value="">—</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.nombre}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-slate-500">
              Modelo
              <select
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                disabled={!brandId}
                className="mt-1 w-full rounded-xl ring-1 ring-slate-200 px-2 py-2 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300 bg-white disabled:bg-slate-50 disabled:text-slate-300"
              >
                <option value="">—</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.nombre}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-slate-500">
              Placa
              <input
                value={placa}
                onChange={(e) => setPlaca(e.target.value.toUpperCase())}
                placeholder="ABC-123-D"
                className="mt-1 w-full rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 uppercase outline-none focus:ring-2 focus:ring-brand-300"
              />
            </label>
            <label className="text-xs text-slate-500">
              Color
              <input
                value={color}
                onChange={(e) => setColor(e.target.value)}
                placeholder="Gris"
                className="mt-1 w-full rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
              />
            </label>
          </div>
          {err && (
            <p className="text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2 ring-1 ring-red-200">
              {err}
            </p>
          )}
          <button
            onClick={agregar}
            disabled={enviando}
            className="rounded-2xl bg-gradient-to-br from-brand-500 to-emerald-600 text-white py-3.5 font-extrabold shadow-lg disabled:opacity-40 active:scale-[0.99] transition"
          >
            {enviando ? "Agregando…" : "Agregar vehículo"}
          </button>
        </section>

        {/* Mis vehículos */}
        <section className="mt-7">
          <h2 className="text-sm font-bold text-slate-700 mb-2">
            Registrados <span className="text-slate-400 font-medium">({mios.length})</span>
          </h2>
          {mios.length === 0 ? (
            <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
              Aún no registras vehículos.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {mios.map((v) => (
                <li
                  key={v.id}
                  className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-800 truncate">
                      {v.placa}
                      {v.color ? ` · ${v.color}` : ""}
                    </p>
                    <p className="text-xs text-slate-500 truncate">
                      {[v.brand?.nombre, v.model?.nombre].filter(Boolean).join(" ") || "Sin marca/modelo"}
                    </p>
                    <span
                      className={`inline-block mt-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                        ESTADO[v.estado] ?? "bg-slate-100 text-slate-500"
                      }`}
                    >
                      {v.estado}
                      {v.tarjeta_rfid ? " · RFID" : ""}
                    </span>
                  </div>
                  {v.estado !== "aprobado" && (
                    <button
                      onClick={() => eliminar(v.id)}
                      className="rounded-xl border border-slate-200 text-slate-500 text-xs font-semibold px-3 py-2 hover:bg-slate-50 shrink-0"
                    >
                      Quitar
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Comité: por aprobar */}
        {isAdmin && (
          <section className="mt-8">
            <h2 className="text-sm font-bold text-slate-700 mb-2">
              Vehículos por aprobar{" "}
              <span className="text-slate-400 font-medium">({pendientes.length})</span>
            </h2>
            {pendErr && (
              <p className="text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2 ring-1 ring-red-200 mb-2">
                {pendErr}
              </p>
            )}
            {pendientes.length === 0 ? (
              <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
                No hay vehículos pendientes 🎉
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {pendientes.map((v) => (
                  <AprobarVehiculo key={v.id} v={v} onResolve={resolver} busy={resolviendo.has(v.id)} />
                ))}
              </ul>
            )}
          </section>
        )}

        {/* Comité: baja de vehículos de cualquier casa */}
        {isAdmin && (
          <section className="mt-8">
            <h2 className="text-sm font-bold text-slate-700 mb-2">Vehículos por casa</h2>
            <p className="text-xs text-slate-500 mb-2">
              Busca por número de casa o placa para dar de baja vehículos registrados.
            </p>
            <div className="flex gap-2">
              <input
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && buscar()}
                placeholder="Casa (ej. 101) o placa"
                className="flex-1 rounded-xl ring-1 ring-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
              />
              <button
                onClick={buscar}
                disabled={buscando}
                className="rounded-xl bg-brand-500 text-white text-sm font-semibold px-4 py-2 hover:bg-brand-600 disabled:opacity-40"
              >
                {buscando ? "…" : "Buscar"}
              </button>
            </div>
            {bajaErr && (
              <p className="text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2 ring-1 ring-red-200 mt-2">
                {bajaErr}
              </p>
            )}
            {bajaMsg && (
              <p className="text-sm text-emerald-700 bg-emerald-50 rounded-xl px-3 py-2 ring-1 ring-emerald-200 mt-2">
                {bajaMsg}
              </p>
            )}
            {resultados !== null &&
              (resultados.length === 0 ? (
                <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100 mt-2">
                  Sin vehículos para esa casa o placa.
                </p>
              ) : (
                <ul className="flex flex-col gap-2 mt-2">
                  {resultados.map((v) => (
                    <li
                      key={v.id}
                      className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100 flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0">
                        <p className="font-semibold text-slate-800 truncate">
                          {v.placa} · Casa {v.house?.numero ?? "?"}
                        </p>
                        <p className="text-xs text-slate-500 truncate">
                          {[v.brand?.nombre, v.model?.nombre].filter(Boolean).join(" ") ||
                            "Sin marca/modelo"}
                          {v.color ? ` · ${v.color}` : ""}
                        </p>
                        <span
                          className={`inline-block mt-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                            ESTADO[v.estado] ?? "bg-slate-100 text-slate-500"
                          }`}
                        >
                          {v.estado}
                          {v.tarjeta_rfid ? " · RFID" : ""}
                        </span>
                      </div>
                      <button
                        onClick={() => darDeBaja(v)}
                        disabled={resolviendo.has(v.id)}
                        className="rounded-xl border border-red-200 text-red-600 text-xs font-semibold px-3 py-2 hover:bg-red-50 disabled:opacity-40 shrink-0"
                      >
                        {resolviendo.has(v.id) ? "…" : "Dar de baja"}
                      </button>
                    </li>
                  ))}
                </ul>
              ))}
          </section>
        )}
      </div>
    </main>
  );
}

function AprobarVehiculo({
  v,
  onResolve,
  busy,
}: {
  v: Pendiente;
  onResolve: (id: string, estado: "aprobado" | "rechazado", rfid?: string) => void;
  busy: boolean;
}) {
  const [rfid, setRfid] = useState("");
  return (
    <li className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-slate-800 truncate">
            {v.placa} · Casa {v.house?.numero}
          </p>
          <p className="text-xs text-slate-500 truncate">
            {[v.brand?.nombre, v.model?.nombre].filter(Boolean).join(" ") || "Sin marca/modelo"}
            {v.color ? ` · ${v.color}` : ""}
          </p>
        </div>
      </div>
      <div className="flex gap-2 mt-2.5">
        <input
          value={rfid}
          onChange={(e) => setRfid(e.target.value)}
          placeholder="RFID (opcional)"
          className="flex-1 rounded-xl ring-1 ring-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
        />
        <button
          onClick={() => onResolve(v.id, "aprobado", rfid)}
          disabled={busy}
          className="rounded-xl bg-brand-500 text-white text-sm font-semibold px-3 py-2 hover:bg-brand-600 disabled:opacity-40"
        >
          {busy ? "…" : "Aprobar"}
        </button>
        <button
          onClick={() => onResolve(v.id, "rechazado")}
          disabled={busy}
          className="rounded-xl border border-slate-200 text-slate-500 text-sm font-semibold px-3 py-2 hover:bg-slate-50 disabled:opacity-40"
        >
          No
        </button>
      </div>
    </li>
  );
}
