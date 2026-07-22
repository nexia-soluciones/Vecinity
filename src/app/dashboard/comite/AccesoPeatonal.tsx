"use client";

import { useCallback, useEffect, useState } from "react";
import { callRpc } from "@/lib/rpc";

type Pendiente = {
  id: string;
  nombre: string;
  casa: string;
  subido_por: string | null;
  created_at: string;
};
type Activo = {
  id: string;
  enroll_no: number;
  nombre: string;
  status: string; // aprobada | enrolada
  motivo: string | null;
  enrolled_at: string | null;
  suspended_at: string | null;
  casa: string;
};
type PanelData = {
  pendientes: Pendiente[];
  activos: Activo[];
  pendiente_borrado: number;
};

const statusBadge = (a: Activo) =>
  a.status === "enrolada"
    ? { txt: "🟢 Activa", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" }
    : { txt: "📤 Por activar", cls: "bg-sky-50 text-sky-700 ring-sky-200" };

export default function AccesoPeatonal() {
  const [data, setData] = useState<PanelData | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fotos, setFotos] = useState<Record<string, string>>({});
  const [rechazando, setRechazando] = useState<string | null>(null); // id
  const [motivo, setMotivo] = useState("");
  const [verActivos, setVerActivos] = useState(false);

  const cargar = useCallback(async () => {
    const res = await callRpc<PanelData>("face_panel_data", {});
    if (!res.ok) return setMsg(res.error);
    setData(res.data);
    // Las fotos pendientes se cargan una por una (no viajan en la lista).
    for (const p of res.data.pendientes) {
      if (fotos[p.id]) continue;
      const f = await callRpc<{ photo_b64: string }>("face_photo", { p_id: p.id });
      if (f.ok) setFotos((prev) => ({ ...prev, [p.id]: f.data.photo_b64 }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  async function revisar(id: string, aprobar: boolean) {
    if (busy) return;
    setMsg(null);
    if (!aprobar && !motivo.trim()) return setMsg("Indica el motivo del rechazo.");
    setBusy(true);
    const res = await callRpc("face_review", {
      p_id: id,
      p_aprobar: aprobar,
      p_motivo: aprobar ? null : motivo.trim(),
    });
    setBusy(false);
    if (!res.ok) return setMsg(res.error);
    setRechazando(null);
    setMotivo("");
    setMsg(
      aprobar
        ? "Aprobada. La caseta la activa en su siguiente ciclo (~10 min)."
        : "Rechazada. El vecino verá el motivo en su cuenta."
    );
    await cargar();
  }

  async function retirar(id: string, nombre: string) {
    if (busy) return;
    if (!window.confirm(`¿Retirar el rostro de ${nombre} de la puerta peatonal?`)) return;
    setBusy(true);
    const res = await callRpc("face_retire", { p_id: id });
    setBusy(false);
    if (!res.ok) return setMsg(res.error);
    setMsg("Retirado. La caseta lo borra de la terminal en su siguiente ciclo.");
    await cargar();
  }

  if (!data)
    return (
      <section className="mt-6">
        <h2 className="text-sm font-bold text-slate-700 mb-2">Acceso peatonal (rostros) 🚶</h2>
        <p className="text-sm text-slate-400 bg-white rounded-2xl p-4 ring-1 ring-slate-100">
          {msg ?? "Cargando…"}
        </p>
      </section>
    );

  return (
    <section className="mt-6">
      <h2 className="text-sm font-bold text-slate-700 mb-2">Acceso peatonal (rostros) 🚶</h2>
      <p className="text-xs text-slate-400 mb-2 px-1">
        El acceso peatonal <span className="font-semibold">nunca se suspende por mora</span> — la
        mora solo aplica al acceso vehicular. Un rostro solo se quita retirándolo aquí. Los
        cambios los aplica la caseta en su siguiente ciclo (~10 min).
      </p>

      {msg && (
        <p className="text-sm text-slate-700 bg-sky-50 rounded-xl px-3 py-2 ring-1 ring-sky-200 mb-2">
          {msg}
        </p>
      )}

      {/* Pendientes de revisión */}
      <div className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100">
        <p className="text-sm font-semibold text-slate-700 mb-2">
          Por revisar{" "}
          <span className="text-slate-400 font-medium">({data.pendientes.length})</span>
        </p>
        {data.pendientes.length === 0 ? (
          <p className="text-sm text-slate-400">Sin fotos pendientes.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {data.pendientes.map((p) => (
              <li key={p.id} className="flex gap-3 border-t border-slate-100 pt-3 first:border-0 first:pt-0">
                {fotos[p.id] ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={`data:image/jpeg;base64,${fotos[p.id]}`}
                    alt={p.nombre}
                    className="w-24 h-24 rounded-xl object-cover ring-1 ring-slate-200 shrink-0"
                  />
                ) : (
                  <div className="w-24 h-24 rounded-xl bg-slate-100 shrink-0 animate-pulse" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-slate-800 text-sm truncate">{p.nombre}</p>
                  <p className="text-xs text-slate-500">
                    Casa {p.casa}
                    {p.subido_por ? ` · subió ${p.subido_por}` : ""}
                  </p>
                  {rechazando === p.id ? (
                    <div className="mt-2 flex flex-col gap-1.5">
                      <input
                        value={motivo}
                        onChange={(e) => setMotivo(e.target.value)}
                        placeholder="Motivo (el vecino lo verá)"
                        className="rounded-xl border border-slate-200 px-3 py-1.5 text-sm"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => revisar(p.id, false)}
                          disabled={busy}
                          className="press rounded-xl bg-red-500 text-white text-xs font-semibold px-3 py-1.5 disabled:opacity-40"
                        >
                          Confirmar rechazo
                        </button>
                        <button
                          onClick={() => {
                            setRechazando(null);
                            setMotivo("");
                          }}
                          className="text-xs text-slate-400"
                        >
                          Cancelar
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2 mt-2">
                      <button
                        onClick={() => revisar(p.id, true)}
                        disabled={busy}
                        className="press rounded-xl bg-brand-500 text-white text-xs font-semibold px-3 py-1.5 hover:bg-brand-600 disabled:opacity-40"
                      >
                        {busy ? "…" : "Aprobar"}
                      </button>
                      <button
                        onClick={() => {
                          setRechazando(p.id);
                          setMotivo("");
                        }}
                        className="rounded-xl border border-red-200 text-red-500 text-xs font-semibold px-3 py-1.5 hover:bg-red-50"
                      >
                        Rechazar
                      </button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Rostros activos */}
      <div className="mt-3">
        <button
          onClick={() => setVerActivos(!verActivos)}
          className="text-sm font-semibold text-slate-500 hover:text-slate-700"
        >
          {verActivos ? "▾" : "▸"} Rostros registrados ({data.activos.length})
          {data.pendiente_borrado > 0 && (
            <span className="ml-2 text-xs text-amber-600">
              · {data.pendiente_borrado} por borrar de la terminal
            </span>
          )}
        </button>
        {verActivos && (
          <ul className="flex flex-col gap-1.5 mt-2">
            {data.activos.map((a) => {
              const b = statusBadge(a);
              return (
                <li
                  key={a.id}
                  className="bg-white rounded-xl px-3 py-2 ring-1 ring-slate-100 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-800 truncate">
                      {a.nombre} <span className="text-slate-400 font-medium">· casa {a.casa}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`text-xs font-semibold rounded-xl px-2.5 py-1 ring-1 ${b.cls}`}>
                      {b.txt}
                    </span>
                    <button
                      onClick={() => retirar(a.id, a.nombre)}
                      disabled={busy}
                      className="text-xs font-semibold text-red-500 disabled:opacity-40"
                    >
                      Retirar
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
