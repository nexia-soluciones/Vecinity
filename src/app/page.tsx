"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { validateInvitation, completeOnboarding, type InvitationInfo } from "./actions";
import { supabaseBrowser } from "@/lib/supabase/browser";

const STEPS = ["Invitación", "Tus datos", "Alertas", "Listo"];
const TELEGRAM_BOT = process.env.NEXT_PUBLIC_TELEGRAM_BOT;

export default function Onboarding() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<InvitationInfo | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [form, setForm] = useState({
    code: "",
    nombre: "",
    email: "",
    password: "",
    telefono: "",
    telegram: false,
  });
  const set = (k: string, v: string | boolean) =>
    setForm((f) => ({ ...f, [k]: v }));

  // Paso 1 → valida invitación
  async function onValidate() {
    setError(null);
    setLoading(true);
    const res = await validateInvitation(form.code);
    setLoading(false);
    if (!res.ok) return setError(res.error ?? "Código no válido.");
    setInvite(res);
    setStep(1);
  }

  // Paso 2 → crea cuenta + perfil, e inicia sesión
  async function onCreate() {
    setError(null);
    setLoading(true);
    const res = await completeOnboarding({
      token: form.code,
      nombre: form.nombre,
      email: form.email,
      password: form.password,
      telefono: form.telefono,
    });
    if (!res.ok) {
      setLoading(false);
      return setError(res.error ?? "No se pudo crear la cuenta.");
    }
    if (res.linked) {
      // Ya tenía cuenta: se le ligó la casa como propietario; entra con su
      // contraseña de siempre (la que escribió aquí no reemplaza la suya).
      setLoading(false);
      router.push("/login?linked=1");
      return;
    }
    setProfileId(res.profileId ?? null);
    // Iniciar sesión para dejar la sesión activa
    await supabaseBrowser.auth.signInWithPassword({
      email: form.email.trim().toLowerCase(),
      password: form.password,
    });
    setLoading(false);
    setStep(2);
  }

  function connectTelegram() {
    set("telegram", true);
    if (TELEGRAM_BOT && profileId) {
      window.open(
        `https://t.me/${TELEGRAM_BOT}?start=vecino_${profileId}`,
        "_blank"
      );
    }
  }

  return (
    <main className="flex-1 flex flex-col bg-gradient-to-b from-brand-50 via-white to-sky-50">
      <div className="w-full max-w-md mx-auto flex-1 flex flex-col items-center px-5 py-8">
        {/* Header */}
        <header className="w-full max-w-md flex flex-col items-center pt-4 pb-6">
          <Image
            src="/brand/vecinity-logo.svg"
            alt="Vecinity"
            width={210}
            height={60}
            priority
          />
          <p className="mt-3 text-slate-500 text-sm text-center">
            Tu colonia, más segura y organizada
          </p>
        </header>

        {/* Card */}
        <section className="w-full max-w-md bg-white rounded-3xl shadow-[0_10px_40px_-12px_rgba(16,185,129,0.25)] ring-1 ring-slate-100 p-6 sm:p-7 flex flex-col">
          {/* Progreso */}
          <div className="flex items-center gap-2 mb-7">
            {STEPS.map((label, i) => (
              <div key={label} className="flex-1 flex flex-col gap-1.5">
                <div
                  className={`h-1.5 rounded-full transition-colors ${
                    i <= step ? "bg-brand-500" : "bg-slate-200"
                  }`}
                />
                <span
                  className={`text-[10px] font-medium tracking-wide ${
                    i <= step ? "text-brand-600" : "text-slate-400"
                  }`}
                >
                  {label}
                </span>
              </div>
            ))}
          </div>

          {/* Paso 1 — Invitación */}
          {step === 0 && (
            <Step
              icon="🎟️"
              title="Entra con tu invitación"
              subtitle="Usa el código que te compartió el comité de tu colonia."
            >
              <input
                value={form.code}
                onChange={(e) => set("code", e.target.value.toUpperCase())}
                placeholder="CÓDIGO DE INVITACIÓN"
                className="input tracking-[0.2em] text-center"
              />
            </Step>
          )}

          {/* Paso 2 — Datos */}
          {step === 1 && (
            <Step
              icon="🙋"
              title="Crea tu cuenta"
              subtitle={
                invite?.colonia
                  ? `${invite.colonia.nombre}${
                      invite.street ? " · " + invite.street : ""
                    }`
                  : "Solo lo indispensable."
              }
            >
              <input
                value={form.nombre}
                onChange={(e) => set("nombre", e.target.value)}
                placeholder="Nombre completo"
                className="input"
              />
              <input
                value={form.email}
                onChange={(e) => set("email", e.target.value)}
                placeholder="Correo electrónico"
                inputMode="email"
                className="input mt-3"
              />
              <input
                value={form.password}
                onChange={(e) => set("password", e.target.value)}
                placeholder="Contraseña (mín. 6)"
                type="password"
                className="input mt-3"
              />
              <input
                value={form.telefono}
                onChange={(e) => set("telefono", e.target.value)}
                placeholder="WhatsApp / Teléfono"
                inputMode="tel"
                className="input mt-3"
              />
            </Step>
          )}

          {/* Paso 3 — Telegram */}
          {step === 2 && (
            <Step
              icon="🔔"
              title="Conecta tus alertas"
              subtitle="Recibe el botón de pánico (SOS) de tu zona, avisos de pagos y noticias del comité — al instante por Telegram."
            >
              <button
                onClick={connectTelegram}
                className={`btn-telegram ${form.telegram ? "opacity-60" : ""}`}
                disabled={form.telegram}
              >
                {form.telegram ? "✓ Telegram conectado" : "Conectar Telegram"}
              </button>
              <button
                onClick={() => setStep(3)}
                className="text-slate-400 text-sm mt-3 underline-offset-2 hover:underline"
              >
                Lo hago después
              </button>
            </Step>
          )}

          {/* Paso 4 — Listo */}
          {step === 3 && (
            <div className="flex flex-col items-center text-center py-4">
              <div className="w-20 h-20 rounded-full bg-brand-50 flex items-center justify-center text-4xl mb-4 ring-8 ring-brand-50/50">
                ✅
              </div>
              <h2 className="text-xl font-bold text-slate-800">
                ¡Bienvenido a la comunidad!
              </h2>
              <p className="text-slate-500 text-sm mt-2 max-w-xs">
                Tu cuenta quedó creada. El comité de tu colonia te aprobará muy
                pronto y recibirás un aviso
                {form.telegram ? " por Telegram" : ""}.
              </p>
            </div>
          )}

          {/* Error */}
          {error && (
            <p className="mt-4 text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2">
              {error}
            </p>
          )}

          {/* Navegación */}
          {step === 0 && (
            <button onClick={onValidate} disabled={loading} className="btn-primary mt-7">
              {loading ? "Validando…" : "Continuar"}
            </button>
          )}
          {step === 1 && (
            <div className="flex gap-3 mt-7">
              <button onClick={() => setStep(0)} className="btn-secondary">
                Atrás
              </button>
              <button
                onClick={onCreate}
                disabled={loading}
                className="btn-primary flex-1"
              >
                {loading ? "Creando cuenta…" : "Crear cuenta"}
              </button>
            </div>
          )}
          {step === 2 && (
            <button onClick={() => setStep(3)} className="btn-primary mt-7">
              Finalizar
            </button>
          )}
          {step === 3 && (
            <button
              onClick={() => router.push("/esperando")}
              className="btn-primary w-full mt-7"
            >
              Entrar a Vecinity
            </button>
          )}
        </section>

        {/* ¿Ya tiene cuenta? */}
        <p className="text-center text-sm text-slate-400 mt-5">
          ¿Ya tienes cuenta?{" "}
          <Link href="/login" className="text-brand-600 font-semibold hover:underline">
            Inicia sesión
          </Link>
        </p>

        {/* Footer — Powered by NexIA */}
        <footer className="mt-auto pt-10">
          <Image
            src="/brand/powered-by-nexia.svg"
            alt="Powered by NexIA"
            width={150}
            height={30}
            className="opacity-90"
          />
        </footer>
      </div>
    </main>
  );
}

function Step({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: string;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <div className="text-3xl mb-2">{icon}</div>
      <h2 className="text-xl font-bold text-slate-800">{title}</h2>
      <p className="text-slate-500 text-sm mt-1.5 mb-5">{subtitle}</p>
      {children}
    </div>
  );
}
