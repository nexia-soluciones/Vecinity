"use client";

/**
 * Cámara casi-en-vivo de la puerta peatonal + botón de apertura remota.
 *
 * Se usa en el panel del comité (/dashboard/comite) y en el dashboard del
 * guardia (/vigilancia). Solo admin/comité/guardia: las RPCs rechazan a
 * cualquier otro rol, la UI solo es la ventana.
 *
 * Cómo funciona (módulo puerta 2026-07-15, migr. 067):
 *  - camera_view() cada ~1.2s mientras la vista está abierta: renueva el
 *    watch (20s) en la BD y trae el último frame JPEG que bombea la Orin.
 *    Si nadie mira, la Orin no sube nada — cero tráfico de video en reposo.
 *  - door_open() encola un comando con TTL de 30s; la Orin lo ejecuta en
 *    ~2-3s y door_status() da el feedback (ok / error / expirado).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { callRpc } from "@/lib/rpc";

type Frame = { frame_b64: string | null; frame_at: string | null; fresh: boolean };
type DoorStatus = { result: string | null; error: string | null; executed_at: string | null };
type LogEntry = {
  requested_at: string;
  result: string | null;
  nombre: string | null;
  casa: string | null;
  rol: string | null;
};

type EstadoPuerta =
  | { fase: "reposo" }
  | { fase: "enviando" }
  | { fase: "esperando"; id: string; desde: number }
  | { fase: "ok" }
  | { fase: "error"; msg: string };

export default function CamaraPuerta({ conBitacora = false }: { conBitacora?: boolean }) {
  const [abierta, setAbierta] = useState(false);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [camMsg, setCamMsg] = useState<string | null>(null);
  const [puerta, setPuerta] = useState<EstadoPuerta>({ fase: "reposo" });
  const [confirmando, setConfirmando] = useState(false);
  const [log, setLog] = useState<LogEntry[] | null>(null);
  // La puerta pertenece a UNA colonia (migr. 069): la card solo existe para
  // perfiles de esa colonia. Al montar se consulta is_door_operator() (sin
  // efectos — no activa el bombeo de la Orin); mientras no responda, nada se
  // pinta. El error de camera_view queda como respaldo.
  const [oculta, setOculta] = useState(true);
  const vivo = useRef(false);

  useEffect(() => {
    (async () => {
      const res = await callRpc<boolean>("is_door_operator", {});
      setOculta(!(res.ok && res.data === true));
    })();
  }, []);

  // ── Bitácora (solo comité/guardia; la RPC rechaza a los demás) ──
  const cargarLog = useCallback(async () => {
    const res = await callRpc<LogEntry[]>("door_log", { p_limit: 10 });
    if (res.ok) setLog(res.data);
  }, []);
  useEffect(() => {
    if (abierta && conBitacora) cargarLog();
  }, [abierta, conBitacora, cargarLog]);

  // ── Loop de cámara: mientras la vista esté abierta y la pestaña visible ──
  useEffect(() => {
    if (!abierta) return;
    vivo.current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (!vivo.current) return;
      if (document.visibilityState === "visible") {
        const res = await callRpc<Frame>("camera_view", {});
        if (!vivo.current) return;
        if (res.ok) {
          setFrame(res.data);
          setCamMsg(res.data.fresh ? null : "Conectando con la caseta…");
        } else if (/no pertenece a tu colonia/i.test(res.error)) {
          setOculta(true);
          return;
        } else {
          setCamMsg(res.error);
        }
      }
      timer = setTimeout(tick, 1200);
    };
    tick();
    return () => {
      vivo.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [abierta]);

  // ── Feedback del comando de apertura ──
  useEffect(() => {
    if (puerta.fase !== "esperando") return;
    const { id, desde } = puerta;
    const timer = setInterval(async () => {
      const res = await callRpc<DoorStatus>("door_status", { p_id: id });
      if (res.ok && res.data.result) {
        clearInterval(timer);
        if (res.data.result === "ok") {
          setPuerta({ fase: "ok" });
          if (conBitacora) cargarLog();
          setTimeout(() => setPuerta({ fase: "reposo" }), 5000);
        } else {
          setPuerta({
            fase: "error",
            msg:
              res.data.result === "expirado"
                ? "La caseta no respondió a tiempo. Verifica que la Orin esté en línea e inténtalo de nuevo."
                : res.data.error || "La terminal rechazó la apertura.",
          });
        }
        return;
      }
      // 40s sin veredicto (TTL 30s + margen): dejar de esperar
      if (Date.now() - desde > 40000) {
        clearInterval(timer);
        setPuerta({ fase: "error", msg: "Sin respuesta de la caseta." });
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [puerta, conBitacora, cargarLog]);

  const abrirPuerta = useCallback(async () => {
    setConfirmando(false);
    setPuerta({ fase: "enviando" });
    const res = await callRpc<{ ok: boolean; id: string }>("door_open", {});
    if (!res.ok) {
      setPuerta({ fase: "error", msg: res.error });
      return;
    }
    setPuerta({ fase: "esperando", id: res.data.id, desde: Date.now() });
  }, []);

  const horaFrame = frame?.frame_at
    ? new Date(frame.frame_at).toLocaleTimeString("es-MX", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : null;

  if (oculta) return null;

  return (
    <section className="mt-6 bg-white rounded-2xl ring-1 ring-slate-100 overflow-hidden">
      <button
        onClick={() => setAbierta((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3.5 text-left"
      >
        <span className="text-sm font-bold text-slate-700">
          🚪 Puerta peatonal <span className="text-slate-400 font-medium">(cámara en vivo)</span>
        </span>
        <span className="text-slate-400 text-sm">{abierta ? "Cerrar ✕" : "Ver ▸"}</span>
      </button>

      {abierta && (
        <div className="px-4 pb-4 flex flex-col gap-3">
          <div className="relative rounded-xl overflow-hidden bg-slate-900 aspect-video">
            {frame?.frame_b64 ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`data:image/jpeg;base64,${frame.frame_b64}`}
                alt="Cámara de la puerta peatonal"
                className="w-full h-full object-contain"
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-slate-400 text-sm">
                Conectando con la caseta…
              </div>
            )}
            {frame?.frame_b64 && (
              <span
                className={`absolute top-2 left-2 text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                  frame.fresh ? "bg-emerald-500/90 text-white" : "bg-amber-500/90 text-white"
                }`}
              >
                {frame.fresh ? `● EN VIVO · ${horaFrame}` : `imagen de ${horaFrame}`}
              </span>
            )}
          </div>
          {camMsg && frame?.frame_b64 && (
            <p className="text-xs text-amber-600">{camMsg}</p>
          )}

          {/* Botón de apertura con confirmación de dos pasos */}
          {puerta.fase === "reposo" && !confirmando && (
            <button
              onClick={() => setConfirmando(true)}
              className="press rounded-xl bg-brand-500 text-white text-sm font-semibold px-4 py-3 hover:bg-brand-600"
            >
              Abrir puerta
            </button>
          )}
          {confirmando && (
            <div className="flex items-center gap-2">
              <button
                onClick={abrirPuerta}
                className="press flex-1 rounded-xl bg-emerald-600 text-white text-sm font-semibold px-4 py-3 hover:bg-emerald-700"
              >
                ✓ Sí, abrir la puerta
              </button>
              <button
                onClick={() => setConfirmando(false)}
                className="press-soft rounded-xl border border-slate-200 text-slate-500 text-sm font-semibold px-4 py-3 hover:bg-slate-50"
              >
                Cancelar
              </button>
            </div>
          )}
          {puerta.fase === "enviando" && (
            <p className="text-sm text-slate-500 text-center py-2">Enviando comando…</p>
          )}
          {puerta.fase === "esperando" && (
            <p className="text-sm text-sky-600 text-center py-2">Abriendo puerta… ⏳</p>
          )}
          {puerta.fase === "ok" && (
            <p className="text-sm font-semibold text-emerald-600 text-center py-2">
              ✓ Puerta abierta
            </p>
          )}
          {puerta.fase === "error" && (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-rose-600 text-center">{puerta.msg}</p>
              <button
                onClick={() => setPuerta({ fase: "reposo" })}
                className="press-soft rounded-xl border border-slate-200 text-slate-500 text-sm font-semibold px-4 py-2 hover:bg-slate-50"
              >
                Entendido
              </button>
            </div>
          )}

          <p className="text-[11px] text-slate-400">
            Cada apertura queda registrada con tu usuario, fecha y hora.
          </p>

          {conBitacora && log && log.length > 0 && (
            <div className="mt-1">
              <h3 className="text-xs font-bold text-slate-500 mb-1.5">Últimas aperturas</h3>
              <ul className="flex flex-col gap-1">
                {log.map((e, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between text-xs bg-slate-50 rounded-lg px-2.5 py-1.5"
                  >
                    <span className="text-slate-600 truncate">
                      {e.result === "ok" ? "🟢" : e.result === "expirado" ? "🟡" : "🔴"}{" "}
                      {e.nombre || "—"}
                      {e.casa ? ` · casa ${e.casa}` : ""}
                      {e.rol && e.rol !== "residente" ? ` (${e.rol})` : ""}
                    </span>
                    <span className="text-slate-400 shrink-0 ml-2">
                      {new Date(e.requested_at).toLocaleString("es-MX", {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
