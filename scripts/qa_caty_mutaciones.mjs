// qa_caty_mutaciones.mjs — un arnés que no muerde se lee igual que uno que pasa.
//
// Muta el archivo REAL (no una copia: con una copia el arnés revisaría otra
// cosa), corre qa_caty_bot.mjs y exige ROJO. Distingue ROJO de ABORTÓ por
// código de salida: una mutación que rompe la sintaxis prueba que rompí el
// archivo, no que el guard sirve. Y verifica que el ancla empate EXACTAMENTE
// una vez — un ancla que empata 0 veces se lee idéntico a "no muerde".
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const RUTA = new URL('../n8n/caty_bot.js', import.meta.url);
const ARNES = new URL('./qa_caty_bot.mjs', import.meta.url).pathname;
const ORIGINAL = readFileSync(RUTA, 'utf8');

const MUTACIONES = [
  { nombre: 'quitar el respaldo: vuelve a enseñar el status crudo de axios',
    de: "      m = 'No pude completar esa acción ahorita. Inténtalo de nuevo en un momento.';",
    a:  "      m = String(e.message || '');",
    esperado: 'rojo' },
  { nombre: 'dejar de mirar response.data (el bug original)',
    de: '    e.response && e.response.data,\n',
    a:  '', esperado: 'rojo' },
  { nombre: 'quitar el último recurso (JSON incrustado en el message)',
    de: "  const m = String(e.message || '').match(/\\{[\\s\\S]*\\}/);",
    a:  '  const m = null;', esperado: 'rojo' },
  { nombre: 'volver a mentir: "expiró" en vez de decir de quién es el teléfono',
    de: "'Este Telegram ya está conectado a la cuenta de *'",
    a:  "'Tu enlace no es válido o expiró.*'", esperado: 'rojo' },
  { nombre: 'no canjear el token nuevo',
    de: "rpcSafe('telegram_link_consumir'", a: "rpcSafe('bot_perfil_x'", esperado: 'rojo' },
  // Control: un cambio inocuo NO debe morder. Si muerde, las aserciones miran
  // el archivo y no la conducta, y todas las de arriba son falsos positivos.
  { nombre: 'CONTROL — comentario inocuo (no debe morder)',
    de: '// ---------- helpers ----------',
    a:  '// ---------- helpers (control) ----------', esperado: 'verde' },
];

function corre() {
  try {
    execFileSync(process.execPath, [ARNES], { encoding: 'utf8', stdio: 'pipe' });
    return { estado: 'verde' };
  } catch (e) {
    const salida = String(e.stdout || '') + String(e.stderr || '');
    if (e.status === 1 && /QA ROJO/.test(salida)) return { estado: 'rojo', salida };
    return { estado: 'abortó', salida: salida.slice(-400) };
  }
}

let malas = 0;
console.log('\nMutaciones sobre n8n/caty_bot.js\n');
for (const m of MUTACIONES) {
  const veces = ORIGINAL.split(m.de).length - 1;
  if (veces !== 1) {
    console.log(`  ✗ ${m.nombre} — el ancla empata ${veces} veces (debe ser 1)`);
    malas++; continue;
  }
  writeFileSync(RUTA, ORIGINAL.replace(m.de, m.a));
  const r = corre();
  writeFileSync(RUTA, ORIGINAL);
  const bien = r.estado === m.esperado;
  if (!bien) malas++;
  console.log(`  ${bien ? '✓' : '✗'} ${m.nombre} → ${r.estado}${bien ? '' : ` (se esperaba ${m.esperado})`}`);
  if (!bien && r.salida) console.log('      ' + r.salida.split('\n').slice(-6).join('\n      '));
}

// El archivo tiene que quedar EXACTAMENTE como estaba.
const restaurado = readFileSync(RUTA, 'utf8') === ORIGINAL;
console.log(`\n  ${restaurado ? '✓' : '✗'} el archivo quedó idéntico al original`);
if (!restaurado) malas++;

console.log(`\n${malas === 0 ? 'MUTACIONES OK' : 'MUTACIONES CON PROBLEMA'} — ${MUTACIONES.length} mutaciones, ${malas} sin morder\n`);
process.exit(malas === 0 ? 0 : 1);
