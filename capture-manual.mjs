import { chromium } from "playwright";
import { mkdirSync } from "fs";

const BASE = "http://localhost:3100";
const OUT = "/Users/juangarces/dev/Vecinity/vecinity-app/docs/manual/screens";
mkdirSync(OUT, { recursive: true });

const VP = { width: 390, height: 844 };
const DSF = 2;

const browser = await chromium.launch();

async function shot(page, name, full = false) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
  console.log("✓", name);
}

// ---------- ONBOARDING (contexto desechable) ----------
{
  const ctx = await browser.newContext({ viewport: VP, deviceScaleFactor: DSF });
  const page = await ctx.newPage();

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await shot(page, "01-onboarding-invitacion");

  await page.getByPlaceholder("CÓDIGO DE INVITACIÓN").fill("DEMO-MANUAL");
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByText("Crea tu cuenta").waitFor({ timeout: 15000 });
  await page.getByPlaceholder("Nombre completo").fill("Laura Méndez");
  await page.getByPlaceholder("Correo electrónico").fill("demo.manual@cantera.test");
  await page.getByPlaceholder("Contraseña (mín. 6)").fill("demo123456");
  await page.getByPlaceholder("WhatsApp / Teléfono").fill("4611234567");
  await page.waitForTimeout(300);
  await shot(page, "02-onboarding-datos");

  await page.getByRole("button", { name: "Crear cuenta" }).click();
  await page.getByText("Conecta tus alertas").waitFor({ timeout: 20000 });
  await page.waitForTimeout(400);
  await shot(page, "03-onboarding-alertas");

  await page.getByText("Lo hago después").click();
  await page.getByText("Bienvenido a la comunidad").waitFor({ timeout: 10000 });
  await page.waitForTimeout(400);
  await shot(page, "04-onboarding-listo");
  await ctx.close();
}

// ---------- LOGIN + DASHBOARD COMITÉ ----------
{
  const ctx = await browser.newContext({ viewport: VP, deviceScaleFactor: DSF });
  const page = await ctx.newPage();
  await page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  await shot(page, "05-login");

  await page.getByPlaceholder("Correo electrónico").fill("comite@cantera.test");
  await page.getByPlaceholder("Contraseña").fill("Comite2026");
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL("**/dashboard", { timeout: 20000 });
  await page.getByText("Solicitudes pendientes").waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);
  await shot(page, "06-dashboard-comite", true);
  await ctx.close();
}

// ---------- PANTALLA DE ESPERA (usuario pendiente) ----------
{
  const ctx = await browser.newContext({ viewport: VP, deviceScaleFactor: DSF });
  const page = await ctx.newPage();
  await page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await page.getByPlaceholder("Correo electrónico").fill("juanperez@cantera.test");
  await page.getByPlaceholder("Contraseña").fill("Vecino2026");
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL("**/esperando", { timeout: 20000 });
  await page.waitForTimeout(1000);
  await shot(page, "07-esperando");
  await ctx.close();
}

await browser.close();
console.log("LISTO — capturas en", OUT);
