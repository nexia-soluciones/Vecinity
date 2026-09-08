# Plan: schema `mifracc` en la Supabase self-hosted de Nexia

**Fecha:** 2026-08-28
**Estado:** planificado, **sin ejecutar** — Vecinity (`vecino`) está en producción y no se puede pausar.
**Objetivo:** crear un schema nuevo `mifracc` en la misma instancia Supabase self-hosted (`supabase.nexiasoluciones.com.mx`) que ya usa Vecinity, con la misma estructura de tablas que `vecino` (sin datos reales), para construir ahí el rediseño (entitlements módulo→rol→funcionalidad) sin tocar nada de Vecinity. Después se conecta ese schema al proyecto `operia-mifracc`.

## Contexto (por qué esto no es trivial)

La instancia Supabase self-hosted es **compartida** por varias apps de Nexia: `vecino` (Vecinity), `scholar`, `pdca`, `vsm`, `smed`, `heijunka`, `nexia_billing`. Dos cosas son compartidas entre todas ellas y hay que tratarlas con cuidado:

- **`auth.users`** — un solo pool de usuarios/autenticación para toda la instancia. Cada app filtra a los suyos con su propio patrón (Vecinity usa `raw_user_meta_data->>'app' = 'vecino'` como guard en su trigger de alta).
- **La lista de schemas expuestos en PostgREST** (`ALTER ROLE authenticator SET pgrst.db_schemas TO '...'`) — es una sola configuración a nivel de rol que se **reemplaza completa**, no se agrega. Si al construir el comando se omite un schema que ya está activo, esa app deja de responder al instante.

Fuera de esos dos puntos compartidos, crear un schema nuevo (`CREATE SCHEMA mifracc`) y tablas dentro de él es una operación aislada que no puede tocar nada de `vecino`.

## Pasos

1. **Confirmar en vivo la lista real de schemas activos en PostgREST** (solo lectura — `SELECT rolconfig FROM pg_roles WHERE rolname='authenticator'` vía `/pg/query`), en vez de confiar en la lista documentada (puede estar desactualizada). Cero riesgo, es un SELECT.
2. **`CREATE SCHEMA mifracc`** — aislado, no afecta a `vecino`.
3. **Generar las migraciones de `mifracc`** a partir de las 99 de Vecinity (`supabase/migrations/001..096`), con el schema renombrado `vecino` → `mifracc` en todo el SQL (tablas, enums, funciones `SECURITY DEFINER`, políticas RLS). Reconstruye la estructura completa, vacía. Dos cosas NO son schema-scoped y hay que ajustarlas para no chocar con lo de Vecinity:
   - **Buckets de Storage** (`vecino-recibos`, `vecino-evidencias`, etc.) son globales a la instancia → renombrar a `mifracc-recibos`, etc.
   - **Trigger de alta de usuario** sobre `auth.users` (tabla compartida) → agregar un trigger **nuevo y separado** (`on_auth_user_created_mifracc` → `mifracc.handle_new_user()`) con su propio guard (`app = 'mifracc'`), sin tocar el trigger existente de Vecinity. Mismo patrón que ya usan para `smed`/`heijunka`.
4. **GRANTs del schema nuevo** a `anon`/`authenticated`/`service_role` (plantilla ya documentada en `nexia-tools/MCP_SUPABASE_REGLAS.md`).
5. **Exponer `mifracc` en PostgREST** con la lista completa confirmada en el paso 1 + `mifracc` agregado. Verificar inmediatamente después que las demás apps (`vecino` incluido) siguen respondiendo antes de dar el cambio por bueno.
6. **Conectar `operia-mifracc` al schema nuevo:** los clientes Supabase del repo (`src/lib/supabase/browser.ts`, `admin.ts`) están hardcodeados al schema `vecino` → cambiar esa opción a `mifracc`, y crear `.env.local` propio (misma URL/keys de la instancia, apuntando al schema nuevo).

## Paso 2 — completado (2026-09-08, vía SSH directo, verificado)

`CREATE SCHEMA mifracc;` ejecutado directo contra `nexia-supabase_supabase-db-1` (Daniel, por SSH,
método paso a paso: ejecutar → verificar antes de seguir). Confirmado con
`SELECT nspname FROM pg_namespace WHERE nspname IN ('mifracc','vecino')`: las dos filas presentes,
`mifracc` vacío y `vecino` intacto. Sin tocar PostgREST todavía (Paso 5 sigue pendiente, no ejecutar
hasta terminar Pasos 3-4).

## Decisión: estructura primero, sin datos reales

No copiar datos reales de Vecinity a `mifracc`, ni ahora ni en el corto plazo:

- El objetivo de `mifracc` es rediseñar el modelo (agregar entitlements, volver los roles parametrizables) — en cuanto empiece esa cirugía, la estructura se separa de la de `vecino`, así que una copia de datos de hoy quedaría obsoleta rápido.
- Los datos de Vecinity son datos reales de vecinos (nombres, teléfonos, saldos, fotos de INE) — no hay razón para que vivan en un schema de desarrollo/experimentación.
- Mejor: sembrar `mifracc` con datos sintéticos/demo (mismo patrón que ya usa Vecinity: cuentas demo, invitaciones tipo `CAT-128`) mientras se construye. La pregunta de migrar datos reales se retoma en el momento del cutover real, cuando el modelo ya esté estable.

## Paso 1 — completado (2026-08-28, solo lectura)

Se confirmó en vivo (`SELECT rolconfig FROM pg_roles WHERE rolname='authenticator'`, corrido por Daniel desde su Terminal — la VM de Cowork no tiene salida a internet) la lista real de schemas expuestos en PostgREST:

```
public, storage, graphql_public, vecino, scholar, pdca, vsm, smed, heijunka,
nexia_core, nexia_billing, nexia_tienda, vsm_studio, edu, sourcing,
nexia_marketing, nexia_control, horacio_core, simulador, clips, obra, firma
```

**Esto confirma que la lista documentada en `nexia-tools/MCP_SUPABASE_REGLAS.md` y `NEXIA-OS.md` está desactualizada** (le faltan `nexia_core`, `nexia_tienda`, `vsm_studio`, `edu`, `sourcing`, `nexia_marketing`, `nexia_control`, `horacio_core`, `simulador`, `clips`, `obra`, `firma` — 12 schemas). Si hubiéramos construido el `ALTER ROLE` del paso 5 con la lista de la doc, habríamos tirado el acceso PostgREST de 12 apps activas. Confirma que este paso de verificación en vivo no era opcional.

**Comando exacto para el paso 5 (listo para cuando lleguemos ahí, NO ejecutar todavía):**
```sql
ALTER ROLE authenticator SET pgrst.db_schemas TO
  'public,storage,graphql_public,vecino,scholar,pdca,vsm,smed,heijunka,nexia_core,nexia_billing,nexia_tienda,vsm_studio,edu,sourcing,nexia_marketing,nexia_control,horacio_core,simulador,clips,obra,firma,mifracc';
NOTIFY pgrst, 'reload schema';
```

**Hallazgo adicional a investigar antes de diseñar entitlements:** existe un schema `nexia_core` que no aparecía en la documentación revisada ni en el repo `nexia-subscription`. `SUPABASE_MULTIAPP_USERS.md` menciona de pasada "el nuevo estándar usa `nexia_core.org_members` + `nexia_billing.nexia_subscriptions`" — vale la pena revisar el contenido real de `nexia_core` antes de diseñar el modelo de entitlements de miFracc, por si ya existe ahí un patrón de organización/membresía reutilizable (o al menos como referencia de convención) a nivel de plataforma Nexia.

## Hallazgo: `nexia_core` (inspeccionado 2026-08-28, solo lectura)

`nexia_core` ya existe en la instancia y modela algo parecido a lo que necesitamos, pero **un nivel arriba** de lo que resuelve `colonia_id` dentro de Vecinity:

- **`organizations`** (id, name, slug, org_type, owner_id) — el "cliente/organización" de Nexia como entidad transversal a todos sus productos.
- **`org_members`** (org_id, user_id, role) — membresía con rol, por organización.
- **`org_app_access`** (org_id, app_slug, enabled, granted_at, granted_by) — **switch de qué apps de Nexia tiene prendidas cada organización.**
- **`cross_app_references`** — liga entidades entre apps distintas (source_app/entity → target_app/entity).
- **`v_user_apps`** — vista agregada de qué apps/suscripciones/presencia tiene un usuario.

**Por qué esto no es lo mismo que necesitamos (pero sí es la referencia de patrón correcta):** `nexia_core` resuelve "¿esta organización cliente de Nexia tiene prendida la app X (scholar, pdca, vecino...) completa, sí o no?" — un toggle a nivel de **app entera**, por organización. Lo que pediste para miFracc es un nivel más fino y *dentro* de una sola app: un fraccionamiento (~equivalente a una `organization` aquí) prendiendo/apagando **módulos, roles y funciones individuales** dentro de miFracc. `org_app_access` no baja a ese nivel de granularidad — es la misma forma de tabla (`entidad_id, cosa_slug, enabled`) pero habría que replicarla un piso más abajo: `colonia_module_access`, y luego roles/funciones parametrizables por colonia, que no existen en ningún lado todavía.

**Pregunta estratégica que esto abre (para decidir contigo, no la resuelvo yo):** ¿los fraccionamientos de miFracc deberían registrarse como filas de `nexia_core.organizations` (con `org_app_access` dándoles acceso a la app `mifracc`), aprovechando la infraestructura de organización/billing que Nexia ya tiene para todo su ecosistema? ¿O deben vivir como un concepto 100% local dentro del schema `mifracc` (tabla `colonias` propia, como hoy en `vecino`), sin depender de `nexia_core`? La primera opción reutiliza infraestructura ya construida; la segunda mantiene a miFracc desacoplado de Nexia desde el día uno — que es justo la dirección de largo plazo que describe el brief (Vecinity/miFracc eventualmente sale de Nexia Soluciones). Enganchar el tenant raíz de miFracc a una tabla que vive en la infraestructura compartida de Nexia iría en sentido contrario a ese desacople.

## Decisión (2026-08-28, Daniel)

**miFracc queda aislado de `nexia_core`.** `colonias` sigue siendo un concepto 100% local dentro del schema `mifracc` (igual que hoy en `vecino`), sin filas en `nexia_core.organizations` ni dependencia de `org_app_access`. Razón: miFracc va a ser una app compleja por sí sola — varios fraccionamientos, cada uno con 200-300 casas — y se mantiene como aplicación independiente, no enganchada a la infraestructura compartida de Nexia. Esto es consistente con la dirección de largo plazo del proyecto (Vecinity/miFracc eventualmente sale de Nexia Soluciones).

Con esto, el modelo de entitlements de miFracc (`colonias` → módulos → roles → funciones) se diseña 100% dentro del schema `mifracc`, sin tocar ni depender de `nexia_core`. El hallazgo de `nexia_core.org_app_access` queda solo como referencia de patrón (forma de tabla `entidad_id, cosa_slug, enabled`), no como dependencia.

## División de trabajo: Cowork vs. Claude Code + VS Code (2026-09-01)

La VM que usa esta sesión de Cowork **no tiene salida a internet** (confirmado antes al intentar pegarle a Supabase). Eso fija cómo se reparte el trabajo de aquí en adelante:

- **Cowork (esta sesión):** orquestación, plan, documentación, memoria del proyecto, preparar el contenido exacto de migraciones/instrucciones, y cualquier edición de archivos que no requiera red.
- **Claude Code + VS Code (terminal real de Daniel):** todo lo que necesita red — `npm install`, correr la app localmente, instalar/usar el MCP de Supabase self-hosted, y ejecutar el resto del plan de schema (pasos 2-6) contra la instancia real.

**Regla para no pisarnos:** si Daniel está editando código activamente en VS Code, Cowork no toca esos mismos archivos en paralelo — se avisa antes.

## Orden acordado para retomar (2026-09-01)

Antes de tocar el schema, primero confirmar que la app corre bien tal como está (baseline), luego proceder al schema, luego a datos dummy:

1. **Verificar que `operia-mifracc` corre en local** (Claude Code/VS Code, necesita red): `npm install`, crear `.env.local` propio (aún apuntando al schema `vecino` — no existe `mifracc` todavía), `npm run dev`, entrar con las cuentas **demo de Villa Aurora** (ver `docs/manual/MANUAL_VENDEDOR.md`: `vecino.demo@vecinity.app` / `comite.demo@vecinity.app` / `guardia.demo@vecinity.app`) — es la colonia ficticia que ya usan para demos, así que no hay riesgo de tocar datos de colonias reales.
2. **Configurar el MCP de Supabase self-hosted en Claude Code**, instruyéndolo a leer `~/dev/nexia-tools/MCP_SUPABASE_REGLAS.md` (instalación, rutas permitidas, reglas de DDL) y `~/dev/nexia-tools/NEXIA-OS.md` para contexto general del ecosistema.
3. **Ejecutar el resto del plan de schema** (pasos 2-6 de este documento) desde Claude Code, ahora con el MCP disponible.
4. **Analizar los datos reales de `vecino`** (solo lectura, vía MCP) para entender formas/rangos reales de los datos (casas, saldos, vehículos, etc.) y diseñar un generador de datos sintéticos/dummy para sembrar `mifracc` — nunca copiar datos reales, solo usarlos de referencia para que lo sintético sea realista.

## Paso 3 en curso (2026-09-08) — hallazgos y decisiones del mapeo `vecino`→`mifracc`

Claude Code mapeó las ~4,050 ocurrencias de "vecino" en las 99 migraciones copiadas a
`supabase/migrations_mifracc/` (sin editar nada todavía). Se dividen en: (1) ~3,960 referencias
de schema/funciones/RLS — mecánico, seguro reemplazar; (2) buckets de Storage y sus políticas —
también mecánico; (3) 11 casos donde "vecino" es dato de negocio, texto de UI, o comentario —
NO tocar con reemplazo ciego; (4) ~370 comentarios en español usando "vecino" como palabra común
— se dejan tal cual, no forzar el español.

**Decisiones (Daniel, 2026-09-08):**
- **`073_frente_por_tipo.sql` (URL real de imágenes de Villa Catania en el bucket
  `vecino-tarjetas`) queda EXCLUIDA de mifracc por ahora.** Pendiente: resolver cuando
  definamos cómo sembrar imágenes sintéticas de tarjetas.
- **`033b_reglamento_seed.sql` (texto legal real del reglamento de un cliente real) queda
  EXCLUIDA de mifracc por ahora.** La estructura de tabla `reglamento` se puede recrear más
  adelante con texto de ejemplo genérico.
- **`005_fix_handle_new_user.sql`** no se copia tal cual (su guard es `app='vecino'`, específico
  del trigger compartido de Vecinity) — se investiga la cadena completa de `handle_new_user`
  y se escribe UNA migración nueva para mifracc con guard `app='mifracc'`, sin tocar el trigger
  existente de Vecinity.

**Pendiente de diseño (NO para hoy, para la fase de entitlements):** vocabulario propio de
producto para diferenciar miFracc de Vecinity — "Residente" en vez de "vecino", "Fraccionamiento"
en vez de "villa/condominio", donde el contexto de UI lo amerite. Se decide junto con el glosario
completo de roles (Residente/Comité/Administrador) cuando se diseñe el modelo de entitlements,
no como parte del reemplazo mecánico de schema de hoy.

## Paso 3.3 — completado (2026-09-08, reemplazo mecánico verificado)

Reemplazo vecino→mifracc aplicado solo en `supabase/migrations_mifracc/` (schema, search_path,
GRANTs, buckets/políticas de Storage — 3,089 reemplazos en 96 archivos). Verificado con grep:
cero ocurrencias de schema/bucket `vecino` restantes en el set principal; lo único que queda son
los ~380 casos de dato de negocio/UI/comentario que se dejaron intactos a propósito. Original
`supabase/migrations/` confirmado sin cambios (`git diff --stat` vacío). Los 3 archivos excluidos
(`073_frente_por_tipo.sql`, `033b_reglamento_seed.sql`, `005_fix_handle_new_user.sql`) están en
`supabase/migrations_mifracc/_excluidos/` con TODO explicando el motivo. Nada ejecutado contra
la base de datos.

Siguiente: construir la migración nueva y separada para el trigger de `auth.users` de mifracc
(guard `app='mifracc'`, sin tocar el trigger existente de Vecinity) — investigar primero toda la
cadena de `handle_new_user` en las 99 migraciones originales antes de escribir nada.

## Próximo paso inmediato

Daniel arranca el paso 1 (verificar que la app corre) desde Claude Code + VS Code. Cowork prepara, si hace falta, el contenido del `.env.local` y cualquier ajuste de código que el arranque revele.
