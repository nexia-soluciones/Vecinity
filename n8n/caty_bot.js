// =============================================================================
// VECINITY · Caty — Code node del workflow "Vecinity - Telegram (Caty)"
// Deploy: scripts/push_caty.sh sustituye los placeholders __*__ desde .env.local
// y hace PUT del workflow por API. NUNCA commitear este archivo con secretos.
//
// Capacidades: menú, reservas de áreas, pase de visita, comprobante por foto
// (OCR Claude + candados anti-duplicado de la BD), saldo amable (Haiku),
// reglamento citando artículos, escalación al comité + casa configurada.
// Identidad: telegram_chat_id (lo manda Telegram) + token de bot validado en BD.
// =============================================================================
const TG = '__TELEGRAM_TOKEN__';
const SB = 'https://supabase.nexiasoluciones.com.mx';
const ANON = '__ANON_KEY__';
const SRV = '__SERVICE_KEY__'; // SOLO para subir la foto al bucket (n8n es server-side)
const BOT = '__BOT_DB_TOKEN__'; // vecino.bot_config.token
const ANTH = '__ANTHROPIC_KEY__';
const APP = 'https://vecinity.nexiasoluciones.com.mx';
const MODEL = 'claude-haiku-4-5-20251001';

const u = $input.first().json;
const body = u.body || u;

// ---------- helpers ----------
async function tg(method, payload) {
  try {
    return await this_http({ method: 'POST', url: 'https://api.telegram.org/bot' + TG + '/' + method, body: payload, json: true });
  } catch (e) { return null; }
}
function this_http(opts) { return HELPERS.httpRequest(opts); }
let HELPERS = null; // se asigna abajo (this no cruza funciones flecha en el sandbox)

async function send(chatId, text, keyboard) {
  const base = { chat_id: chatId, text: text };
  if (keyboard) base.reply_markup = { inline_keyboard: keyboard };
  // Markdown primero; si truena por contenido del usuario, plano (aprendizaje tg_send)
  const md = Object.assign({}, base, { parse_mode: 'Markdown' });
  const ok = await tg('sendMessage', md);
  if (!ok) await tg('sendMessage', base);
}

async function rpc(name, args) {
  return await this_http({
    method: 'POST', url: SB + '/rest/v1/rpc/' + name,
    headers: { apikey: ANON, Authorization: 'Bearer ' + ANON, 'Content-Type': 'application/json', 'Content-Profile': 'vecino' },
    body: args, json: true,
  });
}
// rpc que puede fallar con mensaje amable de la BD → {ok:false, msg}
async function rpcSafe(name, args) {
  try { return { ok: true, data: await rpc(name, args) }; }
  catch (e) {
    let m = e.message || '';
    try {
      const b = e.response && e.response.body;
      const j = typeof b === 'string' ? JSON.parse(b) : b;
      if (j && j.message) m = j.message;
    } catch (_) {}
    m = m.replace(/^[A-Z0-9]+:\s*/, '').replace(/\s*\(.*\)\s*$/, '');
    return { ok: false, msg: m };
  }
}

async function getSession(chatId) {
  const s = await rpcSafe('bot_session_get', { p_token: BOT, p_chat: chatId });
  return s.ok && s.data ? s.data : { step: null, data: {} };
}
async function setSession(chatId, step, data) {
  await rpcSafe('bot_session_set', { p_token: BOT, p_chat: chatId, p_step: step, p_data: data || {} });
}

async function anth(system, userText, maxTokens) {
  try {
    const r = await this_http({
      method: 'POST', url: 'https://api.anthropic.com/v1/messages',
      headers: { 'x-api-key': ANTH, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: { model: MODEL, max_tokens: maxTokens || 500, system: system, messages: [{ role: 'user', content: userText }] },
      json: true,
    });
    return (r.content && r.content[0] && r.content[0].text) || '';
  } catch (e) { return ''; }
}
async function anthVision(system, b64, mediaType, userText) {
  try {
    const r = await this_http({
      method: 'POST', url: 'https://api.anthropic.com/v1/messages',
      headers: { 'x-api-key': ANTH, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: {
        model: MODEL, max_tokens: 400, system: system,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
          { type: 'text', text: userText },
        ] }],
      },
      json: true,
    });
    return (r.content && r.content[0] && r.content[0].text) || '';
  } catch (e) { return ''; }
}
function parseJson(txt) {
  try { const m = txt.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; } catch (e) { return null; }
}

const money = (n) => '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 });
// CDMX es UTC-6 fijo (sin horario de verano desde 2022)
function fechaMX(offsetDias) {
  const d = new Date(Date.now() - 6 * 3600e3 + (offsetDias || 0) * 86400e3);
  return d.toISOString().slice(0, 10);
}
function nombreDia(offsetDias) {
  if (offsetDias === 0) return 'Hoy';
  if (offsetDias === 1) return 'Mañana';
  const dias = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  const d = new Date(Date.now() - 6 * 3600e3 + offsetDias * 86400e3);
  return dias[d.getUTCDay()] + ' ' + d.toISOString().slice(8, 10);
}

const MENU_KB = [
  [{ text: '🏖️ Reservar área', callback_data: 'menu:res' }, { text: '👮 Pase de visita', callback_data: 'menu:vis' }],
  [{ text: '💳 Subir comprobante', callback_data: 'menu:pay' }, { text: '💰 Mi saldo', callback_data: 'menu:saldo' }],
  [{ text: '📖 Reglamento', callback_data: 'menu:reg' }, { text: '🙋 Hablar con el comité', callback_data: 'menu:esc' }],
  [{ text: '🛡️ Ser vecino vigilante', callback_data: 'menu:vig' }, { text: '🆘 SOS — pedir ayuda', callback_data: 'menu:sos' }],
  [{ text: '🔐 Cambiar mi contraseña', callback_data: 'menu:pwd' }],
];

// Dispara el SOS del vecino (tras confirmación) y le da la ruta 911
async function dispararSosBot(chatId) {
  const r = await rpcSafe('bot_sos', { p_token: BOT, p_chat: chatId });
  if (!r.ok) { await send(chatId, '😔 No pude enviar la alerta: ' + r.msg + '\nSi es urgente llama directo al 911.'); return; }
  const a = r.data || {};
  await send(chatId,
    '🚨 *Alerta enviada.* Comité, capitán de zona y vecinos vigilantes ya fueron avisados.\n' +
    'Te confirmo por aquí cuando alguien vaya en camino.\n\n' +
    '📞 Si es una emergencia grave, llama al *911* y dicta:\n' +
    '· ' + ((a.calle ? a.calle + ' ' : '') + (a.casa ? '#' + a.casa : 'tu domicilio')) + '\n' +
    '· ' + (a.colonia || 'tu colonia'));
  await setSession(chatId, null, null);
}
async function showMenu(chatId, nombre) {
  await setSession(chatId, null, null);
  await send(chatId, '¡Hola' + (nombre ? ', ' + nombre.split(' ')[0] : '') + '! 👋 Soy *Caty*. ¿En qué te ayudo?', MENU_KB);
}

// Genera un enlace de recuperación de contraseña y lo manda por Telegram.
// Usa el token_hash de GoTrue apuntando a /reset-password → no depende del
// SITE_URL/allow-list. Solo para el vecino ligado a este chat.
async function enviarResetBot(chatId) {
  const r = await rpcSafe('bot_email', { p_token: BOT, p_chat: chatId });
  if (!r.ok) { await send(chatId, 'Tuve un problema técnico 😅. Intenta de nuevo en un momento.'); return; }
  const em = r.data || {};
  if (!em.ok || !em.email) {
    await send(chatId, 'Tu cuenta no tiene un correo registrado, así que no puedo generarte el enlace. Escríbele al comité para que te ayuden a restablecer la contraseña 🙏');
    return;
  }
  let link = null;
  try {
    const gl = await this_http({
      method: 'POST', url: SB + '/auth/v1/admin/generate_link',
      headers: { apikey: SRV, Authorization: 'Bearer ' + SRV, 'Content-Type': 'application/json' },
      body: { type: 'recovery', email: em.email, redirect_to: APP + '/reset-password' },
      json: true,
    });
    if (gl && gl.hashed_token) link = APP + '/reset-password?token_hash=' + gl.hashed_token + '&type=recovery';
  } catch (e) { link = null; }
  if (!link) { await send(chatId, 'No pude generar el enlace en este momento 😔. Intenta de nuevo en un rato.'); return; }
  await send(chatId,
    '🔐 Restablecer contraseña\n\nToca el enlace para crear una nueva (es de un solo uso y válido por tiempo limitado):\n' +
    link +
    '\n\nSi no lo pediste tú, ignora este mensaje: nadie puede cambiar tu contraseña sin abrir este enlace.');
}

// perfil con manejo de NO_LIGADO
async function perfilODisculpa(chatId) {
  const r = await rpcSafe('bot_perfil', { p_token: BOT, p_chat: chatId });
  if (r.ok) return r.data;
  if ((r.msg || '').indexOf('NO_LIGADO') >= 0) {
    await send(chatId, 'Aún no tengo ligada tu cuenta 🙈. Abre la app Vecinity y toca *Conectar Telegram*:\n' + APP);
  } else {
    await send(chatId, 'Tuve un problema técnico 😅. Intenta de nuevo en un momento.');
  }
  return null;
}

async function escalar(chatId, tema, texto, nombre) {
  const r = await rpcSafe('bot_escalar', { p_token: BOT, p_chat: chatId, p_tema: tema, p_texto: texto });
  if (!r.ok) { await send(chatId, 'No pude avisar al comité 😔. Intenta más tarde.'); return; }
  const chats = r.data.chats || [];
  for (const c of chats) { await tg('sendMessage', { chat_id: c, text: r.data.mensaje }); }
  await send(chatId, chats.length
    ? '📨 Listo' + (nombre ? ', ' + nombre.split(' ')[0] : '') + ': ya le pasé tu mensaje al comité. Te contactan pronto 🤝'
    : '📨 Dejé registrado tu mensaje para el comité. En cuanto se conecten lo verán 🤝');
  await setSession(chatId, null, null);
}

// ---------- flujo principal ----------
async function main() {
  // === callback de botones ===
  if (body.callback_query) {
    const cq = body.callback_query;
    const chatId = String(cq.message.chat.id);
    const dataCb = cq.data || '';
    await tg('answerCallbackQuery', { callback_query_id: cq.id });
    const ses = await getSession(chatId);
    const d = ses.data || {};

    if (dataCb === 'menu:cancel' || dataCb === 'menu:menu') { const p = await perfilODisculpa(chatId); if (p) await showMenu(chatId, p.nombre); return; }

    // === Cambiar contraseña ===
    if (dataCb === 'menu:pwd') {
      const p = await perfilODisculpa(chatId); if (!p) return;
      await enviarResetBot(chatId);
      return;
    }

    // === Vecino vigilante ===
    if (dataCb === 'menu:vig') {
      const p = await perfilODisculpa(chatId); if (!p) return;
      const est = await rpcSafe('bot_mi_vigilante', { p_token: BOT, p_chat: chatId });
      const estado = (est.ok && est.data && est.data.estado) || null;
      if (estado === 'aprobado') { await send(chatId, '🛡️ Ya eres *vecino vigilante*. Te llegan los SOS de la colonia por aquí — ¡gracias por cuidar a tus vecinos!'); return; }
      if (estado === 'postulado') { await send(chatId, '🛡️ Tu postulación ya está *en revisión del comité*. Te aviso en cuanto la aprueben.'); return; }
      await send(chatId,
        '🛡️ *Programa de vecinos vigilantes*\n\nLos vigilantes reciben las alertas SOS de los vecinos por Telegram y acuden a apoyar mientras llega ayuda. El comité aprueba cada postulación.\n\n¿Quieres participar?',
        [[{ text: '✅ Sí, postularme', callback_data: 'vig_ok' }, { text: 'Ahora no', callback_data: 'menu:cancel' }]]);
      return;
    }
    if (dataCb === 'vig_ok') {
      const p = await perfilODisculpa(chatId); if (!p) return;
      const r = await rpcSafe('bot_postular_vigilante', { p_token: BOT, p_chat: chatId });
      if (!r.ok) { await send(chatId, '😔 ' + r.msg); return; }
      await send(chatId, '🙌 ¡Gracias' + (p.nombre ? ', ' + p.nombre.split(' ')[0] : '') + '! Tu postulación quedó registrada y el comité la revisará. Te aviso cuando estés activo.');
      // avisar al comité que hay postulación nueva
      const esc = await rpcSafe('bot_escalar', { p_token: BOT, p_chat: chatId, p_tema: 'vecinos vigilantes', p_texto: 'Se postuló al programa de vecinos vigilantes. Apruébalo en el panel del comité.' });
      if (esc.ok) { for (const c of (esc.data.chats || [])) { await tg('sendMessage', { chat_id: c, text: esc.data.mensaje }); } }
      return;
    }

    // === SOS ===
    if (dataCb === 'menu:sos') {
      const p = await perfilODisculpa(chatId); if (!p) return;
      await send(chatId, '🆘 ¿Confirmas que necesitas ayuda? Se avisará al comité y a los vigilantes con tu casa.',
        [[{ text: '🚨 Sí, pedir ayuda', callback_data: 'sos_fire' }, { text: 'Cancelar', callback_data: 'menu:cancel' }]]);
      return;
    }
    if (dataCb === 'sos_fire') {
      const p = await perfilODisculpa(chatId); if (!p) return;
      await dispararSosBot(chatId);
      return;
    }
    if (dataCb.indexOf('sos_go:') === 0) {
      const r = await rpcSafe('bot_sos_atender', { p_token: BOT, p_chat: chatId, p_sos: dataCb.slice(7) });
      if (!r.ok) { await send(chatId, '😔 ' + r.msg); return; }
      const a = r.data || {};
      if (a.ya_atendido) {
        await send(chatId, '🙌 Gracias — esa alerta ya la tomó *' + (a.atendio || 'otro vecino') + '*.');
        return;
      }
      await send(chatId, '✅ Quedaste como responsable de esta alerta' + (a.casa ? ' (casa ' + a.casa + ')' : '') + '. ¡Gracias! 🏃');
      if (a.solicitante_chat) {
        await tg('sendMessage', { chat_id: a.solicitante_chat, text: '🏃 ' + (a.atendio || 'Un vecino') + ' va en camino a apoyarte. Resiste.' });
      }
      for (const c of (a.otros_chats || [])) {
        await tg('sendMessage', { chat_id: c, text: '✅ ' + (a.atendio || 'Un vecino') + ' está atendiendo el SOS' + (a.casa ? ' de la casa ' + a.casa : '') + '.' });
      }
      return;
    }

    if (dataCb === 'menu:res') {
      const p = await perfilODisculpa(chatId); if (!p) return;
      const a = await rpcSafe('bot_areas', { p_token: BOT, p_chat: chatId });
      const areas = (a.ok && a.data.areas) || [];
      if (!areas.length) { await send(chatId, 'Tu colonia aún no tiene áreas reservables configuradas.'); return; }
      await setSession(chatId, 'res_area', { areas: areas });
      await send(chatId, '🏖️ ¿Qué área quieres reservar?',
        areas.map((x, i) => [{ text: x.nombre, callback_data: 'res_a:' + i }]).concat([[{ text: '‹ Menú', callback_data: 'menu:menu' }]]));
      return;
    }
    if (dataCb.indexOf('res_a:') === 0) {
      const area = (d.areas || [])[Number(dataCb.slice(6))];
      if (!area) { await send(chatId, 'Esa opción expiró, empieza de nuevo con /start.'); return; }
      await setSession(chatId, 'res_fecha', { area: area });
      const kb = [0, 1, 2, 3, 4, 5].map((n) => ({ text: nombreDia(n), callback_data: 'res_f:' + n }));
      await send(chatId, '📅 *' + area.nombre + '* — ¿para qué día?', [kb.slice(0, 3), kb.slice(3), [{ text: '‹ Menú', callback_data: 'menu:menu' }]]);
      return;
    }
    if (dataCb.indexOf('res_f:') === 0) {
      const area = d.area; if (!area) { await send(chatId, 'Esa opción expiró, empieza de nuevo.'); return; }
      const fecha = fechaMX(Number(dataCb.slice(6)));
      const disp = await rpcSafe('bot_disponibilidad', { p_token: BOT, p_chat: chatId, p_area: area.id, p_fecha: fecha });
      const ocupadas = (disp.ok && disp.data.ocupadas) || [];
      const abre = parseInt(area.apertura.slice(0, 2), 10);
      const cierra = parseInt(area.cierre.slice(0, 2), 10);
      const horas = [];
      for (let h = abre; h < cierra; h++) {
        const ini = new Date(fecha + 'T' + String(h).padStart(2, '0') + ':00:00-06:00').getTime();
        const fin = ini + 3600e3;
        const choca = ocupadas.some((o) => new Date(o.inicio).getTime() < fin && new Date(o.fin).getTime() > ini);
        if (!choca) horas.push(h);
      }
      if (!horas.length) { await send(chatId, 'Ese día ya está lleno 😔. Prueba otra fecha.', [[{ text: '‹ Elegir otra', callback_data: 'menu:res' }]]); return; }
      await setSession(chatId, 'res_hora', { area: area, fecha: fecha });
      const kb = []; let fila = [];
      for (const h of horas) { fila.push({ text: String(h).padStart(2, '0') + ':00', callback_data: 'res_h:' + h }); if (fila.length === 4) { kb.push(fila); fila = []; } }
      if (fila.length) kb.push(fila);
      kb.push([{ text: '‹ Menú', callback_data: 'menu:menu' }]);
      await send(chatId, '🕐 ¿A qué hora empieza? (' + nombreDia(Number(dataCb.slice(6))) + ')', kb);
      return;
    }
    if (dataCb.indexOf('res_h:') === 0) {
      const area = d.area; if (!area) { await send(chatId, 'Esa opción expiró, empieza de nuevo.'); return; }
      const hora = Number(dataCb.slice(6));
      const maxH = Math.max(1, Number(area.max_h || 3));
      await setSession(chatId, 'res_dur', { area: area, fecha: d.fecha, hora: hora });
      const kb = [];
      for (let n = Math.max(1, Number(area.min_h || 1)); n <= maxH; n++) kb.push({ text: n + (n === 1 ? ' hora' : ' horas'), callback_data: 'res_d:' + n });
      await send(chatId, '⏱️ ¿Cuántas horas?', [kb, [{ text: '‹ Menú', callback_data: 'menu:menu' }]]);
      return;
    }
    if (dataCb.indexOf('res_d:') === 0) {
      const area = d.area; if (!area) { await send(chatId, 'Esa opción expiró, empieza de nuevo.'); return; }
      const dur = Number(dataCb.slice(6));
      if (area.aforo) {
        await setSession(chatId, 'res_pers', { area: area, fecha: d.fecha, hora: d.hora, dur: dur });
        const tope = Math.max(1, Number(area.max_personas || 5));
        const kb = []; for (let n = 1; n <= Math.min(tope, 8); n++) kb.push({ text: String(n), callback_data: 'res_p:' + n });
        await send(chatId, '👥 ¿Cuántas personas van?', [kb.slice(0, 4), kb.slice(4), [{ text: '‹ Menú', callback_data: 'menu:menu' }]].filter((r) => r.length));
        return;
      }
      await setSession(chatId, 'res_conf', { area: area, fecha: d.fecha, hora: d.hora, dur: dur, pers: null });
      await confirmarReserva(chatId, area, d.fecha, d.hora, dur, null);
      return;
    }
    if (dataCb.indexOf('res_p:') === 0) {
      const area = d.area; if (!area) { await send(chatId, 'Esa opción expiró, empieza de nuevo.'); return; }
      const pers = Number(dataCb.slice(6));
      await setSession(chatId, 'res_conf', { area: area, fecha: d.fecha, hora: d.hora, dur: d.dur, pers: pers });
      await confirmarReserva(chatId, area, d.fecha, d.hora, d.dur, pers);
      return;
    }
    if (dataCb === 'res_ok') {
      const area = d.area; if (!area) { await send(chatId, 'Esa opción expiró, empieza de nuevo.'); return; }
      const ini = d.fecha + 'T' + String(d.hora).padStart(2, '0') + ':00:00-06:00';
      const fin = d.fecha + 'T' + String(d.hora + d.dur).padStart(2, '0') + ':00:00-06:00';
      const r = await rpcSafe('bot_crear_reserva', { p_token: BOT, p_chat: chatId, p_area: area.id, p_inicio: ini, p_fin: fin, p_personas: d.pers });
      if (!r.ok) { await send(chatId, '😔 ' + r.msg, [[{ text: '‹ Menú', callback_data: 'menu:menu' }]]); return; }
      const estado = (r.data && r.data.estado) || 'pendiente';
      await send(chatId, (estado === 'aprobada' ? '✅ ¡Reserva confirmada!' : '📝 Reserva registrada, queda *pendiente de aprobación*.') +
        '\n' + area.nombre + ' · ' + d.fecha + ' · ' + String(d.hora).padStart(2, '0') + ':00–' + String(d.hora + d.dur).padStart(2, '0') + ':00' +
        (area.reglas ? '\n\n📋 Recuerda: ' + area.reglas : ''));
      await setSession(chatId, null, null);
      return;
    }

    if (dataCb === 'menu:vis') {
      const p = await perfilODisculpa(chatId); if (!p) return;
      if (!p.house_id) { await send(chatId, 'Los pases de visita son para quien vive en la casa 🙂. Como propietario puedes ver pagos y saldo.'); return; }
      await setSession(chatId, 'visita_nombre', {});
      await send(chatId, '👮 ¿Cómo se llama tu visitante? (nombre y apellido)');
      return;
    }
    if (dataCb.indexOf('vis_f:') === 0) {
      const fecha = fechaMX(Number(dataCb.slice(6)));
      const r = await rpcSafe('bot_registrar_visita', { p_token: BOT, p_chat: chatId, p_nombre: d.nombre, p_fecha: fecha + 'T12:00:00-06:00' });
      if (!r.ok) { await send(chatId, '😔 ' + r.msg); return; }
      await send(chatId, '✅ Pase creado para *' + d.nombre + '* (' + nombreDia(Number(dataCb.slice(6))) + ').\n\nReenvíale este link — lo muestra en caseta:\n' + APP + '/visita/' + r.data.token);
      await setSession(chatId, null, null);
      return;
    }

    if (dataCb === 'menu:pay') {
      const p = await perfilODisculpa(chatId); if (!p) return;
      const casas = p.casas || [];
      if (!casas.length) { await send(chatId, 'Tu perfil no tiene casa ligada. Avisa al comité 🙏'); return; }
      if (casas.length > 1) {
        await setSession(chatId, 'pay_casa', { casas: casas });
        await send(chatId, '💳 ¿De qué casa es el pago?', casas.map((c, i) => [{ text: 'Casa ' + c.numero + ' · ' + money(c.saldo), callback_data: 'pay_c:' + i }]));
        return;
      }
      await setSession(chatId, 'pay_foto', { house: casas[0].id, numero: casas[0].numero });
      await send(chatId, '📸 Mándame la *foto* de tu comprobante (transferencia o depósito) y yo lo registro.');
      return;
    }
    if (dataCb.indexOf('pay_c:') === 0) {
      const c = (d.casas || [])[Number(dataCb.slice(6))];
      if (!c) { await send(chatId, 'Esa opción expiró, empieza de nuevo.'); return; }
      if (d.file_id) {
        // la foto ya la mandó: procesarla directo para la casa elegida
        const p = await perfilODisculpa(chatId); if (!p) return;
        await procesarComprobante(chatId, p.colonia_id, c.id, c.numero, d.file_id, d.caption || '');
        return;
      }
      await setSession(chatId, 'pay_foto', { house: c.id, numero: c.numero });
      await send(chatId, '📸 Perfecto, casa ' + c.numero + '. Mándame la *foto* del comprobante.');
      return;
    }
    if (dataCb === 'pay_ok') {
      if (!d.url || !d.monto) { await send(chatId, 'Esa opción expiró, vuelve a mandar la foto 🙏'); return; }
      const r = await rpcSafe('bot_registrar_abono', { p_token: BOT, p_chat: chatId, p_monto: d.monto, p_url: d.url, p_hash: d.hash || null, p_house: d.house || null });
      if (!r.ok) { await send(chatId, '😔 ' + r.msg, [[{ text: '‹ Menú', callback_data: 'menu:menu' }]]); await setSession(chatId, null, null); return; }
      let dup = false;
      if (r.data && r.data.id && (d.ocr || d.ref)) {
        const o = await rpcSafe('bot_set_abono_ocr', { p_token: BOT, p_chat: chatId, p_id: r.data.id, p_ocr: d.ocr || {}, p_ref: d.ref || null });
        if (o.ok && o.data && o.data.duplicado) dup = true;
      }
      await send(chatId, dup
        ? '⚠️ Esa transferencia *ya estaba registrada* (misma clave de rastreo), así que no se duplicó tu pago. Si crees que es un error, avísale al comité.'
        : '✅ ¡Listo! Tu abono de ' + money(d.monto) + ' quedó registrado y el comité lo revisará pronto 🤝');
      await setSession(chatId, null, null);
      return;
    }
    if (dataCb === 'pay_edit') {
      await setSession(chatId, 'pay_monto', d);
      await send(chatId, '✏️ ¿De cuánto fue el pago? (solo el número, ej. 1500)');
      return;
    }

    if (dataCb === 'menu:saldo' || dataCb.indexOf('sal_c:') === 0) {
      const p = await perfilODisculpa(chatId); if (!p) return;
      const casas = p.casas || [];
      if (!casas.length) { await send(chatId, 'Tu perfil no tiene casa ligada. Avisa al comité 🙏'); return; }
      let casa = casas[0];
      if (dataCb.indexOf('sal_c:') === 0) casa = casas[Number(dataCb.slice(6))] || casas[0];
      else if (casas.length > 1) {
        await send(chatId, '💰 ¿De qué casa?', casas.map((c, i) => [{ text: 'Casa ' + c.numero, callback_data: 'sal_c:' + i }]));
        return;
      }
      const m = await rpcSafe('bot_movimientos', { p_token: BOT, p_chat: chatId, p_house: casa.id });
      if (!m.ok) { await send(chatId, '😔 ' + m.msg); return; }
      const mv = m.data.movimientos || [];
      let txt = '💰 *Casa ' + m.data.numero + '*\nSaldo: *' + money(m.data.saldo) + '*' +
        (Number(m.data.saldo) > 0 ? ' (pendiente de pago)' : ' — ¡al corriente! 🎉') + '\n\nÚltimos movimientos:';
      for (const t of mv.slice(0, 6)) {
        txt += '\n' + (t.tipo === 'abono' ? '🟢 −' : '🔴 +') + money(t.monto) + ' · ' + t.concepto + ' · ' + t.fecha + (t.estado !== 'aprobado' ? ' _(' + t.estado + ')_' : '');
      }
      txt += '\n\n¿Tienes una duda de tu saldo? *Escríbemela aquí* y te la explico 👇';
      await setSession(chatId, 'saldo_duda', { house: casa.id, resumen: m.data });
      await send(chatId, txt, [[{ text: '🙋 Mejor que me llame el comité', callback_data: 'esc:saldo' }], [{ text: '‹ Menú', callback_data: 'menu:menu' }]]);
      return;
    }
    if (dataCb === 'esc:saldo') {
      const p = await perfilODisculpa(chatId); if (!p) return;
      await escalar(chatId, 'su saldo', (d && d.ultima) || 'El vecino pide que el comité lo contacte por su saldo.', p.nombre);
      return;
    }

    if (dataCb === 'menu:reg') {
      const p = await perfilODisculpa(chatId); if (!p) return;
      await setSession(chatId, 'reg_duda', {});
      await send(chatId, '📖 Pregúntame lo que quieras del reglamento (mascotas, ruido, cocheras, multas…) y te contesto citando el artículo.');
      return;
    }
    if (dataCb === 'menu:esc') {
      const p = await perfilODisculpa(chatId); if (!p) return;
      await setSession(chatId, 'esc_texto', {});
      await send(chatId, '🙋 Cuéntame qué necesitas y yo se lo paso al comité tal cual 📨');
      return;
    }
    return;
  }

  // === mensajes ===
  const msg = body.message || body.edited_message;
  if (!msg || !msg.chat) return;
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  const name = (msg.from && msg.from.first_name) || 'vecino';

  // /start — deep-link de vinculación (flujo original) + menú
  if (text.indexOf('/start') === 0) {
    const param = (text.split(/\s+/)[1]) || '';
    if (param.indexOf('vecino_') === 0) {
      const pid = param.slice(7);
      if (/^[0-9a-fA-F-]{36}$/.test(pid)) {
        let nombre = null;
        try { nombre = await rpc('link_telegram', { p_id: pid, p_chat: chatId }); } catch (e) { nombre = null; }
        if (nombre) {
          await send(chatId, '✅ ¡Listo, ' + name + '! Soy *Caty* 🛡️\nDesde ahora te aviso por aquí y también me puedes pedir cosas:');
          await showMenu(chatId, name);
        } else {
          await send(chatId, 'Tu enlace no es válido o expiró. Abre la app Vecinity y vuelve a tocar *Conectar Telegram*.');
        }
        return;
      }
      await send(chatId, 'Código de enlace inválido. Abre la app y toca *Conectar Telegram*.');
      return;
    }
    const p0 = await rpcSafe('bot_perfil', { p_token: BOT, p_chat: chatId });
    if (p0.ok) { await showMenu(chatId, p0.data.nombre); }
    else { await send(chatId, '¡Hola, ' + name + '! 👋 Soy *Caty*, la asistente de tu colonia en *Vecinity*.\nPara empezar, abre la app y toca *Conectar Telegram*:\n' + APP); }
    return;
  }

  const ses = await getSession(chatId);
  const step = ses.step;
  const d = ses.data || {};

  // "SOS" escrito directo → confirmación exprés (sin pasar por el menú)
  if (/^(sos|s\.o\.s\.?|911|auxilio)$/i.test(text)) {
    const p = await perfilODisculpa(chatId); if (!p) return;
    await send(chatId, '🆘 ¿Confirmas que necesitas ayuda? Se avisará al comité y a los vigilantes con tu casa.',
      [[{ text: '🚨 Sí, pedir ayuda', callback_data: 'sos_fire' }, { text: 'Cancelar', callback_data: 'menu:cancel' }]]);
    return;
  }

  // FOTO → comprobante (con o sin flujo iniciado)
  const photos = msg.photo || (msg.document && /image\//.test(msg.document.mime_type || '') ? [msg.document] : null);
  if (photos && photos.length) {
    const p = await perfilODisculpa(chatId); if (!p) return;
    const casas = p.casas || [];
    if (!casas.length) { await send(chatId, 'Tu perfil no tiene casa ligada. Avisa al comité 🙏'); return; }
    let house = d.house || null, numero = d.numero || null;
    const fid = photos[photos.length - 1].file_id;
    if (!house) {
      if (casas.length > 1) {
        // guardar la foto y preguntar casa (pay_c la procesa directo)
        await setSession(chatId, 'pay_casa_foto', { casas: casas, file_id: fid, caption: msg.caption || '' });
        await send(chatId, '¿De qué casa es este pago?', casas.map((c, i) => [{ text: 'Casa ' + c.numero, callback_data: 'pay_c:' + i }]));
        return;
      }
      house = casas[0].id; numero = casas[0].numero;
    }
    await procesarComprobante(chatId, p.colonia_id, house, numero, fid, msg.caption || '');
    return;
  }

  // pasos que esperan TEXTO
  if (step === 'visita_nombre' && text) {
    await setSession(chatId, 'visita_fecha', { nombre: text.slice(0, 80) });
    const kb = [0, 1, 2, 3].map((n) => ({ text: nombreDia(n), callback_data: 'vis_f:' + n }));
    await send(chatId, '📅 ¿Qué día viene *' + text.slice(0, 80) + '*?', [kb.slice(0, 2), kb.slice(2), [{ text: '‹ Menú', callback_data: 'menu:menu' }]]);
    return;
  }
  if (step === 'pay_monto' && text) {
    const m = parseFloat(text.replace(/[$,\s]/g, ''));
    if (!Number.isFinite(m) || m <= 0) { await send(chatId, 'No entendí el monto 🙈. Escribe solo el número, ej. *1500*'); return; }
    const nd = Object.assign({}, d, { monto: m });
    await setSession(chatId, 'pay_conf', nd);
    await send(chatId, '¿Registro tu pago de *' + money(m) + '*' + (d.numero ? ' para la casa ' + d.numero : '') + '?',
      [[{ text: '✅ Sí, regístralo', callback_data: 'pay_ok' }, { text: 'Cancelar', callback_data: 'menu:cancel' }]]);
    return;
  }
  if (step === 'saldo_duda' && text) {
    const p = await perfilODisculpa(chatId); if (!p) return;
    const ctx = JSON.stringify(d.resumen || {});
    const out = await anth(
      'Eres Caty, la asistente amable de una colonia (app Vecinity). Contesta en español mexicano, cálido, breve (máx 4 líneas), tuteando. Te paso el estado de cuenta REAL de la casa del vecino y su pregunta. Reglas: solo usa esos datos, no inventes montos ni fechas; los cargos suman al saldo y los abonos lo bajan; abonos "pendiente" aún no los aprueba el comité. Si la duda NO se puede resolver con los datos (cobros que no reconoce, promesas del comité, errores), responde con empatía y marca escalar=true. Devuelve SOLO JSON: {"respuesta": string, "escalar": boolean}.',
      'Estado de cuenta: ' + ctx + '\n\nPregunta del vecino: ' + text, 400);
    const j = parseJson(out) || { respuesta: 'Déjame pasarle tu duda al comité para que te la resuelvan bien 🙏', escalar: true };
    await setSession(chatId, 'saldo_duda', Object.assign({}, d, { ultima: text }));
    if (j.escalar) {
      await send(chatId, j.respuesta);
      await escalar(chatId, 'su saldo', text, p.nombre);
    } else {
      await send(chatId, j.respuesta, [[{ text: '🙋 Pasar mi duda al comité', callback_data: 'esc:saldo' }], [{ text: '‹ Menú', callback_data: 'menu:menu' }]]);
    }
    return;
  }
  if (step === 'reg_duda' && text) {
    const p = await perfilODisculpa(chatId); if (!p) return;
    // Expansión de sinónimos: el vecino dice "perro", el reglamento dice "animales".
    // Se AGREGAN términos (no se sustituyen) para que el ranking por hits los pese.
    const SINONIMOS = [
      [/perr|gat|cachorr/, 'mascota mascotas animales'],
      [/basur|escombro/, 'basura residuos limpieza aseo'],
      [/ruido|música|musica|fiesta|escándalo|escandalo/, 'ruidosa molestias evento moral'],
      [/carro|coche|auto|camioneta|moto/, 'vehículo vehículos estacionar estacionamiento cajón'],
      [/rent|inquilin|arrend/, 'arrendamiento arrendatario contrato'],
      [/cuota|mantenimiento|pago|deb|mora/, 'cuotas mantenimiento administración intereses morosos'],
      [/constru|obra|remodel|amplia/, 'construcción obra diseño fachada'],
      [/multa|sanci|castigo/, 'multa sanciones tabulador infracción'],
      [/visita|caseta|acceso|corbat|tag|rfid/, 'acceso caseta vigilancia corbatines registro'],
    ];
    let q = text;
    const lower = text.toLowerCase();
    for (const [rx, extra] of SINONIMOS) { if (rx.test(lower)) q += ' ' + extra; }
    const b = await rpcSafe('bot_reglamento_buscar', { p_token: BOT, p_chat: chatId, p_q: q });
    const arts = (b.ok && b.data.articulos) || [];
    if (!arts.length) {
      await send(chatId, 'Eso no lo encontré en el reglamento 🤔. ¿Quieres que le pregunte al comité?',
        [[{ text: '🙋 Sí, pregúntales', callback_data: 'menu:esc' }], [{ text: '‹ Menú', callback_data: 'menu:menu' }]]);
      return;
    }
    const out = await anth(
      'Eres Caty, asistente amable de una colonia. Te paso artículos LITERALES del reglamento y una pregunta. Contesta en español mexicano, breve y cálido, CITANDO el artículo que aplica (ej. "Según el Artículo 45: …" con una cita textual corta). Si los artículos no responden la pregunta, dilo honestamente. NO inventes reglas que no estén en los artículos. Máximo 6 líneas. Devuelve SOLO JSON: {"respuesta": string}.',
      'Artículos: ' + JSON.stringify(arts) + '\n\nPregunta: ' + text, 500);
    const j = parseJson(out) || { respuesta: 'No pude leer bien el reglamento ahorita 😔, intenta de nuevo.' };
    await send(chatId, j.respuesta, [[{ text: '🙋 Preguntar al comité', callback_data: 'menu:esc' }], [{ text: '‹ Menú', callback_data: 'menu:menu' }]]);
    return; // sigue en reg_duda para preguntas de seguimiento
  }
  if (step === 'esc_texto' && text) {
    const p = await perfilODisculpa(chatId); if (!p) return;
    await escalar(chatId, 'un tema', text, p.nombre);
    return;
  }

  // sin flujo: saludo + menú (ligado) o invitación a ligar
  const p1 = await rpcSafe('bot_perfil', { p_token: BOT, p_chat: chatId });
  if (p1.ok) await showMenu(chatId, p1.data.nombre);
  else await send(chatId, 'Soy *Caty* 🛡️. Para ayudarte con reservas, pagos y más, abre la app Vecinity y toca *Conectar Telegram*:\n' + APP);
}

// Descarga la foto de Telegram, la sube al bucket, OCR con Claude y propone el monto
async function procesarComprobante(chatId, coloniaId, house, numero, fid, caption) {
  await send(chatId, '🔍 Déjame leer tu comprobante…');
  const meta = await tg('getFile', { file_id: fid });
  if (!meta || !meta.result) { await send(chatId, 'No pude descargar la imagen 😔. Intenta de nuevo.'); return; }
  const fpath = meta.result.file_path || '';
  const ext = (fpath.split('.').pop() || 'jpg').toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  const bin = await this_http({ method: 'GET', url: 'https://api.telegram.org/file/bot' + TG + '/' + fpath, encoding: 'arraybuffer', json: false });
  const buf = Buffer.from(bin);
  // hash (dedup por imagen) — si el sandbox no trae webcrypto, seguimos sin hash
  let hash = null;
  try {
    const dig = await crypto.subtle.digest('SHA-256', buf);
    hash = Array.from(new Uint8Array(dig)).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch (e) { hash = null; }
  // subir al bucket (mismo layout de paths que la app: colonia/casa/archivo)
  const path = coloniaId + '/' + house + '/' + ('' + Date.now()) + '-' + Math.floor(Math.random() * 1e6) + '.' + ext;
  try {
    await this_http({
      method: 'POST', url: SB + '/storage/v1/object/vecino-comprobantes/' + path,
      headers: { apikey: SRV, Authorization: 'Bearer ' + SRV, 'Content-Type': mime },
      body: buf, json: false,
    });
  } catch (e) { await send(chatId, 'No pude guardar el comprobante 😔. Intenta de nuevo.'); return; }
  const url = SB + '/storage/v1/object/public/vecino-comprobantes/' + path;
  // OCR con Claude (mismos campos que la app: monto + clave de rastreo para dedup)
  const ocrTxt = await anthVision(
    'Eres un extractor de comprobantes bancarios mexicanos. Devuelve SOLO un JSON: {"monto": number|null, "clave_rastreo": string|null, "folio": string|null, "banco": string|null, "fecha": string|null}. Sin texto extra.',
    buf.toString('base64'), mime, 'Extrae los datos de este comprobante.');
  const ocr = parseJson(ocrTxt) || {};
  const capMonto = parseFloat(((caption || '').match(/[\d,]+(?:\.\d+)?/) || [''])[0].replace(/,/g, ''));
  const monto = ocr.monto || (Number.isFinite(capMonto) ? capMonto : null);
  const ref = ocr.clave_rastreo || ocr.folio || null;
  if (monto) {
    await setSession(chatId, 'pay_conf', { house: house, numero: numero, url: url, hash: hash, ocr: ocr, ref: ref, monto: monto });
    await send(chatId, '📄 Leí un pago de *' + money(monto) + '*' + (ocr.banco ? ' (' + ocr.banco + ')' : '') + (numero ? ' para la casa ' + numero : '') + '.\n¿Lo registro?',
      [[{ text: '✅ Sí, regístralo', callback_data: 'pay_ok' }, { text: '✏️ Otro monto', callback_data: 'pay_edit' }], [{ text: 'Cancelar', callback_data: 'menu:cancel' }]]);
  } else {
    await setSession(chatId, 'pay_monto', { house: house, numero: numero, url: url, hash: hash, ocr: ocr, ref: ref });
    await send(chatId, 'Guardé tu comprobante pero no alcancé a leer el monto 🙈. ¿De cuánto fue? (solo el número)');
  }
}

async function confirmarReserva(chatId, area, fecha, hora, dur, pers) {
  await send(chatId, '📋 Confirma tu reserva:\n*' + area.nombre + '*\n📅 ' + fecha + '\n🕐 ' + String(hora).padStart(2, '0') + ':00–' + String(hora + dur).padStart(2, '0') + ':00' + (pers ? '\n👥 ' + pers + ' personas' : ''),
    [[{ text: '✅ Confirmar', callback_data: 'res_ok' }, { text: 'Cancelar', callback_data: 'menu:cancel' }]]);
}

HELPERS = this.helpers;
await main.call(this);
return [{ json: { ok: true } }];
