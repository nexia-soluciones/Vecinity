// qa_caty_bot.mjs — arnés del cerebro de Caty (n8n/caty_bot.js)
//
// El archivo es el CUERPO de un Code node: lleva `await` y `return` en el nivel
// superior, así que `node --check` lo reporta roto siempre — y un check que
// falla siempre se lee igual que uno que falta. Aquí se parsea como lo parsea
// n8n (AsyncFunction) y se prueban las piezas que se pueden aislar.
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../n8n/caty_bot.js', import.meta.url), 'utf8');
let fallas = 0, checks = 0;
const ok   = (t) => { checks++; console.log('  ✓ ' + t); };
const bad  = (t, d) => { checks++; fallas++; console.log('  ✗ FALLA: ' + t + (d ? ' — ' + d : '')); };
const es   = (t, cond, d) => (cond ? ok(t) : bad(t, d));

// ---------------------------------------------------------------- 1. parseo
console.log('\n1) Parseo como Code node (AsyncFunction)');
try {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  new AsyncFunction(SRC);
  ok('el cuerpo parsea');
} catch (e) {
  bad('el cuerpo parsea', e.message);
}

// ------------------------------------------------- 2. nombres duplicados
// Dos `function X(){}` en el nivel superior NO dan error: la segunda pisa a la
// primera y la pantalla que usaba la primera se queda muda en producción.
console.log('\n2) Declaraciones de nivel superior duplicadas');
{
  const nombres = new Map();
  const re = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm;
  let m;
  while ((m = re.exec(SRC))) {
    const n = m[1] || m[2];
    nombres.set(n, (nombres.get(n) || 0) + 1);
  }
  const dup = [...nombres].filter(([, c]) => c > 1);
  console.log(`  (revisados ${nombres.size} nombres de nivel superior)`);
  es('ningún nombre se declara dos veces', dup.length === 0, dup.map(([n, c]) => `${n} ×${c}`).join(', '));
}

// ------------------------------------------------- 3. msgDeError / rpcSafe
// Se recortan del fuente y se corren aislados: son las dos piezas que deciden
// qué texto ve el vecino cuando la BD rechaza algo.
function recorta(marca) {
  const i = SRC.indexOf(marca);
  if (i < 0) throw new Error('no encontré ' + JSON.stringify(marca) + ' en el fuente');
  const j = SRC.indexOf('\n}\n', i);
  if (j < 0) throw new Error('no encontré el cierre de ' + JSON.stringify(marca));
  return SRC.slice(i, j + 3);
}

console.log('\n3) El vecino ve la razón, no el status HTTP');
{
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fabrica = new AsyncFunction('errorAInyectar', `
    ${recorta('function msgDeError(e) {')}
    async function rpc() { throw errorAInyectar; }
    ${recorta('async function rpcSafe(name, args) {')}
    return { msgDeError, rpcSafe };
  `);

  // (a) La forma EXACTA que se observó en producción el 26-ago: n8n entrega el
  //     error de axios pelón, sin cuerpo. No hay nada que leer.
  const axiosPelon = new Error('Request failed with status code 400');
  // (b) Las formas en que n8n/axios sí traen el cuerpo de PostgREST.
  const cuerpo = { code: 'P0001', details: null, hint: null, message: 'Tu perfil no está ligado a una casa todavía.' };
  const formas = {
    'response.data (objeto)':  Object.assign(new Error('Request failed with status code 400'), { response: { data: cuerpo } }),
    'response.data (string)':  Object.assign(new Error('x'), { response: { data: JSON.stringify(cuerpo) } }),
    'response.body':           Object.assign(new Error('x'), { response: { body: cuerpo } }),
    'cause.response.data':     Object.assign(new Error('x'), { cause: { response: { data: cuerpo } } }),
    'JSON dentro del message': new Error('400 - ' + JSON.stringify(cuerpo)),
  };

  for (const [nombre, err] of Object.entries(formas)) {
    const { rpcSafe } = await fabrica(err);
    const r = await rpcSafe('bot_crear_reserva', {});
    es(`saca el mensaje de la BD desde ${nombre}`,
       r.ok === false && r.msg === 'Tu perfil no está ligado a una casa todavía.',
       'devolvió: ' + JSON.stringify(r.msg));
  }

  {
    const { rpcSafe } = await fabrica(axiosPelon);
    const r = await rpcSafe('bot_crear_reserva', {});
    es('sin cuerpo legible NUNCA enseña el status crudo',
       r.ok === false && !/\b400\b|status code/i.test(r.msg),
       'devolvió: ' + JSON.stringify(r.msg));
    es('sin cuerpo legible dice algo útil en español',
       r.ok === false && r.msg.length > 20 && /inténtalo|intentalo/i.test(r.msg),
       'devolvió: ' + JSON.stringify(r.msg));
  }
}

// -------------------------------------- 4. el /start distingue los 3 casos
console.log('\n4) El deep-link: token nuevo, id viejo, y la verdad cuando el chat es de otro');
{
  const frag = SRC.slice(SRC.indexOf("if (param.indexOf('vecino_') === 0)"), SRC.indexOf("const p0 = await rpcSafe('bot_perfil'"));
  es('canjea el token de un solo uso', /telegram_link_consumir/.test(frag));
  es('distingue token (32 hex) del id de perfil (uuid)',
     /\[0-9a-f\]\{32\}/i.test(frag) && /\{36\}/.test(frag));
  es('dice a qué cuenta está ligado el teléfono en vez de "expiró"',
     /ya está conectado a la cuenta de/.test(frag));
  es('avisa cuando el teléfono cambió de cuenta',
     /Antes este Telegram estaba conectado/.test(frag));
  for (const motivo of ['expirado', 'usado', 'perfil']) {
    es(`explica el motivo "${motivo}"`, new RegExp(`'${motivo}'`).test(frag));
  }
}

console.log(`\n${fallas === 0 ? 'QA VERDE' : 'QA ROJO'} — ${checks} checks, ${fallas} fallas\n`);
process.exit(fallas === 0 ? 0 : 1);
