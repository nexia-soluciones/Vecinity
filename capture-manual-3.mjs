// Capturas para el manual v2 (2026-07-15): nuevas secciones.
// PII: solo datos de las cuentas demo (casa 100) o elementos sin datos de
// vecinos reales. Las páginas del comité con datos reales NO se capturan.
import { chromium } from "playwright";
import { mkdirSync } from "fs";
// Passwords demo: exportar DEMO_VECINO_PASS/DEMO_GUARDIA_PASS desde .env.local

const BASE = "http://localhost:3100";
const OUT = "/Users/juangarces/dev/Vecinity/vecinity-app/docs/manual/screens";
mkdirSync(OUT, { recursive: true });

const VP = { width: 390, height: 844 };
const DSF = 2;
const browser = await chromium.launch();

async function login(email, pass) {
  const ctx = await browser.newContext({ viewport: VP, deviceScaleFactor: DSF });
  const page = await ctx.newPage();
  await page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await page.getByPlaceholder("Correo electrónico").fill(email);
  await page.getByPlaceholder("Contraseña").fill(pass);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForFunction(() => location.pathname !== "/login", { timeout: 25000 });
  return { ctx, page };
}

async function shot(page, name, full = false) {
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
  console.log("✓", name);
}

async function abrirCamara(page) {
  await page.getByRole("button", { name: /Puerta peatonal/ }).click();
  // Espera frame EN VIVO (la Orin bombea al primer camera_view)
  await page.waitForFunction(
    () => document.body.innerText.includes("EN VIVO"),
    { timeout: 30000 },
  );
}

// ───────── RESIDENTE (juanperez demo, casa 100) ─────────
{
  const { ctx, page } = await login("juanperez@cantera.test", process.env.DEMO_VECINO_PASS);

  await page.goto(BASE + "/dashboard", { waitUntil: "networkidle" });
  await shot(page, "08-dashboard-residente");

  await page.goto(BASE + "/dashboard/mi-cuenta", { waitUntil: "networkidle" });
  await shot(page, "30-mi-cuenta");
  const rostro = page.locator("section", { hasText: "reconocimiento de rostro" }).last();
  await rostro.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(400);
  await rostro.screenshot({ path: `${OUT}/31-mi-cuenta-rostro.png` }).catch(() => console.log("… 31 omitida"));
  console.log("✓ 31-mi-cuenta-rostro");

  await page.goto(BASE + "/dashboard/visitas", { waitUntil: "networkidle" });
  await abrirCamara(page);
  const cardV = page.locator("section", { hasText: "Puerta peatonal" }).first();
  await cardV.screenshot({ path: `${OUT}/32-visitas-camara.png` });
  console.log("✓ 32-visitas-camara");

  await page.goto(BASE + "/dashboard/comunicados", { waitUntil: "networkidle" });
  await shot(page, "33-comunicados");

  await page.goto(BASE + "/dashboard/reservas/calendario", { waitUntil: "networkidle" });
  await shot(page, "34-calendario-reservas");

  await ctx.close();
}

// ───────── GUARDIA (demo) ─────────
{
  const { ctx, page } = await login("guardia@cantera.test", process.env.DEMO_GUARDIA_PASS);
  await page.goto(BASE + "/vigilancia", { waitUntil: "networkidle" });
  await abrirCamara(page);
  const cardG = page.locator("section", { hasText: "Puerta peatonal" }).first();
  await cardG.screenshot({ path: `${OUT}/35-vigilancia-camara.png` });
  console.log("✓ 35-vigilancia-camara");
  await ctx.close();
}

await browser.close();
console.log("LISTO");
