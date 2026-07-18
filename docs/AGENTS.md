# AGENTS.md — Vecinity

> Plataforma de comunidad segura: administración de fraccionamiento + vigilancia vecinal.
> Migración del monolito Django (PythonAnywhere, SQLite) → arquitectura Nexia.
> Última actualización: 2026-07-17
>
> 🔎 **RETOMAR AQUÍ:** ver `REVISION_PENDIENTE.md` — paridad para lanzamiento (deploy ≠ cutover).
> El review E2E del 2026-06-27 (abajo) verificó BD + 13 rutas contra producción: **~82% al lanzamiento**.

## Pago de tarjeta desacoplado del estado de la tarjeta — migr. 087 (2026-07-17) ✅ ⚠ deploy

Reporte de campo (Director): "varios vecinos subieron el comprobante de su tarjeta y sigue
en revisión". **Causa raíz:** el pago (migr. 061) se validaba SOLO en la lista del comité
`estado='solicitada'`. En la campaña muchas tarjetas se imprimieron/entregaron ANTES de
validar el pago → al salir de `solicitada` el comprobante `en_revision` quedaba huérfano
(el comité no tenía dónde aprobarlo) y el vecino con tarjeta ya impresa tampoco podía subir
comprobante (la RPC exigía `estado='solicitada'`).

**Fix (3 partes):**
- **BD `subir_comprobante_tarjeta` (087):** acepta comprobante mientras `pago_estado IN
  (pendiente,rechazado)` y `estado NOT IN (cancelada,rechazada)` — cualquier punto vivo del
  ciclo. `validar_pago_tarjeta` ya operaba con cualquier estado → sin cambio.
- **UI comité `credenciales/page.tsx`:** nueva sección **"Comprobantes por validar"** que
  lista TODO `pago_estado='en_revision'` (query por `pago_estado`, no por `estado`), con
  "Pago recibido ✓ / Rechazar". Se quitó el botón de validar inline de "Solicitudes por
  aprobar" (vivía solo ahí) para no duplicar; ese botón ahora dice "Valida el comprobante
  primero ↑" cuando el pago sigue en revisión.
- **UI vecino:** el botón "Subir comprobante" aparece con `pago_estado` pendiente/rechazado
  aunque la tarjeta ya esté impresa/entregada.

**Conciliación de campaña (2026-07-17, backfill vía /pg/query):** crucé los 20 comprobantes
atorados (impresa/entregada) contra `bank_movs` (el concepto del banco trae casa/placa).
**16 aprobadas** (13 con match exacto casa/placa + 3 de casa 150 por depósito $450 "3 accesos"
confirmado por el Director), `pago_motivo_rechazo` usado como nota de auditoría. Quedan
`en_revision` sin match claro: casa 105 (176732), 132 (JJC518A, además duplicada de una
cancelada) y 148 (GGM282-E + Selenne visita) → esperan comprobante/aclaración. Casas 238 (3)
y 107 (2) llegaron como `solicitada` — 238 confirmada en banco, 107 sin match aún.

**Hueco pendiente (2º del mismo diseño):** el pago de tarjeta NO toca `bank_movs` (a diferencia
del mantenimiento) → esos depósitos de $150/$300/$450 quedan como "ingresos sin conciliar" en
Pagos y estorban al comité. Falta que aprobar el pago concilie/descarte también la fila del
banco. Requiere Vibe Check.

## Comprobante robusto + borrar rostro por casa + enroll fallido amigable — migr. 084-086 (2026-07-17) ✅

Tres mejoras pedidas por el Director. ⚠ Requiere deploy (cambios de cliente).

- **084 — comprobante (`registrar_abono`):** al re-subir la MISMA imagen, el mensaje ahora
  dice *"…y está en proceso de liberación (el comité lo revisará)"* (o *"ya fue aprobado"* según
  el estado real), en vez de solo fecha+casa. Cliente `pagos/page.tsx`: botón **deshabilitado sin
  monto válido** + **reset del `<input type=file>` nativo** vía `ref` (setFile(null) no lo limpia
  solo → antes la imagen "se quedaba" tras enviar).
- **085 — borrar rostro por casa (`face_retire`):** el vecino ahora puede borrar CUALQUIER rostro
  **de su casa** en cualquier estado (antes solo `recibida`/`rechazada`). La baja física la sigue
  ejecutando el poller de la Orin (plan `remove`, registro `retirada` + `terminal_removed_at NULL`).
  UI `_components/AccesoPeatonal.tsx`: botón **"Borrar"** en todos los estados, `window.confirm` si
  está `enrolada`, aviso *"se quitará de la puerta en unos minutos"* si `pendiente_borrado`.
- **086 — enroll fallido amigable (`face_mark` acción `'error'`):** cuando la terminal no reconoce
  el rostro (Hikvision FDLib **statusCode 6** = calidad/rostro no detectado), la Orin debe llamar
  `face_mark(<token>, <id>, 'error')` → el registro vuelve a **`rechazada`** con motivo amigable
  (la app ya lo muestra con *"toma otra foto y vuelve a enviarla"*) y **Caty avisa por Telegram**
  al vecino con chat ligado (*"mejora la iluminación, foto de frente…"*).
  🔧 **PENDIENTE EN LA ORIN (fuera de este repo):** mapear el statusCode 6 (y códigos de calidad
  afines) → `face_mark(...,'error',...)` en vez de solo tirar el error crudo al Telegram del comité.

## Edición del vigilante = proveedores recurrentes — migr. 083 (2026-07-16) ✅

Corrección de alcance: el vigilante edita/da de baja **proveedores recurrentes**
(`editar_proveedor`/`baja_proveedor`, is_guard, baja lógica que conserva historial), NO las
tarjetas VF — ese módulo quedó solo consulta (REVOKE de vf_editar/vf_revocar a authenticated).
Dato corregido en prod: proveedora casa 256 (capitalización). ⚠ Requiere deploy.

## Entrega por casa + buscador — migr. 082 (2026-07-16) ✅

`entregar_tarjetas_firmadas(uuid[],...)`: todas las tarjetas de la casa en UN acto (una
firma + un INE, atómico; registro y serial por tarjeta, liga RFID por vehicular). UI:
buscador por casa/nombre/placa; lista agrupada por casa; modal con checkbox y serial por
tarjeta. QA rollback con 2 tarjetas de la misma casa. La RPC individual (080) queda vigente.
⚠ Mismo deploy pendiente.

## Backfill RFID desde tags de campaña — migr. 081 (2026-07-16) ✅

La campaña sí capturó tag↔vehículo en `rfid_tags` (115/120 con vehicle_id, 0 ambiguos) —
solo faltaba copiarlo: backfill a `vehicles.tarjeta_rfid` (92 ligados) → **115/115
vehiculares por entregar con serial conocido**. El modal de entrega pre-llena el número
(sistema fijo > tag de campaña editable > manual). GOTCHA SQL: un SELECT en el mismo
statement del UPDATE (CTE) no ve sus efectos — verificar con query aparte.
⚠️ PENDIENTE (decisión de acceso): al entregar tarjeta NUEVA de un vehículo, el tag viejo
sigue ACTIVO en el panel físico — la Orin solo reconcilia por mora, no procesa 'vencido'.
Extender rfid_reconcile_plan con acción por reemplazo requiere Vibe Check (toca la pluma).

## Entrega liga RFID + paneles abatibles — migr. 080 (2026-07-16) ✅

Las ~92 vehiculares históricas están impresas pero SIN serial registrado (solo las 23
impresas hoy por el sistema quedaron ligadas). En la ENTREGA (tarjeta en mano) el comité
captura el N° impreso → `vehicles.tarjeta_rfid` + upsert `rfid_tags` (mismo efecto que la
impresión nueva); si el sistema ya asignó serial (card_inventory) se muestra fijo.
`card_deliveries.serial` guarda el número entregado. UI: paneles abatibles "Acceso RFID
(caseta)" y "Impresas, por entregar (123)". GOTCHA de nuevo: DROP de la firma de 4 params
antes de crear la de 5.

## Reset de entregas fantasma — migr. 079 (2026-07-16) ✅

Las 96 tarjetas 'entregada' de la campaña vieja NUNCA se entregaron (card_deliveries
vacía) pero SÍ están impresas físicamente. `print_encolar_reimpresion` v2 resetea la
solicitud al flujo real (en_cola → impresa → entregada solo con firma); las 96 se
re-encolaron y se marcaron `impresa` directo (jobs retroactivos SIN gastar stock ni
seriales — las tarjetas físicas ya existen). Estado real en prod: **123 impresas por
entregar** (96 históricas + 27 nuevas) + 15 en trámite; **0 entregadas** hasta que haya
firma + INE. Nota: delivered_at histórico (falso) se limpió. Stock intacto: 69.

## Entrega con foto del INE — migr. 078 (2026-07-16) ✅

El modal de entrega (tablet del comité) pide **foto del INE** de quien recibe + firma.
INE = identificación oficial → bucket **PRIVADO** `vecino-ine` (policies insert/select solo
authenticated), la entrega guarda la RUTA (`card_deliveries.ine_path`, signed URLs para
consultarla); sin foto subida NO se registra la entrega. GOTCHA aplicado: param nuevo con
DEFAULT en `entregar_tarjeta_firmada` → DROP de la firma vieja antes de recrear.
⚠ Mismo deploy pendiente.

## Módulo visitas recurrentes en vigilancia — migr. 077 (2026-07-16) ✅

Sección abatible "💳 Visitas recurrentes" en `/vigilancia`: tarjetas VF de la colonia con
nombre, casa, estado y ● adentro; el vigilante puede **editar** el nombre y **borrar**
(revocar — la tarjeta deja de validar y su impresión pendiente se cancela). RPCs
`vf_listar/vf_editar/vf_revocar` (is_guard) porque el RLS de `card_requests` solo deja
leer a casa propia/comité. QA con ROLLBACK. ⚠ Mismo deploy pendiente.

## Entrada de visita frecuente con historial — migr. 076 (2026-07-16) ✅

El guardia escanea la tarjeta `/vf/<id>` y "✓ Registrar entrada" crea la visita en
`vecino.visitors` (columna nueva `card_request_id` la liga a la tarjeta) con los datos del
titular — mismo historial y salida que cualquier visita. Doble escaneo = "ya adentro" →
el botón cambia a "Marcar salida". RPC `entrada_visita_frecuente` (is_guard). QA con
ROLLBACK simulando guardia real. ⚠ Mismo deploy pendiente.

## QR de tarjetas resuelve — migr. 075 + rutas públicas (2026-07-16) ✅

Las rutas `/vf/<card_id>` y `/r/<profile_id>` que codifica el QR de las tarjetas PVC ya
existen (cerraba la Ola 3 del bridge). Privacidad en capas: **sin sesión** → solo
VIGENTE/NO VÁLIDA + colonia vía `verificar_tarjeta_publico` (anon, CERO PII); **guardia/
comité** → check completo (RPCs 052-053, que el escáner de `/vigilancia` ya reconocía).
El bridge ahora codifica `https://vecinity.nexiasoluciones.com.mx` (antes vecinovigilante);
la única visita impresa con URL vieja quedó re-encolada. ⚠ Requiere el deploy pendiente.

## Tarjetas: seriales RFID + entrega firmada + frentes por tipo — migr. 072-074 (2026-07-16) ✅

- **072** `print_encolar_reimpresion`: reimprimir una tarjeta histórica (entregada sin job)
  la re-encola con payload de `_payload_tarjeta`; guard anti-duplicado.
- **073** `colonias.tarjeta_frente_visita_url`: frente por tipo (visita = diseño azul).
  Diseños de Villa Catania en bucket público `vecino-tarjetas`.
- **074** `card_inventory`: el paquete físico de tarjetas numeradas se registra EN ORDEN
  (desde→hasta, asc o desc); al imprimir, `print_mark_job` asigna el serial de arriba y lo
  liga a la solicitud, a `vehicles.tarjeta_rfid` y a `rfid_tags` (vehicular). `card_deliveries`:
  "entregada" ahora exige **firma del vecino** (canvas en el teléfono del comité, RPC
  `entregar_tarjeta_firmada`, fecha sellada por el servidor). UI: botón "Entregar con firma ✍︎"
  en `/dashboard/credenciales`. Lote real Catania 14840505→14840409 (97) registrado.
  ⚠ **Deploy EasyPanel pendiente** para que el comité vea el flujo de firma.

## Consola de operador de tarjetas — migración 071 (2026-07-15) ✅

Las villas mandan sus tarjetas (comité aprueba → `vecino.print_jobs`) y **Nexia imprime
centralizado** desde la consola del bridge (`nexia-print-bridge` → `localhost:7777/cola.html`),
sin IA. La migración `071_print_operador.sql` agrega RPCs SOLO service_role para el bridge:
- `print_take_selected(uuid[])` — tomar jobs seleccionados por el operador (acepta
  `pendiente` y `error` — reintento directo sin pasar por `print_retry_job` del comité).
- `print_reprint(uuid)` — registrar reimpresión de un job ya impreso (descuenta stock,
  re-sella `printed_at`).
- `print_set_stock(uuid,int)` — actualizar el stock físico de tarjetas de una colonia.
El flujo del comité en `/dashboard/credenciales` NO cambia. Tarjeta BLANCA (vehicular
`personalizada=false`) se marca lista sin pasar por la impresora.
⚠️ Pendiente para impresión real: ninguna colonia tiene `tarjeta_frente_url` — subir el
diseño de frente de cada villa.

## 🔮 Módulo futuro — Presencia sin cámaras por WiFi CSI (ESPectre) (2026-07-15) 📋 PLAN APROBADO, SIN EJECUTAR

Plan de piloto aprobado por Juan; **bloqueado por hardware** (comprar 2× ESP32-C6 con antena
externa IPEX, ~$150–300 MXN c/u). Nada construido aún — esta entrada es el punto de retome.

**Qué es**: detección de presencia/movimiento en áreas comunes SIN cámaras ni PIR, leyendo las
perturbaciones de la señal WiFi (CSI) con un ESP32. Caso de uso del piloto: **movimiento en el
salón de eventos sin reserva activa → alerta Telegram a vigilantes** (cruza con
`calendario_reservas` + `tg_send`/pg_net + anti-spam en BD, todo ya existente).

**Repos evaluados** (2026-07-15): `francescopace/espectre` (elegido — componente ESPHome maduro
8.8k⭐, autocalibración, GPL v3), `espressif/esp-csi` (SDK oficial Apache-2.0 — ruta si algún día
se productiza firmware propio), `ruvnet/ruview` (descartado: claims infladas — pose/vitales por
WiFi no reproducible en ESP32; el propio repo admite pose ~2.5% PCK).

**Decisión de arquitectura**: SIN Home Assistant y SIN broker MQTT — ESPHome hace POST HTTP
directo (`on_state` → `http_request`) a una RPC token-gated de Supabase, mismo patrón que Caty /
print-bridge / access-bridge. Cero infra nueva en el VPS.

**Plan por fases**:
1. **F0 (Juan)**: comprar ESP32-C6 ×2; verificar cobertura WiFi 2.4GHz en el salón (el sensor debe
   quedar a 3–8 m del AP; sin cobertura → cambiar de zona o agregar AP).
2. **F1 — gate**: flashear ESPectre vía ESPHome en la Mac y validar en banco ~1 semana (falsos
   positivos/hora en cuarto vacío, detección al entrar). Si no es estable, el piloto muere aquí.
3. **F2 — BD**: `vecino.presence_sensors` (catálogo + token + heartbeat, patrón `worker_health`) y
   `vecino.presence_events` (append-only); RPC `sensor_report(token, estado)` SECURITY DEFINER;
   RLS solo comité/vigilantes; debounce/anti-spam EN LA BD, no en firmware.
4. **F3 — negocio**: movimiento en salón + sin reserva en ventana ±30 min → `tg_send` a vigilantes
   (sin parse_mode) con anti-spam por transición. **Fail open**: sensor caído o RPC con error
   NUNCA alarma — solo badge "sensor sin señal" para el comité.
5. **F4 — sitio**: instalar en el salón, informar al comité (sensor anónimo de movimiento, no
   identifica personas), observar 2–4 semanas → go/no-go para más zonas (caseta, áreas comunes).

**Criterio de éxito**: detección de entrada real <30 s, <2 falsos positivos/semana, alerta solo
sin reserva activa. **Limitaciones conocidas de ESPectre**: precisión muy dependiente del entorno,
no distingue persona/mascota, rango óptimo 3–8 m, concreto armado degrada señal, requiere ~10 s
inmóvil al boot para autocalibrar.

## Acceso peatonal por rostro — terminal DS-K1T342 (2026-07-14) ✅ EN PRODUCCIÓN

**E2E físico validado el mismo día**: foto desde la app → aprobación del comité → la Orin enrola
(Telegram "🙂 ENROLADO") → **la terminal reconoce el rostro y abre la puerta**. 3 rostros reales
enrolados (casa del QA). Deploy EasyPanel auto desde push a main verificado en prod (buscar el
string del feature en los chunks JS de `/_next/static/` — ojo: `vecinovigilante.` es la app VIEJA
de Vite; la Next.js vive en `vecinity.`). Usuario "prueba" del instalador borrado de la terminal.
En credenciales, "Tarjeta peatonal · Próximamente" pasó a "🚶 Acceso peatonal · incluido, sin
tarjeta" con la sección de registro embebida (las tarjetas RFID no son compatibles con la terminal).

Se instaló la "Puerta Peatonal": terminal facial Hikvision **DS-K1T342EFWX-E1** en `192.168.1.89`
(red de la caseta), **standalone** con su propia BD de usuarios/rostros e **ISAPI REST completo**
(firmware V4.39.180 — a diferencia del DS-K2812 no necesita SDK). Las tarjetas RFID del mazo NO son
compatibles con esta terminal → el acceso peatonal es 100% por reconocimiento de rostro.

- **Flujo**: vecino toma foto de su cara (fondo blanco) en la app → comité aprueba → la Orin la
  enrola en la terminal por ISAPI. N rostros por casa (cap 10).
- **REGLA DE NEGOCIO (Director, 2026-07-14): la peatonal NUNCA se suspende** — ni por mora ni por
  override; el acceso a pie a la vivienda no se restringe. La mora solo gobierna el acceso
  vehicular. Un rostro solo sale por retiro administrativo (`face_retire`). **Migr. 066** redefine
  `face_sync_plan` (solo enroll+remove) y `face_mark` (rechaza suspend/reactivate); el poller de la
  Orin ya no trae ramas de suspensión facial. QA con ROLLBACK: casa con mora extrema + override
  forzado → el plan no emite acción para su rostro ✅ · `face_mark('suspend')` → "accion invalida" ✅.
- **Migr. 065** — `vecino.face_enrollments` (enroll_no IDENTITY desde 1001 = employeeNo en la
  terminal; **la foto vive en la BD** como `photo_b64` JPEG ~100 KB: biometría NO va a bucket público
  y la Orin la baja con su token de bot, sin service key). RPCs: `face_submit`, `face_retire`,
  `face_review`, `face_photo`, `face_panel_data` (auth) + `face_sync_plan`/`face_mark` (token
  `bot_config`, patrón rfid). Aplicada en prod + `NOTIFY pgrst`.
- **UI vecino** `_components/AccesoPeatonal.tsx` (se muestra en **mi-cuenta Y credenciales**; en
  credenciales el bloque "Tarjeta peatonal · Próximamente" pasó a "🚶 Acceso peatonal · incluido,
  sin tarjeta" apuntando a la sección): captura con cámara (`capture="user"`), compresión canvas
  800px/0.85, borrador en localStorage (anti-kill de la PWA al abrir cámara), estados y motivo de
  rechazo visibles, quitar mientras no esté activa.
- **UI comité** `comite/AccesoPeatonal.tsx`: bandeja "Por revisar" con foto (vía `face_photo`),
  aprobar/rechazar con motivo, lista de rostros registrados con retiro (borra de la terminal en el
  siguiente ciclo).
- **Bridge Orin** (`~/access-bridge/app/`): nuevo `terminal.py` (cliente ISAPI digest: UserInfo
  Record/Modify/Delete, FDLib FaceDataRecord multipart, vigencias canónicas 2020→2036 / 2000 para
  suspensión) + `face_cycle()` en el poller (mismo patrón plan→hardware→mark→notify; notifica por
  `rfid_notify` con encabezado 🚶). `/health` ahora incluye `terminal` sin cambiar las llaves
  históricas. **Desplegado y activo** (restart vía `pkill uvicorn`, systemd lo relanza).
- **QA**: ciclo usuario crear/suspender/reactivar/borrar verificado contra la terminal real ✅ ·
  flujo BD completo (submit→approve→plan con foto→enrolada→suspend→remove) con BEGIN/ROLLBACK ✅ ·
  `npm run build` ✅.
- **Pendiente**: password admin de la terminal es el mismo Weak del controlador (endurecer junto
  con el housekeeping) · cámara nueva detectada en `192.168.1.87` (RTSP), posible integración futura.

## Baja de vehículos por el comité (2026-07-13) ✅

El comité no podía remover vehículos de otras casas: `eliminar_vehiculo` (migr. 011) solo permite al
dueño borrar los NO aprobados y su mensaje decía "pide al comité darlo de baja"… camino que no existía.

- **Migr. 064** — RPC `vecino.baja_vehiculo_comite(p_id)`: guard `is_admin()`, DELETE definitivo de
  cualquier vehículo (cualquier casa/estado). Defensivo: si hubiera `rfid_tags` activos ligados al
  vehículo (hoy 0 en prod; FK es ON DELETE SET NULL) devuelve `aviso_rfid` para revisar el panel de
  acceso. Aplicada en prod + `NOTIFY pgrst`.
- **UI** `/dashboard/vehiculos` — sección solo-comité "Vehículos por casa": busca por número de casa
  (exacto, join `houses!inner`) o placa (ilike), dedup, botón "Dar de baja" con `window.confirm` →
  RPC → muestra placa/casa dado de baja y el aviso RFID si aplica.
- **QA en prod con BEGIN/ROLLBACK** (identidad simulada vía `request.jwt.claims`): vecino normal
  rechazado ✅ · vehículo intacto tras rechazo ✅ · admin borra aprobado de otra casa ✅ · id
  inexistente da error legible ✅. `npm run build` ✅.
- Nota RLS: la búsqueda funciona porque `vehicles_read` permite SELECT a toda la colonia (migr. 002);
  la baja queda protegida en el RPC, no en el cliente.

## Recuperación de contraseña — email + Caty (2026-07-06)

Antes NO existía forma de recuperar contraseña (auth solo `signInWithPassword`, onboarding por código).
Se agregó reset self-service por **dos canales**:

- **Email**: `/recuperar` (pide correo, mensaje genérico anti-enumeración) → `resetPasswordForEmail`
  (GoTrue+Zoho) → `/reset-password` (flujo implícito, tokens en el hash) → `updateUser`.
- **Caty (Telegram)**: botón `🔐 Cambiar mi contraseña` → RPC `bot_email` (migr. **050**) da el correo del
  vecino ligado → n8n llama `admin/generate_link` (service key) → manda link
  `/reset-password?token_hash=…` → la página hace `verifyOtp({token_hash,type:recovery})`.
  Este canal **no depende del SITE_URL** (usa el token_hash directo), ya funciona.
- `/reset-password` maneja **ambos** casos; browser client con `flowType:'implicit'`; link en `/login`
  + banner `?reset=1`.

⚠️ **BLOCKER de infra para el canal email** (deuda "Configurar SITE_URL" de NEXIA-OS): el `SITE_URL` de
GoTrue = dominio de Supabase y `vecinity.nexiasoluciones.com.mx` NO está en el allow-list de redirects
→ el enlace del correo aterriza en el dominio de Supabase, no en la app. **Pendiente:** agregar los
dominios de las apps a `ADDITIONAL_REDIRECT_URLS` (→ `GOTRUE_URI_ALLOW_LIST`) en EasyPanel + redeploy del
servicio Supabase. Verificar con `admin/generate_link` que `redirect_to` ya NO se sobrescribe.
`tsc --noEmit` ✅ · `node --check` Caty ✅ · `bot_email` probado ✅. Falta: allow-list + `push_caty.sh` + deploy.

## Reservas + conciliación bancaria de julio (2026-07-06) — parcial ⏳

**Reservas ✅**
- **Bug corregido**: `entregar_area` no validaba fecha → un guardia cerró reservas FUTURAS por error
  (210 del 5-jul, 109 del 9 y 10-jul). Guard de fecha en la RPC + `vigilancia/page.tsx` acotado a solo hoy
  (`[hoy, mañana)`). Reservas corruptas restauradas a `aprobada` (patrón: `fecha_hora_inicio > now()` y
  estado `en_uso/completada` = imposible → limpiar). **Migración 049**.
- **Calendario general de reservas** (nuevo): `/dashboard/reservas/calendario` visible a todos los
  residentes ("lo que está ocupado"). RPC `calendario_reservas(desde,hasta)` aislada por colonia. Botón
  en el dashboard. **Migración 049**.

**Conciliación bancaria julio ⏳ NO TERMINADA**
- Archivo `~/Downloads/Julio_2026.xlsx` (todo julio). **GOTCHA**: es un re-export → el saldo corrido
  cambió → `banco_hash` nuevos → el dedup por hash NO detecta lo ya registrado. Reconciliación correcta
  por casa + clave de rastreo (no por hash). Script espejo: `scripts/conciliar_julio_2026.mjs`.
- **Cargos**: los 10 ya estaban importados ($30,361). Nada que hacer.
- **Abonos**: 41 en el banco → 22 ya registrados, **3 faltantes agregadas** (casas 198/$1500, 107, 180).
- **Bug corregido**: SheetJS lee "Día" como mojibake "DÃ­a" → se perdía la fecha de los movimientos en
  `conciliacion/page.tsx`. Fix: variantes mojibake + fallback col 0.
- **Feature**: badge "✓ ya conciliado en banco · revisa duplicado" en `dashboard/pagos` (Abonos por
  aprobar) cuando la casa+monto+mes ya tiene abono con `banco_hash` (hoy marca casa 144).
- **PENDIENTE (falta que Juan defina):**
  - Confirmar 3 candidatas media-confianza: casas **133** (Keila 133), **230**, **116** ($750 c/u).
  - Asignar casa a 5 movimientos sin número: depósito efectivo **$1,500**, 2 depósitos efectivo $750
    (folios PRACTIC), 2 transferencias $750 sin número ("mantenimiento").
  - Revisar casa **176** (concepto dice "Junio", no julio) y casa **144** (posible duplicado marcado).

## Comité registra el pago de un vecino (comprobante por WhatsApp) (2026-07-02) ✅

Necesidad (Juan): vecinos —sobre todo mayores— que no pueden subir su comprobante se lo mandan al comité
por WhatsApp; antes Juan **entraba a la cuenta del vecino** para subirlo (mala práctica). Ahora hay una
función de comité:
- **Migración 038 · `registrar_abono_admin(house, monto, concepto, url, hash, ocr, ref, fecha)`** — como
  `registrar_abono` pero recibe `p_house_id`, exige `is_admin()`, valida que la casa sea de su colonia, lo
  deja **aprobado** directo (aplica saldo con `resolver_transaccion`) y opcionalmente fecha el pago
  (`p_fecha`). **Doble candado anti-duplicado**: por hash del archivo y por clave de rastreo (`ref_rastreo`,
  ≥6 díg, no rechazado) → no se registra dos veces el mismo pago aunque re-fotografíen el recibo.
- **UI en `dashboard/estado-cuenta`**: botón "＋ Registrar pago del vecino" cuando hay una casa cargada →
  sube el comprobante al bucket `vecino-comprobantes` (la política INSERT ya permite a cualquier
  autenticado, no hizo falta tocar Storage), corre OCR (`leerComprobante`, reusado del flujo del vecino)
  para llenar la clave de rastreo, y llama `registrar_abono_admin`. Monto default 750, fecha y concepto
  opcionales. Verificado E2E (rollback): aplica −750, 2º intento misma clave → `dup_ref`.
- **Dato aplicado:** se registró el pago de **abril de la casa 165** ($750, folio 0046176552, comprobante
  BBVA que mandó la vecina) → casa 165 pasó de −$750 (con adeudo) a **$0, al corriente**. Imagen subida a
  Storage, abono fechado 2026-04-01.

## Auto-conciliar: respaldo por monto+fecha con aprobación del comité (2026-07-02) ✅

Antes, la conciliación cruzaba el comprobante del vecino contra el banco **solo por clave de
rastreo SPEI** (`conciliar_auto`, 028). Si el OCR no leía la clave o el banco no la traía en el
concepto, el comprobante se ignoraba aunque monto y fecha cuadraran. **Nuevo respaldo (migración 036):**
- **`sugerir_abono(monto, fecha, banco_hash, dias=3)`** — READ-ONLY. Para una fila del banco sin match
  por rastreo, busca abonos `pendiente` **con `comprobante_url`** de la colonia con **monto exacto** y
  fecha (OCR `comprobante_ocr->>'fecha'`, o `created_at` en hora MX como fallback) dentro de **±3 días**
  (ventana confirmada por Juan). Devuelve candidatos {abono_id, casa, comprobante_url, fecha_ocr} + dedup
  por `banco_hash`. **No muta nada.**
- **`conciliar_confirmar(abono_id, banco_hash, fecha)`** — liga la fila del banco a ESE abono del vecino
  y lo aprueba (reusa `resolver_transaccion`, `FOR UPDATE`, dedup por `banco_hash`). Igual que el match
  único de 028 pero disparado por el clic del comité, no automático.
- **UI** (`dashboard/conciliacion/page.tsx`): `autoConciliar()` gana un **PASO 3** — lo que no casa por
  rastreo ni por concepto pasa a estado **`propuesta`** (fila ámbar) con **miniatura del comprobante** del
  vecino + casa sugerida + **[Aprobar]/[Descartar]**; si hay varios candidatos (mismo monto+día) muestra
  un `<select>` para elegir la casa. **Nada por monto+fecha se aplica sin el clic del comité.** Las filas
  `propuesta` quedan fuera de "Conciliar seleccionados" (no se duplican). Resumen ahora reporta
  "propuestas por monto+fecha: N".

Flujo recomendado al comité: **Auto-conciliar primero** (limpia rastreo + propone monto+fecha) → aprobar
propuestas → luego "Conciliar seleccionados" para lo que quedó a mano. Evita crear abonos duplicados sobre
comprobantes que el vecino ya subió. Build + tsc + eslint en verde.

### Candado anti-duplicado en `conciliar_abono` (migración 037) + corrección de datos ✅

En la primera tanda de conciliación real, "Conciliar seleccionados" creó **abonos duplicados** en 3 casas
(**252, 161, 105**): el vecino ya había subido su comprobante y el comité además concilió la fila del banco,
que insertaba un abono NUEVO sin revisar. Corregido en dos frentes:
- **Datos (ya aplicado en prod):** se rechazó el stub del banco de las 3 casas y se conservó el comprobante
  del vecino (con foto+rastreo); en la 105 el comprobante estaba `pendiente` → se aprobó. Las 3 quedaron en
  **saldo $0, al corriente**. Barrido de la colonia: solo esos 3 casos; saldos a favor de 103/234 son
  crédito previo legítimo, no de la conciliación. El `banco_hash` se dejó en el stub rechazado (el dedup
  por existencia sigue protegiendo contra re-importar esa fila del banco).
- **Código (migración 037):** `conciliar_abono` ahora, ANTES de insertar, busca un comprobante del vecino
  ya existente (misma casa · mismo monto · ±3 días · con `comprobante_url` · sin `banco_hash`) y lo **ENLAZA**
  (aprueba si estaba pendiente, aplica saldo UNA vez; solo estampa `banco_hash` si ya estaba aprobado). Solo
  crea un abono nuevo si el vecino NO subió comprobante (el banco es la única evidencia). Nuevo param opcional
  `p_fecha` (fecha de la fila del banco) para acotar el match; ambos llamadores del UI lo pasan. Verificado
  E2E con test en transacción+ROLLBACK simulando al comité: `linked:true`, 1 fila (no duplica), comprobante
  aprobado + `banco_hash` estampado.

## Recibo foliado de abonos (paridad Django) + backfill resoluciones (2026-07-02) ✅

**Recibo de abonos:** el Django viejo generaba, al aprobar un abono, un **recibo PDF foliado**
(folio consecutivo por colonia) descargable desde el estado de cuenta; a los vecinos les gusta bajarlos.
El schema nuevo ya tenía `transactions.recibo_pdf_url` + `folio_counters` pero la generación nunca se portó.
Restaurado:
- **Migración 035**: `transactions.folio` (UNIQUE parcial por colonia), RPC `siguiente_folio` (upsert
  atómico sobre `folio_counters`; Villa Catania seguía en **2381** → continúa desde 2382), RPC
  `set_recibo_transaccion`, bucket Storage `vecino-recibos` (público, path `colonia/casa/recibo_N.pdf`).
- **PDF con `pdf-lib`** (`src/lib/recibo-pdf.ts`, coordenadas — robusto en Next standalone/Docker, sin
  gotcha de fuentes AFM de pdfkit) reproduciendo el recibo azul de Villa Catania: folio en rojo, tabla
  DIA/MES/AÑO, datos bancarios (Bancomer/Clabe), concepto, **cantidad + cantidad con letra** (conversor
  español propio, sin dep). E2E probado: folio 2382, subido a Storage, URL pública 200 application/pdf.
- **Server Action** `generarReciboAbono` (`dashboard/recibo-actions.ts`): autz dueño-o-comité, idempotente
  (no regenera si ya existe), asigna folio → arma PDF → sube → guarda `recibo_pdf_url`. Se dispara al
  aprobar el abono (best-effort) y **lazy** al primer "Descargar recibo" (para los ~1,100 abonos históricos
  no se pre-generan PDFs — se crean bajo demanda). Botón en `mi-cuenta` (residente) y `estado-cuenta` (comité).

**Backfill de resoluciones (multas viejas):** `scripts/backfill_resoluciones.mjs` (idempotente,
concurrencia 4). **Completado: 50/50** (se generaron 42, luego se agotó el saldo Anthropic; tras recargar
créditos en la organización correcta de console.anthropic.com se corrieron las 8 restantes). Nota operativa:
los créditos de API son **por organización** y NO se recargan en claude.ai (es otra plataforma).

**Reconciliación multas↔cargos:** `scripts/reconciliar_multas.mjs` ligó 44 multas viejas a su cargo real
(empate 1:1 casa+monto+categoría+fecha). 3 sin cargo se revisaron a mano: 128 era prueba (rechazada, no
cobrada), 167 y 250 reales (cargo creado). La 167 luego se **condonó** (acuerdo con el residente): saldo en
ceros, multa conservada como antecedente. La invariante `saldo = Σcargos − Σabonos` se mantiene (116/116).

**Mejora futura — cruce reserva↔multa:** las reservas de amenidades quedan en `vecino.reservations`
(área, casa, fecha/hora, estado). Al validar una multa de amenidad, el comité podría ver automáticamente
"¿esta casa tenía reserva ese día? Sí/No" como contexto anti-disputa. Hoy tiene poco valor (solo ~4 reservas
totales; el sistema empezó a usarse jun-2026), pero será útil cuando el uso crezca.

## Resolución oficial de multas + anonimato del reportante (2026-07-02) ✅

**Qué pidió Juan:** que el infractor pueda abrir la **resolución oficial** de su multa
(foto + artículo del reglamento que falló) desde su estado de cuenta, **sin ver quién lo reportó**.

**Fuga que se cerró:** la RLS de `incident_reports` era colonia-wide (`colonia_id = my_colonia_id()`)
→ cualquier residente podía leer `reportante_house_id` de CUALQUIER fila (incl. donde era infractor).
El "anónimo" era solo visual. **Ahora** `incident_reports_read = (colonia AND is_admin) OR reportante = my_house`:
el residente solo lee directo los reportes que ÉL levantó; como infractor la fila le es invisible y
el detalle lo obtiene por RPC enmascarado. Verificado simulando al infractor real (Casa 139):
`filas_como_infractor = 0`, y `ver_resolucion_multa` **nunca** devuelve `reportante_house_id`.

**Piezas (migraciones 033, 033b, 034):**
- `vecino.reglamento` (113 artículos de Villa Catania sembrados desde el docx del vault). RLS read
  colonia / write admin. `fine_categories.articulo_id` → mapea cada categoría a su artículo
  (Estacionamiento→97 sexies, Mascotas→38, Ruido→97, Amenidades→101 bis, Fachada→15, Higiene→24, Basura→36).
- `incident_reports.resolucion_oficial / articulo_snapshot / resolucion_generada_at`.
- RPC `ver_resolucion_multa(p_transaction_id)` — SECURITY DEFINER, guard `infractor = my_house OR (is_admin AND colonia)`;
  devuelve categoría/monto/foto/artículo(literal)/resolución, **omite el reportante**. Localiza por el
  `transaction_id` del cargo que el residente ve en su estado de cuenta.
- RPC `set_resolucion_oficial` (service_role) — la escribe la Server Action.
- **Server Action** `generarResolucionOficial` (`incidencias/resolucion-actions.ts`): Claude (`claude-opus-4-8`)
  redacta la resolución citando el **texto LITERAL** del artículo (prohibido inventar / mencionar reportante).
  Se dispara al aprobar la multa (`resolver_incidencia` multar / `votar_resolucion` aprobar), best-effort.
- **Front residente:** tarjeta de saldo del dashboard → `/dashboard/mi-cuenta` (sus `transactions`, RLS self);
  cada cargo `Multa:` tiene "📄 Ver resolución" → modal con foto + artículo + resolución. E2E probado:
  IA generó resolución real de Casa 139 citando Art. 97 sexies textual, sin reportante.

**Tope de multa → CONFIGURABLE** (`colonias.tope_multa` ahora nullable, `NULL = sin límite`).
Villa Catania quedó en `NULL` porque el **Art. 101 bis dice "NO tiene tope superior"** (multa progresiva
`base × N`). Antes la app violaba su propio reglamento capando a $1,000. `sugerir_multa` / `resolver_incidencia`
solo aplican tope si NO es NULL.

**Caveat:** las 218 multas viejas no tienen `evidencia_capturada_at` → la resolución IA usa `created_at`
como fecha (hora del INSERT, no del hecho). Las multas NUEVAS sí sellan la hora real al reportar. La
resolución oficial de multas viejas se genera bajo demanda (aún no hay backfill masivo; el artículo + foto
ya se muestran sin la resolución IA).

**Pendiente menor:** bucket `vecino-evidencias` sigue público (URLs no adivinables). La fuga crítica
(identidad del reportante) está en la fila, no en la foto, y quedó cerrada. Signed URLs privados = Fase 2.

## Cutover / lanzamiento a Villa Catania (2026-06-30) 🚀
Mecanismo de migración de residentes del sistema viejo (Django/PythonAnywhere) a la app nueva, validado en prod.
- **Hallazgo clave:** el login viejo es `username=casa_NNN + password` de Django; **solo 6 de 124 usuarios tienen
  email real** (111 traen `'nan'` de un import) → **NO se puede "mandar liga de reset por email"**. El camino correcto
  es el onboarding por **código de invitación** (`CAT-<casa>`), que ya estaba sembrado: **119 invitaciones, 0 usadas**.
- **Reconciliación de saldos** legacy (`db.sqlite3`, foto 22-jun) vs `vecino.houses`: **migración fiel**, única
  diferencia Casa 170 ($0→$300, confirmar con comité). Sumas $64,761 vs $65,061.
- **Auto-aprobación (deployada, commit `7c70c05`):** `completeOnboarding` ahora pone `approval_status: "aprobado"`
  (el código CAT-NNN ya prueba identidad) → el vecino entra directo al dashboard, sin 119 aprobaciones manuales.
  **Validado en prod con CAT-128** (Juan, casa 128): `accepted_at` marcado + perfil `aprobado`.
- **Acceso del comité:** las 119 invitaciones son role `residente`. Se elevó la cuenta de Juan (casa 128) a `comite`
  y se **eliminó la cuenta demo `comite@cantera.test`** (perfil + auth user) — credenciales conocidas, riesgo en prod.
  ⚠️ La tabla "Cuentas demo" de abajo ya NO aplica para `comite@cantera.test` (borrada).
- **Redirect PythonAnywhere:** `proyecto-condominio/config/urls.py` reescrito a una landing "nos mudamos" que
  intercepta todo (menos `/admin/`) y manda a `https://vecinity.nexiasoluciones.com.mx` con instructivo del código.
  Reversible (urlpatterns viejo comentado al final). **Pendiente:** Juan sube + Reload en PythonAnywhere.
- **Distribución:** `docs/distribucion_codigos.csv` (116 casas reales, sin las 3 cuentas de servicio Alberca/
  Jardinería/Vigilancia) — 114 con link WhatsApp pre-llenado, 2 sin teléfono (entrega en persona). **NO commiteado** (PII).
- App pública viva: `https://vecinity.nexiasoluciones.com.mx` (deploy EasyPanel auto desde push a `main`).
- **Redirect PythonAnywhere DEPLOYADO** (consola Bash, no git): `config/urls.py` ahora sirve la landing "nos mudamos".
  Gotcha que costó: la primera versión usaba `_LANDING % NUEVO_SITIO` pero el CSS tiene `%` literales (`100%`,`40%`)
  → Python intenta interpretarlos como formato → `ValueError` en runtime (Django "Something went wrong"). `ast.parse`
  NO lo detecta (solo sintaxis). Fix: quitar el operador `%`, URL hardcodeada en el `href`. Otro gotcha: el comando
  base64 de una sola línea (~3KB) se **trunca al pegar** en la consola web → escribió archivo vacío sin error;
  usar **heredoc multilínea** (`cat > f <<'EOF'`) que se pega completo.
- **Guardias (1 cuenta por guardia, role `guardia`, aprobados, colonia Villa Catania, sin house_id):**
  Antonio Serrano (`antonio.serrano@villacatania.mx`) y Felipe (`felipe.caseta@villacatania.mx`), pass temporal
  `Caseta2026` (correos solo-login, reset por correo NO aplica → cambio de pass vía Admin API). Login verificado.
  ⚠️ Sigue viva la cuenta demo `guardia@cantera.test` (password rotado 2026-07-15; vive en `.env.local`, NO publicar).
- **Cámara forzada en caseta (commit `792fd1c`, deployado):** los 5 inputs de foto de `/vigilancia` (INE+placas
  de visita walk-in, INE al dar entrada, proveedor nuevo y "foto del día" de recurrentes) tenían solo
  `accept="image/*"` (dejaban elegir galería) → se agregó `capture="environment"` para abrir la cámara trasera
  directo en el celular. Auditoría confirmó: visitas tienen `foto_identificacion_url`/`foto_placas_url`/`plate_ocr`(+conf)
  con OCR activo (`leerPlaca`→`set_visita_plate`); recurrentes = `external_services.foto_url` vía `ingresar_proveedor`;
  bucket `vecino-evidencias` existe. `general_services` (servicios de colonia) no lleva foto (no la necesita).

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
| `juanperez@cantera.test` | residente | *(rotada 2026-07-15 — en `.env.local`)* | ligado a **casa 100** (al corriente) para demo |
| `guardia@cantera.test` | guardia | `(rotada — .env.local)` | aterriza en `/vigilancia` |

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

## Finanzas — gastos de la colonia + dashboard + export CSV (2026-06-27) ✅
- **Sin migración:** la tabla `vecino.colonia_expenses` ya existía (002, 15 gastos reales = $55,050) y su
  política RLS `colonia_expenses_admin` (cmd ALL, `is_admin()`+colonia) permite que el **comité escriba
  directo** desde el cliente. `is_admin()` cubre roles `admin` y `comite`. → feature **puro frontend**.
- **Columnas:** concepto, monto, **categoria (text libre)**, fecha_pago (date), descripcion,
  archivo_principal/secundario_url, registrado_por. No hay estado (los gastos solo se registran).
- **Nueva página `/dashboard/gastos`** (guard admin/comité): total, **desglose por categoría** (barras CSS,
  sin dep de charts), registrar gasto (concepto, monto, categoría con `<datalist>` de sugerencias,
  fecha, comprobante a Storage `vecino-evidencias/gastos`), lista con borrar, y **export CSV**
  (Blob client-side, con BOM UTF-8 para Excel). Enlazada desde el panel del comité (sección Finanzas).
- **Verificado E2E** con `comite@cantera.test`: insert vía RLS ok (sello registrado_por), desglose y CSV. Build limpio.
- **Pendiente finanzas (siguiente):** conciliación bancaria (ver abajo), censo.

## Finanzas — conciliación bancaria de ingresos (2026-06-27) ✅
Replica el flujo del Excel del comité (`Dashboard_Financiero_Villa_Catania` en el vault Obsidian):
suben el estado de cuenta BBVA (Excel) y asignan cada **abono** a su casa. **Insight clave:** el banco
**no dice qué casa pagó** (la referencia SPEI es un folio por transacción) → el match es manual/asistido.
- **Migración `022_conciliacion.sql`** (aplicada):
  - `transactions.banco_hash` + índice único parcial → **dedup** (no reimportar la misma fila del banco).
  - Tabla **`bank_ref_map`** (colonia, ref_key, house_id, veces) → **mapeo aprendido**: al asignar una casa
    a un concepto, se recuerda y se autosugiere después. RLS admin.
  - RPC **`conciliar_abono(house_id, monto, concepto, banco_hash, ref_key)`**: dedup → inserta abono
    `pendiente` → **`PERFORM resolver_transaccion(id, true)`** (reusa el ajuste de saldo/estatus existente)
    → upsert en `bank_ref_map`. Decisión: **abono aprobado directo** (el banco ya confirmó el ingreso).
- **UI `/dashboard/conciliacion`** (SheetJS `xlsx@0.18.5`): sube .xlsx → localiza la fila de encabezado
  (Día/Concepto/Cargo/Abono/Saldo) de forma flexible → lista los **ingresos** (ignora egresos), con casa
  sugerida del mapa aprendido + asignación manual, y marca los **ya importados** (dedup por hash SHA-256
  del cliente). "Conciliar seleccionados" llama `conciliar_abono` por fila. Enlazada desde el panel del comité.
- **Verificado E2E** con `comite@cantera.test` + .xlsx de prueba: 2 abonos conciliados → saldo de casas
  ajustado, mapeo aprendido, egreso ignorado, dedup ok, 0 errores de consola. Build limpio. Datos de prueba limpiados.
- **ref_key** = concepto normalizado (UPPER + espacios colapsados). Honesto: solo auto-sugiere cuando el
  concepto se repite idéntico (pagador con cuenta fija); los SPEI con folio variable quedan manuales (mejora con el uso).
- **Pendiente finanzas (siguiente):** detección de multas (pago > cuota) en la conciliación · importar egresos
  del mismo estado de cuenta (auto-categorizar) · censo.

## Multas — evidencia confiable + reporte mensual con IA (2026-06-27) ✅
Idea de Juan: la foto de la multa debe traer hora/lugar para el reporte. **Corrección técnica clave:** NO depender
del EXIF (los navegadores —iOS sobre todo— lo borran, la compresión lo destruye, y se puede falsificar). En su
lugar se captura metadata confiable **en el momento**, como dato estructurado a prueba de manipulación.
- **Migración `023_evidencia_multas.sql`** (aplicada): columnas `incident_reports.evidencia_capturada_at`
  (sellada por el **servidor** con `now()` al crear el reporte), `evidencia_lat`, `evidencia_lng`. Se reemplazó
  `reportar_incidencia` (DROP de la firma vieja de 4 args) por una de 6 args con `p_lat`/`p_lng`.
- **UI incidencias:** input de evidencia con **`capture="environment"`** (fuerza la cámara, no la galería) +
  `navigator.geolocation` (opcional, con permiso) → pasa lat/lng a la RPC. El comité ve la **hora exacta**
  (📸) y un link **📍 ubicación** (Google Maps) en la resolución.
- **Reporte IA `/dashboard/reporte-multas`** (comité): elige periodo (mes) → carga las multas (`estado='multa'`,
  `resolved_at` en el mes) vía RLS en el cliente → **Server Action** `generarReporteMultas` llama a **Claude
  (`claude-opus-4-8`, SDK `@anthropic-ai/sdk`)** y devuelve el reporte en Markdown. **La API key vive solo en el
  servidor** (el cliente solo manda las filas ya filtradas por RLS, nunca la key).
- **Verificado E2E**: residente reporta con **geo (lat/lng) + foto + hora sellada** → comité aplica multa →
  aparece en el reporte de junio con la hora exacta de la evidencia. Sin `ANTHROPIC_API_KEY`, el botón IA muestra
  un **error elegante** (no rompe). Build limpio. Datos demo limpiados (saldo restaurado).
- **`ANTHROPIC_API_KEY`:** ✅ configurada en `.env.local` **reusando la key de `nexia-tienda`** (misma cuenta
  Anthropic; ya la usa el bot/autocompletado de la tienda). Reporte IA **probado en vivo** (Claude generó el
  reporte real de junio 2026). ⚠️ Falta agregarla en **EasyPanel → Entorno** al momento del deploy.
- **OCR de placas + multa semi-automática (2026-06-27)** ✅ — ver sección siguiente.

## OCR de placas + multa semi-automática (2026-06-27) ✅
Idea de Juan: validar la placa de la incidencia (OCR vs lo que captura el vecino vs tabla `vehicles`)
y, si coincide, procesar — 1ª vez amonestar, reincidencia → multa auto que el comité confirma con 1 voto.
- **Migraciones `024` (enum) + `025` (lógica):**
  - `024`: agrega valores `amonestacion` y `propuesta` al enum `incident_status`. **GOTCHA:** `ALTER TYPE
    ADD VALUE` no puede usarse en la misma transacción donde se agrega → va en migración aparte (la 025 corre después).
  - `025`: columnas en `incident_reports` (`placa_reportada`, **`plate_detected`** —ojo: existía en `visitors`
    pero NO en incident_reports, hubo que crearla—, `plate_ocr_confidence`, `auto_resuelta`, `voto_por`, `voto_at`).
  - RPC `procesar_incidencia_auto(id, placa_reportada, plate_ocr, conf)` (SECURITY DEFINER, la llama la Server
    Action con service_role): **match de 3 vías** con `_norm_placa` (OCR ≈ reportada ≈ `vehicles.placa` de la casa
    infractora). Sin match → queda `pendiente`. Con match: 0 antecedentes (multa+amonestacion de esa casa+categoría)
    → **amonestación** auto (sin monto, notifica Telegram); ≥1 → **propuesta** de multa (monto vía `sugerir_multa`).
  - RPC `votar_resolucion(id, aprobar)` (is_admin): **1 voto** aprueba → crea CARGO + ajusta saldo (misma lógica
    que `resolver_incidencia` multar) + notifica; rechaza → `rechazado`. Helper `_notify_infractor` (tg_send, ignora chat null).
- **Server Action `incidencias/actions.ts` `autoprocesarIncidencia`:** descarga la foto, OCR con **Claude visión
  `claude-opus-4-8`** (base64, pide JSON `{placa,confianza}`), llama al RPC. Key reusada de tienda. Corre al reportar
  (decisión de Juan), solo si el vecino puso placa + foto.
- **UI:** residente ve "✅ Placa verificada por IA → amonestación / propuesta"; comité ve sección **"✨ Propuestas
  automáticas (IA)"** en `/dashboard/incidencias` con "Aprobar (1 voto) → multar" / "Rechazar".
- **Verificado E2E** (placa GNY752F→casa 103, imagen de placa generada): #1 → amonestación (OCR conf 1.0), #2 →
  propuesta $200 → comité votó → multa cargada. Build limpio, datos demo limpiados, saldo restaurado.
- **OCR de placas en caseta (visitas) — 2026-06-27** ✅ — ver sección siguiente.

## OCR de placas en caseta / visitas (2026-06-27) ✅
Cuando el guardia toma la **foto de placas** al registrar una visita manual, una Server Action lee la placa
con visión de Claude y la guarda. Los visitantes son externos (no están en `vehicles`) → el valor es
**capturar la placa para la bitácora** + cotejarla con lo que el guardia escribió (auto-llenado + calidad).
- **Migración `026`:** `visitors.plate_ocr` + `plate_ocr_confidence`; RPC `set_visita_plate(id, plate, conf)`
  (SECURITY DEFINER, is_guard): guarda `plate_ocr`, auto-llena `plate_detected` si venía vacía, y devuelve
  si coincide con la placa escrita. (`plate_detected` ya existía en visitors = placa de registro.)
- **Refactor DRY:** se extrajo el OCR a `src/lib/ocr.ts` (`leerPlacaDeImagen`, server-only, Claude `claude-opus-4-8`).
  Lo usan la Server Action de incidencias (`autoprocesarIncidencia`) y la nueva de vigilancia (`leerPlaca`).
- **UI `/vigilancia`:** al registrar visita manual con foto de placas → OCR → `set_visita_plate`; el **Historial
  de hoy** muestra la placa leída (🚘). Seguridad: el OCR (Server Action) no escribe BD; la escritura va por
  RPC gateada por is_guard con el JWT del guardia.
- **Verificado E2E** (guardia registra "Visitante OCR" con foto placa XYZ987C → plate_ocr='XYZ987C' conf 0.99,
  historial lo muestra). Build limpio, demo limpiado.
- **Pendiente (mejora):** OCR también al marcar entrada de un pase QR (hoy solo en registro manual de caseta).

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
**juanperez@cantera.test** (residente demo casa 100; password rotado 2026-07-15 — en `.env.local`).

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

## Sesión 2026-07-01 — vigilancia UX, estado de cuenta, SOS, QR, branding ✅
Todo desplegado en `main` (auto-deploy EasyPanel). Sin pendientes abiertos de esta sesión.
- **Vigilancia responsive + accesible**: layout de tablet (stack vertical + tarjetas en grid, ya no masonry), texto grande para guardias mayores, botón "Salir", **cámara forzada** (`capture="environment"`) en fotos. Secciones ahora son **bloques tipo tarjeta** (panel gris `bg-slate-100/70`) y "Registrar visita en caseta" es **bloque independiente arriba** (lo más usado; se quitó el toggle `mvOpen`).
- **Auto-refresco del tablero** cada 25s SIN recargar página (React conserva formularios) y **se pausa mientras el guardia captura** algo (`editandoRef`). Resuelve el bug viejo de "se actualizaba y perdían lo que escribían".
- **Escáner de pase QR en la app** (`html5-qrcode`): botón en vigilancia → cámara → extrae token de la URL → busca `visitors.token_acceso` → tarjeta con captura de foto INE/placas + `marcar_entrada_visita`. Reusa RPCs, sin cambios BD. (El QR solo codifica la URL `/visita/<token>`.)
- **SOS / botón de pánico** endurecido: residente = mantener-presionado 2.5s + geolocalización + manejo de error real. Guardia = **banner rojo de SOS activos en vivo** (realtime + sondeo 20s) con Atender/Cerrar. Backend: `notify_sos` ahora also notifica rol `guardia`; RPCs `atender_sos`/`cerrar_sos`; realtime en `sos_events`. ⚠️ Solo 1 persona tiene `telegram_chat_id` — falta que comité/guardias liguen Telegram.
- **Estado de cuenta por casa** (`/dashboard/estado-cuenta`, admin/comité): reemplaza el flujo inseguro de "entrar con la contraseña del vecino". Busca casa → desglose de `transactions` (cargos/abonos + estado + saldo corriente), resalta pendientes/rechazados, aprobar/rechazar inline. Movimientos más recientes primero.
- **Evidencias de incidencias (404)**: eran rutas relativas legacy de Django; subí las 196 imágenes de `proyecto-condominio/media/evidencias/` a Storage `vecino-evidencias` y reescribí URLs a completas (22 sin evidencia → NULL). Ver memoria `vecinity-legacy-media-migration`.
- **Datos**: corregidos conceptos mal rotulados sistémicos ("Mantenimiento Mensual - April 2026" del 30-abr → Mayo; April→Abril; June→Junio) e insertados pagos manuales de Casa 178 (Mayo $850 + Junio $750, idempotentes por `banco_hash`, replicando `resolver_transaccion`). Tope morosos: saldo > $1000 excluyendo `en_convenio`.
- **Ícono de app de marca**: emblema Vecinity (escudo+casa+pulso) → `icon.svg` + `apple-icon.png` + PWA `manifest.ts` + `icon-192/512.png` (generados con `sharp`). Se quitó el `favicon.ico` de plantilla.

## Sesión 2026-07-02 (2) — Control de gastos estandarizado ✅ (migr. 039)
Visión de Juan: el estado de cuenta diario queda completo en Supabase — abonos conciliados a
casa (ya existía) y ahora también los CARGOS como gastos con razón, categoría y proyecto.
- **Migración `039_gastos_banco.sql`** (aplicada): `colonia_expenses` + `banco_hash` (índice
  UNIQUE por colonia = dedup al re-subir el mismo Excel), `concepto_banco` (texto crudo del
  banco), `estado` (`sin_clasificar`/`clasificado`). Tabla **`expense_cat_map`** (keyword→
  categoría, la más larga gana): 20 semillas extraídas del Excel REAL del comité
  (Dashboard_Financiero_Villa_Catania_2026, 151 egresos categorizados a mano: JARDINER,
  ALBERCA, BASURA, JUMAPA, CFE, TELMEX, SAT/GUIA, RFC de la vigilancia…) + mapa APRENDIDO.
  Tabla **`project_documents`** (contrato/cotización/factura por proyecto, lectura colonia-wide).
- **RPCs SECURITY DEFINER**: `importar_gasto_banco` (dedup + auto-categoría; recurrente
  conocido → clasificado solo; desconocido o con proyecto propuesto → bandeja) y
  `clasificar_gasto` (razón + categoría + proyecto + APRENDE la firma del proveedor).
  Patrón 036: lo aprendido con proyecto se PROPONE (prellenado en bandeja), nunca se auto-aplica.
- **Conciliación** ahora parsea también los CARGOS del Excel: preview de auto-categoría,
  dedup marcado, botón "Importar gastos" (resumen: auto-clasificados vs a bandeja).
- **Gastos v2**: bandeja "Por clasificar" (razón + categoría + proyecto + keyword editable
  "el sistema aprenderá…"), selector de proyecto en captura manual, badge 📁 proyecto y CSV
  con columna Proyecto. Captura manual sigue para gastos en efectivo.
- **`/dashboard/proyectos`** (comité): CRUD de `improvement_projects` (tabla existía desde 002
  sin UI), presupuesto vs gastado real (suma de gastos ligados), pagos ligados y subir
  documentos a Storage `vecino-evidencias/{colonia}/proyectos/`.
- **`/dashboard/finanzas`** (TODO residente aprobado, read-only): entradas/gastos por mes
  (hora MX), desglose por categoría, detalle con comprobante, proyectos con costo y documentos.
  Acción 📊 en el dashboard del residente; el RLS colonia-wide de 002 ya lo permitía.
- **QA**: prueba E2E transaccional en BD simulando al usuario comité real (`set_config`
  jwt claims) con ROLLBACK: importar→auto-clasificar, dedup mismo hash, bandeja, clasificar+
  aprender, 2° pago del mismo proveedor propone el proyecto. `npm run build` limpio.
- **Backfill histórico ejecutado** (`scripts/backfill_gastos_2026.py`, idempotente): los 151
  egresos del Excel del comité quedaron en `colonia_expenses` con `banco_hash` (dedup si se
  re-sube el banco). Gotcha Excel: montos/saldos con formato fecha son SERIALES (serial =
  días desde 1899-12-30 → `1902-01-19` = $750). Anti-dup con los 15 manuales previos:
  12 se ENLAZARON por monto exacto + fecha ±5d (conservan la razón del comité; STEREN
  $4285.89→$4285.98 corregido al banco). Proyectos creados y ligados: **Bancas para áreas
  comunes** (4 pagos Home Depot) y **Manguera y aspersores** (enlazado al manual).
  Total BD: $579,590.12 (154 gastos).
- **2 dobles conteos borrados con OK de Juan**: "Mantenimiento alberca Mensual" $5,220
  (duplicaba el pago mensual del banco) y "Reparación de Pistones" $3,828 (= suma EXACTA de
  los 2 pagos del banco: anticipo $2,679 + liquidación $1,149, misma cuenta destino).
  "Garrafones $174" es legítimo (efectivo, no está en el banco). Total final: $570,542.12,
  cuadra con el reporte del comité (~$1 de redondeo de seriales).
- **Migración `040_bienes_editar_gasto.sql`** (aplicada): `es_bien` en `colonia_expenses`
  (🪑 patrimonio/inventario de la villa, ej. cafetera Walmart $899 "para las sesiones") +
  `clasificar_gasto` acepta `p_es_bien` y sirve para RE-clasificar gastos ya clasificados.
  UI: botón ✎ en cualquier gasto de `/dashboard/gastos` → editar razón/categoría/proyecto/bien
  inline (así se asignó "Mano de obra bancas (pago 2 de 3)" $700 → proyecto Bancas).
  `/dashboard/finanzas` muestra sección "🪑 Bienes de la villa" (transparencia del patrimonio).
  NOTA: banco 17-may tiene "MANTTO JUEGO INFANTIL 1 DE 3" $700 (mismo trabajador, pagos 1/2/3
  de 3) — el "3 de 3" aún no aparece en el estado de cuenta.

## Sesión 2026-07-02 (3) — Categorías canónicas (dropdowns) + filtros
- **`src/lib/categorias.ts`** (nueva, fuente única): lista CERRADA de 21 categorías canónicas
  + `COLOR_CATEGORIA` + `canon()` (mapa formas viejas→canónica). Reemplaza los inputs de
  texto libre (`<input list="cats">`) por `<select>` en captura manual, bandeja y edición
  inline → **evita typos y duplicados de captura**.
- **BD normalizada** (una sola pasada): fusionadas las variantes que ya se habían colado —
  Jardineria→Jardinería, SAT/Impuestos→Impuestos (SAT), CFE→CFE (Luz), Vigilancia_Insumos→
  Vigilancia, Fumigacion→Fumigación. De 23 categorías sucias a 18 limpias.
- **Filtros**: en `/dashboard/gastos` el desglose "Por categoría" es clicable → filtra la
  lista de Movimientos (chip activo + contador + botón ✕), incluye un filtro "🪑 Bienes de la
  villa". Mismo patrón en `/dashboard/finanzas` (residente) sobre el detalle del mes.
  Flujo clave para Juan: filtrar "Otros" → reclasificar cada uno con ✎.
- El servidor sigue aceptando texto libre en `clasificar_gasto` (no hay CHECK en BD); el
  candado es la UI (dropdown).

## Sesión 2026-07-02 (4) — Categorías administrables + filtros en CHIPS
- **Feedback de Juan**: (a) el filtro debía ser CHIPS visibles, no barras clicables;
  (b) poder crear categorías desde la app (ej. "Insumos caseta"), no en código.
- **Migración `041_expense_categories.sql`** (aplicada): tabla `vecino.expense_categories`
  (colonia_id, nombre, activa, orden) con UNIQUE case-insensitive por colonia; sembradas las
  21 canónicas + "Insumos caseta" (22 total). RPCs SECURITY DEFINER: `crear_categoria`
  (o reactiva si estaba oculta), `renombrar_categoria` (**arrastra** colonia_expenses y
  expense_cat_map al nuevo nombre), `set_categoria_activa` (ocultar sin borrar histórico).
- **Gastos v3**: los dropdowns ahora leen `expense_categories` (no la constante); `opcionesCat`
  incluye el valor actual aunque esté oculto (no pierde selección al editar gasto viejo).
  **Filtro en fila de chips** (pastilla por categoría con punto de color + conteo, + "Todas" y
  "🪑 Bienes"). **Gestor "⚙️ Administrar categorías"** colapsable: crear / renombrar (✎) /
  ocultar (⊘) / reactivar (↺). `src/lib/categorias.ts` queda como semilla + COLOR + canon.

## Sesión 2026-07-03 — Incidencias: corregir casa infractora + gráfica mensual de gastos
- **Gráfica mensual de gastos** (feedback Juan): la tarjeta de Gastos ahora muestra "Promedio
  por mes" grande + gráfica de barras por mes (últimos 8) en ámbar (sobre promedio) / verde
  (debajo) + Total discreto. GOTCHA: las barras deben usar **altura en px, no %** — dentro de
  un flex `items-end` sin altura de referencia definida el `height:%` colapsa a 0 (se veían
  solo los números, sin barras). Promedio = sobre meses CON movimientos (decisión de Juan).
- **Migración `042_corregir_infractor.sql`** (aplicada): RPC `corregir_casa_infractora(id,
  numero)` SECURITY DEFINER — el comité corrige la casa infractora de una incidencia si el
  vecino la reportó mal. Solo mientras está `pendiente`; valida que la casa exista en la
  colonia. UI: botón "✎ cambiar casa" en `ResolverItem` (dashboard/incidencias) → input inline
  → tras guardar recarga placas+reincidencia (dependen del infractor). Verificado E2E con
  rollback (cambio + guard casa inexistente).

## Sesión 2026-07-03 (2) — Incidencias con evidencia SIN casa identificada
- Juan: a veces hay evidencia (foto) pero no se sabe qué casa es. **Migración `043`**
  (+ enum value `sin_identificar` agregado en llamada aparte antes): `incident_reports
  .infractor_house_id` ahora NULLABLE; RPC `reportar_incidencia_sin_casa` (exige foto, crea
  en estado `sin_identificar`, infractor NULL); `corregir_casa_infractora` ahora también
  identifica los `sin_identificar` → al asignar casa los pasa a `pendiente` (flujo normal).
- **Frontend**: checkbox "🤷 No sé qué casa es — solo tengo la evidencia" en el reporte
  (oculta casa/placa, exige foto). Comité: bandeja nueva "🔎 Por identificar" (`IdentificarItem`)
  con la foto/ubicación + input para asignar casa → pasa a la bandeja de pendientes. "Mis
  reportes" muestra "por identificar / en identificación" (badge azul). Verificado E2E con
  rollback (sin foto rechazado, sin_identificar creado, identificado→pendiente).

## Sesión 2026-07-03 (3) — Propietarios de casas rentadas (código PROP)
- Problema: ~30% de casas rentadas; el inquilino usó el código CAT, pero el mantenimiento lo
  paga el DUEÑO, que no existía en el sistema. **Migración `044_propietarios.sql`** (aplicada):
  - `vecino.house_members` (colonia, casa, perfil, `relacion` enum `propietario`) — vínculo
    persona↔casa por relación; `profiles.house_id` sigue siendo "donde VIVO" (NULL para dueño
    externo). Soporta dueño con 2+ casas y dueño que vive en una casa y renta otra.
  - **Alcance en BD, no en UI**: `my_finance_house_ids()` (vivo ∪ propietario) SOLO en
    superficies financieras: policy `transactions_read`, `registrar_abono` (nuevo arg
    `p_house_id`, colonia derivada de la CASA; DROP de la firma de 4 args para no crear
    sobrecarga ambigua en PostgREST), `set_abono_ocr`. Visitas/reservas/vehículos/incidencias/
    SOS siguen con `my_house_id()` → NULL para el dueño = sin acceso por diseño.
  - `crear_invitacion_propietario(house_id)` (admin): genera/reusa código `PROP-<casa>`
    idempotente en `invitations` (columna nueva `relacion`). `notify_saldo` ahora avisa a
    TODOS los ligados con Telegram (residentes + dueños — el dueño es quien paga).
- **Onboarding** (`actions.ts`): código PROP → perfil con `house_id` NULL + fila en
  `house_members`, auto-aprobado. Si el correo YA tiene cuenta (dueño que vive en la colonia)
  → solo se liga la casa (`linked:true`) y `/login?linked=1` muestra banner "entra con tu
  contraseña de siempre".
- **Frontend**: comité genera el código en el panel (sección "Acceso para propietario",
  tap-para-copiar). Dashboard: tarjeta por casa propia (gris "tu propiedad" / ámbar con
  adeudo); dueño externo puro NO ve reservas, vehículos, visitas, incidencias ni SOS.
  `/dashboard/pagos`: chips selector de casa si tienes 2+ (vivo+propias), `registrar_abono`
  manda `p_house_id`.
- **QA en prod con rollback (10/10)**: dueño ve/abona SOLO su casa; no ve transactions ni
  house_members ajenos; `my_house_id()` NULL; residente intacto (abono sin arg); PROP
  idempotente. Patrón DO + `set_config(jwt.claims)` + `SET LOCAL ROLE authenticated` +
  RAISE final.
## Sesión 2026-07-03 (4) — Caty con superpoderes (bot Telegram operativo)
- Caty pasó de solo ligar el chat a OPERAR: reservas, pases de visita, comprobante por
  foto, saldo amable, reglamento citado y escalación al comité. **Migración `045_caty_bot
  .sql`** (aplicada, QA 13/13 rollback):
  - **Patrón identidad bot**: wrappers `bot_*(p_token, p_chat, …)` SECURITY DEFINER que
    resuelven perfil por `telegram_chat_id` + IMPERSONAN (`set_config('request.jwt.claims',
    {sub})` local a la tx) y llaman al RPC real (`crear_reserva`, `registrar_visita`,
    `registrar_abono`, `set_abono_ocr`) → cero lógica duplicada; umbral de saldo, horarios
    de área y los 3 candados anti-dup aplican idénticos desde Telegram. Gate doble: token
    en `bot_config` (chat_ids son semi-adivinables con anon key) + chat ligado.
  - `bot_sessions` (flujos multi-paso, expiran a 2h), `bot_reglamento_buscar` (FTS spanish
    + fallback ILIKE, índice GIN), `bot_movimientos` (contexto para Haiku), `bot_escalar`
    (notifica a comité/admin con Telegram + residentes de `bot_config.casa_escalacion`,
    default '128', y registra en `notifications`).
- **n8n**: workflow `QcbjAUiwnW28lXLw`, un Code node (`n8n/caty_bot.js` en el repo con
  placeholders; **deploy: `scripts/push_caty.sh`** — sustituye secretos de .env.local +
  token BD, node --check, PUT + deactivate/activate para republicar). Menú inline,
  callback_query, reservas con disponibilidad por hora (CDMX UTC-6 fijo), visita → link
  del pase `/visita/<token>`, foto → getFile → bucket (service key, solo server-side) →
  OCR Claude Haiku (monto+clave rastreo) → confirmar → abono pendiente; saldo con últimos
  movimientos + dudas libres vía Haiku (JSON {respuesta, escalar}) con auto-escalación;
  reglamento cita artículos literales (anti-alucinación).
- Probado E2E: webhook con chat no ligado → ejecución success (invita a ligar). Falta
  prueba en vivo con chat real de Juan (ligar Telegram y recorrer menú).
## Sesión 2026-07-03 (5) — SOS v2: vigilantes, zona, acuse y ruta 911
- **Migración `046_sos_vigilantes.sql`** (aplicada, QA 13/13 rollback):
  - **BUG FIX**: el capitán de zona NUNCA recibía el SOS — el insert del dashboard no
    mandaba `zone_id`. Ahora `disparar_sos(lat,lng,mode)` (RPC) resuelve casa Y zona en BD
    y regresa los datos 911 (calle, número, colonia).
  - **Vecinos vigilantes**: tabla `vigilantes` (postulado→aprobado/baja), `postular_
    vigilante()` (self, requiere vivir en casa), `resolver_vigilante(id, aprobar|baja)`
    (comité). `_sos_destinatarios()` centraliza: comité/admin + capitán de zona +
    vigilantes aprobados, excluyendo al solicitante.
  - **Acuse lazo cerrado**: `tg_send_kb` (pg_net + inline keyboard); la alerta lleva botón
    "🏃 Voy en camino" → `bot_sos_atender` con primero-gana (`WHERE attended_by IS NULL`
    + ROW_COUNT); Caty avisa al solicitante y al resto. GOTCHA cazado en QA: en el guard
    de autorización, `p.id = (subquery que da NULL)` → `NOT(false OR NULL)` = NULL y el
    RAISE no dispara → usar `EXISTS`, nunca `= (subquery)` dentro de un `NOT(...)`.
  - **Ruta 911**: mensaje de alerta con bloque "datos para el 911"; `sos_events.llamo_911`
    + `sos_marcar_911()`. NO hay API pública del 911 en MX — se facilita la llamada, no
    se simula integración.
- **Frontend**: `dashboard/sos.tsx` (hook `useSos` + `SosModal` 911 + `SosFab`); layout
  nuevo del dashboard monta el **FAB rojo en TODAS las páginas** (oculto en home, para
  dueño externo y guardia). Home refactorizado al RPC + modal. Tarjeta "¿Quieres ser
  vecino vigilante?" (postular/en revisión/activo). Comité: bandeja aprobar/dar de baja.
- **Caty**: botón 🆘 en menú + escribir "sos/911/auxilio" → confirmación → `bot_sos`
  (impersonación) → respuesta con ruta 911; callback `sos_go:<id>` = acuse.
## Sesión 2026-07-03 (6) — Reglamento completo verificado + mejor búsqueda
- PREMISA FALSA detectada: la bitácora decía que la 033b sembró "solo artículos de
  multas", pero la tabla YA tenía el reglamento completo (113 filas). El trabajo real
  fue un **diff contra el docx canónico** (Consolidado 2026, vault VillaCatania):
  4 registros desviados + 1 faltante. Fuente: `Reglamento_Consolidado_Villa_Catania_
  2026.docx` → `textutil` → parser Python → diff normalizado → upsert quirúrgico.
- Corregido: **101 bis estaba TRUNCADO** (350→2,121 chars — le faltaba el tabulador
  completo de multas, lo más preguntable); Anexos A/B traían la bitácora 📌 revuelta
  dentro del texto (ahora en su campo); agregado **Anexo C** (acuerdos post 22-may-2026).
  Total: 114 registros.
- **Migración `047_reglamento_search.sql`**: el fallback ILIKE de `bot_reglamento_buscar`
  ahora rankea por # de palabras que pegan (antes: 6 filas en orden arbitrario).
- **Caty**: expansión de sinónimos ANTES de buscar (perro→mascota/animales, carro→
  vehículo, fiesta→ruidosa/evento, etc.) — el vecino no habla en el vocabulario del
  reglamento. Verificado: "¿puedo tener perros?" → Art. 38 + 101 bis + Anexo A.
## Sesión 2026-07-03 (7) — Cierre: vigilante en Caty, unlink Telegram, CAT-128-2
- **Caty menú "🛡️ Ser vecino vigilante"** (migr. `048`, wrapper `bot_postular_vigilante`):
  muestra estado si ya está postulado/aprobado; al postularse avisa al comité por
  Telegram vía `bot_escalar`. Desplegado con push_caty.sh.
- **GOTCHA familiar Telegram**: la hija de Juan tocó "Conectar Telegram" desde el
  perfil de él → su chat quedó ligado al perfil de Juan y `link_telegram` NO
  sobrescribe (guard `telegram_chat_id IS NULL`). Fix: UPDATE a NULL y re-ligar con
  el deep-link `t.me/Caty_VCatania_bot?start=vecino_<profileId>` desde el teléfono
  correcto. Patrón correcto para familias: cada miembro su propia cuenta (invitación
  extra por casa, ej. `CAT-128-2` creada, vence 2026-09-02).
- ⏳ PENDIENTE DE JUAN: (1) ligar su Telegram con su deep-link; (2) **deploy EasyPanel**
  — 4 commits de frontend sin deployar (PROP, FAB SOS, postulación, bandeja vigilantes).
## Sesión 2026-07-06 — Módulo Credenciales (tarjetas PVC) + cola de impresión
- **Migr. 051**: `card_requests` (solicitud→aprobada→en_cola→impresa→entregada) +
  `print_jobs` (cola que consume nexia-print-bridge) + `colonias.precio_tarjeta_adicional`
  / `stock_tarjetas` (sembrado 100 VC) / `tarjeta_frente_url`. **Regla de cupo EN BD**:
  1ª tarjeta VEHICULAR por casa = incluida ($0); todo lo demás (2º carro, peatonales) se
  cobra al saldo con el patrón multa (transactions cargo + saldo + estatus), idempotente
  (FOR UPDATE + check de estado). Aprobación bloqueada si stock − en_cola < 1.
  RPCs: `cotizar_tarjeta`, `solicitar_tarjeta` (anti-dup por vehículo/beneficiario, índice
  UNIQUE parcial), `cancelar_solicitud_tarjeta`, `resolver_solicitud_tarjeta`,
  `entregar_tarjeta`, `print_retry_job`; del bridge (SOLO service_role): `print_take_jobs`
  (SKIP LOCKED) y `print_mark_job` (descuenta stock).
- **Migr. 052**: `verificar_credencial(profile_id)` — el guardia/comité valida el QR
  `/r/<profile_id>` de la tarjeta peatonal (nombre, casa, placas, activo).
- **UI**: `/dashboard/credenciales` (vecino solicita viendo costo ANTES; comité aprueba/
  rechaza, edita precio y stock inline, cola visible con reintentar, marcar entregada) +
  acción 🪪 en dashboard. Escáner de vigilancia ahora reconoce credenciales de residente
  además de pases de visita (ficha verde/roja con placas de la casa).
- **Bridge (nexia-print-bridge v0.3)**: modo cola `QUEUE_POLL=true` — barrido c/10s de
  `print_jobs`, imprime en la ZC300 y marca estados. Frente: `colonias.tarjeta_frente_url`
  o `FRONT_IMAGE` local. QR peatonal se arma en el bridge (`DEFAULT_QR_URL/r/<profileId>`).
- **QA**: 13 pruebas en DO block con rollback (guards, cupo, cargo, doble aprobación,
  stock, permisos, verificador) — todas ✓. E2E real: job insertado → bridge lo tomó solo
  → `impresa` + stock 100→99 → limpiado y restaurado.
- **Migr. 053 — tarjeta de VISITA FRECUENTE** (hijos/cuidadores de personas mayores que
  vienen seguido): tipo `visita` en card_type (enum agregado en llamada separada — gotcha),
  `beneficiario_nombre` text (persona sin cuenta), SIEMPRE con costo (nunca incluida),
  anti-dup por casa+nombre (UNIQUE parcial case-insensitive). QR propio `/vf/<request_id>`
  verificable en caseta (`verificar_tarjeta_visita`: válida solo impresa/entregada).
  Misma plantilla peatonal del bridge con `rotulo='VISITA FRECUENTE'`. GOTCHA aplicado:
  cambiar firma de `solicitar_tarjeta` = DROP FUNCTION de la vieja antes del CREATE
  (sobrecarga ambigua en PostgREST). Precio adicional Villa Catania: **$100** (definido por Juan).
  QA visita: 9 pruebas con rollback ✓ (cotiza 100, sin nombre/duplicado rechazados, cobra
  100 nunca incluida, payload correcto, en_cola no válida / impresa válida, roles).
- **Peatonal = "Próximamente" en la UI** (aún no hay tarjetas físicas de ese tipo): sección
  deshabilitada en /dashboard/credenciales; el backend (RPCs/plantilla/escáner) queda listo —
  para habilitarla restaurar el selector de miembros desde git (commit 6cb3912).
- **Panel del comité**: tarjeta 🪪 Credenciales en "Pendientes por revisar" (contador de
  solicitudes por autorizar → /dashboard/credenciales). Pusheado hasta `75117f6`.
- ⏳ PENDIENTE DE JUAN: (1) deploy EasyPanel de Vecinity; (2) `QUEUE_POLL=true` en el
  .env del bridge cuando quiera activar la impresión automática; (3) subir la
  imagen del frente oficial (o dejar FRONT_IMAGE local); (4) publicar el comunicado de
  la campaña de recolección desde la app (texto listo, ver sesión).

## Sesión 2026-07-04 — Deploy verificado + usuario de prueba E2E
- Juan hizo el deploy EasyPanel; verificado que el bundle servido trae el código nuevo
  (grep de "vecino vigilante"/"tu propiedad" en los chunks de /_next).
- **Usuario de prueba**: `prueba@vecinity.test` / `Vecinity2026!` — perfil
  `5432421c-ba8c-4592-9b34-0d3eb096c1f0`, VIVE en casa **999** y es PROPIETARIO de la
  **998** (rentada) → un solo login recorre residente + dueño externo (chips multi-casa).
  Casas demo: 999 `eaf8eb18…`, 998 `f0de5859…` (zona de la 128).
- **E2E por API como el usuario (todo ✓)**: login, saldo, abono $1 (999), abono $2 como
  dueño (998), pase de visita (página pública 200), reserva Alberca aprobada y cancelada,
  postulación vigilante, RLS positiva/negativa (casa 128 → vacío), web 200.
- Deliberadamente quedaron para probar el lado comité: 2 abonos pendientes (rechazar) y
  1 postulación de vigilante (aprobar). SOS NO se disparó (alertaría Telegram real).
- [ ] **BORRAR usuario/casas de prueba al terminar** (999, 998, perfil, movimientos) —
  el cron de cobros les generará cuota el día 1 como a cualquier casa.
- [ ] **Que comité y guardias liguen su `telegram_chat_id`** — sin esto el SOS por Telegram solo llega a 1 persona (el banner en pantalla del guardia sí jala sin Telegram).
- [ ] Ligar recibos históricos de `media/comprobantes_transacciones/` (~392) a sus transacciones (falta mapeo del sistema viejo).
- [ ] Botón "Registrar pago" en Estado de cuenta (admin captura pago de una casa sin depender de inserts manuales).
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

## Sesión 2026-07-08 — Comprobantes en mi-cuenta + módulo Multas por casa
- **Comprobantes visibles para el vecino**: `mi-cuenta` ya consultaba `comprobante_url`
  pero no lo renderizaba — agregado link "📎 Ver comprobante" en cada movimiento
  (mismo patrón que la vista del comité en estado-cuenta).
- **Migr. 054 — gestión de multas** (2 RPCs SECURITY DEFINER + is_admin, aplicada en prod):
  - `corregir_multa(incident, nuevo_monto, nota)`: ajusta `monto_multa` + el cargo ligado
    + `houses.saldo` por la diferencia (recalc estatus, respeta `tope_multa`); anexa nota
    de auditoría a `resolucion_admin` e invalida `resolucion_oficial` (citaba el monto
    viejo — la UI la regenera best-effort con `generarResolucionOficial`).
  - `cancelar_multa(incident, nota)`: nota OBLIGATORIA; cargo → `rechazado` (queda tachado
    en el historial con su monto para auditoría), saldo revertido (puede quedar a favor si
    ya se pagó), incident → `rechazado`, y `resolucion_oficial` determinista "# Multa
    cancelada" con fecha MX + motivo (el vecino la ve en su modal de resolución).
  - Una multa vive en 3 lugares (incident + transactions + houses.saldo): ambas RPCs los
    mantienen consistentes con FOR UPDATE en incident y transaction.
- **UI `/dashboard/multas`** (guard admin/comité): buscador por número de casa → multas
  activas (categoría, fecha, casa reportante, descripción, evidencia, Ver resolución) con
  "✏️ Corregir monto" y "Cancelar multa" (motivo obligatorio) + historial colapsable
  (rechazadas/canceladas con su nota). Tarjeta 🚨 "Multas por casa" en el panel del comité.
- **QA**: probado en prod con BEGIN/ROLLBACK impersonando al perfil comité
  (`set_config request.jwt.claims`): corrección 300→150 bajó saldo 1650→1500, cancelación
  revirtió 300 más (→1200), notas y resolución de cancelación correctas; rollback verificado
  (casa 170 quedó intacta: saldo 1650, 3 multas activas). `npm run build` limpio.
- **Caso que motivó el módulo**: casa 170 (Rosario) con 3 multas activas de $300
  "Estacionamiento Prohibido" (31 may, 13 jun, 14 jun, todas reportadas por la 166) — Juan
  decidirá cuál cancelar como duplicada desde el módulo nuevo.
- ⏳ PENDIENTE DE JUAN: deploy EasyPanel (la migración 054 ya está aplicada en la BD).
- **Fix vigilancia (fa4f12f)**: en Recurrentes/Reservas/Historial la casa iba al final de
  una línea con `truncate` y se cortaba ("Limpieza Casa 1…") — ahora "Casa N" va PRIMERO
  (y en negritas en recurrentes); lo que se trunca es el tipo/nombre, nunca la casa.

## Sesión 2026-07-09 — Banco persistente (staging) + cobertura + dedup con contexto + palomita
- **Problema (Juan)**: "subo el estado de cuenta por conciliación y siento que no se guarda"
  → correcto: el Excel se parseaba SOLO en el navegador; las filas no conciliadas se
  perdían al salir. Y no había noción de "hasta qué día está cargado el banco".
- **Migr. 055 (aplicada en prod)** — todo aditivo:
  - `bank_uploads` (historial de cortes) + `bank_movs` (staging de TODAS las filas del
    banco: fecha real como columna, hash UNIQUE, estado pendiente/conciliado/gasto/descartado).
  - `subir_corte_banco(archivo, filas jsonb)`: persiste el corte idempotente (re-subir el
    mismo Excel = 0 nuevas); filas cuyo hash ya estaba en transactions/expenses entran
    ya resueltas. `cobertura_banco()`: última fecha (con fallbacks a datos pre-staging),
    días de atraso (zona MX) y pendientes. `descartar_mov_banco(hash, nota)`.
  - **Triggers CON GUARD** en transactions y colonia_expenses (AFTER INSERT/UPDATE OF
    banco_hash WHEN NOT NULL, SECURITY DEFINER): al ligar banco_hash por CUALQUIER camino
    (conciliar_abono/auto/confirmar, importar_gasto, aprobar_abono_banco) la fila staged
    queda marcada sola — presentes y futuros.
  - **Rebote con contexto**: `set_abono_ocr` (dup por clave de rastreo) devuelve
    `original_casa`/`original_fecha`; `registrar_abono` (dup por imagen, colonia-wide)
    lanza "Ese comprobante ya se subió el DD/MM/YYYY por la casa N".
  - **Palomita positiva**: `abonos_pendientes_comite()` cruza cada pendiente contra
    `bank_movs` (1º clave de rastreo contenida en el concepto del banco, 2º monto exacto
    + fecha ±3d de la OCR/registro) y trae `ocr_monto` para comparar contra lo capturado.
    `aprobar_abono_banco(id, hash)`: aprueba Y liga la fila del banco de un golpe.
- **UI /dashboard/conciliacion**: guardar-PRIMERO al subir el Excel (💾 corte guardado);
  tarjeta de cobertura "🏦 Banco cargado hasta el X · ✓ al día / faltan N días — sube un
  corte más reciente" + tabla de cortes subidos (colapsable); al entrar se retoman los
  pendientes guardados sin re-subir el Excel; botón "descartar" por fila (traspasos, intereses).
- **UI /dashboard/pagos**: vecino rebotado ve fecha y casa del comprobante original, y
  aviso si el monto OCR ≠ capturado; el comité ve por card: ✓ verde "encontrado en el
  banco (fecha · por rastreo/monto+fecha)", chip monto comprobante (✓ coincide / ⚠️ difiere
  con ambos valores) y el badge de posible duplicado de siempre. Aprobar con palomita usa
  `aprobar_abono_banco` (liga el banco); sin palomita, `resolver_transaccion` como antes.
- **QA en prod con BEGIN/ROLLBACK** (comité 128, vecinos 242/127): corte idempotente ✓,
  cobertura ✓, dup rastreo con casa/fecha ✓, dup imagen otra casa ✓, palomita por rastreo
  y por monto+fecha ✓ (OCR 900 vs 888.88 detectado), aprobar ligó banco+saldo+staged ✓,
  gasto marcó staged ✓, descartar ✓, RLS con `SET LOCAL ROLE authenticated` (vecino 0
  filas, comité sí) ✓, rollback sin rastro (saldo 242 = 1470 intacto) ✓. Build limpio.
- **GOTCHA /pg/query multi-statement**: devuelve SOLO el último statement que produce
  filas → para QA con varias verificaciones, acumular en TEMP TABLE + un único SELECT
  final ANTES del ROLLBACK (y `GRANT ALL ON temp TO authenticated` si usas SET LOCAL ROLE).
- **Gotcha fechas date-only en UI**: `new Date('YYYY-MM-DD')` = UTC midnight → en MX se
  recorre un día atrás; anclar a `T12:00:00` (helpers `fmtDia`/`fechaDia`).
- ⏳ PENDIENTE DE JUAN: deploy EasyPanel (migración 055 ya aplicada en la BD).
- **Migr. 056 — corregir monto antes de aprobar** (caso casa 222: capturó $750, el
  comprobante decía $450): RPC `corregir_monto_abono(id, nuevo_monto, nota?)` — solo
  comité, SOLO abonos `pendiente` (aún no tocan saldo; resolver aplicará el corregido),
  auditoría en el concepto ("monto corregido de $750 a $450 por el comité"). UI: botón
  "✏️ Corregir monto" en cada card de por-aprobar, pre-llenado con el monto OCR cuando
  difiere; al guardar recarga la lista y si ya cuadra con el banco sale la palomita.
  QA con rollback: corrige+audita ✓, sin_cambio ✓, monto 0 ✗, aprobado ✗, no-admin ✗.
- **Migr. 057 — palomita solo con match SEGURO** (observación Juan: muchas casas pagan
  el mismo monto el mismo día → monto+fecha podía ligar la fila de OTRA casa):
  `abonos_pendientes_comite()` ahora clasifica el match: `rastreo` (clave única) /
  `casa` (el concepto del banco menciona C###/CASA### de ESA casa) / `monto_fecha`
  (solo si el cruce es 1 a 1: único abono ↔ única fila) / `monto_fecha_ambiguo`
  (varios candidatos → badge ámbar "hay N pagos con este monto" y Aprobar NO liga la
  fila del banco, se aprueba normal y se concilia en /conciliacion). Si el banco
  menciona OTRA casa válida, el candidato se descarta. QA con rollback: los $750
  reales dieron 18 candidatos → ámbar ✓; $333.33 único → verde 1:1 ✓; "CASA 242" en
  concepto → verde por casa ✓; "C127" con abono de la 242 → sin palomita ✓.
- **Pagos: sección "Banco: ingresos sin conciliar"** (pedido Juan): lista las filas del
  staging (`bank_movs` estado pendiente, tipo abono) en la misma pantalla de Pagos, con
  botón Descartar en dos taps (primero confirma, `onBlur` cancela) vía
  `descartar_mov_banco`; al descartar se recargan pendientes (cambian palomitas y
  ambigüedades). Link directo a Conciliación para asignar casa.
- **Migr. 058 — enlace manual abono↔banco con APRENDIZAJE** (pedido Juan; caso casa 163:
  fecha del comprobante 4-jul y no 6-jul → el cruce automático no lo agarraba):
  - `enlazar_abono_banco(abono, fila, motivo?)`: exige monto igual (si no, "corrige
    primero el monto"), liga banco_hash + aprueba, audita el motivo en el concepto del
    abono Y en `bank_movs.nota`, y APRENDE: guarda `_norm_ref_key(concepto_banco)` →
    casa en `bank_ref_map` (mismo mapa que autosugiere en /conciliacion).
  - `abonos_pendientes_comite` v3: nuevo nivel **'aprendido'** (referencia enseñada +
    monto exacto, SIN exigir fecha) — verde/seguro, prioridad rastreo > casa > aprendido
    > monto_fecha 1:1 > ambiguo.
  - UI Pagos: botón "🔗 Enlazar al banco" en cada card por-aprobar → candidatos del
    banco del MISMO monto ordenados por cercanía de fecha (radio), campo "¿cómo lo
    identificaste?" (opcional) y "Enlazar y aprobar". Si no hay candidatos del monto,
    sugiere Corregir monto.
  - QA rollback: enlace+auditoría+nota ✓, bank_ref_map aprendió (casa 242) ✓, mes
    siguiente con fecha fuera de ±3d → match 'aprendido' ✓, montos distintos → error
    claro ✓. Gotcha QA: anti-dup de 10 min (misma casa+monto) obliga a variar montos
    en escenarios de prueba consecutivos.
- **Migr. 059 — aclaración de comprobantes ilegibles** (pedido Juan: "su comprobante no
  cuenta con fecha… ¿nos puede decir la fecha y el concepto?"):
  - `solicitar_aclaracion_abono(id, mensaje?)` (comité): mensaje formal AUTOMÁTICO según
    lo que falte en el OCR (fecha/concepto), se guarda sobre el movimiento y sale por
    Telegram (tg_send best-effort) a los perfiles de la casa con chat ligado (residentes
    + house_members). `responder_aclaracion_abono(id, fecha?, texto?)` (vecino, gateada
    por my_finance_house_ids): guarda la respuesta y **inyecta la fecha al
    comprobante_ocr** (`fecha_fuente:'vecino'`) → el cruce con el banco la usa y la
    palomita aparece sola. `abonos_pendientes_comite` v4 expone aclaración/respuesta.
  - UI Pagos: comité "✉️ Pedir datos" por card (badge "esperando respuesta" → caja verde
    "💬 Vecino respondió"); vecino ve banner azul en Mis movimientos con el mensaje +
    fecha/concepto + Enviar respuesta.
  - GOTCHA SQL: `jsonb || NULL = NULL` — al mergear piezas condicionales al OCR, cada
    CASE va envuelto en `coalesce(…,'{}'::jsonb)` o borra el objeto completo.
  - QA rollback: mensaje automático correcto + 1 Telegram (revertido) ✓, responder sin
    solicitud ✗, otro vecino ✗, respuesta inyecta fecha al OCR ✓, y el abono pasó de
    en_banco:false a match monto_fecha 1:1 tras responder ✓.
- **[2026-07-11] Vigilancia: la captura sobrevive al kill de Android al abrir la cámara**
  (reporte del guardia: registraba visita + foto y "lo sacaba de la app" con aviso de
  falta de memoria — la tablet mata el proceso de la PWA mientras la cámara nativa está
  abierta; al volver, la página arrancaba de cero y se perdía el registro):
  - Nuevo `src/lib/draftGuardia.ts`: `comprimirFoto()` (canvas → JPEG máx 1280px, fail
    open a la original), borrador de textos en localStorage (TTL 60 min, se limpia solo
    cuando los campos quedan vacíos tras registrar) y fotos staged como Blobs en
    IndexedDB (`vecinity-vigilancia/fotos` — sobrevive al kill del proceso).
  - `vigilancia/page.tsx`: los 7 inputs de foto comprimen + respaldan al elegir
    (visita manual INE/placas, modal QR INE/placas, INE staged por visita, foto de
    proveedor staged y nuevo proveedor); al montar se restaura todo (incluido el modal
    QR con su visita) con banner ámbar "🔁 Se recuperó tu captura anterior"; indicador
    "✓ lista" junto a cada input (el input pierde el nombre del archivo tras restaurar);
    el respaldo se borra en cada registro exitoso y al cerrar el modal QR.
  - Sin cambios en BD. Nota: las fotos NUNCA pasan por la galería de la tablet (van del
    caché del navegador a Supabase Storage) — que la galería esté vacía es normal.
  - ⏳ PENDIENTE DE JUAN: deploy EasyPanel (acumulado con el pendiente anterior) y
    probar en la tablet real del guardia.
- **[2026-07-13] Panel comité de acceso RFID: override por casa + umbral editable + semáforo Orin**
  (migr. `060_rfid_panel_comite.sql` ✅ aplicada en BD · QA 19/19 con ROLLBACK · build ✓):
  - `houses.rfid_override` por casa: `auto` / `forzar_activo` (exenta de mora) /
    `forzar_suspendido` (motivo obligatorio) — `rfid_reconcile_plan` lo respeta (los
    forzados ganan a la regla de saldo) y emite `motivo` mora|manual; `rfid_mark` nuevo
    de 4 args (el de 3 se DROPeó — sobrecarga ambigua PostgREST).
  - Umbral de suspensión editable por colonia (`rfid_set_umbral`, antes fijo $2,400) y
    bitácora `rfid_panel_log` (quién/qué/motivo, últimos 20 en el panel).
  - Heartbeat de la Orin: poller llama `rfid_heartbeat` cada vuelta → semáforo
    "caseta en línea / sin señal" (umbral 25 min) en el card nuevo de
    `/dashboard/comite` (`AccesoRfid.tsx`, todo vía RPC `rfid_panel_data` gate is_admin).
  - Convención de signo confirmada con datos: en `houses.saldo` NEGATIVO = deuda
    (la regla RFID usa `saldo <= -umbral`); el card marca EN MORA con la misma regla
    del RPC para no divergir.
  - ⏳ PENDIENTE DE JUAN: (1) autorizar Tailscale para copiar `poller.py` parchado a la
    Orin + `sudo systemctl restart access-bridge` (hasta entonces no hay heartbeat y los
    Telegram no etiquetan "por decisión del comité"; el resto ya funciona), (2) deploy
    EasyPanel del frontend.
- **[2026-07-13] Cobro real de tarjetas de acceso + personalizada + pago separado del mantenimiento**
  (migr. `061_tarjetas_cobro.sql` ✅ aplicada · QA 14/14 con ROLLBACK · build ✓):
  - **Bug raíz corregido**: `solicitar_tarjeta` nunca marcaba `es_incluida` en el INSERT →
    `cotizar_tarjeta` siempre veía libre la incluida → TODAS las tarjetas cotizaban $0 y
    nadie veía el aviso de costo (así casa 128 pidió 2 sin costo). Ahora la incluida se
    reclama AL SOLICITAR (serializado por FOR UPDATE de la casa).
  - **Personalizada 🎨 (+$50, `colonias.precio_personalizacion`)**: solo vehiculares;
    frente a color + datos del carro al reverso. El payload del print job lleva
    `personalizada: true|false`. ⏳ El print-bridge debe respetar la bandera
    (blanca = sin impresión de diseño).
  - **Pago por transferencia SEPARADO del saldo** (sin opción de efectivo — decisión Juan):
    `resolver_solicitud_tarjeta` YA NO carga a transactions/saldo; ciclo
    `pago_estado`: pendiente → en_revision (vecino sube comprobante a
    `vecino-comprobantes/tarjetas/` vía `subir_comprobante_tarjeta`) → aprobado/rechazado
    (`validar_pago_tarjeta`, comité, nota obligatoria al rechazar). Guard: no se
    aprueba/imprime sin pago validado.
  - **Retro-fix campaña**: de las 51 solicitadas, la vehicular más antigua de cada casa
    quedó como incluida $0 (25 casas) y 26 quedaron adicionales $100 con pago pendiente
    ($2,600 por cobrar). ⚠️ Avisar a los vecinos (comunicado/Caty) antes de exigir el pago.
  - UI credenciales: checkbox personalizada con desglose, badges de pago, subir
    comprobante en la card, comité valida pago ("Pago recibido ✓" / rechazar con motivo),
    botón aprobar bloqueado hasta pago validado, input de precio de personalización.
  - ⏳ PENDIENTE DE JUAN: deploy EasyPanel (junto con el panel RFID de la migr. 060 que
    sigue sin salir — el deploy de las 14:00 quedó con el build del 12-jul) y plantilla
    personalizada en el print-bridge.
- **[2026-07-13] Personalización estándar de tarjetas (migr. `062` ✅ aplicada, QA 4/4)**:
  decisión del comité — TODA tarjeta vehicular sale personalizada (diseño villa + datos del
  carro al reverso); adicional subió a $150 con personalización incluida (Juan lo cambió en
  la UI); `precio_personalizacion` → 0 (columna se conserva); `solicitar_tarjeta` fuerza
  `personalizada=true` en vehiculares; UI sin checkbox. Solicitudes vivas actualizadas:
  25 incluidas $0 + 21 vehiculares $150 + 4 visitas $150 = $3,750 por cobrar.
  Comunicado a vecinos vía módulo comunicados (RPC `crear_comunicado` con Telegram).
- **[2026-07-13] Cierre de sesión**: comunicado del cambio de precio/personalización enviado
  (app + 21 Telegram, id 4be51c88). Casa 130: el vecino no recordaba su correo — la cuenta
  existente es aris_abonce@hotmail.com (aprobada, un solo login 30-jun); invitación CAT-130
  restaurada (accepted_at=NULL, vence 22-ago) para que pueda registrarse de nuevo. La cuenta
  vieja se dejó activa por si es de un familiar — revisar/desactivar si queda huérfana.
  Casa 145 (2026-07-13, mismo caso): había cuenta existente (aprobada, un solo login 30-jun;
  correo en BD); invitación CAT-145 restaurada (accepted_at=NULL, vence 22-ago).
  Cuenta vieja activa — revisar si queda huérfana tras el nuevo registro.
  ⏳ Deploy EasyPanel pendiente con 909bece+c74444c (UI tarjetas).

## Sesión 2026-07-15 — Puerta peatonal desde la app: cámara en vivo + apertura remota ✅ (migr. 067)
- **Pedido (Juan)**: "¿pueden ver la cámara en tiempo real en Vecinity y abrir la puerta desde la app?"
- **Migr. 067** (`067_puerta_camara.sql`, aplicada en prod): `door_commands` (cola+bitácora,
  TTL 30s) + `camera_state` (singleton frame) + RPCs app (`door_open`, `door_status`,
  `camera_view` — gate `is_door_operator()`: admin/comite/guardia aprobados) + RPCs Orin
  token-gated (`bridge_fast_poll`, `door_mark`, `camera_push`).
- **Orin (nexia-access-bridge)**: `terminal.open_door()` (ISAPI RemoteControl XML) +
  `terminal.snapshot()` (JPEG→b64); `poller.py::_fast_loop` 24/7 cada 2s (1s con espectador).
  Cámara solo bombea si `watch_until > now()` — sin espectador, cero tráfico.
- **UI**: `src/app/_components/CamaraPuerta.tsx` en `/dashboard/comite` y `/vigilancia` —
  vista con badge EN VIVO (frame <10s), botón Abrir con confirmación de 2 pasos y feedback
  del comando; leyenda de auditoría.
- **QA**: residente rechazado por RPC ✓ · apertura real E2E `result=ok` en **2.7s** ✓ ·
  frame 97KB fresco a los 5s ✓ · TTL: comando vencido → `expirado`, jamás ejecutado ✓ ·
  smoke headless (guardia@cantera.test): login → card → frame EN VIVO en el navegador ✓ ·
  `npm run build` ✓.
- ⏳ Deploy EasyPanel pendiente (UI); la Orin ya corre el código nuevo en prod.

### Adenda 2026-07-15 (2) — Vecinos también abren la puerta (migr. 068) ✅
- Deploy EasyPanel de la mañana verificado en prod (smoke headless guardia: frame EN VIVO ✓).
- **Decisión Juan**: el vecino puede abrirle a su visita — el control es la AUDITORÍA, no el rol.
- Migr. 068 (aplicada en prod): `is_door_operator()` → cualquier perfil `aprobado`;
  nueva `door_log(p_limit)` (solo admin/comite/guardia) con nombre + casa + rol + resultado.
  La bitácora directa (SELECT door_commands) sigue vedada a residentes.
- UI: `CamaraPuerta` montada en `/dashboard/visitas` ("¿tu visita llega a pie? ábrele");
  prop `conBitacora` → lista "Últimas aperturas" en la card del comité (se refresca al abrir).
- QA: residente ve cámara y abre ✓ · residente NO lee bitácora (RPC rechaza) ✓ · comité ve
  door_log con atribución ✓ · smoke headless residente demo en /dashboard/visitas ✓ · build ✓.
- ⏳ Deploy EasyPanel pendiente (2º del día) para que los vecinos lo vean.

### Adenda 2026-07-15 (3) — Manuales por rol + hardening puerta (migr. 069) + rotación creds demo ✅
- **Manuales**: `docs/manual/` reestructurado — `Manual_de_Uso_Vecinity.md` ahora es índice;
  nuevos `MANUAL_VECINO.md`, `MANUAL_ADMINISTRADOR.md`, `MANUAL_VIGILANTE.md` (detallados,
  con todo lo de 2026-06/07: mi-cuenta+recibos, rostro peatonal, cámara/puerta, multas,
  conciliación persistente, credenciales, comunicados, calendario, RFID panel, SOS v2, Caty).
  Capturas nuevas 08/30-36 (`capture-manual-3.mjs`, solo cuentas demo casa 100 — sin PII;
  páginas del comité con datos reales van SOLO en texto).
- **Migr. 069** (aplicada): la puerta/cámara pertenece a UNA colonia — `camera_state.colonia_id`
  (Villa Catania) y todos los gates (`is_door_operator(p_device)`, door_open/camera_view/
  door_status/door_log/RLS) exigen perfil de esa colonia. `CamaraPuerta` se auto-oculta si
  la puerta no es de tu colonia. Cierra el hueco: perfiles de otras colonias (o demos
  futuras) ya no pueden ver/abrir la puerta física.
- **Seguridad**: passwords de `juanperez@cantera.test` y `guardia@cantera.test` ROTADOS
  (estaban publicados aquí) → viven en `.env.local` (`DEMO_VECINO_PASS`/`DEMO_GUARDIA_PASS`);
  scripts de captura los leen de env. Menciones viejas redactadas.
- **Gotcha corregido en sesión**: para el flip temporal de rol se tomó un profile con
  `LIMIT 1` que era una vecina real (se restauró de inmediato) — SIEMPRE resolver el id
  por EMAIL antes de mutar un perfil.
- ⏳ Deploy EasyPanel pendiente (build ✓): auto-ocultado de CamaraPuerta por colonia.

### Adenda 2026-07-15 (4) — Villa Aurora (DEMO) para ventas + Manual del Vendedor ✅
- **Villa ficticia** `Villa Aurora (DEMO)` (slug `villa-aurora-demo`, colonia
  `2a7c0627-f498-4745-9a84-438c13a969fd`) sembrada en prod con `scripts/seed_villa_demo.sql`
  (idempotente): 10 casas (D-01..D-10, saldos variados: D-03 morosa $3,200 > umbral $2,400,
  D-04 a favor), historial de movimientos, abono pendiente (D-02), solicitud de vecino
  pendiente (Sofía), 2 áreas (Alberca auto / Terraza $500+$500), 2 comunicados, invitación
  libre `AURORA-08`. Aislada por RLS; SIN dispositivo físico (069 impide ver/abrir la puerta
  real de Catania). Cuentas: vecino.demo@ / comite.demo@ / guardia.demo@ / solicitud.demo@
  `@vecinity.app` (metadata app='interno'; creds en MANUAL_VENDEDOR — solo datos ficticios).
  Smoke E2E en PROD: las 3 sesiones entran y ven Villa Aurora ✓.
- **MANUAL_VENDEDOR.md**: pitch por dolor (cobranza/seguridad/transparencia), guion de demo
  15 min en 3 actos (vecino→comité→caseta) con reseteo, paquete software+hardware con el
  socio instalador (tabla de quién pone qué), objeciones, qué NO prometer (sin pasarela,
  PWA no stores, no CCTV), checklist de levantamiento y cierre. Índice actualizado.
- Gotchas seed: `houses.estatus` es enum (`al_corriente|con_adeudo|en_convenio`);
  `comunicados.autor` CHECK solo `comite|caty`.

### Adenda 2026-07-15 (5) — Aviso de Privacidad con registro de aceptación (migr. 070) ✅
- **Pedido (Juan)**: aviso de privacidad integral (LFPDPPP) al entrar a la app en Villa
  Catania, con "aceptar ahora / aceptar después" y registro de aprobación.
- **Migr. 070** (aplicada): `privacy_notices` (por colonia, VERSIONADO, un activo por
  colonia — publicar v2 vuelve a pedir aceptación a todos) + `privacy_acceptances`
  (UNIQUE notice+profile) + RPCs `privacy_status()` / `privacy_accept()` /
  `privacy_report()` (avance para comité con nombre/casa/fecha). Aviso integral de
  Villa Catania sembrado (texto de Juan, verbatim) + aviso genérico en Villa Aurora demo.
- **UI**: `AvisoPrivacidad.tsx` (modal con markdown ligero; "Aceptar después" = solo
  sessionStorage, reaparece en la siguiente sesión — informa, no bloquea) montado en
  dashboard layout y /vigilancia; `AvisoPrivacidadAvance.tsx` (card X/Y + barra + lista)
  en el panel del comité.
- **QA**: status pendiente para usuario Catania ✓ / sin aviso para Aurora hasta sembrarlo ✓;
  E2E navegador: modal aparece → aceptar registra → recarga no reaparece ✓; report comité
  1/3 con Valeria ✓. GOTCHA: el primer accept tras la migración devolvió ok sin insertar
  (caché de PostgREST recién NOTIFY) — reintento inmediato funcionó; si pasa en prod,
  reintentar/verificar con privacy_report.
- ⏳ Deploy EasyPanel pendiente. Captura 37-aviso-privacidad.png en manuales.

### Cierre 2026-07-15 — Verificación en prod + fix ocultado de card por colonia ✅
- Smoke integral en PROD tras el 2º deploy: aviso aparece a quien no ha aceptado
  (comité demo y guardia Catania) ✓ · no reaparece a quien aceptó ✓ · card 📜 avance
  en panel comité ✓ · cámara Catania EN VIVO ✓.
- Gap detectado y corregido: `CamaraPuerta` colapsada se veía en colonias sin puerta —
  ahora consulta `is_door_operator()` AL MONTAR (RPC sin efectos, no activa el bombeo)
  y no pinta nada hasta confirmar; el error de camera_view queda de respaldo.
  Verificado local: oculta en Aurora ✓, visible y EN VIVO en Catania ✓.
- ⏳ Un deploy más de EasyPanel cuando convenga (cambio cosmético, sin prisa).

## Sesión 2026-07-18 — El pago de tarjeta también resuelve el banco (migr. 088) ✅
- **2º hueco de migr. 087 (Vibe Check Juan)**: el cobro de tarjetas de acceso corre en
  PARALELO al de mantenimiento (`card_requests.pago_estado`) y nunca tocaba `bank_movs`.
  Los depósitos $150/$300/$450/$600 (múltiplos de 150 **≤ $600**; la cuota de Catania es
  **$750**) quedaban como "ingresos por conciliar" en `/conciliacion` y — peor — el comité
  podía ligarlos por error a un abono de mantenimiento (**doble conteo**).
- **Dato clave (Juan)**: todo pago de tarjeta es múltiplo de $150 y proporcional a los
  carros de la casa → discriminador limpio contra la cuota de $750.
- **Migr. 088** (`088_conciliar_pago_tarjeta.sql`, aplicada en prod vía /pg/query):
  - `bank_movs.estado` += `'tarjeta'`; `card_requests.banco_hash` (liga; **NO único** →
    soporta bundle $300 = 2 tarjetas de la misma casa).
  - `_resolver_mov_tarjeta()` helper: marca la fila `tarjeta`; **guard** rechaza filas ya
    `conciliado`/`gasto` (anti doble conteo); idempotente para el bundle.
  - `validar_pago_tarjeta(…, p_banco_hash)` — aprueba el comprobante Y liga el banco.
  - `marcar_mov_tarjeta(hash, card?)` — desde /conciliacion; ligar = aprueba el pago.
  - `sugerir_banco_tarjeta(card)` — candidatos por monto exacto, prioriza casa en concepto,
    solo múltiplos ≤$600 (descarta la cuota $750).
- **UI ambas direcciones**:
  - `/conciliacion`: ingreso múltiplo 150 ≤$600 → botón **"🎫 pago de tarjeta"** (sale de la lista).
  - `/credenciales` "Comprobantes por validar": **"🔗 Buscar el depósito en el banco"** con
    radios de candidatos (badge "casa ✓"); "Pago recibido ✓" liga el elegido.
- **QA**: E2E en ROLLBACK simulando comité (JWT real): sugerir 15 candidatos ✓ · marcar →
  banco `tarjeta`+`resuelto_id`, tarjeta `aprobado`+ligada ✓ · bundle 2ª tarjeta al mismo
  depósito ✓ · guard bloquea fila `conciliado` ✓ · `npm run build` ✓.
- **Limpieza de campaña (mismo día, con OK de Juan)**:
  - (A) 34 depósitos de tarjeta pendientes ($7,200) → marcados `tarjeta`.
  - (B) 12 doble conteo ($3,600): dinero de tarjeta acreditado como mantenimiento a 12
    casas → abono de mantenimiento revertido (saldo restaurado) + fila del banco a `tarjeta`.
  - (C) 57 tarjetas aprobadas sin `banco_hash` ($8,550) = adicionales de pago (la 1ª
    vehicular por casa es gratis) aprobadas en campaña confiando en el comprobante, sin
    fijar la fila del banco. De aquí en adelante se ligan solas.
- Auto-deploy en push (no hay cola de EasyPanel en Vecinity).

### Adenda 2026-07-18 — Reversa de entrega firmada errónea (casa 130) ✅
- **Pedido (Juan)**: un vecino firmó una entrega que no era su casa → borrar el registro de
  entrega de casa 130. No hay RPC de reversa; corrección manual vía /pg/query (transacción).
- Un solo evento de entrega (firma "GMX-846-F", 2026-07-17 19:44) cubría **2 tarjetas
  vehiculares** de casa 130 (placas GMX-846-F / GMB-585-D, serials 14840470 / 14840476).
- **Reversa**: borrados los 2 `card_deliveries`; las 2 `card_requests` de vuelta a `impresa`
  (`delivered_at=NULL`) → reaparecen en "Por entregar" para re-firmar. **RFID conservado**
  (los serials son de casa 130; las tarjetas no se reimprimen — decisión de Juan).
- Cómo revertir una entrega firmada (para futuro): la entrega hace DELETE-inverso de
  (1) fila `card_deliveries`, (2) `card_requests.estado` entregada→impresa + delivered_at NULL,
  (3) opcional desligar `vehicles.tarjeta_rfid` + `rfid_tags` (aquí NO, se conservó).
