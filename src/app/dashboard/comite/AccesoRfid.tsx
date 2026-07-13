"use client";

import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { callRpc } from "@/lib/rpc";

const money = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);

type Tag = {
  id: string;
  codigo_tag: string;
  status: string;
  motivo: string | null;
  suspended_at: string | null;
};
type Casa = {
  id: string;
  numero: string;
  street: string | null;
  saldo: number;
  rfid_override: "auto" | "forzar_activo" | "forzar_suspendido";
  rfid_override_motivo: string | null;
  rfid_override_at: string | null;
  en_mora: boolean;
  tags: Tag[];
};
type Colonia = { id: string; nombre: string; umbral: number };
type LogRow = {
  tipo: string;
  valor_anterior: string | null;
  valor_nuevo: string;
  motivo: string | null;
  changed_at: string;
  casa: string | null;
  colonia: string | null;
  quien: string | null;
};
type PanelData = {
  orin_last_seen_at: string | null;
  colonias: Colonia[];
  casas: Casa[];
  log: LogRow[];
};

const OVERRIDES = [
  { valor: "auto", label: "Automático", desc: "La regla de mora decide" },
  { valor: "forzar_activo", label: "Forzar activo", desc: "Nunca se suspende" },
  { valor: "forzar_suspendido", label: "Forzar suspendido", desc: "Se suspende aunque esté al corriente" },
] as const;

const overrideBadge = (o: Casa["rfid_override"]) =>
  o === "forzar_activo"
    ? { txt: "🟢 Forzado activo", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" }
    : o === "forzar_suspendido"
      ? { txt: "🔴 Forzado suspendido", cls: "bg-red-50 text-red-700 ring-red-200" }
      : { txt: "⚙️ Automático", cls: "bg-slate-50 text-slate-500 ring-slate-200" };

const haceCuanto = (iso: string | null) => {
  if (!iso) return null;
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "hace menos de 1 min";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `hace ${h} h` : `hace ${Math.floor(h / 24)} días`;
};

export default function AccesoRfid() {
  const [data, setData] = useState<PanelData | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // Edición de override por casa
  const [editando, setEditando] = useState<string | null>(null); // house_id
  const [nuevoOverride, setNuevoOverride] = useState<string>("auto");
  const [motivo, setMotivo] = useState("");
  const [busy, setBusy] = useState(false);
  // Otra casa (sin tags todavía)
  const [otraCasa, setOtraCasa] = useState("");
  const [buscando, setBuscando] = useState(false);
  // Umbral
  const [umbralEdit, setUmbralEdit] = useState<string | null>(null); // colonia_id
  const [umbralValor, setUmbralValor] = useState("");
  const [verLog, setVerLog] = useState(false);

  const cargar = useCallback(async () => {
    const res = await callRpc<PanelData>("rfid_panel_data", {});
    if (!res.ok) return setMsg(res.error);
    setData(res.data);
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  async function aplicarOverride(houseId: string) {
    if (busy) return;
    setMsg(null);
    if (nuevoOverride !== "auto" && !motivo.trim())
      return setMsg("Indica el motivo del cambio.");
    setBusy(true);
    const res = await callRpc("rfid_set_override", {
      p_house_id: houseId,
      p_override: nuevoOverride,
      p_motivo: motivo.trim() || null,
    });
    setBusy(false);
    if (!res.ok) return setMsg(res.error);
    setEditando(null);
    setMotivo("");
    setOtraCasa("");
    setMsg("Guardado. La caseta lo aplica en su siguiente ciclo (~10 min).");
    await cargar();
  }

  async function buscarOtraCasa() {
    if (buscando) return;
    setMsg(null);
    const numero = otraCasa.trim();
    if (!numero) return setMsg("Escribe el número de casa.");
    if (data?.casas.some((c) => c.numero === numero)) {
      setMsg(`La casa ${numero} ya está en la lista de abajo.`);
      return;
    }
    setBuscando(true);
    try {
      const { data: h } = await supabaseBrowser
        .from("houses")
        .select("id")
        .eq("numero", numero)
        .maybeSingle();
      const house = h as unknown as { id: string } | null;
      if (!house) return setMsg(`No encontré la casa ${numero}.`);
      setEditando(house.id);
      setNuevoOverride("auto");
      setMotivo("");
    } finally {
      setBuscando(false);
    }
  }

  async function guardarUmbral(coloniaId: string) {
    if (busy) return;
    setMsg(null);
    const v = parseFloat(umbralValor);
    if (!Number.isFinite(v) || v <= 0) return setMsg("El umbral debe ser mayor a $0.");
    setBusy(true);
    const res = await callRpc("rfid_set_umbral", { p_colonia_id: coloniaId, p_umbral: v });
    setBusy(false);
    if (!res.ok) return setMsg(res.error);
    setUmbralEdit(null);
    setUmbralValor("");
    setMsg("Umbral actualizado. Aplica desde el siguiente ciclo de la caseta.");
    await cargar();
  }

  if (!data)
    return (
      <section className="mt-6">
        <h2 className="text-sm font-bold text-slate-700 mb-2">Acceso RFID (caseta) 🚗</h2>
        <p className="text-sm text-slate-400 bg-white rounded-2xl p-4 ring-1 ring-slate-100">
          {msg ?? "Cargando…"}
        </p>
      </section>
    );

  const vistoMin = data.orin_last_seen_at
    ? (Date.now() - new Date(data.orin_last_seen_at).getTime()) / 60000
    : null;
  // Poller cada 10 min → sin señal en 25 min = algo anda mal en la caseta.
  const orinViva = vistoMin !== null && vistoMin < 25;

  const editorOverride = (houseId: string) => (
    <div className="mt-3 border-t border-slate-100 pt-3 flex flex-col gap-2">
      {OVERRIDES.map((o) => (
        <label key={o.valor} className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name={`ovr-${houseId}`}
            checked={nuevoOverride === o.valor}
            onChange={() => setNuevoOverride(o.valor)}
            className="mt-1 accent-brand-500"
          />
          <span>
            <span className="font-semibold text-slate-700">{o.label}</span>{" "}
            <span className="text-slate-400">— {o.desc}</span>
          </span>
        </label>
      ))}
      {nuevoOverride !== "auto" && (
        <input
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder="Motivo (obligatorio)"
          className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
        />
      )}
      <div className="flex gap-2">
        <button
          onClick={() => aplicarOverride(houseId)}
          disabled={busy}
          className="rounded-xl bg-brand-500 text-white text-sm font-semibold px-3 py-2 hover:bg-brand-600 disabled:opacity-40"
        >
          {busy ? "…" : "Guardar"}
        </button>
        <button
          onClick={() => {
            setEditando(null);
            setMotivo("");
          }}
          className="rounded-xl border border-slate-200 text-slate-500 text-sm font-semibold px-3 py-2 hover:bg-slate-50"
        >
          Cancelar
        </button>
      </div>
    </div>
  );

  return (
    <section className="mt-6">
      <h2 className="text-sm font-bold text-slate-700 mb-2">Acceso RFID (caseta) 🚗</h2>

      {/* Estado de la Orin */}
      <div
        className={`rounded-2xl p-3.5 ring-1 flex items-center justify-between ${
          orinViva ? "bg-emerald-50 ring-emerald-200" : "bg-amber-50 ring-amber-200"
        }`}
      >
        <p className="text-sm font-semibold text-slate-700">
          {orinViva ? "🟢 Caseta en línea" : "🟠 Caseta sin señal"}
        </p>
        <p className="text-xs text-slate-500">
          {data.orin_last_seen_at ? haceCuanto(data.orin_last_seen_at) : "sin reporte aún"}
        </p>
      </div>
      <p className="text-xs text-slate-400 mt-1.5 px-1">
        Los cambios los aplica la caseta en su siguiente ciclo (hasta ~10 min).
      </p>

      {msg && (
        <p className="text-sm text-slate-700 bg-sky-50 rounded-xl px-3 py-2 ring-1 ring-sky-200 mt-2">
          {msg}
        </p>
      )}

      {/* Umbral de suspensión */}
      <div className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100 mt-3">
        <p className="text-sm font-semibold text-slate-700 mb-1">Umbral de suspensión por mora</p>
        {data.colonias.map((c) => (
          <div key={c.id} className="flex items-center justify-between py-1.5">
            <p className="text-sm text-slate-600">{c.nombre}</p>
            {umbralEdit === c.id ? (
              <span className="flex items-center gap-2">
                <input
                  value={umbralValor}
                  onChange={(e) => setUmbralValor(e.target.value)}
                  inputMode="decimal"
                  className="w-24 rounded-xl border border-slate-200 px-2 py-1 text-sm text-right"
                />
                <button
                  onClick={() => guardarUmbral(c.id)}
                  disabled={busy}
                  className="text-sm font-semibold text-brand-600 disabled:opacity-40"
                >
                  {busy ? "…" : "OK"}
                </button>
                <button
                  onClick={() => setUmbralEdit(null)}
                  className="text-sm text-slate-400"
                >
                  ✕
                </button>
              </span>
            ) : (
              <button
                onClick={() => {
                  setUmbralEdit(c.id);
                  setUmbralValor(String(c.umbral));
                }}
                className="text-sm font-bold text-slate-800 underline decoration-dotted underline-offset-4"
              >
                {money(c.umbral)}
              </button>
            )}
          </div>
        ))}
        <p className="text-xs text-slate-400 mt-1">
          Se suspende cuando la deuda alcanza el umbral y la casa no tiene convenio activo.
        </p>
      </div>

      {/* Casas con tags u override */}
      <ul className="flex flex-col gap-2 mt-3">
        {data.casas.map((casa) => {
          const badge = overrideBadge(casa.rfid_override);
          return (
            <li key={casa.id} className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-slate-800">
                    Casa {casa.numero}
                    {casa.en_mora && (
                      <span className="ml-2 text-xs font-bold text-amber-600">EN MORA</span>
                    )}
                  </p>
                  <p className="text-xs text-slate-500">
                    Saldo {money(Number(casa.saldo))} · {casa.tags.length}{" "}
                    {casa.tags.length === 1 ? "tag" : "tags"}
                  </p>
                </div>
                <span
                  className={`shrink-0 text-xs font-semibold rounded-xl px-2.5 py-1.5 ring-1 ${badge.cls}`}
                >
                  {badge.txt}
                </span>
              </div>
              {casa.tags.length > 0 && (
                <p className="text-xs text-slate-500 mt-1.5">
                  {casa.tags.map((t) => (
                    <span key={t.id} className="mr-3">
                      {t.status === "activo" ? "🟢" : "🔴"} {t.codigo_tag}
                      {t.motivo ? ` (${t.motivo})` : ""}
                    </span>
                  ))}
                </p>
              )}
              {casa.rfid_override !== "auto" && casa.rfid_override_motivo && (
                <p className="text-xs text-slate-400 mt-1 italic">
                  “{casa.rfid_override_motivo}” · {haceCuanto(casa.rfid_override_at)}
                </p>
              )}
              {editando === casa.id ? (
                editorOverride(casa.id)
              ) : (
                <button
                  onClick={() => {
                    setEditando(casa.id);
                    setNuevoOverride(casa.rfid_override);
                    setMotivo(casa.rfid_override_motivo ?? "");
                    setMsg(null);
                  }}
                  className="mt-2 text-sm font-semibold text-brand-600 hover:text-brand-700"
                >
                  Cambiar estado →
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {/* Otra casa (aún sin tags) */}
      <div className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100 mt-3">
        <p className="text-sm font-semibold text-slate-700 mb-2">Otra casa</p>
        {editando && !data.casas.some((c) => c.id === editando) ? (
          <>
            <p className="text-sm text-slate-600">Casa {otraCasa.trim()}</p>
            {editorOverride(editando)}
          </>
        ) : (
          <div className="flex gap-2">
            <input
              value={otraCasa}
              onChange={(e) => setOtraCasa(e.target.value)}
              placeholder="Número de casa"
              className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm"
            />
            <button
              onClick={buscarOtraCasa}
              disabled={buscando}
              className="rounded-xl border border-slate-200 text-slate-600 text-sm font-semibold px-3 py-2 hover:bg-slate-50 disabled:opacity-40"
            >
              {buscando ? "…" : "Buscar"}
            </button>
          </div>
        )}
      </div>

      {/* Bitácora */}
      {data.log.length > 0 && (
        <div className="mt-3">
          <button
            onClick={() => setVerLog(!verLog)}
            className="text-sm font-semibold text-slate-500 hover:text-slate-700"
          >
            {verLog ? "▾" : "▸"} Últimos cambios ({data.log.length})
          </button>
          {verLog && (
            <ul className="flex flex-col gap-1.5 mt-2">
              {data.log.map((l, i) => (
                <li
                  key={i}
                  className="bg-white rounded-xl px-3 py-2 ring-1 ring-slate-100 text-xs text-slate-600"
                >
                  {l.tipo === "umbral" ? (
                    <>
                      💲 Umbral {l.colonia ?? ""}: {money(Number(l.valor_anterior))} →{" "}
                      {money(Number(l.valor_nuevo))}
                    </>
                  ) : (
                    <>
                      🏠 Casa {l.casa ?? "—"}: {l.valor_anterior ?? "auto"} → {l.valor_nuevo}
                      {l.motivo ? ` · “${l.motivo}”` : ""}
                    </>
                  )}
                  <span className="text-slate-400">
                    {" "}
                    · {l.quien ?? "—"} · {haceCuanto(l.changed_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
