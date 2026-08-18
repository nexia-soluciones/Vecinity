# Workflow "Vecinity - Pagos recurrentes (diario)"

Avisa al comité por Telegram de los servicios recurrentes (luz, agua, Telmex, basura,
vigilancia, alberca, contabilidad, jardinería, limpieza) que **no tienen cargo en el
banco** cuando ya deberían tenerlo. La señal es el cargo bancario, **no el recibo**:
de 156 gastos registrados ninguno tiene recibo adjunto, pero el estado de cuenta se
sube cada 3-4 días.

## Qué hace
`scheduleTrigger` diario 9:00 (America/Mexico_City) → `POST /rest/v1/rpc/cron_pagos_recurrentes`
con la **anon key** y el token del cron (`vcn_cron_7Kp2qXm9`, el mismo patrón que
`cron_generar_cobros`). Toda la lógica vive en la BD (migr. 094); el workflow solo dispara.

## Alta en n8n
1. Importar este JSON (Workflows → Import from file).
2. Definir `VECINITY_ANON_KEY` en el entorno de n8n, o pegar la anon key en los dos headers.
3. **Activarlo a mano** con el toggle — el MCP/API no puede activar workflows.

## Probar sin mandar nada
Cambiar `p_dry` a `true` en el body: calcula, **no escribe absolutamente nada** y devuelve
`{pagos_en_alerta: N, mensajes: [...]}` con los avisos tal cual saldrían, para revisar la
redacción antes de que le lleguen al comité.

## Anti-spam
Un aviso por vencimiento (`recurring_bill_events`), con recordatorio cada 7 días mientras
siga abierto. Si el comité marca "ya se pagó fuera del banco", ese vencimiento deja de avisar.
