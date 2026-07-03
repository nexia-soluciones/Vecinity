"use server";

import { supabaseAdmin } from "@/lib/supabase/admin";

export type InvitationInfo = {
  ok: boolean;
  error?: string;
  colonia?: { id: string; nombre: string };
  street?: string | null;
  numero?: string | null;
  houseId?: string | null;
  role?: string;
  /** 'propietario' = código PROP: dueño que no vive en la casa (solo finanzas) */
  relacion?: string | null;
};

/** Valida un código de invitación y devuelve la colonia/casa pre-llenada. */
export async function validateInvitation(token: string): Promise<InvitationInfo> {
  const code = token.trim().toUpperCase();
  if (!code) return { ok: false, error: "Escribe tu código de invitación." };

  const { data, error } = await supabaseAdmin
    .from("invitations")
    .select(
      "id, role, relacion, accepted_at, expires_at, colonia:colonias(id,nombre), house:houses(id,numero,street)"
    )
    .eq("token", code)
    .maybeSingle();

  if (error) return { ok: false, error: "No pudimos validar la invitación." };
  if (!data) return { ok: false, error: "Código no válido. Revísalo con tu comité." };
  if (data.accepted_at) return { ok: false, error: "Esta invitación ya fue usada." };
  if (data.expires_at && new Date(data.expires_at) < new Date())
    return { ok: false, error: "La invitación expiró. Pide una nueva al comité." };

  const colonia = data.colonia as unknown as { id: string; nombre: string } | null;
  const house = data.house as unknown as
    | { id: string; numero: string; street: string | null }
    | null;

  return {
    ok: true,
    colonia: colonia ?? undefined,
    street: house?.street ?? null,
    numero: house?.numero ?? null,
    houseId: house?.id ?? null,
    role: data.role,
    relacion: (data as { relacion?: string | null }).relacion ?? null,
  };
}

export type OnboardingResult = {
  ok: boolean;
  error?: string;
  profileId?: string;
  /** true = el correo ya tenía cuenta; solo se le ligó la casa como propietario */
  linked?: boolean;
};

/** Liga un perfil como propietario de la casa de la invitación (idempotente). */
async function linkPropietario(
  profileId: string,
  coloniaId: string,
  houseId: string
): Promise<boolean> {
  const { error } = await supabaseAdmin.from("house_members").upsert(
    {
      colonia_id: coloniaId,
      house_id: houseId,
      profile_id: profileId,
      relacion: "propietario",
    },
    { onConflict: "house_id,profile_id,relacion", ignoreDuplicates: true }
  );
  return !error;
}

/** Crea la cuenta, liga el perfil a la colonia/casa de la invitación (status pendiente). */
export async function completeOnboarding(input: {
  token: string;
  nombre: string;
  email: string;
  password: string;
  telefono: string;
}): Promise<OnboardingResult> {
  const nombre = input.nombre.trim();
  const email = input.email.trim().toLowerCase();
  if (!nombre) return { ok: false, error: "Falta tu nombre." };
  if (!/^\S+@\S+\.\S+$/.test(email)) return { ok: false, error: "Correo no válido." };
  if (input.password.length < 6)
    return { ok: false, error: "La contraseña debe tener al menos 6 caracteres." };

  // 1. Re-validar invitación (fuente de verdad en el server)
  const inv = await validateInvitation(input.token);
  if (!inv.ok) return { ok: false, error: inv.error };

  const esPropietario = inv.relacion === "propietario";
  if (esPropietario && (!inv.colonia?.id || !inv.houseId))
    return { ok: false, error: "Invitación de propietario sin casa ligada. Avisa al comité." };

  // 2. Crear usuario de auth (confirmado). El trigger handle_new_user crea el perfil mínimo.
  const { data: created, error: createErr } =
    await supabaseAdmin.auth.admin.createUser({
      email,
      password: input.password,
      email_confirm: true,
      user_metadata: { app: "vecino", name: nombre, phone: input.telefono },
    });

  if (createErr || !created?.user) {
    const msg = createErr?.message?.toLowerCase() ?? "";
    if (msg.includes("already") || msg.includes("registered")) {
      // Dueño con cuenta previa (p.ej. vive en otra casa de la colonia y renta
      // ésta): no es error — solo se le liga la casa como propietario.
      if (esPropietario) {
        const { data: prof } = await supabaseAdmin
          .from("profiles")
          .select("id")
          .eq("email", email)
          .maybeSingle();
        if (!prof)
          return { ok: false, error: "Ese correo ya existe pero no tiene perfil. Avisa al comité." };
        const linked = await linkPropietario(prof.id, inv.colonia!.id, inv.houseId!);
        if (!linked)
          return { ok: false, error: "No pudimos ligar la casa a tu cuenta. Avisa al comité." };
        await supabaseAdmin
          .from("invitations")
          .update({ accepted_at: new Date().toISOString() })
          .eq("token", input.token.trim().toUpperCase());
        return { ok: true, profileId: prof.id, linked: true };
      }
      return { ok: false, error: "Ya existe una cuenta con ese correo." };
    }
    return { ok: false, error: "No pudimos crear tu cuenta. Intenta de nuevo." };
  }

  const userId = created.user.id;

  // 3. Ligar/asegurar el perfil con la colonia y casa de la invitación (upsert).
  //    Propietario externo: house_id queda NULL (no vive ahí); su vínculo con la
  //    casa va en house_members y solo abre las superficies financieras.
  const { error: upErr } = await supabaseAdmin.from("profiles").upsert(
    {
      id: userId,
      nombre,
      email,
      telefono: input.telefono,
      role: inv.role ?? "residente",
      colonia_id: inv.colonia?.id ?? null,
      house_id: esPropietario ? null : inv.houseId ?? null,
      // El código de invitación CAT/PROP-<casa> ya prueba identidad (lo entregó el
      // comité) → auto-aprobado, entra directo al dashboard sin pasar por /esperando.
      approval_status: "aprobado",
    },
    { onConflict: "id" }
  );
  if (upErr) return { ok: false, error: "Cuenta creada, pero falló el perfil. Avisa al comité." };

  if (esPropietario) {
    const linked = await linkPropietario(userId, inv.colonia!.id, inv.houseId!);
    if (!linked)
      return { ok: false, error: "Cuenta creada, pero falló el vínculo con tu casa. Avisa al comité." };
  }

  // 4. Marcar la invitación como usada.
  await supabaseAdmin
    .from("invitations")
    .update({ accepted_at: new Date().toISOString() })
    .eq("token", input.token.trim().toUpperCase());

  return { ok: true, profileId: userId };
}
