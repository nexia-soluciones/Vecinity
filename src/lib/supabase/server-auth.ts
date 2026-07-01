import { supabaseAdmin } from "@/lib/supabase/admin";

// Autenticación para Server Actions.
// El cliente del navegador guarda la sesión en localStorage (no cookies), así que
// las Server Actions reciben el access_token del cliente y lo validan aquí con el
// service role. Evita que cualquiera invoque una Server Action por POST sin sesión.

export type AuthedUser = { id: string; email: string | null; role: string };

async function usuarioDeToken(token: string | null | undefined): Promise<{ id: string; email: string | null }> {
  if (!token) throw new Error("No autorizado (sin sesión).");
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) throw new Error("No autorizado (sesión inválida).");
  return { id: data.user.id, email: data.user.email ?? null };
}

async function perfil(id: string): Promise<{ role: string; approval_status: string } | null> {
  const { data } = await supabaseAdmin
    .from("profiles")
    .select("role, approval_status")
    .eq("id", id)
    .maybeSingle();
  return (data as { role: string; approval_status: string } | null) ?? null;
}

/** Requiere una sesión válida y perfil aprobado. */
export async function requireAprobado(token: string | null | undefined): Promise<AuthedUser> {
  const u = await usuarioDeToken(token);
  const p = await perfil(u.id);
  if (!p || p.approval_status !== "aprobado") throw new Error("No autorizado.");
  return { ...u, role: p.role };
}

/** Requiere sesión válida + rol admin/comité aprobado. */
export async function requireAdmin(token: string | null | undefined): Promise<AuthedUser> {
  const u = await requireAprobado(token);
  if (u.role !== "admin" && u.role !== "comite") throw new Error("Solo el comité.");
  return u;
}

/** Requiere sesión válida + rol guardia/admin/comité aprobado. */
export async function requireGuardia(token: string | null | undefined): Promise<AuthedUser> {
  const u = await requireAprobado(token);
  if (!["guardia", "admin", "comite"].includes(u.role)) throw new Error("Solo vigilancia.");
  return u;
}
