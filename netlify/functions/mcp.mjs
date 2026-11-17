/* =====================================================================
   Fluffy Master · Servidor MCP remoto (SOLO LECTURA)
   Endpoint:  https://admin.fluffylashesco.com/mcp   (también /api/mcp)

   - Protocolo MCP "Streamable HTTP", sin sesión (cada POST es independiente).
   - Autenticación: llave API en el encabezado  Authorization: Bearer <llave>  (o  X-API-Key).
   - Solo hace SELECT a la tabla `docs` de Supabase y devuelve NÚMEROS AGREGADOS.
     Nunca devuelve nombres, teléfonos, correos, comisiones ni notas de clientas.
   - Sin dependencias (usa fetch y crypto nativos de Node 18+).

   Variables de entorno (Netlify → Site configuration → Environment variables):
     SUPABASE_URL                 https://xxxx.supabase.co
     SUPABASE_SERVICE_ROLE_KEY    llave secreta de Supabase (NUNCA en el repositorio)
     MCP_API_KEY                  llave(s) de acceso, mínimo 32 caracteres; varias separadas por coma
     SALON_TZ                     (opcional) zona horaria del salón. Por defecto America/New_York
     MCP_ALLOW_QUERY_KEY          (opcional) "1" permite ?key=... en la URL (menos seguro; ver README)
   ===================================================================== */
import { createHash, timingSafeEqual } from 'node:crypto';

export const config = { path: ['/mcp', '/api/mcp'] };

const SERVER = { name: 'fluffy-master', title: 'Fluffy Master (solo lectura)', version: '1.0.0' };
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY = 64 * 1024;
const MAX_RANGE_DAYS = 400;
const PAGE = 1000, MAX_PAGES = 10;

/* ---------------- utilidades ---------------- */
const r2 = v => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const sha = s => createHash('sha256').update(String(s)).digest();
const tz = () => process.env.SALON_TZ || 'America/New_York';
const RE_DAY = /^\d{4}-\d{2}-\d{2}$/;

const dayNum = iso => { const [y, m, d] = iso.split('-').map(Number); return Math.floor(Date.UTC(y, m - 1, d) / 864e5); };
const dayIso = n => new Date(n * 864e5).toISOString().slice(0, 10);
const validDay = iso => RE_DAY.test(iso) && dayIso(dayNum(iso)) === iso;
const addDays = (iso, k) => dayIso(dayNum(iso) + k);
/** fecha local (zona del salón) de un instante ISO; si ya es solo fecha, se respeta */
const localDay = v => {
  if (!v) return null; const s = String(v);
  if (RE_DAY.test(s)) return s;
  const t = new Date(s); if (isNaN(t)) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
};
const todayIso = () => localDay(new Date().toISOString());
/** semana de Fluffy: viernes a jueves (igual que la app) */
const weekOf = iso => { const dow = new Date(dayNum(iso) * 864e5).getUTCDay(); const s = dayNum(iso) - ((dow - 5 + 7) % 7); return [dayIso(s), dayIso(s + 6)]; };
const monthOf = iso => { const [y, m] = iso.split('-').map(Number); return [`${y}-${String(m).padStart(2, '0')}-01`, dayIso(Math.floor(Date.UTC(y, m, 0) / 864e5))]; };
const inRange = (d, from, to) => !!d && d >= from && d <= to;

/** Periodos pedidos → { nombre: [desde, hasta] }. Sin argumentos: día, semana y mes de hoy. */
function periodsFrom(args) {
  const a = args || {}, ref = a.date ? String(a.date) : todayIso();
  if (!validDay(ref)) throw new UserError('La fecha debe tener el formato AAAA-MM-DD.');
  const p = a.period || 'all', out = {};
  if (p === 'day' || p === 'all') out.day = [ref, ref];
  if (p === 'week' || p === 'all') out.week = weekOf(ref);
  if (p === 'month' || p === 'all') out.month = monthOf(ref);
  if (p === 'range') {
    if (!validDay(String(a.from || '')) || !validDay(String(a.to || ''))) throw new UserError('Para period="range" escribe from y to (AAAA-MM-DD).');
    if (a.from > a.to) throw new UserError('"from" no puede ser posterior a "to".');
    if (dayNum(a.to) - dayNum(a.from) > MAX_RANGE_DAYS) throw new UserError(`El rango máximo es de ${MAX_RANGE_DAYS} días.`);
    out.range = [a.from, a.to];
  }
  if (!Object.keys(out).length) throw new UserError('period debe ser day, week, month, range o all.');
  return out;
}
const unionRange = ps => { const all = Object.values(ps).flat().sort(); return [all[0], all[all.length - 1]]; };

class UserError extends Error {}

/* ---------------- acceso a Supabase (solo SELECT sobre docs) ---------------- */
function sbConfig() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, ''), key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(url) || !key) { console.error('MCP: faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); throw new Error('config'); }
  return { url, key };
}
/**
 * fields: { alias: 'ruta' } → select=alias:data->>ruta ; si la ruta empieza con "@" devuelve JSON (data->ruta)
 * filters: lista de [columna, "op.valor"] ; and: lista de condiciones dentro de and=(…)
 */
async function selectDocs(collection, fields, { filters = [], order = 'id.asc', limit = null } = {}) {
  const { url, key } = sbConfig(), headers = { apikey: key, Accept: 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key;      // llave antigua (JWT); las sb_secret_ solo van en apikey
  const jpath = (p, asJson) => { const parts = p.split('.'), last = parts.pop(); return 'data' + parts.map(x => '->' + x).join('') + (asJson ? '->' : '->>') + last; };
  const sel = Object.entries(fields).map(([a, p]) => `${a}:${p[0] === '@' ? jpath(p.slice(1), true) : jpath(p, false)}`).join(',');
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ select: sel, collection: 'eq.' + collection, order, limit: String(limit || PAGE), offset: String(page * PAGE) });
    for (const [k, v] of filters) q.append(k, v);
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
    let res; try { res = await fetch(`${url}/rest/v1/docs?${q}`, { headers, signal: ctl.signal }); } finally { clearTimeout(timer); }
    if (!res.ok) { console.error('MCP: Supabase respondió', res.status, collection); throw new Error('db'); }
    const data = await res.json(); rows.push(...data);
    if (limit || data.length < PAGE) return rows;
  }
  console.error('MCP: demasiados registros en', collection); throw new UserError('Hay demasiados registros para este rango; usa un rango más corto.');
}
const dayFilter = (from, to, f = 'date') => [['and', `(data->>${f}.gte.${from},data->>${f}.lte.${to})`]];

async function loadMoney(from, to) {
  const [sales, moves, notePays, pkgs, orders] = await Promise.all([
    selectDocs('sales', { date: 'date', price: 'price', discount: 'discount', tip: 'tip', method: 'paymentMethod', deposit: 'depositAmount', depositMethod: 'depositMethod', payGroup: 'payGroup', payments: '@payments' }, { filters: dayFilter(from, to) }),
    selectDocs('inventoryMoves', { date: 'date', qty: 'qty', price: 'unitPrice', method: 'method', payGroup: 'payGroup', payLead: 'payLead', payments: '@payments' }, { filters: [['data->>type', 'eq.Venta en salón'], ...dayFilter(from, to)] }),
    selectDocs('notePayments', { date: 'date', amount: 'amount', method: 'method' }, { filters: dayFilter(from, to) }),
    selectDocs('packages', { date: 'date', total: 'total', tip: 'tipTotal', method: 'method', payments: '@payments' }, { filters: dayFilter(from, to) }),
    // pedidos en línea: cuentan cuando se envían o entregan, por esa fecha (como el Resumen de la app)
    selectDocs('onlineOrders', { status: 'status', payMethod: 'payMethod', shippedAt: 'shippedAt', deliveredAt: 'deliveredAt', date: 'date', subtotal: 'subtotal', feePayment: 'fees.payment', feeOther: 'fees.other' }, { filters: [['data->>status', 'in.(Enviado,Entregado)']] }),
  ]);
  return { sales, moves, notePays, pkgs, orders };
}
async function firstSaleDay() {
  const r = await selectDocs('sales', { date: 'date' }, { order: 'data->>date.asc', limit: 1 });
  return r[0] && RE_DAY.test(r[0].date || '') ? r[0].date : null;
}

/* ---------------- cálculo (mismas reglas que el Resumen de ventas de la app) ---------------- */
const arr = v => Array.isArray(v) ? v : [];
function money(data, from, to) {
  const S = data.sales.filter(s => inRange(s.date, from, to)), M = data.moves.filter(m => inRange(m.date, from, to)),
    N = data.notePays.filter(p => inRange(p.date, from, to)), K = data.pkgs.filter(p => inRange(p.date, from, to)),
    O = data.orders.filter(o => inRange(localDay(o.shippedAt || o.deliveredAt || o.date), from, to));
  let ventas = 0, descuentos = 0, tips = 0; S.forEach(s => { ventas += num(s.price); descuentos += num(s.discount); tips += num(s.tip); });
  const servicios = r2(ventas - descuentos), productos = r2(M.reduce((t, m) => t + num(m.qty) * num(m.price), 0)),
    lashistas = r2(N.reduce((t, p) => t + num(p.amount), 0)), online = r2(O.reduce((t, o) => t + num(o.subtotal) - num(o.feePayment) - num(o.feeOther), 0)),
    paquetes = r2(K.reduce((t, p) => t + num(p.total) + num(p.tip), 0));
  // dinero recibido, por forma de pago (igual que "Dinero recibido" del Resumen)
  const parts = [], add = (m, v) => parts.push([m || 'Sin registrar', num(v)]);
  S.forEach(s => {
    if (s.method === 'Paquete prepagado' || s.payGroup) return;
    const tot = r2(num(s.price) - num(s.discount) + num(s.tip)), dep = Math.min(num(s.deposit), tot), pays = arr(s.payments);
    if (dep) add(s.depositMethod, dep);
    if (pays.length > 1) { pays.forEach(p => add(p.method, p.amount)); return; }
    if (tot - dep) add(s.method, tot - dep);
  });
  K.forEach(p => { const pays = arr(p.payments); pays.length > 1 ? pays.forEach(q => add(q.method, q.amount)) : add(p.method, num(p.total) + num(p.tip)); });
  M.forEach(m => { if (m.payGroup) { if (m.payLead) arr(m.payments).forEach(q => add(q.method, q.amount)); } else add(m.method, num(m.qty) * num(m.price)); });
  N.forEach(p => add(p.method, p.amount));
  O.forEach(o => add(o.payMethod || 'PayPal', num(o.subtotal) - num(o.feePayment) - num(o.feeOther)));
  const byMethod = {}; parts.forEach(([m, v]) => { byMethod[m] = r2((byMethod[m] || 0) + v); });
  return {
    desde: from, hasta: to,
    revenue: r2(servicios + tips + productos + lashistas + online),
    cash_collected: r2(parts.reduce((t, p) => t + p[1], 0)),
    desglose_revenue: { servicios_netos: servicios, propinas: r2(tips), productos_salon: productos, insumos_a_lashistas_cobrados: lashistas, tienda_web_neta: online },
    servicios_realizados: S.length, descuentos_en_servicios: r2(descuentos), paquetes_vendidos: paquetes, pedidos_en_linea: O.length,
    cash_por_forma_de_pago: Object.fromEntries(Object.entries(byMethod).sort((a, b) => b[1] - a[1])),
  };
}
const noShowPct = (done, ns) => done + ns ? Math.round(ns / (done + ns) * 1000) / 10 : null;

async function loadAppointments(from, to) {
  const [byDate, byCreated] = await Promise.all([
    selectDocs('appointments', { date: 'date', status: 'status' }, { filters: dayFilter(from, to) }),
    // createdAt es un instante UTC: se pide con un día de margen y se filtra por fecha local
    selectDocs('appointments', { createdAt: 'createdAt', status: 'status' }, { filters: dayFilter(addDays(from, -1), addDays(to, 3), 'createdAt') }),
  ]);
  return { byDate, byCreated };
}
function apptStats(data, from, to) {
  const A = data.byDate.filter(a => inRange(a.date, from, to)), cnt = st => A.filter(a => a.status === st).length;
  const done = cnt('Pagada'), ns = cnt('No-show'), canc = cnt('Cancelada'), pend = cnt('Agendada');
  const created = data.byCreated.filter(a => inRange(localDay(a.createdAt), from, to));
  return {
    desde: from, hasta: to,
    nuevas_citas: created.length, nuevas_citas_sin_canceladas: created.filter(a => a.status !== 'Cancelada').length,
    citas_en_el_periodo: A.length, completadas: done, no_shows: ns, canceladas: canc, agendadas_pendientes: pend,
    no_show_pct: noShowPct(done, ns),
  };
}

/* ---------------- herramientas ---------------- */
const periodSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    period: { type: 'string', enum: ['day', 'week', 'month', 'range', 'all'], description: 'Periodo. Por omisión "all" = día, semana (vie–jue) y mes de la fecha dada.' },
    date: { type: 'string', description: 'Fecha de referencia AAAA-MM-DD (por omisión, hoy en la zona del salón).' },
    from: { type: 'string', description: 'Inicio AAAA-MM-DD (solo con period="range").' },
    to: { type: 'string', description: 'Fin AAAA-MM-DD (solo con period="range").' },
  },
};
const NOT_TRACKED = {
  academy_enrollments: 'La app todavía no registra inscripciones a la Academy.',
  new_reviews: 'La app todavía no registra reseñas.',
  new_leads: 'La app todavía no registra leads.',
  close_rate: 'No se puede calcular: la app no registra leads.',
};
const NOTES = [
  'Revenue = servicios netos (precio − descuento) + propinas + productos vendidos en salón + insumos cobrados a lashistas + tienda web neta (producto menos comisión de pago). Es el "Total del periodo" del Resumen de ventas.',
  'cash_collected = dinero realmente recibido en el periodo (incluye depósitos aplicados, paquetes y pagos de lashistas; no incluye sesiones de paquetes ya pagadas antes).',
  'Solo incluye lo registrado en la app (no el histórico importado de Excel).',
];

const TOOLS = [
  {
    name: 'get_revenue', title: 'Revenue e ingresos',
    description: 'Revenue y dinero cobrado (cash collected) del salón para el día, la semana (viernes a jueves) y el mes, con desglose por origen y forma de pago. Solo totales; sin datos de clientas.',
    inputSchema: periodSchema,
    async run(args) {
      const ps = periodsFrom(args), [from, to] = unionRange(ps), [data, first] = await Promise.all([loadMoney(from, to), firstSaleDay()]);
      return { zona_horaria: tz(), periodos: Object.fromEntries(Object.entries(ps).map(([k, [f, t]]) => [k, { ...money(data, f, t), ...(first && f < first ? { parcial: `La app tiene ventas desde ${first}; antes de esa fecha las cifras están incompletas.` } : {}) }])), notas: NOTES };
    },
  },
  {
    name: 'get_appointments', title: 'Citas: nuevas, completadas y no-shows',
    description: 'Número de citas nuevas (creadas en el periodo), completadas (cobradas), no-shows, canceladas y pendientes, más el % de no-shows (no-shows ÷ (completadas + no-shows)). Solo conteos.',
    inputSchema: periodSchema,
    async run(args) {
      const ps = periodsFrom(args), [from, to] = unionRange(ps), data = await loadAppointments(from, to);
      return { zona_horaria: tz(), periodos: Object.fromEntries(Object.entries(ps).map(([k, [f, t]]) => [k, apptStats(data, f, t)])), notas: ['nuevas_citas cuenta las citas creadas en el periodo (por la fecha en que se agendaron); las demás cifras son de citas cuya fecha cae en el periodo.', 'completadas = citas en estado Pagada.'] };
    },
  },
  {
    name: 'get_academy_enrollments', title: 'Inscripciones a la Academy',
    description: 'Inscripciones a la Academy. La app todavía no las registra, por lo que devuelve disponible=false.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    async run() { return { disponible: false, valor: null, motivo: NOT_TRACKED.academy_enrollments }; },
  },
  {
    name: 'get_dashboard_metrics', title: 'Métricas clave del dashboard',
    description: 'Revenue, cash collected, nuevas citas, % de no-shows y, cuando existan en la app, Academy enrollments, reseñas nuevas, leads nuevos y close rate (hoy devuelven null con el motivo).',
    inputSchema: periodSchema,
    async run(args) {
      const ps = periodsFrom(args), [from, to] = unionRange(ps), [m, a, first] = await Promise.all([loadMoney(from, to), loadAppointments(from, to), firstSaleDay()]);
      const periodos = {};
      for (const [k, [f, t]] of Object.entries(ps)) {
        const mm = money(m, f, t), aa = apptStats(a, f, t);
        periodos[k] = { desde: f, hasta: t, revenue: mm.revenue, cash_collected: mm.cash_collected, nuevas_citas: aa.nuevas_citas, no_show_pct: aa.no_show_pct, completadas: aa.completadas, no_shows: aa.no_shows,
          academy_enrollments: null, new_reviews: null, new_leads: null, close_rate: null, ...(first && f < first ? { parcial: `La app tiene ventas desde ${first}; antes de esa fecha las cifras están incompletas.` } : {}) };
      }
      return { zona_horaria: tz(), periodos, no_disponibles_en_la_app: NOT_TRACKED, notas: NOTES };
    },
  },
];
const READONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/* ---------------- protocolo JSON-RPC / MCP ---------------- */
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
async function dispatch(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcErr(msg && msg.id, -32600, 'Solicitud inválida');
  const { id, method, params } = msg, isNote = id === undefined || id === null;
  if (isNote) return null;                                  // notificaciones (p. ej. notifications/initialized): sin respuesta
  const ok = result => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize': {
      const want = params && params.protocolVersion;
      return ok({ protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER,
        instructions: 'Datos del salón Fluffy Lashes, solo lectura y solo totales. Zona horaria del salón: ' + tz() + '. La semana va de viernes a jueves.' });
    }
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS.map(t => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, ...READONLY } })) });
    case 'tools/call': {
      const tool = TOOLS.find(t => t.name === (params && params.name));
      if (!tool) return rpcErr(id, -32602, 'Herramienta desconocida');
      try {
        const data = await tool.run((params && params.arguments) || {});
        return ok({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data, isError: false });
      } catch (e) {
        const text = e instanceof UserError ? e.message : 'No se pudieron leer los datos en este momento. Intenta de nuevo en unos minutos.';
        if (!(e instanceof UserError)) console.error('MCP tool error:', tool.name, e && e.message);
        return ok({ content: [{ type: 'text', text }], isError: true });
      }
    }
    default: return rpcErr(id, -32601, 'Método no soportado');
  }
}

/* ---------------- seguridad HTTP ---------------- */
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-API-Key, Mcp-Session-Id, MCP-Protocol-Version, Accept', 'Access-Control-Max-Age': '600' };
const json = (obj, status = 200, extra = {}) => new Response(obj === null ? null : JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...CORS, ...extra } });

const fails = new Map();                                     // límite simple de intentos fallidos por IP (por instancia)
const throttled = ip => { const f = fails.get(ip); return !!f && f.n >= 10 && Date.now() - f.t < 10 * 60e3; };
const noteFail = ip => { const f = fails.get(ip), now = Date.now(); fails.set(ip, f && now - f.t < 10 * 60e3 ? { n: f.n + 1, t: f.t } : { n: 1, t: now }); if (fails.size > 500) fails.clear(); };

function authorized(req) {
  const keys = (process.env.MCP_API_KEY || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!keys.length || keys.some(k => k.length < 32)) { console.error('MCP: MCP_API_KEY ausente o menor a 32 caracteres'); return 'config'; }
  const h = req.headers.get('authorization') || '', bearer = /^Bearer\s+(.+)$/i.exec(h);
  let given = bearer ? bearer[1].trim() : (req.headers.get('x-api-key') || '').trim();
  if (!given && process.env.MCP_ALLOW_QUERY_KEY === '1') given = (new URL(req.url).searchParams.get('key') || '').trim();
  if (!given) return false;
  const g = sha(given); let ok = false;
  for (const k of keys) if (timingSafeEqual(g, sha(k))) ok = true;   // tiempo constante
  return ok;
}

export default async (req, context) => {
  const ip = (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || 'x';
  if (req.method === 'OPTIONS') return json(null, 204);
  if (req.method !== 'POST') return json({ error: 'Usa POST (este servidor MCP no ofrece transmisión SSE).' }, 405, { Allow: 'POST, OPTIONS' });
  if (throttled(ip)) return json({ error: 'Demasiados intentos. Espera unos minutos.' }, 429, { 'Retry-After': '600' });
  const auth = authorized(req);
  if (auth === 'config') return json({ error: 'Servidor MCP sin configurar.' }, 500);
  if (!auth) { noteFail(ip); return json({ error: 'No autorizado.' }, 401, { 'WWW-Authenticate': 'Bearer realm="fluffy-master-mcp"' }); }

  const len = Number(req.headers.get('content-length') || 0); if (len > MAX_BODY) return json({ error: 'Solicitud demasiado grande.' }, 413);
  let text; try { text = await req.text(); } catch { return json(rpcErr(null, -32700, 'Error de lectura'), 400); }
  if (text.length > MAX_BODY) return json({ error: 'Solicitud demasiado grande.' }, 413);
  let body; try { body = JSON.parse(text); } catch { return json(rpcErr(null, -32700, 'JSON inválido'), 400); }
  if (Array.isArray(body)) {
    if (!body.length || body.length > 20) return json(rpcErr(null, -32600, 'Lote inválido'), 400);
    const out = (await Promise.all(body.map(dispatch))).filter(Boolean);
    return out.length ? json(out) : json(null, 202);
  }
  const res = await dispatch(body);
  return res ? json(res) : json(null, 202);
};

export const _test = { money, apptStats, periodsFrom, weekOf, monthOf, dispatch, authorized, localDay };
