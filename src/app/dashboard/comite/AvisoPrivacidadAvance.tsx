"use client";

/**
 * Card del comité: avance de aceptación del Aviso de Privacidad (migr. 070).
 * Muestra "X de Y" y, expandida, la lista de quién ya aceptó (nombre, casa,
 * fecha) vía privacy_report() — solo admin/comité.
 */

import { useEffect, useState } from "react";
import { callRpc } from "@/lib/rpc";

type Reporte = {
  hay_aviso: boolean;
  version?: number;
  titulo?: string;
  aceptados?: number;
  total?: number;
  lista?: { nombre: string; casa: string | null; accepted_at: string }[];
};

export default function AvisoPrivacidadAvance() {
  const [rep, setRep] = useState<Reporte | null>(null);
  const [abierta, setAbierta] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await callRpc<Reporte>("privacy_report", {});
      if (res.ok) setRep(res.data);
    })();
  }, []);

  if (!rep?.hay_aviso) return null;
  const pct = rep.total ? Math.round(((rep.aceptados || 0) / rep.total) * 100) : 0;

  return (
    <section className="mt-6 bg-white rounded-2xl ring-1 ring-slate-100 overflow-hidden">
      <button
        onClick={() => setAbierta((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3.5 text-left"
      >
        <span className="text-sm font-bold text-slate-700">
          📜 Aviso de privacidad{" "}
          <span className="text-slate-400 font-medium">(v{rep.version})</span>
        </span>
        <span className="text-sm font-semibold text-slate-500">
          {rep.aceptados}/{rep.total} · {pct}%
        </span>
      </button>
      <div className="px-4 pb-1">
        <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
          <div
            className="h-full bg-brand-500 rounded-full transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      {abierta && (
        <div className="px-4 pb-4 pt-2">
          {(rep.lista || []).length === 0 ? (
            <p className="text-xs text-slate-400">Nadie ha aceptado todavía.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {(rep.lista || []).map((e, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between text-xs bg-slate-50 rounded-lg px-2.5 py-1.5"
                >
                  <span className="text-slate-600 truncate">
                    ✅ {e.nombre}
                    {e.casa ? ` · casa ${e.casa}` : ""}
                  </span>
                  <span className="text-slate-400 shrink-0 ml-2">
                    {new Date(e.accepted_at).toLocaleDateString("es-MX", {
                      day: "numeric",
                      month: "short",
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[10px] text-slate-400 mt-2">
            El aviso aparece a cada usuario al entrar hasta que lo acepte.
          </p>
        </div>
      )}
    </section>
  );
}
