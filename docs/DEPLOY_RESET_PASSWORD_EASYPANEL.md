# Deploy — Recuperación de contraseña (EasyPanel)

> Para: **Daniel** · De: Juan (+ agente) · Fecha: 2026-07-06
> Contexto: se agregó recuperación de contraseña a Vecinity (canal email + bot Caty).
> El código ya está en `main` (commit `e6136b4`) y Caty ya está en vivo.
> Faltan **2 pasos en EasyPanel** que solo se pueden hacer manualmente.

---

## Resumen

| Paso | Qué | Afecta | Urgencia |
|------|-----|--------|----------|
| 1 | Redeploy del frontend `vecinity-app` | Solo Vecinity | Necesario para ver las pantallas nuevas |
| 2 | Allow-list de redirects en GoTrue (Supabase) | **Todas las apps** | Necesario solo para el canal **email** |

> ⚠️ El canal **Caty (Telegram) ya funciona** sin ninguno de estos pasos. El paso 2
> solo desbloquea el reset por **correo** (y de paso lo habilita para scholar y pdca).

---

## Paso 1 — Redeploy del frontend

1. EasyPanel → proyecto **vecinity-app** (el servicio Next.js).
2. **Deploy / Redeploy** (build desde `main`, ya tiene el commit `e6136b4`).
3. Esperar a que termine el build.

**Verificar:** abrir `https://vecinity.nexiasoluciones.com.mx/recuperar` → debe cargar la
pantalla "¿Olvidaste tu contraseña?". En `/login` debe aparecer el link "¿Olvidaste tu contraseña?".

---

## Paso 2 — Allow-list de redirects en GoTrue

**Por qué:** el `SITE_URL` de GoTrue está en el dominio de Supabase (valor por defecto de
Docker). Si no se agrega el dominio de la app al allow-list, GoTrue **sobrescribe** el
`redirect_to` del correo de recuperación → el enlace aterriza en el dominio de Supabase en
vez de en la app y el reset por email queda roto. (Es la deuda "Configurar SITE_URL" de NEXIA-OS.)

### Qué cambiar

1. EasyPanel → servicio **Supabase** (el contenedor de **auth / gotrue**) → pestaña **Environment**.
2. Agregar (o editar) la variable de entorno:

   **Opción A — si el env usa el estilo `.env` de Supabase:**
   ```
   ADDITIONAL_REDIRECT_URLS=https://vecinity.nexiasoluciones.com.mx/**,https://scholar.nexiasoluciones.com.mx/**,https://pdca.nexiasoluciones.com.mx/**
   ```

   **Opción B — si el env expone las variables `GOTRUE_*` directas:**
   ```
   GOTRUE_URI_ALLOW_LIST=https://vecinity.nexiasoluciones.com.mx/**,https://scholar.nexiasoluciones.com.mx/**,https://pdca.nexiasoluciones.com.mx/**
   ```

   > Usar la que ya exista en la config. En el `docker-compose` estándar de Supabase,
   > `GOTRUE_URI_ALLOW_LIST` se alimenta de `ADDITIONAL_REDIRECT_URLS`.
   > El comodín `/**` permite cualquier ruta de esos dominios.
   > Si ya hay valores en la variable, **no los borres** — agrega estos separados por coma.

3. **Redeploy / restart** del servicio Supabase (auth) para que tome la env.

> ⏱️ El restart del contenedor auth interrumpe el **login de todas las apps** por unos
> segundos. Hacerlo en un momento de bajo tráfico. No hay pérdida de datos.

### Cómo verificar (avísale a Juan/agente y lo confirma en segundos)

Regenerar un enlace de recuperación y confirmar que el `redirect_to` ya **no** se sobrescribe:

```bash
curl -s -X POST "https://supabase.nexiasoluciones.com.mx/auth/v1/admin/generate_link" \
  -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  --data-binary '{"type":"recovery","email":"prueba@vecinity.test","redirect_to":"https://vecinity.nexiasoluciones.com.mx/reset-password"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["action_link"])'
```

- ✅ **Bien:** el `action_link` termina en `redirect_to=https://vecinity.nexiasoluciones.com.mx/reset-password`
- ❌ **Mal (aún sin efecto):** `redirect_to=https://supabase.nexiasoluciones.com.mx`

---

## Prueba end-to-end (después de ambos pasos)

1. `https://vecinity.nexiasoluciones.com.mx/recuperar` → escribir un correo real registrado → "Enviar enlace".
2. Llega correo de recuperación (revisar spam). Clic en el enlace → debe abrir `/reset-password` en la app.
3. Escribir nueva contraseña (mín. 8) → "Guardar" → redirige a `/login` con aviso.
4. Entrar con la contraseña nueva.

**Canal Caty (ya activo, opcional probar):** en Telegram con Caty → menú → 🔐 Cambiar mi
contraseña → llega el enlace → abre `/reset-password` → cambiar → entrar.

---

## Nota — scholar y pdca

El allow-list del Paso 2 ya incluye `scholar` y `pdca`, así que el reset por email queda
**habilitado a nivel infra** para esas apps también. Falta implementar las pantallas
`/recuperar` + `/reset-password` en cada una (mismo patrón que Vecinity) cuando se decida.
