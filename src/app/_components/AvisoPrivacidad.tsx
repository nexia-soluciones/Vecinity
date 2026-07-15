"use client";

/**
 * Modal del Aviso de Privacidad (migr. 070).
 *
 * Al entrar a la app, si la colonia del usuario tiene un aviso ACTIVO que él
 * no ha aceptado, se muestra este modal con el texto completo:
 *  - "Aceptar ahora" → privacy_accept() registra usuario+versión+fecha y cierra.
 *  - "Aceptar después" → cierra por esta sesión (sessionStorage); vuelve a
 *    aparecer en la siguiente. La app sigue usable — el aviso informa, no
 *    bloquea (el registro de quién falta lo ve el comité en su panel).
 *
 * El contenido viene en markdown ligero: líneas "## " = título de sección,
 * líneas "- " = viñeta, resto = párrafos.
 */

import { useCallback, useEffect, useState } from "react";
import { callRpc } from "@/lib/rpc";

type Notice = {
  pendiente: boolean;
  id?: string;
  titulo?: string;
  contenido?: string;
  version?: number;
};

const SESSION_KEY = "aviso-privacidad-pospuesto";

function Contenido({ texto }: { texto: string }) {
  const bloques = texto.split(/\n\n+/);
  return (
    <div className="flex flex-col gap-3">
      {bloques.map((b, i) => {
        const t = b.trim();
        if (t.startsWith("## ")) {
          return (
            <h3 key={i} className="text-sm font-bold text-slate-800 mt-1">
              {t.slice(3)}
            </h3>
          );
        }
        if (t.startsWith("- ")) {
          return (
            <ul key={i} className="list-disc pl-5 flex flex-col gap-1.5">
              {t.split("\n").map((li, j) => (
                <li key={j} className="text-[13px] leading-relaxed text-slate-600">
                  {li.replace(/^- /, "")}
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="text-[13px] leading-relaxed text-slate-600">
            {t}
          </p>
        );
      })}
    </div>
  );
}

export default function AvisoPrivacidad() {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [aceptando, setAceptando] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (sessionStorage.getItem(SESSION_KEY) === "1") return;
    (async () => {
      const res = await callRpc<Notice>("privacy_status", {});
      if (res.ok && res.data.pendiente) setNotice(res.data);
    })();
  }, []);

  const aceptar = useCallback(async () => {
    if (!notice?.id) return;
    setAceptando(true);
    const res = await callRpc("privacy_accept", { p_notice_id: notice.id });
    setAceptando(false);
    if (!res.ok) {
      setMsg(res.error);
      return;
    }
    setNotice(null);
  }, [notice]);

  const despues = useCallback(() => {
    sessionStorage.setItem(SESSION_KEY, "1");
    setNotice(null);
  }, []);

  if (!notice?.pendiente) return null;

  return (
    <div className="fixed inset-0 z-[90] bg-slate-900/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-6">
      <div className="bg-white w-full sm:max-w-lg sm:rounded-3xl rounded-t-3xl shadow-2xl flex flex-col max-h-[92dvh]">
        <div className="px-5 pt-5 pb-3 border-b border-slate-100">
          <p className="text-[11px] font-semibold text-brand-600 uppercase tracking-wide">
            Villa · Documento oficial
          </p>
          <h2 className="text-lg font-bold text-slate-800">{notice.titulo}</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Versión {notice.version} · Ley Federal de Protección de Datos
            Personales en Posesión de los Particulares
          </p>
        </div>

        <div className="overflow-y-auto px-5 py-4 flex-1">
          <Contenido texto={notice.contenido || ""} />
        </div>

        <div className="px-5 py-4 border-t border-slate-100 flex flex-col gap-2">
          {msg && <p className="text-xs text-rose-600 text-center">{msg}</p>}
          <button
            onClick={aceptar}
            disabled={aceptando}
            className="rounded-xl bg-brand-500 text-white text-sm font-semibold px-4 py-3 hover:bg-brand-600 disabled:opacity-50"
          >
            {aceptando ? "Registrando…" : "He leído y acepto el Aviso de Privacidad"}
          </button>
          <button
            onClick={despues}
            disabled={aceptando}
            className="rounded-xl text-slate-400 text-sm font-semibold px-4 py-2 hover:text-slate-600"
          >
            Aceptar después
          </button>
          <p className="text-[10px] text-slate-400 text-center">
            Tu aceptación queda registrada con tu usuario, fecha y versión del aviso.
          </p>
        </div>
      </div>
    </div>
  );
}
