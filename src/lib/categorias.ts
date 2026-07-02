// Catálogo canónico de categorías de gasto de la colonia.
// Lista CERRADA (dropdowns) para evitar errores de captura y duplicados como
// "Jardineria"/"Jardinería" o "CFE"/"CFE (Luz)". Si hace falta una categoría
// nueva, se agrega AQUÍ (una sola fuente de verdad para toda la app).

export const CATEGORIAS = [
  "Vigilancia",
  "Jardinería",
  "JUMAPA (Agua)",
  "Alberca",
  "Basura",
  "Limpieza",
  "CFE (Luz)",
  "Telmex",
  "Impuestos (SAT)",
  "Comisiones Bancarias",
  "Contabilidad",
  "Fumigación",
  "Materiales",
  "Mano de obra",
  "Compras Menores",
  "Reparaciones",
  "Cámaras/Equipo",
  "Seguridad",
  "Retiros Cajero",
  "INFONAVIT",
  "Otros",
] as const;

export type Categoria = (typeof CATEGORIAS)[number];

// Color por categoría (barras del desglose). Cae a brand si no está.
export const COLOR_CATEGORIA: Record<string, string> = {
  Vigilancia: "bg-slate-600",
  Jardinería: "bg-emerald-500",
  "JUMAPA (Agua)": "bg-blue-500",
  Alberca: "bg-sky-500",
  Basura: "bg-orange-500",
  Limpieza: "bg-cyan-600",
  "CFE (Luz)": "bg-amber-500",
  Telmex: "bg-indigo-500",
  "Impuestos (SAT)": "bg-red-500",
  "Comisiones Bancarias": "bg-rose-400",
  Contabilidad: "bg-violet-500",
  Fumigación: "bg-lime-600",
  Materiales: "bg-yellow-600",
  "Mano de obra": "bg-teal-600",
  "Compras Menores": "bg-fuchsia-500",
  Reparaciones: "bg-stone-500",
  "Cámaras/Equipo": "bg-zinc-600",
  Seguridad: "bg-red-700",
  "Retiros Cajero": "bg-neutral-500",
  INFONAVIT: "bg-purple-600",
  Otros: "bg-purple-500",
};

// Mapa de formas antiguas → canónica. Se usó una vez para normalizar la BD;
// también sirve para mostrar bonito cualquier dato viejo que quede.
export const NORMALIZA: Record<string, string> = {
  Jardineria: "Jardinería",
  SAT: "Impuestos (SAT)",
  Impuestos: "Impuestos (SAT)",
  CFE: "CFE (Luz)",
  Vigilancia_Insumos: "Vigilancia",
  Fumigacion: "Fumigación",
};

export const canon = (c: string): string => NORMALIZA[c] ?? c;
