"use server";

import Anthropic from "@anthropic-ai/sdk";
import { requireAdmin } from "@/lib/supabase/server-auth";

export type FilaMulta = {
  fecha: string; // fecha de resolución (YYYY-MM-DD)
  categoria: string;
  casa: string;
  monto: number;
  capturada_at: string | null; // hora exacta de la evidencia
  lat: number | null;
  lng: number | null;
  descripcion: string | null;
};

type Resultado = { ok: true; reporte: string } | { ok: false; error: string };

// Genera un reporte mensual de multas asistido por Claude.
// La API key vive solo en el servidor (nunca llega al cliente).
export async function generarReporteMultas(
  token: string,
  periodoLabel: string,
  colonia: string,
  filas: FilaMulta[]
): Promise<Resultado> {
  try {
    await requireAdmin(token);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "No autorizado." };
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      error:
        "Falta configurar ANTHROPIC_API_KEY en el servidor (.env.local y EasyPanel → Entorno).",
    };
  }
  if (!filas.length) return { ok: false, error: "No hay multas en el periodo seleccionado." };

  const total = filas.reduce((s, f) => s + f.monto, 0);
  const detalle = filas
    .map((f, i) => {
      const partes = [
        `${i + 1}.`,
        f.fecha,
        `Casa ${f.casa}`,
        f.categoria,
        `$${f.monto.toLocaleString("es-MX")}`,
      ];
      if (f.capturada_at) partes.push(`evidencia ${f.capturada_at}`);
      if (f.lat != null && f.lng != null) partes.push(`ubicación ${f.lat},${f.lng}`);
      if (f.descripcion) partes.push(`"${f.descripcion}"`);
      return partes.join(" · ");
    })
    .join("\n");

  const prompt = `Eres el asistente del comité de la colonia "${colonia}". Redacta un **reporte mensual de multas** del periodo ${periodoLabel}, en español, claro y profesional, en formato Markdown.

Datos de las multas aplicadas (${filas.length} en total, suma $${total.toLocaleString(
    "es-MX"
  )}):
${detalle}

El reporte debe incluir:
- **Resumen ejecutivo**: total de multas, monto total y número de casas involucradas.
- **Desglose por categoría**: cuántas multas y cuánto suma cada categoría.
- **Reincidencias**: casas con más de una multa en el periodo, si las hay.
- **Observaciones**: patrones útiles para el comité (por ejemplo, días u horas frecuentes según la hora de la evidencia, si la información lo permite).
- **Cierre** breve y neutral.

Reglas: no inventes datos que no estén en la lista; usa un tono institucional y respetuoso; no incluyas nombres de personas (solo número de casa).`;

  const client = new Anthropic({ apiKey });
  try {
    const resp = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    });
    const reporte = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!reporte) return { ok: false, error: "La IA no devolvió contenido." };
    return { ok: true, reporte };
  } catch (e) {
    if (e instanceof Anthropic.APIError) {
      return { ok: false, error: `Error de IA (${e.status ?? "?"}): ${e.message}` };
    }
    return { ok: false, error: e instanceof Error ? e.message : "Error generando el reporte." };
  }
}
