"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";

export default function Esperando() {
  const router = useRouter();
  const [estado, setEstado] = useState<string>("cargando");
  const [nombre, setNombre] = useState<string>("");
  const [colonia, setColonia] = useState<string>("");

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabaseBrowser.auth.getUser();
      if (!user) {
        router.replace("/login");
        return;
      }
      const { data } = await supabaseBrowser
        .from("profiles")
        .select("nombre, approval_status, colonia:colonias(nombre)")
        .eq("id", user.id)
        .maybeSingle();
      if (data) {
        setNombre(data.nombre ?? "");
        setEstado(data.approval_status ?? "pendiente");
        const col = data.colonia as unknown as { nombre: string } | null;
        setColonia(col?.nombre ?? "");
      } else {
        setEstado("pendiente");
      }
    })();
  }, [router]);

  async function salir() {
    await supabaseBrowser.auth.signOut();
    router.replace("/login");
  }

  const aprobado = estado === "aprobado";

  return (
    <main className="flex-1 flex flex-col bg-gradient-to-b from-brand-50 via-white to-sky-50">
      <div className="w-full max-w-md mx-auto flex-1 flex flex-col items-center justify-center px-5 py-8 text-center">
        <Image src="/brand/vecinity-logo.svg" alt="Vecinity" width={190} height={54} priority />

        <div className="mt-8 w-full bg-white rounded-3xl shadow-[0_10px_40px_-12px_rgba(16,185,129,0.25)] ring-1 ring-slate-100 p-8 flex flex-col items-center">
          <div
            className={`w-20 h-20 rounded-full flex items-center justify-center text-4xl mb-4 ring-8 ${
              aprobado ? "bg-brand-50 ring-brand-50/50" : "bg-amber-50 ring-amber-50/50"
            }`}
          >
            {estado === "cargando" ? "⏳" : aprobado ? "🎉" : "🕓"}
          </div>

          {estado === "cargando" && (
            <p className="text-slate-500">Cargando tu estado…</p>
          )}

          {estado === "pendiente" && (
            <>
              <h1 className="text-xl font-bold text-slate-800">
                {nombre ? `¡Gracias, ${nombre.split(" ")[0]}!` : "¡Gracias!"}
              </h1>
              <p className="text-slate-500 text-sm mt-2">
                Tu solicitud para <b>{colonia || "tu colonia"}</b> está en revisión.
                El comité te aprobará pronto y te avisaremos.
              </p>
            </>
          )}

          {estado === "rechazado" && (
            <>
              <h1 className="text-xl font-bold text-slate-800">Solicitud no aprobada</h1>
              <p className="text-slate-500 text-sm mt-2">
                Contacta al comité de tu colonia para más información.
              </p>
            </>
          )}

          {aprobado && (
            <>
              <h1 className="text-xl font-bold text-slate-800">¡Ya eres parte de {colonia}!</h1>
              <p className="text-slate-500 text-sm mt-2">Tu acceso fue aprobado.</p>
              <button
                onClick={() => router.push("/dashboard")}
                className="btn-primary w-full mt-5"
              >
                Entrar al panel
              </button>
            </>
          )}

          <button
            onClick={salir}
            className="text-slate-400 text-sm mt-6 underline-offset-2 hover:underline"
          >
            Cerrar sesión
          </button>
        </div>

        <footer className="mt-10">
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
