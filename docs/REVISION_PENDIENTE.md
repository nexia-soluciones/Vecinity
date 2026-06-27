# 🔎 Vecinity — Para revisar a detalle (próxima sesión)

> Estado al cierre del **2026-06-22**. Punto de retomada para la segunda revisión.

## ⭐ El tema central a revisar: DEPLOY ≠ LANZAMIENTO
El deploy técnico está listo, **pero no se puede lanzar (cutover) sin paridad de funciones**
con lo que los vecinos ya usan en el sistema viejo (Django). El **Art. 97 quater del reglamento**
hace la app **canal oficial obligatorio** para reservas/visitas/incidencias/adeudos, y liga los
servicios al **estatus de pago**. → La paridad es requisito de lanzamiento, no "extra".

## ✅ Lo que YA está hecho (no rehacer)
- Schema `vecino` (49 tablas, RLS) + **datos reales migrados** (119 casas, 285 vehículos, 2,427 tx, etc.)
- Onboarding + **login** + esperando + dashboard (saldo, SOS, aprobaciones del comité)
- Telegram (bot **Caty** @Caty_VCatania_bot) + enganche de chat + 3 notificaciones (SOS, saldo, pago vencido)
- Captura para diagnóstico comunitario (Presión vs. Resiliencia) instrumentada
- Deploy preparado: Dockerfile standalone, build verificado, repo en GitHub (`jjrmrcly79/Vecinity`), `DEPLOY.md` + `DEPLOY_PARA_DANIEL.md`
- Manual de uso con pantallas (`manual/`)

## 🚧 PARIDAD pendiente para poder lanzar (revisar prioridad y reglas)
| Rol | Función | Estado |
|---|---|---|
| Residente | **Reservar áreas comunes (con restricciones)** | ✅ — construido 2026-06-23 (ver AGENTS.md) |
| Residente | Registrar visita (QR/token) + WhatsApp | ✅ — registro + pase QR/WhatsApp + pase público `/visita/[token]` (2026-06-23). Falta: captura fotos INE/placas + entrada/salida → **fase vista vigilante** |
| Residente | Mis vehículos (alta/baja) | ✅ — alta (catálogo marcas/modelos) + baja + aprobación comité + RFID (2026-06-23) |
| Residente | Pagar / subir comprobante de abono | ✅ — abono + comprobante a Storage + aprobación comité (ajusta saldo/estatus) (2026-06-23) |
| Residente | Reportar incidencia (con foto) | ✅ — reporte (infractor por casa **o placa**) + evidencia a Storage + resolución comité con monto por reincidencia (2026-06-23) |
| Residente | Paquetes, propuestas/votos, marketplace, comunidad | ❌ |
| Vigilante | **Vista completa** (entrada/salida visitas, placas, paquetes, turnos, ciclo de llave de reservas, **servicios generales + recurrentes con foto**) | ✅ — `/vigilancia` (2026-06-23). **Caseta cerrada (2026-06-27):** ✅ registro manual de visita (walk-in) · ✅ fotos INE/placas · ✅ historial del día. Falta (post-lanzamiento): OCR placas, gafetes |
| Comité/Admin | Aprobar pagos/vehículos, resolver multas, generar cobros, gastos, finanzas | ⚠️ ✅ aprobar vecinos · ✅ vehículos · ✅ abonos · ✅ áreas/reservas · ✅ resolver incidencias · ✅ **Panel del comité** (pendientes+finanzas+morosos) · ✅ anti-duplicado de comprobante por hash. ✅ **generar cobros mensuales** + recargos · ✅ **convenios de pago (seguimiento semanal)**. Falta: conciliación bancaria CSV, gastos/dashboard de gastos, censo, export |

## 📋 Áreas comunes — reglas del reglamento (VALIDAR antes de construir)
Fuente: `Reglamento_Consolidado_Villa_Catania_2026.docx` (Anexos A y B).
- **Regla central:** solo reserva quien está **AL CORRIENTE** (Art. 67 + 97 quater) → gate por `houses.saldo`.
- 🏊 **Alberca:** horario 8:00–20:00 · máx **5 personas/casa** · gratis (llave en caseta, registro) · uso compartido.
- 🌅 **Terraza:** uso ordinario sin costo (L-J/Dom 8–23h, V-S 8–24h); **evento** = cuota **$3,000** + depósito **$3,000** (reintegrable si no hay daños), límite **22:00**, **aforo 25**, sin inflables.
- 🅿️ **Estac. visitas:** solo visitantes, **máx 24 h**, no permanente (Art. 20, 97 sexies).
- Multas: mal uso amenidades **$400**, mal uso estac. visitas **$300**.

### ❓ Preguntas abiertas → RESUELTAS (2026-06-23, implementadas)
1. Terraza $3,000 + $3,000 depósito ✅. "Con adeudo = no puede reservar" aplica a TODAS las áreas ✅ (gate `houses.saldo > colonias.umbral_reserva`, **tolerancia configurable por villa** desde `/dashboard/areas`, default 0). Solo Alberca y Terraza reservables; el comité puede **agregar más áreas** ✅.
2. Aprobación **automática si está dentro de rango** ✅ (`common_areas.aprobacion_automatica`; si una área futura se marca manual → cae en la bandeja del comité).
3. Orden de paridad confirmado: **áreas comunes ✅ → visitas/QR (siguiente) → vehículos → pagos → vista vigilante → resto**.

> Duración **por área** (config `duracion_min/max_horas`). Terraza = **evento completo** (toma toda el área, aforo 25). Alberca = **compartida** (no bloquea por solape).
> Pendiente de la fase **vista vigilante**: conectar el ciclo guardia (entrega/devolución de llave) que ya tiene campos en `reservations`.

## 🧹 Limpieza de datos pendiente
- **36/285 placas** son placeholder ('101', '101PENPLAC'…) — limpiar.
- Áreas comunes raras heredadas: "Escalera" (cap 1) y "Estacionamiento de Visitas" como reservable — depurar al construir (reservables reales: Alberca y Terraza).

## 🔭 Backlog post-lanzamiento (no bloquea)
- OCR de placas con **modelo de visión (Claude)** — NO Tesseract (probado: falla en placas reales) + vista vigilante.
- **Caty + reglamento** (RAG): Q&A del reglamento en el bot.
- **Índice de salud comunitaria** (Presión vs. Resiliencia) — ya hay captura, falta tendencia/tablero.
- Auth/billing `nexia_billing` (app_slug `vecino`) cuando se defina cobro a colonias.

## 🌐 Opción de URL pública para pruebas (sin crear app nueva)
`vecinovigilante.nexiasoluciones.com.mx` **sigue vivo** en EasyPanel (sirve el prototipo viejo React/Vite,
ya muerto en datos porque vaciamos su schema). Se puede **reusar ese slot**: Daniel repunta esa app
al repo `jjrmrcly79/Vecinity` (build Dockerfile, puerto 3000, Build Args + Env) → reutiliza dominio+TLS,
una sola reconfiguración. Para "solo probar" NO hace falta deploy: **local ya pega a la BD real**.
Ajustar `NEXT_PUBLIC_APP_URL` si se usa ese dominio. Pre-lanzamiento OK (pega a prod).

## 🔑 Datos útiles para retomar
- App local: `cd ~/dev/Vecinity/vecinity-app && PORT=3100 npm run dev`
- Login comité demo: `comite@cantera.test` / `Comite2026` · invitación demo: `CAT-128`
- Repo: github.com/jjrmrcly79/Vecinity · n8n: workflows `Vecinity - Telegram (Caty)` y `Vecinity - Cobros vencidos (diario)`
- Secretos en `vecinity-app/.env.local` (gitignored). DDL vía `curl /pg/query` con SERVICE_ROLE (keys en NexIA_Tienda/.env.local).
