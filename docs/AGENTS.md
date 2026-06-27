# AGENTS.md — Vecinity

> Plataforma de comunidad segura: administración de fraccionamiento + vigilancia vecinal.
> Migración del monolito Django (PythonAnywhere, SQLite) → arquitectura Nexia.
> Última actualización: 2026-06-27
>
> 🔎 **RETOMAR AQUÍ:** ver `REVISION_PENDIENTE.md` — paridad para lanzamiento (deploy ≠ cutover).
> El review E2E del 2026-06-27 (abajo) verificó BD + 13 rutas contra producción: **~82% al lanzamiento**.

## Review end-to-end + manual de usuario (2026-06-27) ✅
Verificación contra la **BD real de producción** (no solo docs) + captura de pantallas para el manual.
- **BD sana:** 51 tablas, **RLS en 51/51** (0 tablas bloqueadas sin política), **50 funciones SECURITY DEFINER**,
  5 triggers. Datos reales intactos: 2 colonias, 119 casas, 285 vehículos, 2,428 tx, 218 incidencias, 119 invitaciones.
  **Todas las RPCs que llama la UI existen** (crear_reserva, registrar_visita, agregar_vehiculo, registrar_abono,
  reportar_incidencia, resolver_*, iniciar_turno, marcar_visita_por_token, generar_cobros, convenios, crons…).
- **`npm run build` limpio** · 13 rutas (4 residente + comité + áreas + vigilancia + pase público dinámico).
- **Smoke test visual** de las 13 pantallas en los 3 roles + pase público sin login: todas renderizan con datos
  reales vía RLS (JWT, no service role). Verificada la **integración cross-feature**: una visita creada por el
  residente aparece en `/vigilancia` del guardia con botón Entrada. Sin errores de consola.
- **Hallazgo (no bug):** la cuenta `juanperez` (residente) no tenía casa ligada → se ligó a **casa 100** como
  casa demo (los residentes reales reciben casa vía invitación, así que no es un defecto del producto).

### Cuentas demo (colonia La Cantera) — para captures/pruebas
| Cuenta | Rol | Password | Notas |
|---|---|---|---|
| `comite@cantera.test` | comité | `Comite2026` | casa 128 |
| `juanperez@cantera.test` | residente | `Vecino2026` | ligado a **casa 100** (al corriente) para demo |
| `guardia@cantera.test` | guardia | `Guardia2026` | aterriza en `/vigilancia` |

> Passwords fijados vía **Auth Admin API** (`PUT /auth/v1/admin/users/{id}`), no por MCP
> (`update_auth_user` exige DATABASE_URL = puerto 5432 bloqueado).

### Capturas del manual
- `capture-manual.mjs` — onboarding + login + comité + esperando (capturas 01–07). **No re-correr a la ligera**:
  el flujo de onboarding **crea un usuario real** (invitación `DEMO-MANUAL`).
- `capture-manual-2.mjs` — **funciones del 23-jun** (capturas 08–18, Playwright 390×844). Logea como
  residente/comité/guardia y captura dashboard, reservas, visitas+QR, pase público, vehículos, pagos,
  incidencias, panel comité, áreas y vigilancia. **Es idempotente**: crea 1 visita ("María López") + 1 vehículo
  ("DEMO01A") de ejemplo; limpiarlos antes de re-correr con el DELETE de abajo.
- `next.config.ts` lleva `devIndicators: false` para capturas limpias (solo afecta dev, inocuo en prod).
- Limpieza de datos de ejemplo (deja la casa demo intacta):
  ```sql
  DELETE FROM vecino.visitors WHERE house_id='26189134-1f76-47de-9233-a7f1a64d5443' AND nombre='María López';
  DELETE FROM vecino.vehicles WHERE house_id='26189134-1f76-47de-9233-a7f1a64d5443' AND placa='DEMO01A';
  ```
- Manual de usuario actualizado: `manual/Manual_de_Uso_Vecinity.md` (16 secciones, 18 capturas).

### Gaps confirmados para lanzar (no son bugs; falta construir)
- **Caseta:** fotos INE/placas + registro manual de visita en caseta (lo usan a diario los guardias).
- **Finanzas comité:** conciliación bancaria CSV + dashboard de gastos + export.
- **Limpieza:** 36/285 placas placeholder.
- **Deploy real:** lo ejecuta Daniel en EasyPanel (se puede reusar el slot `vecinovigilante.nexiasoluciones.com.mx`).

## Caseta — registro manual + fotos INE/placas + historial (2026-06-27) ✅
Cierra el pendiente #1 de lanzamiento. **Migración `021_caseta.sql`** (aplicada vía `/pg/query`):
- `registrar_visita_manual(nombre, house_id, placa, foto_ine_url, foto_placa_url)` — walk-in sin pase:
  entra como `adentro`, sella `guardia_entrada_id`+`fecha_hora_entrada`. **GOTCHA:** `visitors.origen_registro`
  tiene CHECK `IN ('vecino','vigilante')` → se usa **`'vigilante'`** (no un valor nuevo, evita abort 23514).
- `adjuntar_fotos_visita(id, foto_ine_url, foto_placa_url)` — para el flujo QR: el guardia adjunta fotos
  al marcar entrada (no pisa fotos previas, `coalesce`). Ambas SECURITY DEFINER gateadas por `is_guard()`.
- **El esquema ya tenía los campos** (`foto_identificacion_url`, `foto_placas_url`, `plate_detected`,
  `origen_registro`, sellos guardia/hora) desde `002` — solo faltaban las RPCs + UI.
- **UI `/vigilancia`**: form "+ En caseta" (nombre, casa, placa, foto INE, foto placas), 📷 para adjuntar
  INE a una visita QR antes de Entrada, y sección **Historial de hoy** (entradas/salidas del día con enlaces
  a las fotos). Fotos a Storage `vecino-evidencias` (subcarpeta `visitas`) vía el helper `subirFoto` existente.
- **Verificado E2E** con cuenta `guardia`: registro manual → visita `adentro` (origen `vigilante`, placa,
  sellos) + aparece en Historial. `npm run build` limpio. 0 errores de consola.
- **Pendiente caseta (post-lanzamiento):** OCR de placas (visión Claude, no Tesseract) · gafetes (nexia-print-bridge).

## Qué es
Producto unificado (decisión 2026-06-22) que fusiona dos ideas:
- **Administración de condominio** (legacy Django `proyecto-condominio/`, "Villa Catania")
- **Vigilancia vecinal** (SOS/pánico, zonas, capitán de calle, comité de auxilio electo por votación)

Hook de venta: seguridad para otras colonias. Multi-tenant desde diseño (`colonia_id` en todo).

## Stack destino
- Frontend: **Next.js 16 + TS + Tailwind v4** (PWA) — pendiente de crear
- BD: **Supabase self-hosted** · schema **`vecino`**
- Auth/Acceso: Supabase Auth + `nexia_billing` (app_slug `vecino`)
- Automatización: **n8n + pg_net** · OCR placas: **Tesseract local**
- Notificaciones: **Telegram** (decisión del Director)

## Estado de la BD — ✅ COMPLETA (2026-06-22)
Schema `vecino` reconstruido desde cero. **44 tablas, RLS en todas (91 políticas), expuesto en PostgREST (HTTP 200).**
Migraciones reproducibles en `supabase/migrations/`:
- `001_core.sql` — colonias, zones, houses, profiles, invitations + helpers RLS (`my_colonia_id()`, `my_role()`, `is_admin()`)
- `002_finance_vehicles_rfid.sql` — transactions, payments, expenses, fines, vehicles, visitors(+OCR), RFID (tags/access/suspensions)
- `003_security_cameras_governance.sql` — sos_events, alerts, safe_points, cameras, camera_events, proposals, votes, committee
- `004_operations_community_notifications.sql` — packages, reservations, parking, shifts, services, marketplace, notifications
- `005_fix_handle_new_user.sql` — **fix crítico** (ver abajo)

### Módulos del schema (A–L)
A Núcleo · B Finanzas · C Multas · D Vehículos/Visitantes+OCR · E Seguridad vecinal ·
F Comité+Votación · G Mejoras · H Operación · I Comunidad · J Notificaciones · K Acceso RFID · L Cámaras IP

### ⚠️ Aprendizaje crítico (handle_new_user)
La limpieza inicial borró tablas y enums del schema viejo pero **NO las funciones**. Sobrevivió
`vecino.handle_new_user()` + el trigger global `on_auth_user_created` en `auth.users`, que insertaba
columnas/enums viejos → habría roto el alta de usuarios de **todo el ecosistema**. Fix: función con
**guard** (`raw_user_meta_data->>'app' = 'vecino'`), columnas/enums nuevos y `EXCEPTION WHEN OTHERS`
(nunca bloquea el alta de auth). Las altas de Vecinity deben mandar `app: 'vecino'` en el metadata del signUp.
> Nota: existen triggers gemelos sin guard `on_auth_user_created_smed` / `_heijunka` (deuda conocida en NEXIA-OS).

## Acceso a BD (reglas Nexia)
- DDL vía `curl POST /pg/query` con `SUPABASE_SERVICE_ROLE_KEY` (en `NexIA_Tienda/.env.local`).
  `/pg/query` corre **todo en una transacción** (un error = rollback total).
- Lectura/verificación: MCP `supabase-nexia` `execute_sql` (read_only, sin `;` final).
- RLS: toda tabla con `colonia_id` filtra por `vecino.my_colonia_id()` (SECURITY DEFINER, sin recursión).

## Respaldo
`backup_vecino_schema_2026-06-22.json` — datos de prueba del schema viejo (vigilancia), por si acaso.

## App Next.js — `vecinity-app/` (2026-06-22)
Next.js 16.2.9 + React 19 + Tailwind v4. Corre en `http://localhost:3100` (`npm run dev`).
- Marca: `public/brand/` (vecinity-logo, powered-by-nexia morado). Tema en `globals.css` (`--color-brand-*`).
- **Onboarding cableado a Supabase** (`src/app/page.tsx` + `src/app/actions.ts`):
  1. Valida invitación (`validateInvitation`) → embed colonia+casa. ✅ probado
  2. Crea cuenta (`completeOnboarding` → `auth.admin.createUser` con `user_metadata.app='vecino'`
     → trigger `handle_new_user` crea perfil pendiente → upsert liga colonia/casa → marca invitación usada). ✅ probado
  3. Telegram (deep-link `NEXT_PUBLIC_TELEGRAM_BOT`, pendiente bot real)
  4. Inicia sesión y va a `/esperando` (pantalla de aprobación pendiente).
- Clientes: `src/lib/supabase/browser.ts` (anon, schema vecino) · `admin.ts` (service role, solo server).
- `.env.local` con URL+anon+service role (gitignored). Invitación de prueba: **`CANTERA2026`**.

## Dashboard post-login — `src/app/dashboard/page.tsx` (2026-06-22)
Role-aware, gateado por sesión + `approval_status`. Validado end-to-end con RLS real (JWT, no service role):
- Residente: tarjeta de saldo (verde/ámbar), acciones rápidas, **botón SOS** (insert `sos_events`). ✅
- Comité/admin: panel **Solicitudes pendientes** → Aprobar/Rechazar (`profiles.approval_status`). ✅
- `/esperando` enlaza a `/dashboard` cuando aprobado.
Cuentas de prueba (colonia La Cantera): **comite@cantera.test / Comite2026** (comité, casa 128 saldo 1600) ·
**juanperez@cantera.test / Vecino2026** (residente pendiente, para demo de aprobación).

## Telegram — bot "Caty" (@Caty_VCatania_bot) (2026-06-22)
- Token en `vecinity-app/.env.local` (`TELEGRAM_BOT_TOKEN`, gitignored) + embebido en el workflow n8n. Username público: `Caty_VCatania_bot` (`NEXT_PUBLIC_TELEGRAM_BOT`).
- **Enganche de chat**: onboarding deep-link `t.me/Caty_VCatania_bot?start=vecino_<profileId>` → webhook n8n
  **`Vecinity - Telegram (Caty)`** (ID `QcbjAUiwnW28lXLw`, ACTIVO, webhook `…/webhook/vecino-telegram`)
  → Code llama RPC **`vecino.link_telegram(uuid,text)`** (SECURITY DEFINER, usa anon key, no service role)
  → guarda `profiles.telegram_chat_id` y Caty responde. ✅ probado end-to-end.
- Sanitización: profileId validado como UUID antes de la RPC (anti-inyección).

## Migración de datos SQLite→Supabase (2026-06-22) ✅
Generador reproducible: `migrate.py` (lee `proyecto-condominio/db.sqlite3`, emite SQL para `/pg/query`).
Migrado: **2 colonias** (villas), **119 casas** (saldo/estatus/teléfonos/propietario), 52 marcas + 351 modelos,
**285 vehículos**, 7 categorías de multa, **150 pagos**, **2,427 transacciones**, **218 multas**,
8 propuestas + 139 votos, 15 gastos, áreas comunes, folios. Integridad: 0 huérfanos. 39 casas con adeudo ($76,968).
- **Usuarios NO migrados** (passwords Django incompatibles): se generó **1 invitación por casa** (119, código `CAT-<numero>`)
  para que cada vecino se re-registre con el onboarding y quede ligado a su casa.
- **Omitido** (logs transitorios ligados a usuarios): visitantes (3957), reservaciones (659), turnos, servicios, paquetes.
- Demo `comite@cantera.test` re-ligado a colonia "Villa Catania" + casa 128 (Juan Garcés, saldo $250) → el dashboard ya muestra datos reales.

## Diagnóstico comunitario (Presión vs. Resiliencia) — captura instrumentada (2026-06-22)
Migración `006_diagnostics_capture.sql`. Solo CAPTURA de señales (índice/tablero DIFERIDO a post-deploy,
necesita tendencia). Norte de producto: `docs/diagnostico-comunitario.md`.
Nuevo: `incident_reports.resolved_at/by`, `security_reports.resolved_at`, `houses.estado_fisico`,
`colonias.fondo_comun`; tablas `condition_logs`, `assemblies`, `assembly_attendance`, `fund_snapshots`,
`house_tenancy_log` (trigger auto de rotación) + trigger condition→houses.estado_fisico. (49 tablas total.)

## Notificaciones automáticas (2026-06-22) ✅
Migración `007_notifications.sql`. Token SOLO en `vecino.tg_send()` (SECURITY DEFINER, no en tabla expuesta).
- **🆘 SOS** → trigger `trg_notify_sos` en `sos_events` → pg_net → Telegram al comité/admin de la colonia + capitán de zona (con ubicación). ✅ pipeline probado (pg_net llega a Telegram API).
- **💸 Saldo alto** → trigger `trg_notify_saldo` en `houses` (al cruzar `umbral_saldo_alerta`) → al residente.
- **⏰ Pago vencido (>vencimiento)** → `vecino.run_late_fee_notifications()` (idempotente vía `notifications`),
  disparado por workflow n8n **`Vecinity - Cobros vencidos (diario)`** (ID `0v1MkIlynKVySxSK`, ACTIVO, 9am MX)
  vía wrapper `vecino.cron_late_fees(token)` (gate, anon key, sin service role). 53 pagos vencidos pendientes de correr.
- Todo se registra en `vecino.notifications` (log/auditoría). pg_cron NO existe → schedule por n8n.

## Panel del comité — ✅ centro de mando (2026-06-23)
Mejora del `dashboard_admin` legacy. `/dashboard/comite` (rol admin/comité):
- **Pendientes** en un solo lugar (conteo + link): abonos, vehículos, incidencias, vecinos.
- **Finanzas de la colonia**: adeudo total (Σ saldo>0), saldo a favor, # morosos, # al corriente
  (calculado en cliente desde `houses`; RLS admin por colonia).
- **Mayores adeudos** (top 8 casas con saldo>0).
- Acceso desde un botón destacado en el dashboard (sección comité).
- **Validación automatizada** que el legacy hacía a mano: comprobante duplicado por imagen
  (hash SHA-256, ver Pagos/migración `017`).
- **Cobros mensuales + recargos (migración `018`)**: `generar_cobros_mensuales(periodo)` (CARGO de
  `colonias.cuota_mensual`=**$750** por casa, idempotente por periodo) y `aplicar_recargos(periodo)`
  (CARGO `colonias.recargo`=**$100** a quien sigue debiendo tras el día 10). Botones en el panel.
  Pensados para el día 1 (cobros) / día 11 (recargos).
  - **Automatización n8n (migración `020`)**: helpers internos `_cobros_colonia`/`_recargos_colonia`
    (reutilizados por el botón is_admin y por el cron) + wrappers `cron_generar_cobros(token)` /
    `cron_aplicar_recargos(token)` (token-gated, anon key, mismo patrón que `cron_late_fees`; recorren
    todas las colonias). Workflows n8n creados **INACTIVOS** (Daniel los activa):
    `Vecinity - Cobros mensuales (día 1)` (`7m0eSC4jiCkky0CZ`, cron día 1 6am MX) y
    `Vecinity - Recargos (día 11)` (`E7tp0Tn67bx0aSGa`, día 11 6am MX). Idempotentes.
- **Convenios de pago (migración `019`)**: tabla `payment_plans` (monto semanal + deuda acordada);
  `crear_convenio`/`cerrar_convenio` (marca casa `en_convenio`) + `convenios_seguimiento()` →
  **esperado (semanas×monto) vs abonado** (abonos desde que inició) → al día / atrasado, con barra de
  progreso en el panel. Resuelve el seguimiento manual de morosos que pagan semanal.
- `npm run build` limpio. **Pendiente (finanzas avanzadas):** conciliación bancaria (CSV diario →
  match depósito↔casa), gastos (`expenses`) + gráfica por categoría, cobranza-por-casa, export Excel/CSV.

## Incidencias / multas — ✅ reporte + resolución comité (2026-06-23)
Sexta función de paridad (`incident_reports`: **131 pendientes reales** + 7 `fine_categories`).
- **Migración `014_incidencias.sql`** (aplicada) + **`014b`** (bucket `vecino-evidencias`):
  - `sugerir_multa(infractor, categoria)` → `monto_base × (multas previas + 1)`, **capado al
    `colonias.tope_multa`** (migración `015`, default $1,000, editable por el comité en `/dashboard/areas`).
    Tarifas base Villa Catania: Estac $300 · Mascotas $250 · Amenidades $400 · Ruido $500 · Fachada $1,000.
  - `reportar_incidencia(infractor, categoria, descripcion, evidencia_url)` → estado `pendiente`,
    reportante = mi casa (anónimo para el infractor).
  - `resolver_incidencia(id, accion, monto, nota)` → **solo `is_admin`**: `multar` crea CARGO
    `aprobado` (`Multa: <cat>`), liga `transaction_id`, sube saldo + recalcula estatus del infractor;
    `rechazar` cierra con nota. **Enforce del tope** al multar (no excede `tope_multa`). Idempotente (solo si `pendiente`).
- **UI `/dashboard/incidencias`** (role-aware): residente reporta eligiendo categoría + **casa
  infractora por número O por placa** (resuelve la casa desde `vehicles` — integra la búsqueda de
  placa que antes era manual) + evidencia a Storage; comité ve "Por resolver" (cuenta total) con
  **monto sugerido por reincidencia** y **las placas del infractor** + multar/rechazar. Link en dashboard.
- `npm run build` limpio. **Pendiente:** apelaciones, vista pública de multas, notificación al infractor.

## Vista vigilante — ✅ operación del guardia (2026-06-23)
Quinta función de paridad. Conecta visitas, reservas (ciclo de llave) y vehículos.
- **Migración `013_vigilancia.sql`** (aplicada): helper `is_guard()` (guardia/admin/comité) + RPCs
  SECURITY DEFINER (el rol `guardia` solo tiene `_read`):
  - Turno: `iniciar_turno()` (idempotente) / `cerrar_turno()`.
  - Visitas: `marcar_entrada_visita(id)` / `marcar_salida_visita(id)` (esperando→adentro→completada,
    sella guardia + timestamp) y `marcar_visita_por_token(token, accion)` para el flujo QR.
  - Reservas (ciclo de llave): `entregar_area(id)` (aprobada→en_uso) / `devolver_area(id)` (en_uso→completada),
    sella `guardia_entrega/devolucion` — **esto era la pieza del Django viejo que faltaba**.
  - Paquetes: `registrar_paquete(house_id, remitente, guia)` / `entregar_paquete(id)`.
- **UI `/vigilancia`**: turno, buscar placa (lectura directa `vehicles` por colonia), visitas
  (entrada/salida), reservas de hoy (entregar/devolución), paquetes (registrar/entregar).
  Guard de rol; `guardia` aterriza aquí directo desde login (dashboard redirige); comité/admin con botón.
- **QR conectado**: en `/visita/[token]`, si un guardia logueado abre el pase ve botones
  **entrada/salida** (RPC `marcar_visita_por_token`) — escanear el QR con la cámara nativa basta.
- **Servicios (migración `016`)**:
  - **Generales de villa** (Alberca/Limpieza/Basura/Jardinería): 4 botones que togglean
    entrada/salida (`general_services`; RPC `iniciar_servicio_general(tipo)` / `cerrar_servicio_general(id)`).
  - **Recurrentes domésticos** (mejora): tabla `service_providers` (registro único con foto) +
    `external_services` (+`provider_id`,`foto_url`). El proveedor se da de alta UNA vez (nombre, tipo,
    casa, foto) y el ingreso diario es **un tap** (`ingresar_proveedor`/`salir_proveedor`), con foto del
    día opcional (📷 → bucket `vecino-evidencias`). `crear_proveedor`: guardia para cualquier casa,
    residente solo para la suya. (PostgREST: recargado el schema cache tras crear la tabla.)
- `npm run build` limpio. **Pendiente:** fotos INE/placas (Storage), OCR de placas, gafetes,
  registro manual de visita en caseta, historial/analytics de entradas.

## Pagos — ✅ abono + comprobante + aprobación comité (2026-06-23)
Cuarta función de paridad (libro mayor `transactions`: cargo/abono/ajuste, 2427 tx reales).
- **Bucket Storage `vecino-comprobantes`** (público, paths `colonia/casa/uuid.ext`) + políticas
  `insert/select` para `authenticated` (creado vía `/pg/query` sobre `storage.objects`).
- **Migración `012_pagos.sql`** (aplicada): RPCs SECURITY DEFINER:
  - `registrar_abono(monto, comprobante_url, concepto, comprobante_hash)` → transacción `abono`
    `pendiente`; **doble anti-duplicado**: (1) mismo monto en 10 min, (2) **mismo comprobante por
    hash SHA-256** (migración `017`, el cliente calcula el hash del archivo) → si la imagen ya se usó
    en una transacción no rechazada, se rechaza solo (antes era manual). Valida monto>0.
  - `resolver_transaccion(id, aprobar)` → **solo `is_admin`**; al aprobar ajusta `houses.saldo`
    **incremental** (abono −monto, cargo/ajuste +monto) y recalcula `estatus` (en_convenio manda).
    Idempotente (solo si estaba `pendiente`).
- **UI `/dashboard/pagos`** (role-aware): residente ve saldo, registra abono (sube comprobante a
  Storage) y su lista de movimientos; comité ve **"Abonos por aprobar"** con ver comprobante +
  aprobar/rechazar (al aprobar baja el saldo del residente). Link en dashboard.
- `npm run build` limpio. **Nota seguridad (post-launch):** el bucket es público con paths uuid
  (la URL solo se expone vía filas RLS por colonia); endurecer a signed URLs si se requiere.

## Vehículos — ✅ alta/baja + aprobación comité (2026-06-23)
Tercera función de paridad (285 vehículos reales; catálogo migrado 52 marcas / 351 modelos).
- **Migración `011_vehiculos.sql`** (aplicada): RPCs SECURITY DEFINER:
  - `agregar_vehiculo(placa, brand_id, model_id, color)` → estado `pendiente`; valida placa
    no duplicada por colonia (`UNIQUE(colonia_id, placa)`), normaliza a mayúsculas.
  - `eliminar_vehiculo(id)` → baja propia; **no** si ya está `aprobado` (lo da de baja el comité).
- **UI `/dashboard/vehiculos`** (role-aware): residente da de alta (marca→modelo dependiente,
  placa, color) + "Registrados" con estado + quitar; comité ve **"Vehículos por aprobar"** con
  aprobar/rechazar + asignar **tarjeta RFID** (update directo vía política admin). Link en dashboard.
- Catálogo `vehicle_brands`/`vehicle_models` legible por todos (RLS `true`). `vehicles` read por colonia, write admin.
- `npm run build` limpio. **Pendiente (vista vigilante/OCR):** `vehicles.plate_ocr_confidence` + búsqueda de placa por el guardia.

## Reservas de áreas comunes — ✅ paridad + mejora (2026-06-23)
Primera función de paridad sobre el Django viejo (659 reservas reales rescatadas como flujo, no como datos).
- **Migración `008_reservas.sql`** (aplicada vía `/pg/query`):
  - `common_areas` enriquecida con config del comité: `activa, reservable, exclusiva, requiere_aforo,
    hora_apertura/cierre, duracion_min/max_horas, max_personas_casa, costo, deposito,
    aprobacion_automatica, reglas, color, icono, orden`.
  - Helper `vecino.my_house_id()` (SECURITY DEFINER).
  - **RPC `crear_reserva(area,inicio,fin,personas)`** (SECURITY DEFINER, RLS-safe): valida
    (1) gate **al-corriente** `houses.saldo > colonias.umbral_reserva` → bloquea
    (umbral configurable por villa, default 0 = al corriente estricto — migración `009`), (2) horario del área en TZ MX,
    (3) duración, (4) aforo, (5) **choque de franja solo si `exclusiva`** (compartidas no bloquean) →
    estado `aprobada` (auto) o `pendiente`. Lanza EXCEPTION con mensajes claros (P0001).
  - **RPC `disponibilidad_area(area,fecha)`** → reservas activas del día (pinta franjas ocupadas).
  - **RPC `cancelar_reserva(id)`** → cancela reserva propia futura.
  - Seed: **Alberca** (compartida, 8–20, máx 5/casa, gratis) · **Terraza** (evento exclusivo, 8–22,
    aforo 25, $3,000 + $3,000 depósito). Depuradas: Escalera (inactiva) y Estac. Visitas (no reservable, va por módulo parking).
- **UI residente `/dashboard/reservas`**: elige área → tira de 14 días → línea de tiempo del día con
  franjas ocupadas → hora/duración/aforo → confirma. Gate de adeudo visible. "Mis reservas" con cancelar.
  Mejora clave vs. el modal simple viejo: **disponibilidad real por franja**.
- **UI comité `/dashboard/areas`**: CRUD de áreas (activar/desactivar, reglas, horarios, costo,
  exclusiva, auto-aprobar) + **agregar nuevas áreas** + bandeja de aprobación de reservas pendientes.
- Enlaces en el dashboard (CTA residente + acceso comité). `npm run build` limpio (Next 16.2.9).
- **Pendiente (fase vista vigilante):** conectar ciclo guardia entrega/devolución (campos ya existen en `reservations`).

## Visitas (QR/token) — ✅ registro + pase público (2026-06-23)
Segunda función de paridad (3957 visitantes reales en el legacy). Esta fase = lado residente.
- **Migración `010_visitas.sql`** (aplicada): índice único `visitors.token_acceso`; RPCs SECURITY DEFINER:
  - `registrar_visita(nombre, fecha_programada)` → genera token (32 hex vía `gen_random_uuid`, sin extensión), inserta visita `esperando`, devuelve `{token}`.
  - `cancelar_visita(id)` → borra visita propia aún `esperando`.
  - `get_visita_publica(token)` → **granted a `anon`**: datos seguros del pase (nombre, casa, colonia, logo, estado, fecha) para la página pública sin login.
- **UI residente `/dashboard/visitas`**: registrar visita → modal con **QR** (`qrcode` npm) + **compartir por WhatsApp** (`wa.me`) + lista "Mis visitas" (cancelar). Link desde acción "Registrar visita" del dashboard.
- **Página pública `/visita/[token]`** (ruta dinámica, sin auth): pase con logo de colonia, datos del visitante y QR; "Pase no válido" si el token no existe. Usa la RPC anon.
- `npm run build` limpio (Next 16.2.9). Nueva dep: `qrcode` + `@types/qrcode`.
- **Pendiente (fase vista vigilante):** captura de fotos INE/placas (requiere Storage buckets),
  marcado de entrada/salida por el guardia, registro manual en caseta, historial/analytics, OCR de placas (`visitors.plate_detected`).

## Deploy — preparado (2026-06-22)
`vecinity-app/` es repo git (commit inicial). `next.config.ts` con `output:'standalone'`,
`Dockerfile` multi-stage (deps→build→runner, node:22-alpine, puerto 3000), `.dockerignore`.
**Build de producción verificado ✓** (`npm run build` limpio). Guía completa: `vecinity-app/DEPLOY.md`.
Pendiente que ejecuta el Director: push a GitHub + crear app en EasyPanel (Build Args + Env, dominio
`vecinity.nexiasoluciones.com.mx`). Secretos solo en `.env.local` (gitignored): SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN.

## Pendientes (siguiente fase, post-deploy)
- [ ] Vista del vigilante + OCR de placas con **modelo de visión (Claude)** — NO Tesseract (probado: falla en placas reales). Limpiar 36/285 placas placeholder.
- [ ] Caty + reglamento (RAG): ingestar `Reglamento_Consolidado_Villa_Catania_2026.docx` (~48k chars) + Q&A en el bot.
- [ ] Índice de salud comunitaria (Presión vs. Resiliencia)
- [ ] Auth/billing `nexia_billing` (app_slug `vecino`) cuando se defina modelo de cobro a colonias
- [ ] **Índice de salud comunitaria** (Verde/Amarillo/Rojo) — POST-deploy, cuando haya tendencia
- [ ] Bot Telegram de Vecinity + captura de `telegram_chat_id` (n8n)
- [ ] Auth estándar Nexia (middleware/proxy + check-access + nexia_billing app_slug `vecino`)
- [ ] Dashboard post-login (residente / comité / vigilante / admin)
- [ ] Migración de datos reales SQLite (Villa Catania) → `vecino`
- [ ] Automatizaciones n8n: SOS→Telegram, saldo bajo, multa día >10, OCR placas
- [ ] Storage buckets (comprobantes, INE, placas, evidencias, market)
- [ ] Suspensión RFID gobernada (umbral + aprobación comité/votación)
- [ ] Deploy EasyPanel
