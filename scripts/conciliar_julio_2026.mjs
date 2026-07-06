/**
 * Conciliación del estado de cuenta de julio 2026 — espejo EXACTO de
 * src/app/dashboard/conciliacion/page.tsx (mismo xlsx, mismo hash, misma
 * extracción de casa) para garantizar dedup idéntico (banco_hash) y NO duplicar.
 *
 * Uso:
 *   node scripts/conciliar_julio_2026.mjs            # dry-run (no escribe)
 *   node scripts/conciliar_julio_2026.mjs --apply    # ejecuta las RPCs
 *
 * Escribe llamando a las MISMAS RPCs que la página, impersonando al comité
 * (set_config request.jwt.claims) vía /pg/query. Todo deduplica por banco_hash.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import XLSX from "xlsx";

const XLSX_PATH = "/Users/juangarces/Downloads/Julio_2026.xlsx";
const COLONIA = "ce43b59c-529b-4960-8dd7-d975e43ac2fb";
const COMITE_UID = "69230445-3145-42b9-a331-bf86b1342bc3"; // Juan Garcés, casa 128, comité
const DESDE = "2026-07-01";
const BASE = "https://supabase.nexiasoluciones.com.mx/pg/query";
const APPLY = process.argv.includes("--apply");

const KEY = fs
  .readFileSync("/Users/juangarces/dev/Vecinity/vecinity-app/.env.local", "utf8")
  .split("\n")
  .find((l) => l.startsWith("SUPABASE_SERVICE_ROLE_KEY"))
  .split("=")
  .slice(1)
  .join("=")
  .trim();

async function pg(query) {
  const res = await fetch(BASE, {
    method: "POST",
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  const txt = await res.text();
  let json;
  try {
    json = JSON.parse(txt || "[]");
  } catch {
    throw new Error("Respuesta no-JSON: " + txt.slice(0, 300));
  }
  if (json && json.error) throw new Error("PG: " + JSON.stringify(json.error));
  return json;
}
const esc = (s) => String(s).replace(/'/g, "''");
const CLAIMS = `{"sub":"${COMITE_UID}","role":"authenticated"}`;
// Ejecuta una expresión que devuelve jsonb como el comité (impersonación)
async function rpc(expr) {
  const q = `SELECT ${expr} AS res FROM (SELECT set_config('request.jwt.claims', '${CLAIMS}', true)) _s`;
  const r = await pg(q);
  return r[0]?.res ?? null;
}

// ---- helpers COPIADOS de la página (deben ser idénticos) --------------------
const normRef = (s) => s.toUpperCase().replace(/\s+/g, " ").trim();
function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}
const fmtFecha = (v) => {
  if (v instanceof Date)
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(
      v.getDate()
    ).padStart(2, "0")}`;
  return String(v ?? "").slice(0, 10);
};
const toNum = (v) => {
  if (typeof v === "number") return v;
  const n = parseFloat(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return isNaN(n) ? 0 : n;
};
function extraerCasa(concepto, casasSet) {
  const limpio = String(concepto || "")
    .toUpperCase()
    .replace(/\d{4,}/g, " ");
  const valida = (n) => {
    const k = String(parseInt(n, 10));
    return casasSet.has(k) ? k : null;
  };
  const m = limpio.match(/\bCASA\s*(\d{1,3})\b/) || limpio.match(/\bC\s*(\d{1,3})\b/);
  if (m) {
    const k = valida(m[1]);
    if (k) return { casa: k, conf: "alta" };
  }
  let last = null;
  for (const n of limpio.match(/\b\d{1,3}\b/g) || []) {
    const k = valida(n);
    if (k) last = k;
  }
  if (last) return { casa: last, conf: "media" };
  return { casa: null, conf: null };
}

// ---- 1. Cargar mapas de BD --------------------------------------------------
const casasRows = await pg(
  `SELECT numero, id::text FROM vecino.houses WHERE colonia_id='${COLONIA}'`
);
const casas = {}; // numero -> id
for (const h of casasRows) casas[String(h.numero)] = h.id;
const casasSet = new Set(Object.keys(casas));

const txHashes = new Set(
  (await pg(
    `SELECT banco_hash FROM vecino.transactions WHERE colonia_id='${COLONIA}' AND banco_hash IS NOT NULL`
  )).map((r) => r.banco_hash)
);

// Abonos de julio YA registrados (para reconciliar por casa + clave, no solo por hash)
const abonosDB = await pg(
  `SELECT h.numero AS casa, t.monto::numeric AS monto, t.estado, t.ref_rastreo AS ref
   FROM vecino.transactions t JOIN vecino.houses h ON h.id=t.house_id
   WHERE t.colonia_id='${COLONIA}' AND t.tipo='abono'
     AND t.created_at >= '2026-07-01' AND t.estado IN ('aprobado','pendiente')`
);
const casasConJulio = new Set(abonosDB.map((a) => String(a.casa))); // casa ya tiene abono de julio
const refsPend = abonosDB
  .filter((a) => a.ref && String(a.ref).length >= 5)
  .map((a) => ({ casa: String(a.casa), ref: String(a.ref).toUpperCase(), monto: Number(a.monto) }));
const gastoHashes = new Set(
  (await pg(
    `SELECT banco_hash FROM vecino.colonia_expenses WHERE colonia_id='${COLONIA}' AND banco_hash IS NOT NULL`
  )).map((r) => r.banco_hash)
);

// ---- 2. Leer Excel exactamente como la página -------------------------------
const wb = XLSX.read(fs.readFileSync(XLSX_PATH), { cellDates: true });
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });

let hi = -1;
for (let i = 0; i < Math.min(rows.length, 30); i++) {
  const cells = (rows[i] || []).map((c) => String(c ?? "").toLowerCase());
  if (
    cells.some((c) => c.includes("abono")) &&
    cells.some((c) => c.includes("cargo") || c.includes("concepto") || c.includes("referencia"))
  ) {
    hi = i;
    break;
  }
}
if (hi < 0) throw new Error("No encontré la fila de encabezado del banco.");
const head = rows[hi].map((c) => String(c ?? "").toLowerCase());
const col = (...names) => head.findIndex((h) => names.some((n) => h.includes(n)));
// "Día" a veces llega como mojibake ("DÃ­a") → col() falla; la fecha es la col 0.
let iFecha = col("día", "dia", "fecha", "dã­a");
if (iFecha < 0) iFecha = 0;
const iConcepto = col("concepto", "referencia");
const iAbono = col("abono");
const iCargo = col("cargo");
const iSaldo = col("saldo");

const abonos = [];
const gastos = [];
let saltPorFecha = 0;
for (let i = hi + 1; i < rows.length; i++) {
  const r = rows[i];
  if (!r || r.length === 0) continue;
  const monto = toNum(r[iAbono]);
  const cargo = iCargo >= 0 ? toNum(r[iCargo]) : 0;
  if (monto <= 0 && cargo <= 0) continue;
  const concepto = String(r[iConcepto] ?? "").trim();
  const fecha = fmtFecha(r[iFecha]);
  if (DESDE && fecha && fecha < DESDE) {
    saltPorFecha++;
    continue;
  }
  const saldo = iSaldo >= 0 ? toNum(r[iSaldo]) : 0;
  if (cargo > 0) {
    const hash = sha256(`${fecha}|${cargo}|${concepto}|${saldo}`);
    gastos.push({ fecha, concepto, monto: cargo, hash, dup: gastoHashes.has(hash) });
  } else {
    const refKey = normRef(concepto);
    const hash = sha256(`${fecha}|${monto}|${concepto}|${saldo}`);
    const ext = extraerCasa(concepto, casasSet);
    abonos.push({ fecha, concepto, monto, refKey, hash, ...ext, dup: txHashes.has(hash) });
  }
}

// ---- 3. Reporte -------------------------------------------------------------
const gNuevos = gastos.filter((g) => !g.dup);
const aNuevos = abonos.filter((a) => !a.dup);
console.log(`\n=== JULIO 2026 · ${APPLY ? "APLICAR" : "DRY-RUN"} ===`);
console.log(`Movimientos ≥ ${DESDE}: ${gastos.length} cargos · ${abonos.length} abonos (${saltPorFecha} anteriores ignorados)`);
console.log(`\nCARGOS (gastos): ${gNuevos.length} nuevos · ${gastos.length - gNuevos.length} ya importados`);
for (const g of gNuevos) console.log(`  +$${g.monto}  ${g.fecha}  ${g.concepto.slice(0, 60)}`);
console.log(`\nABONOS (banco): ${abonos.length} · ${aNuevos.length} con hash nuevo`);
// Reconciliación por IDENTIDAD ECONÓMICA (casa/clave), no por hash:
const matchRef = (a) => refsPend.find((p) => a.refKey.includes(p.ref)); // clave del vecino dentro del concepto
const faltantes = [];
for (const a of abonos) {
  const rm = matchRef(a);
  const casaAlta = a.conf === "alta" ? a.casa : null;
  const yaPorClave = !!rm;
  const yaPorCasa = casaAlta && casasConJulio.has(casaAlta);
  a._estado = a.dup
    ? "hash-dup"
    : yaPorClave
    ? `ya (clave→casa ${rm.casa})`
    : yaPorCasa
    ? `ya (casa ${casaAlta} tiene julio)`
    : casaAlta
    ? "FALTA (casa alta)"
    : "revisar (casa incierta)";
  if (a._estado === "FALTA (casa alta)") faltantes.push(a);
}
const cuenta = (s) => abonos.filter((a) => a._estado.startsWith(s)).length;
console.log(`  ya registrados por clave de rastreo: ${abonos.filter((a) => a._estado.startsWith("ya (clave")).length}`);
console.log(`  ya registrados (casa ya pagó julio): ${abonos.filter((a) => a._estado.startsWith("ya (casa")).length}`);
console.log(`  hash duplicado exacto:               ${cuenta("hash-dup")}`);
console.log(`  ⚠️ FALTANTES (casa segura, sin registro): ${faltantes.length}`);
console.log(`  a revisar (casa incierta):           ${cuenta("revisar")}`);
console.log("\n  --- detalle ---");
for (const a of abonos)
  console.log(`  $${String(a.monto).padStart(5)}  [${(a.conf ?? "—").padEnd(5)}:${(a.casa ?? "?").padStart(3)}]  ${a._estado.padEnd(26)}  ${a.concepto.slice(0, 42)}`);
if (faltantes.length) {
  console.log("\n  ⚠️ POSIBLES FALTANTES (revisar antes de agregar):");
  for (const a of faltantes) console.log(`     casa ${a.casa}  $${a.monto}  ${a.fecha}  ${a.concepto.slice(0, 50)}`);
}
const revisar = abonos.filter((a) => a._estado.startsWith("revisar"));
if (revisar.length) {
  console.log(`\n  === ${revisar.length} INCIERTAS (concepto completo) ===`);
  revisar.forEach((a, i) =>
    console.log(`  ${String(i + 1).padStart(2)}. ${a.fecha}  $${a.monto}  «${a.concepto}»  (lectura: ${a.conf ?? "sin casa"}${a.casa ? " " + a.casa : ""})`)
  );
}

if (!APPLY) {
  console.log("\n(dry-run — nada se escribió. Corre con --apply para ejecutar.)");
  process.exit(0);
}

// ---- 4. APLICAR — SOLO las faltantes con casa segura (no tocar el resto) -----
// Gastos: los 10 ya están importados → nada que hacer.
// Abonos: solo los 3 marcados "FALTA (casa alta)". conciliar_abono trae candado
// anti-dup + dedup por hash, así que es seguro aunque se re-corra.
console.log(`\n--- Agregando ${faltantes.length} abonos faltantes (casa segura) ---`);
let ok = 0, dup = 0, err = 0;
for (const a of faltantes) {
  const casaId = casas[a.casa];
  if (!casaId) { err++; console.log(`  ✗ casa ${a.casa} inexistente`); continue; }
  const fechaArg = a.fecha ? `'${a.fecha}'::date` : "NULL";
  try {
    const cb = await rpc(
      `vecino.conciliar_abono('${casaId}'::uuid, ${a.monto}, '${esc(`Pago banco ${a.fecha} · ${a.concepto}`.slice(0, 200))}'::text, '${a.hash}', '${esc(a.refKey)}', ${fechaArg})`
    );
    if (cb?.dup) { dup++; console.log(`  = casa ${a.casa} $${a.monto} ya estaba (dup)`); }
    else { ok++; console.log(`  ✓ casa ${a.casa}  $${a.monto}  (${cb?.linked ? "enlazado a comprobante" : "creado y aprobado"})`); }
  } catch (e) { err++; console.log(`  ✗ casa ${a.casa} $${a.monto} — ${e.message}`); }
}
console.log(`\nFaltantes: ${ok} agregados · ${dup} ya estaban · ${err} error`);
console.log("Los 10 cargos ya estaban importados. Las 16 inciertas quedan para revisión manual.");
