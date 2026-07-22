"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { supabaseBrowser } from "@/lib/supabase/browser";
import CamaraPuerta from "@/app/_components/CamaraPuerta";

type Visita = {
  id: string;
  nombre: string;
  token_acceso: string | null;
  fecha_programada: string | null;
  estado: string;
};

const fmt = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("es-MX", {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Sin fecha";

export default function VisitasPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [houseId, setHouseId] = useState<string | null>(null);
  const [visitas, setVisitas] = useState<Visita[]>([]);

  const [nombre, setNombre] = useState("");
  const [cuando, setCuando] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // pase activo (modal)
  const [pase, setPase] = useState<{ nombre: string; token: string } | null>(null);

  const cargarVisitas = useCallback(async (hid: string) => {
    const { data } = await supabaseBrowser
      .from("visitors")
      .select("id, nombre, token_acceso, fecha_programada, estado")
      .eq("house_id", hid)
      .order("fecha_programada", { ascending: false, nullsFirst: false })
      .limit(30);
    setVisitas((data as unknown as Visita[]) ?? []);
  }, []);

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabaseBrowser.auth.getUser();
      if (!user) return router.replace("/login");
      const { data: prof } = await supabaseBrowser
        .from("profiles")
        .select("house_id, approval_status")
        .eq("id", user.id)
        .maybeSingle();
      const p = prof as unknown as { house_id: string | null; approval_status: string } | null;
      if (!p || p.approval_status !== "aprobado") return router.replace("/esperando");
      setHouseId(p.house_id);
      if (p.house_id) await cargarVisitas(p.house_id);
      setReady(true);
    })();
  }, [router, cargarVisitas]);

  async function registrar() {
    setErr(null);
    if (!nombre.trim()) return setErr("Escribe el nombre del visitante.");
    setEnviando(true);
    const fechaISO = cuando ? new Date(cuando).toISOString() : new Date().toISOString();
    const { data, error } = await supabaseBrowser.rpc("registrar_visita", {
      p_nombre: nombre.trim(),
      p_fecha_programada: fechaISO,
    });
    setEnviando(false);
    if (error) return setErr(error.message.replace(/^.*?:\s/, ""));
    const res = data as unknown as { token: string };
    setPase({ nombre: nombre.trim(), token: res.token });
    setNombre("");
    setCuando("");
    if (houseId) await cargarVisitas(houseId);
  }

  async function cancelar(id: string) {
    const { error } = await supabaseBrowser.rpc("cancelar_visita", { p_id: id });
    if (!error && houseId) await cargarVisitas(houseId);
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

        <h1 className="text-2xl font-bold text-slate-800 mt-4">Registrar visita</h1>
        <p className="text-sm text-slate-500">
          Genera un pase con QR y compártelo por WhatsApp con tu invitado.
        </p>

        {/* ¿Tu visita llegó a pie? Mírala en la cámara y ábrele desde aquí. */}
        <CamaraPuerta />
        <p className="text-[11px] text-slate-400 -mt-1 px-1">
          ¿Tu visita llega a pie? Mírala en la cámara y ábrele — la apertura
          queda registrada a tu nombre.
        </p>

        {/* Formulario */}
        <section className="mt-5 bg-white rounded-2xl ring-1 ring-slate-100 p-4 flex flex-col gap-3">
          <label className="text-xs text-slate-500">
            Nombre del visitante
            <input
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              placeholder="Ej. María López"
              className="mt-1 w-full rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
            />
          </label>
          <label className="text-xs text-slate-500">
            ¿Cuándo llega? (opcional)
            <input
              type="datetime-local"
              value={cuando}
              onChange={(e) => setCuando(e.target.value)}
              className="mt-1 w-full rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
            />
          </label>
          {err && (
            <p className="text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2 ring-1 ring-red-200">
              {err}
            </p>
          )}
          <button
            onClick={registrar}
            disabled={enviando}
            className="rounded-2xl bg-gradient-to-br from-brand-500 to-emerald-600 text-white py-3.5 font-extrabold shadow-lg disabled:opacity-40 active:scale-[0.99] transition"
          >
            {enviando ? "Generando…" : "Generar pase de visita"}
          </button>
        </section>

        {/* Mis visitas */}
        <section className="mt-7">
          <h2 className="text-sm font-bold text-slate-700 mb-2">
            Mis visitas <span className="text-slate-400 font-medium">({visitas.length})</span>
          </h2>
          {visitas.length === 0 ? (
            <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
              Aún no registras visitas.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {visitas.map((v) => (
                <li
                  key={v.id}
                  className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-800 truncate">{v.nombre}</p>
                    <p className="text-xs text-slate-500">{fmt(v.fecha_programada)}</p>
                    <span
                      className={`inline-block mt-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                        v.estado === "adentro"
                          ? "bg-emerald-50 text-emerald-700"
                          : v.estado === "completada"
                          ? "bg-slate-100 text-slate-500"
                          : "bg-amber-50 text-amber-700"
                      }`}
                    >
                      {v.estado}
                    </span>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    {v.token_acceso && v.estado === "esperando" && (
                      <button
                        onClick={() => setPase({ nombre: v.nombre, token: v.token_acceso! })}
                        className="press rounded-xl bg-brand-500 text-white text-xs font-semibold px-3 py-2 hover:bg-brand-600"
                      >
                        Ver pase
                      </button>
                    )}
                    {v.estado === "esperando" && (
                      <button
                        onClick={() => cancelar(v.id)}
                        className="press-soft rounded-xl border border-slate-200 text-slate-500 text-xs font-semibold px-3 py-2 hover:bg-slate-50"
                      >
                        Cancelar
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {pase && <PaseModal nombre={pase.nombre} token={pase.token} onClose={() => setPase(null)} />}
    </main>
  );
}

function PaseModal({
  nombre,
  token,
  onClose,
}: {
  nombre: string;
  token: string;
  onClose: () => void;
}) {
  const [qr, setQr] = useState<string>("");
  const [url, setUrl] = useState<string>("");

  useEffect(() => {
    const u = `${window.location.origin}/visita/${token}`;
    setUrl(u);
    QRCode.toDataURL(u, { width: 320, margin: 1 }).then(setQr).catch(() => setQr(""));
  }, [token]);

  const waText = encodeURIComponent(
    `¡Hola! Te comparto tu pase de visita en Vecinity. Muéstralo en la caseta:\n${url}`
  );

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-3xl p-6 w-full max-w-sm text-center"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm text-slate-500">Pase de visita</p>
        <h3 className="text-xl font-bold text-slate-800 mb-4">{nombre}</h3>
        {qr ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={qr} alt="QR del pase" className="mx-auto rounded-2xl ring-1 ring-slate-100" width={240} height={240} />
        ) : (
          <div className="h-[240px] flex items-center justify-center text-slate-400">Generando QR…</div>
        )}
        <p className="text-xs text-slate-400 mt-3 break-all">{url}</p>
        <a
          href={`https://wa.me/?text=${waText}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 block w-full rounded-2xl bg-[#25D366] text-white py-3.5 font-bold shadow active:scale-[0.99] transition"
        >
          Compartir por WhatsApp
        </a>
        <button onClick={onClose} className="mt-3 text-sm text-slate-500 hover:text-slate-700">
          Cerrar
        </button>
      </div>
    </div>
  );
}
