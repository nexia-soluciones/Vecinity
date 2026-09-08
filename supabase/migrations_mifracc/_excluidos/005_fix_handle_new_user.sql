-- TODO(mifracc): excluido del set mifracc — este archivo instala el trigger sobre auth.users (tabla COMPARTIDA entre todas las apps de Nexia) con guard app='vecino'. mifracc necesita su PROPIO trigger nuevo y separado (on_auth_user_created_mifracc -> mifracc.handle_new_user(), guard app='mifracc'), sin tocar ni copiar el guard de Vecinity. Se construye aparte en el siguiente paso, no como copia mecánica de este archivo.

-- ============================================================
-- VECINITY · Fix crítico: vecino.handle_new_user
-- El trigger global on_auth_user_created (auth.users) llamaba a esta función
-- con columnas/enums viejos → rompía TODA alta de usuario del ecosistema.
-- Nuevo: GUARD por metadata app='vecino' + columnas/enums correctos + a prueba de fallos.
-- ============================================================
CREATE OR REPLACE FUNCTION vecino.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = vecino, auth
AS $fn$
BEGIN
  -- Guard: solo crear perfil vecino si el alta viene de la app Vecinity.
  IF COALESCE(NEW.raw_user_meta_data->>'app','') <> 'vecino' THEN
    RETURN NEW;
  END IF;

  BEGIN
    INSERT INTO vecino.profiles (id, nombre, email, telefono, role, approval_status, avatar)
    VALUES (
      NEW.id,
      COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
      NEW.email,
      NEW.raw_user_meta_data->>'phone',
      'residente',
      'pendiente',
      upper(substring(COALESCE(NEW.raw_user_meta_data->>'name', NEW.email), 1, 2))
    )
    ON CONFLICT (id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    -- Nunca bloquear el alta de auth por un error en la creación del perfil.
    NULL;
  END;

  RETURN NEW;
END;
$fn$;
