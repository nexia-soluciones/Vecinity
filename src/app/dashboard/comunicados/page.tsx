"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { callRpc } from "@/lib/rpc";

type Comunicado = {
  id: string;
  house_id: string | null;
  titulo: string;
  mensaje: string;
  autor: string;
  verificado_comite: boolean;
  tipo: string;
  leido_at: string | null;
  created_at: string;
  house: { numero: string } | null;
};

const fecha = (iso: string) =>
  new Date(iso).toLocaleString("es-MX", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const COLS =
  "id, house_id, titulo, mensaje, autor, verificado_comite, tipo, leido_at, created_at, house:houses(numero)";

export default function ComunicadosPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [lista, setLista] = useState<Comunicado[]>([]);

  // compose (comité)
  const [casas, setCasas] = useState<{ id: string; numero: string }[]>([]);
  const [destino, setDestino] = useState(""); // "" = público, o house_id
  const [titulo, setTitulo] = useState("");
  const [mensaje, setMensaje] = useState("");
  const [comoCaty, setComoCaty] = useState(true);
  const [verificado, setVerificado] = useState(true);
  const [tipo, setTipo] = useState("aviso");
  const [enviando, setEnviando] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    const { data } = await supabaseBrowser
      .from("comunicados")
      .select(COLS)
      .order("created_at", { ascending: false })
      .limit(100);
    setLista((data as unknown as Comunicado[]) ?? []);
  }, []);

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabaseBrowser.auth.getUser();
      if (!user) return router.replace("/login");
      const { data: prof } = await supabaseBrowser
        .from("profiles")
        .select("role, approval_status")
        .eq("id", user.id)
        .maybeSingle();
      const p = prof as unknown as { role: string; approval_status: string } | null;
      if (!p || p.approval_status !== "aprobado") return router.replace("/esperando");
      const admin = p.role === "admin" || p.role === "comite";
      setIsAdmin(admin);
      if (admin) {
        const { data: hs } = await supabaseBrowser.from("houses").select("id, numero").order("numero");
        setCasas((hs as unknown as { id: string; numero: string }[]) ?? []);
      }
      await cargar();
      setReady(true);
      // marca leídos los dirigidos a mi casa (no los públicos ni admin)
      if (!admin) {
        const { data } = await supabaseBrowser
          .from("comunicados")
          .select("id, house_id, leido_at")
          .is("leido_at", null);
        for (const c of (data as unknown as { id: string; house_id: string | null }[]) ?? [])
          if (c.house_id) await supabaseBrowser.rpc("marcar_comunicado_leido", { p_id: c.id });
      }
    })();
  }, [router, cargar]);

  async function enviar() {
    setMsg(null);
    setErr(null);
    if (!titulo.trim() || !mensaje.trim()) return setErr("Escribe título y mensaje.");
    setEnviando(true);
    const res = await callRpc<{ telegram_enviados?: number }>("crear_comunicado", {
      p_house_id: destino || null,
      p_titulo: titulo.trim(),
      p_mensaje: mensaje.trim(),
      p_autor: comoCaty ? "caty" : "comite",
      p_verificado: verificado,
      p_tipo: tipo,
    });
    setEnviando(false);
    if (!res.ok) return setErr(res.error);
    const n = res.data?.telegram_enviados ?? 0;
    setMsg(`Comunicado enviado${n > 0 ? ` · ${n} por Telegram` : " (sin Telegram: nadie con chat ligado)"}.`);
    setTitulo("");
    setMensaje("");
    setDestino("");
    await cargar();
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

        <h1 className="text-2xl font-bold text-slate-800 mt-4">Comunicados</h1>

        {isAdmin && (
          <section className="mt-4 bg-white rounded-2xl ring-1 ring-slate-100 p-4 flex flex-col gap-3">
            <h2 className="text-sm font-bold text-slate-700">Nuevo comunicado</h2>
            <label className="text-xs text-slate-500">
              Para
              <select
                value={destino}
                onChange={(e) => setDestino(e.target.value)}
                className="mt-1 w-full rounded-xl ring-1 ring-slate-200 px-2 py-2 text-slate-800 bg-white outline-none focus:ring-2 focus:ring-brand-300"
              >
                <option value="">📢 Toda la colonia (público)</option>
                {casas.map((c) => (
                  <option key={c.id} value={c.id}>
                    Casa {c.numero} (privado)
                  </option>
                ))}
              </select>
            </label>
            <input
              value={titulo}
              onChange={(e) => setTitulo(e.target.value)}
              placeholder="Título"
              className="w-full rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
            />
            <textarea
              value={mensaje}
              onChange={(e) => setMensaje(e.target.value)}
              rows={4}
              placeholder="Mensaje"
              className="w-full rounded-xl ring-1 ring-slate-200 px-3 py-2 text-slate-800 text-sm outline-none focus:ring-2 focus:ring-brand-300"
            />
            <div className="flex flex-wrap gap-3 text-xs text-slate-600">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={comoCaty} onChange={(e) => setComoCaty(e.target.checked)} className="accent-nexia" />
                Firmar como Caty
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={verificado} onChange={(e) => setVerificado(e.target.checked)} className="accent-nexia" />
                Revisado por el comité
              </label>
              <select
                value={tipo}
                onChange={(e) => setTipo(e.target.value)}
                className="rounded-lg ring-1 ring-slate-200 px-2 py-1 bg-white"
              >
                <option value="aviso">Aviso</option>
                <option value="discrepancia">Discrepancia</option>
                <option value="cobro">Cobro</option>
              </select>
            </div>
            {err && <p className="text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2 ring-1 ring-red-200">{err}</p>}
            {msg && <p className="text-sm text-emerald-700 bg-emerald-50 rounded-xl px-3 py-2 ring-1 ring-emerald-200">{msg}</p>}
            <button
              onClick={enviar}
              disabled={enviando}
              className="rounded-2xl bg-gradient-to-br from-brand-500 to-emerald-600 text-white py-3 font-extrabold shadow-lg disabled:opacity-40 active:scale-[0.99]"
            >
              {enviando ? "Enviando…" : "Enviar comunicado"}
            </button>
          </section>
        )}

        <section className="mt-6 mb-6">
          <h2 className="text-sm font-bold text-slate-700 mb-2">
            {isAdmin ? "Enviados" : "Tus comunicados"}
          </h2>
          {lista.length === 0 ? (
            <p className="text-slate-400 text-sm bg-white rounded-2xl p-4 ring-1 ring-slate-100">
              No hay comunicados.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {lista.map((c) => (
                <li
                  key={c.id}
                  className={`rounded-2xl p-4 ring-1 ${
                    c.autor === "caty" ? "bg-purple-50/60 ring-purple-100" : "bg-white ring-slate-100"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-bold text-slate-800">{c.titulo}</p>
                    <span className="text-[10px] text-slate-400 shrink-0">{fecha(c.created_at)}</span>
                  </div>
                  <p className="text-sm text-slate-600 mt-1 whitespace-pre-wrap">{c.mensaje}</p>
                  <div className="flex flex-wrap items-center gap-2 mt-2">
                    <span className="text-[10px] font-semibold text-nexia bg-purple-100/70 rounded-full px-2 py-0.5">
                      {c.autor === "caty" ? "🔎 Caty" : "Comité"}
                      {c.verificado_comite ? " · revisado por el comité" : ""}
                    </span>
                    <span className="text-[10px] font-semibold text-slate-500 bg-slate-100 rounded-full px-2 py-0.5">
                      {c.house_id ? `🔒 Casa ${c.house?.numero ?? ""}` : "📢 Público"}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
