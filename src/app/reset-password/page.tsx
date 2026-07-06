"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";

type Estado = "verificando" | "listo" | "invalido" | "guardando" | "hecho";

export default function ResetPassword() {
  const router = useRouter();
  const [estado, setEstado] = useState<Estado>("verificando");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Establecer la sesión de recuperación desde el enlace.
  useEffect(() => {
    let cancelado = false;
    const marcarListo = () => !cancelado && setEstado((s) => (s === "verificando" ? "listo" : s));

    // Canal email (flujo implícito): supabase-js procesa el hash y emite este evento.
    const { data: sub } = supabaseBrowser.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || (event === "SIGNED_IN" && session)) marcarListo();
    });

    (async () => {
      const url = new URL(window.location.href);
      const tokenHash = url.searchParams.get("token_hash");

      // Canal Caty (Telegram): enlace con ?token_hash=…&type=recovery
      if (tokenHash) {
        const { error: e } = await supabaseBrowser.auth.verifyOtp({
          token_hash: tokenHash,
          type: "recovery",
        });
        if (cancelado) return;
        setEstado(e ? "invalido" : "listo");
        return;
      }

      // Canal email: dar un instante a que supabase-js parsee el hash, luego verificar sesión.
      const { data } = await supabaseBrowser.auth.getSession();
      if (cancelado) return;
      if (data.session) return marcarListo();
      setTimeout(async () => {
        const { data: d2 } = await supabaseBrowser.auth.getSession();
        if (cancelado) return;
        setEstado(d2.session ? "listo" : "invalido");
      }, 1800);
    })();

    return () => {
      cancelado = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  async function guardar() {
    if (password.length < 8) return setError("La contraseña debe tener al menos 8 caracteres.");
    if (password !== confirm) return setError("Las contraseñas no coinciden.");
    setError(null);
    setEstado("guardando");
    const { error: e } = await supabaseBrowser.auth.updateUser({ password });
    if (e) {
      setEstado("listo");
      return setError("No pudimos actualizar la contraseña. El enlace pudo expirar; solicita uno nuevo.");
    }
    // Cerrar la sesión de recuperación para forzar login limpio con la nueva contraseña.
    await supabaseBrowser.auth.signOut();
    setEstado("hecho");
    setTimeout(() => router.replace("/login?reset=1"), 1600);
  }

  return (
    <main className="flex-1 flex flex-col bg-gradient-to-b from-brand-50 via-white to-sky-50">
      <div className="w-full max-w-md mx-auto flex-1 flex flex-col items-center justify-center px-5 py-8">
        <Image src="/brand/vecinity-logo.svg" alt="Vecinity" width={200} height={57} priority />
        <p className="mt-3 mb-7 text-slate-500 text-sm">Crea una nueva contraseña</p>

        <section className="w-full bg-white rounded-3xl shadow-[0_10px_40px_-12px_rgba(16,185,129,0.25)] ring-1 ring-slate-100 p-6 sm:p-7">
          {estado === "verificando" && (
            <p className="text-sm text-slate-500 text-center py-4">Verificando el enlace…</p>
          )}

          {estado === "invalido" && (
            <>
              <h1 className="text-xl font-bold text-slate-800 mb-3">Enlace inválido o expirado</h1>
              <p className="text-sm text-slate-600 leading-relaxed">
                Este enlace ya no es válido. Solicita uno nuevo para restablecer tu contraseña.
              </p>
              <Link href="/recuperar" className="btn-primary w-full mt-6 inline-block text-center">
                Solicitar nuevo enlace
              </Link>
            </>
          )}

          {estado === "hecho" && (
            <>
              <h1 className="text-xl font-bold text-emerald-700 mb-3">¡Contraseña actualizada!</h1>
              <p className="text-sm text-slate-600">
                Ya puedes iniciar sesión con tu nueva contraseña. Redirigiendo…
              </p>
            </>
          )}

          {(estado === "listo" || estado === "guardando") && (
            <>
              <h1 className="text-xl font-bold text-slate-800 mb-5">Nueva contraseña</h1>
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Nueva contraseña (mín. 8 caracteres)"
                type="password"
                autoComplete="new-password"
                className="input"
              />
              <input
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && guardar()}
                placeholder="Repite la contraseña"
                type="password"
                autoComplete="new-password"
                className="input mt-3"
              />
              {error && (
                <p className="mt-4 text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2">{error}</p>
              )}
              <button
                onClick={guardar}
                disabled={estado === "guardando"}
                className="btn-primary w-full mt-6"
              >
                {estado === "guardando" ? "Guardando…" : "Guardar contraseña"}
              </button>
            </>
          )}
        </section>

        <footer className="mt-10">
          <Image src="/brand/powered-by-nexia.svg" alt="Powered by NexIA" width={150} height={30} className="opacity-90" />
        </footer>
      </div>
    </main>
  );
}
