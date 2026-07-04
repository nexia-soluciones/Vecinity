"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/browser";

// Tiempo que hay que mantener presionado el SOS para activarlo (evita disparos accidentales)
const SOS_HOLD_MS = 2500;

export type SosState = "idle" | "holding" | "sending" | "sent" | "error";
export type SosAlerta = {
  id: string;
  casa: string | null;
  calle: string | null;
  colonia: string | null;
};

// Captura la ubicación del dispositivo; si se niega o no hay GPS, devuelve null (no bloquea la alerta)
function getCoords(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
    );
  });
}

/** Lógica compartida del botón de pánico: hold de 2.5s → RPC disparar_sos (resuelve
 *  casa y ZONA en BD → capitán sí recibe) → modal con datos listos para el 911. */
export function useSos() {
  const [sosState, setSosState] = useState<SosState>("idle");
  const [holdPct, setHoldPct] = useState(0);
  const [alerta, setAlerta] = useState<SosAlerta | null>(null);
  const holdTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const holdStart = useRef(0);

  const disparar = useCallback(async () => {
    setSosState("sending");
    const coords = await getCoords();
    const { data, error } = await supabaseBrowser.rpc("disparar_sos", {
      p_lat: coords?.lat ?? null,
      p_lng: coords?.lng ?? null,
      p_mode: "loud",
    });
    if (error) {
      setSosState("error");
      return;
    }
    const r = data as unknown as { id: string; casa: string | null; calle: string | null; colonia: string | null };
    setAlerta({ id: r.id, casa: r.casa, calle: r.calle, colonia: r.colonia });
    setSosState("sent");
  }, []);

  const clearHold = useCallback(() => {
    if (holdTimer.current) {
      clearInterval(holdTimer.current);
      holdTimer.current = null;
    }
  }, []);

  const startHold = useCallback(() => {
    if (sosState === "sending" || sosState === "sent") return;
    setSosState("holding");
    setHoldPct(0);
    holdStart.current = Date.now();
    holdTimer.current = setInterval(() => {
      const pct = Math.min(100, ((Date.now() - holdStart.current) / SOS_HOLD_MS) * 100);
      setHoldPct(pct);
      if (pct >= 100) {
        clearHold();
        setHoldPct(0);
        disparar();
      }
    }, 50);
  }, [sosState, disparar, clearHold]);

  const cancelHold = useCallback(() => {
    clearHold();
    setSosState((s) => (s === "holding" ? "idle" : s));
    setHoldPct(0);
  }, [clearHold]);

  const cerrar = useCallback(() => {
    setAlerta(null);
    setSosState("idle");
  }, []);

  // Limpia el temporizador si el componente se desmonta a medio hold
  useEffect(() => clearHold, [clearHold]);

  return { sosState, holdPct, alerta, startHold, cancelHold, cerrar };
}

/** Pantalla de emergencia post-SOS: confirmación + datos para dictar al 911. */
export function SosModal({ alerta, onClose }: { alerta: SosAlerta; onClose: () => void }) {
  async function llamar911() {
    // registra en la bitácora del incidente que se marcó al 911 (best-effort)
    try {
      await supabaseBrowser.rpc("sos_marcar_911", { p_id: alerta.id });
    } catch {
      /* la llamada es lo importante */
    }
  }
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-3xl p-6 shadow-2xl">
        <p className="text-3xl">🚨</p>
        <h2 className="text-xl font-bold text-slate-800 mt-1">Alerta enviada</h2>
        <p className="text-sm text-slate-600 mt-1">
          El comité, el capitán de tu zona y los vecinos vigilantes ya fueron avisados con tu
          ubicación. Te confirmamos por Telegram cuando alguien vaya en camino.
        </p>
        <div className="mt-4 rounded-2xl bg-red-50 ring-1 ring-red-200 p-4">
          <p className="text-xs font-bold text-red-700 uppercase tracking-wide">
            Si es una emergencia grave, llama al 911 y dicta:
          </p>
          <p className="text-sm text-slate-800 mt-2 font-semibold">
            {alerta.calle ? `${alerta.calle} ` : ""}
            {alerta.casa ? `#${alerta.casa}` : "Tu domicilio"}
          </p>
          {alerta.colonia && <p className="text-sm text-slate-700">{alerta.colonia}</p>}
        </div>
        <a
          href="tel:911"
          onClick={llamar911}
          className="mt-4 block w-full text-center rounded-2xl bg-red-600 text-white py-3.5 font-extrabold text-lg shadow-lg active:scale-[0.99]"
        >
          📞 Llamar al 911
        </a>
        <button
          onClick={onClose}
          className="mt-2 w-full rounded-2xl ring-1 ring-slate-200 text-slate-600 py-3 font-semibold"
        >
          Estoy a salvo — cerrar
        </button>
      </div>
    </div>
  );
}

/** FAB rojo persistente: disponible en TODAS las páginas del dashboard (excepto el
 *  home, que tiene su botón grande) para no tener que navegar de regreso en una
 *  emergencia. Oculto para el dueño externo (no vive en la colonia). */
export function SosFab() {
  const pathname = usePathname();
  const { sosState, holdPct, alerta, startHold, cancelHold, cerrar } = useSos();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabaseBrowser.auth.getUser();
      if (!user) return;
      const { data } = await supabaseBrowser
        .from("profiles")
        .select("house_id, role, approval_status")
        .eq("id", user.id)
        .maybeSingle();
      const p = data as unknown as { house_id: string | null; role: string; approval_status: string } | null;
      setVisible(!!p && p.approval_status === "aprobado" && !!p.house_id && p.role !== "guardia");
    })();
  }, []);

  if (pathname === "/dashboard" || !visible) return null;

  return (
    <>
      <button
        onPointerDown={startHold}
        onPointerUp={cancelHold}
        onPointerLeave={cancelHold}
        onPointerCancel={cancelHold}
        onContextMenu={(e) => e.preventDefault()}
        disabled={sosState === "sending" || sosState === "sent"}
        aria-label="Botón de pánico — mantén presionado"
        className="fixed bottom-5 right-5 z-40 h-16 w-16 rounded-full bg-gradient-to-br from-red-500 to-red-600 text-white shadow-xl select-none touch-none flex items-center justify-center text-xl font-extrabold active:scale-95 transition"
      >
        {sosState === "holding" ? (
          <span className="text-xs">{Math.round(holdPct)}%</span>
        ) : sosState === "sending" ? (
          "…"
        ) : (
          "🆘"
        )}
        {sosState === "holding" && (
          <span
            className="absolute inset-0 rounded-full ring-4 ring-red-300"
            style={{ clipPath: `inset(${100 - holdPct}% 0 0 0)` }}
            aria-hidden
          />
        )}
      </button>
      {sosState === "error" && (
        <p className="fixed bottom-24 right-5 z-40 text-xs bg-red-50 text-red-700 ring-1 ring-red-200 rounded-xl px-3 py-2 shadow">
          No se envió — mantén presionado de nuevo
        </p>
      )}
      {alerta && <SosModal alerta={alerta} onClose={cerrar} />}
    </>
  );
}
