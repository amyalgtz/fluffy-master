/* =====================================================================
   Fluffy Master · Carga de «Mensajes a clientas» (SOLO ESCRITURA de este recurso)
   Endpoint:  POST https://admin.fluffylashesco.com/api/reception-messages
   Encabezado: X-API-Key: <llave de carga>   (también acepta Authorization: Bearer <llave>)

   - Es la única forma de CREAR o REEMPLAZAR lotes. La pantalla de Fluffy Master solo los lee y marca «enviado» con la sesión
     de la persona (reglas RLS en Supabase); aquí no hay lectura ni borrado: GET, PATCH y DELETE responden 405.
   - La llave de carga es distinta de la del MCP: no lee citas, ventas ni otras tablas, y solo puede llamar a fm_rm_ingest.
   - Nunca envía SMS ni programa envíos. Solo guarda los textos que ya redactó el asistente de la agenda.
   - No registra teléfonos, nombres ni textos en los logs.
   - Sin dependencias (fetch y crypto nativos de Node 18+).

   Variables de entorno (Netlify → Site configuration → Environment variables):
     SUPABASE_URL                 https://xxxx.supabase.co            (la misma del MCP)
     SUPABASE_SERVICE_ROLE_KEY    llave secreta de Supabase           (la misma del MCP; NUNCA en el repositorio)
     RECEPTION_INGEST_KEY         llave(s) de carga, mínimo 32 caracteres; varias separadas por coma (para rotar sin cortes)
   ===================================================================== */
import { createHash, timingSafeEqual } from 'node:crypto';

export const config = { path: ['/api/reception-messages'] };

const MAX_BODY = 1024 * 1024;           // 1 MB (300 mensajes de ~2 KB caben de sobra)
const MAX_MSGS = 300;
const KINDS = ['24h', 'hoy', '2h'];
const TYPES = ['reminder', 'deposit', 'special'];
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
const rateLimited = ip => { const now = Date.now(), h = (hits.get(ip) || []).filter(t => now - t < 60e3); h.push(now); hits.set(ip, h); if (hits.size > 500) hits.clear(); return h.length > 30; };   // 30 cargas por minuto

function authorized(req) {
  const keys = (process.env.RECEPTION_INGEST_KEY || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!keys.length || keys.some(k => k.length < 32)) { console.error('reception-messages: RECEPTION_INGEST_KEY ausente o menor a 32 caracteres'); return 'config'; }
  const h = req.headers.get('authorization') || '', bearer = /^Bearer\s+(.+)$/i.exec(h);
  const given = bearer ? bearer[1].trim() : (req.headers.get('x-api-key') || '').trim();
  if (!given) return false;
  const g = sha(given); let ok = false;
  for (const k of keys) if (timingSafeEqual(g, sha(k))) ok = true;   // tiempo constante
  return ok;
}

/* ---------------- validación (los mensajes de error nunca repiten datos de clientas) ---------------- */
const optStr = (v, max) => v === undefined || v === null || (typeof v === 'string' && v.length <= max);

/** Devuelve { error } o { payload } ya normalizado. */
export function validate(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: 'El cuerpo debe ser un objeto JSON.' };
  if (!KINDS.includes(b.kind)) return { error: 'kind debe ser 24h, hoy o 2h.' };
  if (!validDay(b.date)) return { error: 'date debe ser una fecha AAAA-MM-DD válida.' };
  const t = dayNum(todayNY());
  if (dayNum(b.date) < t - 30 || dayNum(b.date) > t + 60) return { error: 'date fuera de rango (de 30 días atrás a 60 días adelante).' };
  if (!optStr(b.label, 80)) return { error: 'label demasiado largo (máx. 80).' };
  if (!optStr(b.timezone, 60) || !optStr(b.source, 40)) return { error: 'timezone o source inválidos.' };
  if (b.generated_at != null && (typeof b.generated_at !== 'string' || Number.isNaN(Date.parse(b.generated_at)))) return { error: 'generated_at debe ser una fecha y hora ISO 8601.' };
  if (!Array.isArray(b.messages)) return { error: 'messages debe ser una lista.' };
  if (b.messages.length > MAX_MSGS) return { error: `Demasiados mensajes (máx. ${MAX_MSGS} por lote).` };
  const seen = new Set(), msgs = [];
  for (let i = 0; i < b.messages.length; i++) {
    const m = b.messages[i], at = `messages[${i}]`;
    if (!m || typeof m !== 'object' || Array.isArray(m)) return { error: `${at} debe ser un objeto.` };
    if (typeof m.id !== 'string' || !m.id || m.id.length > 200) return { error: `${at}.id es obligatorio (texto de hasta 200 caracteres).` };
    if (seen.has(m.id)) return { error: `${at}.id está repetido en el lote.` };
    seen.add(m.id);
    if (!TYPES.includes(m.type)) return { error: `${at}.type debe ser reminder, deposit o special.` };
    if (typeof m.text !== 'string' || !m.text.trim() || m.text.length > 2000) return { error: `${at}.text es obligatorio (hasta 2000 caracteres).` };
    if (!optStr(m.client_name, 120) || !optStr(m.first_name, 80)) return { error: `${at}.client_name o first_name demasiado largo.` };
    let phone = m.phone == null ? '' : m.phone;
    if (typeof phone !== 'string') return { error: `${at}.phone debe ser texto.` };
    if (phone !== '' && !RE_PHONE.test(phone)) return { error: `${at}.phone debe estar en formato E.164 (por ejemplo +1XXXXXXXXXX) o vacío.` };
    if (m.deposit_status != null && m.deposit_status !== '' && !['paid', 'missing'].includes(m.deposit_status)) return { error: `${at}.deposit_status debe ser paid o missing.` };
    if (!optStr(m.time, 20) || !optStr(m.send_at, 20) || !optStr(m.service, 200) || !optStr(m.artist, 120) || !optStr(m.title, 200) || !optStr(m.subtitle, 300)) return { error: `${at} tiene un campo demasiado largo o que no es texto.` };
    msgs.push({ id: m.id, type: m.type, client_name: m.client_name || '', first_name: m.first_name || '', phone, time: m.time || '', service: m.service || '', artist: m.artist || '', deposit_status: m.deposit_status || '', send_at: m.send_at || '', title: m.title || '', subtitle: m.subtitle || '', text: m.text });
  }
  return { payload: { date: b.date, kind: b.kind, label: b.label || '', timezone: b.timezone || TZ, source: b.source || 'booksy', generated_at: b.generated_at || null, messages: msgs } };
}

/* ---------------- Supabase (solo la función fm_rm_ingest) ---------------- */
async function ingest(payload) {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, ''), key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(url) || !key) { console.error('reception-messages: faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); return { status: 500, body: { error: 'Servidor sin configurar.' } }; }
  let r;
  try { r = await fetch(`${url}/rest/v1/rpc/fm_rm_ingest`, { method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ p: payload }), signal: AbortSignal.timeout(15000) }); }
  catch { console.error('reception-messages: no se pudo conectar con Supabase'); return { status: 502, body: { error: 'No se pudo conectar con la base de datos.' } }; }
  let data = null; try { data = await r.json(); } catch { /* sin cuerpo */ }
  if (r.ok && data && data.ok) return { status: 200, body: { ok: true, date: data.date, kind: data.kind, upserted: data.upserted } };
  const code = data && data.code;
  console.error('reception-messages: Supabase respondió', r.status, code || '');   // solo estado y código; nunca el detalle (puede traer datos de clientas)
  if (code === 'P0001' && typeof data.message === 'string') return { status: 400, body: { error: data.message.slice(0, 200) } };   // mensajes propios de fm_rm_ingest (sin datos)
  if (code === 'PGRST202' || code === '42883') return { status: 500, body: { error: 'Falta instalar actualizacion-mensajes-clientas.sql en Supabase.' } };
  if (/^23/.test(code || '') || r.status === 400) return { status: 400, body: { error: 'El lote no cumple el esquema.' } };
  return { status: 502, body: { error: 'La base de datos no pudo guardar el lote.' } };
}

export default async (req, context) => {
  const ip = (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || 'x';
  if (req.method !== 'POST') return json({ error: 'Solo POST. La lectura y el estado de «enviado» se hacen desde Fluffy Master con la sesión de la persona.' }, 405, { Allow: 'POST' });
  if (throttled(ip)) return json({ error: 'Demasiados intentos. Espera unos minutos.' }, 429, { 'Retry-After': '600' });
  const auth = authorized(req);
  if (auth === 'config') return json({ error: 'Servidor sin configurar.' }, 500);
  if (!auth) { noteFail(ip); return json({ error: 'No autorizado.' }, 401, { 'WWW-Authenticate': 'Bearer realm="fluffy-master-mensajes"' }); }
  if (rateLimited(ip)) return json({ error: 'Demasiadas cargas seguidas. Espera un minuto.' }, 429, { 'Retry-After': '60' });

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

export const _test = { validate, authorized, todayNY };
