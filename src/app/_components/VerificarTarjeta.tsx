"use client";

import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { callRpc } from "@/lib/rpc";

/**
 * Verificación del QR de una tarjeta PVC (página pública).
 * - Sin sesión (cualquier teléfono): solo VIGENTE / NO VÁLIDA + colonia — sin datos personales.
 * - Guardia / comité con sesión: check completo (nombre, casa, rol, placas).
 */

type Full = {
  valida: boolean;
  motivo: string | null;
  nombre?: string;
  casa?: string | null;
  rol?: string;
  placas?: string[];
  tarjeta_emitida?: boolean;
};
type Publico = { valida: boolean; colonia: string | null };

export default function VerificarTarjeta({ clase, id }: { clase: "r" | "vf"; id: string }) {
  const [loading, setLoading] = useState(true);
  const [full, setFull] = useState<Full | null>(null);
  const [pub, setPub] = useState<Publico | null>(null);

  useEffect(() => {
    (async () => {
      // ¿Hay sesión de guardia/comité? → check completo. Si no, check público.
      const {
        data: { user },
      } = await supabaseBrowser.auth.getUser();
      if (user) {
        const { data: prof } = await supabaseBrowser
          .from("profiles")
          .select("role")
          .eq("id", user.id)
          .maybeSingle();
        const rol = (prof as unknown as { role: string } | null)?.role;
        if (rol === "guardia" || rol === "comite" || rol === "admin") {
          const res =
            clase === "r"
              ? await callRpc<Full>("verificar_credencial", { p_profile_id: id })
              : await callRpc<Full>("verificar_tarjeta_visita", { p_card_id: id });
          if (res.ok) {
            setFull(res.data);
            setLoading(false);
            return;
          }
        }
      }
      const res = await callRpc<Publico>("verificar_tarjeta_publico", { p_clase: clase, p_id: id });
      setPub(res.ok ? res.data : { valida: false, colonia: null });
      setLoading(false);
    })();
  }, [clase, id]);

  const valida = full ? full.valida : pub?.valida;

  return (
    <main className="min-h-dvh bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-sm ring-1 ring-slate-100 w-full max-w-sm p-6 text-center">
        <p className="text-xs font-bold tracking-widest text-slate-400 uppercase">
          Vecinity · Verificación de tarjeta
        </p>

        {loading ? (
          <p className="text-sm text-slate-400 mt-8 mb-6">Verificando…</p>
        ) : (
          <>
            <div
              className={`mx-auto mt-5 w-20 h-20 rounded-full flex items-center justify-center text-4xl ${
                valida ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-500"
              }`}
            >
              {valida ? "✓" : "✗"}
            </div>
            <h1 className={`mt-3 text-lg font-bold ${valida ? "text-emerald-700" : "text-red-600"}`}>
              {valida ? "Tarjeta vigente" : "Tarjeta no válida"}
            </h1>

            {full ? (
              <div className="mt-4 text-left bg-slate-50 rounded-2xl p-4">
                {full.nombre && <p className="text-sm font-bold text-slate-800">{full.nombre}</p>}
                <p className="text-xs text-slate-500 mt-0.5">
                  {[full.rol, full.casa ? `Casa ${full.casa}` : null].filter(Boolean).join(" · ")}
                </p>
                {full.placas && full.placas.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {full.placas.map((p) => (
                      <span
                        key={p}
                        className="text-[11px] font-mono font-semibold bg-white ring-1 ring-slate-200 rounded-lg px-2 py-0.5"
                      >
                        {p}
                      </span>
                    ))}
                  </div>
                )}
                {full.motivo && <p className="text-xs text-red-600 mt-2">{full.motivo}</p>}
              </div>
            ) : (
              <p className="text-xs text-slate-400 mt-3">
                {pub?.colonia
                  ? `Tarjeta de acceso de ${pub.colonia}.`
                  : "Este QR no corresponde a ninguna tarjeta registrada."}{" "}
                El personal de vigilancia puede ver el detalle desde su cuenta.
              </p>
            )}
          </>
        )}
      </div>
    </main>
  );
}
