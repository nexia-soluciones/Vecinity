// Capturas de las funciones nuevas (23-jun) para el manual de usuario.
// Deja intactas las 7 capturas de onboarding/login del capture-manual.mjs.
// Usa cuentas demo (colonia La Cantera). Limpia sus datos con cleanup-demo.mjs.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "fs";

const BASE = "http://localhost:3100";
const OUT = "/Users/juangarces/dev/Vecinity/vecinity-app/docs/manual/screens";
mkdirSync(OUT, { recursive: true });

const VP = { width: 390, height: 844 };
const DSF = 2;
const browser = await chromium.launch();

async function shot(page, name, full = true) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
  console.log("✓", name);
}

async function login(page, email, pass) {
  await page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await page.getByPlaceholder("Correo electrónico").fill(email);
  await page.getByPlaceholder("Contraseña").fill(pass);
  await page.getByRole("button", { name: "Entrar" }).click();
}

let publicToken = null;

// ---------- RESIDENTE (juanperez) ----------
{
  const ctx = await browser.newContext({ viewport: VP, deviceScaleFactor: DSF });
  const page = await ctx.newPage();
  await login(page, "juanperez@cantera.test", "Vecino2026");
  await page.waitForURL("**/dashboard", { timeout: 20000 });
  await page.getByText("Botón de pánico").waitFor({ timeout: 15000 });
  await page.waitForTimeout(700);
  await shot(page, "08-dashboard-residente");

  // Reservas
  await page.goto(BASE + "/dashboard/reservas", { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await shot(page, "09-reservas");

  // Vehículos — crea uno demo (queda pendiente para la cola del comité)
  await page.goto(BASE + "/dashboard/vehiculos", { waitUntil: "networkidle" });
  await page.getByText("Mis vehículos").first().waitFor({ timeout: 15000 });
  await page.getByPlaceholder("ABC-123-D").fill("DEMO01A");
  await page.getByPlaceholder("Gris").fill("Azul");
  await page.getByRole("button", { name: "Agregar vehículo" }).click();
  await page.waitForTimeout(1500);
  await shot(page, "13-vehiculos");

  // Visitas — genera pase y captura el QR
  await page.goto(BASE + "/dashboard/visitas", { waitUntil: "networkidle" });
  await page.getByPlaceholder("Ej. María López").fill("María López");
  await page.getByRole("button", { name: "Generar pase de visita" }).click();
  await page.locator('img[alt="QR del pase"]').waitFor({ timeout: 15000 });
  await page.waitForTimeout(600);
  await shot(page, "11-visita-qr", false);
  const urlText = (await page.locator("p.break-all").first().textContent()) || "";
  publicToken = urlText.trim().split("/visita/")[1] || null;
  // cerrar modal y capturar lista
  await page.getByRole("button", { name: "Cerrar" }).click();
  await page.waitForTimeout(500);
  await shot(page, "10-visitas");

  // Pagos
  await page.goto(BASE + "/dashboard/pagos", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await shot(page, "14-pagos");

  // Incidencias
  await page.goto(BASE + "/dashboard/incidencias", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await shot(page, "15-incidencias");

  await ctx.close();
}

// ---------- PASE PÚBLICO (sin login) ----------
if (publicToken) {
  const ctx = await browser.newContext({ viewport: VP, deviceScaleFactor: DSF });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/visita/${publicToken}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await shot(page, "12-visita-publica");
  await ctx.close();
  writeFileSync(`${OUT}/.demo-token`, publicToken);
  console.log("token público:", publicToken);
} else {
  console.log("⚠ No se obtuvo token público");
}

// ---------- COMITÉ ----------
{
  const ctx = await browser.newContext({ viewport: VP, deviceScaleFactor: DSF });
  const page = await ctx.newPage();
  await login(page, "comite@cantera.test", "Comite2026");
  await page.waitForURL("**/dashboard", { timeout: 20000 });
  await page.waitForTimeout(800);

  await page.goto(BASE + "/dashboard/comite", { waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  await shot(page, "16-comite-panel");

  await page.goto(BASE + "/dashboard/areas", { waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  await shot(page, "17-areas");
  await ctx.close();
}

// ---------- VIGILANTE (guardia) ----------
{
  const ctx = await browser.newContext({ viewport: VP, deviceScaleFactor: DSF });
  const page = await ctx.newPage();
  await login(page, "guardia@cantera.test", "Guardia2026");
  await page.waitForURL("**/vigilancia", { timeout: 20000 });
  await page.waitForTimeout(1800);
  await shot(page, "18-vigilancia");
  await ctx.close();
}

await browser.close();
console.log("LISTO — capturas en", OUT);
