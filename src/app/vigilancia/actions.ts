"use server";

import { leerPlacaDeImagen } from "@/lib/ocr";
import { requireGuardia } from "@/lib/supabase/server-auth";

// Lee la placa de una foto (caseta). OCR puro; el guardia guarda el
// resultado vía la RPC set_visita_plate (gateada por is_guard).
export async function leerPlaca(
  token: string,
  url: string
): Promise<{ ok: true; plate: string; conf: number } | { ok: false; error: string }> {
  try {
    await requireGuardia(token);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "No autorizado." };
  }
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, error: "no-key" };
  try {
    const r = await leerPlacaDeImagen(url);
    if (!r) return { ok: false, error: "No se pudo leer la imagen." };
    return { ok: true, plate: r.plate, conf: r.conf };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Error en el OCR." };
  }
}
