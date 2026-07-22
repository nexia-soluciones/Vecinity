"use server";

import { supabaseAdmin } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/supabase/server-auth";

// Ayuda de acceso del comité. Las dos operaciones que necesitan SERVICE_ROLE
// (crear el enlace de contraseña y corregir el correo de una cuenta) viven aquí:
// la key nunca sale del servidor y cada acción queda en soporte_acceso_log.

type Resultado<T> = ({ ok: true } & T) | { ok: false; error: string };

type Actor = { id: string; nombre: string; coloniaId: string | null };
type Target = {
  id: string;
  nombre: string;
  email: string;
  coloniaId: string | null;
  houseId: string | null;
  casa: string | null;
};

async function actorYObjetivo(
  token: string,
  profileId: string
): Promise<{ actor: Actor; target: Target }> {
  const admin = await requireAdmin(token);

  const { data: a } = await supabaseAdmin
    .from("profiles")
    .select("id, nombre, colonia_id")
    .eq("id", admin.id)
    .maybeSingle();
  const actorRow = a as { id: string; nombre: string; colonia_id: string | null } | null;
  if (!actorRow) throw new Error("No encontramos tu perfil.");

  const { data: t } = await supabaseAdmin
    .from("profiles")
    .select("id, nombre, email, colonia_id, house_id, house:houses(numero)")
    .eq("id", profileId)
    .maybeSingle();
  const targetRow = t as unknown as {
    id: string;
    nombre: string;
    email: string;
    colonia_id: string | null;
    house_id: string | null;
    house: { numero: string } | null;
  } | null;
  if (!targetRow) throw new Error("Esa cuenta no existe.");

  // Un comité solo opera cuentas de SU colonia (el gate de rol no basta:
  // multi-tenant real).
  if (!actorRow.colonia_id || targetRow.colonia_id !== actorRow.colonia_id) {
    throw new Error("Esa cuenta no es de tu colonia.");
  }

  return {
    actor: { id: actorRow.id, nombre: actorRow.nombre, coloniaId: actorRow.colonia_id },
    target: {
      id: targetRow.id,
      nombre: targetRow.nombre,
      email: targetRow.email,
      coloniaId: targetRow.colonia_id,
      houseId: targetRow.house_id,
      casa: targetRow.house?.numero ?? null,
    },
  };
}

async function registrar(
  actor: Actor,
  target: Target,
  accion: string,
  detalle: string
): Promise<void> {
  // La bitácora nunca debe tumbar la operación que ya se ejecutó.
  await supabaseAdmin.from("soporte_acceso_log").insert({
    colonia_id: actor.coloniaId,
    actor_id: actor.id,
    actor_nombre: actor.nombre,
    target_profile_id: target.id,
    target_nombre: target.nombre,
    target_email: target.email,
    house_id: target.houseId,
    casa: target.casa,
    accion,
    detalle,
  });
}

/**
 * Genera un enlace de un solo uso para que el vecino cree una contraseña nueva.
 * Canal token_hash (el mismo de Caty): NO depende de que salga el correo ni del
 * SITE_URL/allow-list de GoTrue. El comité lo copia y lo manda por WhatsApp.
 */
export async function generarEnlaceReset(
  token: string,
  profileId: string
): Promise<Resultado<{ url: string; email: string }>> {
  let actor: Actor, target: Target;
  try {
    ({ actor, target } = await actorYObjetivo(token, profileId));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "No autorizado." };
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  if (!appUrl) {
    return {
      ok: false,
      error: "Falta NEXT_PUBLIC_APP_URL en el servidor (.env.local y EasyPanel → Entorno).",
    };
  }

  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: "recovery",
    email: target.email,
    options: { redirectTo: `${appUrl}/reset-password` },
  });
  const hashed = data?.properties?.hashed_token;
  if (error || !hashed) {
    return { ok: false, error: "No pudimos generar el enlace. Intenta de nuevo en un momento." };
  }

  const url = `${appUrl}/reset-password?token_hash=${hashed}&type=recovery`;
  await registrar(actor, target, "enlace_password", `Enlace de contraseña generado para ${target.email}`);
  return { ok: true, url, email: target.email };
}

/**
 * Corrige el correo de una cuenta (lo escribió mal al registrarse, o ya no tiene
 * acceso a él). Evita tener que crear una cuenta nueva y dejar la vieja huérfana.
 */
export async function cambiarCorreoCuenta(
  token: string,
  profileId: string,
  correoNuevo: string
): Promise<Resultado<{ email: string }>> {
  let actor: Actor, target: Target;
  try {
    ({ actor, target } = await actorYObjetivo(token, profileId));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "No autorizado." };
  }

  const email = correoNuevo.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return { ok: false, error: "Correo no válido." };
  if (email === target.email.toLowerCase())
    return { ok: false, error: "Ese ya es el correo de la cuenta." };

  const { data: ocupado } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  if (ocupado) return { ok: false, error: "Ya existe otra cuenta con ese correo." };

  const { error } = await supabaseAdmin.auth.admin.updateUserById(profileId, {
    email,
    email_confirm: true,
  });
  if (error) {
    const msg = error.message?.toLowerCase() ?? "";
    if (msg.includes("already") || msg.includes("registered"))
      return { ok: false, error: "Ya existe otra cuenta con ese correo." };
    return { ok: false, error: "No pudimos cambiar el correo. Intenta de nuevo." };
  }

  const { error: perfilErr } = await supabaseAdmin
    .from("profiles")
    .update({ email })
    .eq("id", profileId);
  if (perfilErr) {
    // auth ya cambió: revertir para no dejar la cuenta partida en dos.
    await supabaseAdmin.auth.admin.updateUserById(profileId, {
      email: target.email,
      email_confirm: true,
    });
    return { ok: false, error: "No pudimos actualizar el perfil. No se cambió nada." };
  }

  await registrar(actor, target, "cambio_correo", `${target.email} → ${email}`);
  return { ok: true, email };
}
