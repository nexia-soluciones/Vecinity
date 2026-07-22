"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { supabaseBrowser } from "@/lib/supabase/browser";

type Pase = {
  nombre: string;
  estado: string;
  fecha_programada: string | null;
  casa: string;
  colonia: string;
  logo_url: string | null;
};

const fmt = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("es-MX", {
        weekday: "long",
        day: "numeric",
        month: "long",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Sin horario específico";

const ESTADO_LABEL: Record<string, { txt: string; cls: string }> = {
  esperando: { txt: "Pase válido · pendiente de ingreso", cls: "bg-amber-50 text-amber-700" },
  adentro: { txt: "Visitante dentro de la colonia", cls: "bg-emerald-50 text-emerald-700" },
  completada: { txt: "Visita finalizada", cls: "bg-slate-100 text-slate-500" },
};

export default function PaseVisitaPublico() {
  const params = useParams<{ token: string }>();
  const token = params?.token;
  const [pase, setPase] = useState<Pase | null>(null);
  const [qr, setQr] = useState("");
  const [loading, setLoading] = useState(true);
  const [isGuard, setIsGuard] = useState(false);
  const [acting, setActing] = useState(false);

  const refrescar = async () => {
    const { data } = await supabaseBrowser.rpc("get_visita_publica", { p_token: token });
    setPase((data as unknown as Pase) ?? null);
  };

  useEffect(() => {
    if (!token) return;
    QRCode.toDataURL(`${window.location.origin}/visita/${token}`, { width: 320, margin: 1 })
      .then(setQr)
      .catch(() => setQr(""));
    (async () => {
      await refrescar();
      // ¿quien abre es vigilancia logueada?
      const {
        data: { user },
      } = await supabaseBrowser.auth.getUser();
      if (user) {
        const { data: prof } = await supabaseBrowser
          .from("profiles")
          .select("role")
          .eq("id", user.id)
          .maybeSingle();
        const role = (prof as unknown as { role: string } | null)?.role;
        setIsGuard(!!role && ["guardia", "admin", "comite"].includes(role));
      }
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function accionGuardia(accion: "entrada" | "salida") {
    setActing(true);
    await supabaseBrowser.rpc("marcar_visita_por_token", { p_token: token, p_accion: accion });
    await refrescar();
    setActing(false);
  }

  if (loading)
    return (
      <main className="min-h-screen flex items-center justify-center text-slate-400">Cargando…</main>
    );

  if (!pase)
    return (
      <main className="min-h-screen flex flex-col items-center justify-center bg-slate-50 p-6 text-center">
        <span className="text-5xl mb-3">🚫</span>
        <h1 className="text-xl font-bold text-slate-800">Pase no válido</h1>
        <p className="text-slate-500 text-sm mt-1">
          Este enlace no corresponde a ninguna visita activa.
        </p>
      </main>
    );

  const est = ESTADO_LABEL[pase.estado] ?? ESTADO_LABEL.esperando;

  return (
    <main className="min-h-screen bg-gradient-to-b from-brand-50 via-white to-sky-50 flex flex-col items-center px-5 py-10">
      <div className="w-full max-w-sm bg-white rounded-3xl ring-1 ring-slate-100 shadow-lg p-6 text-center">
        {pase.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={pase.logo_url} alt={pase.colonia} className="h-12 mx-auto object-contain" />
        ) : (
          <p className="text-sm font-semibold text-brand-600">{pase.colonia}</p>
        )}

        <p className="text-xs uppercase tracking-wide text-slate-400 mt-4">Pase de visita</p>
        <h1 className="text-2xl font-bold text-slate-800">{pase.nombre}</h1>
        <p className="text-slate-500 text-sm mt-1">
          {pase.colonia} · Casa {pase.casa}
        </p>
        <p className="text-slate-600 text-sm mt-1 capitalize">{fmt(pase.fecha_programada)}</p>

        {qr ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={qr}
            alt="Código QR del pase"
            className="mx-auto mt-5 rounded-2xl ring-1 ring-slate-100"
            width={220}
            height={220}
          />
        ) : (
          <div className="h-[220px] flex items-center justify-center text-slate-400">QR…</div>
        )}

        <p className={`mt-5 text-sm font-semibold rounded-xl px-3 py-2 ${est.cls}`}>{est.txt}</p>

        {/* Acciones del guardia (solo vigilancia logueada) */}
        {isGuard && pase.estado === "esperando" && (
          <button
            onClick={() => accionGuardia("entrada")}
            disabled={acting}
            className="mt-4 w-full rounded-2xl bg-gradient-to-br from-brand-500 to-emerald-600 text-white py-3.5 font-extrabold shadow-lg disabled:opacity-40 active:scale-[0.99] transition"
          >
            {acting ? "Registrando…" : "✓ Marcar entrada"}
          </button>
        )}
        {isGuard && pase.estado === "adentro" && (
          <button
            onClick={() => accionGuardia("salida")}
            disabled={acting}
            className="press mt-4 w-full rounded-2xl bg-slate-700 text-white py-3.5 font-extrabold shadow-lg disabled:opacity-40"
          >
            {acting ? "Registrando…" : "Marcar salida"}
          </button>
        )}

        {!isGuard && (
          <p className="text-xs text-slate-400 mt-3">
            Muestra este código en la caseta de vigilancia.
          </p>
        )}
      </div>

      <p className="text-xs text-slate-400 mt-6">Vecinity · seguridad para tu comunidad</p>
    </main>
  );
}
