"use server";

import { supabaseAdmin } from "@/lib/supabase/admin";
import { leerPlacaDeImagen } from "@/lib/ocr";
import { requireAprobado } from "@/lib/supabase/server-auth";

type Resultado =
  | { ok: true; accion: "amonestacion" | "propuesta" | "ninguna"; monto?: number; placaOcr?: string }
  | { ok: false; error: string };

// OCR de la placa con visión de Claude + auto-proceso de la incidencia.
// La API key vive solo en el servidor; el RPC (SECURITY DEFINER, service role)
// hace la validación de 3 vías y crea amonestación o propuesta de multa.
export async function autoprocesarIncidencia(
  token: string,
  incidentId: string,
  placaReportada: string,
  evidenciaUrl: string
): Promise<Resultado> {
  try {
    await requireAprobado(token);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "No autorizado." };
  }
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, error: "no-key" };

  try {
    // 1. OCR de la placa (visión de Claude)
    const ocr = await leerPlacaDeImagen(evidenciaUrl);
    const placaOcr = ocr?.plate ?? "";
    const conf = ocr?.conf ?? 0;

    // 2. Auto-procesar (match de 3 vías + amonestación/propuesta) en la BD
    const { data, error } = await supabaseAdmin.rpc("procesar_incidencia_auto", {
      p_id: incidentId,
      p_placa_reportada: placaReportada,
      p_plate_ocr: placaOcr,
      p_confidence: conf,
    });
    if (error) return { ok: false, error: error.message };

    const d = (data ?? {}) as { accion?: string; monto?: number };
    const accion = (d.accion === "amonestacion" || d.accion === "propuesta"
      ? d.accion
      : "ninguna") as "amonestacion" | "propuesta" | "ninguna";
    return { ok: true, accion, monto: d.monto, placaOcr };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Error en el OCR." };
  }
}
