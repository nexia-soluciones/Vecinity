"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";

type Profile = {
  id: string;
  nombre: string;
  role: string;
  colonia_id: string | null;
  house_id: string | null;
  approval_status: string;
  colonia?: { nombre: string } | null;
};
type House = { numero: string; street: string | null; saldo: number };
type Pending = { id: string; nombre: string; email: string; created_at: string };

const money = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);

export default function Dashboard() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [house, setHouse] = useState<House | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [sosSent, setSosSent] = useState(false);
  const [ready, setReady] = useState(false);

  const isAdmin = profile?.role === "admin" || profile?.role === "comite";

  const loadPending = useCallback(async () => {
    const { data } = await supabaseBrowser
      .from("profiles")
      .select("id, nombre, email, created_at")
      .eq("approval_status", "pendiente")
      .order("created_at", { ascending: false });
    setPending(data ?? []);
  }, []);

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabaseBrowser.auth.getUser();
      if (!user) return router.replace("/login");

      const { data: prof } = await supabaseBrowser
        .from("profiles")
        .select(
          "id, nombre, role, colonia_id, house_id, approval_status, colonia:colonias(nombre)"
        )
        .eq("id", user.id)
        .maybeSingle();

      const p = prof as unknown as Profile | null;
      if (!p) return router.replace("/esperando");
      if (p.approval_status !== "aprobado") return router.replace("/esperando");
      setProfile(p);

      if (p.house_id) {
        const { data: h } = await supabaseBrowser
          .from("houses")
          .select("numero, street, saldo")
          .eq("id", p.house_id)
          .maybeSingle();
        setHouse(h as unknown as House | null);
      }
      if (p.role === "admin" || p.role === "comite") await loadPending();
      setReady(true);
    })();
  }, [router, loadPending]);

  async function activarSOS() {
    if (!profile?.colonia_id) return;
    await supabaseBrowser.from("sos_events").insert({
      colonia_id: profile.colonia_id,
      profile_id: profile.id,
      house_id: profile.house_id,
      mode: "loud",
    });
    setSosSent(true);
    setTimeout(() => setSosSent(false), 4000);
  }

  async function resolver(id: string, status: "aprobado" | "rechazado") {
    await supabaseBrowser
      .from("profiles")
      .update({ approval_status: status })
      .eq("id", id);
    setPending((list) => list.filter((x) => x.id !== id));
  }

  async function salir() {
    await supabaseBrowser.auth.signOut();
    router.replace("/login");
  }

  if (!ready)
    return (
      <main className="flex-1 flex items-center justify-center text-slate-400">
        Cargando…
      </main>
    );

  const saldo = house?.saldo ?? 0;
  const conAdeudo = saldo > 0;

  return (
    <main className="flex-1 bg-gradient-to-b from-brand-50 via-white to-sky-50">
      <div className="w-full max-w-md mx-auto px-5 py-6 flex flex-col">
        {/* Top bar */}
        <div className="flex items-center justify-between">
          <Image src="/brand/vecinity-logo.svg" alt="Vecinity" width={150} height={43} priority />
          <button
            onClick={salir}
            className="text-xs text-slate-400 hover:text-slate-600"
          >
            Salir
          </button>
        </div>

        {/* Saludo */}
        <div className="mt-5">
          <p className="text-slate-500 text-sm">
            {profile?.colonia?.nombre ?? "Tu colonia"}
          </p>
          <h1 className="text-2xl font-bold text-slate-800">
            Hola, {profile?.nombre?.split(" ")[0]} 👋
          </h1>
          {isAdmin && (
            <span className="inline-block mt-1 text-[11px] font-semibold tracking-wide text-nexia bg-purple-50 rounded-full px-2.5 py-0.5">
              {profile?.role === "admin" ? "ADMINISTRADOR" : "COMITÉ"}
            </span>
          )}
        </div>

        {/* Saldo */}
        {house && (
          <div
            className={`mt-5 rounded-3xl p-5 text-white shadow-lg ${
              conAdeudo
                ? "bg-gradient-to-br from-amber-500 to-orange-600"
                : "bg-gradient-to-br from-brand-500 to-emerald-600"
            }`}
          >
            <p className="text-white/80 text-sm">
              Casa {house.numero}
              {house.street ? ` · ${house.street}` : ""}
            </p>
            <p className="text-3xl font-extrabold mt-1">{money(saldo)}</p>
            <p className="text-white/90 text-sm mt-1">
              {conAdeudo ? "Saldo pendiente por pagar" : "Estás al corriente ✓"}
            </p>
          </div>
        )}

        {/* Acciones rápidas */}
        <div className="grid grid-cols-2 gap-3 mt-5">
          <Action emoji="💳" label="Pagar / Subir comprobante" />
          <Action emoji="🚗" label="Mis vehículos" />
          <Action emoji="👮" label="Registrar visita" />
          <Action emoji="📣" label="Reportar incidencia" />
        </div>

        {/* Botón SOS */}
        <button
          onClick={activarSOS}
          className="mt-5 rounded-3xl bg-gradient-to-br from-red-500 to-red-600 text-white py-5 font-extrabold text-lg shadow-lg active:scale-[0.99] transition"
        >
          {sosSent ? "🚨 SOS enviado al comité" : "🆘 Botón de pánico (SOS)"}
        </button>

        {/* Panel comité — aprobaciones */}
        {isAdmin && (
          <section className="mt-7">
            <h2 className="text-sm font-bold text-slate-700 mb-2">
              Solicitudes pendientes{" "}
              <span className="text-slate-400 font-medium">({pending.length})</span>
            </h2>
            {pending.length === 0 ? (
              <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
                No hay solicitudes por revisar 🎉
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {pending.map((u) => (
                  <li
                    key={u.id}
                    className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100 flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-800 truncate">{u.nombre}</p>
                      <p className="text-xs text-slate-400 truncate">{u.email}</p>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button
                        onClick={() => resolver(u.id, "aprobado")}
                        className="rounded-xl bg-brand-500 text-white text-sm font-semibold px-3 py-2 hover:bg-brand-600"
                      >
                        Aprobar
                      </button>
                      <button
                        onClick={() => resolver(u.id, "rechazado")}
                        className="rounded-xl border border-slate-200 text-slate-500 text-sm font-semibold px-3 py-2 hover:bg-slate-50"
                      >
                        No
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <footer className="mt-10 mb-2 flex justify-center">
          <Image
            src="/brand/powered-by-nexia.svg"
            alt="Powered by NexIA"
            width={140}
            height={28}
            className="opacity-80"
          />
        </footer>
      </div>
    </main>
  );
}

function Action({ emoji, label }: { emoji: string; label: string }) {
  return (
    <button className="bg-white rounded-2xl p-4 ring-1 ring-slate-100 text-left hover:ring-brand-200 transition">
      <span className="text-2xl">{emoji}</span>
      <p className="text-sm font-medium text-slate-700 mt-2 leading-tight">{label}</p>
    </button>
  );
}
