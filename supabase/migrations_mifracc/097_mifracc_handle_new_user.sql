-- ============================================================
-- MIFRACC · Trigger nuevo y separado sobre auth.users (tabla compartida)
-- Espejo de vecino.handle_new_user(), guard propio app='mifracc'.
-- No modifica ni reemplaza el trigger/función de Vecinity
-- (on_auth_user_created -> vecino.handle_new_user(), verificado en vivo
-- vía MCP supabase-nexia, solo lectura, antes de escribir este archivo).
-- ============================================================
CREATE OR REPLACE FUNCTION mifracc.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mifracc, auth
AS $fn$
BEGIN
  -- Guard: solo crear perfil si el alta viene de la app miFracc.
  IF COALESCE(NEW.raw_user_meta_data->>'app','') <> 'mifracc' THEN
    RETURN NEW;
  END IF;

  BEGIN
    INSERT INTO mifracc.profiles (id, nombre, email, telefono, role, approval_status, avatar)
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

REVOKE ALL ON FUNCTION mifracc.handle_new_user() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mifracc.handle_new_user() TO service_role;

DROP TRIGGER IF EXISTS on_auth_user_created_mifracc ON auth.users;
CREATE TRIGGER on_auth_user_created_mifracc
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION mifracc.handle_new_user();
