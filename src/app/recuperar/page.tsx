"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";

export default function Recuperar() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enviar() {
    const correo = email.trim().toLowerCase();
    if (!correo || !correo.includes("@")) {
      return setError("Escribe un correo válido.");
    }
    setError(null);
    setLoading(true);
    // El redirect apunta a /reset-password en ESTE mismo origen; el dominio
    // debe estar en el allow-list de GoTrue para que no caiga al SITE_URL.
    const { error: e } = await supabaseBrowser.auth.resetPasswordForEmail(correo, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setLoading(false);
    // Mensaje genérico siempre (aunque el correo no exista) → evita revelar
    // qué correos están registrados (anti-enumeración).
    if (e) {
      // Solo errores de red/servidor se muestran; "usuario no existe" NO llega
      // como error en este endpoint.
      return setError("No pudimos procesar la solicitud. Intenta de nuevo en un momento.");
    }
    setSent(true);
  }

  return (
    <main className="flex-1 flex flex-col bg-gradient-to-b from-brand-50 via-white to-sky-50">
      <div className="w-full max-w-md mx-auto flex-1 flex flex-col items-center justify-center px-5 py-8">
        <Image src="/brand/vecinity-logo.svg" alt="Vecinity" width={200} height={57} priority />
        <p className="mt-3 mb-7 text-slate-500 text-sm">Recupera el acceso a tu cuenta</p>

        <section className="w-full bg-white rounded-3xl shadow-[0_10px_40px_-12px_rgba(16,185,129,0.25)] ring-1 ring-slate-100 p-6 sm:p-7">
          {sent ? (
            <>
              <h1 className="text-xl font-bold text-slate-800 mb-3">Revisa tu correo</h1>
              <p className="text-sm text-slate-600 leading-relaxed">
                Si <span className="font-semibold text-slate-800">{email.trim().toLowerCase()}</span>{" "}
                está registrado, te enviamos un enlace para crear una nueva contraseña.
                Puede tardar un par de minutos; revisa también la carpeta de spam.
              </p>
              <Link href="/login" className="btn-primary w-full mt-6 inline-block text-center">
                Volver a iniciar sesión
              </Link>
            </>
          ) : (
            <>
              <h1 className="text-xl font-bold text-slate-800 mb-2">¿Olvidaste tu contraseña?</h1>
              <p className="text-sm text-slate-500 mb-5">
                Escribe tu correo y te enviamos un enlace para restablecerla.
              </p>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && enviar()}
                placeholder="Correo electrónico"
                inputMode="email"
                type="email"
                className="input"
              />
              {error && (
                <p className="mt-4 text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2">{error}</p>
              )}
              <button onClick={enviar} disabled={loading} className="btn-primary w-full mt-6">
                {loading ? "Enviando…" : "Enviar enlace"}
              </button>
              <p className="text-center text-sm text-slate-400 mt-5">
                <Link href="/login" className="text-brand-600 font-semibold hover:underline">
                  Volver a iniciar sesión
                </Link>
              </p>
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
