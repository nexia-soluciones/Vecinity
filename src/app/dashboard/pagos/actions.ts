"use server";

import { leerComprobanteDeImagen, type ComprobanteOCR } from "@/lib/ocr";
import { requireAprobado } from "@/lib/supabase/server-auth";

// Lee un comprobante de transferencia con visión de Claude. OCR puro: no escribe
// en BD (el cliente guarda el resultado vía la RPC set_abono_ocr, gateada por casa).
// Autenticada: requiere sesión válida de un vecino aprobado (evita abuso de costos).
export async function leerComprobante(
  token: string,
  url: string
): Promise<{ ok: true; data: ComprobanteOCR } | { ok: false; error: string }> {
  try {
    await requireAprobado(token);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "No autorizado." };
  }
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, error: "no-key" };
  try {
    const r = await leerComprobanteDeImagen(url);
    if (!r) return { ok: false, error: "No se pudo leer el comprobante." };
    return { ok: true, data: r };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Error en el OCR." };
  }
}
