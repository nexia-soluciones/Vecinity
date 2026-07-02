"use client";

import { useEffect, useState } from "react";

// Evento no estándar de Chrome/Android para instalar la PWA.
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const DISMISS_KEY = "vecinity-pwa-dismissed";
const DISMISS_DAYS = 7;

function esIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return (
    /iphone|ipad|ipod/i.test(ua) ||
    // iPadOS se reporta como Mac con pantalla táctil
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}
function yaInstalada(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}
function descartadaReciente(): boolean {
  try {
    const t = localStorage.getItem(DISMISS_KEY);
    if (!t) return false;
    return Date.now() - Number(t) < DISMISS_DAYS * 86400000;
  } catch {
    return false;
  }
}

// Barra de "Instala la app": en Android dispara el instalador nativo con un
// toque; en iPhone (Safari no permite instalación por código) abre un
// instructivo visual. Se oculta si ya está instalada o si se descartó.
export function InstallAppButton() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);
  const [ios, setIos] = useState(false);
  const [guiaIOS, setGuiaIOS] = useState(false);

  useEffect(() => {
    // Registrar el service worker (requisito para "Instalar" en Android).
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
    if (yaInstalada() || descartadaReciente()) return;

    if (esIOS()) {
      setIos(true);
      setVisible(true);
      return;
    }
    const onPrompt = (e: Event) => {
      e.preventDefault(); // evita el mini-infobar nativo; usamos nuestro botón
      setDeferred(e as BeforeInstallPromptEvent);
      setVisible(true);
    };
    const onInstalled = () => {
      setVisible(false);
      try {
        localStorage.setItem(DISMISS_KEY, String(Date.now()));
      } catch {}
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  function cerrar() {
    setVisible(false);
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {}
  }

  async function instalar() {
    if (ios) {
      setGuiaIOS(true);
      return;
    }
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <>
      <div className="fixed inset-x-0 bottom-0 z-40 p-3 pointer-events-none">
        <div className="pointer-events-auto mx-auto max-w-md rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200 p-3 flex items-center gap-3">
          <span className="text-2xl shrink-0">📲</span>
          <div className="min-w-0 flex-1">
            <p className="font-bold text-slate-800 text-sm leading-tight">Instala Vecinity</p>
            <p className="text-xs text-slate-500 leading-tight">
              Ábrela como app desde tu pantalla de inicio.
            </p>
          </div>
          <button
            onClick={instalar}
            className="shrink-0 rounded-xl bg-brand-500 text-white font-semibold text-sm px-4 py-2 hover:bg-brand-600"
          >
            {ios ? "Cómo" : "Instalar"}
          </button>
          <button
            onClick={cerrar}
            aria-label="Cerrar"
            className="shrink-0 text-slate-400 hover:text-slate-600 text-lg px-1"
          >
            ✕
          </button>
        </div>
      </div>

      {guiaIOS && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-end justify-center p-4"
          onClick={() => setGuiaIOS(false)}
        >
          <div
            className="bg-white w-full max-w-sm rounded-3xl p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-slate-800">Instalar en iPhone</h3>
              <button onClick={() => setGuiaIOS(false)} className="text-slate-400 text-xl">
                ✕
              </button>
            </div>
            <ol className="flex flex-col gap-3 text-sm text-slate-700">
              <li className="flex items-start gap-3">
                <span className="shrink-0 w-6 h-6 rounded-full bg-brand-100 text-brand-700 font-bold flex items-center justify-center text-xs">
                  1
                </span>
                <span>
                  Toca el botón <span className="font-semibold">Compartir</span>{" "}
                  <span className="inline-block align-middle text-brand-600 font-bold">⎋</span> en la
                  barra de abajo de Safari.
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="shrink-0 w-6 h-6 rounded-full bg-brand-100 text-brand-700 font-bold flex items-center justify-center text-xs">
                  2
                </span>
                <span>
                  Desliza y elige{" "}
                  <span className="font-semibold">&ldquo;Agregar a inicio&rdquo;</span> (Add to Home
                  Screen).
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="shrink-0 w-6 h-6 rounded-full bg-brand-100 text-brand-700 font-bold flex items-center justify-center text-xs">
                  3
                </span>
                <span>
                  Toca <span className="font-semibold">&ldquo;Agregar&rdquo;</span>. ¡Listo! Vecinity
                  queda como app en tu pantalla.
                </span>
              </li>
            </ol>
            <p className="text-xs text-slate-400 mt-4">
              Nota: en iPhone esto solo funciona desde <span className="font-semibold">Safari</span>,
              no desde Chrome.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
