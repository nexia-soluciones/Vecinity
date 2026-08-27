-- qa_095_096.sql — arnés de 095 (enlace de Telegram) y 096 (multa directa).
--
-- Corre contra PRODUCCIÓN dentro de BEGIN … ROLLBACK: se ejercita el camino
-- real (funciones reales, tablas reales, guards reales) y no queda una sola
-- fila. Las llamadas que deben fallar se envuelven en su propio bloque para
-- capturar el MENSAJE — una excepción que tumba el arnés se lee igual que
-- "mordió", y cuando dos capas rechazan el mismo caso, "pasó / no pasó" no
-- distingue nada: lo que distingue es qué dijo el guard.
BEGIN;

CREATE TEMP TABLE _r(n int, caso text, ok boolean, detalle text) ON COMMIT DROP;

DO $$
DECLARE
  v_comite   uuid;
  v_valeria  uuid;
  v_luis     uuid;
  v_col      uuid;
  v_casa     uuid;
  v_cat      uuid;
  v_tope     numeric;
  v_tok      text;
  v_tok2     text;
  v_res      jsonb;
  v_chat     text := '999900001';   -- chat de prueba, no existe en el padrón
  v_n0       int;
  v_n1       int;
  v_saldo0   numeric;
  v_saldo1   numeric;
  v_id       uuid;
  v_err      text;
  v_monto    numeric := 337;        -- monto raro a propósito: si el saldo se
                                    -- mueve por otra vía, no cuadra por azar
BEGIN
  SELECT id INTO v_col FROM vecino.colonias WHERE slug = 'villa-aurora-demo';
  SELECT id INTO v_comite  FROM vecino.profiles WHERE email = 'comite.demo@vecinity.app';
  SELECT id INTO v_valeria FROM vecino.profiles WHERE email = 'vecino.demo@vecinity.app';
  SELECT id INTO v_luis    FROM vecino.profiles WHERE house_id IS NOT NULL
     AND colonia_id = v_col AND id <> v_valeria LIMIT 1;
  SELECT house_id INTO v_casa FROM vecino.profiles WHERE id = v_valeria;
  SELECT id INTO v_cat FROM vecino.fine_categories WHERE colonia_id = v_col ORDER BY monto_base LIMIT 1;
  SELECT tope_multa INTO v_tope FROM vecino.colonias WHERE id = v_col;

  -- Guard de fixture: si algo de esto falta, TODAS las aserciones de abajo
  -- salen verdes sin haber probado nada. Se para en rojo.
  IF v_col IS NULL OR v_comite IS NULL OR v_valeria IS NULL OR v_casa IS NULL
     OR v_cat IS NULL OR v_tope IS NULL THEN
    RAISE EXCEPTION 'FIXTURE INCOMPLETO: col=% comite=% valeria=% casa=% cat=% tope=%',
      v_col, v_comite, v_valeria, v_casa, v_cat, v_tope;
  END IF;

  -- ============================================================ 095 · tokens
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_valeria)::text, true);

  v_tok := vecino.telegram_link_token();
  INSERT INTO _r VALUES (1, 'el token es de 32 hex', v_tok ~ '^[0-9a-f]{32}$', v_tok);

  v_res := vecino.telegram_link_consumir(v_tok, v_chat);
  INSERT INTO _r VALUES (2, 'canjear un token vivo liga el chat',
    (v_res->>'ok')::boolean AND v_res->>'nombre' = 'Valeria Demo' AND v_res->>'antes' IS NULL,
    v_res::text);
  INSERT INTO _r VALUES (3, 'el chat quedó escrito en el perfil',
    (SELECT telegram_chat_id FROM vecino.profiles WHERE id = v_valeria) = v_chat,
    (SELECT telegram_chat_id FROM vecino.profiles WHERE id = v_valeria));

  v_res := vecino.telegram_link_consumir(v_tok, v_chat);
  INSERT INTO _r VALUES (4, 'un token NO se puede usar dos veces',
    NOT (v_res->>'ok')::boolean AND v_res->>'motivo' = 'usado', v_res::text);

  v_res := vecino.telegram_link_consumir('deadbeef00000000000000000000cafe', v_chat);
  INSERT INTO _r VALUES (5, 'un token inventado no liga nada',
    NOT (v_res->>'ok')::boolean AND v_res->>'motivo' = 'invalido', v_res::text);

  -- Expirado: el caso NO existe solo, hay que construirlo.
  v_tok := vecino.telegram_link_token();
  UPDATE vecino.telegram_link_tokens SET expires_at = now() - interval '1 minute' WHERE token = v_tok;
  v_res := vecino.telegram_link_consumir(v_tok, v_chat);
  INSERT INTO _r VALUES (6, 'un token caducado no liga nada',
    NOT (v_res->>'ok')::boolean AND v_res->>'motivo' = 'expirado', v_res::text);

  -- Pedir uno nuevo mata al anterior (un link viejo en una pestaña no sirve).
  v_tok  := vecino.telegram_link_token();
  v_tok2 := vecino.telegram_link_token();
  v_res  := vecino.telegram_link_consumir(v_tok, v_chat);
  INSERT INTO _r VALUES (7, 'pedir un token nuevo invalida el anterior',
    NOT (v_res->>'ok')::boolean AND v_res->>'motivo' = 'usado', v_res::text);

  -- ★ EL CASO QUE NOS MORDIÓ EL 26-AGO: el teléfono ya es de OTRO perfil.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_comite)::text, true);
  UPDATE vecino.profiles SET telegram_chat_id = NULL WHERE telegram_chat_id = v_chat;
  UPDATE vecino.profiles SET telegram_chat_id = v_chat WHERE id = v_comite;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_valeria)::text, true);
  v_tok := vecino.telegram_link_token();
  v_res := vecino.telegram_link_consumir(v_tok, v_chat);
  INSERT INTO _r VALUES (8, 'el teléfono cambia de cuenta y DICE de quién era',
    (v_res->>'ok')::boolean AND v_res->>'antes' = 'Carlos Demo', v_res::text);
  INSERT INTO _r VALUES (9, 'al perfil anterior se le suelta el chat (no quedan dos dueños)',
    (SELECT telegram_chat_id FROM vecino.profiles WHERE id = v_comite) IS NULL
    AND (SELECT telegram_chat_id FROM vecino.profiles WHERE id = v_valeria) = v_chat,
    coalesce((SELECT telegram_chat_id FROM vecino.profiles WHERE id = v_comite), '(null)'));

  -- El invariante en la BD, no en la disciplina del que escribe.
  BEGIN
    UPDATE vecino.profiles SET telegram_chat_id = v_chat WHERE id = v_comite;
    INSERT INTO _r VALUES (10, 'la BD impide que dos perfiles tengan el mismo chat', false, 'el UPDATE pasó');
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO _r VALUES (10, 'la BD impide que dos perfiles tengan el mismo chat', true, 'unique_violation');
  END;

  -- ====================================================== 096 · multa directa
  SELECT count(*) INTO v_n0 FROM vecino.incident_reports WHERE colonia_id = v_col;
  SELECT saldo    INTO v_saldo0 FROM vecino.houses WHERE id = v_casa;

  -- Un residente no puede multar.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_valeria)::text, true);
  BEGIN
    v_res := vecino.levantar_multa(v_casa, v_cat, 100, 'lo que sea');
    INSERT INTO _r VALUES (11, 'un residente NO puede levantar multas', false, 'pasó');
  EXCEPTION WHEN others THEN
    v_err := SQLERRM;
    INSERT INTO _r VALUES (11, 'un residente NO puede levantar multas',
      v_err LIKE '%Solo el comité%', v_err);
  END;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_comite)::text, true);

  -- Sin relato no hay multa: quien la reciba no podría ni aclararla.
  BEGIN
    v_res := vecino.levantar_multa(v_casa, v_cat, 100, '   ');
    INSERT INTO _r VALUES (12, 'exige escribir qué pasó', false, 'pasó');
  EXCEPTION WHEN others THEN
    v_err := SQLERRM;
    INSERT INTO _r VALUES (12, 'exige escribir qué pasó', v_err LIKE '%Escribe qué pasó%', v_err);
  END;

  -- ★ Atomicidad: si el monto se pasa del tope, TAMPOCO queda el expediente.
  BEGIN
    v_res := vecino.levantar_multa(v_casa, v_cat, v_tope + 1, 'se pasó del tope');
    INSERT INTO _r VALUES (13, 'respeta el tope de la colonia', false, 'pasó');
  EXCEPTION WHEN others THEN
    v_err := SQLERRM;
    INSERT INTO _r VALUES (13, 'respeta el tope de la colonia', v_err LIKE '%tope%', v_err);
  END;
  SELECT count(*) INTO v_n1 FROM vecino.incident_reports WHERE colonia_id = v_col;
  INSERT INTO _r VALUES (14, 'una multa rechazada NO deja expediente huérfano',
    v_n1 = v_n0, format('antes %s, después %s', v_n0, v_n1));

  -- Categoría de otra colonia.
  BEGIN
    v_res := vecino.levantar_multa(v_casa,
      (SELECT id FROM vecino.fine_categories WHERE colonia_id <> v_col LIMIT 1),
      100, 'categoría ajena');
    INSERT INTO _r VALUES (15, 'no acepta una categoría de otra colonia', false, 'pasó');
  EXCEPTION WHEN others THEN
    v_err := SQLERRM;
    INSERT INTO _r VALUES (15, 'no acepta una categoría de otra colonia',
      v_err LIKE '%no es de tu colonia%', v_err);
  END;

  -- Casa de otra colonia (el guard lo pone reportar_incidencia, la puerta vieja).
  BEGIN
    v_res := vecino.levantar_multa(
      (SELECT id FROM vecino.houses WHERE colonia_id <> v_col LIMIT 1),
      v_cat, 100, 'casa ajena');
    INSERT INTO _r VALUES (16, 'no acepta una casa de otra colonia', false, 'pasó');
  EXCEPTION WHEN others THEN
    v_err := SQLERRM;
    INSERT INTO _r VALUES (16, 'no acepta una casa de otra colonia',
      v_err LIKE '%no pertenece a tu colonia%', v_err);
  END;

  -- Camino feliz.
  v_res := vecino.levantar_multa(v_casa, v_cat, v_monto,
             'Cochera bloqueada la noche del sábado', NULL, 'Visto por el comité');
  v_id  := (v_res->>'id')::uuid;
  SELECT saldo INTO v_saldo1 FROM vecino.houses WHERE id = v_casa;

  INSERT INTO _r VALUES (17, 'la multa directa queda como multa, no como pendiente',
    (SELECT estado::text FROM vecino.incident_reports WHERE id = v_id) = 'multa',
    (SELECT estado::text FROM vecino.incident_reports WHERE id = v_id));
  INSERT INTO _r VALUES (18, 'queda marcada como levantada por el comité',
    (SELECT origen FROM vecino.incident_reports WHERE id = v_id) = 'comite',
    (SELECT origen FROM vecino.incident_reports WHERE id = v_id));
  INSERT INTO _r VALUES (19, 'genera el cargo con el monto exacto',
    (SELECT monto FROM vecino.transactions WHERE id = (v_res->>'transaction_id')::uuid) = v_monto,
    (SELECT monto::text FROM vecino.transactions WHERE id = (v_res->>'transaction_id')::uuid));
  INSERT INTO _r VALUES (20, 'el saldo de la casa sube exactamente el monto',
    v_saldo1 - v_saldo0 = v_monto, format('%s → %s', v_saldo0, v_saldo1));
  INSERT INTO _r VALUES (21, 'guarda el relato y la nota del comité',
    (SELECT descripcion FROM vecino.incident_reports WHERE id = v_id) = 'Cochera bloqueada la noche del sábado'
    AND (SELECT resolucion_admin FROM vecino.incident_reports WHERE id = v_id) = 'Visto por el comité',
    (SELECT descripcion FROM vecino.incident_reports WHERE id = v_id));
  INSERT INTO _r VALUES (22, 'deja firmado quién la resolvió',
    (SELECT resolved_by FROM vecino.incident_reports WHERE id = v_id) = v_comite
    AND (SELECT resolved_at FROM vecino.incident_reports WHERE id = v_id) IS NOT NULL,
    (SELECT resolved_by::text FROM vecino.incident_reports WHERE id = v_id));
  INSERT INTO _r VALUES (23, 'la sugerencia cuenta la reincidencia recién creada',
    (vecino.sugerir_multa(v_casa, v_cat)->>'reincidencias')::int = 1,
    vecino.sugerir_multa(v_casa, v_cat)::text);
END $$;

SELECT n,
       CASE WHEN ok THEN '  OK  ' ELSE '*FALLA' END AS r,
       caso,
       CASE WHEN ok THEN '' ELSE detalle END AS detalle
  FROM _r ORDER BY n;

ROLLBACK;
