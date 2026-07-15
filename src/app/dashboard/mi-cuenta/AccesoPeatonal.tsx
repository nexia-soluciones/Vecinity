"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { callRpc } from "@/lib/rpc";

// La terminal facial reconoce mejor con foto tipo credencial: rostro centrado,
// fondo blanco, sin lentes oscuros. Comprimimos a máx 800px (≈100 KB JPEG).
const LADO_MAX = 800;
const CALIDAD_JPEG = 0.85;
// Respaldo anti-kill de la PWA al abrir la cámara (mismo motivo que draftGuardia).
const LS_KEY = "acceso_peatonal_borrador";
const TTL_MS = 60 * 60 * 1000;

type Registro = {
  id: string;
  nombre: string;
  status: string;
  motivo: string | null;
  created_at: string;
};

const badge = (r: Registro) =>
  r.status === "recibida"
    ? { txt: "🕓 En revisión del comité", cls: "bg-amber-50 text-amber-700 ring-amber-200" }
    : r.status === "aprobada"
      ? { txt: "📤 Aprobada · por activar en la puerta", cls: "bg-sky-50 text-sky-700 ring-sky-200" }
      : r.status === "enrolada"
        ? { txt: "🟢 Activa en la puerta", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" }
        : { txt: "❌ Rechazada", cls: "bg-red-50 text-red-700 ring-red-200" };

async function comprimirRostro(original: File): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(original);
    const escala = Math.min(1, LADO_MAX / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * escala));
    canvas.height = Math.max(1, Math.round(bitmap.height * escala));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const dataUrl = canvas.toDataURL("image/jpeg", CALIDAD_JPEG);
    return dataUrl.split(",")[1] ?? null;
  } catch {
    return null;
  }
}

export default function AccesoPeatonal({ houseId }: { houseId: string }) {
  const [registros, setRegistros] = useState<Registro[]>([]);
  const [nombre, setNombre] = useState("");
  const [fotoB64, setFotoB64] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [fotoDe, setFotoDe] = useState<Record<string, string>>({}); // id → b64 al pedir "ver"
  const fileRef = useRef<HTMLInputElement>(null);

  const cargar = useCallback(async () => {
    const { data } = await supabaseBrowser
      .from("face_enrollments")
      .select("id, nombre, status, motivo, created_at")
      .eq("house_id", houseId)
      .neq("status", "retirada")
      .order("created_at", { ascending: true });
    setRegistros((data as unknown as Registro[]) ?? []);
  }, [houseId]);

  useEffect(() => {
    cargar();
    // Restaurar borrador si la cámara mató la PWA a media captura.
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const d = JSON.parse(raw) as { ts: number; nombre: string; b64: string | null };
        if (Date.now() - d.ts < TTL_MS) {
          if (d.nombre) setNombre(d.nombre);
          if (d.b64) {
            setFotoB64(d.b64);
            setMsg("Se recuperó tu captura anterior.");
          }
        } else localStorage.removeItem(LS_KEY);
      }
    } catch {
      /* sin respaldo, el flujo sigue */
    }
  }, [cargar]);

  const guardarBorrador = (n: string, b64: string | null) => {
    try {
      if (!n && !b64) return localStorage.removeItem(LS_KEY);
      localStorage.setItem(LS_KEY, JSON.stringify({ ts: Date.now(), nombre: n, b64 }));
    } catch {
      /* localStorage lleno: seguimos sin respaldo */
    }
  };

  async function onFoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; // leer ANTES de cualquier await
    e.target.value = "";
    if (!file) return;
    setMsg(null);
    const b64 = await comprimirRostro(file);
    if (!b64) return setMsg("No se pudo procesar la foto. Inténtalo de nuevo.");
    setFotoB64(b64);
    guardarBorrador(nombre, b64);
  }

  async function enviar() {
    if (busy) return;
    setMsg(null);
    if (!nombre.trim()) return setMsg("Escribe el nombre de la persona.");
    if (!fotoB64) return setMsg("Toma la foto primero.");
    setBusy(true);
    const res = await callRpc("face_submit", {
      p_nombre: nombre.trim(),
      p_photo_b64: fotoB64,
      p_house_id: houseId,
    });
    setBusy(false);
    if (!res.ok) return setMsg(res.error);
    setNombre("");
    setFotoB64(null);
    guardarBorrador("", null);
    setMsg("Foto enviada. El comité la revisará y en cuanto se apruebe la puerta te reconocerá.");
    await cargar();
  }

  async function retirar(id: string) {
    if (busy) return;
    setBusy(true);
    const res = await callRpc("face_retire", { p_id: id });
    setBusy(false);
    if (!res.ok) return setMsg(res.error);
    await cargar();
  }

  async function verFoto(id: string) {
    if (fotoDe[id]) return setFotoDe((f) => ({ ...f, [id]: "" })); // toggle off
    const res = await callRpc<{ photo_b64: string }>("face_photo", { p_id: id });
    if (!res.ok) return setMsg(res.error);
    setFotoDe((f) => ({ ...f, [id]: res.data.photo_b64 }));
  }

  return (
    <section className="mt-6">
      <h2 className="text-sm font-bold text-slate-700 mb-2">Acceso peatonal 🚶</h2>
      <div className="bg-white rounded-2xl p-3.5 ring-1 ring-slate-100">
        <p className="text-sm text-slate-600">
          La puerta peatonal abre con <span className="font-semibold">reconocimiento de rostro</span>.
          Registra a cada persona que vive en tu casa con una foto{" "}
          <span className="font-semibold">de frente, con fondo blanco</span> y buena luz
          (sin gorra ni lentes oscuros).
        </p>

        {msg && (
          <p className="text-sm text-slate-700 bg-sky-50 rounded-xl px-3 py-2 ring-1 ring-sky-200 mt-2">
            {msg}
          </p>
        )}

        {/* Alta nueva */}
        <div className="mt-3 flex flex-col gap-2">
          <input
            value={nombre}
            onChange={(e) => {
              setNombre(e.target.value);
              guardarBorrador(e.target.value, fotoB64);
            }}
            placeholder="Nombre de la persona"
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
          />
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="user"
            onChange={onFoto}
            className="hidden"
          />
          {fotoB64 ? (
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`data:image/jpeg;base64,${fotoB64}`}
                alt="Foto capturada"
                className="w-20 h-20 rounded-xl object-cover ring-1 ring-slate-200"
              />
              <div className="flex flex-col gap-1.5">
                <button
                  onClick={() => fileRef.current?.click()}
                  className="text-sm font-semibold text-brand-600 text-left"
                >
                  Volver a tomar
                </button>
                <button
                  onClick={enviar}
                  disabled={busy}
                  className="rounded-xl bg-brand-500 text-white text-sm font-semibold px-4 py-2 hover:bg-brand-600 disabled:opacity-40"
                >
                  {busy ? "Enviando…" : "Enviar al comité"}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => fileRef.current?.click()}
              className="rounded-xl border border-dashed border-slate-300 text-slate-600 text-sm font-semibold px-3 py-3 hover:bg-slate-50"
            >
              📷 Tomar foto del rostro
            </button>
          )}
        </div>

        {/* Rostros de la casa */}
        {registros.length > 0 && (
          <ul className="flex flex-col gap-2 mt-4 border-t border-slate-100 pt-3">
            {registros.map((r) => {
              const b = badge(r);
              return (
                <li key={r.id} className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-slate-800 text-sm truncate">{r.nombre}</p>
                    <span className={`shrink-0 text-xs font-semibold rounded-xl px-2.5 py-1 ring-1 ${b.cls}`}>
                      {b.txt}
                    </span>
                  </div>
                  {r.status === "rechazada" && r.motivo && (
                    <p className="text-xs text-red-600 italic">“{r.motivo}” — toma otra foto y vuelve a enviarla.</p>
                  )}
                  <div className="flex gap-3">
                    <button onClick={() => verFoto(r.id)} className="text-xs font-semibold text-slate-500">
                      {fotoDe[r.id] ? "Ocultar foto" : "Ver foto"}
                    </button>
                    {(r.status === "recibida" || r.status === "rechazada") && (
                      <button
                        onClick={() => retirar(r.id)}
                        disabled={busy}
                        className="text-xs font-semibold text-red-500 disabled:opacity-40"
                      >
                        Quitar
                      </button>
                    )}
                  </div>
                  {fotoDe[r.id] && (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={`data:image/jpeg;base64,${fotoDe[r.id]}`}
                      alt={r.nombre}
                      className="w-24 h-24 rounded-xl object-cover ring-1 ring-slate-200"
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
