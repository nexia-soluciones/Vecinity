"use server";

import Anthropic from "@anthropic-ai/sdk";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/supabase/server-auth";

type Resultado = { ok: true; resolucion: string } | { ok: false; error: string };

const money = (n: number) => `$${Number(n).toLocaleString("es-MX")}`;
const fechaLarga = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("es-MX", {
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "fecha no registrada";

// Genera la RESOLUCIÓN OFICIAL de una multa citando el artículo LITERAL del
// reglamento. La redacta Claude; la key vive solo en el servidor. El texto se
// guarda vía set_resolucion_oficial (service role). NUNCA menciona al reportante.
export async function generarResolucionOficial(
  token: string,
  incidentId: string
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
      error: "Falta ANTHROPIC_API_KEY en el servidor (.env.local y EasyPanel → Entorno).",
    };
  }

  // Datos de la incidencia + categoría + artículo (service role, sin filtrar por RLS).
  const { data: inc, error: e1 } = await supabaseAdmin
    .from("incident_reports")
    .select(
      "id, estado, monto_multa, descripcion, evidencia_capturada_at, created_at, " +
        "categoria:fine_categories(nombre, monto_base, articulo_id), " +
        "infractor:houses!infractor_house_id(numero), " +
        "colonia:colonias(nombre)"
    )
    .eq("id", incidentId)
    .maybeSingle();
  if (e1 || !inc) return { ok: false, error: e1?.message ?? "No se encontró la incidencia." };

  const row = inc as unknown as {
    estado: string;
    monto_multa: number;
    descripcion: string | null;
    evidencia_capturada_at: string | null;
    created_at: string;
    categoria: { nombre: string; monto_base: number; articulo_id: string | null } | null;
    infractor: { numero: string } | null;
    colonia: { nombre: string } | null;
  };

  if (row.estado !== "multa") {
    return { ok: false, error: "La incidencia no es una multa aplicada." };
  }

  // Artículo del reglamento que sanciona esta categoría (texto literal).
  type Articulo = { articulo: string; titulo: string | null; texto: string };
  let articulo: Articulo | null = null;
  if (row.categoria?.articulo_id) {
    const { data: art } = await supabaseAdmin
      .from("reglamento")
      .select("articulo, titulo, texto")
      .eq("id", row.categoria.articulo_id)
      .maybeSingle();
    articulo = (art as Articulo | null) ?? null;
  }

  const colonia = row.colonia?.nombre ?? "el condominio";
  const casa = row.infractor?.numero ?? "—";
  const categoria = row.categoria?.nombre ?? "Incidencia";
  const cuandoEvidencia = fechaLarga(row.evidencia_capturada_at ?? row.created_at);

  const bloqueArticulo = articulo
    ? `${articulo.articulo}${articulo.titulo ? ` — ${articulo.titulo}` : ""}:\n"${articulo.texto}"`
    : "No hay un artículo específico ligado a esta categoría; cita el reglamento interno de manera general.";

  const prompt = `Eres el asistente del Comité de Administración de la colonia "${colonia}". Redacta una **RESOLUCIÓN OFICIAL** de una multa, dirigida al condómino infractor, en español, con tono institucional, formal y respetuoso, en formato Markdown breve (máx. ~200 palabras).

Datos de la infracción:
- Casa infractora: ${casa}
- Motivo (categoría): ${categoria}
- Fecha y hora de la evidencia: ${cuandoEvidencia}
- Monto de la multa: ${money(row.monto_multa)}
${row.descripcion ? `- Detalle del reporte: "${row.descripcion}"` : ""}

Artículo del reglamento que fundamenta la sanción (cítalo TEXTUALMENTE, no lo reformules ni inventes números de artículo):
${bloqueArticulo}

La resolución debe:
1. Encabezarse como "Resolución Oficial de Multa".
2. Describir la conducta sancionada y la fecha/hora de la evidencia.
3. **Citar el artículo del reglamento tal como se te entregó** (número y texto).
4. Indicar el monto y que se cargó al estado de cuenta del condómino.
5. Mencionar que el condómino puede solicitar aclaración o condonación ante el Comité.

Reglas estrictas:
- NO inventes artículos, montos ni datos que no estén arriba.
- NO menciones ni insinúes quién reportó la infracción; el reporte es anónimo.
- No incluyas nombres de personas (solo número de casa).`;

  const client = new Anthropic({ apiKey });
  let resolucion: string;
  try {
    const resp = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 1200,
      messages: [{ role: "user", content: prompt }],
    });
    resolucion = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
  } catch (e) {
    if (e instanceof Anthropic.APIError) {
      return { ok: false, error: `Error de IA (${e.status ?? "?"}): ${e.message}` };
    }
    return { ok: false, error: e instanceof Error ? e.message : "Error generando la resolución." };
  }
  if (!resolucion) return { ok: false, error: "La IA no devolvió contenido." };

  const { error: e2 } = await supabaseAdmin.rpc("set_resolucion_oficial", {
    p_incident_id: incidentId,
    p_texto: resolucion,
    p_articulo: articulo ? articulo.articulo : null,
  });
  if (e2) return { ok: false, error: e2.message };

  return { ok: true, resolucion };
}
