# Auditoría técnica de Vecinity — punto de partida para miFracc/OperIA

**Fecha:** 2026-08-28
**Repo auditado:** `github.com/HiramSpeed/operia-mifracc` (fork de `nexia-soluciones/Vecinity`)
**Alcance:** documentación interna, stack, esquema de base de datos, modelo de roles/permisos, y evaluación de multi-tenancy real, para decidir stack y diseñar el modelo de entitlements módulo → rol → funcionalidad.

## Resumen ejecutivo

Vecinity está mejor construido de lo que el brief inicial asumía: la base de datos **sí es multi-tenant desde el diseño** (cada tabla relevante cuelga de `colonia_id`, con RLS que aísla los datos por fraccionamiento). Ese es el cimiento correcto para miFracc.

Donde el sistema está en cero es en el otro eje que pediste: **no existe ningún sistema de módulos activables ni de permisos parametrizables.** Los roles son un ENUM fijo de Postgres, iguales para todos los fraccionamientos, y los permisos están repartidos como comparaciones de texto (`role === "admin"`) en más de diez archivos de frontend, más las políticas RLS correspondientes en SQL. Activar o desactivar una función hoy significa escribir código y migraciones, no cambiar una configuración.

En otras palabras: el problema no es la arquitectura de datos (ya resuelto, y bien resuelto), es que falta construir por completo la capa de entitlements (módulo → rol → funcionalidad) sobre la que insististe desde el principio.

## 1. Estado de la documentación interna

El repo trae documentación interna inusualmente completa para su tamaño:

- `AGENTS.md` (raíz) apunta a `docs/AGENTS.md`, una bitácora canónica de **1,878 líneas** con historial migración por migración, decisiones y QA realizado.
- `docs/REVISION_PENDIENTE.md` — estado de paridad de funciones frente al sistema legado (Django) que reemplaza, con una tabla de qué falta por rol.
- `DEPLOY.md` y `docs/DEPLOY_PARA_DANIEL.md` — proceso de deploy en EasyPanel/Docker.
- `docs/diagnostico-comunitario.md`, manual de usuario con capturas, scripts de captura E2E (`capture-*.mjs`).

Esto reduce mucho el riesgo de la reingeniería: hay trazabilidad de por qué se tomó cada decisión, no solo el código.

## 2. Stack tecnológico actual

- **Frontend/app:** Next.js 16.2.9 (App Router) + React 19 + TypeScript + Tailwind v4, como PWA.
- **Base de datos:** Supabase **self-hosted** (Postgres + PostgREST + Auth + Storage), schema dedicado `vecino`. Sin ORM — las migraciones son SQL crudo, aplicadas vía `POST /pg/query` con la service role key.
- **Automatización:** n8n + `pg_net` (triggers de Postgres que llaman webhooks directamente).
- **IA:** SDK de Anthropic (Claude) usado para visión — lectura de placas vehiculares y evidencia de multas —, reemplazó a Tesseract OCR por baja precisión en pruebas reales.
- **Notificaciones:** bot de Telegram propio.
- **Deploy:** Docker (build standalone) sobre EasyPanel en un VPS propio, no Vercel.
- **Testing:** no hay suite de pruebas automatizadas tipo Jest/Vitest; el QA se hace con scripts SQL en transacciones con `BEGIN/ROLLBACK` documentados en la bitácora, y con Playwright únicamente para generar capturas de pantalla manuales, no como test runner de CI.

Es un stack moderno y coherente (versiones actuales de Next/React, nada abandonado), pero con una ausencia notable de pruebas automatizadas — algo a considerar si el producto va a crecer a múltiples clientes.

## 3. Esquema de base de datos

- Schema `vecino`: **99 migraciones aplicadas**, ~49 tablas, **RLS activo en todas** (91+ políticas).
- Organizado en 12 grupos temáticos ya bautizados A–L: Núcleo, Finanzas, Multas, Vehículos/Visitantes+OCR, Seguridad vecinal, Comité+Votación, Mejoras, Operación, Comunidad, Notificaciones, Acceso RFID, Cámaras IP. Esta taxonomía, aunque no fue pensada como "módulos activables", es un punto de partida razonable para definir los límites de los módulos reales de miFracc.
- **`colonias` es la tabla raíz de tenant.** Prácticamente toda tabla de negocio (`houses`, `profiles`, `transactions`, `vehicles`, `incident_reports`, `sos_events`, etc.) tiene `colonia_id` y su RLS filtra por `vecino.my_colonia_id()` (función `SECURITY DEFINER`, sin recursión). Esto **sí es un aislamiento multi-tenant real**, no aspiracional.
- Ya hay parámetros configurables *por colonia* a nivel de datos (no de módulo): cuota mensual, día límite de pago, recargo, umbral de suspensión RFID, umbral de saldo para reservar, aforo por defecto, tope de multa, etc. — es decir, el patrón de "parámetro por fraccionamiento" ya existe para configuración de negocio, solo falta extenderlo a "qué módulos/funciones están prendidas".
- Estado de datos real en producción: **2 colonias, 119 casas** migradas desde el sistema Django legado — es decir, ya hay evidencia de que el modelo aguanta más de un tenant, aunque a escala pequeña (tu meta es 300+ casas por fraccionamiento y múltiples fraccionamientos simultáneos, que aún no se ha probado a esa escala).

## 4. Modelo de roles y permisos (el punto débil)

- El rol vive en un **ENUM global de Postgres**: `CREATE TYPE vecino.user_role AS ENUM ('admin','guardia','residente','capitan','comite')`. Los mismos 5 roles para todos los fraccionamientos, sin posibilidad de variar por cliente sin una migración de esquema.
- No existe ninguna tabla de tipo `roles`, `permissions`, `modules`, `feature_flags` ni similar. Cero infraestructura de entitlements.
- Los checks de permiso están **hardcodeados como comparaciones de string**, repetidos en al menos 10 archivos de frontend (`p.role === "admin" || p.role === "comite"` en `dashboard/page.tsx`, `comunicados/page.tsx`, `incidencias/page.tsx`, `vehiculos/page.tsx`, `credenciales/page.tsx`, `pagos/page.tsx`, `recibo-actions.ts`, etc.), y espejados del lado de la base de datos en funciones como `is_admin()` (que hoy cubre fijo a `admin` + `comite`) usadas dentro de las políticas RLS.
- Consecuencia directa: **apagar una función para un solo rol o un solo fraccionamiento hoy requiere tocar código y política RLS**, no es un toggle de configuración. Esto es exactamente lo opuesto al requisito de "ningún rol con funciones fijas y cerradas" que ya validaste en el spec funcional de Lombardía.

## 5. Multi-tenancy real: veredicto

Separando los dos ejes que pediste evaluar:

| Eje | Estado |
|---|---|
| Aislamiento de datos por fraccionamiento (un solo esquema de BD, RLS por `colonia_id`) | ✅ Ya resuelto y probado con datos reales |
| Parámetros de negocio configurables por fraccionamiento (cuotas, umbrales, tolerancias) | ✅ Ya existe el patrón, extensible |
| Módulos completos activables/desactivables por fraccionamiento | ❌ No existe — todo el código está siempre activo para todos |
| Roles parametrizables por fraccionamiento | ❌ No existe — ENUM fijo global |
| Funcionalidades activables/desactivables dentro de un rol | ❌ No existe — hardcodeado en frontend + RLS |

## 6. Sobre el sistema de billing/entitlements de Nexia (`nexia_billing`)

Vecinity ya tiene un gate pendiente mencionado en su propia documentación: `nexia_billing` (app_slug `vecino`), descrito como "follow-up cuando se defina el modelo de cobro a colonias" — es decir, nunca se conectó.

Revisé el repo `nexia-subscription`, que es la infraestructura de monetización compartida del ecosistema Nexia (conecta Lemon Squeezy con las apps vía n8n). Su modelo es una tabla plana `nexia_billing.nexia_subscriptions` de **(user_email, app_slug) → status/plan**, pensada para suscripciones individuales de apps de consumo (`nexia-pdca`, `nexia-scholar`, `nexia-facturacion`). **No tiene noción de tenant ni de módulo/rol/funcionalidad** — es un "¿este usuario tiene acceso a esta app, sí o no?", no un sistema de entitlements granular B2B.

Conclusión: no hay nada reutilizable ahí para el sistema de activación de tres niveles que describiste. El modelo de entitlements de miFracc se tiene que diseñar desde cero — aunque quizá se pueda reusar la plomería de pagos (Lemon Squeezy + n8n) como capa de facturación una vez que se defina qué se cobra.

## 7. Estado de madurez del producto (contexto para la decisión)

Por `docs/REVISION_PENDIENTE.md`: Vecinity está técnicamente desplegado pero **aún no lanzado** con el primer cliente (Villa Catania/La Cantera) — falta paridad de funciones frente al sistema Django que reemplaza, exigida por el reglamento del fraccionamiento. Esto importa para la decisión de stack: no es un sistema ya en producción con usuarios activos que se rompería con una reingeniería agresiva; es un sistema recién migrado y aún en fase de cierre de paridad con un solo cliente piloto.

## 8. Recomendación inicial (a validar contigo)

Con esto ya no llegamos a la primera sesión técnica en blanco — hay una hipótesis de trabajo:

1. **No hay razón técnica para tirar el stack.** Next.js 16 + React 19 + Supabase self-hosted + Postgres son piezas actuales, coherentes entre sí, y el modelo de aislamiento por `colonia_id` + RLS ya es el correcto para multi-tenant de un solo esquema — justo lo que pediste. Cambiar de stack aquí sería resolver un problema que no existe.
2. **El trabajo real de "arquitectura técnica de OperIA" es construir la capa de entitlements que hoy no existe:** tablas nuevas (`modules`, `role_definitions` o `permissions`, `colonia_module_activations`, y algo tipo `colonia_role_overrides` para el nivel de funcionalidad), reemplazar los checks hardcodeados de rol por una función/hook centralizado de autorización, y extender las políticas RLS para consultar esa nueva capa en vez de un rol fijo.
3. **La taxonomía de 12 módulos (A–L) que ya existe en las migraciones** es un punto de partida razonable — no definitivo — para decidir dónde trazar los límites de "módulo vendible" en miFracc.
4. **Riesgo a vigilar:** ausencia de pruebas automatizadas. Si vamos a tocar el modelo de permisos a fondo (que toca casi cada pantalla), conviene meter al menos una capa mínima de pruebas antes de tocarlo, para no romper en silencio el sistema que ya usa el primer cliente piloto.

Esto es una hipótesis para discutir contigo, no una decisión tomada — como acordamos, el stack y el modelo de entitlements se deciden después de este diagnóstico, contigo.

## Próximos pasos sugeridos

1. Confirmar o ajustar la recomendación del punto 8 contigo.
2. Si se confirma, diseñar el modelo de datos concreto de `modules → role_definitions → permissions` por `colonia_id` (siguiente sesión técnica).
3. Definir cómo migra el is_admin()/checks de rol actuales a la nueva capa sin romper el piloto de Villa Catania.
4. Retomar el nombre final del producto (miFracc sigue provisional).
