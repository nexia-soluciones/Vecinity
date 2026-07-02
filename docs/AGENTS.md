# AGENTS.md — Vecinity

> Plataforma de comunidad segura: administración de fraccionamiento + vigilancia vecinal.
> Migración del monolito Django (PythonAnywhere, SQLite) → arquitectura Nexia.
> Última actualización: 2026-07-02
>
> 🔎 **RETOMAR AQUÍ:** ver `REVISION_PENDIENTE.md` — paridad para lanzamiento (deploy ≠ cutover).
> El review E2E del 2026-06-27 (abajo) verificó BD + 13 rutas contra producción: **~82% al lanzamiento**.

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
  ⚠️ Sigue viva la cuenta demo `guardia@cantera.test`/`Guardia2026` (creds conocidas) — pendiente borrar.
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

## Pendientes (siguiente fase, post-deploy)
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
