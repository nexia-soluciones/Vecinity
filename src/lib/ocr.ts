import Anthropic from "@anthropic-ai/sdk";

// Helper server-only: lee una placa de una imagen con visión de Claude.
// Devuelve null si no hay API key o no se pudo leer la imagen.
type MediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

// Allowlist anti-SSRF: solo se permite hacer fetch a las imágenes del Storage de
// Supabase de este proyecto (evita que una URL arbitraria sondee la red interna).
function assertStorageUrl(url: string): void {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  let host: string;
  try {
    host = new URL(url).origin;
  } catch {
    throw new Error("URL de imagen inválida.");
  }
  if (!base || host !== new URL(base).origin || !url.includes("/storage/v1/object/")) {
    throw new Error("Origen de imagen no permitido.");
  }
}

export async function leerPlacaDeImagen(
  url: string
): Promise<{ plate: string; conf: number } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  assertStorageUrl(url);
  const img = await fetch(url);
  if (!img.ok) return null;
  const b64 = Buffer.from(await img.arrayBuffer()).toString("base64");
  const ct = (img.headers.get("content-type") || "image/jpeg").toLowerCase();
  const media: MediaType = (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(ct)
    ? ct
    : "image/jpeg") as MediaType;

  const client = new Anthropic({ apiKey });
  const resp = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: media, data: b64 } },
          {
            type: "text",
            text:
              'Lee la PLACA del vehículo en esta foto. Responde SOLO con un JSON: ' +
              '{"placa":"ABC123D","confianza":0.0} donde "placa" son los caracteres ' +
              'alfanuméricos sin espacios ni guiones (en MAYÚSCULAS) y "confianza" es de 0 a 1. ' +
              'Si no se ve ninguna placa legible, usa {"placa":"","confianza":0}.',
          },
        ],
      },
    ],
  });

  const txt = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return { plate: "", conf: 0 };
  try {
    const o = JSON.parse(m[0]) as { placa?: string; confianza?: number };
    return { plate: String(o.placa ?? "").toUpperCase(), conf: Number(o.confianza) || 0 };
  } catch {
    return { plate: "", conf: 0 };
  }
}

// Datos que se intentan extraer de un comprobante de transferencia.
// Formato variado (cada banco/app es distinto), pero casi todos traen fecha,
// monto, una CLAVE DE RASTREO/folio y a veces el concepto que escribió el cliente.
export type ComprobanteOCR = {
  fecha: string | null;        // ISO YYYY-MM-DD si se detecta
  monto: number | null;
  clave_rastreo: string | null; // clave de rastreo SPEI / folio de la operación
  folio: string | null;
  concepto: string | null;      // concepto/descripción que escribió el cliente
  banco: string | null;         // banco o app emisora (BBVA, Nu, Mercado Pago…)
};

export async function leerComprobanteDeImagen(url: string): Promise<ComprobanteOCR | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  assertStorageUrl(url);
  const img = await fetch(url);
  if (!img.ok) return null;
  const b64 = Buffer.from(await img.arrayBuffer()).toString("base64");
  const ct = (img.headers.get("content-type") || "image/jpeg").toLowerCase();
  const media: MediaType = (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(ct)
    ? ct
    : "image/jpeg") as MediaType;

  const client = new Anthropic({ apiKey });
  const resp = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 500,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: media, data: b64 } },
          {
            type: "text",
            text:
              "Esta es la captura de un comprobante de transferencia/pago (puede ser de " +
              "cualquier banco o app mexicana). Extrae los datos y responde SOLO con un JSON:\n" +
              '{"fecha":"YYYY-MM-DD","monto":0.0,"clave_rastreo":"","folio":"","concepto":"","banco":""}\n' +
              "- fecha: la fecha de la operación en formato YYYY-MM-DD (null si no se ve).\n" +
              "- monto: el importe transferido como número (null si no se ve).\n" +
              "- clave_rastreo: la CLAVE DE RASTREO SPEI o número de seguimiento/operación " +
              "(el identificador largo de la transferencia). null si no aparece.\n" +
              "- folio: cualquier folio/referencia adicional. null si no aparece.\n" +
              "- concepto: el concepto o descripción que escribió quien pagó. null si no hay.\n" +
              "- banco: el banco o app emisora. null si no se identifica.\n" +
              "Usa null (no cadenas vacías) cuando un dato no aparezca.",
          },
        ],
      },
    ],
  });

  const txt = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const mm = txt.match(/\{[\s\S]*\}/);
  if (!mm) return null;
  try {
    const o = JSON.parse(mm[0]) as Record<string, unknown>;
    const rawMonto = o.monto;
    const monto =
      rawMonto == null || rawMonto === ""
        ? null
        : Number(String(rawMonto).replace(/[^0-9.-]/g, "")) || null;
    const s = (v: unknown) => {
      const t = String(v ?? "").trim();
      return t && t.toLowerCase() !== "null" ? t : null;
    };
    return {
      fecha: s(o.fecha),
      monto,
      clave_rastreo: s(o.clave_rastreo),
      folio: s(o.folio),
      concepto: s(o.concepto),
      banco: s(o.banco),
    };
  } catch {
    return null;
  }
}
