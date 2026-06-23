"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function entrar() {
    setError(null);
    setLoading(true);
    const { data, error: e } = await supabaseBrowser.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });
    if (e || !data.user) {
      setLoading(false);
      return setError("Correo o contraseña incorrectos.");
    }
    const { data: prof } = await supabaseBrowser
      .from("profiles")
      .select("approval_status")
      .eq("id", data.user.id)
      .maybeSingle();
    setLoading(false);
    router.replace(prof?.approval_status === "aprobado" ? "/dashboard" : "/esperando");
  }

  return (
    <main className="flex-1 flex flex-col bg-gradient-to-b from-brand-50 via-white to-sky-50">
      <div className="w-full max-w-md mx-auto flex-1 flex flex-col items-center justify-center px-5 py-8">
        <Image src="/brand/vecinity-logo.svg" alt="Vecinity" width={200} height={57} priority />
        <p className="mt-3 mb-7 text-slate-500 text-sm">Bienvenido de vuelta a tu colonia</p>

        <section className="w-full bg-white rounded-3xl shadow-[0_10px_40px_-12px_rgba(16,185,129,0.25)] ring-1 ring-slate-100 p-6 sm:p-7">
          <h1 className="text-xl font-bold text-slate-800 mb-5">Iniciar sesión</h1>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Correo electrónico"
            inputMode="email"
            className="input"
          />
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && entrar()}
            placeholder="Contraseña"
            type="password"
            className="input mt-3"
          />
          {error && (
            <p className="mt-4 text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2">{error}</p>
          )}
          <button onClick={entrar} disabled={loading} className="btn-primary w-full mt-6">
            {loading ? "Entrando…" : "Entrar"}
          </button>
          <p className="text-center text-sm text-slate-400 mt-5">
            ¿Tienes una invitación?{" "}
            <Link href="/" className="text-brand-600 font-semibold hover:underline">
              Regístrate
            </Link>
          </p>
        </section>

        <footer className="mt-10">
          <Image src="/brand/powered-by-nexia.svg" alt="Powered by NexIA" width={150} height={30} className="opacity-90" />
        </footer>
      </div>
    </main>
  );
}
