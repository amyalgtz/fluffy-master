/* =====================================================================
   Fluffy Master · Carga de «Citas de Booksy» (SOLO ESCRITURA de este recurso)
   Endpoint:  POST https://admin.fluffylashesco.com/api/booksy-bookings
   Encabezado: X-API-Key: <llave de carga>   (también acepta Authorization: Bearer <llave>)

   - Solo deja las reservas en la bandeja fm_booksy_inbox. NO crea citas, depósitos ni fichas: eso lo hace la app, con la sesión de una
     persona y las reglas de siempre (y manda a «Revisar» lo dudoso). GET, PATCH y DELETE responden 405.
   - La llave de carga es distinta de la de Mensajes y de la del MCP: solo puede llamar a fm_bi_ingest.
   - No registra nombres, teléfonos ni montos en los logs. Sin dependencias (fetch y crypto nativos de Node 18+).

   Variables de entorno (Netlify → Site configuration → Environment variables):
     SUPABASE_URL                 https://xxxx.supabase.co            (la misma del MCP)
     SUPABASE_SERVICE_ROLE_KEY    llave secreta de Supabase           (la misma del MCP; NUNCA en el repositorio)
     BOOKSY_INGEST_KEY            llave(s) de carga, mínimo 32 caracteres; varias separadas por coma (para rotar sin cortes)
   ===================================================================== */
import { createHash, timingSafeEqual } from 'node:crypto';

export const config = { path: ['/api/booksy-bookings'] };

const MAX_BODY = 1024 * 1024;
const MAX_ITEMS = 200;
const STATUSES = ['booked', 'rescheduled', 'cancelled', 'no_show'];
const RE_DAY = /^\d{4}-\d{2}-\d{2}$/;
const RE_PHONE = /^\+[1-9][0-9]{6,14}$/;
const TZ = 'America/New_York';

const sha = s => createHash('sha256').update(String(s)).digest();
const dayNum = iso => { const [y, m, d] = iso.split('-').map(Number); return Math.floor(Date.UTC(y, m - 1, d) / 864e5); };
const dayIso = n => new Date(n * 864e5).toISOString().slice(0, 10);
const validDay = iso => typeof iso === 'string' && RE_DAY.test(iso) && dayIso(dayNum(iso)) === iso;
const todayNY = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const json = (obj, status = 200, extra = {}) => new Response(obj === null ? null : JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra } });

/* ---------------- límites (por instancia, mejor esfuerzo) ---------------- */
const fails = new Map(), hits = new Map();
const throttled = ip => { const f = fails.get(ip); return !!f && f.n >= 10 && Date.now() - f.t < 10 * 60e3; };
const noteFail = ip => { const f = fails.get(ip), now = Date.now(); fails.set(ip, f && now - f.t < 10 * 60e3 ? { n: f.n + 1, t: f.t } : { n: 1, t: now }); if (fails.size > 500) fails.clear(); };
const rateLimited = ip => { const now = Date.now(), h = (hits.get(ip) || []).filter(t => now - t < 60e3); h.push(now); hits.set(ip, h); if (hits.size > 500) hits.clear(); return h.length > 60; };   // 60 cargas por minuto

function authorized(req) {
  const keys = (process.env.BOOKSY_INGEST_KEY || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!keys.length || keys.some(k => k.length < 32)) { console.error('booksy-bookings: BOOKSY_INGEST_KEY ausente o menor a 32 caracteres'); return 'config'; }
  const h = req.headers.get('authorization') || '', bearer = /^Bearer\s+(.+)$/i.exec(h);
  const given = bearer ? bearer[1].trim() : (req.headers.get('x-api-key') || '').trim();
  if (!given) return false;
  const g = sha(given); let ok = false;
  for (const k of keys) if (timingSafeEqual(g, sha(k))) ok = true;   // tiempo constante
  return ok;
}

/* ---------------- validación (los mensajes de error nunca repiten datos de clientas) ---------------- */
const optStr = (v, max) => v === undefined || v === null || (typeof v === 'string' && v.length <= max);
const num = (v, max) => v === undefined || v === null || v === '' || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max);
const isoTs = v => v === undefined || v === null || v === '' || (typeof v === 'string' && !Number.isNaN(Date.parse(v)));

/** "10:00", "9:30", "10:00 AM", "1:05 pm" → "HH:MM" (24 h) o null. */
export function normTime(t) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*([ap])?\.?m?\.?\s*$/i.exec(String(t == null ? '' : t)); if (!m) return null;
  let h = +m[1]; const mi = +m[2]; if (mi > 59) return null;
  if (m[3]) { if (h < 1 || h > 12) return null; h = h % 12 + (m[3].toLowerCase() === 'p' ? 12 : 0); } else if (h > 23) return null;
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}

/** Devuelve { error } o { payload } ya normalizado. */
export function validate(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: 'El cuerpo debe ser un objeto JSON.' };
  if (!Array.isArray(b.bookings)) return { error: 'bookings debe ser una lista.' };
  if (b.bookings.length > MAX_ITEMS) return { error: `Demasiadas reservas (máx. ${MAX_ITEMS} por envío).` };
  if (!optStr(b.source, 40)) return { error: 'source inválido.' };
  const t = dayNum(todayNY()), seen = new Set(), out = [];
  for (let i = 0; i < b.bookings.length; i++) {
    const x = b.bookings[i], at = `bookings[${i}]`;
    if (!x || typeof x !== 'object' || Array.isArray(x)) return { error: `${at} debe ser un objeto.` };
    const id = typeof x.booking_id === 'number' && Number.isFinite(x.booking_id) ? String(x.booking_id) : x.booking_id;
    if (typeof id !== 'string' || !id.trim() || id.length > 100) return { error: `${at}.booking_id es obligatorio (texto de hasta 100 caracteres).` };
    if (seen.has(id)) return { error: `${at}.booking_id está repetido en el envío.` };
    seen.add(id);
    if (!STATUSES.includes(x.status)) return { error: `${at}.status debe ser booked, rescheduled, cancelled o no_show.` };
    if (!validDay(x.date)) return { error: `${at}.date debe ser una fecha AAAA-MM-DD válida.` };
    const dn = dayNum(x.date); if (dn < t - 90 || dn > t + 400) return { error: `${at}.date fuera de rango (de 90 días atrás a 400 adelante).` };
    const time = normTime(x.time); if (!time) return { error: `${at}.time debe ser HH:MM (o 10:00 AM).` };
    if (!optStr(x.client_name, 120) || !optStr(x.first_name, 80) || !optStr(x.last_name, 80)) return { error: `${at}: nombre demasiado largo o no es texto.` };
    if (!x.client_name && !x.first_name) return { error: `${at}: falta client_name (o first_name y last_name).` };
    const phone = x.phone == null ? '' : x.phone;
    if (typeof phone !== 'string') return { error: `${at}.phone debe ser texto.` };
    if (phone !== '' && !RE_PHONE.test(phone)) return { error: `${at}.phone debe estar en formato E.164 (por ejemplo +1XXXXXXXXXX) o vacío.` };
    if (!optStr(x.email, 120) || (x.email && !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;.]{2,}$/.test(x.email))) return { error: `${at}.email inválido.` };
    if (!optStr(x.service, 200) || !optStr(x.technique, 200) || !optStr(x.artist, 120) || !optStr(x.notes, 500)) return { error: `${at} tiene un campo demasiado largo o que no es texto.` };
    if (!num(x.price, 10000) || !num(x.addons_amount, 10000)) return { error: `${at}.price y addons_amount deben ser números de 0 a 10000.` };
    if (!(x.duration_min == null || (Number.isInteger(x.duration_min) && x.duration_min >= 0 && x.duration_min <= 1440))) return { error: `${at}.duration_min debe ser un entero de minutos (0 a 1440).` };
    if (!isoTs(x.modified_at)) return { error: `${at}.modified_at debe ser fecha y hora ISO 8601.` };
    let dep = null;
    if (x.deposit != null) {
      const d = x.deposit;
      if (typeof d !== 'object' || Array.isArray(d)) return { error: `${at}.deposit debe ser un objeto o null.` };
      if (typeof d.paid !== 'boolean') return { error: `${at}.deposit.paid debe ser true o false.` };
      if (!num(d.paid_amount, 1000)) return { error: `${at}.deposit.paid_amount debe ser un número de 0 a 1000.` };
      if (!optStr(d.receipt == null ? d.receipt : String(d.receipt), 60) || !isoTs(d.paid_at)) return { error: `${at}.deposit.receipt o paid_at inválido.` };
      dep = { paid: d.paid, paid_amount: d.paid_amount == null || d.paid_amount === '' ? null : d.paid_amount, receipt: d.receipt == null ? '' : String(d.receipt), paid_at: d.paid_at || '' };
    }
    out.push({ booking_id: id.trim(), status: x.status, date: x.date, time, duration_min: x.duration_min == null ? null : x.duration_min,
      client_name: x.client_name || '', first_name: x.first_name || '', last_name: x.last_name || '', phone, email: x.email || '',
      service: x.service || '', technique: x.technique || '', artist: x.artist || '', price: x.price == null || x.price === '' ? null : x.price, addons_amount: x.addons_amount == null || x.addons_amount === '' ? 0 : x.addons_amount,
      notes: x.notes || '', deposit: dep, ...(x.modified_at ? { modified_at: x.modified_at } : {}) });
  }
  return { payload: { source: b.source || 'booksy', bookings: out } };
}

/* ---------------- Supabase (solo la función fm_bi_ingest) ---------------- */
async function ingest(payload) {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, ''), key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(url) || !key) { console.error('booksy-bookings: faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); return { status: 500, body: { error: 'Servidor sin configurar.' } }; }
  let r;
  try { r = await fetch(`${url}/rest/v1/rpc/fm_bi_ingest`, { method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ p: payload }), signal: AbortSignal.timeout(15000) }); }
  catch { console.error('booksy-bookings: no se pudo conectar con Supabase'); return { status: 502, body: { error: 'No se pudo conectar con la base de datos.' } }; }
  let data = null; try { data = await r.json(); } catch { /* sin cuerpo */ }
  if (r.ok && data && data.ok) return { status: 200, body: { ok: true, inserted: data.inserted, updated: data.updated, unchanged: data.unchanged, stale: data.stale } };
  const code = data && data.code;
  console.error('booksy-bookings: Supabase respondió', r.status, code || '');   // solo estado y código; nunca el detalle (puede traer datos de clientas)
  if (code === 'P0001' && typeof data.message === 'string') return { status: 400, body: { error: data.message.slice(0, 200) } };
  if (code === 'PGRST202' || code === '42883') return { status: 500, body: { error: 'Falta instalar actualizacion-citas-booksy.sql en Supabase.' } };
  if (/^23/.test(code || '') || r.status === 400) return { status: 400, body: { error: 'El envío no cumple el esquema.' } };
  return { status: 502, body: { error: 'La base de datos no pudo guardar el envío.' } };
}

export default async (req, context) => {
  const ip = (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || 'x';
  if (req.method !== 'POST') return json({ error: 'Solo POST. La lectura y la revisión se hacen desde Fluffy Master con la sesión de la persona.' }, 405, { Allow: 'POST' });
  if (throttled(ip)) return json({ error: 'Demasiados intentos. Espera unos minutos.' }, 429, { 'Retry-After': '600' });
  const auth = authorized(req);
  if (auth === 'config') return json({ error: 'Servidor sin configurar.' }, 500);
  if (!auth) { noteFail(ip); return json({ error: 'No autorizado.' }, 401, { 'WWW-Authenticate': 'Bearer realm="fluffy-master-booksy"' }); }
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

export const _test = { validate, authorized, todayNY, normTime };
