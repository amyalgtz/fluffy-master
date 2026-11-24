/* =====================================================================
   Fluffy Master · Carga de la «Lista de espera de Booksy» (SOLO ESCRITURA de este recurso)
   Endpoint:  POST https://admin.fluffylashesco.com/api/booksy-waitlist
   Encabezado: X-API-Key: <llave de carga>   (también acepta Authorization: Bearer <llave>)

   - Deja a las clientas de la lista de espera de Booksy en la Lista de espera de Fluffy Master (colección waitlist, kind 'entry').
     NO crea citas, depósitos, mensajes ni avisos de espacio, y NO envía SMS. GET, PATCH, DELETE y OPTIONS responden 405.
   - Usa la misma llave que /api/reception-messages (RECEPTION_INGEST_KEY). Solo puede llamar a fm_wl_ingest.
   - No registra nombres, teléfonos, correos ni textos de clientas en los logs ni en los errores. Sin dependencias (fetch y crypto nativos de Node 18+).

   Variables de entorno (Netlify → Site configuration → Environment variables): las mismas que ya usa reception-messages
     SUPABASE_URL                 https://xxxx.supabase.co
     SUPABASE_SERVICE_ROLE_KEY    llave secreta de Supabase (NUNCA en el repositorio)
     RECEPTION_INGEST_KEY         llave(s) de carga, mínimo 32 caracteres; varias separadas por coma (para rotar sin cortes)
   ===================================================================== */
import { createHash, timingSafeEqual } from 'node:crypto';

export const config = { path: ['/api/booksy-waitlist'] };

const MAX_BODY = 1024 * 1024;
const MAX_ITEMS = 200;
const ACTIONS = ['active', 'removed', 'fulfilled'];
const RE_PHONE = /^\+[1-9][0-9]{7,14}$/;          // E.164 (8 a 15 dígitos, como CL.phone de la app)
const RE_US = /^\+1[2-9][0-9]{9}$/;               // un +1 debe ser un número completo de EE. UU./Canadá

const sha = s => createHash('sha256').update(String(s)).digest();
const json = (obj, status = 200, extra = {}) => new Response(obj === null ? null : JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra } });

/* ---------------- límites (por instancia, mejor esfuerzo) ---------------- */
const fails = new Map(), hits = new Map();
const throttled = ip => { const f = fails.get(ip); return !!f && f.n >= 10 && Date.now() - f.t < 10 * 60e3; };
const noteFail = ip => { const f = fails.get(ip), now = Date.now(); fails.set(ip, f && now - f.t < 10 * 60e3 ? { n: f.n + 1, t: f.t } : { n: 1, t: now }); if (fails.size > 500) fails.clear(); };
const rateLimited = ip => { const now = Date.now(), h = (hits.get(ip) || []).filter(t => now - t < 60e3); h.push(now); hits.set(ip, h); if (hits.size > 500) hits.clear(); return h.length > 60; };   // 60 cargas por minuto

function authorized(req) {
  const keys = (process.env.RECEPTION_INGEST_KEY || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!keys.length || keys.some(k => k.length < 32)) { console.error('booksy-waitlist: RECEPTION_INGEST_KEY ausente o menor a 32 caracteres'); return 'config'; }
  const h = req.headers.get('authorization') || '', bearer = /^Bearer\s+(.+)$/i.exec(h);
  const given = bearer ? bearer[1].trim() : (req.headers.get('x-api-key') || '').trim();
  if (!given) return false;
  const g = sha(given); let ok = false;
  for (const k of keys) if (timingSafeEqual(g, sha(k))) ok = true;   // tiempo constante
  return ok;
}

/* ---------------- validación (los mensajes de error nunca repiten datos de clientas) ---------------- */
const optStr = (v, max) => v === undefined || v === null || (typeof v === 'string' && v.length <= max);
const isoTs = v => v === undefined || v === null || v === '' || (typeof v === 'string' && !Number.isNaN(Date.parse(v)));
/** Igual que title() de la app: minúsculas y mayúscula al inicio de cada palabra (o tras un guion). */
export const title = s => String(s || '').toLowerCase().replace(/(^|\s|-)\S/g, c => c.toUpperCase());

/** Devuelve { error } o { payload } ya normalizado. */
export function validate(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: 'El cuerpo debe ser un objeto JSON.' };
  if (!Array.isArray(b.entries)) return { error: 'entries debe ser una lista.' };
  if (b.entries.length > MAX_ITEMS) return { error: `Demasiadas entradas (máx. ${MAX_ITEMS} por envío).` };
  if (!optStr(b.source, 40)) return { error: 'source inválido.' };
  if (!optStr(b.timezone, 64)) return { error: 'timezone inválido.' };
  if (!isoTs(b.synced_at)) return { error: 'synced_at debe ser fecha y hora ISO 8601.' };
  const seen = new Set(), out = [];
  for (let i = 0; i < b.entries.length; i++) {
    const x = b.entries[i], at = `entries[${i}]`;
    if (!x || typeof x !== 'object' || Array.isArray(x)) return { error: `${at} debe ser un objeto.` };
    const id = typeof x.booksy_waitlist_id === 'number' && Number.isFinite(x.booksy_waitlist_id) ? String(x.booksy_waitlist_id) : x.booksy_waitlist_id;
    if (typeof id !== 'string' || !id.trim() || id.trim().length > 100) return { error: `${at}.booksy_waitlist_id es obligatorio (texto de hasta 100 caracteres).` };
    const bid = id.trim();
    if (seen.has(bid)) return { error: `${at}.booksy_waitlist_id está repetido en el envío.` };
    seen.add(bid);
    const action = x.action === undefined || x.action === null || x.action === '' ? 'active' : x.action;
    if (!ACTIONS.includes(action)) return { error: `${at}.action debe ser active, removed o fulfilled.` };
    if (action !== 'active') { out.push({ booksy_waitlist_id: bid, action }); continue; }   // bajas y cumplimientos solo necesitan el id
    if (!optStr(x.client_name, 120) || !optStr(x.first_name, 80) || !optStr(x.last_name, 80)) return { error: `${at}: nombre demasiado largo o no es texto.` };
    if (!(x.client_name || '').trim() && !(x.first_name || '').trim()) return { error: `${at}: falta client_name (o first_name y last_name).` };
    const phone = x.phone == null ? '' : x.phone;
    if (typeof phone !== 'string') return { error: `${at}.phone debe ser texto.` };
    if (phone !== '' && (!RE_PHONE.test(phone) || (phone.startsWith('+1') && !RE_US.test(phone)))) return { error: `${at}.phone debe estar en formato E.164 (por ejemplo +1XXXXXXXXXX) o vacío.` };
    if (!optStr(x.email, 120) || (x.email && !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;.]{2,}$/.test(x.email.trim()))) return { error: `${at}.email inválido.` };
    if (!optStr(x.service, 200) || !optStr(x.artist, 120) || !optStr(x.when, 300) || !optStr(x.notes, 500) || !optStr(x.source, 40)) return { error: `${at} tiene un campo demasiado largo o que no es texto.` };
    // Nombre: si viene first_name se usa tal cual; si solo viene client_name, la primera palabra es el nombre y el resto el apellido (como la app).
    let first = (x.first_name || '').trim(), last = (x.last_name || '').trim();
    if (!first) { const parts = (x.client_name || '').trim().split(/\s+/); first = parts[0]; last = parts.slice(1).join(' '); }
    out.push({ booksy_waitlist_id: bid, action, first_name: title(first), last_name: title(last), phone, email: (x.email || '').trim().toLowerCase(),
      service: (x.service || '').trim(), artist: (x.artist || '').trim(), when: (x.when || '').trim(), notes: (x.notes || '').trim(), source: (x.source || b.source || 'booksy').trim() || 'booksy' });
  }
  return { payload: { source: (b.source || 'booksy'), entries: out } };
}

/* ---------------- Supabase (solo la función fm_wl_ingest) ---------------- */
async function ingest(payload) {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, ''), key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(url) || !key) { console.error('booksy-waitlist: faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); return { status: 500, body: { error: 'Servidor sin configurar.' } }; }
  let r;
  try { r = await fetch(`${url}/rest/v1/rpc/fm_wl_ingest`, { method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ p: payload }), signal: AbortSignal.timeout(15000) }); }
  catch { console.error('booksy-waitlist: no se pudo conectar con Supabase'); return { status: 502, body: { error: 'No se pudo conectar con la base de datos.' } }; }
  let data = null; try { data = await r.json(); } catch { /* sin cuerpo */ }
  if (r.ok && data && data.ok) return { status: 200, body: { ok: true, inserted: data.inserted, updated: data.updated, unchanged: data.unchanged, closed: data.closed, skipped: data.skipped, duplicates: data.duplicates, results: data.results } };
  const code = data && data.code;
  console.error('booksy-waitlist: Supabase respondió', r.status, code || '');   // solo estado y código; nunca el detalle (puede traer datos de clientas)
  if (code === 'P0001' && typeof data.message === 'string') return { status: 400, body: { error: data.message.slice(0, 200) } };
  if (code === 'PGRST202' || code === '42883') return { status: 500, body: { error: 'Falta instalar actualizacion-lista-espera-booksy.sql en Supabase.' } };
  if (/^23/.test(code || '') || r.status === 400) return { status: 400, body: { error: 'El envío no cumple el esquema.' } };
  return { status: 502, body: { error: 'La base de datos no pudo guardar el envío.' } };
}

export default async (req, context) => {
  const ip = (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || 'x';
  if (req.method !== 'POST') return json({ error: 'Solo POST. La lectura y la revisión se hacen desde Fluffy Master con la sesión de la persona.' }, 405, { Allow: 'POST' });
  if (throttled(ip)) return json({ error: 'Demasiados intentos. Espera unos minutos.' }, 429, { 'Retry-After': '600' });
  const auth = authorized(req);
  if (auth === 'config') return json({ error: 'Servidor sin configurar.' }, 500);
  if (!auth) { noteFail(ip); return json({ error: 'No autorizado.' }, 401, { 'WWW-Authenticate': 'Bearer realm="fluffy-master-waitlist"' }); }
  if (rateLimited(ip)) return json({ error: 'Demasiados envíos seguidos. Espera un minuto.' }, 429, { 'Retry-After': '60' });

  if (!/^application\/json\b/i.test(req.headers.get('content-type') || '')) return json({ error: 'Content-Type debe ser application/json.' }, 415);
  const len = Number(req.headers.get('content-length') || 0); if (len > MAX_BODY) return json({ error: 'Solicitud demasiado grande.' }, 413);
  let text; try { text = await req.text(); } catch { return json({ error: 'No se pudo leer la solicitud.' }, 400); }
  if (text.length > MAX_BODY) return json({ error: 'Solicitud demasiado grande.' }, 413);
  let body; try { body = JSON.parse(text); } catch { return json({ error: 'JSON inválido.' }, 400); }

  const v = validate(body);
  if (v.error) return json({ error: v.error }, 400);
  const out = await ingest(v.payload);
  return json(out.body, out.status);
};

export const _test = { validate, authorized, title };
