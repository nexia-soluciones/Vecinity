import { createClient } from "@supabase/supabase-js";

// Cliente de navegador: usa ANON KEY + JWT del usuario. Schema por defecto: vecino.
export const supabaseBrowser = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  {
    db: { schema: "vecino" },
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // Flujo implícito: el enlace de recuperación llega con los tokens en el
      // hash (#access_token&type=recovery) y supabase-js lo procesa solo,
      // sin depender de un code_verifier del mismo navegador (más robusto
      // cuando el correo se abre en otro dispositivo).
      flowType: "implicit",
      detectSessionInUrl: true,
    },
  }
);
