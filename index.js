require('dotenv').config();
const express  = require('express');
const axios    = require('axios');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const xmlrpc   = require('xmlrpc');
const twilio   = require('twilio');
const googleTrends = require('google-trends-api');
const multer = require('multer');
const XLSX = require('xlsx');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const SERVER_START = new Date().toISOString();
const DEPLOY_COMMIT = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0,7) || 'local';

app.get('/api/version', (req, res) => res.json({ started: SERVER_START, commit: DEPLOY_COMMIT, uptime: Math.round(process.uptime()) + 's' }));

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // disabled because of inline scripts in index.html
  crossOriginEmbedderPolicy: false,
}));

// HTTPS redirect in production (Railway)
app.use((req, res, next) => {
  if (process.env.RAILWAY_ENVIRONMENT && req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect('https://' + req.get('host') + req.url);
  }
  next();
});

// Rate limiting on auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // max 20 login attempts per 15 min
  message: { error: 'Demasiados intentos. Esperá 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/auth/login', authLimiter);
app.use('/auth/google', authLimiter);

// General rate limiting
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200, // 200 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(generalLimiter);

app.use(express.json({ limit: '25mb' }));
const PORT = process.env.PORT || 3000;

// ── Sesiones (persistidas en disco) ──
const SESSIONS_FILE = path.join(__dirname, 'data', 'sessions.json');
const sessions = new Map();

// Cargar sesiones de disco al arrancar
try {
  if (fs.existsSync(SESSIONS_FILE)) {
    const saved = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    for (const [k, v] of Object.entries(saved)) {
      if (v.expiresAt > Date.now()) sessions.set(k, v);
    }
    console.log(`[sessions] ${sessions.size} sesiones cargadas de disco`);
  }
} catch {}

function saveSessions() {
  try {
    const obj = {};
    for (const [k, v] of sessions) obj[k] = v;
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj), 'utf8');
  } catch {}
}

function getSession(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expiresAt < Date.now()) { sessions.delete(token); saveSessions(); return null; }
  return s;
}

const { CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, ANTHROPIC_API_KEY } = process.env;
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
const ML_AUTH_URL = 'https://auth.mercadolibre.com.uy';
const ML_API_URL = 'https://api.mercadolibre.com';

let tokenData      = null;
let cachedClaims   = [];
let pendingRedirect = '/';

// ── Persistencia del token ML ────────────────────────────────────
const TOKEN_FILE = path.join(__dirname, 'data', 'ml_token.json');
function saveToken(data) {
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(data), 'utf8'); } catch(e) {}
}
function loadToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const t = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      if (t?.access_token) { tokenData = t; console.log('[token] cargado desde disco'); }
    }
  } catch(e) {}
}
loadToken();

// Cache de publicaciones (se carga una sola vez, persiste en disco)
let cachedItemIds = [];
let cachedItems   = [];
const STOCK_FILE  = path.join(__dirname, 'data', 'stock_cache.json');

function loadStockFromDisk() {
  try {
    if (fs.existsSync(STOCK_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STOCK_FILE, 'utf8'));
      cachedItems   = saved.items   || [];
      cachedItemIds = cachedItems.map(i => i.id);
      console.log(`[stock] cache cargado desde disco: ${cachedItems.length} publicaciones`);
    }
  } catch(e) { console.error('[stock] error leyendo cache:', e.message); }
}

function saveStockToDisk() {
  try {
    fs.writeFileSync(STOCK_FILE, JSON.stringify({ items: cachedItems, savedAt: new Date().toISOString() }), 'utf8');
  } catch(e) { console.error('[stock] error guardando cache:', e.message); }
}

// Stats históricos por mes — { 'YYYY-MM': { count, revenue, units, by_status, lastFetched } }
let monthlyStats = {};
let syncState    = { running: false, done: false, progress: 0, total: 36, currentMonth: null, error: null };

const MONTHLY_FILE = path.join(__dirname, 'data', 'monthly_cache.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function pad(n) { return String(n).padStart(2, '0'); }

function loadMonthlyFromDisk() {
  try {
    if (fs.existsSync(MONTHLY_FILE)) {
      monthlyStats = JSON.parse(fs.readFileSync(MONTHLY_FILE, 'utf8'));
      const n = Object.keys(monthlyStats).length;
      if (n > 0) { syncState.done = true; syncState.progress = n; }
      console.log(`[historico] cargado desde disco: ${n} meses`);
    }
  } catch(e) { console.error('[historico] error leyendo cache:', e.message); }
}

function saveMonthlyToDisk() {
  try {
    if (!fs.existsSync(path.dirname(MONTHLY_FILE))) fs.mkdirSync(path.dirname(MONTHLY_FILE), { recursive: true });
    fs.writeFileSync(MONTHLY_FILE, JSON.stringify(monthlyStats), 'utf8');
  } catch(e) { console.error('[historico] error guardando cache:', e.message); }
}

const syncLogs = [];
function syncLog(msg) {
  console.log(msg);
  syncLogs.push({ time: new Date().toISOString(), msg });
  if (syncLogs.length > 200) syncLogs.shift();
}

function getAllMonthsSince2015() {
  const now = new Date();
  const months = [];
  const start = new Date(2015, 0, 1);
  const d = new Date(start);
  while (d <= now) {
    months.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
    d.setMonth(d.getMonth() + 1);
  }
  return months;
}

// Barrido completo mes a mes usando paginación por fecha.
async function runSync(force = false) {
  if (syncState.running) return;

  const headers = { Authorization: `Bearer ${tokenData.access_token}` };
  const uid = tokenData.user_id;

  // Determinar qué meses faltan
  const now = new Date();
  const currentKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const allMonths = getAllMonthsSince2015();
  const pending = force
    ? allMonths
    : allMonths.filter(({ year, month }) => {
        const key = `${year}-${pad(month)}`;
        return !monthlyStats[key] || key === currentKey;
      });

  if (!pending.length) { syncState.done = true; return; }

  syncLog(`[historico] iniciando sync de ${pending.length} meses (force=${force})`);
  syncState = { running: true, done: false, progress: 0, total: pending.length, currentMonth: null, error: null };

  const PAID = new Set(['paid', 'confirmed']);
  let totalFetched = 0;

  for (let mi = 0; mi < pending.length; mi++) {
    const { year, month } = pending[mi];
    const key = `${year}-${pad(month)}`;
    syncState.currentMonth = key;
    syncState.progress = mi;

    const from = `${year}-${pad(month)}-01T00:00:00.000-03:00`;
    const lastDay = new Date(year, month, 0).getDate();
    const to = `${year}-${pad(month)}-${pad(lastDay)}T23:59:59.000-03:00`;

    let allOrders = [];
    let offset = 0;

    while (true) {
      try {
        const r = await axios.get(`${ML_API_URL}/orders/search`, {
          headers,
          params: {
            seller: uid, limit: 50, offset, sort: 'date_desc',
            'order.date_created.from': from,
            'order.date_created.to': to,
          }
        });
        const results = r.data.results || [];
        allOrders = allOrders.concat(results);
        offset += 50;
        if (results.length < 50) break;
        await sleep(200);
      } catch(e) {
        console.error(`[historico] error ${key} offset ${offset}:`, e.response?.status || e.message);
        break;
      }
    }

    if (!allOrders.length && year < now.getFullYear() - 1) {
      // Mes sin órdenes y antiguo, no guardar para no llenar de ceros
      continue;
    }

    const paid = allOrders.filter(o => PAID.has(o.status));
    const by_status = {};
    for (const o of allOrders) by_status[o.status] = (by_status[o.status] || 0) + 1;

    monthlyStats[key] = {
      count: allOrders.length,
      revenue: paid.reduce((s, o) => s + (o.total_amount || 0), 0),
      units: paid.reduce((s, o) => s + (o.order_items || []).reduce((q, oi) => q + (oi.quantity || 1), 0), 0),
      by_status,
      lastFetched: new Date().toISOString(),
    };

    totalFetched += allOrders.length;
    syncLog(`[historico] ${key} — ${allOrders.length} órdenes, $${Math.round(monthlyStats[key].revenue).toLocaleString('es-UY')}`);

    // Guardar a disco cada 6 meses para no perder progreso
    if (mi % 6 === 5) saveMonthlyToDisk();
  }

  saveMonthlyToDisk();
  syncLog(`[historico] ✅ sync completo — ${totalFetched} órdenes, ${Object.keys(monthlyStats).length} meses`);
  syncState.running = false;
  syncState.done = true;
  syncState.progress = pending.length;
  syncState.currentMonth = null;
}

loadMonthlyFromDisk();
loadStockFromDisk();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// PKCE helpers
let pkceVerifier = null;
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}
function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// GET /login
app.get('/login', (req, res) => {
  pkceVerifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(pkceVerifier);
  const authUrl =
    `${ML_AUTH_URL}/authorization` +
    `?response_type=code` +
    `&client_id=${CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=read_orders+offline_access` +
    `&code_challenge=${challenge}` +
    `&code_challenge_method=S256`;
  res.redirect(authUrl);
});

// GET /callback
app.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'Falta el parámetro code' });
  try {
    const response = await axios.post(`${ML_API_URL}/oauth/token`, {
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: pkceVerifier,
    });
    pkceVerifier = null;
    tokenData = response.data;
    saveToken(tokenData);
    // Arrancar refreshes en background
    runSync();
    refreshStockCache();
    const dest = pendingRedirect || '/';
    pendingRedirect = '/';
    res.redirect(dest);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener el token', detail: err.response?.data || err.message });
  }
});

function requireToken(req, res, next) {
  // Verificar sesión de usuario
  const sessionTok = req.headers['x-session-token'] || req.query._token;
  if (sessionTok && !getSession(sessionTok)) {
    return res.status(401).json({ error: 'Sesión inválida' });
  }
  if (!tokenData?.access_token) {
    const isHtml = req.headers.accept?.includes('text/html');
    if (isHtml) {
      pendingRedirect = req.originalUrl;
      return res.redirect('/login');
    }
    return res.status(401).json({ error: 'No autenticado con ML' });
  }
  next();
}

app.get('/api/auth-status', (req, res) => {
  res.json({ authenticated: !!tokenData?.access_token });
});

app.get('/api/user', requireToken, async (req, res) => {
  try {
    const r = await axios.get(`${ML_API_URL}/users/${tokenData.user_id}`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// GET /api/sync — inicia sync en background
app.get('/api/sync', requireToken, (req, res) => {
  const force = req.query.force === 'true';
  if (!syncState.running) runSync(force);
  res.json({ started: true, state: syncState });
});

// GET /api/sync/status
app.get('/api/sync/status', requireToken, (req, res) => {
  res.json({ ...syncState, cached: Object.keys(monthlyStats).length, logs: syncLogs.slice(-30) });
});

// GET /api/ordenes — siempre desde ML en tiempo real con paginación
app.get('/api/ordenes', requireToken, async (req, res) => {
  const offset = parseInt(req.query.offset) || 0;
  const limit  = Math.min(parseInt(req.query.limit) || 50, 50);
  try {
    const r = await axios.get(`${ML_API_URL}/orders/search`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
      params: { seller: tokenData.user_id, offset, limit, sort: 'date_desc' },
    });
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// GET /api/stats — KPIs desde muestra reciente + gráfico desde monthlyStats si existe
app.get('/api/stats', requireToken, async (req, res) => {
  try {
    // Muestra reciente para KPIs (últimas 200 órdenes)
    const pages = await Promise.all(
      [0, 50, 100, 150].map(o =>
        axios.get(`${ML_API_URL}/orders/search`, {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
          params: { seller: tokenData.user_id, offset: o, limit: 50, sort: 'date_desc' },
        })
      )
    );

    const recentOrders = pages.flatMap(p => p.data.results || []);
    const total = pages[0].data.paging?.total || 0;

    const byStatus = {};
    const byMonthRecent = {};
    recentOrders.forEach(o => {
      byStatus[o.status] = (byStatus[o.status] || 0) + 1;
      const d   = new Date(o.date_created);
      const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
      if (!byMonthRecent[key]) byMonthRecent[key] = { count: 0, amount: 0 };
      byMonthRecent[key].count++;
      byMonthRecent[key].amount += o.total_amount || 0;
    });

    const totalRevenue = recentOrders
      .filter(o => o.status === 'paid')
      .reduce((s, o) => s + (o.total_amount || 0), 0);

    // Usar monthlyStats para el gráfico si ya se sincronizó
    let byMonth = byMonthRecent;
    let synced  = false;
    let historicRevenue = 0;
    let historicUnits   = 0;
    if (Object.keys(monthlyStats).length > 0) {
      byMonth = {};
      Object.entries(monthlyStats).forEach(([k, v]) => {
        byMonth[k] = { count: v.count, amount: v.revenue, units: v.units || 0 };
        historicRevenue += v.revenue || 0;
        historicUnits   += v.units   || 0;
      });
      synced = true;
    }

    res.json({
      total_orders: total, total_revenue: totalRevenue,
      historic_revenue: historicRevenue, historic_units: historicUnits,
      by_status: byStatus, by_month: byMonth,
      synced, sync_months: Object.keys(monthlyStats).length,
    });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// POST /notifications — webhook de MercadoLibre (claims, orders, etc.)
app.post('/notifications', async (req, res) => {
  // ML requiere respuesta 200 inmediata
  res.sendStatus(200);

  const { topic, resource } = req.body || {};
  if (!resource || !tokenData?.access_token) return;

  // Solo procesar notificaciones de reclamos
  if (topic !== 'claims' && topic !== 'claims_actions') return;

  // El resource viene como "/post-purchase/v1/claims/5281510459"
  const claimId = String(resource).split('/').pop();
  if (!claimId || isNaN(claimId)) return;

  try {
    const r = await axios.get(`${ML_API_URL}/post-purchase/v1/claims/${claimId}`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const claim = r.data;
    const idx = cachedClaims.findIndex(c => c.id === claim.id);
    if (idx >= 0) cachedClaims[idx] = claim; // actualizar si ya existe
    else cachedClaims.unshift(claim);         // agregar nuevo al inicio
    console.log(`[claim] ${topic} — ID ${claimId} guardado (total: ${cachedClaims.length})`);
  } catch (e) {
    console.error(`[claim] Error al obtener claim ${claimId}:`, e.response?.data || e.message);
  }
});

// GET /api/reclamos — reclamos acumulados por notificaciones
app.get('/api/reclamos', requireToken, (req, res) => {
  const offset = parseInt(req.query.offset) || 0;
  const limit  = parseInt(req.query.limit)  || 50;
  const status = req.query.status || '';

  let claims = cachedClaims;
  if (status) claims = claims.filter(c => c.status === status);

  res.json({
    data: claims.slice(offset, offset + limit),
    paging: { total: claims.length, offset, limit },
  });
});

// GET /api/reclamos/stats
app.get('/api/reclamos/stats', requireToken, (req, res) => {
  const byStatus = {};
  const byType   = {};
  const byReason = {};

  cachedClaims.forEach(c => {
    byStatus[c.status] = (byStatus[c.status] || 0) + 1;
    byType[c.type]     = (byType[c.type]     || 0) + 1;
    if (c.resolution?.reason) byReason[c.resolution.reason] = (byReason[c.resolution.reason] || 0) + 1;
  });

  res.json({ total: cachedClaims.length, by_status: byStatus, by_type: byType, by_reason: byReason });
});

// GET /api/reclamos/scan — escanea órdenes canceladas y carga reclamos históricos
let scanState = { running: false, done: false, checked: 0, total: 0, found: 0, error: null };

async function runClaimsScan(months = 3) {
  if (scanState.running) return;
  scanState = { running: true, done: false, checked: 0, total: 0, found: 0, error: null };

  const headers = { Authorization: `Bearer ${tokenData.access_token}` };
  const from = new Date();
  from.setMonth(from.getMonth() - months);
  const fromStr = from.toISOString().slice(0, 19) + '.000-00:00';

  try {
    // Traer total de órdenes canceladas
    const first = await axios.get(`${ML_API_URL}/orders/search`, {
      headers, params: { seller: tokenData.user_id, 'order.status': 'cancelled', 'date_created.from': fromStr, limit: 1 },
    });
    scanState.total = first.data.paging?.total || 0;

    let offset = 0;
    while (offset < scanState.total) {
      const r = await axios.get(`${ML_API_URL}/orders/search`, {
        headers, params: { seller: tokenData.user_id, 'order.status': 'cancelled', 'date_created.from': fromStr, offset, limit: 50 },
      });
      const orders = r.data.results || [];

      await Promise.all(orders.map(async o => {
        try {
          const cr = await axios.get(`${ML_API_URL}/post-purchase/v1/claims/search`, {
            headers, params: { resource_id: o.id, resource: 'order', limit: 10 },
          });
          const claims = cr.data.data || [];
          claims.forEach(claim => {
            const exists = cachedClaims.find(c => c.id === claim.id);
            if (!exists) { cachedClaims.push(claim); scanState.found++; }
          });
        } catch {}
        scanState.checked++;
      }));

      offset += 50;
      await sleep(200);
    }

    cachedClaims.sort((a, b) => new Date(b.date_created) - new Date(a.date_created));
  } catch (e) {
    scanState.error = e.message;
  }

  scanState.running = false;
  scanState.done = true;
}

app.get('/api/reclamos/scan', requireToken, (req, res) => {
  const months = parseInt(req.query.months) || 3;
  if (!scanState.running) runClaimsScan(months);
  res.json({ started: true, state: scanState });
});

app.get('/api/reclamos/scan/status', requireToken, (req, res) => {
  res.json(scanState);
});

// GET /api/debug/order-claims — busca claims en órdenes canceladas recientes
app.get('/api/debug/order-claims', requireToken, async (req, res) => {
  const headers = { Authorization: `Bearer ${tokenData.access_token}` };
  const uid = tokenData.user_id;

  // Traer 10 órdenes canceladas
  const ordersRes = await axios.get(`${ML_API_URL}/orders/search`, {
    headers, params: { seller: uid, 'order.status': 'cancelled', limit: 10, sort: 'date_desc' },
  });
  const orders = ordersRes.data.results || [];

  const results = await Promise.all(orders.map(async o => {
    try {
      const r = await axios.get(`${ML_API_URL}/post-purchase/v1/claims/search`, {
        headers, params: { resource_id: o.id, resource: 'order', limit: 5 },
      });
      return { order_id: o.id, total_claims: r.data.paging?.total, claims: r.data.data };
    } catch (e) {
      return { order_id: o.id, error: e.response?.data?.error };
    }
  }));

  res.json({ orders_checked: orders.length, results });
});

let cachedStock     = [];   // resultado final procesado
let cachedVariationSkuMap = {};  // SKU variante → publicación
let stockFetching   = false;
let stockLastUpdate = null;
const STOCK_RESULT_FILE = path.join(__dirname, 'data', 'stock_result.json');

// Cargar resultado de stock desde disco
try {
  if (fs.existsSync(STOCK_RESULT_FILE)) {
    const s = JSON.parse(fs.readFileSync(STOCK_RESULT_FILE, 'utf8'));
    cachedStock     = s.items     || [];
    stockLastUpdate = s.savedAt   || null;
    console.log(`[stock] resultado cargado desde disco: ${cachedStock.length} items`);
  }
} catch(e) { console.error('[stock] error leyendo resultado:', e.message); }

async function refreshStockCache(forceRefresh = false) {
  if (stockFetching) return;
  if (!tokenData?.access_token) return;
  stockFetching = true;
  console.log(`[stock] iniciando refresh (force=${forceRefresh})`);

  const headers = { Authorization: `Bearer ${tokenData.access_token}` };
  const uid = tokenData.user_id;

  try {
    let items;

    if (cachedItems.length > 0 && !forceRefresh) {
      console.log(`[stock] actualizando stock de ${cachedItems.length} items cacheados`);
      const allIds = cachedItems.map(i => i.id);
      const freshItems = [];
      for (let i = 0; i < allIds.length; i += 20) {
        const batch = allIds.slice(i, i + 20);
        const r = await axios.get(`${ML_API_URL}/items`, { headers, params: { ids: batch.join(','), include_attributes: 'all' } });
        const details = (r.data || []).map(e => e.body).filter(Boolean);
        freshItems.push(...details);
        await sleep(100);
      }
      items = freshItems;
      cachedItems = items;
    } else {
      // Carga completa: traer IDs + detalles de publicaciones
      console.log(`[stock] ${forceRefresh ? 'Refresh forzado' : 'Primera carga'}: trayendo lista de publicaciones...`);

      async function fetchItemIds(status) {
        const ids = [];
        // Primera página para saber el total
        const first = await axios.get(`${ML_API_URL}/users/${uid}/items/search`, {
          headers, params: { status, limit: 50, offset: 0 },
        });
        const total = first.data.paging?.total || 0;
        ids.push(...(first.data.results || []));
        console.log(`[stock] ${status}: ${ids.length}/${total}`);

        // Páginas siguientes en paralelo
        const offsets = [];
        for (let o = 50; o < total; o += 50) offsets.push(o);

        for (let i = 0; i < offsets.length; i += 5) {
          const batch = offsets.slice(i, i + 5);
          const pages = await Promise.allSettled(
            batch.map(o => axios.get(`${ML_API_URL}/users/${uid}/items/search`, {
              headers, params: { status, limit: 50, offset: o },
            }))
          );
          pages.forEach(p => {
            if (p.status === 'fulfilled') ids.push(...(p.value.data.results || []));
          });
          console.log(`[stock] ${status}: ${ids.length}/${total}`);
          await sleep(150);
        }
        return ids;
      }

      const [activeIds, pausedIds] = await Promise.all([fetchItemIds('active'), fetchItemIds('paused')]);
      const allIds = [...new Set([...activeIds, ...pausedIds])];
      cachedItemIds = allIds;
      console.log(`[stock] Total IDs únicos: ${allIds.length}`);

      items = [];
      for (let i = 0; i < allIds.length; i += 20) {
        const batch = allIds.slice(i, i + 20);
        const r = await axios.get(`${ML_API_URL}/items`, { headers, params: { ids: batch.join(','), include_attributes: 'all' } });
        const details = (r.data || []).map(e => e.body).filter(Boolean);
        items.push(...details);
        await sleep(100);
      }
      cachedItems = items;
      saveStockToDisk();
    }

    // 3. Traer TODAS las órdenes de los últimos 30 días en batches paralelos
    const from30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 19) + '.000-00:00';

    const firstPage = await axios.get(`${ML_API_URL}/orders/search`, {
      headers,
      params: { seller: uid, 'date_created.from': from30, offset: 0, limit: 50, sort: 'date_asc' },
    });
    const total30 = firstPage.data.paging?.total || 0;
    const allPages = [firstPage.data.results || []];

    const MAX_OFFSET = 9950; // ML no permite offset + limit > 10000
    const offsets = [];
    for (let o = 50; o <= Math.min(total30 - 50, MAX_OFFSET); o += 50) offsets.push(o);

    const BATCH = 10;
    for (let i = 0; i < offsets.length; i += BATCH) {
      const pages = await Promise.allSettled(
        offsets.slice(i, i + BATCH).map(o =>
          axios.get(`${ML_API_URL}/orders/search`, {
            headers,
            params: { seller: uid, 'date_created.from': from30, offset: o, limit: 50, sort: 'date_asc' },
          })
        )
      );
      pages.forEach(p => {
        if (p.status === 'fulfilled') allPages.push(p.value.data.results || []);
      });
      await sleep(200);
    }

    const salesByItem = {};
    allPages.flat().forEach(order => {
      (order.order_items || []).forEach(oi => {
        const id = oi.item?.id;
        if (id) salesByItem[id] = (salesByItem[id] || 0) + (oi.quantity || 1);
      });
    });

    // 4. Traer nombres de categorías únicas
    const categoryIds = [...new Set(items.map(i => i.category_id).filter(Boolean))];
    const categoryNames = {};
    await Promise.all(categoryIds.map(async id => {
      try {
        const r = await axios.get(`${ML_API_URL}/categories/${id}`, { headers });
        categoryNames[id] = r.data.name;
      } catch { categoryNames[id] = id; }
    }));

    // 5. Calcular días de stock sin factor de escala (datos exactos)
    const result = items.map(item => {
      const sold30d   = salesByItem[item.id] || 0;
      const dailyRate = sold30d / 30;
      const stock     = item.available_quantity || 0;
      const daysLeft  = dailyRate > 0 ? Math.round(stock / dailyRate) : null;

      return {
        id:            item.id,
        title:         item.title,
        thumbnail:     item.thumbnail,
        price:         item.price,
        currency:      item.currency_id,
        status:        item.status,
        category_id:   item.category_id,
        category_name: categoryNames[item.category_id] || item.category_id || 'Sin categoría',
        stock,
        sold30d,
        daily_rate: parseFloat(dailyRate.toFixed(2)),
        days_left:  daysLeft,
        permalink:  item.permalink,
        sku: (item.attributes || []).find(a => a.id === 'SELLER_SKU')?.value_name
          || (item.attributes || []).find(a => a.id === 'SELLER_SKU')?.values?.[0]?.name
          || null,
        variations: (item.variations || []).map(v => ({
          id: v.id,
          name: (v.attribute_combinations || []).map(a => a.value_name).join(', '),
          stock: v.available_quantity || 0,
          sku: (v.attributes || []).find(a => a.id === 'SELLER_SKU')?.value_name || null,
        })),
        original_price:  item.original_price || null,
        logistic_type:   item.shipping?.logistic_type || null,
        shipping_mode:   item.shipping?.mode || null,
        free_shipping:   item.shipping?.free_shipping || false,
      };
    });

    // Ordenar: sin stock → crítico por días → poco stock físico → warning → ok → sin ventas
    result.sort((a, b) => {
      const score = item => {
        if (item.stock === 0)                                   return 0;
        if (item.days_left !== null && item.days_left < 7)     return 1;
        if (item.stock <= 5)                                    return 2;
        if (item.days_left !== null && item.days_left <= 30)   return 3;
        if (item.stock <= 15)                                   return 4;
        if (item.days_left !== null)                            return 5;
        return 6;
      };
      const sa = score(a), sb = score(b);
      if (sa !== sb) return sa - sb;
      return (a.days_left ?? a.stock) - (b.days_left ?? b.stock);
    });

    cachedStock     = result;
    stockLastUpdate = new Date().toISOString();

    // Build variation SKU → publication index
    cachedVariationSkuMap = {};
    for (const item of result) {
      for (const v of (item.variations || [])) {
        if (v.sku) cachedVariationSkuMap[v.sku] = item;
      }
    }
    console.log(`[stock] variation SKU map: ${Object.keys(cachedVariationSkuMap).length} SKUs`);

    fs.writeFileSync(STOCK_RESULT_FILE, JSON.stringify({ items: result, savedAt: stockLastUpdate }), 'utf8');
    console.log(`[stock] refresh completo — ${result.length} items`);
  } catch(err) {
    console.error('[stock] error en refresh:', err.response?.data || err.message);
  } finally {
    stockFetching = false;
  }
}

// Cron: actualizar stock cada 20 minutos
setInterval(() => refreshStockCache(), 20 * 60 * 1000);

// Cron: refrescar token ML cada 5 horas (expira a las 6h)
async function refreshMLToken() {
  if (!tokenData?.refresh_token) return;
  try {
    const r = await axios.post(`${ML_API_URL}/oauth/token`, {
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: tokenData.refresh_token,
    });
    tokenData = r.data;
    saveToken(tokenData);
    console.log('[token] ML token refrescado OK');
  } catch(e) {
    console.error('[token] error refrescando ML token:', e.response?.data || e.message);
  }
}
setInterval(refreshMLToken, 5 * 60 * 60 * 1000);
// Refrescar al arrancar si ya hay token guardado
if (tokenData?.refresh_token) refreshMLToken();

// ── Estrategia ML: datos de pricing ──
const ESTRATEGIA_FILE = path.join(__dirname, 'data', 'estrategia_log.json');
function loadEstrategiaLog() { try { return fs.existsSync(ESTRATEGIA_FILE) ? JSON.parse(fs.readFileSync(ESTRATEGIA_FILE, 'utf8')) : { campaigns: [], log: [] }; } catch { return { campaigns: [], log: [] }; } }
function saveEstrategiaLog(data) { fs.writeFileSync(ESTRATEGIA_FILE, JSON.stringify(data, null, 2)); }

app.get('/api/estrategia/item/:itemId', requireToken, async (req, res) => {
  try {
    const itemId = req.params.itemId;
    const token = tokenData?.access_token;
    if (!token) return res.status(401).json({ error: 'Sin token ML' });

    // Item details
    const itemRes = await fetch(`https://api.mercadolibre.com/items/${itemId}`, { headers: { Authorization: `Bearer ${token}` } });
    const item = await itemRes.json();

    // Visits last 30 days
    const visitsRes = await fetch(`https://api.mercadolibre.com/items/${itemId}/visits/time_window?last=30&unit=days`, { headers: { Authorization: `Bearer ${token}` } });
    const visits30 = await visitsRes.json();

    // Visits last 7 days
    const visits7Res = await fetch(`https://api.mercadolibre.com/items/${itemId}/visits/time_window?last=7&unit=days`, { headers: { Authorization: `Bearer ${token}` } });
    const visits7 = await visits7Res.json();

    // ML fees
    const feesRes = await fetch(`https://api.mercadolibre.com/sites/MLU/listing_prices?price=${item.price}&listing_type_id=${item.listing_type_id}&category_id=${item.category_id}`, { headers: { Authorization: `Bearer ${token}` } });
    const fees = await feesRes.json();

    // Log history
    const logData = loadEstrategiaLog();
    const campaignLog = logData.log.filter(l => l.item_id === itemId);

    res.json({
      item: {
        id: item.id,
        title: item.title,
        price: item.price,
        original_price: item.original_price,
        available_quantity: item.available_quantity,
        sold_quantity: item.sold_quantity,
        status: item.status,
        listing_type_id: item.listing_type_id,
        permalink: item.permalink,
        thumbnail: item.thumbnail,
        shipping_free: item.shipping?.free_shipping || false,
        category_id: item.category_id,
      },
      visits_30d: visits30.total_visits || 0,
      visits_7d: visits7.total_visits || 0,
      fees: {
        percentage: fees.sale_fee_details?.percentage_fee || 0,
        fixed: fees.sale_fee_details?.fixed_fee || 0,
        total: fees.sale_fee_amount || 0,
      },
      log: campaignLog,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/estrategia/price', requireToken, async (req, res) => {
  try {
    const { itemId, price, original_price } = req.body;
    const token = tokenData?.access_token;
    const body = { price };
    if (original_price) body.original_price = original_price;
    const r = await fetch(`https://api.mercadolibre.com/items/${itemId}`, {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await r.json();
    // Log
    const logData = loadEstrategiaLog();
    logData.log.push({ item_id: itemId, action: 'price_change', price, original_price: original_price || null, date: new Date().toISOString() });
    saveEstrategiaLog(logData);
    res.json({ ok: true, price: result.price, original_price: result.original_price });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/estrategia/shipping', requireToken, async (req, res) => {
  try {
    const { itemId, free_shipping } = req.body;
    const token = tokenData?.access_token;
    const r = await fetch(`https://api.mercadolibre.com/items/${itemId}`, {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ shipping: { free_shipping } }),
    });
    const result = await r.json();
    const logData = loadEstrategiaLog();
    logData.log.push({ item_id: itemId, action: 'shipping_change', free_shipping, date: new Date().toISOString() });
    saveEstrategiaLog(logData);
    res.json({ ok: true, free_shipping: result.shipping?.free_shipping });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Notebook: consultas con IA sobre datos del negocio ──
app.post('/api/notebook/query', requireToken, async (req, res) => {
  try {
    if (!anthropic) return res.status(400).json({ error: 'ANTHROPIC_API_KEY no configurada' });
    const { question, history } = req.body;
    if (!question) return res.status(400).json({ error: 'Sin pregunta' });

    // Get available data context
    const products = odooCache || [];
    const productSummary = products.slice(0, 20).map(p => `${p.default_code}: ${p.name} (stock: ${p.qty_available}, precio: ${p.list_price})`).join('\n');
    const categories = [...new Set(products.map(p => Array.isArray(p.categ_id) ? p.categ_id[1] : '').filter(Boolean))].sort();

    // Build Odoo query function for Claude
    const uid = await odooAuth();

    const systemPrompt = `Sos un analista de datos de un e-commerce uruguayo (MUNDO SHOP). Tenés acceso a datos de Odoo (ERP) con productos, ventas, stock.

DATOS DISPONIBLES:
- ${products.length} productos en Odoo
- Categorías: ${categories.slice(0, 30).join(', ')}
- Vendedores: Mateo (ID 2, MercadoLibre), Gustavo (17) y Omar (18, Mayorista), Giorgina/Atención al cliente (8), Tatiana (9), Rodrigo (14), Agustin (15) = WhatsApp, POS = Local
- Modelos Odoo: sale.order.line (ventas), product.product (productos), pos.order.line (POS), stock.move (movimientos)
- Moneda: UYU (pesos uruguayos)

Ejemplos de productos:
${productSummary}

INSTRUCCIONES:
1. Respondé la pregunta del usuario con datos concretos
2. Generá una respuesta JSON con este formato exacto:
{
  "text": "Explicación en texto con los datos",
  "table": { "headers": ["Col1","Col2"], "rows": [["val1","val2"]] } | null,
  "chart": { "type": "bar|line|pie|doughnut", "title": "Título", "labels": ["A","B"], "datasets": [{ "label": "Serie", "data": [1,2], "backgroundColor": "#color" }] } | null,
  "queries": [{ "model": "sale.order.line", "method": "read_group", "domain": [...], "fields": [...], "groupby": [...] }]
}

3. En "queries" poné las queries de Odoo que necesitás para responder. Yo las ejecuto y te devuelvo los resultados.
4. Si necesitás datos, SIEMPRE incluí queries. No inventes números.
5. Para fechas usá formato YYYY-MM-DD
6. Para ventas por mes usá groupby ['create_date:month']
7. Para ventas por producto usá groupby ['product_id']
8. Respondé SOLO con el JSON, sin texto adicional ni markdown.`;

    // First call: Claude decides what queries to run
    const msg1 = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [
        ...(history || []).slice(-4),
        { role: 'user', content: question }
      ],
    });

    let parsed;
    try {
      const raw = msg1.content[0].text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      parsed = JSON.parse(raw);
    } catch(e) {
      return res.json({ text: msg1.content[0].text, table: null, chart: null });
    }

    // Execute queries if any
    let queryResults = [];
    if (parsed.queries && parsed.queries.length > 0 && uid) {
      for (const q of parsed.queries.slice(0, 5)) {
        try {
          const result = await odooCall('/xmlrpc/2/object', 'execute_kw', [
            ODOO_DB, uid, ODOO_API_KEY, q.model, q.method || 'read_group',
            [q.domain || []],
            { fields: q.fields || [], groupby: q.groupby || [], lazy: false, ...(q.limit ? { limit: q.limit } : {}) },
          ]);
          queryResults.push({ query: q, result });
        } catch(e) {
          queryResults.push({ query: q, error: e.message });
        }
      }

      // Second call: Claude interprets results and generates chart/table
      const msg2 = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 3000,
        system: systemPrompt + '\n\nAhora tenés los resultados de las queries. Generá la respuesta final con texto, tabla y/o gráfica.',
        messages: [
          ...(history || []).slice(-4),
          { role: 'user', content: question },
          { role: 'assistant', content: JSON.stringify(parsed) },
          { role: 'user', content: 'Resultados de queries:\n' + JSON.stringify(queryResults, null, 2) + '\n\nGenerá la respuesta final con text, table y chart. Solo JSON.' },
        ],
      });

      try {
        const raw2 = msg2.content[0].text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        parsed = JSON.parse(raw2);
      } catch(e) {
        parsed.text = msg2.content[0].text;
      }
    }

    res.json({ text: parsed.text || '', table: parsed.table || null, chart: parsed.chart || null });
  } catch(e) {
    console.error('[notebook] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/estrategia/log', requireToken, (req, res) => {
  const { item_id, action, data } = req.body;
  const logData = loadEstrategiaLog();
  logData.log.push({ item_id, action, ...data, date: new Date().toISOString() });
  saveEstrategiaLog(logData);
  res.json({ ok: true });
});

// Tracker automático: snapshot cada hora de items monitoreados
const ESTRATEGIA_SNAPSHOTS_FILE = path.join(__dirname, 'data', 'estrategia_snapshots.json');
function loadSnapshots() { try { return fs.existsSync(ESTRATEGIA_SNAPSHOTS_FILE) ? JSON.parse(fs.readFileSync(ESTRATEGIA_SNAPSHOTS_FILE, 'utf8')) : []; } catch { return []; } }
function saveSnapshots(data) { fs.writeFileSync(ESTRATEGIA_SNAPSHOTS_FILE, JSON.stringify(data)); }

async function trackEstrategiaItems() {
  const logData = loadEstrategiaLog();
  const trackedItems = logData.tracked_items || ['MLU480822453']; // default: tolix metal negra
  const token = tokenData?.access_token;
  if (!token) return;

  const snapshots = loadSnapshots();
  for (const itemId of trackedItems) {
    try {
      const [itemRes, visits30Res, visits7Res] = await Promise.all([
        fetch(`https://api.mercadolibre.com/items/${itemId}`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`https://api.mercadolibre.com/items/${itemId}/visits/time_window?last=30&unit=days`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`https://api.mercadolibre.com/items/${itemId}/visits/time_window?last=7&unit=days`, { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      const item = await itemRes.json();
      const v30 = await visits30Res.json();
      const v7 = await visits7Res.json();

      snapshots.push({
        item_id: itemId,
        date: new Date().toISOString(),
        price: item.price,
        original_price: item.original_price || null,
        stock: item.available_quantity,
        sold_quantity: item.sold_quantity,
        visits_30d: v30.total_visits || 0,
        visits_7d: v7.total_visits || 0,
        free_shipping: item.shipping?.free_shipping || false,
        status: item.status,
      });
      console.log(`[estrategia] snapshot ${itemId}: precio=$${item.price} stock=${item.available_quantity} visitas30d=${v30.total_visits||0} vendidos=${item.sold_quantity}`);
    } catch (e) {
      console.error(`[estrategia] error tracking ${itemId}:`, e.message);
    }
  }
  saveSnapshots(snapshots);
}

// Ejecutar cada hora
setInterval(trackEstrategiaItems, 60 * 60 * 1000);
// Primera ejecución a los 30 segundos de arrancar
setTimeout(trackEstrategiaItems, 30000);

// Endpoint para ver snapshots
app.get('/api/estrategia/snapshots/:itemId', requireToken, (req, res) => {
  const snapshots = loadSnapshots().filter(s => s.item_id === req.params.itemId);
  res.json(snapshots);
});

// Endpoint para agregar/quitar items del tracking
app.post('/api/estrategia/track', requireToken, (req, res) => {
  const { itemId, track } = req.body;
  const logData = loadEstrategiaLog();
  if (!logData.tracked_items) logData.tracked_items = ['MLU480822453'];
  if (track && !logData.tracked_items.includes(itemId)) logData.tracked_items.push(itemId);
  if (!track) logData.tracked_items = logData.tracked_items.filter(i => i !== itemId);
  saveEstrategiaLog(logData);
  res.json({ ok: true, tracked: logData.tracked_items });
});

// GET /api/stock — devuelve cache inmediatamente, refresca en background si hace falta
app.get('/api/stock', requireToken, async (req, res) => {
  const forceRefresh = req.query.refresh === 'true';

  if (forceRefresh) {
    await refreshStockCache(true);
  } else if (!cachedStock.length) {
    // Sin cache: esperar a que termine (ya sea fetch en curso o uno nuevo)
    if (!stockFetching) refreshStockCache(false);
    while (stockFetching) await sleep(500);
  } else {
    // Hay cache: devolver inmediatamente y refrescar en background
    refreshStockCache(false);
  }

  // Agregar unidades en camino por SKU desde órdenes de compra
  const compras = loadCompras();
  const incoming = {}; // sku -> [{qty, expected_date, supplier, id}]
  for (const c of compras) {
    for (const it of (c.items || [])) {
      if (!it.sku) continue;
      if (!incoming[it.sku]) incoming[it.sku] = [];
      incoming[it.sku].push({ qty: it.qty, expected_date: c.expected_date, supplier: c.supplier, order_id: c.id });
    }
  }
  const itemsWithIncoming = cachedStock.map(item => ({
    ...item,
    incoming: incoming[item.sku] || [],
  }));

  res.json({ items: itemsWithIncoming, total_items: itemsWithIncoming.length, lastUpdated: stockLastUpdate });
});

// ── Órdenes de compra ────────────────────────────────────────────
const COMPRAS_FILE = path.join(__dirname, 'data', 'compras.json');

function loadCompras() {
  try {
    if (fs.existsSync(COMPRAS_FILE)) return JSON.parse(fs.readFileSync(COMPRAS_FILE, 'utf8'));
  } catch(e) {}
  return [];
}
function saveCompras(data) {
  fs.writeFileSync(COMPRAS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ── Análisis de precios ──────────────────────────────────────────
const PRECIOS_FILE = path.join(__dirname, 'data', 'precios_cache.json');
let preciosRunning = false;

app.get('/api/precios', requireToken, async (req, res) => {
  if (req.query.refresh === 'true') {
    if (!preciosRunning) runPreciosAnalysis();
    return res.json({ running: true, message: 'Análisis iniciado en background' });
  }

  // Devolver cache existente
  try {
    if (fs.existsSync(PRECIOS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PRECIOS_FILE, 'utf8'));
      return res.json({ running: preciosRunning, ...data });
    }
  } catch(e) {}
  res.json({ running: preciosRunning, items: [], savedAt: null });
});

async function runPreciosAnalysis() {
  if (preciosRunning) return;
  preciosRunning = true;
  console.log('[precios] iniciando análisis...');

  try {
    const headers = { Authorization: `Bearer ${tokenData.access_token}` };

    // Filtrar: stock > 90 días, sin ventas en 30 días, sin descuento
    const candidates = cachedStock.filter(item =>
      item.days_left !== null && item.days_left > 90 &&
      item.sold30d === 0 &&
      !item.original_price &&
      item.stock > 0
    );

    console.log(`[precios] ${candidates.length} candidatos (overstock + sin ventas + sin descuento)`);

    const results = [];

    for (const item of candidates) {
      try {
        // Buscar competidores: primeras 4 palabras del título + categoría
        const keywords = item.title.split(' ').slice(0, 4).join(' ');
        const searchRes = await axios.get(`${ML_API_URL}/sites/MLU/search`, {
          headers,
          params: { q: keywords, category: item.category_id, limit: 20 },
        });

        const prices = (searchRes.data.results || [])
          .filter(r => r.id !== item.id && r.price > 0)
          .map(r => r.price);

        if (prices.length < 3) { await sleep(200); continue; }

        prices.sort((a, b) => a - b);
        const median = prices[Math.floor(prices.length / 2)];
        const p25    = prices[Math.floor(prices.length * 0.25)];
        const p75    = prices[Math.floor(prices.length * 0.75)];
        const pctDiff = ((item.price - median) / median * 100);

        let status = 'ok';
        if (item.price > p75 * 1.1)  status = 'caro';
        if (item.price < p25 * 0.9)  status = 'barato';

        results.push({
          id:         item.id,
          title:      item.title,
          thumbnail:  item.thumbnail,
          permalink:  item.permalink,
          sku:        item.sku,
          price:      item.price,
          stock:      item.stock,
          days_left:  item.days_left,
          median,
          p25,
          p75,
          pct_diff:   parseFloat(pctDiff.toFixed(1)),
          status,
          competitors: prices.length,
        });

        await sleep(200); // respetar rate limit
      } catch(e) {
        await sleep(500);
      }
    }

    // Ordenar: primero los más fuera de rango
    results.sort((a, b) => Math.abs(b.pct_diff) - Math.abs(a.pct_diff));

    const data = { items: results, savedAt: new Date().toISOString(), total: results.length };
    fs.writeFileSync(PRECIOS_FILE, JSON.stringify(data, null, 2));
    console.log(`[precios] análisis completo: ${results.length} ítems analizados`);
  } catch(e) {
    console.error('[precios] error:', e.message);
  } finally {
    preciosRunning = false;
  }
}

// GET /api/compras
app.get('/api/compras', requireToken, (req, res) => {
  res.json(loadCompras());
});

// POST /api/compras — body: { supplier, expected_date, notes, items: [{sku, qty}] }
app.post('/api/compras', requireToken, express.json(), (req, res) => {
  const compras = loadCompras();
  const nueva = {
    id: Date.now().toString(),
    created_at: new Date().toISOString(),
    supplier:      req.body.supplier || 'China',
    expected_date: req.body.expected_date,
    notes:         req.body.notes || '',
    items:         req.body.items || [],
  };
  compras.push(nueva);
  saveCompras(compras);
  res.json(nueva);
});

// DELETE /api/compras/:id
app.delete('/api/compras/:id', requireToken, (req, res) => {
  const compras = loadCompras().filter(c => c.id !== req.params.id);
  saveCompras(compras);
  res.json({ ok: true });
});

// ── Cache de ventas ──────────────────────────────────────────────
const UY_OFFSET_MS  = 3 * 60 * 60 * 1000;
const CACHE_FILE    = path.join(__dirname, 'data', 'ventas_cache.json');
let ventasFetching  = {};

// Cargar cache desde disco al arrancar
let ventasCache = {};
try {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  if (fs.existsSync(CACHE_FILE)) {
    ventasCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    // Invalidar cache de 'today' si fue guardado en otro día
    if (ventasCache['today']) {
      const savedDay = new Date(ventasCache['today'].lastUpdated).toISOString().slice(0, 10);
      const todayDay = new Date(Date.now() - UY_OFFSET_MS).toISOString().slice(0, 10);
      if (savedDay !== todayDay) {
        delete ventasCache['today'];
        console.log('[cache] cache de hoy invalidado (día distinto)');
      }
    }
    console.log(`[cache] ventas cargado desde disco (${Object.keys(ventasCache).length} períodos)`);
  }
} catch(e) {
  console.warn('[cache] no se pudo leer cache de disco:', e.message);
  ventasCache = {};
}

function saveCacheToDisk() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(ventasCache), 'utf8');
  } catch(e) {
    console.warn('[cache] error al guardar cache:', e.message);
  }
}

function uyMidnightUTC(offsetDays = 0) {
  const uyNow = new Date(Date.now() - UY_OFFSET_MS);
  const y = uyNow.getUTCFullYear(), m = uyNow.getUTCMonth(), d = uyNow.getUTCDate() + offsetDays;
  return new Date(Date.UTC(y, m, d, 3, 0, 0, 0));
}
function toMLDateV(d) { return d.toISOString().slice(0, 19) + '.000-00:00'; }

function ventasDateRange(period, fromQ, toQ) {
  if (period === 'today') {
    return { from: toMLDateV(uyMidnightUTC(0)), to: toMLDateV(new Date(uyMidnightUTC(1).getTime() - 1000)) };
  }
  if (period === 'month') {
    const uyNow = new Date(Date.now() - UY_OFFSET_MS);
    return { from: toMLDateV(new Date(Date.UTC(uyNow.getUTCFullYear(), uyNow.getUTCMonth(), 1, 3, 0, 0, 0))), to: null };
  }
  if (period === '7' || period === '30' || period === '90') {
    return { from: toMLDateV(uyMidnightUTC(-parseInt(period))), to: null };
  }
  // custom
  const [fy, fm, fd] = (fromQ || '').split('-').map(Number);
  const [ty, tm, td] = (toQ   || '').split('-').map(Number);
  return {
    from: fy ? toMLDateV(new Date(Date.UTC(fy, fm-1, fd, 3, 0, 0, 0))) : toMLDateV(uyMidnightUTC(0)),
    to:   ty ? toMLDateV(new Date(Date.UTC(ty, tm-1, td+1, 3, 0, 0, 0) - 1000)) : null,
  };
}

async function fetchVentasData(period, fromQ, toQ) {
  if (!tokenData?.access_token) throw new Error('No autenticado');
  const headers = { Authorization: `Bearer ${tokenData.access_token}` };
  const uid = tokenData.user_id;
  const { from, to } = ventasDateRange(period, fromQ, toQ);

  const fromDate = new Date(from);
  const toDate   = to ? new Date(to) : new Date();

  // Hora UY actual para referencia
  const nowUY = new Date(Date.now() - UY_OFFSET_MS);
  console.log(`[ventas] ---- ${period} ----`);
  console.log(`[ventas] ahora UY:  ${nowUY.toISOString().slice(0,16)} (UTC-3)`);
  console.log(`[ventas] from:      ${from}  →  ${fromDate.toISOString()}`);
  console.log(`[ventas] to:        ${to || '(ahora)'}  →  ${toDate.toISOString()}`);

  const allOrders = [];
  let offset = 0, done = false;

  while (!done) {
    const r = await axios.get(`${ML_API_URL}/orders/search`, {
      headers, params: { seller: uid, limit: 50, sort: 'date_desc', offset },
    });
    const results = r.data.results || [];

    if (offset === 0 && results.length > 0) {
      const first = new Date(results[0].date_created);
      const last  = new Date(results[results.length - 1].date_created);
      console.log(`[ventas] pág 1: primera orden ${first.toISOString().slice(0,16)}, última ${last.toISOString().slice(0,16)}`);
    }

    // Procesar toda la página — ML no siempre ordena perfecto
    for (const order of results) {
      const d = new Date(order.date_created);
      if (d >= fromDate && d <= toDate) allOrders.push(order);
    }
    // Cortar solo cuando el último orden de la página es anterior a fromDate
    const lastD = results.length ? new Date(results[results.length - 1].date_created) : null;
    if (!lastD || lastD < fromDate || results.length < 50) done = true;
    offset += 50;
    if (offset > 9950) done = true;
    if (!done) await sleep(150);
  }

  const byStatusLog = {};
  allOrders.forEach(o => { byStatusLog[o.status] = (byStatusLog[o.status] || 0) + 1; });
  console.log(`[ventas] órdenes en rango: ${allOrders.length} | estados:`, JSON.stringify(byStatusLog));

  const PAID = new Set(['paid', 'confirmed']);
  const paidOrders      = allOrders.filter(o => PAID.has(o.status));
  const cancelledOrders = allOrders.filter(o => o.status === 'cancelled');
  const totalRevenue    = paidOrders.reduce((s, o) => s + (o.total_amount || 0), 0);
  const totalUnits      = paidOrders.reduce((s, o) =>
    s + (o.order_items || []).reduce((q, oi) => q + (oi.quantity || 1), 0), 0);
  const cancelRate      = allOrders.length > 0 ? (cancelledOrders.length / allOrders.length * 100) : 0;

  const byItem = {};
  paidOrders.forEach(order => {
    (order.order_items || []).forEach(oi => {
      const id = oi.item?.id;
      if (!id) return;
      if (!byItem[id]) byItem[id] = {
        id, title: oi.item.title || '', thumbnail: null, permalink: null,
        price: oi.unit_price || 0, currency: order.currency_id || 'UYU',
        listing_type: oi.listing_type_id || '', units: 0, revenue: 0,
      };
      byItem[id].units   += oi.quantity || 1;
      byItem[id].revenue += (oi.unit_price || 0) * (oi.quantity || 1);
    });
  });

  if (cachedItems.length > 0) {
    cachedItems.forEach(ci => {
      if (byItem[ci.id]) { byItem[ci.id].thumbnail = ci.thumbnail; byItem[ci.id].permalink = ci.permalink; }
    });
  } else {
    const ids = Object.keys(byItem);
    for (let i = 0; i < ids.length; i += 20) {
      try {
        const r = await axios.get(`${ML_API_URL}/items`, { headers, params: { ids: ids.slice(i, i+20).join(',') } });
        (r.data || []).forEach(e => {
          if (e.body && byItem[e.body.id]) { byItem[e.body.id].thumbnail = e.body.thumbnail; byItem[e.body.id].permalink = e.body.permalink; }
        });
      } catch {}
      await sleep(100);
    }
  }

  const items = Object.values(byItem).sort((a, b) => b.revenue - a.revenue);
  items.forEach(i => { i.participation = totalRevenue > 0 ? (i.revenue / totalRevenue * 100) : 0; });

  console.log(`[ventas] ${period} — ${paidOrders.length} pagadas, $${Math.round(totalRevenue).toLocaleString('es-UY')}`);
  return {
    period: { from, to },
    lastUpdated: new Date().toISOString(),
    metrics: {
      total_orders: allOrders.length, paid_orders: paidOrders.length,
      cancelled_orders: cancelledOrders.length, cancel_rate: parseFloat(cancelRate.toFixed(1)),
      total_units: totalUnits, total_revenue: parseFloat(totalRevenue.toFixed(2)),
      avg_ticket: parseFloat((paidOrders.length > 0 ? totalRevenue / paidOrders.length : 0).toFixed(2)),
      items_with_sales: items.length,
    },
    items,
  };
}

async function refreshVentasCache(period, fromQ, toQ) {
  const key = period + (fromQ || '') + (toQ || '');
  if (ventasFetching[key]) return;
  ventasFetching[key] = true;
  try {
    ventasCache[key] = await fetchVentasData(period, fromQ, toQ);
    saveCacheToDisk();
  } catch(e) {
    console.error(`[ventas] error refresh ${period}:`, e.message);
  } finally {
    ventasFetching[key] = false;
  }
}

// Auto-refresh "today" cada 5 minutos si hay sesión activa
setInterval(() => { if (tokenData?.access_token) refreshVentasCache('today'); }, 5 * 60 * 1000);

// GET /api/ventas
app.get('/api/ventas', requireToken, async (req, res) => {
  const period = req.query.period || 'today';
  const fromQ  = req.query.from  || null;
  const toQ    = req.query.to    || null;
  const key    = period + (fromQ || '') + (toQ || '');

  const forceRefresh = req.query.refresh === 'true';

  if (!forceRefresh && ventasCache[key]) {
    const ageMin = (Date.now() - new Date(ventasCache[key].lastUpdated)) / 60000;
    if (ageMin > 3) refreshVentasCache(period, fromQ, toQ);
    return res.json({ ...ventasCache[key], fromCache: true });
  }

  // Force refresh o primera vez: esperar la carga
  try {
    delete ventasCache[key]; // limpiar cache para forzar fetch fresco
    ventasCache[key] = await fetchVentasData(period, fromQ, toQ);
    res.json({ ...ventasCache[key], fromCache: false });
  } catch(err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// GET /api/tareas — preguntas sin responder + órdenes ME1/acuerda-con-comprador
app.get('/api/tareas', requireToken, async (req, res) => {
  const headers = { Authorization: `Bearer ${tokenData.access_token}` };
  const uid = tokenData.user_id;

  try {
    // 1. Preguntas sin responder de los últimos 7 días
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const qRes = await axios.get(`${ML_API_URL}/questions/search`, {
      headers,
      params: { seller_id: uid, status: 'UNANSWERED', sort_fields: 'date_created', sort_types: 'DESC', limit: 50 },
    });
    const allQuestions = qRes.data.questions || [];
    const recentQuestions = allQuestions.filter(q => q.date_created >= since7d);
    const rawQuestions = recentQuestions.map(q => ({
      id:           q.id,
      item_id:      q.item_id,
      text:         q.text,
      date_created: q.date_created,
      from_id:      q.from?.id || null,
    }));

    // Generar respuestas sugeridas con Claude
    console.log(`[tareas] anthropic=${!!anthropic} rawQuestions=${rawQuestions.length}`);
    let suggestions = {};
    if (anthropic && rawQuestions.length > 0) {
      try {
        const reglasPromptTareas = reglasTexto(filtrarReglasPorContexto(loadReglasNegocio(), 'tareas'));
        const prompt = `Sos el asistente de MUNDO SHOP, una tienda en MercadoLibre Uruguay.
Generá respuestas cortas y amigables a estas preguntas de compradores.
El estilo es: empezar con "Hola, ¿cómo estás?" y terminar con "Agradecemos te hayas comunicado, quedamos a las órdenes! MUNDO SHOP".${reglasPromptTareas}
Respondé SOLO con un JSON válido: un objeto donde cada clave es el id de la pregunta y el valor es la respuesta sugerida.

Preguntas:
${rawQuestions.map(q => `ID ${q.id}: "${q.text}"`).join('\n')}`;

        const r = await anthropic.messages.create({
          model: 'claude-haiku-4-5',
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
        });
        const text = r.content.find(b => b.type === 'text')?.text || '{}';
        fs.writeFileSync('data/debug_suggestions.json', JSON.stringify({ text }, null, 2));
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) suggestions = JSON.parse(jsonMatch[0]);
      } catch(e) {
        console.error('[tareas] sugerencias error:', e.message);
      }
    }

    const questions = rawQuestions.map(q => ({ ...q, suggestion: suggestions[q.id] || null }));

    // 2. Últimas 50 órdenes pagadas
    const ordRes = await axios.get(`${ML_API_URL}/orders/search`, {
      headers,
      params: { seller: uid, limit: 50, sort: 'date_desc', order_status: 'paid' },
    });
    const orders = ordRes.data.results || [];

    // 3. Acuerda con comprador: tag no_shipping (no necesita fetch extra)
    const acordadas = orders.filter(o => (o.tags || []).includes('no_shipping'));

    // 4. Fetch shipments para todas las órdenes con shipping.id
    const withShipping = orders.filter(o => o.shipping?.id && !(o.tags || []).includes('no_shipping'));
    const shipmentDetails = {};
    await Promise.all(withShipping.map(async o => {
      try {
        const r = await axios.get(`${ML_API_URL}/shipments/${o.shipping.id}`, { headers });
        shipmentDetails[o.shipping.id] = r.data;
      } catch(e) { /* skip */ }
    }));
    const me1Orders = withShipping.filter(o => shipmentDetails[o.shipping.id]?.mode === 'me1');
    const dacOrders = withShipping.filter(o => {
      const shp = shipmentDetails[o.shipping.id];
      if (!shp) return false;
      const mode = shp.mode || '';
      const logistic = shp.logistic_type || '';
      return mode !== 'me1' && (mode === 'custom' || logistic === 'dac' || logistic === 'self_service' || logistic === 'drop_off' || mode === 'me2');
    });

    const formatOrder = (order, label) => {
      const oi = order.order_items?.[0] || {};
      const item = oi.item || {};
      const shp = shipmentDetails[order.shipping?.id] || {};
      const addr = shp.receiver_address || {};
      const shipping_address = shp.id ? {
        id: shp.id,
        status: shp.status || '',
        mode: shp.mode || '',
        logistic_type: shp.logistic_type || '',
        receiver_name: addr.receiver_name || order.buyer?.nickname || '',
        address: addr.address_line || '',
        city: addr.city?.name || '',
        state: addr.state?.name || '',
        zip: addr.zip_code || '',
        comment: addr.comment || ''
      } : null;
      return {
        order_id:        order.id,
        date_created:    order.date_created,
        buyer_name:      order.buyer?.nickname || order.buyer?.first_name || '—',
        total_amount:    order.total_amount,
        item_title:      item.title || '—',
        item_thumbnail:  item.thumbnail || null,
        item_sku:        item.seller_sku || (item.attributes || []).find(a => a.id === 'SELLER_SKU')?.value_name || null,
        quantity:        oi.quantity || 1,
        shipping_label:  label,
        shipping_address
      };
    };

    console.log(`[tareas] ${questions.length} preguntas sin responder | ${acordadas.length} acuerda | ${me1Orders.length} ME1 | ${dacOrders.length} DAC`);

    res.json({
      questions,
      acuerda_orders: acordadas.map(o => formatOrder(o, 'Acuerda c/ comprador')),
      me1_orders:     me1Orders.map(o => formatOrder(o, 'ME1')),
      dac_orders:     dacOrders.map(o => formatOrder(o, 'ME1 a coordinar')),
    });
  } catch(err) {
    console.error('[tareas] error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// GET /api/devoluciones
app.get('/api/devoluciones', requireToken, async (req, res) => {
  const headers = { Authorization: `Bearer ${tokenData.access_token}` };
  const statusFilter = req.query.status || null;

  try {
    const allClaims = [];
    let offset = 0;

    while (true) {
      const params = { role: 'seller', offset, limit: 50 };
      if (statusFilter && statusFilter !== 'all') params.status = statusFilter;

      const r = await axios.get(`${ML_API_URL}/post-purchase/v1/claims/search`, { headers, params });
      const results = r.data.data || r.data.results || [];
      const total   = r.data.paging?.total ?? results.length;
      for (const c of results) allClaims.push(c);
      if (results.length < 50 || allClaims.length >= total) break;
      offset += 50;
      await sleep(150);
    }

    // Enrich with order data (buyer, shipping, items with SKU/price/variant)
    const orderIds = [...new Set(allClaims.map(c => c.resource_id).filter(Boolean))];
    const orderMap = {};
    for (let i = 0; i < orderIds.length && i < 200; i += 20) {
      const batch = orderIds.slice(i, i + 20);
      await Promise.all(batch.map(async (oid) => {
        try {
          const or = await axios.get(`${ML_API_URL}/orders/${oid}`, { headers });
          const o  = or.data;
          const oi = o.order_items?.[0] || {};
          const it = oi.item || {};
          const sh = o.shipping || {};
          orderMap[oid] = {
            buyer_nickname: o.buyer?.nickname || null,
            buyer_name:     [o.buyer?.first_name, o.buyer?.last_name].filter(Boolean).join(' ') || null,
            logistic_type:  sh.logistic_type  || null,
            shipping_id:    sh.id             || null,
            item_id:        it.id             || null,
            item_title:     it.title          || null,
            item_thumbnail: it.thumbnail      || null,
            item_sku:       it.seller_sku || oi.seller_sku || null,
            variation_name: it.variation_attributes?.map(a => `${a.name}: ${a.value_name}`).join(', ') || null,
            unit_price:     oi.unit_price     || null,
            quantity:       oi.quantity       || null,
          };
        } catch { /* skip */ }
      }));
      if (i + 20 < orderIds.length) await sleep(150);
    }

    const enriched = allClaims.map(c => ({ ...c, ...(orderMap[c.resource_id] || {}) }));

    const returns = enriched.filter(c => c.type === 'return');
    const claims  = enriched.filter(c => c.type !== 'return');

    // Count by substatus for returns summary
    const by_substatus = {};
    for (const r of returns) {
      const k = r.sub_status || r.substatus || r.status || 'other';
      by_substatus[k] = (by_substatus[k] || 0) + 1;
    }

    const by_status = { opened: 0, closed: 0, resolved: 0 };
    for (const c of enriched) {
      if (c.status === 'opened')        by_status.opened++;
      else if (c.status === 'closed')   by_status.closed++;
      else if (c.status === 'resolved') by_status.resolved++;
    }

    res.json({ returns, claims, by_status, by_substatus, total: enriched.length });
  } catch(err) {
    console.error('[devoluciones] error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ── Odoo ─────────────────────────────────────────────────────────
// Odoo PRODUCCIÓN (solo lectura)
const ODOO_HOST    = process.env.ODOO_HOST;
const ODOO_DB      = process.env.ODOO_DB;
const ODOO_USER    = process.env.ODOO_USER;
const ODOO_API_KEY = process.env.ODOO_API_KEY;

// Odoo STAGING (escritura - cotizaciones)
const ODOO_STAGING_HOST    = process.env.ODOO_STAGING_HOST || ODOO_HOST;
const ODOO_STAGING_DB      = process.env.ODOO_STAGING_DB || ODOO_DB;
const ODOO_STAGING_API_KEY = process.env.ODOO_STAGING_API_KEY || ODOO_API_KEY;

console.log(`[odoo] producción: ${ODOO_HOST} / ${ODOO_DB}`);
console.log(`[odoo] staging: ${ODOO_STAGING_HOST} / ${ODOO_STAGING_DB}`);

// JSON-RPC call to Odoo (más rápido que XML-RPC)
let jsonRpcId = 1;
async function odooCall(path, method, params, host = ODOO_HOST) {
  const protocol = host.includes('odoo.com') ? 'https' : 'http';
  const url = `${protocol}://${host}/jsonrpc`;

  // Map XML-RPC style calls to JSON-RPC format
  const body = {
    jsonrpc: '2.0',
    id: jsonRpcId++,
    method: 'call',
    params: { service: path.includes('common') ? 'common' : 'object', method, args: params },
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await axios.post(url, body, { headers: { 'Content-Type': 'application/json' }, timeout: 120000 });
      if (r.data.error) throw new Error(r.data.error.data?.message || r.data.error.message || JSON.stringify(r.data.error));
      return r.data.result;
    } catch (e) {
      if (attempt === 3) throw e;
      console.log(`[odoo] intento ${attempt} falló (${e.message}), reintentando...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

function odooCallStaging(path, method, params) {
  return odooCall(path, method, params, ODOO_STAGING_HOST);
}

async function odooAuth() {
  return odooCall('/xmlrpc/2/common', 'authenticate', [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}]);
}
async function odooAuthStaging() {
  return odooCallStaging('/xmlrpc/2/common', 'authenticate', [ODOO_STAGING_DB, ODOO_USER, ODOO_STAGING_API_KEY, {}]);
}

// API endpoint to tell frontend which DB is connected
app.get('/api/odoo/status', (req, res) => {
  res.json({
    produccion: { host: ODOO_HOST, db: ODOO_DB },
    staging: { host: ODOO_STAGING_HOST, db: ODOO_STAGING_DB },
  });
});

async function odooSearchRead(uid, model, domain, fields, opts = {}, onProgress) {
  const allItems = [];
  const pageSize = 200;
  let offset = 0;
  while (true) {
    const batch = await odooCall('/xmlrpc/2/object', 'execute_kw', [
      ODOO_DB, uid, ODOO_API_KEY, model, 'search_read', [domain],
      { fields, limit: pageSize, offset, ...opts },
    ]);
    allItems.push(...batch);
    if (onProgress) onProgress(allItems.length, batch.length);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return allItems;
}

let odooCache = null;
let odooCacheTime = 0;
const ODOO_CACHE_FILE = path.join(__dirname, 'data', 'odoo_cache.json');

function loadOdooCacheFromDisk() {
  try {
    if (fs.existsSync(ODOO_CACHE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(ODOO_CACHE_FILE, 'utf8'));
      odooCache     = saved.products || [];
      odooCacheTime = new Date(saved.savedAt).getTime() || 0;
      console.log(`[odoo] cache cargado desde disco: ${odooCache.length} productos`);
    }
  } catch(e) { console.error('[odoo] error leyendo cache:', e.message); }
}

function saveOdooCacheToDisk() {
  try {
    fs.writeFileSync(ODOO_CACHE_FILE, JSON.stringify({ products: odooCache, savedAt: new Date().toISOString() }), 'utf8');
  } catch(e) { console.error('[odoo] error guardando cache:', e.message); }
}

async function getOdooProducts(force = false) {
  if (!force && odooCache && odooCache.length > 0) return odooCache;
  const uid = await odooAuth();
  const fieldsAll = ['name', 'default_code', 'list_price', 'standard_price', 'categ_id', 'taxes_id', 'uom_id', 'x_studio_producto_mayorista', 'qty_available', 'image_128'];
  const fieldsLight = ['name', 'default_code', 'list_price', 'standard_price', 'categ_id', 'taxes_id', 'uom_id', 'x_studio_producto_mayorista', 'qty_available'];

  // Incremental: si ya tengo cache, solo traer los modificados (sin imagen, más rápido)
  if (odooCache && odooCache.length > 0 && odooCacheTime > 0) {
    const since = new Date(odooCacheTime).toISOString().replace('T', ' ').slice(0, 19);
    console.log(`[odoo] refresh incremental desde ${since}...`);
    const updated = await odooSearchRead(uid, 'product.product', [['active', '=', true], ['write_date', '>', since]], fieldsLight);
    if (updated.length > 0) {
      const cacheMap = {};
      for (const p of odooCache) cacheMap[p.id] = p;
      for (const p of updated) cacheMap[p.id] = p;
      odooCache = Object.values(cacheMap);
      console.log(`[odoo] incremental: ${updated.length} actualizados, total ${odooCache.length}`);
    } else {
      console.log(`[odoo] incremental: sin cambios`);
    }
    // También traer nuevos productos que no existían
    const newProducts = await odooSearchRead(uid, 'product.product', [['active', '=', true], ['create_date', '>', since]], fieldsAll);
    if (newProducts.length > 0) {
      const existingIds = new Set(odooCache.map(p => p.id));
      const reallyNew = newProducts.filter(p => !existingIds.has(p.id));
      if (reallyNew.length > 0) {
        odooCache.push(...reallyNew);
        console.log(`[odoo] ${reallyNew.length} productos nuevos agregados`);
      }
    }
  } else {
    // Primera carga: traer todo
    console.log(`[odoo] carga completa de productos...`);
    odooCache = await odooSearchRead(uid, 'product.product', [['active', '=', true]], fieldsAll);
    console.log(`[odoo] ${odooCache.length} productos cargados`);
  }

  odooCacheTime = Date.now();
  saveOdooCacheToDisk();
  return odooCache;
}

loadOdooCacheFromDisk();

// ── Dashboard de Stock ──
app.get('/api/dashboard-stock', requireToken, async (req, res) => {
  try {
    const products = odooCache || [];
    if (!products.length) return res.status(503).json({ error: 'Sin datos de Odoo. Sincronizá primero.' });

    const compras = loadCompras();
    const incomingBySku = {};
    for (const c of compras) {
      for (const it of (c.items || [])) {
        if (it.sku) incomingBySku[it.sku] = (incomingBySku[it.sku] || 0) + (parseInt(it.qty) || 0);
      }
    }

    let ihomeMap = {};
    try { if (fs.existsSync(IHOME_MAP_FILE)) ihomeMap = JSON.parse(fs.readFileSync(IHOME_MAP_FILE, 'utf8')); } catch {}

    // Catalogo cache for sales data
    let salesData = {};
    if (_catalogoCache?.categories) {
      for (const cat of _catalogoCache.categories) {
        for (const item of cat.items) {
          if (item.sku) salesData[item.sku] = item;
        }
      }
    }

    const leadTimeChina = parseInt(req.query.lead_time) || 50;
    const skipNames = ['mercado envios', 'self_service', 'drop_off', 'cross_docking', 'fulfillment', 'soydelivery', 'soy delivery', 'standard delivery', 'default fenicio', 'flete', 'costo de envio', 'retiro por local', 'envío', 'radio e instalacion'];
    const packBom = loadPackBom();
    const now = new Date();

    const items = [];
    let totalCapital = 0, totalCapitalTransito = 0, totalCapitalMuerto = 0;
    let quiebreCount = 0, reponerCount = 0, dormidoCount = 0;
    let totalDiasCobertura = 0, itemsConVenta = 0;

    for (const p of products) {
      const nameLower = (p.name || '').toLowerCase();
      if (skipNames.some(s => nameLower.includes(s))) continue;
      if (p.type === 'service') continue;
      const sku = (p.default_code || '').trim();
      if (!sku) continue;
      const skuLower = sku.toLowerCase();
      if (['delivery_007','false','0001','001','002'].includes(skuLower) || skuLower.startsWith('soydelivery') || skuLower.startsWith('retiro')) continue;
      if (packBom[sku]) continue; // skip packs

      const stock = p.qty_available || 0;
      const cost = p.standard_price || 0;
      const incoming = incomingBySku[sku] || 0;
      const sd = salesData[sku] || {};
      const categ = Array.isArray(p.categ_id) ? p.categ_id[1] : (p.categ_id || '');
      const ih = ihomeMap[sku] || {};

      // Sales last 90 days (3 months) from sales_by_month
      const salesByMonth = sd.sales_by_month || {};
      const months = Object.keys(salesByMonth).sort().slice(-3);
      const sold90d = months.reduce((s, m) => s + (salesByMonth[m] || 0), 0);
      const ventaDiaria = months.length > 0 ? sold90d / (months.length * 30) : 0;

      // Coverage days
      const available = stock + incoming;
      const diasCobertura = ventaDiaria > 0 ? Math.round(available / ventaDiaria) : (stock > 0 ? 999 : 0);

      // Last sale month
      const allMonths = Object.keys(salesByMonth).sort();
      const lastSaleMonth = allMonths.length > 0 ? allMonths[allMonths.length - 1] : null;

      // ABC from sales data
      const abc = sd.abc || null;

      // Capital
      const capitalInvertido = Math.round(stock * cost);
      const capitalTransito = Math.round(incoming * cost);
      totalCapital += capitalInvertido;
      totalCapitalTransito += capitalTransito;

      // Coverage target by ABC
      const coberturaObjetivo = abc === 'A' ? 120 : abc === 'B' ? 90 : 60;

      // Suggested qty to order (reach target coverage post-lead-time)
      const diasNecesarios = coberturaObjetivo + leadTimeChina;
      const necesario = Math.ceil(ventaDiaria * diasNecesarios);
      const sugerido = Math.max(0, necesario - available);

      // Classify
      let estado = 'ok';
      if (ventaDiaria === 0 && stock > 0) {
        // No sales 90d but has stock = dormido
        estado = 'dormido';
        dormidoCount++;
        totalCapitalMuerto += capitalInvertido;
      } else if (diasCobertura < 30) {
        estado = 'quiebre';
        quiebreCount++;
      } else if (diasCobertura <= 90) {
        estado = 'reponer';
        reponerCount++;
      } else if (diasCobertura > 180 && ventaDiaria > 0) {
        estado = 'exceso';
      }

      if (ventaDiaria > 0) {
        totalDiasCobertura += diasCobertura;
        itemsConVenta++;
      }

      items.push({
        sku, name: p.name, categ, abc,
        stock, incoming, cost, ventaDiaria: Math.round(ventaDiaria * 100) / 100,
        diasCobertura, coberturaObjetivo, sugerido, estado,
        capitalInvertido, capitalTransito,
        sold90d, lastSaleMonth,
        fob: ih.fob || 0, ihome: ih.ihome || '',
        thumbnail: sd.ml_thumbnail || null,
        canal_principal: sd.canal_principal || null,
      });
    }

    // Global coverage (weighted average)
    const coberturaGlobal = itemsConVenta > 0 ? Math.round(totalDiasCobertura / itemsConVenta) : 0;

    // Insights
    const insights = [];

    // 1. Categories growing
    const catSales = {};
    for (const it of items) {
      if (!it.categ || it.ventaDiaria === 0) continue;
      if (!catSales[it.categ]) catSales[it.categ] = { current: 0, items: 0 };
      catSales[it.categ].current += it.sold90d;
      catSales[it.categ].items++;
    }
    const topCats = Object.entries(catSales).sort((a, b) => b[1].current - a[1].current).slice(0, 3);
    if (topCats.length) {
      insights.push({ type: 'growth', text: 'Top categorías 90d: ' + topCats.map(([c, d]) => c + ' (' + d.current + ' uds)').join(', ') });
    }

    // 2. Supplier with most breaks
    const supplierBreaks = {};
    for (const it of items) {
      if (it.estado !== 'quiebre') continue;
      const sup = it.categ || 'General';
      supplierBreaks[sup] = (supplierBreaks[sup] || 0) + 1;
    }
    const worstSup = Object.entries(supplierBreaks).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (worstSup.length && worstSup[0][1] > 2) {
      insights.push({ type: 'warning', text: worstSup.map(([s, c]) => s + ': ' + c + ' SKUs en quiebre').join(' · ') });
    }

    // 3. A products without stock
    const aNoStock = items.filter(i => i.abc === 'A' && i.stock <= 0 && i.ventaDiaria > 0);
    if (aNoStock.length) {
      insights.push({ type: 'critical', text: aNoStock.length + ' productos A sin stock: ' + aNoStock.slice(0, 5).map(i => i.sku).join(', ') + (aNoStock.length > 5 ? '...' : '') });
    }

    // 4. Dead capital summary
    if (totalCapitalMuerto > 0) {
      insights.push({ type: 'info', text: 'Capital muerto: $' + totalCapitalMuerto.toLocaleString('es-UY') + ' en ' + dormidoCount + ' SKUs sin ventas 90d' });
    }

    // 5. High coverage items that could be liquidated
    const exceso = items.filter(i => i.estado === 'exceso');
    if (exceso.length > 5) {
      const capExceso = exceso.reduce((s, i) => s + i.capitalInvertido, 0);
      insights.push({ type: 'opportunity', text: exceso.length + ' SKUs con +180 días de cobertura ($' + capExceso.toLocaleString('es-UY') + ' atado). Oportunidad de liquidar.' });
    }

    res.json({
      kpis: {
        capitalTotal: totalCapital + totalCapitalTransito,
        capitalStock: totalCapital,
        capitalTransito: totalCapitalTransito,
        coberturaGlobal,
        quiebreCount,
        reponerCount,
        capitalMuerto: totalCapitalMuerto,
        dormidoCount,
        totalSKUs: items.length,
        itemsConVenta,
      },
      quiebre: items.filter(i => i.estado === 'quiebre').sort((a, b) => a.diasCobertura - b.diasCobertura),
      reponer: items.filter(i => i.estado === 'reponer').sort((a, b) => a.diasCobertura - b.diasCobertura),
      dormidos: items.filter(i => i.estado === 'dormido').sort((a, b) => b.capitalInvertido - a.capitalInvertido),
      insights,
      config: { leadTimeChina },
      generado: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[dashboard-stock] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Odoo: Railway NUNCA conecta a Odoo. Solo se sincroniza localmente y se pushea el cache.
// En Railway se lee siempre del cache en disco.

// Sync local + push a Railway (con streaming de progreso)
let _syncLog = [];
let _syncStatus = 'idle'; // idle, running, done, error
let _syncProgress = 0;

app.post('/api/odoo/sync-push', requireAdmin, async (req, res) => {
  if (process.env.RAILWAY_ENVIRONMENT) return res.status(403).json({ error: 'Solo se puede sincronizar desde local' });
  if (_syncStatus === 'running') return res.status(409).json({ error: 'Ya hay una sincronización en curso' });

  _syncLog = [];
  _syncStatus = 'running';
  _syncProgress = 0;
  res.json({ ok: true, message: 'Sincronización iniciada' });

  // Run in background
  (async () => {
    try {
      const { execSync } = require('child_process');

      // Step 1: Auth
      _syncProgress = 5;
      _syncLog.push({ t: Date.now(), msg: 'Conectando a Odoo (' + ODOO_HOST + ')...' });
      const uid = await odooAuth();
      _syncLog.push({ t: Date.now(), msg: 'Autenticado con Odoo (uid: ' + uid + ')' });
      _syncProgress = 10;

      // Step 2: Products (con detalle)
      const beforeCount = odooCache?.length || 0;
      const since = odooCacheTime > 0 ? new Date(odooCacheTime).toISOString().replace('T', ' ').slice(0, 19) : null;
      if (since) {
        _syncLog.push({ t: Date.now(), msg: 'Modo incremental: trayendo cambios desde ' + since });
      } else {
        _syncLog.push({ t: Date.now(), msg: 'Primera carga: trayendo todos los productos...' });
      }

      const fieldsAll = ['name', 'default_code', 'list_price', 'standard_price', 'categ_id', 'taxes_id', 'uom_id', 'x_studio_producto_mayorista', 'qty_available', 'image_128'];
      // Incremental: sin imagen (ya la tenemos), mucho más rápido
      const fieldsLight = ['name', 'default_code', 'list_price', 'standard_price', 'categ_id', 'taxes_id', 'uom_id', 'x_studio_producto_mayorista', 'qty_available'];

      if (since && odooCache?.length > 0) {
        // Incremental sin imágenes
        const updated = await odooSearchRead(uid, 'product.product', [['active', '=', true], ['write_date', '>', since]], fieldsLight, {},
          (total, batch) => { _syncLog.push({ t: Date.now(), msg: '  → ' + total + ' productos modificados encontrados (lote de ' + batch + ')' }); _syncProgress = Math.min(25, 10 + total / 10); }
        );
        if (updated.length > 0) {
          const cacheMap = {};
          for (const p of odooCache) cacheMap[p.id] = p;
          for (const p of updated) cacheMap[p.id] = p;
          odooCache = Object.values(cacheMap);
          _syncLog.push({ t: Date.now(), msg: updated.length + ' productos actualizados' });
        } else {
          _syncLog.push({ t: Date.now(), msg: 'Sin productos modificados' });
        }

        const newProds = await odooSearchRead(uid, 'product.product', [['active', '=', true], ['create_date', '>', since]], fieldsAll, {},
          (total) => { _syncLog.push({ t: Date.now(), msg: '  → ' + total + ' productos nuevos encontrados' }); }
        );
        const existingIds = new Set(odooCache.map(p => p.id));
        const reallyNew = newProds.filter(p => !existingIds.has(p.id));
        if (reallyNew.length > 0) {
          odooCache.push(...reallyNew);
          _syncLog.push({ t: Date.now(), msg: reallyNew.length + ' productos nuevos agregados' });
        } else {
          _syncLog.push({ t: Date.now(), msg: 'Sin productos nuevos' });
        }
      } else {
        // Full load
        odooCache = await odooSearchRead(uid, 'product.product', [['active', '=', true]], fieldsAll, {},
          (total, batch) => { _syncLog.push({ t: Date.now(), msg: '  → ' + total + ' productos cargados...' }); _syncProgress = Math.min(25, 10 + total / 200); }
        );
      }

      odooCacheTime = Date.now();
      saveOdooCacheToDisk();
      const afterCount = odooCache?.length || 0;
      _syncLog.push({ t: Date.now(), msg: 'Productos totales en cache: ' + afterCount + (afterCount - beforeCount > 0 ? ' (+' + (afterCount - beforeCount) + ')' : '') });
      _syncProgress = 30;

      // Step 3: Build catalogo con ventas
      _syncLog.push({ t: Date.now(), msg: 'Construyendo catálogo con ventas por canal...' });
      _syncProgress = 35;

      const syncLog = (msg) => { _syncLog.push({ t: Date.now(), msg: '  ' + msg }); };
      await buildCatalogoCache(true, syncLog);
      _syncLog.push({ t: Date.now(), msg: 'Catálogo listo: ' + (_catalogoCache?.total || 0) + ' productos' });
      _syncProgress = 70;

      // Step 5: Save files
      _syncLog.push({ t: Date.now(), msg: 'Guardando cache en disco...' });
      const odooSize = Math.round(fs.statSync(path.join(__dirname, 'data', 'odoo_cache.json')).size / 1024);
      const catSize = Math.round(fs.statSync(CATALOGO_CACHE_FILE).size / 1024);
      _syncLog.push({ t: Date.now(), msg: 'Archivos: odoo_cache.json (' + odooSize + 'KB) + catalogo_cache.json (' + catSize + 'KB)' });
      _syncProgress = 80;

      // Step 6: Git
      _syncLog.push({ t: Date.now(), msg: 'Git: staging archivos...' });
      const gitDir = __dirname;
      execSync('git add -f data/odoo_cache.json data/catalogo_cache.json', { cwd: gitDir });
      _syncProgress = 85;

      const now = new Date().toLocaleString('es-UY', { timeZone: 'America/Montevideo' });
      try {
        execSync(`git commit -m "Sync Odoo cache ${now}"`, { cwd: gitDir });
        _syncLog.push({ t: Date.now(), msg: 'Git: commit creado' });
      } catch(e) {
        _syncLog.push({ t: Date.now(), msg: 'Git: sin cambios (datos ya actualizados)' });
        _syncProgress = 100;
        _syncStatus = 'done';
        return;
      }
      _syncProgress = 90;

      _syncLog.push({ t: Date.now(), msg: 'Git: pushing a main y testing...' });
      execSync('git push origin main main:testing --force', { cwd: gitDir });
      _syncLog.push({ t: Date.now(), msg: 'Push completo. Railway redeploya en ~3 min.' });
      _syncProgress = 100;
      _syncStatus = 'done';

    } catch(e) {
      _syncLog.push({ t: Date.now(), msg: 'ERROR: ' + e.message });
      _syncStatus = 'error';
      console.error('[sync] error:', e.message);
    }
  })();
});

// Polling endpoint para el progreso
app.get('/api/odoo/sync-status', requireAdmin, (req, res) => {
  const lastUpdate = odooCacheTime ? new Date(odooCacheTime).toISOString() : null;
  const productCount = odooCache?.length || 0;
  res.json({ status: _syncStatus, progress: _syncProgress, log: _syncLog, lastUpdate, productCount });
});

app.get('/api/odoo/buscar-partner', async (req, res) => {
  try {
    const q = req.query.q || '';
    if (!q) return res.json([]);
    const uid = await odooAuth();
    // Buscar por nombre, teléfono, móvil y referencia interna
    const domain = [
      ['customer_rank', '>', 0],
      '|', '|', '|',
      ['name', 'ilike', q],
      ['phone', 'ilike', q],
      ['mobile', 'ilike', q],
      ['ref', 'ilike', q],
    ];
    const partners = await odooCall('/xmlrpc/2/object', 'execute_kw', [
      ODOO_DB, uid, ODOO_API_KEY, 'res.partner', 'search_read',
      [domain],
      { fields: ['id', 'name', 'phone', 'mobile', 'ref'], limit: 10 },
    ]);
    res.json(partners);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sirve la imagen de un product.product por ID (con cache en disco)
const IMG_CACHE_DIR = path.join(__dirname, 'data', 'images');
if (!fs.existsSync(IMG_CACHE_DIR)) fs.mkdirSync(IMG_CACHE_DIR, { recursive: true });

app.get('/api/odoo/imagen/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).end();
  const filePath = path.join(IMG_CACHE_DIR, `${id}.png`);
  try {
    if (fs.existsSync(filePath)) {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=604800');
      return res.end(fs.readFileSync(filePath));
    }
    const uid = await odooAuth();
    const rows = await odooCall('/xmlrpc/2/object', 'execute_kw', [
      ODOO_DB, uid, ODOO_API_KEY, 'product.product', 'search_read',
      [[['id', '=', id]]],
      { fields: ['image_512'], limit: 1 },
    ]);
    const b64 = rows[0]?.image_512;
    if (!b64) return res.status(404).end();
    const buf = Buffer.from(b64, 'base64');
    fs.writeFileSync(filePath, buf);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.end(buf);
  } catch (err) {
    res.status(500).end();
  }
});

function upgradeMlThumb(url) {
  if (!url) return null;
  return url
    .replace('http://', 'https://')
    .replace(/\/D_/, '/D_NQ_NP_')
    .replace(/-I\.jpg$/, '-O.jpg');
}

// Cache completo de productos + ventas para servir instantáneo
let _catalogoCache = null;
let _catalogoCacheTime = 0;
const CATALOGO_CACHE_FILE = path.join(__dirname, 'data', 'catalogo_cache.json');

async function buildCatalogoCache(force = false, onLog) {
  if (!force && _catalogoCache && (Date.now() - _catalogoCacheTime < 3600000)) return _catalogoCache;
  if (!force && !_catalogoCache) {
    try {
      if (fs.existsSync(CATALOGO_CACHE_FILE)) {
        _catalogoCache = JSON.parse(fs.readFileSync(CATALOGO_CACHE_FILE, 'utf8'));
        _catalogoCacheTime = Date.now();
        console.log('[catalogo] cache cargado desde disco: ' + (_catalogoCache.total || 0) + ' productos');
        return _catalogoCache;
      }
    } catch(e) {}
  }
  console.log('[catalogo] construyendo cache...');
  const result = await _buildCatalogoData(force, onLog);
  _catalogoCache = result;
  _catalogoCacheTime = Date.now();
  try { fs.writeFileSync(CATALOGO_CACHE_FILE, JSON.stringify(result)); } catch(e) {}
  console.log('[catalogo] cache listo: ' + result.total + ' productos');
  return result;
}

// Catalogo se sirve del cache en disco. En Railway nunca conecta a Odoo.

app.get('/api/odoo/productos', async (req, res) => {
  try {
    if (req.query.refresh === 'true' && !process.env.RAILWAY_ENVIRONMENT) {
      buildCatalogoCache(true).catch(e => console.error('[catalogo] refresh error:', e.message));
    }
    // Serve from cache if available
    if (_catalogoCache) return res.json(_catalogoCache);
    // No cache yet — serve products from odooCache without sales (fast fallback)
    if (odooCache && odooCache.length > 0) {
      const mlMap = buildMlSkuMap();
      const skipNames = ['mercado envios', 'self_service', 'drop_off', 'cross_docking', 'fulfillment', 'soydelivery', 'soy delivery', 'standard delivery', 'default fenicio', 'flete', 'costo de envio', 'retiro por local', 'envío', 'radio e instalacion'];
      const byCategory = {};
      for (const p of odooCache) {
        const nameLower = (p.name || '').toLowerCase();
        if (skipNames.some(s => nameLower.includes(s))) continue;
        if (p.type === 'service') continue;
        const cat = Array.isArray(p.categ_id) ? p.categ_id[1] : (p.categ_id || 'Sin categoría');
        if (!byCategory[cat]) byCategory[cat] = [];
        const sku = p.default_code || '';
        const ml = mlMap[sku.trim()] || null;
        byCategory[cat].push({
          id: p.id, name: p.name, sku, price: p.list_price, cost: p.standard_price ?? 0,
          stock: p.qty_available ?? 0, sold_6m: 0, sold_avg_month: 0,
          sales_by_month: {}, sales_by_channel: { ml:{}, mayorista:{}, local:{} },
          ml_stock: ml?.stock ?? null, ml_price: ml?.price ?? null, ml_status: ml?.status ?? null,
          ml_thumbnail: ml ? upgradeMlThumb(ml.thumbnail) : null,
          odoo_image: p.image_128 ? 'data:image/png;base64,' + p.image_128 : null,
          incoming: 0, incoming_detail: [], categ: cat, mayorista: p.x_studio_producto_mayorista || false,
        });
      }
      const categories = Object.entries(byCategory).sort(([a],[b]) => a.localeCompare(b,'es')).map(([name,items]) => ({ name, items: items.sort((a,b) => a.name.localeCompare(b.name,'es')) }));
      return res.json({ categories, total: odooCache.length, salesMonths: [], savedAt: 'cache parcial — ventas cargando...' });
    }
    res.status(503).json({ error: 'Catálogo cargando, intentá en unos minutos...' });
  } catch (err) {
    console.error('[odoo] error productos:', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function _buildCatalogoData(forceProducts, onLog) {
  const log = onLog || (() => {});
  try {
    const products = await getOdooProducts(forceProducts);
    log('Productos cargados: ' + products.length);

    // Traer ventas de los últimos 6 meses por producto, mes Y canal
    let salesByProduct = {};     // product_id -> total qty
    let salesByProductMonth = {}; // product_id -> { 'YYYY-MM': qty }
    let salesByChannel = {};     // product_id -> { ml: { 'YYYY-MM': qty }, mayorista: {...}, local: {...} }
    let salesMonths = [];
    const monthNames = { enero:'01',febrero:'02',marzo:'03',abril:'04',mayo:'05',junio:'06',julio:'07',agosto:'08',septiembre:'09',setiembre:'09',octubre:'10',noviembre:'11',diciembre:'12',
      january:'01',february:'02',march:'03',april:'04',may:'05',june:'06',july:'07',august:'08',september:'09',october:'10',november:'11',december:'12' };

    function parseOdooMonth(str) {
      const parts = (str || '').toLowerCase().split(' ');
      if (parts.length !== 2) return null;
      const mm = monthNames[parts[0]];
      return mm ? parts[1] + '-' + mm : null;
    }

    try {
      const uid = await odooAuth();
      if (uid) {
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 12);
        const dateFrom = sixMonthsAgo.toISOString().slice(0, 10);
        const monthSet = new Set();

        // ML: salesman_id = 2 (Mateo)
        log('Trayendo ventas ML (Mateo, desde ' + dateFrom + ')...');
        const mlSales = await odooCall('/xmlrpc/2/object', 'execute_kw', [
          ODOO_DB, uid, ODOO_API_KEY, 'sale.order.line', 'read_group',
          [[['create_date', '>=', dateFrom], ['state', 'in', ['sale', 'done']], ['salesman_id', '=', 2]]],
          { fields: ['product_id', 'product_uom_qty', 'create_date'], groupby: ['product_id', 'create_date:month'], lazy: false }
        ]);
        log('  ML: ' + mlSales.length + ' registros');

        // Mayorista: salesman_id in [17, 18]
        log('Trayendo ventas Mayorista (Gustavo/Omar)...');
        const maySales = await odooCall('/xmlrpc/2/object', 'execute_kw', [
          ODOO_DB, uid, ODOO_API_KEY, 'sale.order.line', 'read_group',
          [[['create_date', '>=', dateFrom], ['state', 'in', ['sale', 'done']], ['salesman_id', 'in', [17, 18]]]],
          { fields: ['product_id', 'product_uom_qty', 'create_date'], groupby: ['product_id', 'create_date:month'], lazy: false }
        ]);
        log('  Mayorista: ' + maySales.length + ' registros');

        // POS (local)
        log('Trayendo ventas Local (POS)...');
        const posSales = await odooCall('/xmlrpc/2/object', 'execute_kw', [
          ODOO_DB, uid, ODOO_API_KEY, 'pos.order.line', 'read_group',
          [[['create_date', '>=', dateFrom]]],
          { fields: ['product_id', 'qty', 'create_date'], groupby: ['product_id', 'create_date:month'], lazy: false }
        ]);
        log('  Local: ' + posSales.length + ' registros');

        function processSales(data, channel, qtyField) {
          for (const r of data) {
            if (!r.product_id) continue;
            const pid = r.product_id[0];
            const qty = r[qtyField] || 0;
            const key = parseOdooMonth(r['create_date:month']);
            if (!key) continue;
            monthSet.add(key);
            // Total
            salesByProduct[pid] = (salesByProduct[pid] || 0) + qty;
            if (!salesByProductMonth[pid]) salesByProductMonth[pid] = {};
            salesByProductMonth[pid][key] = (salesByProductMonth[pid][key] || 0) + qty;
            // By channel
            if (!salesByChannel[pid]) salesByChannel[pid] = { ml: {}, mayorista: {}, local: {} };
            salesByChannel[pid][channel][key] = (salesByChannel[pid][channel][key] || 0) + qty;
          }
        }

        processSales(mlSales, 'ml', 'product_uom_qty');
        processSales(maySales, 'mayorista', 'product_uom_qty');
        processSales(posSales, 'local', 'qty');

        salesMonths = [...monthSet].sort();
      }
    } catch(e) { console.error('[odoo] error ventas:', e.message); }

    // Compras en camino por SKU
    const compras = loadCompras();
    const incomingBySku = {};
    const incomingDetailBySku = {};
    for (const c of compras) {
      for (const it of (c.items || [])) {
        if (!it.sku) continue;
        incomingBySku[it.sku] = (incomingBySku[it.sku] || 0) + (parseInt(it.qty) || 0);
        if (!incomingDetailBySku[it.sku]) incomingDetailBySku[it.sku] = [];
        incomingDetailBySku[it.sku].push({ qty: parseInt(it.qty) || 0, date: c.expected_date, supplier: c.supplier });
      }
    }

    // Índice ML por SKU para cruzar stock (incluye variantes)
    const mlMap = buildMlSkuMap();

    // Agrupar por categoría
    const byCategory = {};
    const skipNames = ['mercado envios', 'self_service', 'drop_off', 'cross_docking', 'fulfillment', 'soydelivery', 'soy delivery', 'standard delivery', 'default fenicio', 'flete', 'costo de envio', 'retiro por local', 'envío', 'radio e instalacion'];
    for (const p of products) {
      const nameLower = (p.name || '').toLowerCase();
      if (skipNames.some(s => nameLower.includes(s))) continue;
      if (p.type === 'service') continue;
      const cat = Array.isArray(p.categ_id) ? p.categ_id[1] : (p.categ_id || 'Sin categoría');
      if (!byCategory[cat]) byCategory[cat] = [];
      const sku = p.default_code || '';
      const ml = mlMap[sku.trim()] || null;
      const sold6m = salesByProduct[p.id] || 0;
      byCategory[cat].push({
        id:        p.id,
        name:      p.name,
        sku,
        price:     p.list_price,
        cost:      p.standard_price ?? 0,
        stock:     p.qty_available ?? 0,
        sold_6m:      sold6m,
        sold_avg_month: Math.round(sold6m / 6 * 10) / 10,
        sales_by_month: salesByProductMonth[p.id] || {},
        sales_by_channel: salesByChannel[p.id] || { ml: {}, mayorista: {}, local: {} },
        ml_stock:     ml ? ml.stock     : null,
        ml_price:     ml ? ml.price     : null,
        ml_status:    ml ? ml.status    : null,
        ml_thumbnail: ml ? upgradeMlThumb(ml.thumbnail) : null,
        odoo_image: p.image_128 ? `data:image/png;base64,${p.image_128}` : null,
        incoming: incomingBySku[sku.trim()] || 0,
        incoming_detail: incomingDetailBySku[sku.trim()] || [],
        categ:     cat,
        uom_id:    p.uom_id,
        tax_ids:   p.taxes_id || [],
        mayorista: p.x_studio_producto_mayorista || false,
      });
    }
    // Ordenar categorías y productos dentro de cada una
    const categories = Object.entries(byCategory)
      .sort(([a], [b]) => a.localeCompare(b, 'es'))
      .map(([name, items]) => ({
        name,
        items: items.sort((a, b) => a.name.localeCompare(b.name, 'es')),
      }));
    return { categories, total: products.length, salesMonths, savedAt: new Date().toISOString() };
  } catch (err) {
    console.error('[odoo] error productos:', err.message);
    throw err;
  }
}

// Mapeo manual SKU Odoo → ML item ID
const SKU_MAP_FILE = path.join(__dirname, 'data', 'sku_map_manual.json');
function loadSkuMapManual() {
  try { return fs.existsSync(SKU_MAP_FILE) ? JSON.parse(fs.readFileSync(SKU_MAP_FILE, 'utf8')) : {}; } catch { return {}; }
}
function saveSkuMapManual(map) { fs.writeFileSync(SKU_MAP_FILE, JSON.stringify(map, null, 2)); }

// Construye mapa sku → item incluyendo SKUs de variantes y mapeo manual
function buildMlSkuMap() {
  const map = {};
  const mlById = {};
  for (const item of cachedStock) {
    mlById[String(item.id)] = item;
    if (item.sku) map[item.sku.trim()] = item;
    for (const vsku of (item.variation_skus || [])) {
      if (vsku) map[vsku.trim()] = item;
    }
  }
  // Aplicar mapeo manual
  const manual = loadSkuMapManual();
  for (const [sku, mlId] of Object.entries(manual)) {
    const item = mlById[String(mlId)];
    if (item) map[sku.trim()] = item;
  }
  return map;
}

// GET /api/config/sku-map — leer mapeo manual
app.get('/api/config/sku-map', requireToken, (req, res) => res.json(loadSkuMapManual()));

// POST /api/config/sku-map — agregar entrada
app.post('/api/config/sku-map', requireToken, (req, res) => {
  const { sku, ml_id } = req.body;
  if (!sku || !ml_id) return res.status(400).json({ error: 'sku y ml_id requeridos' });
  const map = loadSkuMapManual();
  map[sku.trim()] = String(ml_id).replace(/[^0-9]/g, '');
  saveSkuMapManual(map);
  res.json({ ok: true, total: Object.keys(map).length });
});

// DELETE /api/config/sku-map/:sku — eliminar entrada
app.delete('/api/config/sku-map/:sku', requireToken, (req, res) => {
  const map = loadSkuMapManual();
  delete map[decodeURIComponent(req.params.sku)];
  saveSkuMapManual(map);
  res.json({ ok: true });
});

// GET /api/stock/discrepancias — stock en Odoo pero pausado o sin stock en ML
app.get('/api/stock/discrepancias', requireToken, async (req, res) => {
  try {
    const products = await getOdooProducts(false);
    const odooMap = {};
    for (const p of products) {
      if (p.default_code) odooMap[p.default_code.trim()] = p;
    }
    const mlMap = buildMlSkuMap();

    const rows = [];
    for (const [sku, odoo] of Object.entries(odooMap)) {
      const odooStock = odoo.qty_available ?? 0;
      if (odooStock <= 0) continue; // solo con stock en Odoo
      const ml = mlMap[sku];
      const mlPausada = ml && ml.status === 'paused';
      const mlSinStock = ml && ml.stock === 0;
      const sinPublicacion = !ml;
      if (!mlPausada && !mlSinStock && !sinPublicacion) continue;

      rows.push({
        sku,
        odoo_name:   odoo.name,
        odoo_stock:  odooStock,
        odoo_categ:  Array.isArray(odoo.categ_id) ? odoo.categ_id[1] : null,
        ml_title:    ml ? ml.title : null,
        ml_stock:    ml ? ml.stock : null,
        ml_status:   ml ? ml.status : null,
        ml_id:       ml ? ml.id : null,
        ml_permalink: ml ? ml.permalink : null,
        motivo:      sinPublicacion ? 'sin_publicacion' : mlPausada ? 'pausada' : 'sin_stock_ml',
      });
    }
    rows.sort((a, b) => b.odoo_stock - a.odoo_stock);
    res.json({ rows, total: rows.length });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stock/cruce-nombre — productos Odoo sin SKU en ML, con posible match por nombre
function simNombre(a, b) {
  const tok = s => s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar tildes
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/).filter(w => w.length > 2);
  const wa = new Set(tok(a));
  const wb = new Set(tok(b));
  if (!wa.size || !wb.size) return 0;
  let inter = 0;
  wa.forEach(w => { if (wb.has(w)) inter++; });
  return inter / Math.sqrt(wa.size * wb.size);
}

app.get('/api/stock/cruce-nombre', requireToken, async (req, res) => {
  try {
    const products = await getOdooProducts(false);
    const mlMap = buildMlSkuMap();

    // Solo Odoo con stock y sin match exacto por SKU
    const sinMatch = products.filter(p => {
      if (!p.qty_available || p.qty_available <= 0) return false;
      if (!p.default_code) return true; // sin SKU
      return !mlMap[p.default_code.trim()]; // SKU no encontrado en ML
    });

    // Para cada uno, buscar el ML más similar por nombre
    const rows = [];
    for (const p of sinMatch) {
      let best = null, bestScore = 0;
      for (const item of cachedStock) {
        const score = simNombre(p.name, item.title);
        if (score > bestScore) { bestScore = score; best = item; }
      }
      if (bestScore >= 0.25) { // umbral mínimo
        rows.push({
          odoo_id:    p.id,
          odoo_sku:   p.default_code || null,
          odoo_name:  p.name,
          odoo_stock: p.qty_available,
          odoo_categ: Array.isArray(p.categ_id) ? p.categ_id[1] : null,
          ml_id:      best.id,
          ml_sku:     best.sku || null,
          ml_title:   best.title,
          ml_stock:   best.stock,
          ml_status:  best.status,
          ml_permalink: best.permalink,
          score:      Math.round(bestScore * 100),
        });
      }
    }
    rows.sort((a, b) => b.score - a.score);
    res.json({ rows, total: rows.length });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/odoo/cruce', async (req, res) => {
  try {
    const products = await getOdooProducts(req.query.refresh === 'true');

    // Índice Odoo por SKU (default_code)
    const odooMap = {};
    for (const p of products) {
      if (p.default_code) odooMap[p.default_code.trim()] = p;
    }

    // Índice ML por SKU (incluye variantes)
    const mlMap = buildMlSkuMap();

    // Unir: todos los SKUs de ambos lados
    const allSkus = new Set([...Object.keys(odooMap), ...Object.keys(mlMap)]);
    const rows = [];
    for (const sku of allSkus) {
      const o = odooMap[sku];
      const m = mlMap[sku];
      rows.push({
        sku,
        odoo_name:  o ? o.name : null,
        odoo_price: o ? o.list_price : null,
        odoo_categ: o && Array.isArray(o.categ_id) ? o.categ_id[1] : null,
        ml_title:   m ? m.title : null,
        ml_price:   m ? m.price : null,
        ml_stock:   m ? m.stock : null,
        ml_status:  m ? m.status : null,
        in_odoo:    !!o,
        in_ml:      !!m,
      });
    }
    rows.sort((a, b) => a.sku.localeCompare(b.sku, 'es'));
    res.json({ rows, total: rows.length, only_odoo: rows.filter(r => !r.in_ml).length, only_ml: rows.filter(r => !r.in_odoo).length, both: rows.filter(r => r.in_odoo && r.in_ml).length });
  } catch (err) {
    console.error('[odoo] error cruce:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Cotización desde foto ────────────────────────────────────────
app.post('/api/odoo/cotizacion-foto', express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const { image_base64, media_type } = req.body;
    if (!image_base64) return res.status(400).json({ error: 'Se requiere image_base64' });

    // 1. Claude lee la imagen
    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: media_type || 'image/jpeg', data: image_base64 },
          },
          {
            type: 'text',
            text: `Analizá esta imagen de un pedido escrito a mano. Extraé:
1. Nombre del cliente (suele estar arriba)
2. Lista de productos con: SKU completo (incluyendo variante de color/temperatura), cantidad y precio si aparece

IMPORTANTE — formato de variantes de SKU:
- Los SKUs tienen formato: {BASE}-{COLOR}-{TEMP}  (ej: 22306-BLA-FRI)
- Abreviaciones de color: B/BL/Blanco=BLA, N/NG/Negro=NEG, G/GR/Gris=GRI, R/RO/Rosa=ROS, V/VE/Verde=VER, D/DO/Dorado=DOR, P/PL/Plateado=PLA, AZ/AZU=AZU
- Abreviaciones de temperatura: F/FRI=FRI, C/CAL=CAL
- Cuando una línea dice "18110: 2B-2N" significa: 2 unidades de 18110-BLA y 2 unidades de 18110-NEG → generá DOS entradas separadas
- Cuando dice "22306 3FRI-2CAL" significa: 3 unidades de 22306-FRI y 2 unidades de 22306-CAL → DOS entradas separadas
- Si solo hay un color/variante, generá una sola entrada con el SKU completo

Respondé ÚNICAMENTE con un JSON válido con esta estructura exacta, sin texto adicional:
{
  "cliente": "nombre del cliente",
  "productos": [
    { "sku": "18110-BLA", "cantidad": 2, "precio": null },
    { "sku": "18110-NEG", "cantidad": 2, "precio": null }
  ],
  "notas": "cualquier nota o condición adicional que aparezca"
}
Si no encontrás algún campo ponelo como null.`,
          },
        ],
      }],
    });

    let parsed;
    try {
      const text = msg.content[0].text.trim().replace(/^```json\n?/, '').replace(/\n?```$/, '');
      parsed = JSON.parse(text);
    } catch (e) {
      return res.status(422).json({ error: 'No se pudo interpretar la imagen', raw: msg.content[0].text });
    }

    const uid = await odooAuth();

    // 2. Buscar cliente por nombre, teléfono o referencia (solo si hay valor)
    const cq = (parsed.cliente || '').trim();
    let partners = [];
    if (cq) {
      const partnerDomain = [
        ['customer_rank', '>', 0],
        '|', '|', '|',
        ['name', 'ilike', cq],
        ['phone', 'ilike', cq],
        ['mobile', 'ilike', cq],
        ['ref', 'ilike', cq],
      ];
      partners = await odooCall('/xmlrpc/2/object', 'execute_kw', [
        ODOO_DB, uid, ODOO_API_KEY, 'res.partner', 'search_read',
        [partnerDomain],
        { fields: ['id', 'name', 'phone', 'mobile', 'ref'], limit: 5 },
      ]);
    }

    // 3. Buscar productos por SKU en el cache local
    const skus = (parsed.productos || []).map(p => p.sku).filter(Boolean);
    const cache = await getOdooProducts();
    const productMap = {};
    for (const p of cache) {
      if (p.default_code) productMap[p.default_code] = p;
    }

    // Helper: busca SKU exacto, luego base (sin último segmento), luego sin dos últimos
    function findProduct(sku) {
      if (!sku) return null;
      if (productMap[sku]) return productMap[sku];
      const parts = sku.split('-');
      if (parts.length > 2) {
        const base2 = parts.slice(0, -1).join('-');
        if (productMap[base2]) return productMap[base2];
      }
      if (parts.length > 1) {
        const base1 = parts[0];
        if (productMap[base1]) return productMap[base1];
      }
      return null;
    }

    // 4. Devolver datos extraídos para que el usuario confirme
    const lineas = (parsed.productos || []).map(p => {
      const prod = findProduct(p.sku);
      return {
        sku:       p.sku,
        cantidad:  p.cantidad || 1,
        precio:    p.precio ?? prod?.list_price ?? prod?.lst_price ?? 0,
        found:     !!prod,
        product_id:   prod?.id || null,
        product_name: prod?.name || null,
        uom_id:       prod?.uom_id || null,
        tax_ids:      prod?.taxes_id || [],
      };
    });

    res.json({
      cliente_raw: parsed.cliente,
      partners,
      lineas,
      notas: parsed.notas || '',
    });
  } catch (err) {
    console.error('[cotizacion-foto] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/odoo/cotizacion-crear', express.json(), async (req, res) => {
  try {
    const { partner_id, lineas, notas } = req.body;
    if (!partner_id) return res.status(400).json({ error: 'Se requiere partner_id' });
    if (!lineas?.length) return res.status(400).json({ error: 'Se requieren líneas de productos' });

    // ⚠️ ESCRITURA → usa STAGING, nunca producción
    const uid = await odooAuthStaging();

    const order_lines = lineas.map(l => [0, 0, {
      product_id:      l.product_id,
      name:            l.product_name,
      product_uom_qty: l.cantidad,
      price_unit:      l.precio,
      product_uom:     l.uom_id?.[0] || 1,
      tax_id:          [[6, 0, l.tax_ids || []]],
      ...(l.descuento ? { discount: l.descuento } : {}),
    }]);

    const orderId = await odooCallStaging('/xmlrpc/2/object', 'execute_kw', [
      ODOO_STAGING_DB, uid, ODOO_STAGING_API_KEY, 'sale.order', 'create',
      [{
        partner_id,
        pricelist_id: 2, // MAYORISTA UYU
        date_order:   new Date().toISOString().replace('T', ' ').slice(0, 19),
        note:         notas || '',
        order_line:   order_lines,
      }],
    ]);

    // Leer el nombre asignado
    const [order] = await odooCallStaging('/xmlrpc/2/object', 'execute_kw', [
      ODOO_STAGING_DB, uid, ODOO_STAGING_API_KEY, 'sale.order', 'read',
      [[orderId]], { fields: ['name', 'amount_total', 'partner_id'] },
    ]);

    res.json({ success: true, order_id: orderId, order_name: order.name, amount_total: order.amount_total });
  } catch (err) {
    console.error('[cotizacion-crear] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── WhatsApp webhook (Twilio) ────────────────────────────────────
const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;

app.post('/webhook/whatsapp', express.urlencoded({ extended: false }), async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();

  const reply = text => {
    twiml.message(text);
    res.type('text/xml').send(twiml.toString());
  };

  try {
    const numMedia = parseInt(req.body.NumMedia || '0');
    const from     = req.body.From;

    if (!numMedia) {
      return reply('Hola! Mandame una foto del pedido escrito a mano y lo cargo en Odoo automáticamente 📋');
    }

    const mediaUrl  = req.body.MediaUrl0;
    const mediaType = req.body.MediaContentType0 || 'image/jpeg';

    // Descargar imagen de Twilio usando el SDK
    const twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);
    const messageSid   = req.body.MessageSid || req.body.SmsSid;
    const mediaItems   = await twilioClient.messages(messageSid).media.list({ limit: 1 });
    if (!mediaItems.length) return reply('No se encontró imagen en el mensaje.');
    const mediaUri  = mediaItems[0].uri.replace('.json', '');
    const directUrl = `https://api.twilio.com${mediaUri}`;
    const imgResp = await axios.get(directUrl, {
      auth: { username: TWILIO_SID, password: TWILIO_TOKEN },
      responseType: 'arraybuffer',
    });
    const image_base64 = Buffer.from(imgResp.data).toString('base64');

    // Claude lee la imagen
    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: image_base64 } },
          { type: 'text', text: `Analizá este pedido escrito a mano y extraé el cliente y los productos.

Reglas para variantes de SKU (formato {BASE}-{COLOR} o {BASE}-{COLOR}-{TEMP}):
- Colores: B/BL/Blanco=BLA, N/NG/Negro=NEG, G/GR/Gris=GRI, R/RO/Rosa=ROS, V/VE/Verde=VER, D/DO/Dorado=DOR, P/PL/Plateado=PLA
- Temperatura: F/FRI=FRI, C/CAL=CAL
- "18110: 2B-2N" → dos líneas: {sku:"18110-BLA",cantidad:2} y {sku:"18110-NEG",cantidad:2}
- "22306 3FRI-2CAL" → dos líneas: {sku:"22306-FRI",cantidad:3} y {sku:"22306-CAL",cantidad:2}
- "25203 2BLA-FRI" → una línea: {sku:"25203-BLA-FRI",cantidad:2}
- Si no hay variante, usá el SKU base tal cual

Respondé ÚNICAMENTE con JSON válido, sin texto adicional:
{
  "cliente": "nombre del cliente",
  "productos": [
    { "sku": "18110-BLA", "cantidad": 2 },
    { "sku": "18110-NEG", "cantidad": 2 }
  ]
}` },
        ],
      }],
    });

    let parsed;
    try {
      const text = msg.content[0].text.trim().replace(/^```json\n?/, '').replace(/\n?```$/, '');
      parsed = JSON.parse(text);
    } catch {
      return reply('No pude leer el pedido de la imagen. ¿Podés mandar una foto más clara?');
    }

    // ⚠️ ESCRITURA → usa STAGING
    const uid = await odooAuthStaging();

    // Buscar cliente en staging
    const partners = await odooCallStaging('/xmlrpc/2/object', 'execute_kw', [
      ODOO_STAGING_DB, uid, ODOO_STAGING_API_KEY, 'res.partner', 'search_read',
      [[['name', 'ilike', parsed.cliente], ['customer_rank', '>', 0]]],
      { fields: ['id', 'name'], limit: 1 },
    ]);

    if (!partners.length) {
      return reply(`No encontré el cliente "${parsed.cliente}" en Odoo. Verificá el nombre y volvé a intentar.`);
    }
    const partner = partners[0];

    // Buscar productos en staging
    const skus = parsed.productos.map(p => p.sku);
    const products = await odooCallStaging('/xmlrpc/2/object', 'execute_kw', [
      ODOO_STAGING_DB, uid, ODOO_STAGING_API_KEY, 'product.product', 'search_read',
      [[['default_code', 'in', skus], ['active', '=', true]]],
      { fields: ['id', 'name', 'default_code', 'lst_price', 'uom_id', 'taxes_id'] },
    ]);

    const productMap = {};
    for (const p of products) productMap[p.default_code] = p;

    const notFound = skus.filter(s => !productMap[s]);
    if (notFound.length) {
      return reply(`No encontré estos SKUs en Odoo: ${notFound.join(', ')}. Revisá y volvé a intentar.`);
    }

    // Crear cotización en staging
    const order_lines = parsed.productos.map(p => {
      const prod = productMap[p.sku];
      return [0, 0, {
        product_id:      prod.id,
        name:            `[${p.sku}] ${prod.name}`,
        product_uom_qty: p.cantidad,
        price_unit:      prod.lst_price,
        product_uom:     prod.uom_id[0],
        tax_id:          [[6, 0, prod.taxes_id || []]],
      }];
    });

    const orderId = await odooCallStaging('/xmlrpc/2/object', 'execute_kw', [
      ODOO_STAGING_DB, uid, ODOO_STAGING_API_KEY, 'sale.order', 'create',
      [{
        partner_id:   partner.id,
        pricelist_id: 2,
        date_order:   new Date().toISOString().replace('T', ' ').slice(0, 19),
        order_line:   order_lines,
      }],
    ]);

    const [order] = await odooCallStaging('/xmlrpc/2/object', 'execute_kw', [
      ODOO_STAGING_DB, uid, ODOO_STAGING_API_KEY, 'sale.order', 'read',
      [[orderId]], { fields: ['name', 'amount_total'] },
    ]);

    const totalUnits = parsed.productos.reduce((s, p) => s + p.cantidad, 0);
    reply(`✅ Cotización creada en Odoo!\n\n📋 ${order.name}\n👤 ${partner.name}\n📦 ${parsed.productos.length} productos (${totalUnits} unidades)\n💰 $${order.amount_total.toLocaleString('es-UY')}`);

    console.log(`[whatsapp] cotización ${order.name} creada desde ${from}`);
  } catch (err) {
    console.error('[whatsapp] error:', err.message);
    reply('Ocurrió un error procesando el pedido. Intentá de nuevo.');
  }
});

// ── Usuarios y sesiones ──────────────────────────────────────────
const USERS_FILE = path.join(__dirname, 'data', 'users.json');

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}
function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch(e) {}
  return [];
}
function saveUsers(data) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Crear admin por defecto si no hay usuarios
(function ensureAdmin() {
  const users = loadUsers();
  if (!users.length) {
    const salt = crypto.randomBytes(16).toString('hex');
    users.push({
      id:       crypto.randomUUID(),
      username: 'admin',
      name:     'Administrador',
      role:     'admin',
      salt,
      hash:     hashPassword('admin123', salt),
      createdAt: new Date().toISOString(),
    });
    saveUsers(users);
    console.log('[usuarios] Usuario admin creado — password: admin123  (cambialo después)');
  }
})();

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 });
  saveSessions();
  return token;
}
function requireUser(req, res, next) {
  const token = req.headers['x-session-token'] || req.query._token;
  const session = token ? getSession(token) : null;
  if (!session) return res.status(401).json({ error: 'Sesión inválida' });
  const users = loadUsers();
  const user = users.find(u => u.id === session.userId);
  if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });
  req.user = user;
  next();
}
function requireAdmin(req, res, next) {
  requireUser(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin permiso' });
    next();
  });
}

// POST /api/auth/login
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Faltan credenciales' });
  const users = loadUsers();
  const user  = users.find(u => u.username === username);
  if (!user) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  const h = hashPassword(password, user.salt);
  if (h !== user.hash) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  const token = createSession(user.id);
  res.json({ token, user: { id: user.id, username: user.username, name: user.name, role: user.role } });
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
  const token = req.headers['x-session-token'];
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

// GET /api/auth/me
app.get('/api/auth/me', requireUser, (req, res) => {
  const { id, username, name, role, email } = req.user;
  res.json({ id, username, name, role, email });
});

// ── Google OAuth ──
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

app.get('/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(500).send('Google OAuth no configurado');
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const redirectUri = `${baseUrl}/auth/google/callback`;
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send('Sin código de autorización');
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const redirectUri = `${baseUrl}/auth/google/callback`;

    // Exchange code for tokens
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
      code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri, grant_type: 'authorization_code',
    });
    const { access_token } = tokenRes.data;

    // Get user info
    const userRes = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const { email, name, picture } = userRes.data;

    // Check if email is authorized
    const users = loadUsers();
    let user = users.find(u => u.email === email);

    if (!user) {
      // Check allowed emails list
      const ALLOWED_FILE = path.join(__dirname, 'data', 'allowed_emails.json');
      let allowed = [];
      try { allowed = fs.existsSync(ALLOWED_FILE) ? JSON.parse(fs.readFileSync(ALLOWED_FILE, 'utf8')) : []; } catch {}

      if (!allowed.includes(email)) {
        return res.send('<html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;"><div style="text-align:center;"><h2>Acceso denegado</h2><p>' + email + ' no está autorizado.</p><a href="/">Volver</a></div></body></html>');
      }

      // Create user automatically
      const salt = crypto.randomBytes(16).toString('hex');
      user = {
        id: crypto.randomUUID(),
        username: email.split('@')[0],
        name: name || email,
        email,
        picture,
        role: 'user',
        salt,
        hash: hashPassword(crypto.randomBytes(32).toString('hex'), salt), // random password
        createdAt: new Date().toISOString(),
        googleAuth: true,
      };
      users.push(user);
      saveUsers(users);
      console.log('[auth] nuevo usuario Google:', email);
    } else {
      // Update name/picture
      if (name && !user.name) user.name = name;
      if (picture) user.picture = picture;
      user.email = email;
      user.googleAuth = true;
      saveUsers(users);
    }

    // Create session
    const sessionTok = createSession(user.id);
    res.send(`<html><body><script>
      localStorage.setItem('session_token', '${sessionTok}');
      window.location.href = '/';
    </script></body></html>`);
  } catch (e) {
    console.error('[auth] Google OAuth error:', e.message);
    res.status(500).send('Error de autenticación: ' + e.message);
  }
});

// API para gestionar emails autorizados (admin)
const ALLOWED_EMAILS_FILE = path.join(__dirname, 'data', 'allowed_emails.json');
function loadAllowedEmails() { try { return fs.existsSync(ALLOWED_EMAILS_FILE) ? JSON.parse(fs.readFileSync(ALLOWED_EMAILS_FILE, 'utf8')) : ['alpuy.mateo@gmail.com']; } catch { return ['alpuy.mateo@gmail.com']; } }
function saveAllowedEmails(list) { fs.writeFileSync(ALLOWED_EMAILS_FILE, JSON.stringify(list, null, 2)); }

// Initialize file if not exists
if (!fs.existsSync(ALLOWED_EMAILS_FILE)) saveAllowedEmails(['alpuy.mateo@gmail.com']);

app.get('/api/auth/allowed-emails', requireAdmin, (req, res) => {
  res.json(loadAllowedEmails());
});

app.post('/api/auth/allowed-emails', requireAdmin, (req, res) => {
  const { email, action } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido' });
  let list = loadAllowedEmails();
  if (action === 'add' && !list.includes(email)) list.push(email);
  if (action === 'remove') list = list.filter(e => e !== email);
  saveAllowedEmails(list);
  res.json({ ok: true, emails: list });
});

// GET /api/users  (admin)
app.get('/api/users', requireAdmin, (req, res) => {
  res.json(loadUsers().map(({ id, username, name, role, createdAt }) => ({ id, username, name, role, createdAt })));
});

// POST /api/users  (admin)
app.post('/api/users', requireAdmin, (req, res) => {
  const { username, name, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username y password son requeridos' });
  const users = loadUsers();
  if (users.find(u => u.username === username)) return res.status(409).json({ error: 'El usuario ya existe' });
  const salt = crypto.randomBytes(16).toString('hex');
  const user = { id: crypto.randomUUID(), username, name: name || username, role: role || 'user', salt, hash: hashPassword(password, salt), createdAt: new Date().toISOString() };
  users.push(user);
  saveUsers(users);
  res.json({ id: user.id, username: user.username, name: user.name, role: user.role });
});

// PUT /api/users/:id  (admin — cambia nombre, rol o password)
app.put('/api/users/:id', requireAdmin, (req, res) => {
  const users = loadUsers();
  const idx   = users.findIndex(u => u.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Usuario no encontrado' });
  const { name, role, password } = req.body || {};
  if (name)     users[idx].name = name;
  if (role)     users[idx].role = role;
  if (password) {
    const salt = crypto.randomBytes(16).toString('hex');
    users[idx].salt = salt;
    users[idx].hash = hashPassword(password, salt);
  }
  saveUsers(users);
  res.json({ id: users[idx].id, username: users[idx].username, name: users[idx].name, role: users[idx].role });
});

// DELETE /api/users/:id  (admin)
app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const users = loadUsers();
  if (users.find(u => u.id === req.params.id)?.role === 'admin' &&
      users.filter(u => u.role === 'admin').length === 1)
    return res.status(400).json({ error: 'No podés eliminar el único admin' });
  saveUsers(users.filter(u => u.id !== req.params.id));
  res.json({ ok: true });
});

// ── ML: comisiones por categoría (cache en disco) ────────────────
const FEES_FILE = path.join(__dirname, 'data', 'ml_fees_cache.json');
let feesCache   = {};   // { category_id: { fee_pct, shipping_pct, updatedAt } }

try {
  if (fs.existsSync(FEES_FILE)) feesCache = JSON.parse(fs.readFileSync(FEES_FILE, 'utf8'));
} catch(e) {}

async function fetchCategoryFee(categoryId, samplePrice, headers) {
  try {
    const r = await axios.get(`${ML_API_URL}/sites/MLU/listing_prices`, {
      headers,
      params: { price: samplePrice, category_id: categoryId, listing_type_id: 'gold_special', currency_id: 'UYU' },
    });
    const fee_pct      = samplePrice > 0 ? parseFloat(((r.data.sale_fee_amount  || 0) / samplePrice * 100).toFixed(2)) : 0;
    const shipping_pct = samplePrice > 0 ? parseFloat(((r.data.free_shipping_cost?.cost || 0) / samplePrice * 100).toFixed(2)) : 0;
    return { fee_pct, shipping_cost: r.data.free_shipping_cost?.cost || 0, updatedAt: new Date().toISOString() };
  } catch(e) { return null; }
}

async function refreshFees(force = false) {
  if (!tokenData?.access_token) return;
  const headers = { Authorization: `Bearer ${tokenData.access_token}` };
  // Agrupar items por categoría con precio promedio
  const byCat = {};
  for (const item of cachedStock) {
    if (!item.category_id || !item.price) continue;
    if (!byCat[item.category_id]) byCat[item.category_id] = [];
    byCat[item.category_id].push(item.price);
  }
  let updated = 0;
  for (const [catId, prices] of Object.entries(byCat)) {
    if (!force && feesCache[catId] && feesCache[catId].updatedAt) {
      const age = Date.now() - new Date(feesCache[catId].updatedAt).getTime();
      if (age < 24 * 60 * 60 * 1000) continue; // usar cache si tiene menos de 24h
    }
    const avg = Math.round(prices.reduce((a,b) => a+b, 0) / prices.length);
    const fee = await fetchCategoryFee(catId, avg, headers);
    if (fee) { feesCache[catId] = fee; updated++; }
    await sleep(150);
  }
  if (updated > 0) {
    fs.writeFileSync(FEES_FILE, JSON.stringify(feesCache), 'utf8');
    console.log(`[fees] actualizadas ${updated} categorías`);
  }
}

// Config de costos de envío (editable por el usuario)
const SHIPPING_CFG_FILE = path.join(__dirname, 'data', 'shipping_config.json');
const DEFAULT_SHIPPING_CFG = {
  flex: {
    label: 'Flex (MUNDOSHOP)',
    note: 'Solo Montevideo y Canelones — costo por zona — vos siempre pagás',
    always_seller: true,
    // Zonas configurables con su costo. Para simular se usa el promedio ponderado.
    zones: [
      { name: 'Zona 1 (cerca)',  cost: 150 },
      { name: 'Zona 2 (media)',  cost: 200 },
      { name: 'Zona 3 (lejos)',  cost: 250 },
    ],
  },
  me2: {
    label: 'ME2 (Mercado Envíos / UES drop-off)',
    note: 'Vendedor paga solo si precio ≥ umbral — promedio histórico entre zonas',
    seller_threshold: 1200,
    avg_cost: 330,
  },
  me1: {
    label: 'ME1 (bultos grandes)',
    note: 'Costo fijo que vos configurás — se aplica por publicación o globalmente',
    always_seller: true,
    default_cost: 500,      // costo global por defecto
  },
};

function loadShippingCfg() {
  try {
    if (fs.existsSync(SHIPPING_CFG_FILE)) return JSON.parse(fs.readFileSync(SHIPPING_CFG_FILE, 'utf8'));
  } catch(e) {}
  return DEFAULT_SHIPPING_CFG;
}
function saveShippingCfg(data) {
  fs.writeFileSync(SHIPPING_CFG_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// mlShippingCost: costo que da ML para ME2 (del feesCache)
function calcShippingCost(cfg, logisticType, price, mlShippingCost) {
  if (logisticType === 'self_service') {
    // Flex: promedio de zonas configuradas
    const zones = cfg.flex?.zones || [];
    if (!zones.length) return 0;
    return Math.round(zones.reduce((s, z) => s + z.cost, 0) / zones.length);
  }
  if (logisticType === 'drop_off') {
    // ME2: vendedor paga solo si precio >= threshold
    if (cfg.me2?.seller_threshold && price < cfg.me2.seller_threshold) return 0;
    return cfg.me2?.avg_cost || 0;
  }
  if (logisticType === 'default') {
    // ME1: costo fijo configurado por el vendedor
    return cfg.me1?.default_cost || 0;
  }
  return 0;
}

app.get('/api/ml/shipping-config', requireToken, (req, res) => res.json(loadShippingCfg()));
app.put('/api/ml/shipping-config', requireToken, (req, res) => {
  saveShippingCfg(req.body);
  res.json({ ok: true });
});

// GET /api/ml/fees — devuelve fees por categoría y dispara refresh si hace falta
app.get('/api/ml/fees', requireToken, async (req, res) => {
  const force = req.query.force === 'true';
  if (force || Object.keys(feesCache).length === 0) await refreshFees(force);
  res.json({ categories: Object.keys(feesCache).length, fees: feesCache });
});

// ── Cache de costos de envío reales por item (histórico 36 meses) ──
const SHIP_COSTS_FILE = path.join(__dirname, 'data', 'shipping_costs_by_item.json');
let shipCostsCache = {};   // { item_id: { avg_cost, count, logistic_type, sku } }
let shipCostsAnalyzing = false;
let shipCostsProgress  = { status: 'idle', orders: 0, shipments: 0, items: 0, error: null };

try {
  if (fs.existsSync(SHIP_COSTS_FILE)) {
    shipCostsCache = JSON.parse(fs.readFileSync(SHIP_COSTS_FILE, 'utf8'));
    console.log(`[ship-costs] cache cargado: ${Object.keys(shipCostsCache).length} items`);
  }
} catch(e) {}

// POST /api/ml/shipping-costs/analyze — analiza histórico 36 meses y promedia costo por item
app.post('/api/ml/shipping-costs/analyze', requireToken, async (req, res) => {
  if (shipCostsAnalyzing) return res.json({ ok: false, msg: 'Ya está corriendo', progress: shipCostsProgress });
  res.json({ ok: true, msg: 'Análisis iniciado en background' });
  shipCostsAnalyzing = true;
  shipCostsProgress  = { status: 'scanning', orders: 0, shipments: 0, items: 0, error: null };

  try {
    const headers = { Authorization: `Bearer ${tokenData.access_token}` };
    const uid     = tokenData.user_id;

    // 1. Scroll completo de órdenes (últimos 36 meses)
    const threeYrsAgo = new Date();
    threeYrsAgo.setFullYear(threeYrsAgo.getFullYear() - 3);

    const ordersWithShip = [];  // { shipping_id, item_id, sku, logistic_type }
    let scrollId = null;

    while (true) {
      const params = { seller: uid, limit: 50, search_type: 'scan' };
      if (scrollId) params.scroll_id = scrollId;
      const r = await axios.get(`${ML_API_URL}/orders/search`, { headers, params });
      const results = r.data.results || [];

      for (const order of results) {
        if (new Date(order.date_created) < threeYrsAgo) continue;
        const shipId    = order.shipping?.id;
        const logistic  = order.shipping?.logistic_type;
        if (!shipId) continue;
        for (const oi of (order.order_items || [])) {
          const itemId = oi.item?.id;
          const sku    = (oi.item?.seller_custom_field) || null;
          if (itemId) ordersWithShip.push({ shipping_id: shipId, item_id: itemId, sku, logistic_type: logistic });
        }
      }
      shipCostsProgress.orders = ordersWithShip.length;

      if (!results.length || !r.data.scroll_id) break;
      scrollId = r.data.scroll_id;
      await sleep(300);
    }

    console.log(`[ship-costs] ${ordersWithShip.length} líneas de orden con envío`);
    shipCostsProgress.status = 'fetching_shipments';

    // 2. Shipments únicos
    const uniqueShipIds = [...new Set(ordersWithShip.map(o => o.shipping_id))];
    const shipCostById  = {};   // { shipping_id: base_cost }

    for (let i = 0; i < uniqueShipIds.length; i += 5) {
      const batch = uniqueShipIds.slice(i, i + 5);
      await Promise.all(batch.map(async shipId => {
        try {
          const r = await axios.get(`${ML_API_URL}/shipments/${shipId}`, { headers });
          const base = r.data?.base_cost;
          if (base != null) shipCostById[shipId] = base;
        } catch(e) {}
      }));
      shipCostsProgress.shipments = Object.keys(shipCostById).length;
      if (i % 100 === 0) console.log(`[ship-costs] shipments fetched: ${shipCostsProgress.shipments}/${uniqueShipIds.length}`);
      await sleep(200);
    }

    // 3. Agrupar base_cost por item_id
    const byItem = {};
    for (const o of ordersWithShip) {
      const cost = shipCostById[o.shipping_id];
      if (cost == null || cost <= 0) continue;
      if (!byItem[o.item_id]) byItem[o.item_id] = { costs: [], logistic_type: o.logistic_type, sku: o.sku };
      byItem[o.item_id].costs.push(cost);
    }

    // 4. Calcular promedio y guardar
    const result = {};
    for (const [itemId, d] of Object.entries(byItem)) {
      const avg = d.costs.reduce((s, c) => s + c, 0) / d.costs.length;
      result[itemId] = { avg_cost: Math.round(avg), count: d.costs.length, logistic_type: d.logistic_type, sku: d.sku };
    }
    shipCostsCache = result;
    fs.writeFileSync(SHIP_COSTS_FILE, JSON.stringify(result), 'utf8');
    shipCostsProgress = { status: 'done', orders: ordersWithShip.length, shipments: Object.keys(shipCostById).length, items: Object.keys(result).length, error: null };
    console.log(`[ship-costs] análisis completo — ${Object.keys(result).length} items con costo histórico`);
  } catch(e) {
    shipCostsProgress = { ...shipCostsProgress, status: 'error', error: e.message };
    console.error('[ship-costs] error:', e.message);
  } finally {
    shipCostsAnalyzing = false;
  }
});

app.get('/api/ml/shipping-costs/status', requireToken, (req, res) => {
  res.json({ ...shipCostsProgress, cached_items: Object.keys(shipCostsCache).length });
});

// ── Analizador de publicaciones con Claude ───────────────────────
app.post('/api/ml/analizar-publicaciones', requireToken, async (req, res) => {
  const { item_ids } = req.body;
  if (!Array.isArray(item_ids) || item_ids.length === 0 || item_ids.length > 5)
    return res.status(400).json({ error: 'Enviá entre 1 y 5 item_ids' });

  const headers = { Authorization: `Bearer ${tokenData.access_token}` };

  try {
    // 1. Traer detalles completos de cada publicación
    const details = await Promise.all(item_ids.map(async id => {
      const [itemR, descR] = await Promise.all([
        axios.get(`${ML_API_URL}/items/${id}`, { headers }).catch(() => null),
        axios.get(`${ML_API_URL}/items/${id}/description`, { headers }).catch(() => null),
      ]);
      if (!itemR) return null;
      const item = itemR.data;
      // Atributos importantes vs faltantes
      const attrs = (item.attributes || []).map(a => ({
        id: a.id, name: a.name,
        value: a.value_name || a.values?.[0]?.name || null,
      }));
      const attrsFilled   = attrs.filter(a => a.value);
      const attrsEmpty    = attrs.filter(a => !a.value);
      // Info de stock del cache
      const stockItem = cachedStock.find(s => s.id === id);
      return {
        id, title: item.title, status: item.status,
        price: item.price, currency: item.currency_id,
        listing_type: item.listing_type_id,
        condition: item.condition,
        category_id: item.category_id,
        pictures_count: (item.pictures || []).length,
        pictures: (item.pictures || []).slice(0, 3).map(p => p.url),
        description: descR?.data?.plain_text?.slice(0, 800) || '',
        attrs_filled: attrsFilled.length,
        attrs_empty: attrsEmpty.length,
        attrs_empty_names: attrsEmpty.slice(0, 10).map(a => a.name),
        attrs_sample: attrsFilled.slice(0, 8).map(a => `${a.name}: ${a.value}`),
        sold30d: stockItem?.sold30d ?? null,
        stock: stockItem?.stock ?? null,
        permalink: item.permalink,
      };
    }));

    const validItems = details.filter(Boolean);
    if (!validItems.length) return res.status(404).json({ error: 'No se pudieron obtener los items' });

    // 2. Llamar a Claude para analizar
    const prompt = `Sos un experto en optimización de publicaciones de MercadoLibre Uruguay.
Analizá cada una de estas publicaciones y dá tips concretos y priorizados para mejorar la conversión.

Criterios clave para ML Uruguay:
- Título: máximo 60 caracteres, incluir marca + modelo + característica principal + condición. Usar keywords que buscan los compradores.
- Fotos: mínimo 6-8 fotos, fondo blanco en la principal, distintos ángulos, detalles importantes.
- Atributos: ML prioriza en búsqueda las publicaciones con atributos completos. Cada atributo vacío es una penalización.
- Descripción: clara, con las características más importantes primero, evitar texto genérico.
- Tipo de publicación: Gold Special tiene mejor posicionamiento.
- Precio: considerar si es competitivo para la categoría.

Para cada publicación respondé en este formato JSON exacto:
{
  "id": "MLU...",
  "score": 65,
  "resumen": "una línea con el estado general",
  "tips": [
    { "prioridad": "alta", "categoria": "titulo", "problema": "...", "accion": "..." },
    { "prioridad": "media", "categoria": "fotos", "problema": "...", "accion": "..." }
  ]
}

Categorías posibles: titulo, fotos, atributos, descripcion, precio, tipo_publicacion, otro.
Prioridades: alta, media, baja.
Máximo 5 tips por publicación, ordenados por impacto.

Publicaciones a analizar:
${JSON.stringify(validItems, null, 2)}

Respondé SOLO con un array JSON válido, sin texto adicional. No uses comillas dobles dentro de los strings — usá comillas simples o reemplazalas con espacios. No uses saltos de línea dentro de los valores de string.`;

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = msg.content[0].text.trim();
    // Extraer JSON del response — intentar parsear directamente, luego buscar array
    let analysis;
    const jsonMatch = raw.match(/\[[\s\S]*\]/s);
    if (!jsonMatch) return res.status(500).json({ error: 'Respuesta inválida de Claude', raw: raw.slice(0, 300) });
    try {
      analysis = JSON.parse(jsonMatch[0]);
    } catch(parseErr) {
      // Intentar extraer cada objeto individualmente
      analysis = [];
      for (const m of jsonMatch[0].matchAll(/\{[\s\S]*?"tips"[\s\S]*?\]\s*\}/g)) {
        try { analysis.push(JSON.parse(m[0])); } catch(e2) {}
      }
      if (!analysis.length)
        return res.status(500).json({ error: 'JSON inválido de Claude', detail: parseErr.message, raw: raw.slice(0, 300) });
    }

    res.json({ items: validItems, analysis });
  } catch(e) {
    console.error('[analizar-publicaciones]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Mensajes post-venta ───────────────────────────────────────────

const MENSAJES_CACHE_FILE = path.join(__dirname, 'data', 'mensajes_cache.json');
const MENSAJES_CACHE_TTL = 5 * 60 * 1000; // 5 minutos
let mensajesCache = null; // { ts, threads }

function loadMensajesCache() {
  try {
    if (fs.existsSync(MENSAJES_CACHE_FILE)) {
      mensajesCache = JSON.parse(fs.readFileSync(MENSAJES_CACHE_FILE, 'utf8'));
    }
  } catch {}
}
function saveMensajesCache(threads) {
  mensajesCache = { ts: Date.now(), threads };
  try { fs.writeFileSync(MENSAJES_CACHE_FILE, JSON.stringify(mensajesCache)); } catch {}
}
loadMensajesCache();

// GET /api/ml/mensajes/pendientes — hilos con último mensaje del comprador
app.get('/api/ml/mensajes/pendientes', requireToken, async (req, res) => {
  const headers = { Authorization: `Bearer ${tokenData.access_token}` };
  const uid = tokenData.user_id;
  const dias = parseInt(req.query.dias) || 14;
  const force = req.query.force === '1';

  // Servir desde cache si está fresco y no se pide force
  if (!force && mensajesCache && (Date.now() - mensajesCache.ts) < MENSAJES_CACHE_TTL) {
    return res.json({ threads: mensajesCache.threads, total: mensajesCache.threads.length, cached: true });
  }

  try {
    const cutoff = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);

    // Escanear órdenes en paralelo por páginas (en lotes de 5 páginas simultáneas)
    const allOrders = [];
    const seenPacks = new Set();

    // Primero obtener total para saber cuántas páginas hay en el rango
    const firstPage = await axios.get(`${ML_API_URL}/orders/search`, {
      headers, params: { seller: uid, limit: 50, sort: 'date_desc', offset: 0 }
    });
    const firstResults = firstPage.data.results || [];

    // Estimar cuántas páginas necesitamos (basado en que la última orden de la primera página tiene fecha X)
    // Si la primera página ya pasa el cutoff, listo
    let neededPages = 1;
    if (firstResults.length && new Date(firstResults[firstResults.length - 1].date_created) >= cutoff) {
      // Necesitamos más páginas — estimar cuántas
      const totalOrders = firstPage.data.paging?.total || 0;
      // Aproximar con un límite razonable de 20 páginas (1000 órdenes)
      neededPages = Math.min(20, Math.ceil(totalOrders / 50));
    }

    // Cargar todas las páginas necesarias en paralelo
    const pagePromises = [Promise.resolve(firstPage)];
    for (let p = 1; p < neededPages; p++) {
      pagePromises.push(axios.get(`${ML_API_URL}/orders/search`, {
        headers, params: { seller: uid, limit: 50, sort: 'date_desc', offset: p * 50 }
      }).catch(() => ({ data: { results: [] } })));
    }
    const pages = await Promise.all(pagePromises);

    for (const page of pages) {
      for (const o of page.data.results || []) {
        if (new Date(o.date_created) < cutoff) break;
        const key = o.pack_id || o.id;
        if (!seenPacks.has(key)) { seenPacks.add(key); allOrders.push(o); }
      }
    }

    const orders = allOrders;

    const itemMap = {};
    cachedItems.forEach(i => { itemMap[i.id] = i; });

    const threads = [];
    // Procesar en lotes de 30 para no saturar el rate limit
    const BATCH = 30;
    for (let i = 0; i < orders.length; i += BATCH) {
      await Promise.all(orders.slice(i, i + BATCH).map(async (order) => {
      const packOrOrder = order.pack_id || order.id;
      try {
        const mr = await axios.get(`${ML_API_URL}/messages/packs/${packOrOrder}/sellers/${uid}`, {
          headers, params: { tag: 'post_sale', limit: 50 }
        });
        const msgs = (mr.data.messages || []).filter(m => m.text && m.text.trim());
        if (!msgs.length) return;

        msgs.sort((a, b) => new Date(a.message_date.created) - new Date(b.message_date.created));
        const lastMsg = msgs[msgs.length - 1];
        const lastIsFromBuyer = lastMsg.from?.user_id !== uid;
        const lastDate = new Date(lastMsg.message_date.created);

        // Mostrar si: último mensaje del comprador reciente, O cualquier mensaje del comprador sin leer
        const hasUnreadFromBuyer = msgs.some(m => m.from?.user_id !== uid && !m.message_date?.read);
        if (!lastIsFromBuyer && !hasUnreadFromBuyer) return;
        if (lastDate < cutoff && !hasUnreadFromBuyer) return;

        const oi = order.order_items?.[0] || {};
        const itemId = oi.item?.id;
        const cachedItem = itemMap[itemId] || {};

        // Si no hay thumbnail en el cache, traerlo de ML (usa itemDetailCache para no repetir)
        let itemTitle = oi.item?.title || cachedItem.title || '';
        let itemThumbnail = cachedItem.thumbnail || '';
        if (itemId && !itemThumbnail) {
          const ctx = await fetchItemContext(itemId).catch(() => null);
          if (ctx) {
            if (!itemTitle) itemTitle = ctx.title || '';
            // fetchItemContext no devuelve thumbnail — buscar en cachedItems actualizado
            const fresh = itemMap[itemId];
            if (fresh?.thumbnail) itemThumbnail = fresh.thumbnail;
            else if (ctx.thumbnail) itemThumbnail = ctx.thumbnail;
          }
        }

        const shp = order.shipping || {};
        const addr = shp.receiver_address || {};
        const shipping = shp.id ? {
          id: shp.id,
          status: shp.status || '',
          receiver_name: addr.receiver_name || order.buyer?.nickname || '',
          address: addr.address_line || '',
          city: addr.city?.name || '',
          state: addr.state?.name || '',
          zip: addr.zip_code || '',
          comments: addr.comment || ''
        } : null;

        threads.push({
          order_id: order.id,
          pack_id: packOrOrder,
          buyer_id: order.buyer?.id,
          buyer_name: order.buyer?.nickname || '—',
          item_id: itemId,
          item_title: itemTitle || '—',
          item_thumbnail: itemThumbnail || '',
          order_status: order.status,
          total_amount: order.total_amount,
          shipping,
          last_message: lastMsg.text,
          last_message_date: lastMsg.message_date.created,
          unread: !lastMsg.message_date.read,
          messages: msgs.map(m => ({
            id: m.id,
            from_buyer: m.from?.user_id !== uid,
            text: m.text,
            date: m.message_date.created,
            read: !!m.message_date.read
          }))
        });
      } catch(e) { /* skip */ }
      })); // fin lote
    } // fin for lotes

    // Ordenar por fecha del último mensaje, más reciente primero
    threads.sort((a, b) => new Date(b.last_message_date) - new Date(a.last_message_date));
    saveMensajesCache(threads);
    res.json({ threads, total: threads.length, cached: false });
  } catch(e) {
    console.error('[mensajes/pendientes]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/ml/mensajes/simular — sugiere respuesta IA para un hilo
app.post('/api/ml/mensajes/simular', requireToken, async (req, res) => {
  if (!anthropic) return res.status(400).json({ error: 'ANTHROPIC_API_KEY no configurada' });
  const { pack_id, item_id, item_title, order_status, messages } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'messages requerido' });

  try {
    let kb = null;
    if (fs.existsSync(QA_KB_FILE)) kb = JSON.parse(fs.readFileSync(QA_KB_FILE, 'utf8'));

    const kbText = kb ? `Estilo MUNDO SHOP:
- Saludo: "${kb.estilo.saludo}"
- Despedida: "${kb.estilo.despedida}"
- Tono: ${kb.estilo.tono}
Reglas:
${kb.reglas_generales.slice(0, 8).map(r => '- ' + r).join('\n')}` : '';

    const reglasText = reglasTexto(filtrarReglasPorContexto(loadReglasNegocio(), 'post-venta'));

    // Ejemplos de respuestas malas para que Claude las evite
    let malasText = '';
    try {
      if (fs.existsSync(BAD_RESP_FILE)) {
        const malas = JSON.parse(fs.readFileSync(BAD_RESP_FILE, 'utf8')).slice(-10);
        if (malas.length) malasText = `\nEJEMPLOS DE RESPUESTAS MALAS — NO imites esto:\n${malas.map(m => `- "${m.respuesta_mala.slice(0, 120)}"${m.motivo ? ' (' + m.motivo + ')' : ''}`).join('\n')}`;
      }
    } catch(_) {}

    // Fetch item context
    const itemCtx = item_id ? await fetchItemContext(item_id) : null;
    const itemText = itemCtx ? buildItemContextText(itemCtx) : `Producto: ${item_title || 'no especificado'}`;

    const historial = messages.map(m =>
      `[${m.from_buyer ? 'COMPRADOR' : 'VENDEDOR'}]: ${m.text}`
    ).join('\n');

    // ¿Conversación ya iniciada? (hay al menos 1 mensaje del vendedor antes del último)
    const vendedorYaHabló = messages.slice(0, -1).some(m => !m.from_buyer);

    // Último mensaje del comprador — para que el modelo focalice
    const lastBuyerMsg = [...messages].reverse().find(m => m.from_buyer);

    const r = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Sos el asistente post-venta de MUNDO SHOP en Mercado Libre Uruguay.
${kbText}
${reglasText ? 'REGLAS DEL NEGOCIO (usá estos datos exactos cuando apliquen, tienen prioridad):' + reglasText : ''}
${malasText}

${itemText}
Estado de la orden: ${order_status || 'desconocido'}

--- HISTORIAL COMPLETO ---
${historial}
--- FIN HISTORIAL ---

ÚLTIMO MENSAJE DEL COMPRADOR (esto es lo que necesita respuesta ahora):
"${lastBuyerMsg?.text || ''}"

${vendedorYaHabló
  ? 'Esta es una conversación en curso. NO uses saludo ni despedida. Respondé directamente y brevemente (1-2 oraciones máximo), como si siguieras la charla.'
  : 'Primera interacción. Usá el saludo y la despedida estándar de MUNDO SHOP.'
}
Si hay un problema o reclamo, sugerí también una acción concreta (ej: "Coordinar retiro", "Emitir reembolso", "Reenviar producto", etc.).
Respondé en JSON con este formato exacto:
{"respuesta":"texto de la respuesta","accion":null}
Si hay acción recomendada pon la acción en el campo accion, si no null.`
      }]
    });

    const text = r.content[0].text.trim();
    try {
      const match = text.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match[0]);
      // Si respuesta es a su vez un JSON, extraer el campo interno
      if (typeof parsed.respuesta === 'string' && parsed.respuesta.trim().startsWith('{')) {
        try {
          const inner = JSON.parse(parsed.respuesta);
          if (inner.respuesta) { parsed.respuesta = inner.respuesta; if (!parsed.accion) parsed.accion = inner.accion; }
        } catch(_) {}
      }
      res.json(parsed);
    } catch(e) {
      // Último recurso: devolver el texto limpio sin JSON
      const clean = text.replace(/```json?/gi,'').replace(/```/g,'').trim();
      res.json({ respuesta: clean, accion: null });
    }
  } catch(e) {
    console.error('[mensajes/simular]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/ml/mensajes/responder — envía mensaje al comprador vía ML
app.post('/api/ml/mensajes/responder', requireToken, async (req, res) => {
  const { pack_id, buyer_id, text } = req.body;
  if (!pack_id || !buyer_id || !text) return res.status(400).json({ error: 'pack_id, buyer_id y text requeridos' });
  const uid = tokenData.user_id;
  try {
    const r = await axios.post(
      `${ML_API_URL}/messages/packs/${pack_id}/sellers/${uid}?tag=post_sale`,
      { from: { user_id: uid }, to: { user_id: buyer_id }, text },
      { headers: { Authorization: `Bearer ${tokenData.access_token}`, 'Content-Type': 'application/json' } }
    );
    res.json({ ok: true, message_id: r.data.id });
  } catch(e) {
    const detail = e.response?.data || e.message;
    console.error('[mensajes/responder]', detail);
    res.status(e.response?.status || 500).json({ error: detail });
  }
});

// ── Preguntas frecuentes por publicación ─────────────────────────
const PREGUNTAS_FILE  = path.join(__dirname, 'data', 'preguntas_por_publicacion.json');
const QA_KB_FILE      = path.join(__dirname, 'data', 'qa_knowledge_base.json');
const REGLAS_NEGOCIO_FILE = path.join(__dirname, 'data', 'reglas_negocio.json');

// Similitud por overlap de palabras (0 a 1) — sin dependencias externas
function similaridad(a, b) {
  const tokenize = s => s.toLowerCase().replace(/[^a-záéíóúüñ0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  const wa = new Set(tokenize(a));
  const wb = new Set(tokenize(b));
  if (!wa.size || !wb.size) return 0;
  let interseccion = 0;
  wa.forEach(w => { if (wb.has(w)) interseccion++; });
  return interseccion / Math.sqrt(wa.size * wb.size);
}

// Devuelve los N ejemplos aprendidos más similares a la pregunta
function buscarSimilares(pregunta, n = 8) {
  if (!fs.existsSync(LEARNED_FILE)) return [];
  try {
    const learned = JSON.parse(fs.readFileSync(LEARNED_FILE, 'utf8'));
    return learned
      .map(e => ({ ...e, score: similaridad(pregunta, e.pregunta) }))
      .filter(e => e.score > 0.1)
      .sort((a, b) => b.score - a.score)
      .slice(0, n);
  } catch(e) { return []; }
}

function loadReglasNegocio() {
  if (!fs.existsSync(REGLAS_NEGOCIO_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(REGLAS_NEGOCIO_FILE, 'utf8')); } catch(e) { return []; }
}

// Filtra reglas por contexto: solo las categorías relevantes + General + sin categoría
// contextos válidos: 'post-venta', 'preguntas', 'tareas'
function filtrarReglasPorContexto(reglas, contexto) {
  const MAP = {
    'post-venta': ['post-venta', 'envíos', 'retiros', 'general'],
    'preguntas':  ['preguntas', 'envíos', 'general'],
    'tareas':     ['tareas', 'envíos', 'general'],
  };
  const permitidas = MAP[contexto] || null;
  if (!permitidas) return reglas;
  return reglas.filter(r => {
    if (!r.categoria) return true; // sin categoría → siempre incluir
    return permitidas.includes(r.categoria.toLowerCase());
  });
}

function reglasTexto(reglas) {
  if (!reglas.length) return '';
  return `\nInformación del negocio:\n${reglas.map(r => `- ${r.categoria ? '[' + r.categoria + '] ' : ''}${r.texto}`).join('\n')}`;
}

// GET /api/config/reglas
app.get('/api/config/reglas', requireToken, (req, res) => {
  res.json(loadReglasNegocio());
});

// POST /api/config/reglas
app.post('/api/config/reglas', requireToken, (req, res) => {
  const { texto, categoria } = req.body;
  if (!texto?.trim()) return res.status(400).json({ error: 'texto requerido' });
  const reglas = loadReglasNegocio();
  const nueva = { id: Date.now(), texto: texto.trim(), categoria: categoria?.trim() || '' };
  reglas.push(nueva);
  fs.writeFileSync(REGLAS_NEGOCIO_FILE, JSON.stringify(reglas, null, 2));
  res.json(nueva);
});

// DELETE /api/config/reglas/:id
app.delete('/api/config/reglas/:id', requireToken, (req, res) => {
  const id = parseInt(req.params.id);
  const reglas = loadReglasNegocio().filter(r => r.id !== id);
  fs.writeFileSync(REGLAS_NEGOCIO_FILE, JSON.stringify(reglas, null, 2));
  res.json({ ok: true });
});

// GET /api/config/reglas/interpretar — Claude resume cómo va a aplicar las reglas
app.get('/api/config/reglas/interpretar', requireToken, async (req, res) => {
  if (!anthropic) return res.status(400).json({ error: 'ANTHROPIC_API_KEY no configurada' });
  const reglas = loadReglasNegocio();
  if (!reglas.length) return res.json({ interpretacion: '' });
  try {
    const r = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Sos el asistente de MUNDO SHOP. Te dieron las siguientes reglas de negocio para usar al responder clientes en Mercado Libre:

${reglas.map(r => `- ${r.categoria ? '[' + r.categoria + '] ' : ''}${r.texto}`).join('\n')}

Resumí cada regla en formato diagrama de una línea: "situación → acción/dato clave". Una línea por regla, sin explicaciones, sin puntos, directo al grano. Ejemplo: "retiro muebles → Av. Italia 1234"`
      }]
    });
    res.json({ interpretacion: r.content[0].text.trim() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ml/preguntas/pendientes — preguntas sin responder de ML
app.get('/api/ml/preguntas/pendientes', requireToken, async (req, res) => {
  try {
    const dias = parseInt(req.query.dias) || 7; // por defecto últimos 7 días
    const r = await axios.get(`${ML_API_URL}/my/received_questions/search`, {
      params: { status: 'UNANSWERED', limit: 50 },
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const questions = r.data.questions || [];
    const cutoff = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);
    const filtered = dias === 0 ? questions : questions.filter(q => new Date(q.date_created) >= cutoff);

    const itemMap = {};
    cachedItems.forEach(i => { itemMap[i.id] = i; });
    const enriched = await Promise.all(filtered.map(async q => {
      const item = itemMap[q.item_id] || {};
      let item_title = item.title || '';
      let item_thumbnail = item.thumbnail || '';
      if (q.item_id && (!item_title || !item_thumbnail)) {
        const ctx = await fetchItemContext(q.item_id).catch(() => null);
        if (ctx) {
          if (!item_title) item_title = ctx.title || q.item_id;
          if (!item_thumbnail) item_thumbnail = ctx.thumbnail || '';
        }
      }
      return {
        id: q.id,
        item_id: q.item_id,
        item_title: item_title || q.item_id,
        item_thumbnail,
        text: q.text,
        date_created: q.date_created,
        from_id: q.from?.id
      };
    }));
    res.json({ questions: enriched, total: enriched.length, total_ml: r.data.total });
  } catch(e) {
    console.error('[preguntas/pendientes]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Helper: trae atributos + descripción de un ítem de ML (con cache persistido en disco)
const ITEM_CACHE_FILE = path.join(__dirname, 'data', 'item_detail_cache.json');
const itemDetailCache = (() => {
  try { return fs.existsSync(ITEM_CACHE_FILE) ? JSON.parse(fs.readFileSync(ITEM_CACHE_FILE, 'utf8')) : {}; } catch { return {}; }
})();
function saveItemCache() {
  try { fs.writeFileSync(ITEM_CACHE_FILE, JSON.stringify(itemDetailCache)); } catch {}
}

async function fetchItemContext(itemId) {
  if (itemDetailCache[itemId]) return itemDetailCache[itemId];
  try {
    const [itemR, descR] = await Promise.allSettled([
      axios.get(`${ML_API_URL}/items/${itemId}`, { headers: { Authorization: `Bearer ${tokenData.access_token}` } }),
      axios.get(`${ML_API_URL}/items/${itemId}/description`, { headers: { Authorization: `Bearer ${tokenData.access_token}` } })
    ]);
    const item = itemR.status === 'fulfilled' ? itemR.value.data : {};
    const desc = descR.status === 'fulfilled' ? descR.value.data?.plain_text || '' : '';

    // Extraer atributos relevantes
    const attrs = (item.attributes || [])
      .filter(a => a.value_name)
      .map(a => `${a.name}: ${a.value_name}`)
      .join(', ');

    const ctx = {
      title: item.title || itemId,
      price: item.price,
      thumbnail: item.thumbnail || '',
      attrs,
      description: desc.slice(0, 800)
    };
    itemDetailCache[itemId] = ctx;
    saveItemCache();
    return ctx;
  } catch(e) {
    return { title: itemId, attrs: '', description: '' };
  }
}

function buildItemContextText(ctx) {
  let text = `Producto: ${ctx.title}`;
  if (ctx.price) text += `\nPrecio: $${ctx.price}`;
  if (ctx.attrs) text += `\nAtributos: ${ctx.attrs}`;
  if (ctx.description) text += `\nDescripción: ${ctx.description}`;
  return text;
}

// POST /api/ml/preguntas/simular — genera sugerencias IA para múltiples preguntas
app.post('/api/ml/preguntas/simular', requireToken, async (req, res) => {
  if (!anthropic) return res.status(400).json({ error: 'ANTHROPIC_API_KEY no configurada' });
  const { questions } = req.body; // [{ id, item_id, item_title, text }]
  if (!questions?.length) return res.status(400).json({ error: 'questions requerido' });

  let kb = null;
  if (fs.existsSync(QA_KB_FILE)) kb = JSON.parse(fs.readFileSync(QA_KB_FILE, 'utf8'));

  const kbText = kb ? `Estilo MUNDO SHOP:
- Saludo: "${kb.estilo.saludo}"
- Despedida: "${kb.estilo.despedida}"
- Tono: ${kb.estilo.tono}
Reglas clave:
${kb.reglas_generales.slice(0, 10).map(r => '- ' + r).join('\n')}` : '';

  const reglasText = reglasTexto(filtrarReglasPorContexto(loadReglasNegocio(), 'preguntas'));

  // Load QA examples per item
  let preguntasData = null;
  if (fs.existsSync(PREGUNTAS_FILE)) {
    try { preguntasData = JSON.parse(fs.readFileSync(PREGUNTAS_FILE, 'utf8')); } catch(e) {}
  }

  const results = [];
  for (const q of questions) {
    try {
      // Fetch real item data from ML
      const itemCtx = await fetchItemContext(q.item_id);
      const itemText = buildItemContextText(itemCtx);

      let ejemplos = '';
      if (preguntasData && q.item_id && preguntasData.byPub[q.item_id]) {
        const prevQA = preguntasData.byPub[q.item_id].qa.slice(-8); // últimas 8 incluyendo aprendidas
        if (prevQA.length) {
          ejemplos = '\nEjemplos anteriores de esta publicación:\n' +
            prevQA.map(e => `P: ${e.q}\nR: ${e.a}`).join('\n---\n');
        }
      }
      // Agregar respuestas aprendidas más similares a la pregunta actual
      const similares = buscarSimilares(q.text, 6);
      if (similares.length) {
        ejemplos += '\nRespuestas validadas similares:\n' +
          similares.map(e => `P: ${e.pregunta}\nR: ${e.respuesta}`).join('\n---\n');
      }
      const r = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 250,
        messages: [{
          role: 'user',
          content: `Sos el asistente de MUNDO SHOP en Mercado Libre Uruguay.
${kbText}
${reglasText ? 'REGLAS DEL NEGOCIO (usá estos datos exactos cuando apliquen, tienen prioridad):' + reglasText : ''}
${ejemplos}
${itemText}
Pregunta: "${q.text}"

Instrucciones:
- Responde SOLO con el texto final a enviar, sin explicaciones
- Las direcciones de retiro mencionarlas SOLO si preguntan explícitamente cómo retirar un producto ya comprado, no para "verlo" o visitarlo
- MUNDO SHOP debe aparecer UNA SOLA VEZ, al final de la despedida
- Si la info no está en las reglas, no la inventes`
        }]
      });
      results.push({ id: q.id, respuesta: r.content[0].text.trim() });
    } catch(e) {
      results.push({ id: q.id, error: e.message });
    }
  }
  res.json({ results });
});

const LEARNED_FILE = path.join(__dirname, 'data', 'respuestas_aprendidas.json');
const BAD_RESP_FILE = path.join(__dirname, 'data', 'respuestas_malas.json');

// POST /api/ml/mensajes/feedback-malo — marca una respuesta sugerida como mala
app.post('/api/ml/mensajes/feedback-malo', requireToken, (req, res) => {
  const { historial, respuesta_mala, motivo } = req.body;
  if (!respuesta_mala) return res.status(400).json({ error: 'respuesta_mala requerida' });
  try {
    let malas = fs.existsSync(BAD_RESP_FILE) ? JSON.parse(fs.readFileSync(BAD_RESP_FILE, 'utf8')) : [];
    malas.push({ historial: historial || '', respuesta_mala, motivo: motivo || '', fecha: new Date().toISOString() });
    if (malas.length > 500) malas = malas.slice(-500);
    fs.writeFileSync(BAD_RESP_FILE, JSON.stringify(malas, null, 2));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ml/preguntas/feedback — guarda respuesta buena en el historial para aprendizaje
app.post('/api/ml/preguntas/feedback', requireToken, (req, res) => {
  const { pregunta, respuesta, item_id, item_title, tipo } = req.body;
  if (!pregunta || !respuesta) return res.status(400).json({ error: 'pregunta y respuesta requeridos' });
  try {
    let learned = [];
    if (fs.existsSync(LEARNED_FILE)) learned = JSON.parse(fs.readFileSync(LEARNED_FILE, 'utf8'));
    learned.push({ pregunta, respuesta, item_id, item_title, tipo: tipo || 'pregunta', fecha: new Date().toISOString() });
    // Mantener últimas 500 entradas
    if (learned.length > 500) learned = learned.slice(-500);
    fs.writeFileSync(LEARNED_FILE, JSON.stringify(learned, null, 2));

    // Si tiene item_id, guardar también en preguntas_por_publicacion para enriquecer el historial
    if (item_id && fs.existsSync(PREGUNTAS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PREGUNTAS_FILE, 'utf8'));
      if (!data.byPub[item_id]) data.byPub[item_id] = { titulo: item_title || item_id, qa: [] };
      data.byPub[item_id].qa.push({ q: pregunta, a: respuesta, aprendida: true });
      fs.writeFileSync(PREGUNTAS_FILE, JSON.stringify(data));
    }

    res.json({ ok: true, total_aprendidas: learned.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ml/preguntas/responder-ml — publica respuesta en ML y auto-aprende
app.post('/api/ml/preguntas/responder-ml', requireToken, async (req, res) => {
  const { question_id, text, pregunta, item_id, item_title } = req.body;
  if (!question_id || !text) return res.status(400).json({ error: 'question_id y text requeridos' });
  try {
    const r = await axios.post(`${ML_API_URL}/answers`,
      { question_id, text },
      { headers: { Authorization: `Bearer ${tokenData.access_token}`, 'Content-Type': 'application/json' } }
    );

    // Auto-aprendizaje: guardar en base de conocimiento cada respuesta enviada a ML
    if (pregunta) {
      try {
        let learned = [];
        if (fs.existsSync(LEARNED_FILE)) learned = JSON.parse(fs.readFileSync(LEARNED_FILE, 'utf8'));
        // Evitar duplicados exactos
        const yaExiste = learned.some(e => e.pregunta === pregunta && e.respuesta === text);
        if (!yaExiste) {
          learned.push({ pregunta, respuesta: text, item_id: item_id || null, item_title: item_title || null, tipo: 'pregunta', fecha: new Date().toISOString() });
          if (learned.length > 2000) learned = learned.slice(-2000);
          fs.writeFileSync(LEARNED_FILE, JSON.stringify(learned, null, 2));
          // Guardar también en preguntas_por_publicacion
          if (item_id && fs.existsSync(PREGUNTAS_FILE)) {
            const data = JSON.parse(fs.readFileSync(PREGUNTAS_FILE, 'utf8'));
            if (!data.byPub[item_id]) data.byPub[item_id] = { titulo: item_title || item_id, qa: [] };
            const yaEnPub = data.byPub[item_id].qa.some(e => e.q === pregunta);
            if (!yaEnPub) {
              data.byPub[item_id].qa.push({ q: pregunta, a: text, aprendida: true });
              fs.writeFileSync(PREGUNTAS_FILE, JSON.stringify(data));
            }
          }
          console.log(`[auto-learn] guardado: "${pregunta.slice(0, 50)}..."`);
        }
      } catch(e) { console.error('[auto-learn]', e.message); }
    }

    res.json({ ok: true, data: r.data });
  } catch(e) {
    const detail = e.response?.data || e.message;
    console.error('[responder-ml]', detail);
    res.status(e.response?.status || 500).json({ error: detail });
  }
});

// POST /api/ml/preguntas/importar-historial — importa preguntas ya respondidas desde ML API
let importState = { running: false, progress: 0, total: 0, importadas: 0, error: null };
app.get('/api/ml/preguntas/importar-estado', requireToken, (req, res) => res.json(importState));

app.post('/api/ml/preguntas/importar-historial', requireToken, async (req, res) => {
  if (importState.running) return res.json({ ok: false, msg: 'ya corriendo' });
  importState = { running: true, progress: 0, total: 0, importadas: 0, error: null };
  res.json({ ok: true, msg: 'importación iniciada' });

  (async () => {
    try {
      let offset = 0;
      const limit = 50;
      let total = null;
      let learned = fs.existsSync(LEARNED_FILE) ? JSON.parse(fs.readFileSync(LEARNED_FILE, 'utf8')) : [];
      let preguntasData = fs.existsSync(PREGUNTAS_FILE) ? JSON.parse(fs.readFileSync(PREGUNTAS_FILE, 'utf8')) : { byPub: {} };
      const existentes = new Set(learned.map(e => e.pregunta + '||' + e.respuesta));
      let importadas = 0;

      while (true) {
        const r = await axios.get(`${ML_API_URL}/my/received_questions/search`, {
          params: { status: 'ANSWERED', limit, offset },
          headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const qs = r.data.questions || [];
        if (total === null) { total = r.data.total || 0; importState.total = total; }
        if (!qs.length) break;

        for (const q of qs) {
          const answer = q.answer?.text;
          if (!q.text || !answer) continue;
          const key = q.text + '||' + answer;
          if (existentes.has(key)) continue;
          existentes.add(key);
          learned.push({
            pregunta: q.text,
            respuesta: answer,
            item_id: q.item_id || null,
            item_title: null,
            tipo: 'pregunta',
            fecha: q.date_created || new Date().toISOString()
          });
          // Guardar en preguntas_por_publicacion
          if (q.item_id) {
            if (!preguntasData.byPub[q.item_id]) preguntasData.byPub[q.item_id] = { titulo: q.item_id, qa: [] };
            const yaEnPub = preguntasData.byPub[q.item_id].qa.some(e => e.q === q.text);
            if (!yaEnPub) preguntasData.byPub[q.item_id].qa.push({ q: q.text, a: answer });
          }
          importadas++;
        }

        offset += qs.length;
        importState.progress = offset;
        importState.importadas = importadas;
        if (offset >= total) break;
        await sleep(300); // respetar rate limit ML
      }

      if (learned.length > 5000) learned = learned.slice(-5000);
      fs.writeFileSync(LEARNED_FILE, JSON.stringify(learned, null, 2));
      fs.writeFileSync(PREGUNTAS_FILE, JSON.stringify(preguntasData));
      importState = { running: false, progress: offset, total, importadas, error: null };
      console.log(`[importar-historial] importadas ${importadas} preguntas nuevas`);
    } catch(e) {
      importState = { running: false, progress: importState.progress, total: importState.total, importadas: importState.importadas, error: e.message };
      console.error('[importar-historial]', e.message);
    }
  })();
});

// GET /api/ml/preguntas/stats — top publicaciones por preguntas
app.get('/api/ml/preguntas/stats', requireToken, (req, res) => {
  try {
    if (!fs.existsSync(PREGUNTAS_FILE)) return res.json({ pubs: [], total: 0 });
    const data = JSON.parse(fs.readFileSync(PREGUNTAS_FILE, 'utf8'));
    const pubs = Object.entries(data.byPub).map(([id, p]) => ({
      id,
      titulo: p.titulo,
      total: p.qa.length,
      categorias: p.categorias || {}
    })).sort((a, b) => b.total - a.total);
    res.json({ pubs, total: pubs.reduce((s, p) => s + p.total, 0) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ml/preguntas/:itemId — preguntas de una publicación
app.get('/api/ml/preguntas/:itemId', requireToken, (req, res) => {
  try {
    if (!fs.existsSync(PREGUNTAS_FILE)) return res.json({ qa: [] });
    const data = JSON.parse(fs.readFileSync(PREGUNTAS_FILE, 'utf8'));
    const pub  = data.byPub[req.params.itemId];
    if (!pub) return res.json({ qa: [], titulo: '' });
    res.json({ qa: pub.qa, titulo: pub.titulo });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ml/preguntas/responder — responder pregunta con IA usando knowledge base
app.post('/api/ml/preguntas/responder', requireToken, async (req, res) => {
  if (!anthropic) return res.status(400).json({ error: 'ANTHROPIC_API_KEY no configurada' });
  const { pregunta, itemId, titulo } = req.body;
  if (!pregunta) return res.status(400).json({ error: 'pregunta requerida' });

  try {
    let kb = null;
    if (fs.existsSync(QA_KB_FILE)) kb = JSON.parse(fs.readFileSync(QA_KB_FILE, 'utf8'));

    // Ejemplos por publicación
    let ejemplosPub = [];
    if (itemId && fs.existsSync(PREGUNTAS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PREGUNTAS_FILE, 'utf8'));
      const pub  = data.byPub[itemId];
      if (pub) ejemplosPub = pub.qa.slice(-10);
    }

    // Ejemplos similares de toda la base aprendida
    const similares = buscarSimilares(pregunta, 6);

    const kbText = kb ? `
Estilo de respuesta:
- Saludo: "${kb.estilo.saludo}"
- Despedida: "${kb.estilo.despedida}"
- Tono: ${kb.estilo.tono}

Reglas:
${kb.reglas_generales.slice(0, 8).map(r => '- ' + r).join('\n')}
` : '';

    const ejemplosPubText = ejemplosPub.length ? `
Ejemplos anteriores para esta publicación:
${ejemplosPub.slice(0, 5).map(e => `P: ${e.q}\nR: ${e.a}`).join('\n---\n')}
` : '';

    const similoresText = similares.length ? `
Respuestas validadas similares (de otras publicaciones):
${similares.map(e => `P: ${e.pregunta}\nR: ${e.respuesta}`).join('\n---\n')}
` : '';

    const ejemplosText = ejemplosPubText + similoresText;

    // Fetch real item context from ML
    const itemCtx = itemId ? await fetchItemContext(itemId) : null;
    const itemText = itemCtx ? buildItemContextText(itemCtx) : `Producto: ${titulo || 'no especificado'}`;

    const r = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Sos el asistente de MUNDO SHOP en Mercado Libre Uruguay. Responde la siguiente pregunta de un comprador.
${kbText}${ejemplosText}${(() => { const r = loadReglasNegocio(); return r.length ? '\nInformación del negocio:\n' + r.map(x => `- ${x.categoria ? '['+x.categoria+'] ' : ''}${x.texto}`).join('\n') : ''; })()}
${itemText}

Pregunta del comprador: "${pregunta}"

Responde SOLO con el texto de la respuesta, sin explicaciones adicionales. Si no sabes un dato específico, no lo inventes — decí que lo consulten por el chat de la compra.`
      }]
    });

    res.json({ respuesta: r.content[0].text.trim() });
  } catch(e) {
    console.error('[preguntas/responder]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── ML: sin descuento y ofertas ──────────────────────────────────

// GET /api/ml/rentabilidad — simulación de rentabilidad por producto
app.get('/api/ml/rentabilidad', requireToken, async (req, res) => {
  // 1. Asegurar fees cargadas
  if (Object.keys(feesCache).length === 0) await refreshFees(false);

  // 2. Costos desde Odoo
  const costoBySku = {};
  try {
    if (fs.existsSync(ODOO_CACHE_FILE)) {
      const odooRaw = JSON.parse(fs.readFileSync(ODOO_CACHE_FILE, 'utf8'));
      const xmlrpc  = require('xmlrpc');
      const uid     = await new Promise((resolve, reject) => {
        const c = xmlrpc.createSecureClient({ host: ODOO_HOST, path: '/xmlrpc/2/common' });
        c.methodCall('authenticate', [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}], (e,v) => e ? reject(e) : resolve(v));
      });
      // Traer standard_price de todos los productos con SKU
      const skus   = [...new Set(cachedStock.map(i => i.sku).filter(Boolean))];
      const batch  = 200;
      for (let i = 0; i < skus.length; i += batch) {
        const slice = skus.slice(i, i + batch);
        const prods = await odooSearchRead(uid, 'product.product', [['default_code','in',slice]], ['default_code','standard_price']);
        for (const p of prods) costoBySku[p.default_code] = p.standard_price || 0;
        await sleep(100);
      }
    }
  } catch(e) { console.error('[rentabilidad] error cargando costos Odoo:', e.message); }

  // 3. Cargar config de envíos
  const shippingCfg = loadShippingCfg();

  // 4. Calcular rentabilidad para cada item de ofertas
  const ofertasItems = cachedStock
    .filter(i => !i.original_price)
    .map(i => {
      const fee        = feesCache[i.category_id] || { fee_pct: 13 };
      const costo      = costoBySku[i.sku] || 0;
      const feePct     = fee.fee_pct || 13;
      const logistic   = i.logistic_type || 'drop_off';
      // Usar costo histórico real si existe, si no, usar config global
      const histCost   = shipCostsCache[i.id];
      const envio      = histCost ? histCost.avg_cost : calcShippingCost(shippingCfg, logistic, i.price);

      const IVA = 1.22; // IVA Uruguay 22%

      // Margen real al precio actual (para referencia)
      const precioSinIvaActual = i.price / IVA;
      const comisionActual     = i.price * feePct / 100;
      const netoActual         = precioSinIvaActual - comisionActual - envio;
      const margenActual       = costo > 0 ? parseFloat(((netoActual - costo) / precioSinIvaActual * 100).toFixed(1)) : null;

      // Calcular precio necesario para alcanzar un margen objetivo
      // Para ME2: el envío depende de si el precio >= threshold (circular) → resuelvo con 2 casos
      function calcPrecioParaMargen(targetPct) {
        if (!costo) return null;
        const t       = targetPct / 100;
        const divisor = (1 - t) / IVA - feePct / 100;
        if (divisor <= 0) return null;

        const me2Threshold = shippingCfg.me2?.seller_threshold || 1200;

        function resolver(envioAsumido) {
          return Math.round((envioAsumido + costo) / divisor);
        }

        let precio, envioUsado;

        if (logistic === 'drop_off') {
          // Caso 1: asumir que vendedor paga envío
          const p1 = resolver(calcShippingCost(shippingCfg, 'drop_off', me2Threshold)); // precio como si pagara
          if (p1 >= me2Threshold) {
            // Consistente: precio >= threshold y vendedor paga
            precio = p1;
            envioUsado = calcShippingCost(shippingCfg, 'drop_off', p1);
          } else {
            // Caso 2: precio < threshold → comprador paga envío (envio=0)
            precio = resolver(0);
            envioUsado = 0;
          }
        } else {
          envioUsado = envio; // Flex y ME1: no cambia con el precio
          precio = resolver(envioUsado);
        }

        const descuento = parseFloat(((1 - precio / i.price) * 100).toFixed(1));
        return { precio, descuento, envioUsado };
      }

      const sim = {
        actual: margenActual,
        m30: calcPrecioParaMargen(30),
        m20: calcPrecioParaMargen(20),
        m15: calcPrecioParaMargen(15),
        m10: calcPrecioParaMargen(10),
        m0:  calcPrecioParaMargen(0),  // break-even
      };

      // Score oferta (igual que antes)
      let score = 0, tipo = '';
      if (i.sold30d === 0 && i.days_left === null)                              { score = 100; tipo = 'sin_ventas'; }
      else if (i.days_left > 90 && i.sold30d === 0)                            { score = 95;  tipo = 'overstock_sin_ventas'; }
      else if (i.days_left > 90 && i.sold30d <= 2)                             { score = 80;  tipo = 'overstock_lento'; }
      else if (i.sold30d <= 1 && i.stock > 5)                                  { score = 60;  tipo = 'muy_lento'; }
      else if (i.sold30d <= 3 && i.days_left !== null && i.days_left > 60)     { score = 40;  tipo = 'lento'; }

      return {
        id: i.id, title: i.title, thumbnail: i.thumbnail, permalink: i.permalink,
        sku: i.sku, price: i.price, stock: i.stock, status: i.status, sold30d: i.sold30d,
        days_left: i.days_left, category_name: i.category_name,
        costo, fee_pct: feePct, envio, logistic_type: logistic, score, tipo, sim,
        tiene_costo: costo > 0,
      };
    })
    .filter(i => i.score > 0)
    .sort((a, b) => b.score - a.score);

  res.json({ items: ofertasItems, total: ofertasItems.length, lastUpdated: stockLastUpdate });
});

// GET /api/ml/sin-descuento — productos con stock y sin descuento en ML
app.get('/api/ml/sin-descuento', requireToken, (req, res) => {
  const items = cachedStock
    .filter(i => i.sku && i.stock > 0 && !i.original_price)
    .map(i => ({
      id: i.id, title: i.title, thumbnail: i.thumbnail, permalink: i.permalink,
      sku: i.sku, price: i.price, stock: i.stock, sold30d: i.sold30d,
      daily_rate: i.daily_rate, days_left: i.days_left, category_name: i.category_name,
    }));
  res.json({ items, total: items.length, lastUpdated: stockLastUpdate });
});

// GET /api/ml/ofertas — candidatos para oferta del día / relámpago
// Criterios: stock > 0, pocas ventas (sold30d <= 2 o sin ventas), overstock
app.get('/api/ml/ofertas', requireToken, (req, res) => {
  const items = cachedStock
    .filter(i => i.stock > 0 && !i.original_price)
    .map(i => {
      // Score: más urgente = más candidato a oferta
      let score = 0;
      let tipo  = '';
      if (i.sold30d === 0 && i.days_left === null) { score = 100; tipo = 'sin_ventas'; }
      else if (i.days_left !== null && i.days_left > 90 && i.sold30d === 0) { score = 95; tipo = 'overstock_sin_ventas'; }
      else if (i.days_left !== null && i.days_left > 90 && i.sold30d <= 2) { score = 80; tipo = 'overstock_lento'; }
      else if (i.sold30d <= 1 && i.stock > 5)  { score = 60; tipo = 'muy_lento'; }
      else if (i.sold30d <= 3 && i.days_left !== null && i.days_left > 60) { score = 40; tipo = 'lento'; }
      return { ...i, score, tipo };
    })
    .filter(i => i.score > 0)
    .sort((a, b) => b.score - a.score || (b.days_left ?? 9999) - (a.days_left ?? 9999));

  res.json({ items, total: items.length, lastUpdated: stockLastUpdate });
});

// ── Previsiones / Reglas de reabastecimiento ─────────────────────
const REGLAS_FILE = path.join(__dirname, 'data', 'reglas_reabastecimiento.json');

function loadReglas() {
  try {
    if (fs.existsSync(REGLAS_FILE)) return JSON.parse(fs.readFileSync(REGLAS_FILE, 'utf8'));
  } catch(e) {}
  return [];
}
function saveReglas(data) {
  fs.writeFileSync(REGLAS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// GET /api/previsiones/reglas
app.get('/api/previsiones/reglas', requireToken, (req, res) => {
  res.json(loadReglas());
});

// POST /api/previsiones/reglas — crea o actualiza por SKU
app.post('/api/previsiones/reglas', requireToken, (req, res) => {
  const { sku, lead_time_days, safety_days, notes } = req.body;
  if (!sku) return res.status(400).json({ error: 'Falta SKU' });
  const reglas = loadReglas();
  const idx = reglas.findIndex(r => r.sku === sku);
  const regla = { sku, lead_time_days: parseInt(lead_time_days) || 30, safety_days: parseInt(safety_days) || 7, notes: notes || '' };
  if (idx >= 0) reglas[idx] = regla; else reglas.push(regla);
  saveReglas(reglas);
  res.json(regla);
});

// DELETE /api/previsiones/reglas/:sku
app.delete('/api/previsiones/reglas/:sku', requireToken, (req, res) => {
  saveReglas(loadReglas().filter(r => r.sku !== req.params.sku));
  res.json({ ok: true });
});

// GET /api/previsiones — forecast con stock actual + entrante + reglas
app.get('/api/previsiones', requireToken, (req, res) => {
  const reglas = loadReglas();
  const reglaMap = {};
  for (const r of reglas) reglaMap[r.sku] = r;

  const compras = loadCompras();
  // incoming por SKU: { sku -> [{qty, expected_date, supplier, order_id}] }
  const incoming = {};
  for (const c of compras) {
    for (const it of (c.items || [])) {
      if (!it.sku) continue;
      if (!incoming[it.sku]) incoming[it.sku] = [];
      incoming[it.sku].push({ qty: parseInt(it.qty) || 0, expected_date: c.expected_date, supplier: c.supplier, order_id: c.id });
    }
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const items = cachedStock
    .filter(item => item.sku) // solo items con SKU
    .map(item => {
      const itemIncoming = (incoming[item.sku] || []).map(e => {
        const arrivalDate = e.expected_date ? new Date(e.expected_date) : null;
        const daysUntilArrival = arrivalDate ? Math.ceil((arrivalDate - today) / 86400000) : null;
        return { ...e, days_until_arrival: daysUntilArrival };
      }).sort((a, b) => (a.days_until_arrival ?? 9999) - (b.days_until_arrival ?? 9999));

      const totalIncoming = itemIncoming.reduce((s, e) => s + e.qty, 0);

      // Días de stock sin entrantes
      const daysLeft = item.days_left;
      // Días de stock con entrantes (simplificado: suma total incoming / daily_rate)
      const daysLeftWithIncoming = item.daily_rate > 0
        ? Math.round((item.stock + totalIncoming) / item.daily_rate)
        : (item.stock + totalIncoming > 0 ? null : 0);

      const regla = reglaMap[item.sku] || { lead_time_days: 30, safety_days: 7 };
      const reorder_point_days = regla.lead_time_days + regla.safety_days;

      // Cuándo debería emitirse la orden de compra (días desde hoy)
      // El stock (con entrantes) debería bajar hasta reorder_point_days
      let days_until_order = null;
      let status = 'ok';
      let should_order = false;

      if (item.daily_rate > 0) {
        // Tiempo hasta que el stock (con entrantes) llegue al punto de reorden
        const stockWithIncoming = item.stock + totalIncoming;
        const targetStock = reorder_point_days * item.daily_rate;
        days_until_order = Math.round((stockWithIncoming - targetStock) / item.daily_rate);

        if (item.stock === 0 && totalIncoming > 0) {
          // Sin stock pero ya tiene pedido en camino
          status = 'sin_stock_en_camino';
        } else if (days_until_order <= 0 && totalIncoming > 0) {
          // Necesita más pero ya tiene algo en camino
          status = 'en_camino';
        } else if (days_until_order <= 0) {
          status = 'pedir_ya';
          should_order = true;
        } else if (days_until_order <= 7) {
          status = 'pedir_pronto';
        } else if (days_until_order <= 30) {
          status = 'atención';
        } else {
          status = 'ok';
        }
      } else if (item.stock === 0 && totalIncoming === 0) {
        status = 'sin_stock';
        should_order = true;
      } else if (item.stock === 0 && totalIncoming > 0) {
        status = 'sin_stock_en_camino';
      } else {
        status = 'sin_ventas';
      }

      return {
        id:                   item.id,
        title:                item.title,
        thumbnail:            item.thumbnail,
        permalink:            item.permalink,
        sku:                  item.sku,
        variations:           item.variations || [],
        stock:                item.stock,
        sold30d:              item.sold30d,
        daily_rate:           item.daily_rate,
        days_left:            daysLeft,
        incoming:             itemIncoming,
        total_incoming:       totalIncoming,
        days_left_with_inc:   daysLeftWithIncoming,
        lead_time_days:       regla.lead_time_days,
        safety_days:          regla.safety_days,
        reorder_point_days,
        days_until_order,
        status,
        should_order,
      };
    });

  // Ordenar: pedir_ya → pedir_pronto → atención → sin_stock → ok → sin_ventas
  const ORDER = { pedir_ya: 0, sin_stock: 1, pedir_pronto: 2, sin_stock_en_camino: 3, sin_stock_con_entrante: 3, en_camino: 4, atención: 5, ok: 6, sin_ventas: 7 };
  items.sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || (a.days_until_order ?? 9999) - (b.days_until_order ?? 9999));

  res.json({ items, total: items.length, lastUpdated: stockLastUpdate });
});

app.get('/api/debug/shipment/:id', requireToken, async (req, res) => {
  try {
    const r = await axios.get(`${ML_API_URL}/shipments/${req.params.id}`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    res.json(r.data);
  } catch(e) { res.status(500).json({ error: e.response?.data || e.message }); }
});

// ── Oportunidades personalizadas ──

app.get('/api/oportunidades/para-mi', requireToken, async (req, res) => {
  if (!anthropic) return res.status(500).json({ error: 'Anthropic API no configurada' });

  try {
    // 1. Analizar catálogo actual: categorías top y productos más vendidos
    const stockData = cachedStock || [];
    const catSales = {};
    const topProducts = [];

    stockData.forEach(i => {
      const cat = i.category_name || 'Sin categoría';
      if (!catSales[cat]) catSales[cat] = { ventas: 0, items: 0, revenue: 0, titles: [] };
      catSales[cat].ventas += i.sold30d || 0;
      catSales[cat].items++;
      catSales[cat].revenue += (i.sold30d || 0) * (i.price || 0);
      if (catSales[cat].titles.length < 3 && (i.sold30d || 0) > 10) {
        catSales[cat].titles.push(i.title);
      }
    });

    const topCats = Object.entries(catSales)
      .sort((a, b) => b[1].ventas - a[1].ventas)
      .slice(0, 10)
      .map(([name, d]) => ({ name, ...d }));

    const bestSellers = [...stockData]
      .filter(i => (i.sold30d || 0) > 20)
      .sort((a, b) => (b.sold30d || 0) - (a.sold30d || 0))
      .slice(0, 20)
      .map(i => ({ title: i.title, sold30d: i.sold30d, price: i.price, category: i.category_name }));

    // 2. Consultar Google Trends para las categorías top (en inglés para Amazon)
    const catKeywords = {
      'Estanterías': 'floating shelves',
      'Alfombras y Carpetas': 'shaggy rug',
      'Otras Lámparas': 'himalayan salt lamp',
      'Mesas de Luz': 'nightstand',
      'Lámparas de Pie': 'floor lamp',
      'Frascos y Tarros': 'airtight food containers',
      'Alambrados': 'welded wire mesh',
      'Para Techo': 'pendant light',
      'Roperos': 'wardrobe closet',
      'Canastos de mimbre': 'woven storage basket',
    };

    const trendsData = {};
    for (const cat of topCats.slice(0, 5)) {
      const kw = catKeywords[cat.name] || cat.name;
      try {
        const raw = await googleTrends.interestOverTime({
          keyword: kw,
          startTime: new Date(Date.now() - 12 * 30 * 24 * 60 * 60 * 1000),
          geo: 'US'
        });
        const data = JSON.parse(raw);
        const points = data.default?.timelineData || [];
        const values = points.map(t => t.value[0]);
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        const current = values[values.length - 1] || 0;
        const trend = current > avg * 1.2 ? 'subiendo' : current < avg * 0.7 ? 'bajando' : 'estable';
        trendsData[cat.name] = { keyword: kw, current, avg: Math.round(avg), trend, values };
      } catch {}
    }

    // 3. Pedir a Claude oportunidades basadas en el catálogo real
    const catalogoResumen = topCats.slice(0, 8).map(c =>
      `- ${c.name}: ${c.ventas} ventas/mes, ${c.items} productos, $${Math.round(c.revenue/1000)}k revenue. Ejemplos: ${c.titles.slice(0,2).join(', ')}`
    ).join('\n');

    const bestSellersResumen = bestSellers.slice(0, 10).map(b =>
      `- ${b.title} (${b.sold30d} ventas/mes, $${b.price})`
    ).join('\n');

    const trendsResumen = Object.entries(trendsData).map(([cat, t]) =>
      `- ${cat} ("${t.keyword}"): tendencia ${t.trend}, actual ${t.current}/100, promedio ${t.avg}/100`
    ).join('\n');

    const prompt = `Sos un experto en e-commerce para Uruguay/Latinoamérica. Analizá este catálogo real de MUNDO SHOP en MercadoLibre Uruguay y sugerí oportunidades de productos para importar de China.

CATÁLOGO ACTUAL (categorías con más ventas en los últimos 30 días):
${catalogoResumen}

PRODUCTOS MÁS VENDIDOS:
${bestSellersResumen}

TENDENCIAS GOOGLE (interés actual en USA):
${trendsResumen}

PERFIL DEL NEGOCIO:
- Vende decoración, hogar, iluminación, organización
- Productos chicos y medianos, importados de China
- Mercado: Uruguay (chico, 3.5M habitantes)
- Precio promedio: $500-3000 UYU ($12-70 USD)

Necesito que me sugieras 12 productos CONCRETOS divididos en 3 categorías:

1. **AMPLIAR LO QUE YA FUNCIONA** (4 productos): variaciones o complementos de tus best sellers que no tenés todavía
2. **TENDENCIAS EN ALZA** (4 productos): productos que están subiendo en tendencia y encajan con tu perfil de negocio
3. **NICHOS SIN EXPLOTAR** (4 productos): productos que se venden bien en Amazon/otros mercados y tienen poca competencia en ML Uruguay

Para cada producto:
- Nombre EXACTO en inglés (para buscar en Amazon/AliExpress)
- Nombre en español (como se vendería en ML Uruguay)
- Precio estimado en Amazon USD
- Por qué es buena oportunidad para ESTE negocio específicamente
- Keywords de ML Uruguay (array de 3 búsquedas como las haría un uruguayo)

Respondé SOLO con JSON:
{
  "ampliar": [
    {
      "nombre": "nombre en español",
      "nombre_en": "exact English product name",
      "precio_amazon_usd": 15.99,
      "por_que": "razón específica para MUNDO SHOP",
      "relacion": "qué producto actual complementa",
      "keywords_ml": ["búsqueda 1", "búsqueda 2", "búsqueda 3"]
    }
  ],
  "tendencias": [...],
  "nichos": [...]
}`;

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = msg.content.find(b => b.type === 'text')?.text || '{}';
    let sugerencias = {};
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      sugerencias = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    } catch { return res.status(500).json({ error: 'Error parseando respuesta de IA' }); }

    // 4. Calcular rentabilidad para cada sugerencia
    const tipoCambio = 42;
    const procesarProducto = (p) => {
      const precioChinaUsd = p.precio_amazon_usd * 0.3;
      const costoUsd = precioChinaUsd * 1.5;
      const costoUyu = costoUsd * tipoCambio;
      const precioVentaMinimo = Math.round(costoUyu * 1.2745 / 0.8);
      return {
        ...p,
        precio_china_est: Math.round(precioChinaUsd * 100) / 100,
        costo_usd: Math.round(costoUsd * 100) / 100,
        costo_uyu: Math.round(costoUyu),
        precio_venta_minimo: precioVentaMinimo,
        amazon_search: `https://www.amazon.com/s?k=${encodeURIComponent(p.nombre_en)}`,
      };
    };

    const resultado = {
      ampliar: (sugerencias.ampliar || []).map(procesarProducto),
      tendencias: (sugerencias.tendencias || []).map(procesarProducto),
      nichos: (sugerencias.nichos || []).map(procesarProducto),
      contexto: {
        top_categorias: topCats.slice(0, 5).map(c => ({ nombre: c.name, ventas: c.ventas })),
        best_sellers: bestSellers.slice(0, 5).map(b => ({ titulo: b.title, ventas: b.sold30d })),
        trends: trendsData,
      },
    };

    res.json(resultado);
  } catch(e) {
    console.error('[para-mi]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Oportunidades de productos ──

app.post('/api/oportunidades/buscar', requireToken, async (req, res) => {
  if (!anthropic) return res.status(500).json({ error: 'Anthropic API no configurada' });
  const { categoria, keywords } = req.body;
  const query = keywords || categoria || 'hogar productos chicos útiles';

  try {
    // 1. Pedir a Claude productos trending de Amazon
    const prompt = `Sos un experto en e-commerce y productos trending de Amazon USA.

Necesito que me des exactamente 8 productos de la categoría "${query}" que cumplan TODOS estos criterios:
- Son productos CHICOS y livianos (fácil de importar)
- Son exitosos en Amazon USA (best sellers o trending)
- Categoría: Hogar / Home & Kitchen
- Precio en Amazon entre USD 5 y USD 40
- Productos que tengan buena demanda y no sean demasiado genéricos
- DEBEN ser productos REALES que existan en Amazon con su ASIN real

Para cada producto respondé SOLO con un JSON array, sin texto extra:
[
  {
    "nombre": "nombre del producto en español",
    "nombre_en": "product name in English (exacto como aparece en Amazon)",
    "descripcion": "descripción corta de 1 línea",
    "asin": "B08XXXXX (el ASIN real del producto en Amazon)",
    "precio_amazon_usd": 15.99,
    "categoria_amazon": "Home & Kitchen > subcategoría",
    "keywords_ml": ["búsqueda 1 corta y genérica", "búsqueda 2 alternativa", "búsqueda 3 con sinónimos"],
    "keywords_amazon": "search terms to find this exact product on Amazon",
    "rating_amazon": 4.5,
    "reviews_amazon": 15000,
    "por_que": "razón corta de por qué es buena oportunidad"
  }
]

IMPORTANTE:
- Solo devolvé el JSON, nada más
- Precios y ASINs realistas de Amazon
- keywords_ml DEBE ser un array de 3 formas DISTINTAS de buscar el producto en MercadoLibre URUGUAY. Usá palabras SIMPLES y CORTAS como buscaría un uruguayo (ej: "organizador cajones", "luz led sensor", "cepillo limpieza"). NO uses traducciones literales del inglés. Pensá en cómo se llama el producto en una ferretería o bazar de Uruguay.`;

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = msg.content.find(b => b.type === 'text')?.text || '[]';
    let productos = [];
    try {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      productos = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch { return res.status(500).json({ error: 'Error parseando respuesta de IA' }); }

    // 2. Para cada producto, buscar competencia en ML Uruguay
    const headers = { Authorization: `Bearer ${tokenData.access_token}` };
    const resultados = [];

    for (const prod of productos) {
      // keywords_ml puede ser array o string
      const searchTerms = Array.isArray(prod.keywords_ml) ? prod.keywords_ml : [prod.keywords_ml || prod.nombre];
      let competencia = { total: 0, precio_min: null, precio_max: null, precio_promedio: null, vendedores: [], imagen: null };
      let bestKeyword = searchTerms[0];

      // Probar cada keyword y quedarse con la que da más resultados
      for (const kw of searchTerms) {
        try {
          const sr = await axios.get(`${ML_API_URL}/sites/MLU/search`, {
            params: { q: kw, limit: 10 },
            headers,
          });
          const results = sr.data.results || [];
          const total = sr.data.paging?.total || results.length;
          if (total > competencia.total && results.length > 0) {
            competencia.total = total;
            bestKeyword = kw;
            const precios = results.map(r => r.price).filter(p => p > 0);
            competencia.precio_min = Math.min(...precios);
            competencia.precio_max = Math.max(...precios);
            competencia.precio_promedio = Math.round(precios.reduce((a, b) => a + b, 0) / precios.length);
            competencia.imagen = results[0].thumbnail || null;
            competencia.vendedores = results.slice(0, 5).map(r => ({
              titulo: r.title,
              precio: r.price,
              vendidos: r.sold_quantity || 0,
              permalink: r.permalink,
              thumbnail: r.thumbnail || null,
              seller: r.seller?.nickname,
              envio_gratis: r.shipping?.free_shipping || false,
            }));
          }
        } catch(e) {
          console.log(`[oportunidades] ML search failed for "${kw}": ${e.response?.status || e.message}`);
        }
      }
      prod.keyword_usada = bestKeyword;

      // 3. Calcular rentabilidad
      // Precio China ≈ 30% del precio Amazon, × 1.5 markup importación
      const precioChinaUsd = prod.precio_amazon_usd * 0.3;
      const costoUsd = precioChinaUsd * 1.5;
      // Tipo de cambio aproximado (UYU por USD)
      const tipoCambio = 42;
      const costoUyu = costoUsd * tipoCambio;

      // Precio venta necesario para margen 22.5% con ML 20% e IVA 22%
      // precio_venta = costo / (1 - comision_ml - margen) → pero IVA es sobre la ganancia
      // Simplificado: precio_venta = costo / (1 - 0.20) * 1.225
      // O sea: lo que te queda después de ML es 80%, de eso necesitás cubrir costo + 22.5% margen + IVA
      const comisionMl = 0.20;
      const margenObj = 0.225;
      const iva = 0.22;
      // precio_neto (después de ML) = precio_venta * 0.80
      // ganancia_bruta = precio_neto - costo
      // ganancia_neta = ganancia_bruta / 1.22 (sacas IVA)
      // margen = ganancia_neta / costo >= 0.225
      // Entonces: (pv * 0.8 - costo) / 1.22 / costo = 0.225
      // pv * 0.8 = costo + costo * 0.225 * 1.22
      // pv * 0.8 = costo * (1 + 0.2745)
      // pv = costo * 1.2745 / 0.8
      const precioVentaMinimo = Math.round(costoUyu * 1.2745 / 0.8);

      // Margen real si vendés al precio promedio del mercado
      let margenReal = null;
      let precioSugerido = precioVentaMinimo;
      if (competencia.precio_promedio) {
        const netoMl = competencia.precio_promedio * (1 - comisionMl);
        const ganBruta = netoMl - costoUyu;
        const ganNeta = ganBruta / (1 + iva);
        margenReal = costoUyu > 0 ? Math.round((ganNeta / costoUyu) * 100) : 0;
        // Sugerido: el menor entre el mínimo y el promedio de mercado
        precioSugerido = Math.max(precioVentaMinimo, Math.round(competencia.precio_promedio * 0.95));
      }

      // Score de oportunidad (0-100)
      let score = 50;
      if (margenReal !== null) {
        if (margenReal >= 30) score += 20;
        else if (margenReal >= 20) score += 10;
        else if (margenReal < 10) score -= 20;
      }
      if (competencia.total < 5) score += 15; // poca competencia
      else if (competencia.total < 20) score += 5;
      else if (competencia.total > 100) score -= 10;
      if (prod.reviews_amazon > 10000) score += 10;
      if (prod.rating_amazon >= 4.5) score += 5;
      score = Math.max(0, Math.min(100, score));

      // Links
      const amazonUrl = prod.asin
        ? `https://www.amazon.com/dp/${prod.asin}`
        : `https://www.amazon.com/s?k=${encodeURIComponent(prod.keywords_amazon || prod.nombre_en)}`;
      const imagen = competencia.imagen || null;

      resultados.push({
        ...prod,
        amazon_url: amazonUrl,
        imagen,
        precio_china_usd: Math.round(precioChinaUsd * 100) / 100,
        costo_usd: Math.round(costoUsd * 100) / 100,
        costo_uyu: Math.round(costoUyu),
        precio_venta_minimo: precioVentaMinimo,
        precio_sugerido: precioSugerido,
        margen_real: margenReal,
        competencia,
        score,
      });
    }

    // Ordenar por score descendente
    resultados.sort((a, b) => b.score - a.score);
    res.json({ resultados, total: resultados.length });
  } catch(e) {
    console.error('[oportunidades]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Generar líneas de productos
app.post('/api/oportunidades/lineas', requireToken, async (req, res) => {
  if (!anthropic) return res.status(500).json({ error: 'Anthropic API no configurada' });

  const lineas = [
    { id: 'cocina', nombre: 'Organización cocina/hogar', emoji: '🏠', color: '#059669', keywords: 'kitchen organization home storage' },
    { id: 'limpieza', nombre: 'Gadgets de limpieza', emoji: '🧹', color: '#2563eb', keywords: 'cleaning gadgets tools innovative' },
    { id: 'led', nombre: 'Iluminación LED', emoji: '💡', color: '#d97706', keywords: 'LED lights sensor motion portable' },
    { id: 'bano', nombre: 'Accesorios de baño', emoji: '🚿', color: '#7c3aed', keywords: 'bathroom accessories organizer modern' },
  ];

  const lineaId = req.body.linea; // opcional: generar solo una línea
  const targetLineas = lineaId ? lineas.filter(l => l.id === lineaId) : lineas;

  try {
    const resultados = [];

    for (const linea of targetLineas) {
      const prompt = `Sos un experto en e-commerce especializado en productos exitosos de Amazon USA para revender en mercados emergentes.

Necesito 6 productos REALES y EXITOSOS de Amazon USA para la línea "${linea.nombre}".

REQUISITOS ESTRICTOS:
- Productos CHICOS y livianos (menos de 500g, fácil de importar)
- BEST SELLERS reales de Amazon con miles de reviews
- Precio Amazon entre USD 8 y USD 35
- Productos con demanda comprobada (alto volumen de ventas)
- NO productos genéricos (tiene que tener algo diferencial/innovador)
- Productos que se puedan encontrar en fabricantes chinos (AliExpress/1688)

Para cada producto, dame el nombre EXACTO como aparece en Amazon en inglés para que el usuario pueda buscarlo directamente.

Respondé SOLO con un JSON array:
[
  {
    "nombre": "nombre en español",
    "nombre_en": "EXACT Amazon product title or close match",
    "descripcion": "qué es y por qué funciona (1 línea)",
    "precio_amazon_usd": 14.99,
    "rating": 4.7,
    "reviews": 45000,
    "peso_estimado_g": 200,
    "por_que_exitoso": "razón concreta de por qué vende tanto",
    "keywords_ml": ["búsqueda 1 corta", "búsqueda 2 alternativa", "búsqueda 3 sinónimos"],
    "tip_importacion": "consejo práctico para importar este producto"
  }
]

IMPORTANTE:
- Solo JSON. Productos REALES. Nombres EXACTOS de Amazon.
- keywords_ml DEBE ser un array de 3 formas DISTINTAS de buscar el producto en MercadoLibre URUGUAY. Usá palabras SIMPLES y CORTAS como buscaría un uruguayo en un bazar o ferretería (ej: "organizador cajones", "luz led sensor movimiento", "cepillo limpieza"). NO uses traducciones literales del inglés ni nombres técnicos.`;

      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = msg.content.find(b => b.type === 'text')?.text || '[]';
      let productos = [];
      try {
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        productos = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
      } catch { productos = []; }

      // Calcular rentabilidad para cada producto
      const tipoCambio = 42;
      productos = productos.map(p => {
        const precioChinaUsd = p.precio_amazon_usd * 0.3;
        const costoUsd = precioChinaUsd * 1.5;
        const costoUyu = costoUsd * tipoCambio;
        const precioVentaMinimo = Math.round(costoUyu * 1.2745 / 0.8);
        return {
          ...p,
          precio_china_est: Math.round(precioChinaUsd * 100) / 100,
          costo_usd: Math.round(costoUsd * 100) / 100,
          costo_uyu: Math.round(costoUyu),
          precio_venta_minimo: precioVentaMinimo,
          amazon_search: `https://www.amazon.com/s?k=${encodeURIComponent(p.nombre_en)}`,
        };
      });

      resultados.push({ ...linea, productos });
    }

    res.json({ lineas: resultados });
  } catch(e) {
    console.error('[lineas]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Calculadora rápida de rentabilidad
app.post('/api/oportunidades/calcular', requireToken, (req, res) => {
  const { precio_ref_usd, tipo_cambio = 42, comision_ml = 0.20, iva = 0.22, margen_obj = 0.225, precio_venta_manual } = req.body;
  if (!precio_ref_usd) return res.status(400).json({ error: 'precio_ref_usd requerido' });

  const costoUsd = precio_ref_usd * 1.5;
  const costoUyu = costoUsd * tipo_cambio;
  const precioVentaMinimo = Math.round(costoUyu * (1 + margen_obj * (1 + iva)) / (1 - comision_ml));

  let resultado = { costo_usd: costoUsd, costo_uyu: Math.round(costoUyu), precio_venta_minimo: precioVentaMinimo };

  if (precio_venta_manual) {
    const netoMl = precio_venta_manual * (1 - comision_ml);
    const ganBruta = netoMl - costoUyu;
    const ganNeta = ganBruta / (1 + iva);
    resultado.precio_venta = precio_venta_manual;
    resultado.ganancia_bruta = Math.round(ganBruta);
    resultado.ganancia_neta = Math.round(ganNeta);
    resultado.margen = costoUyu > 0 ? Math.round((ganNeta / costoUyu) * 100 * 10) / 10 : 0;
    resultado.comision_ml = Math.round(precio_venta_manual * comision_ml);
    resultado.iva_pagar = Math.round(ganBruta - ganNeta);
  }

  res.json(resultado);
});

// ══════════════════════════════════════════════════════════════════
// ── IMPORTACIONES (Google Drive) ─────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const { google } = require('googleapis');
const pdfParse = require('pdf-parse');

const DRIVE_CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const DRIVE_TOKEN_PATH = path.join(__dirname, 'data', 'drive_token.json');
const DRIVE_INDEX_PATH = path.join(__dirname, 'data', 'drive_index.json');
const DRIVE_ROOT_FOLDER_ID = '1K1UmNLt2yQ0WJ921_l26YyeGRg-j6hB_';

function getDriveAuth() {
  const credentials = JSON.parse(fs.readFileSync(DRIVE_CREDENTIALS_PATH, 'utf8'));
  const { client_id, client_secret } = credentials.installed;
  const oauth2Client = new google.auth.OAuth2(client_id, client_secret);
  const token = JSON.parse(fs.readFileSync(DRIVE_TOKEN_PATH, 'utf8'));
  oauth2Client.setCredentials(token);
  return oauth2Client;
}

function classifyImportFile(name) {
  const n = name.toLowerCase();
  // Factura / Invoice
  if (n.includes('factura') || n.includes('invoice') || n.includes('fatura')) return 'factura';
  // Packing list
  if (n.includes('packing') || n.includes('empaque') || n.includes('embalaje') || n.includes('lista de empaque') || n.match(/\bpl\s*(final|of)\b/)) return 'packing_list';
  // Certificado de origen
  if (n.includes('certificado') || n.includes('origen') || n.match(/^co\s+\d/) || n.match(/\bcod\b/) || n.includes('certificadodeorig')) return 'certificado_origen';
  // Comprobante de pago
  if (n.includes('comprobante') || n.includes('transferencia') || n.includes('bbva') || n.includes('pago') || n.includes('comprobante_lote')) return 'comprobante_pago';
  // Despacho aduanero
  if (n.includes('despacho') || n.includes('sob_') || n.match(/^111a\d/) || n.includes('reportefact') || n.match(/^ryf\s/) || n.includes('du-e')) return 'despacho';
  // Despacho del despachante (MA + PROVEEDOR.pdf)
  if (n.match(/^ma\s+[a-z]/) && n.endsWith('.pdf') && !n.includes('import')) return 'despacho';
  // CRT
  if (n.match(/\bcrt\b/) || n.includes('carta de porte')) return 'crt';
  // Proforma
  if (n.includes('proforma') || n.includes('pro forma') || n.includes('pisv') || n.includes('plsv') || n.includes('cisv') || n.match(/\bpi\s*(final|of|-final)\b/) || n.match(/^pi\s+exp/) || n.match(/^pi-/i)) return 'proforma';
  // Costo
  if (n.includes('costo') || n.includes('costos')) return 'costo';
  // MIC
  if (n.match(/\bmic\b/)) return 'mic';
  // Nota fiscal
  if (n.match(/\bnf\s/) || n.includes('nfe') || n.includes('nota fiscal') || n.match(/\bnfe?\s?\d/)) return 'nota_fiscal';
  // Seguro
  if (n.includes('seguro')) return 'seguro';
  // Flete
  if (n.includes('flete') || n.includes('frete')) return 'flete';
  // Imagenes
  if (n.endsWith('.jpg') || n.endsWith('.jpeg') || n.endsWith('.png')) return 'imagen';
  return 'documento';
}

function parseImportFolder(name, subfolders) {
  // Standard format: B29 - BRAVO / 4.6.24
  const match = name.match(/^([BC]\d+)\s*-\s*(.+?)(?:\s*\/\s*(.*))?$/);
  if (match) {
    const code = match[1].trim();
    const supplier = match[2].trim();
    const details = (match[3] || '').trim();
    let date = null;
    const dateMatch = details.match(/(\d{1,2}[./]\d{1,2}[./]\d{2,4})/);
    if (dateMatch) date = dateMatch[1];
    return { code, supplier, date, details };
  }

  // 2026 format: "B 01" with subfolder "26 - TREVISUL"
  const match2 = name.match(/^([BC])\s+(\d+)$/);
  if (match2) {
    const code = `${match2[1]}${match2[2]}`;
    let supplier = name;
    let date = null;
    // Try to get supplier from subfolder names
    if (subfolders && subfolders.length) {
      const sub = subfolders[0];
      const subMatch = sub.match(/^\d+\s*-\s*(.+)/);
      if (subMatch) supplier = subMatch[1].trim();
    }
    return { code, supplier, date, details: '' };
  }

  return { code: name, supplier: name, date: null, details: '' };
}

function checkImportCompleteness(files, origin) {
  const types = new Set(files.map(f => classifyImportFile(f.name)));
  const required = { BRASIL: ['factura','packing_list','comprobante_pago','despacho'], CHINA: ['factura','packing_list','comprobante_pago','despacho'] };
  const desirable = { BRASIL: ['certificado_origen','crt','proforma','costo'], CHINA: ['proforma','costo','seguro'] };
  const reqs = required[origin] || required.BRASIL;
  const desirs = desirable[origin] || desirable.BRASIL;
  const missing = reqs.filter(r => !types.has(r));
  const missingDesirable = desirs.filter(d => !types.has(d));
  const pct = Math.round(((reqs.length - missing.length) / reqs.length) * 100);
  return { pct, missing, missingDesirable, types: [...types] };
}

// Deducibles = reintegros de gastos (no se suman al costo, se recuperan)
// Anticipo IDAE/IRAE, IVA importación, Anticipo de IVA
const DEDUCIBLE_KEYS = ['iva', 'anticipo de iva', 'anticipo iva', 'anticipo irae', 'anticipo idae', 'i.v.a'];

function classifyDespachoItem(label) {
  const l = label.toLowerCase().trim();
  if (DEDUCIBLE_KEYS.some(k => l.includes(k))) return 'deducible';
  return 'no_deducible';
}

function parseCostSheet(rows) {
  const costs = {};
  const despacho = {};
  for (const row of rows) {
    if (!row || !row[0]) continue;
    const label = row[0].toString().trim().toUpperCase();
    const value = row[1] ? parseFloat(row[1].toString().replace(/\./g, '').replace(',', '.')) : null;
    if (label === 'PROVEEDOR') costs.proveedor = row[1];
    else if (label === 'ORIGEN') costs.origen = row[1];
    else if (label.includes('FECHA')) costs.fecha = row[1];
    else if (label === 'PRODUCTO') costs.producto = row[1];
    else if (label === 'FOB') costs.fob = value;
    else if (label === 'FLETE') costs.flete = value;
    else if (label.includes('COMISION')) costs.comision = value;
    else if (label.includes('FLETE INTERNO')) costs.fleteInterno = value;
    else if (label.includes('PUESTA FOB')) costs.puestaFob = value;
    else if (label.includes('GTOS GIRO') || label.includes('GASTOS GIRO')) costs.gastosGiro = value;
    else if (label.includes('GTOS DESPACHO') || label.includes('GASTOS DESPACHO')) costs.gastosDespacho = value;
    else if (label.includes('OTROS')) costs.otros = value;
    else if (label.startsWith('TOTAL')) costs.total = value;
    else if (label.includes('GASTOS TOTALES')) costs.gastosTotales = value;
    if (row[4] && row[4].toString().trim() === 'TC' && row[5]) {
      costs.tc = parseFloat(row[5].toString().replace(',', '.'));
    }
    if (row[7] && row[8]) {
      const dLabel = row[7].toString().trim();
      const dValue = parseFloat(row[8].toString().replace(/\./g, '').replace(',', '.'));
      if (dLabel && !isNaN(dValue)) despacho[dLabel] = dValue;
    }
  }

  // Classify despacho items
  const deducibles = {};
  const noDeducibles = {};
  const otrosDespacho = {};
  let totalDeducible = 0;
  let totalNoDeducible = 0;

  for (const [label, value] of Object.entries(despacho)) {
    const tipo = classifyDespachoItem(label);
    if (tipo === 'no_deducible') {
      noDeducibles[label] = value;
      totalNoDeducible += value;
    } else if (tipo === 'deducible') {
      deducibles[label] = value;
      totalDeducible += value;
    } else {
      otrosDespacho[label] = value;
    }
  }

  costs.detalleDespacho = despacho;
  costs.deducibles = deducibles;
  costs.noDeducibles = noDeducibles;
  costs.otrosDespacho = otrosDespacho;
  costs.totalDeducible = totalDeducible;
  costs.totalNoDeducible = totalNoDeducible;
  costs.totalDespacho = totalNoDeducible; // Solo se suman los no deducibles al costo

  // Monto factura = FOB (valor de la mercaderia)
  // Flete internacional
  costs.montoFactura = costs.fob || 0;
  costs.fleteInternacional = costs.flete || 0;

  return costs;
}

// GET /api/imp/imports
app.get('/api/imp/imports', (req, res) => {
  try {
    const index = JSON.parse(fs.readFileSync(DRIVE_INDEX_PATH, 'utf8'));
    const groups = {};
    for (const file of index) {
      const parts = file.path.split('/').filter(Boolean);
      if (parts.length < 3) continue;
      const key = `${parts[0]}/${parts[1]}/${parts[2]}`;
      if (!groups[key]) groups[key] = { country: parts[0], year: parts[1], folder: parts[2], files: [] };
      groups[key].files.push(file);
    }
    const imports = Object.entries(groups)
      .filter(([key, g]) => {
        // Filter out non-import folders (loose files, payment folders, etc.)
        const f = g.folder;
        if (f.endsWith('.pdf') || f.endsWith('.xlsx') || f.endsWith('.jpg')) return false;
        if (f.startsWith('PAGOS') || f.startsWith('CTA CTE') || f.startsWith('CC ')) return false;
        if (!f.match(/^[BC]\s?\d+/)) return false;
        return true;
      })
      .map(([key, g]) => {
        // Find subfolders for 2026-style imports (B 01/26 - TREVISUL)
        const subfolderNames = new Set();
        g.files.forEach(f => {
          const parts = f.path.split('/').filter(Boolean);
          if (parts.length >= 4) subfolderNames.add(parts[3]);
        });
        const parsed = parseImportFolder(g.folder, [...subfolderNames]);
        const completeness = checkImportCompleteness(g.files, g.country);
        return { key, country: g.country, year: g.year, folder: g.folder, code: parsed.code, supplier: parsed.supplier, date: parsed.date, details: parsed.details, fileCount: g.files.length, completeness };
      });
    imports.sort((a, b) => {
      if (a.country !== b.country) return a.country.localeCompare(b.country);
      if (a.year !== b.year) return a.year.localeCompare(b.year);
      return (parseInt(a.code.replace(/\D/g,'')) || 0) - (parseInt(b.code.replace(/\D/g,'')) || 0);
    });
    res.json(imports);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/imp/import/:country/:year/:folder
app.get('/api/imp/import/:country/:year/:folder', (req, res) => {
  try {
    const { country, year, folder } = req.params;
    const prefix = `/${country}/${year}/${decodeURIComponent(folder)}`;
    const index = JSON.parse(fs.readFileSync(DRIVE_INDEX_PATH, 'utf8'));
    const files = index.filter(f => f.path.startsWith(prefix)).map(f => ({ ...f, relativePath: f.path.slice(prefix.length), docType: classifyImportFile(f.name) }));
    const parsed = parseImportFolder(decodeURIComponent(folder));
    const completeness = checkImportCompleteness(files, country);
    res.json({ files, parsed, completeness, country, year, folder: decodeURIComponent(folder) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/imp/costs/:fileId
app.get('/api/imp/costs/:fileId', async (req, res) => {
  try {
    const sheets = google.sheets({ version: 'v4', auth: getDriveAuth() });
    const meta = await sheets.spreadsheets.get({ spreadsheetId: req.params.fileId });
    const sheetNames = meta.data.sheets.map(s => s.properties.title);
    const allData = {};
    for (const name of sheetNames) {
      const r = await sheets.spreadsheets.values.get({ spreadsheetId: req.params.fileId, range: `${name}!A1:Z50` });
      allData[name] = r.data.values || [];
    }
    const costs = parseCostSheet(allData[sheetNames[0]] || []);
    res.json({ sheets: allData, costs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/imp/search
app.get('/api/imp/search', (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase();
    if (!q) return res.json([]);
    const index = JSON.parse(fs.readFileSync(DRIVE_INDEX_PATH, 'utf8'));
    const results = index.filter(f => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)).slice(0, 50).map(f => ({ ...f, docType: classifyImportFile(f.name) }));
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/imp/stats
app.get('/api/imp/stats', (req, res) => {
  try {
    const index = JSON.parse(fs.readFileSync(DRIVE_INDEX_PATH, 'utf8'));
    const countries = new Set(), suppliers = new Set(), years = new Set();
    let totalImports = 0;
    const seen = {};
    for (const file of index) {
      const parts = file.path.split('/').filter(Boolean);
      if (parts.length < 3) continue;
      const f = parts[2];
      if (f.endsWith('.pdf') || f.endsWith('.xlsx') || f.endsWith('.jpg')) continue;
      if (f.startsWith('PAGOS') || f.startsWith('CTA CTE') || f.startsWith('CC ')) continue;
      if (!f.match(/^[BC]\s?\d+/)) continue;
      countries.add(parts[0]); years.add(parts[1]);
      const key = `${parts[0]}/${parts[1]}/${parts[2]}`;
      if (!seen[key]) {
        seen[key] = true; totalImports++;
        // For B ## folders, try to get supplier from subfolder
        const subfolders = parts.length >= 4 && parts[2].match(/^[BC]\s+\d+$/) ? [parts[3]] : [];
        suppliers.add(parseImportFolder(parts[2], subfolders).supplier);
      }
    }
    res.json({ totalFiles: index.length, totalImports, countries: [...countries], suppliers: [...suppliers].sort(), years: [...years].sort() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/imp/edit-costs — Edit cached cost data
app.post('/api/imp/edit-costs', (req, res) => {
  try {
    const { key, costos } = req.body;
    if (!key || !costos) return res.status(400).json({ error: 'key and costos required' });
    if (!impReadCache[key]) impReadCache[key] = { costos: null, facturas: [], packingLists: [], otros: [] };
    impReadCache[key].costos = { ...impReadCache[key].costos, ...costos, edited: true };
    saveImpCache();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/imp/reindex
app.post('/api/imp/reindex', async (req, res) => {
  try {
    const drive = google.drive({ version: 'v3', auth: getDriveAuth() });
    const index = [];
    async function indexRecursive(parentId, parentPath) {
      const r = await drive.files.list({ q: `'${parentId}' in parents and trashed = false`, fields: 'files(id, name, mimeType, size, modifiedTime)', pageSize: 1000 });
      for (const file of (r.data.files || [])) {
        const filePath = `${parentPath}/${file.name}`;
        index.push({ id: file.id, name: file.name, path: filePath, type: file.mimeType, size: file.size, modified: file.modifiedTime });
        if (file.mimeType === 'application/vnd.google-apps.folder') await indexRecursive(file.id, filePath);
      }
    }
    await indexRecursive(DRIVE_ROOT_FOLDER_ID, '');
    fs.writeFileSync(DRIVE_INDEX_PATH, JSON.stringify(index, null, 2));
    res.json({ success: true, count: index.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cache for read folder data
const IMP_CACHE_PATH = path.join(__dirname, 'data', 'imp_read_cache.json');
let impReadCache = {};
try { if (fs.existsSync(IMP_CACHE_PATH)) impReadCache = JSON.parse(fs.readFileSync(IMP_CACHE_PATH, 'utf8')); } catch {}
function saveImpCache() {
  try { fs.writeFileSync(IMP_CACHE_PATH, JSON.stringify(impReadCache, null, 2)); } catch(e) { console.error('imp cache save error:', e.message); }
}

// GET /api/imp/read-folder/:country/:year/:folder — Read & extract data from all files
app.get('/api/imp/read-folder/:country/:year/:folder', async (req, res) => {
  try {
    const { country, year, folder } = req.params;
    const cacheKey = `${country}/${year}/${decodeURIComponent(folder)}`;
    const forceRefresh = req.query.refresh === '1';

    // Return cached if available
    if (!forceRefresh && impReadCache[cacheKey]) {
      return res.json(impReadCache[cacheKey]);
    }

    const prefix = `/${country}/${year}/${decodeURIComponent(folder)}`;
    const index = JSON.parse(fs.readFileSync(DRIVE_INDEX_PATH, 'utf8'));
    const files = index.filter(f => f.path.startsWith(prefix));
    const drive = google.drive({ version: 'v3', auth: getDriveAuth() });
    const sheets = google.sheets({ version: 'v4', auth: getDriveAuth() });

    const result = {
      info: parseImportFolder(decodeURIComponent(folder)),
      costos: null,
      facturas: [],
      packingLists: [],
      otros: [],
    };

    for (const file of files) {
      const docType = classifyImportFile(file.name);
      const isSheet = file.type === 'application/vnd.google-apps.spreadsheet';
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      const isXlsx = file.name.toLowerCase().endsWith('.xlsx') || file.name.toLowerCase().endsWith('.xls');
      const isFolder = file.type === 'application/vnd.google-apps.folder';

      if (isFolder) continue;

      // Read cost spreadsheet
      if (docType === 'costo' && isSheet) {
        try {
          const meta = await sheets.spreadsheets.get({ spreadsheetId: file.id });
          const sheetName = meta.data.sheets[0].properties.title;
          const r = await sheets.spreadsheets.values.get({ spreadsheetId: file.id, range: `${sheetName}!A1:Z50` });
          result.costos = parseCostSheet(r.data.values || []);
        } catch(e) { console.error('Error reading cost sheet:', e.message); }
        continue;
      }

      // Read PDFs (facturas, packing lists, proformas, etc.)
      if (isPdf && ['factura', 'packing_list', 'proforma', 'despacho', 'certificado_origen', 'documento'].includes(docType)) {
        try {
          const r = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'arraybuffer' });
          const buffer = Buffer.from(r.data);
          const pdf = await pdfParse(buffer);
          const text = pdf.text || '';

          const extracted = {
            file: file.name,
            type: docType,
            pages: pdf.numpages,
            text: text.substring(0, 5000), // limit
            data: extractDataFromText(text, docType),
          };

          if (docType === 'factura') result.facturas.push(extracted);
          else if (docType === 'packing_list') result.packingLists.push(extracted);
          else result.otros.push(extracted);
        } catch(e) {
          // Some PDFs are scanned images, can't extract text
          result.otros.push({ file: file.name, type: docType, error: 'No se pudo leer (posiblemente escaneado)' });
        }
        continue;
      }

      // Read Excel files
      if (isXlsx && (docType === 'factura' || docType === 'packing_list' || docType === 'proforma' || docType === 'costo')) {
        try {
          const XLSX = require('xlsx');
          const r = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'arraybuffer' });
          const wb = XLSX.read(Buffer.from(r.data), { type: 'buffer' });
          const sheetData = {};
          for (const name of wb.SheetNames) {
            sheetData[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1 });
          }
          const extracted = { file: file.name, type: docType, sheets: sheetData };
          if (docType === 'factura') result.facturas.push(extracted);
          else if (docType === 'packing_list') result.packingLists.push(extracted);
          else if (docType === 'costo' && !result.costos) {
            // Try to parse as cost sheet
            const firstSheet = sheetData[wb.SheetNames[0]] || [];
            result.costos = parseCostSheet(firstSheet);
          }
          else result.otros.push(extracted);
        } catch(e) {
          result.otros.push({ file: file.name, type: docType, error: e.message });
        }
      }
    }

    // If no cost sheet found, use Claude to read PDFs
    if (!result.costos && anthropic) {
      try {
        // Collect PDF buffers to send to Claude (max 3 most relevant files)
        const pdfFiles = files.filter(f => {
          const isPdf = f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
          const docType = classifyImportFile(f.name);
          return isPdf && ['factura', 'packing_list', 'proforma', 'despacho', 'documento', 'comprobante_pago'].includes(docType);
        }).slice(0, 4);

        if (pdfFiles.length > 0) {
          const pdfContents = [];
          for (const pf of pdfFiles) {
            try {
              const r = await drive.files.get({ fileId: pf.id, alt: 'media' }, { responseType: 'arraybuffer' });
              const base64 = Buffer.from(r.data).toString('base64');
              pdfContents.push({ name: pf.name, base64, type: classifyImportFile(pf.name) });
            } catch(e) { /* skip unreadable */ }
          }

          if (pdfContents.length > 0) {
            const content = [];
            content.push({ type: 'text', text: `Analizá estos documentos de una importación en Uruguay y extraé la información.

REGLA CRITICA: TODOS los montos deben ser NETOS SIN IVA. Si un documento muestra subtotal/neto + IVA + total, usá SIEMPRE el valor neto/subtotal. NUNCA el total con IVA incluido.

Respondé SOLO con un JSON válido (sin markdown, sin backticks):
{
  "proveedor": "nombre",
  "origen": "pais",
  "fecha": "fecha",
  "producto": "descripcion general",
  "factura": {"neto": numero_sin_iva, "iva": numero_o_null, "moneda": "USD/BRL/UYU"},
  "flete": {"neto": numero_sin_iva, "iva": numero_o_null, "moneda": "USD/BRL/UYU"},
  "gastos_despacho": [
    {"concepto": "nombre", "neto": numero_sin_iva, "moneda": "UYU"}
  ],
  "deducibles": [
    {"concepto": "IVA IMPORTACION", "monto": numero, "moneda": "UYU"},
    {"concepto": "ANTICIPO DE IVA", "monto": numero, "moneda": "UYU"},
    {"concepto": "ANTICIPO IRAE/IDAE", "monto": numero, "moneda": "UYU"}
  ],
  "productos": [
    {"descripcion": "nombre", "cantidad": "100 un", "precio_unitario": numero, "moneda": "USD"}
  ],
  "peso_bruto": "1234 kg",
  "peso_neto": "1100 kg",
  "container": "XXXX1234567"
}
Reglas:
- SIEMPRE neto sin IVA. Ej: si flete es neto 1704 + IVA 519 = total 2223, poner 1704
- Los deducibles (IVA importacion, anticipo IVA, anticipo IRAE/IDAE) van en el array "deducibles", separados de gastos_despacho
- Respetá la moneda original de cada documento
- Números sin formato de miles
- Solo incluí campos que encuentres` });

            for (const pdf of pdfContents) {
              content.push({
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: pdf.base64 },
              });
              content.push({ type: 'text', text: `Archivo: ${pdf.name} (${pdf.type})` });
            }

            const msg = await anthropic.messages.create({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 2000,
              messages: [{ role: 'user', content }],
            });

            const responseText = msg.content[0]?.text || '';
            try {
              const parsed = JSON.parse(responseText);
              result.claudeExtracted = parsed;

              const fac = parsed.factura || {};
              const fle = parsed.flete || {};
              const facMonto = fac.neto || fac.monto || null; // Siempre neto
              const facMoneda = fac.moneda || 'USD';
              const fleMonto = fle.neto || fle.monto || null; // Siempre neto
              const fleMoneda = fle.moneda || facMoneda;

              // Build despacho from gastos_despacho array (todos netos)
              const detalleDespacho = {};
              const deducibles = {};
              const noDeducibles = {};
              let totalDeducible = 0, totalNoDeducible = 0;

              (parsed.gastos_despacho || []).forEach(g => {
                const monto = g.neto || g.monto || 0;
                if (g.concepto && monto) {
                  detalleDespacho[g.concepto] = monto;
                  noDeducibles[g.concepto] = monto;
                  totalNoDeducible += monto;
                }
              });

              // Deducibles van aparte (IVA, anticipos)
              (parsed.deducibles || []).forEach(g => {
                if (g.concepto && g.monto) {
                  deducibles[g.concepto] = g.monto;
                  totalDeducible += g.monto;
                }
              });

              const totalDespacho = totalNoDeducible; // Solo no deducibles se suman al costo

              if (facMonto || Object.keys(detalleDespacho).length) {
                result.costos = {
                  proveedor: parsed.proveedor || null,
                  origen: parsed.origen || null,
                  fecha: parsed.fecha || null,
                  producto: parsed.producto || null,
                  fob: facMonto,
                  fobMoneda: facMoneda,
                  flete: fleMonto,
                  fleteMoneda: fleMoneda,
                  total: facMonto,
                  montoFactura: facMonto,
                  montoFacturaMoneda: facMoneda,
                  fleteInternacional: fleMonto || 0,
                  fleteInternacionalMoneda: fleMoneda,
                  tc: null,
                  detalleDespacho,
                  despachoMoneda: parsed.gastos_despacho?.[0]?.moneda || 'UYU',
                  deducibles, noDeducibles,
                  totalDeducible, totalNoDeducible,
                  totalDespacho,
                  source: 'claude',
                };
              }

              // Products
              if (parsed.productos?.length) {
                result.facturas.push({
                  file: 'Extraido por IA',
                  type: 'factura',
                  data: {
                    products: parsed.productos.map(p => {
                      if (typeof p === 'string') return p;
                      let line = p.descripcion || '';
                      if (p.cantidad) line = `${p.cantidad} - ${line}`;
                      if (p.precio_unitario) line += ` (${p.moneda || facMoneda} ${p.precio_unitario})`;
                      return line;
                    }),
                    weights: [parsed.peso_bruto, parsed.peso_neto].filter(Boolean),
                    containers: parsed.container ? [parsed.container] : [],
                    amounts: facMonto ? [{ label: `Total factura`, value: facMonto, moneda: facMoneda }] : [],
                  },
                });
              }
            } catch(e) { /* Claude didn't return valid JSON */ }
          }
        }
      } catch(e) { console.error('Claude extraction error:', e.message); }
    }

    // Save to cache
    impReadCache[cacheKey] = result;
    saveImpCache();

    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function extractDataFromText(text, docType) {
  const data = {};
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Try to extract amounts (USD, UYU, BRL)
  const amountPatterns = [
    /(?:total|valor|amount|monto|importe)\s*:?\s*(?:US\$?|USD|\$)\s*([\d.,]+)/gi,
    /(?:US\$?|USD)\s*([\d.,]+)/gi,
    /(?:FOB|CIF|CFR)\s*:?\s*(?:US\$?|USD|\$)?\s*([\d.,]+)/gi,
  ];

  const amounts = [];
  for (const pattern of amountPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const val = parseFloat(match[1].replace(/\./g, '').replace(',', '.'));
      if (!isNaN(val) && val > 0) amounts.push({ label: match[0].trim(), value: val });
    }
  }
  if (amounts.length) data.amounts = amounts.slice(0, 10);

  // Try to extract product descriptions / items
  const products = [];
  for (const line of lines) {
    // Lines that look like product entries (have quantity + description patterns)
    if (line.match(/^\d+\s+.{5,}/) || line.match(/\d+\s*(un|pcs|pc|ctn|ctns|box|boxes|pzs|pz|kg|und)\b/i)) {
      products.push(line.substring(0, 200));
    }
  }
  if (products.length) data.products = products.slice(0, 30);

  // Extract weights
  const weightMatch = text.match(/(?:peso|weight|gross|net|bruto|neto)\s*:?\s*([\d.,]+)\s*(kg|ton|lb)/gi);
  if (weightMatch) data.weights = weightMatch.slice(0, 5);

  // Extract container info
  const containerMatch = text.match(/\b([A-Z]{4}\d{7})\b/g);
  if (containerMatch) data.containers = [...new Set(containerMatch)];

  return data;
}

// ── Dimensiones de envío ─────────────────────────────────────────
// Debug: ver shipping raw de un item
app.get('/api/dimensiones/raw/:id', requireToken, async (req, res) => {
  try {
    const headers = { Authorization: `Bearer ${tokenData.access_token}` };
    const r = await axios.get(`${ML_API_URL}/items/${req.params.id}`, {
      headers, params: { attributes: 'id,title,shipping' }
    });
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/dimensiones', requireToken, async (req, res) => {
  try {
    const headers = { Authorization: `Bearer ${tokenData.access_token}` };

    function parseDimStr(s) {
      if (!s) return { length: null, width: null, height: null, weight: null };
      const m = s.match(/^(\d+)x(\d+)x(\d+),(\d+)$/);
      if (m) return { length: +m[1], width: +m[2], height: +m[3], weight: +m[4] };
      return { length: null, width: null, height: null, weight: null };
    }

    // Fetch shipping dimensions en lotes de 20 usando multiget con atributo shipping
    const allIds = cachedItems.map(i => i.id);
    const shippingMap = {};
    for (let i = 0; i < allIds.length; i += 20) {
      const batch = allIds.slice(i, i + 20);
      try {
        const r = await axios.get(`${ML_API_URL}/items`, {
          headers, params: { ids: batch.join(','), attributes: 'id,shipping' }
        });
        for (const entry of (r.data || [])) {
          if (entry.body) {
            const dimStr = entry.body.shipping?.dimensions;
            shippingMap[entry.body.id] = {
              dimensions: typeof dimStr === 'string' ? dimStr : null,
              free_shipping: entry.body.shipping?.free_shipping || false,
              logistic_type: entry.body.shipping?.logistic_type || null,
            };
          }
        }
      } catch {}
      if (i + 20 < allIds.length) await sleep(80);
    }
    console.log(`[dimensiones] fetched shipping para ${Object.keys(shippingMap).length} items`);

    const items = cachedItems.map(item => {
      const sh = shippingMap[item.id] || {};
      const dims = parseDimStr(sh.dimensions);
      const sku = (item.attributes || []).find(a => a.id === 'SELLER_SKU')?.value_name
        || (item.attributes || []).find(a => a.id === 'SELLER_SKU')?.values?.[0]?.name
        || null;
      return {
        id: item.id,
        title: item.title,
        thumbnail: item.thumbnail,
        status: item.status,
        sku,
        free_shipping: sh.free_shipping || false,
        logistic_type: sh.logistic_type || item.shipping?.logistic_type || null,
        dimensions: sh.dimensions || null,
        length: dims.length,
        width: dims.width,
        height: dims.height,
        weight: dims.weight,
      };
    });
    res.json({ items, total: items.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Zureo ventas históricas ──────────────────────────────────────
const ZUREO_FILE = path.join(__dirname, 'data', 'zureo_ventas.json');
let zureoData = null;
try { if (fs.existsSync(ZUREO_FILE)) { zureoData = JSON.parse(fs.readFileSync(ZUREO_FILE, 'utf8')); console.log(`[zureo] cargado: ${Object.keys(zureoData.monthly).length} meses, ${Object.keys(zureoData.items).length} artículos`); } } catch(e) { console.error('[zureo] error:', e.message); }

app.get('/api/zureo/resumen', requireToken, (req, res) => {
  if (!zureoData) return res.json({ monthly: {}, items: [] });
  res.json({ monthly: zureoData.monthly });
});

// Histórico unificado: Zureo (hasta 2025-08) + ML (desde 2025-09)
app.get('/api/historico', requireToken, (req, res) => {
  const monthly = {};
  const ML_START = '2025-09'; // ML toma desde acá

  // Zureo primero (2023-08 a 2025-08)
  if (zureoData) {
    for (const [k, v] of Object.entries(zureoData.monthly)) {
      if (k < ML_START) {
        monthly[k] = { count: v.qty, revenue: v.total, source: 'zureo' };
      }
    }
  }

  // ML desde 2025-09
  for (const [k, v] of Object.entries(monthlyStats)) {
    if (k >= ML_START) {
      monthly[k] = { count: v.count, revenue: v.revenue, units: v.units || 0, source: 'ml' };
    }
  }

  res.json({ monthly });
});

app.get('/api/zureo/items', requireToken, (req, res) => {
  if (!zureoData) return res.json({ items: [] });
  const q = (req.query.q || '').toLowerCase();
  const sortBy = req.query.sort || 'total'; // total, qty, name
  let items = Object.values(zureoData.items).map(it => {
    let totalQty = 0, totalAmount = 0;
    for (const m of Object.values(it.months)) { totalQty += m.qty; totalAmount += m.total; }
    return { ...it, totalQty, totalAmount };
  });
  if (q) items = items.filter(it => it.name.toLowerCase().includes(q) || it.code.toLowerCase().includes(q));
  if (sortBy === 'total') items.sort((a,b) => b.totalAmount - a.totalAmount);
  else if (sortBy === 'qty') items.sort((a,b) => b.totalQty - a.totalQty);
  else items.sort((a,b) => a.name.localeCompare(b.name));
  res.json({ items: items.slice(0, parseInt(req.query.limit) || 200), total: items.length });
});

// ── Comparador de productos año a año ────────────────────────────
app.get('/api/zureo/comparador', requireToken, (req, res) => {
  if (!zureoData) return res.json({ items: [] });
  const q = (req.query.q || '').toLowerCase();
  const sortBy = req.query.sort || 'diff'; // diff, total, qty, name, growth
  const year1 = parseInt(req.query.year1) || new Date().getFullYear();
  const year2 = parseInt(req.query.year2) || year1 - 1;

  const pad2 = n => String(n).padStart(2, '0');
  const results = [];

  for (const [code, item] of Object.entries(zureoData.items)) {
    if (q && !item.name.toLowerCase().includes(q) && !code.toLowerCase().includes(q)) continue;

    const y1 = { qty: 0, total: 0, months: {} };
    const y2 = { qty: 0, total: 0, months: {} };

    for (const [m, v] of Object.entries(item.months)) {
      const y = parseInt(m.slice(0, 4));
      const mo = parseInt(m.slice(5));
      if (y === year1) { y1.qty += v.qty; y1.total += v.total; y1.months[mo] = v; }
      if (y === year2) { y2.qty += v.qty; y2.total += v.total; y2.months[mo] = v; }
    }

    if (y1.qty === 0 && y2.qty === 0) continue;

    const diffTotal = y1.total - y2.total;
    const diffQty = y1.qty - y2.qty;
    const growthPct = y2.total > 0 ? ((y1.total - y2.total) / y2.total * 100) : (y1.total > 0 ? 100 : 0);

    // Odoo stock
    const mapping = zureoOdooMap[code];
    const odooSku = mapping?.odooSku || code;
    const mlItem = cachedStock.find(s => s.sku === odooSku || s.sku === code);

    const monthly = [];
    for (let m = 1; m <= 12; m++) {
      monthly.push({
        month: m,
        y1Qty: y1.months[m]?.qty || 0, y1Total: Math.round(y1.months[m]?.total || 0),
        y2Qty: y2.months[m]?.qty || 0, y2Total: Math.round(y2.months[m]?.total || 0),
      });
    }

    results.push({
      code, name: item.name,
      year1, year2,
      y1Qty: y1.qty, y1Total: Math.round(y1.total),
      y2Qty: y2.qty, y2Total: Math.round(y2.total),
      diffTotal: Math.round(diffTotal), diffQty,
      growthPct: Math.round(growthPct * 10) / 10,
      monthly,
      mlStock: mlItem?.stock ?? null,
      mlId: mlItem?.id || null,
    });
  }

  // Sort
  switch (sortBy) {
    case 'diff': results.sort((a, b) => b.diffTotal - a.diffTotal); break;
    case 'drop': results.sort((a, b) => a.diffTotal - b.diffTotal); break;
    case 'total': results.sort((a, b) => b.y1Total - a.y1Total); break;
    case 'qty': results.sort((a, b) => b.y1Qty - a.y1Qty); break;
    case 'growth': results.sort((a, b) => b.growthPct - a.growthPct); break;
    case 'name': results.sort((a, b) => a.name.localeCompare(b.name)); break;
  }

  // Totals
  const totY1 = results.reduce((s, i) => s + i.y1Total, 0);
  const totY2 = results.reduce((s, i) => s + i.y2Total, 0);
  const totQtyY1 = results.reduce((s, i) => s + i.y1Qty, 0);
  const totQtyY2 = results.reduce((s, i) => s + i.y2Qty, 0);
  const grew = results.filter(i => i.diffTotal > 0).length;
  const dropped = results.filter(i => i.diffTotal < 0).length;

  res.json({
    items: results.slice(0, parseInt(req.query.limit) || 500),
    total: results.length, year1, year2,
    summary: { totY1, totY2, totQtyY1, totQtyY2, grew, dropped, diff: totY1 - totY2 },
  });
});

// ── Productos perdidos mes a mes ─────────────────────────────────
const ZUREO_ODOO_MAP_FILE = path.join(__dirname, 'data', 'zureo_odoo_mapping.json');
let zureoOdooMap = {};
try { if (fs.existsSync(ZUREO_ODOO_MAP_FILE)) { zureoOdooMap = JSON.parse(fs.readFileSync(ZUREO_ODOO_MAP_FILE, 'utf8')); console.log(`[mapping] zureo→odoo: ${Object.keys(zureoOdooMap).length} items`); } } catch {}

app.get('/api/perdidos', requireToken, (req, res) => {
  if (!zureoData) return res.json({ months: [] });
  const minQty = parseInt(req.query.min) || 1;
  const filter = req.query.filter || 'todos'; // todos, sin_stock, con_stock

  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;
  const monthNames = ['','Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const itemData = zureoData.items;

  // Build Odoo stock lookup from cache — sum all variants (19446-BLA + 19446-NEG → 19446)
  const odooStockMap = {};     // exact sku → { stock, name }
  const odooBaseStock = {};    // base code → total stock across variants
  try {
    const cache = path.join(__dirname, 'data', 'odoo_cache.json');
    if (fs.existsSync(cache)) {
      const d = JSON.parse(fs.readFileSync(cache, 'utf8'));
      // Support multiple formats
      let allItems = [];
      if (d.categories) {
        for (const cat of d.categories) allItems.push(...(cat.items || []));
      } else if (Array.isArray(d.products)) {
        // Raw Odoo format: {id, name, default_code, qty_available, ...}
        allItems = d.products.map(p => ({
          id: p.id, name: p.name,
          sku: p.default_code || p.sku || null,
          stock: p.qty_available ?? p.stock ?? 0,
        }));
      }
      for (const item of allItems) {
        if (!item.sku) continue;
        odooStockMap[item.sku] = { stock: item.stock, name: item.name, id: item.id };
        const base = item.sku.replace(/-[A-Z]{2,}$/, '');
        if (!odooBaseStock[base]) odooBaseStock[base] = { stock: 0, name: item.name, variants: [] };
        odooBaseStock[base].stock += Math.max(0, item.stock || 0);
        odooBaseStock[base].variants.push({ sku: item.sku, stock: item.stock });
      }
    }
  } catch {}

  const monthResults = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(curYear, curMonth - 1 - i, 1);
    const m = d.getMonth() + 1;
    const y = d.getFullYear();
    const key = `${y}-${pad(m)}`;
    const keyPrev = `${y - 1}-${pad(m)}`;

    let lost = [];
    for (const [code, item] of Object.entries(itemData)) {
      const prev = item.months[keyPrev];
      const curr = item.months[key];
      if (prev && prev.qty >= minQty && (!curr || curr.qty === 0)) {
        const mapping = zureoOdooMap[code];
        const odooSku = mapping?.odooSku || code;
        // Try exact, then base code for summed variants
        const odooExact = odooStockMap[odooSku] || odooStockMap[code];
        const odooBase = odooBaseStock[code] || odooBaseStock[odooSku];
        const odooStock = odooBase?.stock ?? odooExact?.stock ?? null;
        const odooName = mapping?.odooName || odooBase?.name || odooExact?.name || null;
        const mlItem = cachedStock.find(s => s.sku === odooSku || s.sku === code);

        lost.push({
          code, name: item.name,
          prevQty: prev.qty, prevTotal: Math.round(prev.total),
          odooSku, odooName,
          odooStock,
          mlStock: mlItem?.stock ?? null,
          mlId: mlItem?.id || null,
        });
      }
    }

    // Filter by stock
    if (filter === 'sin_stock') lost = lost.filter(i => (i.odooStock === 0 || i.odooStock === null) && (i.mlStock === 0 || i.mlStock === null));
    if (filter === 'con_stock') lost = lost.filter(i => (i.odooStock > 0) || (i.mlStock > 0));

    lost.sort((a, b) => b.prevTotal - a.prevTotal);
    const totalLost = lost.reduce((s, i) => s + i.prevTotal, 0);

    monthResults.push({
      key, label: monthNames[m] + ' ' + y,
      vs: monthNames[m] + ' ' + (y - 1),
      count: lost.length, totalLost,
      items: lost,
    });
  }

  res.json({ months: monthResults });
});

// ── CBM consumidos por mes (local/POS) ──────────────────────────
app.get('/api/cbm-local', requireToken, async (req, res) => {
  try {
    const uid = await odooAuth();
    const monthNames = { enero:'01',febrero:'02',marzo:'03',abril:'04',mayo:'05',junio:'06',julio:'07',agosto:'08',septiembre:'09',setiembre:'09',octubre:'10',noviembre:'11',diciembre:'12',
      january:'01',february:'02',march:'03',april:'04',may:'05',june:'06',july:'07',august:'08',september:'09',october:'10',november:'11',december:'12' };

    const posSales = await odooCall('/xmlrpc/2/object', 'execute_kw', [
      ODOO_DB, uid, ODOO_API_KEY, 'pos.order.line', 'read_group',
      [[]],
      { fields: ['product_id', 'qty', 'create_date'], groupby: ['product_id', 'create_date:month'], lazy: false }
    ]);

    const products = await getOdooProducts(false);
    const prodMap = {};
    for (const p of products) prodMap[p.id] = p;

    let ihomeMap = {};
    try { if (fs.existsSync(path.join(__dirname, 'data', 'ihome_mapping.json'))) ihomeMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'ihome_mapping.json'), 'utf8')); } catch {}

    const byMonth = {};
    const byProduct = {};

    for (const r of posSales) {
      if (!r.product_id) continue;
      const prod = prodMap[r.product_id[0]];
      if (!prod) continue;
      const sku = (prod.default_code || '').trim();
      const qty = r.qty || 0;
      if (qty <= 0) continue;

      const monthStr = (r['create_date:month'] || '').toLowerCase();
      const parts = monthStr.split(' ');
      if (parts.length !== 2) continue;
      const mm = monthNames[parts[0]];
      if (!mm) continue;
      const key = parts[1] + '-' + mm;

      const cbmUnit = ihomeMap[sku]?.cbm_per_unit || 0;
      const cbm = cbmUnit * qty;

      if (!byMonth[key]) byMonth[key] = { cbm: 0, qty: 0, products: new Set() };
      byMonth[key].cbm += cbm;
      byMonth[key].qty += qty;
      byMonth[key].products.add(sku);

      if (!byProduct[sku]) byProduct[sku] = { name: prod.name, totalQty: 0, totalCbm: 0, cbmUnit, months: {} };
      byProduct[sku].totalQty += qty;
      byProduct[sku].totalCbm += cbm;
      if (!byProduct[sku].months[key]) byProduct[sku].months[key] = { qty: 0, cbm: 0 };
      byProduct[sku].months[key].qty += qty;
      byProduct[sku].months[key].cbm += cbm;
    }

    for (const v of Object.values(byMonth)) { v.items = v.products.size; delete v.products; v.cbm = Math.round(v.cbm * 100) / 100; }

    const topProducts = Object.entries(byProduct)
      .map(([sku, d]) => ({ sku, ...d, totalCbm: Math.round(d.totalCbm * 100) / 100 }))
      .filter(p => p.totalCbm > 0)
      .sort((a, b) => b.totalCbm - a.totalCbm)
      .slice(0, 50);

    const months = Object.keys(byMonth).sort();
    const totalCbm = months.reduce((s, m) => s + byMonth[m].cbm, 0);
    const avgCbm = months.length > 0 ? Math.round(totalCbm / months.length * 100) / 100 : 0;

    res.json({
      byMonth, months, topProducts,
      summary: {
        totalCbm: Math.round(totalCbm * 100) / 100,
        avgCbmMonth: avgCbm,
        totalMonths: months.length,
        contenedores20ft: Math.round(avgCbm / 28 * 10) / 10,
        contenedores40ft: Math.round(avgCbm / 67 * 10) / 10,
      }
    });
  } catch (e) {
    console.error('[cbm-local]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Catálogo de productos con CBM y costos ─────────────────────
app.get('/api/catalogo-productos', requireToken, async (req, res) => {
  try {
    const products = await getOdooProducts(false);
    let ihomeMap = {};
    try { if (fs.existsSync(path.join(__dirname, 'data', 'ihome_mapping.json'))) ihomeMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'ihome_mapping.json'), 'utf8')); } catch {}

    const q = (req.query.q || '').toLowerCase();
    const sinCbm = req.query.sin_cbm === 'true';
    const sort = req.query.sort || 'name';

    const skipNames = ['mercado envios', 'self_service', 'drop_off', 'cross_docking', 'fulfillment', 'soydelivery', 'soy delivery', 'standard delivery', 'default fenicio', 'flete', 'costo de envio', 'retiro por local', 'envío', 'radio e instalacion'];

    let items = products.map(p => {
      const sku = (p.default_code || '').trim();
      if (!sku) return null;
      const nameLower = (p.name || '').toLowerCase();
      if (skipNames.some(s => nameLower.includes(s))) return null;
      if (p.type === 'service') return null;

      const ih = ihomeMap[sku] || {};
      const ml = cachedStock.find(s => s.sku === sku) || cachedVariationSkuMap[sku];
      const categ = Array.isArray(p.categ_id) ? p.categ_id[1] : '';

      return {
        id: p.id,
        sku,
        name: p.name,
        categ,
        stock: p.qty_available || 0,
        cost: p.standard_price || 0,
        price: p.list_price || 0,
        fob: ih.fob || 0,
        ihome: ih.ihome || '',
        cbm_per_unit: ih.cbm_per_unit || 0,
        cbm_source: ih.cbm_source || (ih.cbm_per_unit ? 'ihome' : ''),
        cbm_per_ctn: ih.cbm_per_ctn || 0,
        qty_per_ctn: ih.qty_per_ctn || 0,
        description_china: ih.description || '',
        ml_id: ml?.id || null,
        ml_thumbnail: ml?.thumbnail || null,
        ml_permalink: ml?.permalink || null,
      };
    }).filter(Boolean);

    if (q) items = items.filter(i => i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q) || i.ihome.toLowerCase().includes(q));
    if (sinCbm) items = items.filter(i => !i.cbm_per_unit);

    if (sort === 'name') items.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'sku') items.sort((a, b) => a.sku.localeCompare(b.sku));
    else if (sort === 'stock') items.sort((a, b) => b.stock - a.stock);
    else if (sort === 'cost') items.sort((a, b) => b.cost - a.cost);
    else if (sort === 'fob') items.sort((a, b) => b.fob - a.fob);
    else if (sort === 'cbm') items.sort((a, b) => b.cbm_per_unit - a.cbm_per_unit);

    const totalItems = items.length;
    const conCbm = items.filter(i => i.cbm_per_unit > 0).length;
    const conFob = items.filter(i => i.fob > 0).length;

    res.json({
      items: items.slice(0, parseInt(req.query.limit) || 500),
      total: totalItems,
      conCbm, conFob,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Export orden a Excel con fotos ──────────────────────────────
app.post('/api/orden/export-excel', requireToken, async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const { items } = req.body;
    if (!items?.length) return res.status(400).json({ error: 'Sin items' });

    let ihomeMap = {};
    try { if (fs.existsSync(path.join(__dirname, 'data', 'ihome_mapping.json'))) ihomeMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'ihome_mapping.json'), 'utf8')); } catch {}

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Orden de Compra');

    // Header
    ws.columns = [
      { header: 'Foto', key: 'foto', width: 12 },
      { header: 'SKU', key: 'sku', width: 15 },
      { header: 'IHOME', key: 'ihome', width: 12 },
      { header: 'Producto', key: 'name', width: 40 },
      { header: 'Qty', key: 'qty', width: 8 },
      { header: 'CBM/u', key: 'cbm_unit', width: 10 },
      { header: 'CBM Total', key: 'cbm_total', width: 10 },
      { header: 'FOB/u', key: 'fob', width: 10 },
      { header: 'FOB Total', key: 'fob_total', width: 12 },
      { header: 'Origen', key: 'origen', width: 10 },
      { header: 'Link ML', key: 'ml_link', width: 50 },
    ];

    // Style header
    ws.getRow(1).font = { bold: true, size: 11 };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4361EE' } };
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      const sku = (item.sku || '').trim();
      const ih = ihomeMap[sku] || {};
      // Search ML by exact SKU, then by base SKU (without -COLOR suffix)
      let ml = cachedStock.find(s => s.sku === sku) || cachedVariationSkuMap[sku];
      if (!ml) {
        const base = sku.replace(/-[A-Z]{2,}$/, '');
        ml = cachedStock.find(s => s.sku === base || (s.sku || '').startsWith(sku));
      }
      const cbmUnit = ih.cbm_per_unit || 0;
      const fob = ih.fob || 0;
      const mlLink = ml?.permalink || (ml?.id ? `https://articulo.mercadolibre.com.uy/${ml.id.replace('MLU','MLU-')}` : '');

      const row = ws.addRow({
        foto: '',
        sku: item.sku,
        ihome: ih.ihome || '',
        name: item.name,
        qty: item.qty,
        cbm_unit: cbmUnit,
        cbm_total: Math.round(cbmUnit * item.qty * 1000) / 1000,
        fob: fob,
        fob_total: Math.round(fob * item.qty * 100) / 100,
        origen: item.origen || '',
        ml_link: mlLink,
      });

      row.height = 45;

      // ML link as hyperlink
      if (mlLink) {
        row.getCell('ml_link').value = { text: mlLink, hyperlink: mlLink };
        row.getCell('ml_link').font = { color: { argb: 'FF3B82F6' }, underline: true };
      }

      // Try to add image — ML thumbnail, or Odoo image, or IHOME image
      const thumbUrl = item.thumb || ml?.thumbnail || (ih.image ? `http://localhost:${PORT}${ih.image}` : null);
      if (thumbUrl) {
        try {
          const imgRes = await axios.get(thumbUrl, { responseType: 'arraybuffer', timeout: 5000 });
          const imgId = wb.addImage({ buffer: imgRes.data, extension: 'jpeg' });
          ws.addImage(imgId, {
            tl: { col: 0, row: idx + 1 },
            ext: { width: 50, height: 50 },
          });
        } catch {}
      }
    }

    // Totals row
    const totalQty = items.reduce((s, i) => s + (i.qty || 0), 0);
    const totalCbm = items.reduce((s, i) => s + (ihomeMap[i.sku]?.cbm_per_unit || 0) * (i.qty || 0), 0);
    const totalFob = items.reduce((s, i) => s + (ihomeMap[i.sku]?.fob || 0) * (i.qty || 0), 0);
    const totRow = ws.addRow({ name: 'TOTAL', qty: totalQty, cbm_total: Math.round(totalCbm * 100) / 100, fob_total: Math.round(totalFob * 100) / 100 });
    totRow.font = { bold: true, size: 12 };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=orden-compra.xlsx');
    await wb.xlsx.write(res);
  } catch (e) {
    console.error('[export-excel]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Comparador año a año ─────────────────────────────────────────
app.get('/api/comparador', requireToken, async (req, res) => {
  const headers = { Authorization: `Bearer ${tokenData.access_token}` };
  const sellerId = tokenData.user_id;
  const now = new Date();
  const mode    = req.query.mode || 'mensual'; // 'mensual', 'hasta-hoy' o 'diario'
  const month   = parseInt(req.query.month) || (now.getMonth() + 1);
  const day     = parseInt(req.query.day)   || now.getDate();
  const year    = now.getFullYear();
  const cutDay  = now.getDate(); // día actual para "hasta hoy"

  function fmtISO(d) { return d.toISOString().slice(0, 19) + '.000-00:00'; }

  let periods;
  if (mode === 'diario') {
    periods = [year, year - 1, year - 2].map(y => {
      const from = new Date(y, month - 1, day);
      const to   = new Date(y, month - 1, day + 1);
      return { year: y, from: fmtISO(from), to: fmtISO(to), label: `${pad(day)}/${pad(month)}/${y}` };
    });
  } else if (mode === 'hasta-hoy') {
    // Del 1 al día de hoy del mes seleccionado, en cada año
    periods = [year, year - 1, year - 2].map(y => {
      const from = new Date(y, month - 1, 1);
      const to   = new Date(y, month - 1, cutDay + 1); // hasta fin del día actual
      return { year: y, from: fmtISO(from), to: fmtISO(to), label: `01-${pad(cutDay)}/${pad(month)}/${y}` };
    });
  } else {
    // Mes completo
    periods = [year, year - 1, year - 2].map(y => {
      const from = new Date(y, month - 1, 1);
      const to   = new Date(y, month, 1);
      return { year: y, from: fmtISO(from), to: fmtISO(to), label: `${pad(month)}/${y}` };
    });
  }

  async function fetchPeriod(p) {
    const items = {};
    let total = 0, revenue = 0;
    const allResults = [];

    const first = await axios.get(`${ML_API_URL}/orders/search`, {
      headers, params: {
        seller: sellerId, 'order.status': 'paid',
        'order.date_created.from': p.from, 'order.date_created.to': p.to,
        limit: 50, offset: 0, sort: 'date_asc'
      }
    });
    allResults.push(...(first.data.results || []));
    const totalOrders = first.data.paging?.total || 0;

    const maxOffset = Math.min(totalOrders, 1000);
    const pagesToFetch = Math.ceil(maxOffset / 50);
    if (pagesToFetch > 1) {
      for (let batch = 1; batch < pagesToFetch; batch += 10) {
        const promises = [];
        for (let pg = batch; pg < Math.min(batch + 10, pagesToFetch); pg++) {
          promises.push(
            axios.get(`${ML_API_URL}/orders/search`, {
              headers, params: {
                seller: sellerId, 'order.status': 'paid',
                'order.date_created.from': p.from, 'order.date_created.to': p.to,
                limit: 50, offset: pg * 50, sort: 'date_asc'
              }
            }).catch(() => ({ data: { results: [] } }))
          );
        }
        const pages = await Promise.all(promises);
        pages.forEach(pg => allResults.push(...(pg.data.results || [])));
        if (batch + 10 < pagesToFetch) await sleep(200);
      }
    }

    console.log(`[comparador] ${p.label}: ${allResults.length}/${totalOrders} órdenes`);

    for (const order of allResults) {
      revenue += order.total_amount || 0;
      total++;
      for (const oi of (order.order_items || [])) {
        const itemId = oi.item?.id;
        if (!itemId) continue;
        if (!items[itemId]) {
          items[itemId] = { id: itemId, title: oi.item.title || itemId, thumbnail: oi.item.thumbnail || null, quantity: 0, revenue: 0 };
        }
        items[itemId].quantity += oi.quantity || 1;
        items[itemId].revenue += (oi.unit_price || 0) * (oi.quantity || 1);
      }
    }

    for (const id of Object.keys(items)) {
      if (!items[id].thumbnail) {
        const c = cachedItems.find(x => x.id === id);
        if (c?.thumbnail) items[id].thumbnail = c.thumbnail;
      }
    }

    return {
      year: p.year, label: p.label, total, totalML: totalOrders,
      revenue: Math.round(revenue),
      units: Object.values(items).reduce((s, i) => s + i.quantity, 0),
      items: Object.values(items).sort((a, b) => b.quantity - a.quantity),
    };
  }

  try {
    const periodResults = await Promise.all(periods.map(fetchPeriod));
    res.json({ mode, month, day, periods: periodResults });
  } catch (e) {
    console.error('[comparador]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Lector de Proforma Invoice (con IA) ──

app.post('/api/pi/leer', requireToken, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });

  try {
    const wb = XLSX.read(req.file.buffer, { cellStyles: false, cellFormula: false });

    // 1. Convertir todas las hojas a texto para IA
    let sheetsText = '';
    const allRawData = {};
    for (const sheetName of wb.SheetNames) {
      const data = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1 });
      allRawData[sheetName] = data;
      // Convertir primeras 30 filas a texto legible
      const preview = data.slice(0, 30).map((row, i) =>
        `Row${i}: ${(row || []).map(c => c === null || c === undefined ? '' : String(c).slice(0, 80)).join(' | ')}`
      ).join('\n');
      sheetsText += `\n=== HOJA: ${sheetName} (${data.length} filas) ===\n${preview}\n`;
    }

    // 2. IA parsea el Excel
    console.log('[pi/ia] sheetsText length:', sheetsText.length, 'sheets:', wb.SheetNames.length);
    let aiProducts = [];
    if (anthropic) {
      const stockItems = cachedStock || [];
      const skuList = stockItems.filter(i => i.sku).slice(0, 200).map(i => `${i.sku} | ${i.title.slice(0, 50)}`).join('\n');

      // Procesar hoja por hoja para evitar respuestas truncadas
      let supplier = '';
      let contract = '';

      for (const sheetName of wb.SheetNames) {
        const data = allRawData[sheetName];
        const sheetText = data.slice(0, 40).map((row, i) =>
          `Row${i}: ${(row || []).map(c => c === null || c === undefined ? '' : String(c).slice(0, 80)).join(' | ')}`
        ).join('\n');

        console.log(`[pi/ia] Processing sheet: ${sheetName}`);
        const msg = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 8192,
          messages: [{ role: 'user', content: `Extraé los productos de esta hoja de una Proforma Invoice.

HOJA "${sheetName}":
${sheetText}

CATÁLOGO (SKU | Producto):
${skuList}

Pensá como una persona que trabaja en esta empresa y conoce el sistema de códigos. Para cada PRODUCTO (ignorá headers, totales, legales, filas vacías):

- sku: Mirá la columna MA CODE. Puede venir de varias formas:
  1. Ya completo con color y talle: "48107-NEG-42" → usalo tal cual
  2. Varios códigos separados por "/": "54505-BLA / 54505-NEG" → es un producto que viene en variantes, usá el primer código
  3. Solo número: "54505" → fijate en la DESCRIPTION si dice el color y armá el código completo

  Colores: Black=-NEG, White=-BLA, Grey/Gray=-GRI, Beige/Khaki=-BEI, Brown=-MAR, Blue=-AZU, Red=-ROJ, Green=-VER, Pink=-ROS, Champagne=-CHA, Natural/Wood=-NAT

  Mirá el catálogo para confirmar: si en el catálogo existe "54505-NEG" y la descripción dice "Black", entonces el sku es "54505-NEG". Si no estás seguro del color, dejá solo el número.

- description: nombre corto del producto EN ESPAÑOL si podés, sino en inglés. Incluí color/talle si aplica.
- qty: cantidad total (columna QUATITY/QUANTITY)
- fob: precio unitario FOB
- amount: monto total USD

Respondé SOLO JSON, sin backticks ni explicaciones:
[{"sku":"54505-NEG","description":"Mesa plegable negra 180x74","qty":100,"fob":15.5,"amount":1550}]` }],
        });

        let text = msg.content.find(b => b.type === 'text')?.text || '[]';
        text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').replace(/[\x00-\x1f]/g, ' ');
        console.log('[pi/ia] sheet response length:', text.length);

        try {
          const jsonMatch = text.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const products = JSON.parse(jsonMatch[0]);
            console.log(`[pi/ia] ${sheetName}: ${products.length} products`);
            products.forEach(p => { p.sheet = sheetName; });
            aiProducts = aiProducts.concat(products);
          }
        } catch(e) {
          console.error(`[pi/ia] ${sheetName} parse error:`, e.message);
          // Fallback truncado
          try {
            const lastBrace = text.lastIndexOf('}');
            const firstBracket = text.indexOf('[');
            if (firstBracket >= 0 && lastBrace > firstBracket) {
              const arr = JSON.parse(text.slice(firstBracket, lastBrace + 1) + ']');
              arr.forEach(p => { p.sheet = sheetName; });
              aiProducts = aiProducts.concat(arr);
              console.log(`[pi/ia] ${sheetName} fallback: ${arr.length} products`);
            }
          } catch {}
        }

        // Extraer supplier de la primera hoja
        if (!supplier) {
          const supMatch = data.flat().find(c => typeof c === 'string' && c.includes('CO.,LTD'));
          if (supMatch) supplier = supMatch;
        }
      }

      res._piSupplier = supplier;
      res._piContract = contract;
    }

    // 3. Matching con catálogo
    const stockItems = cachedStock || [];
    for (const prod of aiProducts) {
      prod.ml_matches = [];
      const sku = String(prod.sku || '').trim();

      if (sku) {
        const matches = stockItems.filter(i =>
          (i.sku || '') === sku ||
          (i.sku || '').startsWith(sku) ||
          (i.variation_skus || []).some(vs => vs === sku || vs.startsWith(sku))
        );
        if (matches.length) {
          prod.ml_matches = matches.map(m => ({
            id: m.id, title: m.title, sku: m.sku, price: m.price,
            stock: m.stock, sold30d: m.sold30d, thumbnail: m.thumbnail, permalink: m.permalink,
          }));
        }
      }
      prod.matched = prod.ml_matches.length > 0;
      prod.is_reposition = prod.matched;
    }

    const matched = aiProducts.filter(p => p.matched);
    const notMatched = aiProducts.filter(p => !p.matched);

    res.json({
      supplier: res._piSupplier || '',
      contract: res._piContract || '',
      total: aiProducts.length,
      matched: matched.length,
      not_matched: notMatched.length,
      total_qty: aiProducts.reduce((s, p) => s + (p.qty || 0), 0),
      total_amount: Math.round(aiProducts.reduce((s, p) => s + (p.amount || 0), 0) * 100) / 100,
      products: aiProducts,
    });
  } catch(e) {
    console.error('[pi/leer]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/pi/confirmar — carga reposiciones como mercadería en camino
app.post('/api/pi/confirmar', requireToken, (req, res) => {
  const { supplier, expected_date, products } = req.body;
  if (!products?.length) return res.status(400).json({ error: 'Sin productos' });

  const reposiciones = products.filter(p => p.is_reposition && p.sku && p.qty > 0);
  if (!reposiciones.length) return res.status(400).json({ error: 'Sin reposiciones para cargar' });

  const compras = loadCompras();
  const nueva = {
    id: Date.now().toString(),
    created_at: new Date().toISOString(),
    supplier: supplier || 'China',
    expected_date: expected_date || '',
    notes: `Importado desde PI - ${reposiciones.length} productos`,
    items: reposiciones.map(p => ({ sku: p.sku, qty: p.qty })),
  };
  compras.push(nueva);
  saveCompras(compras);
  console.log(`[pi/confirmar] ${reposiciones.length} reposiciones cargadas en previsiones`);
  res.json({ ok: true, compra: nueva, loaded: reposiciones.length });
});

// ── Planificador de compras ──

app.get('/api/planificador', requireToken, async (req, res) => {
  try {
    const leadDaysChina = parseInt(req.query.lead_days) || 120;
    const leadDaysBrasil = parseInt(req.query.lead_days_brasil) || 30;
    const growthPct = parseFloat(req.query.growth) || 30;
    const growthFactor = 1 + growthPct / 100;

    // Categorías de muebles (Brasil, 30 días)
    const brasilKeywords = ['mobiliario', 'mueble', 'ropero', 'placard', 'mesa de luz', 'rack para tv', 'escritorio madesa', 'escritorio appunto'];

    function isBrasil(categ, name) {
      const c = (categ || '').toLowerCase();
      const n = (name || '').toLowerCase();
      return brasilKeywords.some(k => c.includes(k) || n.includes(k));
    }

    // Dos meses objetivo según origen
    const targetDateChina = new Date();
    targetDateChina.setDate(targetDateChina.getDate() + leadDaysChina);
    const targetDateBrasil = new Date();
    targetDateBrasil.setDate(targetDateBrasil.getDate() + leadDaysBrasil);

    const targetMonthChina = targetDateChina.getMonth() + 1;
    const targetYearChina = targetDateChina.getFullYear();
    const targetKeyChina = `${targetYearChina}-${pad(targetMonthChina)}`;
    const compKeyChina = `${targetYearChina - 1}-${pad(targetMonthChina)}`;

    const targetMonthBrasil = targetDateBrasil.getMonth() + 1;
    const targetYearBrasil = targetDateBrasil.getFullYear();
    const targetKeyBrasil = `${targetYearBrasil}-${pad(targetMonthBrasil)}`;
    const compKeyBrasil = `${targetYearBrasil - 1}-${pad(targetMonthBrasil)}`;

    const monthLabels = ['','Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

    // Traer ventas de TODOS los meses por producto desde Odoo — separado por canal
    const uid = await odooAuth();
    if (!uid) return res.status(500).json({ error: 'No se pudo autenticar con Odoo' });

    const monthNames = { enero:'01',febrero:'02',marzo:'03',abril:'04',mayo:'05',junio:'06',julio:'07',agosto:'08',septiembre:'09',setiembre:'09',octubre:'10',noviembre:'11',diciembre:'12',
      january:'01',february:'02',march:'03',april:'04',may:'05',june:'06',july:'07',august:'08',september:'09',october:'10',november:'11',december:'12' };

    function parseMonth(str) {
      const parts = (str || '').toLowerCase().split(' ');
      if (parts.length !== 2) return null;
      const mm = monthNames[parts[0]];
      return mm ? parts[1] + '-' + mm : null;
    }

    // Queries: total + por canal en paralelo
    // WhatsApp: salesman_id 8 (Atención al cliente / Giorgina), 9 (Tatiana), 14 (Rodrigo), 15 (Agustin)
    const [allSales, mlSales, maySales, wppSales, posSales] = await Promise.all([
      odooCall('/xmlrpc/2/object', 'execute_kw', [
        ODOO_DB, uid, ODOO_API_KEY, 'sale.order.line', 'read_group',
        [[['state', 'in', ['sale', 'done']]]],
        { fields: ['product_id', 'product_uom_qty', 'create_date'], groupby: ['product_id', 'create_date:month'], lazy: false }
      ]),
      odooCall('/xmlrpc/2/object', 'execute_kw', [
        ODOO_DB, uid, ODOO_API_KEY, 'sale.order.line', 'read_group',
        [[['state', 'in', ['sale', 'done']], ['salesman_id', '=', 2]]],
        { fields: ['product_id', 'product_uom_qty', 'create_date'], groupby: ['product_id', 'create_date:month'], lazy: false }
      ]),
      odooCall('/xmlrpc/2/object', 'execute_kw', [
        ODOO_DB, uid, ODOO_API_KEY, 'sale.order.line', 'read_group',
        [[['state', 'in', ['sale', 'done']], ['salesman_id', 'in', [17, 18]]]],
        { fields: ['product_id', 'product_uom_qty', 'create_date'], groupby: ['product_id', 'create_date:month'], lazy: false }
      ]),
      odooCall('/xmlrpc/2/object', 'execute_kw', [
        ODOO_DB, uid, ODOO_API_KEY, 'sale.order.line', 'read_group',
        [[['state', 'in', ['sale', 'done']], ['salesman_id', 'in', [8, 9, 14, 15]]]],
        { fields: ['product_id', 'product_uom_qty', 'create_date'], groupby: ['product_id', 'create_date:month'], lazy: false }
      ]),
      odooCall('/xmlrpc/2/object', 'execute_kw', [
        ODOO_DB, uid, ODOO_API_KEY, 'pos.order.line', 'read_group',
        [[]],
        { fields: ['product_id', 'qty', 'create_date'], groupby: ['product_id', 'create_date:month'], lazy: false }
      ]),
    ]);

    // Build: product_id -> { 'YYYY-MM': qty } (total, para cálculos)
    const salesByProdMonth = {};
    const allMonths = new Set();
    for (const r of allSales) {
      if (!r.product_id) continue;
      const pid = r.product_id[0];
      const key = parseMonth(r['create_date:month']);
      if (!key) continue;
      allMonths.add(key);
      if (!salesByProdMonth[pid]) salesByProdMonth[pid] = {};
      salesByProdMonth[pid][key] = (salesByProdMonth[pid][key] || 0) + (r.product_uom_qty || 0);
    }

    // Build: sales_by_channel por producto (para desglose)
    const salesByChannel = {}; // pid -> { ml: {}, mayorista: {}, local: {}, whatsapp: {} }
    function processPlanChannelSales(data, channel, qtyField) {
      for (const r of data) {
        if (!r.product_id) continue;
        const pid = r.product_id[0];
        const qty = r[qtyField] || 0;
        const key = parseMonth(r['create_date:month']);
        if (!key) continue;
        allMonths.add(key);
        if (!salesByChannel[pid]) salesByChannel[pid] = { ml: {}, mayorista: {}, local: {}, whatsapp: {} };
        salesByChannel[pid][channel][key] = (salesByChannel[pid][channel][key] || 0) + qty;
      }
    }

    processPlanChannelSales(mlSales, 'ml', 'product_uom_qty');
    processPlanChannelSales(maySales, 'mayorista', 'product_uom_qty');
    processPlanChannelSales(wppSales, 'whatsapp', 'product_uom_qty');
    processPlanChannelSales(posSales, 'local', 'qty');

    // ── Enriquecer con historial de Zureo ──
    // Zureo tiene data 2023-08 a 2025-08 que Odoo puede no tener
    if (zureoData) {
      const products = await getOdooProducts(false);
      // Build SKU → product_id map
      const skuToPid = {};
      for (const p of products) {
        if (p.default_code) {
          skuToPid[p.default_code.trim()] = p.id;
          // Also map base code (without -BLA, -NEG suffix)
          const base = p.default_code.trim().replace(/-[A-Z]{2,}$/, '');
          if (!skuToPid[base]) skuToPid[base] = p.id;
        }
      }
      // Also use zureo→odoo mapping
      for (const [zureoCode, mapping] of Object.entries(zureoOdooMap)) {
        if (mapping.odooSku && skuToPid[mapping.odooSku]) {
          skuToPid[zureoCode] = skuToPid[mapping.odooSku];
        }
      }

      let zureoAdded = 0;
      for (const [code, item] of Object.entries(zureoData.items)) {
        const pid = skuToPid[code];
        if (!pid) continue;
        if (!salesByProdMonth[pid]) salesByProdMonth[pid] = {};
        for (const [month, data] of Object.entries(item.months)) {
          // Solo agregar meses que Odoo NO tiene (no sobreescribir)
          if (!salesByProdMonth[pid][month]) {
            salesByProdMonth[pid][month] = data.qty;
            allMonths.add(month);
            zureoAdded++;
          }
        }
      }
      console.log(`[planificador] zureo: ${zureoAdded} meses agregados al historial`);
    }

    const sortedMonths = [...allMonths].sort();

    // Productos de Odoo
    const products = await getOdooProducts(false);
    const mlMap = buildMlSkuMap();
    const skipNames = ['mercado envios', 'self_service', 'drop_off', 'cross_docking', 'fulfillment', 'soydelivery', 'soy delivery', 'standard delivery', 'default fenicio', 'flete', 'costo de envio', 'retiro por local', 'envío', 'radio e instalacion'];

    // Compras en camino
    const compras = loadCompras();
    const incomingBySku = {};
    for (const c of compras) {
      for (const it of (c.items || [])) {
        if (!it.sku) continue;
        if (!incomingBySku[it.sku]) incomingBySku[it.sku] = 0;
        incomingBySku[it.sku] += parseInt(it.qty) || 0;
      }
    }

    // Pack BOM: descomponer ventas de packs a componentes unitarios
    const packBom = loadPackBom();
    const packDemandBySku = {}; // SKU unitario → qty extra por ventas de packs
    for (const [packSku, pack] of Object.entries(packBom)) {
      // Buscar ventas del pack en salesByProdMonth
      const packProduct = products.find(p => (p.default_code || '') === packSku);
      if (!packProduct) continue;
      const packSales = salesByProdMonth[packProduct.id] || {};
      const packTotal = sortedMonths.reduce((s, m) => s + (packSales[m] || 0), 0);
      if (packTotal <= 0) continue;
      // Distribuir demanda a componentes
      for (const comp of pack.components) {
        if (comp.sku) {
          packDemandBySku[comp.sku] = (packDemandBySku[comp.sku] || 0) + packTotal * comp.qty;
        }
      }
    }

    // Productos ya pedidos (órdenes en estado "pedida")
    const pedidosBySku = getProductosPedidos();

    // Calcular ABC: revenue últimos 6 meses
    const last6 = sortedMonths.slice(-6);
    const revenueByProd = {};
    let totalRevenue = 0;

    const items = [];
    for (const p of products) {
      const nameLower = (p.name || '').toLowerCase();
      if (skipNames.some(s => nameLower.includes(s))) continue;
      if (p.type === 'service') continue;

      const sku = p.default_code || '';
      // Filtrar packs: no sugerir pedir packs, solo unitarios
      if (packBom[sku.trim()]) continue;

      const ml = mlMap[sku.trim()] || null;
      const categ = Array.isArray(p.categ_id) ? p.categ_id[1] : (p.categ_id || '');
      const sales = salesByProdMonth[p.id] || {};
      const stock = p.qty_available || 0;
      const incoming = incomingBySku[sku.trim()] || 0;
      const pedido = pedidosBySku[sku.trim()] || 0;
      const cost = p.standard_price || 0;
      const price = p.list_price || 0;

      // Determinar origen
      const origen = isBrasil(categ, p.name) ? 'Brasil' : 'China';
      const leadDays = origen === 'Brasil' ? leadDaysBrasil : leadDaysChina;
      const compKey = origen === 'Brasil' ? compKeyBrasil : compKeyChina;
      const targetKey = origen === 'Brasil' ? targetKeyBrasil : targetKeyChina;
      const targetLabel = origen === 'Brasil'
        ? monthLabels[targetMonthBrasil] + ' ' + targetYearBrasil
        : monthLabels[targetMonthChina] + ' ' + targetYearChina;
      const compLabel = origen === 'Brasil'
        ? monthLabels[targetMonthBrasil] + ' ' + (targetYearBrasil - 1)
        : monthLabels[targetMonthChina] + ' ' + (targetYearChina - 1);

      // Revenue últimos 6 meses
      const rev6m = last6.reduce((s, m) => s + (sales[m] || 0), 0) * price;
      revenueByProd[p.id] = rev6m;
      totalRevenue += rev6m;

      // Ventas del mes objetivo año pasado
      const soldCompMonth = sales[compKey] || 0;

      // Promedio mensual últimos 6 meses — solo dividir por meses con ventas
      // Ventas unitarias + ventas via packs descompuestas
      const soldDirect = last6.reduce((s, m) => s + (sales[m] || 0), 0);
      const soldViaPacks = packDemandBySku[sku.trim()] || 0;
      const sold6m = soldDirect + Math.round(soldViaPacks * last6.length / Math.max(sortedMonths.length, 1));
      const monthsWithSalesCount = last6.filter(m => (sales[m] || 0) > 0).length;
      const avgMonth = monthsWithSalesCount > 0 ? sold6m / monthsWithSalesCount : 0;

      // Estacionalidad: mirar los últimos 3 meses para ver si el producto está activo
      const last3 = sortedMonths.slice(-3);
      const sold3m = last3.reduce((s, m) => s + (sales[m] || 0), 0);
      const last3WithSales = last3.filter(m => (sales[m] || 0) > 0).length;
      const avgLast3 = last3WithSales > 0 ? sold3m / last3WithSales : 0;

      // Detectar si es estacional / inactivo:
      // Si no vendió nada en los últimos 3 meses → no pedir (producto estacional fuera de temporada)
      // Si vendió muy poco (<20% del promedio general) → reducir pedido
      let seasonalFactor = 1;
      let seasonalNote = '';
      if (avgMonth > 0 && sold3m === 0) {
        seasonalFactor = 0; // no se está vendiendo, no pedir
        seasonalNote = 'Sin ventas 3 meses - no pedir';
      } else if (avgMonth > 5 && avgLast3 < avgMonth * 0.2) {
        seasonalFactor = 0.3; // se vende muy poco vs promedio → reducir
        seasonalNote = 'Temporada baja - reducido';
      } else if (avgLast3 > avgMonth * 1.5) {
        seasonalFactor = 1.2; // está vendiendo más que lo normal → subir un poco
        seasonalNote = 'Temporada alta';
      }

      // Estimación: usar el mayor entre (mes año pasado × crecimiento) y (promedio últimos 3 × crecimiento)
      // Estimación: si tengo dato del mismo mes año pasado, priorizar ese.
      // Solo usar promedio reciente si no hay dato del año pasado.
      const estByCompMonth = Math.ceil(soldCompMonth * growthFactor);
      const estByRecent = Math.ceil(avgLast3 * growthFactor);
      let baseEstimated;
      if (soldCompMonth > 0) {
        // Tengo dato del año pasado: usarlo como base principal
        // Si el promedio reciente es similar (±50%), promediar. Si no, confiar en el año pasado.
        if (estByRecent > 0 && estByRecent < estByCompMonth * 1.5 && estByRecent > estByCompMonth * 0.5) {
          baseEstimated = Math.ceil((estByCompMonth + estByRecent) / 2);
        } else {
          baseEstimated = estByCompMonth;
        }
      } else {
        baseEstimated = estByRecent;
      }
      const estimated = Math.ceil(baseEstimated * seasonalFactor);

      // Stock de seguridad: 20% de la estimación (capped, no basado en stddev que da números locos con estacionalidad)
      const safetyStock = seasonalFactor > 0 ? Math.ceil(estimated * 0.2) : 0;

      // Faltante
      const available = stock + incoming + pedido;
      const needed = estimated + safetyStock;
      const gap = Math.max(0, needed - available);

      // Días de stock al ritmo actual
      const dailyRate = avgMonth / 30;
      const daysOfStock = dailyRate > 0 ? Math.round(available / dailyRate) : null;

      // Quiebre: ¿se queda sin stock antes de que llegue el contenedor?
      const willBreak = daysOfStock !== null && daysOfStock < leadDays;

      items.push({
        id: p.id,
        name: p.name,
        sku,
        categ: Array.isArray(p.categ_id) ? p.categ_id[1] : (p.categ_id || ''),
        cost,
        price,
        stock,
        incoming,
        pedido,
        available,
        ml_thumbnail: ml ? ml.thumbnail : null,
        ml_status: ml ? ml.status : null,
        sold_comp_month: soldCompMonth,
        estimated,
        safety_stock: safetyStock,
        needed,
        gap,
        avg_month: Math.round(avgMonth * 10) / 10,
        days_of_stock: daysOfStock,
        will_break: willBreak,
        origen,
        lead_days: leadDays,
        target_label: targetLabel,
        comp_label: compLabel,
        seasonal_note: seasonalNote,
        seasonal_factor: seasonalFactor,
        avg_last_3: Math.round(avgLast3 * 10) / 10,
        max_month_6m: Math.max(...last6.map(m => sales[m] || 0)),
        sold_6m: sold6m,
        revenue_6m: Math.round(rev6m),
        sales_by_month: sales,
        sales_by_channel: salesByChannel[p.id] || { ml: {}, mayorista: {}, local: {} },
        abc: null, // se calcula abajo
      });
    }

    // Calcular canal principal de cada item
    for (const item of items) {
      const ch = item.sales_by_channel;
      const totals = {
        ml: Object.values(ch.ml || {}).reduce((s,v) => s + v, 0),
        mayorista: Object.values(ch.mayorista || {}).reduce((s,v) => s + v, 0),
        local: Object.values(ch.local || {}).reduce((s,v) => s + v, 0),
        whatsapp: Object.values(ch.whatsapp || {}).reduce((s,v) => s + v, 0),
      };
      const maxCh = Object.entries(totals).sort((a,b) => b[1] - a[1]);
      item.main_channel = maxCh[0][1] > 0 ? maxCh[0][0] : null;
      item.channel_totals = totals;
    }

    // ABC classification
    items.sort((a, b) => b.revenue_6m - a.revenue_6m);
    let cumRev = 0;
    for (const item of items) {
      cumRev += item.revenue_6m;
      const pct = totalRevenue > 0 ? cumRev / totalRevenue : 0;
      item.abc = pct <= 0.8 ? 'A' : pct <= 0.95 ? 'B' : 'C';
    }

    // XYZ classification (estabilidad de demanda)
    for (const item of items) {
      const monthlyQtys = last6.map(m => item.sales_by_month[m] || 0);
      const avg = monthlyQtys.reduce((s, v) => s + v, 0) / last6.length;
      const monthsWithSales = monthlyQtys.filter(v => v > 0).length;
      const maxMonth = Math.max(...monthlyQtys);

      if (avg > 0) {
        const variance = monthlyQtys.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / last6.length;
        const stdDev = Math.sqrt(variance);
        const cv = stdDev / avg; // coeficiente de variación
        item.xyz = cv < 0.5 ? 'X' : cv < 1.0 ? 'Y' : 'Z';
        item.cv = Math.round(cv * 100) / 100;
      } else {
        item.xyz = 'Z';
        item.cv = null;
      }
      item.abc_xyz = item.abc + item.xyz;
      item.months_with_sales = monthsWithSales;
      item.max_month = maxMonth;
    }

    // Ordenar por gap descendente (los que más necesitás primero)
    items.sort((a, b) => b.gap - a.gap);

    // KPIs
    const totalGap = items.reduce((s, i) => s + i.gap, 0);
    const totalInversion = items.reduce((s, i) => s + i.gap * i.cost, 0);
    const willBreakCount = items.filter(i => i.will_break && i.avg_month > 0).length;
    const aItems = items.filter(i => i.abc === 'A').length;

    const chinaLabel = monthLabels[targetMonthChina] + ' ' + targetYearChina;
    const brasilLabel = monthLabels[targetMonthBrasil] + ' ' + targetYearBrasil;
    const chinaItems = items.filter(i => i.origen === 'China');
    const brasilItems = items.filter(i => i.origen === 'Brasil');

    // ── Por categoría (proveedor): agrupar y completar ──
    // Si hay productos con gap en una categoría, sugerir también otros de esa categoría
    // que tengan ventas pero poco stock, para completar un contenedor
    const byCategory = {};
    for (const item of items) {
      const cat = getCategoryGroup(item.name);
      if (!byCategory[cat]) byCategory[cat] = { withGap: [], complement: [] };
      if (item.gap > 0 && item.avg_month > 0 && item.seasonal_factor > 0) {
        byCategory[cat].withGap.push(item);
      } else if (item.avg_month > 0 && item.stock < item.avg_month * 3) {
        // Tiene ventas y menos de 3 meses de stock → candidato a complementar
        byCategory[cat].complement.push(item);
      }
    }

    // Para cada categoría con gap, agregar complementos
    const categoryGroups = [];
    for (const [cat, data] of Object.entries(byCategory)) {
      if (!data.withGap.length) continue;
      categoryGroups.push({
        category: cat,
        withGap: data.withGap.sort((a,b) => b.gap - a.gap),
        complement: data.complement.sort((a,b) => b.avg_month - a.avg_month).slice(0, 20),
        totalGapCbm: 0, // se calcula en contenedores
      });
    }

    // ── Reposición urgente: available (stock + incoming + pedido) ≤ 0 con ventas recientes ──
    const reposicion = items.filter(i => i.available <= 0 && i.avg_month > 0 && i.seasonal_factor > 0)
      .sort((a, b) => b.avg_month - a.avg_month)
      .map(i => ({ ...i, tipo: 'reposicion' }));

    // ── Compra zafral: productos vendidos en próximos 120 días año pasado, sin disponible hoy ──
    const now = new Date();
    const zafralItems = [];
    for (const item of items) {
      if (item.available > 5) continue; // ya tiene stock + incoming + pedido
      // Mirar ventas de los próximos 4 meses del año pasado
      let zafralQty = 0, zafralTotal = 0;
      const zafralMonths = [];
      for (let i = 0; i < 4; i++) {
        const d = new Date(now.getFullYear() - 1, now.getMonth() + i, 1);
        const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
        const sold = item.sales_by_month[key] || 0;
        if (sold > 0) {
          zafralQty += sold;
          zafralTotal += sold * item.price;
          zafralMonths.push({ month: key, qty: sold });
        }
      }
      if (zafralQty >= 5) { // vendió al menos 5 en esos 4 meses
        zafralItems.push({
          ...item,
          tipo: 'zafral',
          zafral_qty: zafralQty,
          zafral_total: Math.round(zafralTotal),
          zafral_months: zafralMonths,
          zafral_avg: Math.round(zafralQty / 4),
        });
      }
    }
    zafralItems.sort((a, b) => b.zafral_total - a.zafral_total);

    const compLabel = monthLabels[now.getMonth() + 1] + '-' + monthLabels[Math.min(12, now.getMonth() + 4)] + ' ' + (now.getFullYear() - 1);

    res.json({
      config: {
        lead_days_china: leadDaysChina, lead_days_brasil: leadDaysBrasil, growth_pct: growthPct,
        china: { target: targetKeyChina, comp: compKeyChina, label: chinaLabel },
        brasil: { target: targetKeyBrasil, comp: compKeyBrasil, label: brasilLabel },
        comp_label: compLabel,
      },
      kpis: { total_items: items.length, total_gap: totalGap, total_inversion: Math.round(totalInversion), will_break: willBreakCount, a_items: aItems, china_count: chinaItems.length, brasil_count: brasilItems.length },
      items,
      categoryGroups,
      reposicion,
      zafral: zafralItems,
      all_months: sortedMonths,
    });
  } catch(e) {
    console.error('[planificador]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Órdenes de compra ──
const ORDENES_FILE = path.join(__dirname, 'data', 'ordenes_compra.json');
function loadOrdenes() { try { return fs.existsSync(ORDENES_FILE) ? JSON.parse(fs.readFileSync(ORDENES_FILE, 'utf8')) : []; } catch { return []; } }
function saveOrdenes(data) { fs.writeFileSync(ORDENES_FILE, JSON.stringify(data, null, 2), 'utf8'); }

app.get('/api/ordenes-compra', requireToken, (req, res) => {
  let ihomeMap = {};
  try { if (fs.existsSync(path.join(__dirname, 'data', 'ihome_mapping.json'))) ihomeMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'ihome_mapping.json'), 'utf8')); } catch {}

  const ordenes = loadOrdenes().map(o => {
    // Enrich items with CBM, FOB, thumb if missing
    o.items = (o.items || []).map(item => {
      const ih = ihomeMap[item.sku] || {};
      const ml = cachedStock.find(s => s.sku === item.sku);
      return {
        ...item,
        cbm: item.cbm || Math.round((ih.cbm_per_unit || 0) * (item.qty || 0) * 100) / 100 || 0,
        fob: item.fob || ih.fob || 0,
        thumb: item.thumb || ml?.thumbnail || '',
      };
    });
    o.total_cbm = Math.round(o.items.reduce((s, i) => s + (i.cbm || 0), 0) * 100) / 100;
    o.total_fob = Math.round(o.items.reduce((s, i) => s + (i.fob || 0) * (i.qty || 0), 0) * 100) / 100;
    o.total_qty = o.items.reduce((s, i) => s + (i.qty || 0), 0);
    return o;
  });
  res.json(ordenes);
});

app.post('/api/ordenes-compra', requireToken, (req, res) => {
  const { items, notes, status: reqStatus } = req.body;
  if (!items?.length) return res.status(400).json({ error: 'Sin items' });
  let ihomeMap = {};
  try { if (fs.existsSync(IHOME_MAP_FILE)) ihomeMap = JSON.parse(fs.readFileSync(IHOME_MAP_FILE, 'utf8')); } catch {}
  const ordenes = loadOrdenes();
  const enrichedItems = items.map(i => {
    const m = ihomeMap[i.sku] || {};
    return { sku: i.sku, name: i.name, qty: i.qty, origen: i.origen, thumb: i.thumb, cbm_per_unit: m.cbm_per_unit || 0, cbm_total: Math.round((m.cbm_per_unit || 0) * (i.qty || 0) * 1000) / 1000, ihome: m.ihome || '', fob: m.fob || 0 };
  });
  const totalCbm = Math.round(enrichedItems.reduce((s, i) => s + i.cbm_total, 0) * 100) / 100;
  const totalFob = Math.round(enrichedItems.reduce((s, i) => s + (i.fob * i.qty), 0) * 100) / 100;
  const orden = {
    id: Date.now().toString(),
    created_at: new Date().toISOString(),
    status: reqStatus || 'pedida',
    notes: notes || '',
    items: enrichedItems,
    total_qty: items.reduce((s, i) => s + (i.qty || 0), 0),
    total_cbm: totalCbm,
    total_fob: totalFob,
  };
  ordenes.push(orden);
  saveOrdenes(ordenes);
  console.log(`[ordenes] nueva orden: ${orden.id} - ${orden.items.length} productos, ${orden.total_qty} uds`);
  res.json(orden);
});

app.post('/api/ordenes-compra/:id/confirmar', requireToken, (req, res) => {
  const { expected_date } = req.body;
  const ordenes = loadOrdenes();
  const orden = ordenes.find(o => o.id === req.params.id);
  if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });
  if (orden.status === 'confirmada') return res.status(400).json({ error: 'Ya confirmada' });

  orden.status = 'confirmada';
  orden.confirmed_at = new Date().toISOString();
  orden.expected_date = expected_date || '';
  saveOrdenes(ordenes);

  // Cargar en Previsiones como mercadería en camino
  const compras = loadCompras();
  compras.push({
    id: 'ord-' + orden.id,
    created_at: new Date().toISOString(),
    supplier: 'Orden #' + orden.id.slice(-6),
    expected_date: expected_date || '',
    notes: 'Confirmada desde orden de compra',
    items: orden.items.filter(i => i.sku && i.qty > 0).map(i => ({ sku: i.sku, qty: i.qty })),
  });
  saveCompras(compras);
  console.log(`[ordenes] orden ${orden.id} confirmada → previsiones`);
  res.json(orden);
});

app.delete('/api/ordenes-compra/:id', requireToken, (req, res) => {
  saveOrdenes(loadOrdenes().filter(o => o.id !== req.params.id));
  res.json({ ok: true });
});

// Edit items within an order
app.put('/api/ordenes-compra/:id/item', requireToken, (req, res) => {
  const { index, qty } = req.body;
  const ordenes = loadOrdenes();
  const orden = ordenes.find(o => o.id === req.params.id);
  if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });
  if (index >= 0 && index < orden.items.length) {
    if (qty <= 0) {
      orden.items.splice(index, 1);
    } else {
      orden.items[index].qty = qty;
    }
    orden.total_qty = orden.items.reduce((s, i) => s + (i.qty || 0), 0);
    saveOrdenes(ordenes);
  }
  res.json({ ok: true });
});

app.delete('/api/ordenes-compra/:id/item', requireToken, (req, res) => {
  const { index } = req.body;
  const ordenes = loadOrdenes();
  const orden = ordenes.find(o => o.id === req.params.id);
  if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });
  if (index >= 0 && index < orden.items.length) {
    orden.items.splice(index, 1);
    orden.total_qty = orden.items.reduce((s, i) => s + (i.qty || 0), 0);
    saveOrdenes(ordenes);
  }
  res.json({ ok: true });
});

app.post('/api/ordenes-compra/:id/item', requireToken, (req, res) => {
  const { sku, qty } = req.body;
  const ordenes = loadOrdenes();
  const orden = ordenes.find(o => o.id === req.params.id);
  if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });

  // Look up product info
  const prod = (odooCache || []).find(p => (p.default_code || '').trim() === sku);
  const name = prod?.name || sku;
  let ihomeMap = {};
  try { if (fs.existsSync(path.join(__dirname, 'data', 'ihome_mapping.json'))) ihomeMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'ihome_mapping.json'), 'utf8')); } catch {}
  const ih = ihomeMap[sku] || {};
  const mlItem = cachedStock.find(s => s.sku === sku);

  const existing = orden.items.find(i => i.sku === sku);
  if (existing) {
    existing.qty += qty;
    existing.cbm = Math.round((ih.cbm_per_unit || 0) * existing.qty * 100) / 100;
  } else {
    orden.items.push({
      sku, name, qty,
      fob: ih.fob || 0,
      cbm: Math.round((ih.cbm_per_unit || 0) * qty * 100) / 100,
      thumb: mlItem?.thumbnail || '',
    });
  }
  orden.total_qty = orden.items.reduce((s, i) => s + (i.qty || 0), 0);
  orden.total_cbm = Math.round(orden.items.reduce((s, i) => s + (i.cbm || 0), 0) * 100) / 100;
  orden.total_fob = Math.round(orden.items.reduce((s, i) => s + (i.fob || 0) * (i.qty || 0), 0) * 100) / 100;
  saveOrdenes(ordenes);
  res.json({ ok: true });
});

// ── Orden draft (auto-guardado) ──
const DRAFT_FILE = path.join(__dirname, 'data', 'orden_draft.json');

function loadDraft() {
  try { return fs.existsSync(DRAFT_FILE) ? JSON.parse(fs.readFileSync(DRAFT_FILE, 'utf8')) : null; } catch { return null; }
}
function saveDraft(data) {
  fs.writeFileSync(DRAFT_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function generateOrderNumber() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  // Count existing orders this month
  const ordenes = loadOrdenes();
  const thisMonth = ordenes.filter(o => o.number && o.number.startsWith(`OC-${y}${m}`)).length;
  const seq = String(thisMonth + 1).padStart(3, '0');
  return `OC-${y}${m}-${seq}`;
}

app.get('/api/orden-draft', requireToken, (req, res) => {
  const draft = loadDraft();
  if (draft) res.json(draft);
  else res.json({ id: null, number: null, items: [] });
});

app.post('/api/orden-draft', requireToken, (req, res) => {
  const { id, items } = req.body;
  let draft = loadDraft();
  if (!draft || !draft.id || (id && draft.id !== id)) {
    // New draft
    const newId = 'draft-' + Date.now();
    const number = generateOrderNumber();
    draft = { id: newId, number, items: items || [], created: new Date().toISOString(), updated: new Date().toISOString() };
  } else {
    draft.items = items || [];
    draft.updated = new Date().toISOString();
  }
  saveDraft(draft);
  res.json({ id: draft.id, number: draft.number });
});

app.delete('/api/orden-draft', requireToken, (req, res) => {
  try { fs.unlinkSync(DRAFT_FILE); } catch {}
  res.json({ ok: true });
});

// Productos ya pedidos (para descontar del planificador)
function getProductosPedidos() {
  const ordenes = loadOrdenes().filter(o => o.status === 'pedida');
  const pedidos = {};
  for (const o of ordenes) {
    for (const i of o.items) {
      pedidos[i.sku] = (pedidos[i.sku] || 0) + (i.qty || 0);
    }
  }
  return pedidos;
}

// ── Objetivos mensuales ──

app.get('/api/objetivos', requireToken, (req, res) => {
  const growthPct = parseFloat(req.query.growth) || 30;
  const growthFactor = 1 + growthPct / 100;
  const canal = req.query.canal || 'total'; // total, ml, mayorista, local

  try {
    // Load data sources
    const zureoTotal = zureoData?.monthly || {};
    const CANALES_FILE = path.join(__dirname, 'data', 'zureo_canales.json');
    let canales = {};
    try { if (fs.existsSync(CANALES_FILE)) canales = JSON.parse(fs.readFileSync(CANALES_FILE, 'utf8')); } catch {}

    // Build unified monthly based on selected channel
    function getMonthly(key) {
      if (canal === 'mayorista') {
        const d = canales.mayorista?.[key];
        return d ? { qty: d.qty, total: d.total } : null;
      }
      if (canal === 'local') {
        const d = canales.local?.[key];
        return d ? { qty: d.qty, total: d.total } : null;
      }
      if (canal === 'ml') {
        // ML only: total minus local minus mayorista
        const t = zureoTotal[key];
        const l = canales.local?.[key];
        const m = canales.mayorista?.[key];
        if (!t) {
          // Try from monthlyStats (ML direct)
          const ms = monthlyStats[key];
          return ms ? { qty: ms.count, total: ms.revenue } : null;
        }
        const mlTotal = t.total - (l?.total || 0) - (m?.total || 0);
        const mlQty = t.qty - (l?.qty || 0) - (m?.qty || 0);
        return { qty: Math.max(0, mlQty), total: Math.max(0, mlTotal) };
      }
      // total: use historico (zureo + ml)
      const z = zureoTotal[key];
      if (z) return { qty: z.qty, total: z.total };
      const ms = monthlyStats[key];
      if (ms) return { qty: ms.count, total: ms.revenue };
      return null;
    }

    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();
    const currentDay = now.getDate();
    const daysInMonth = new Date(currentYear, currentMonth, 0).getDate();
    const monthNames = ['','Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

    const months = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(currentYear, currentMonth - 1 + i, 1);
      const m = d.getMonth() + 1;
      const y = d.getFullYear();
      const key = `${y}-${pad(m)}`;
      const keyPrev1 = `${y - 1}-${pad(m)}`;
      const keyPrev2 = `${y - 2}-${pad(m)}`;

      const prev1 = getMonthly(keyPrev1);
      const prev2 = getMonthly(keyPrev2);
      const actual = getMonthly(key);

      let base = 0;
      if (prev1) base = prev1.total;
      else if (prev2) base = prev2.total;
      const objetivo = Math.round(base * growthFactor);

      let progreso = null, proyeccion = null;
      const isCurrent = i === 0;
      if (isCurrent && actual && objetivo > 0) {
        progreso = Math.round(actual.total / objetivo * 100);
        proyeccion = Math.round(actual.total / currentDay * daysInMonth);
      }

      months.push({
        key, label: monthNames[m] + ' ' + y, month: m, year: y,
        prev2: prev2 ? { qty: prev2.qty, total: Math.round(prev2.total), year: y - 2 } : null,
        prev1: prev1 ? { qty: prev1.qty, total: Math.round(prev1.total), year: y - 1 } : null,
        actual: actual ? { qty: actual.qty, total: Math.round(actual.total) } : null,
        objetivo, progreso, proyeccion,
        is_current: isCurrent, days_passed: isCurrent ? currentDay : null, days_total: daysInMonth,
      });
    }

    // Channel summary for current view
    const channelSummary = {};
    if (canal === 'total') {
      const curKey = `${currentYear}-${pad(currentMonth)}`;
      for (const ch of ['ml','mayorista','local']) {
        const orig = req.query.canal;
        // Quick calc for each channel this month
        let val = null;
        if (ch === 'mayorista') val = canales.mayorista?.[curKey];
        else if (ch === 'local') val = canales.local?.[curKey];
        else {
          const t = zureoTotal[curKey] || (monthlyStats[curKey] ? { qty: monthlyStats[curKey].count, total: monthlyStats[curKey].revenue } : null);
          const l = canales.local?.[curKey];
          const m2 = canales.mayorista?.[curKey];
          if (t) val = { total: t.total - (l?.total || 0) - (m2?.total || 0) };
        }
        channelSummary[ch] = val ? Math.round(val.total) : 0;
      }
    }

    res.json({ growth_pct: growthPct, canal, months, channelSummary });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Pack BOM (lista de materiales) ──
const PACK_BOM_FILE = path.join(__dirname, 'data', 'pack_bom.json');
function loadPackBom() {
  try { return fs.existsSync(PACK_BOM_FILE) ? JSON.parse(fs.readFileSync(PACK_BOM_FILE, 'utf8')) : {}; } catch { return {}; }
}
function isPackSku(sku) {
  const bom = loadPackBom();
  return !!bom[sku];
}

// ── IHOME Mapping + Product Images ──
const IHOME_MAP_FILE = path.join(__dirname, 'data', 'ihome_mapping.json');
const PRODUCT_IMAGES_DIR = path.join(__dirname, 'data', 'product_images');

// ── Armado de contenedores ──

// Productos grandes → contenedor dedicado
const LARGE_KEYWORDS = ['biciclet', 'caminador', 'spinning', 'silla escritorio', 'silla gamer', 'silla gaming', 'colchon', 'mesa futbol', 'soccer table', 'cinta caminadora'];

function isLargeProduct(name) {
  const n = (name || '').toLowerCase();
  return LARGE_KEYWORDS.some(k => n.includes(k));
}

// Categorías similares que van juntas
const CATEGORY_GROUPS = {
  'iluminacion': ['lampara', 'aplique', 'luz led', 'tira led', 'guia de luces', 'foco', 'bombita', 'dimmer', 'cable sal'],
  'decoracion': ['cuadro', 'espejo', 'reloj', 'vela', 'portarretrato', 'marco', 'triptico'],
  'hogar': ['organizador', 'canasto', 'cesto', 'tender', 'cortina', 'alfombra', 'tapete', 'manta'],
  'cocina': ['jarra', 'tarro', 'hermetico', 'recipiente', 'tabla', 'cuchillo'],
  'exterior': ['carpa', 'reposera', 'silla plegable', 'hamaca', 'camping', 'sombrilla'],
  'deporte': ['mancuerna', 'pesa', 'yoga', 'gym', 'fitness', 'inflador'],
  'jardin': ['enredadera', 'planta artificial', 'maceta', 'jardin vertical'],
  'bano': ['baño', 'jabonera', 'toallero', 'cortina baño', 'dispensador'],
  'musica': ['guitarra', 'ukelele', 'soporte guitarra', 'atril'],
};

function getCategoryGroup(name) {
  const n = (name || '').toLowerCase();
  for (const [group, keywords] of Object.entries(CATEGORY_GROUPS)) {
    if (keywords.some(k => n.includes(k))) return group;
  }
  return 'general';
}

app.post('/api/orden/contenedores', requireToken, (req, res) => {
  const { items } = req.body;
  if (!items?.length) return res.status(400).json({ error: 'Sin items' });

  let ihomeMap = {};
  try { if (fs.existsSync(IHOME_MAP_FILE)) ihomeMap = JSON.parse(fs.readFileSync(IHOME_MAP_FILE, 'utf8')); } catch {}

  const CONTAINER_20 = 28;
  const CONTAINER_40 = 67;

  // Enriquecer items con CBM, categoría, etc
  const enriched = items.map(i => {
    const m = ihomeMap[i.sku] || {};
    const cbmPerUnit = m.cbm_per_unit || 0;
    const totalCbm = cbmPerUnit * (i.qty || 0);
    return {
      ...i,
      cbm_per_unit: cbmPerUnit,
      total_cbm: Math.round(totalCbm * 1000) / 1000,
      ihome: m.ihome || '',
      fob: m.fob || 0,
      is_large: isLargeProduct(i.name),
      category_group: getCategoryGroup(i.name),
    };
  });

  const totalCbm = enriched.reduce((s, i) => s + i.total_cbm, 0);
  const sinCbm = enriched.filter(i => !i.cbm_per_unit);

  // 1. Separar productos grandes por tipo → contenedor dedicado
  const largeItems = enriched.filter(i => i.is_large && i.total_cbm > 0);
  const normalItems = enriched.filter(i => !i.is_large && i.total_cbm > 0);

  const containers = [];

  // Agrupar grandes por nombre similar
  const largeGroups = {};
  for (const item of largeItems) {
    // Agrupar por las primeras 2 palabras del nombre
    const groupKey = (item.name || '').split(/\s+/).slice(0, 2).join(' ').toLowerCase();
    if (!largeGroups[groupKey]) largeGroups[groupKey] = [];
    largeGroups[groupKey].push(item);
  }

  for (const [groupName, groupItems] of Object.entries(largeGroups)) {
    const groupCbm = groupItems.reduce((s, i) => s + i.total_cbm, 0);
    const capacity = groupCbm > CONTAINER_20 ? CONTAINER_40 : CONTAINER_20;
    const c = {
      id: containers.length + 1,
      type: capacity === CONTAINER_40 ? '40ft HQ' : '20ft',
      label: '🚲 ' + groupName.charAt(0).toUpperCase() + groupName.slice(1),
      capacity,
      used_cbm: Math.round(groupCbm * 1000) / 1000,
      items: groupItems.map(i => ({ ...i })),
    };
    containers.push(c);
  }

  // 2. Productos normales: agrupar por categoría
  const byCatGroup = {};
  for (const item of normalItems) {
    if (!byCatGroup[item.category_group]) byCatGroup[item.category_group] = [];
    byCatGroup[item.category_group].push(item);
  }

  // Ordenar grupos por CBM total descendente
  const catEntries = Object.entries(byCatGroup).sort((a, b) =>
    b[1].reduce((s, i) => s + i.total_cbm, 0) - a[1].reduce((s, i) => s + i.total_cbm, 0)
  );

  // Llenar contenedores por grupo de categoría
  for (const [catGroup, catItems] of catEntries) {
    // Ordenar items dentro de categoría por CBM desc
    catItems.sort((a, b) => b.total_cbm - a.total_cbm);

    for (const item of catItems) {
      let remaining = item.qty;
      while (remaining > 0) {
        // Buscar contenedor existente de misma categoría o con espacio
        let placed = false;

        // Primero: buscar contenedor que ya tenga items de esta categoría
        for (const c of containers) {
          if (c.label && c.label.startsWith('🚲')) continue; // no mezclar con grandes
          const sameCategory = c.items.some(ci => ci.category_group === catGroup);
          if (!sameCategory) continue;
          const spaceLeft = c.capacity - c.used_cbm;
          const unitsCanFit = Math.floor(spaceLeft / item.cbm_per_unit);
          if (unitsCanFit > 0) {
            const unitsToPlace = Math.min(remaining, unitsCanFit);
            c.items.push({ ...item, qty: unitsToPlace, total_cbm: Math.round(unitsToPlace * item.cbm_per_unit * 1000) / 1000 });
            c.used_cbm = Math.round((c.used_cbm + unitsToPlace * item.cbm_per_unit) * 1000) / 1000;
            remaining -= unitsToPlace;
            placed = true;
            break;
          }
        }

        // Segundo: buscar contenedor de MISMA categoría que tenga espacio (NUNCA mezclar categorías = proveedores distintos)
        // NO mezclar con otras categorías

        // Tercero: nuevo contenedor
        if (!placed) {
          const remainingCbm = remaining * item.cbm_per_unit;
          const capacity = remainingCbm > CONTAINER_20 ? CONTAINER_40 : CONTAINER_20;
          const catLabel = catGroup.charAt(0).toUpperCase() + catGroup.slice(1);
          const c = { id: containers.length + 1, type: capacity === CONTAINER_40 ? '40ft HQ' : '20ft', label: '📦 ' + catLabel, capacity, used_cbm: 0, items: [] };
          const unitsCanFit = Math.floor(capacity / item.cbm_per_unit);
          const unitsToPlace = Math.min(remaining, unitsCanFit);
          c.items.push({ ...item, qty: unitsToPlace, total_cbm: Math.round(unitsToPlace * item.cbm_per_unit * 1000) / 1000 });
          c.used_cbm = Math.round(unitsToPlace * item.cbm_per_unit * 1000) / 1000;
          remaining -= unitsToPlace;
          containers.push(c);
        }
      }
    }
  }

  // Agregar items sin CBM al último contenedor normal
  if (sinCbm.length) {
    const normalContainer = containers.find(c => !c.label?.startsWith('🚲')) || containers[containers.length - 1];
    if (normalContainer) {
      for (const item of sinCbm) normalContainer.items.push({ ...item, total_cbm: 0 });
    } else {
      containers.push({ id: containers.length + 1, type: '20ft', label: '📦 Sin CBM', capacity: CONTAINER_20, used_cbm: 0, items: sinCbm.map(i => ({ ...i, total_cbm: 0 })) });
    }
  }

  // Stats por contenedor
  containers.forEach(c => {
    c.total_qty = c.items.reduce((s, i) => s + (i.qty || 0), 0);
    c.total_fob = Math.round(c.items.reduce((s, i) => s + (i.qty || 0) * (i.fob || 0), 0) * 100) / 100;
    c.fill_pct = c.capacity > 0 ? Math.round(c.used_cbm / c.capacity * 100) : 0;
    c.items_count = c.items.length;
    // Categorías en el contenedor
    const cats = [...new Set(c.items.map(i => i.category_group))];
    c.categories = cats;
  });

  res.json({
    total_cbm: Math.round(totalCbm * 100) / 100,
    total_items: items.length,
    sin_cbm: sinCbm.length,
    containers,
  });
});

app.get('/api/ihome-mapping', requireToken, (req, res) => {
  try {
    if (fs.existsSync(IHOME_MAP_FILE)) return res.json(JSON.parse(fs.readFileSync(IHOME_MAP_FILE, 'utf8')));
    res.json({});
  } catch { res.json({}); }
});

app.get('/api/product-image/:filename', (req, res) => {
  const filePath = path.join(PRODUCT_IMAGES_DIR, req.params.filename);
  if (fs.existsSync(filePath)) return res.sendFile(filePath);
  res.status(404).end();
});

// Export orden con imágenes (ExcelJS)
const ExcelJS = require('exceljs');
app.post('/api/orden/exportar', requireToken, async (req, res) => {
  const { items } = req.body;
  if (!items?.length) return res.status(400).json({ error: 'Sin items' });

  try {
    let ihomeMap = {};
    try { if (fs.existsSync(IHOME_MAP_FILE)) ihomeMap = JSON.parse(fs.readFileSync(IHOME_MAP_FILE, 'utf8')); } catch {}

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Purchase Order');

    // Header
    ws.mergeCells('A1:G1');
    ws.getCell('A1').value = 'PURCHASE ORDER - MA IMPORTACIONES';
    ws.getCell('A1').font = { size: 14, bold: true };
    ws.getCell('A2').value = 'Date:';
    ws.getCell('B2').value = new Date().toLocaleDateString('es-UY');

    // Column headers
    ws.getRow(4).values = ['NO.', 'FOTO', 'IHOME CODE', 'MA CODE', 'DESCRIPTION', 'QTY', 'FOB (ref)', 'LINK ML'];
    ws.getRow(4).font = { bold: true };
    ws.getRow(4).eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } }; });

    // Column widths
    ws.getColumn(1).width = 5;
    ws.getColumn(2).width = 15;
    ws.getColumn(3).width = 14;
    ws.getColumn(4).width = 14;
    ws.getColumn(5).width = 55;
    ws.getColumn(6).width = 8;
    ws.getColumn(7).width = 10;
    ws.getColumn(8).width = 40;

    let totalQty = 0;
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      const mapping = ihomeMap[item.sku] || {};
      const rowNum = 5 + idx;
      const row = ws.getRow(rowNum);
      row.height = 60;

      row.getCell(1).value = idx + 1;
      // Image: China → ML → Odoo
      let imgBuffer = null;
      let imgExt = 'png';
      // 1. Foto de China
      if (mapping.image) {
        const imgFile = path.join(PRODUCT_IMAGES_DIR, path.basename(mapping.image));
        if (fs.existsSync(imgFile)) imgBuffer = fs.readFileSync(imgFile);
      }
      // 2. Foto de ML
      if (!imgBuffer && item.thumb) {
        try {
          const imgUrl = item.thumb.replace('http://', 'https://');
          const imgRes = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 5000 });
          imgBuffer = Buffer.from(imgRes.data);
          imgExt = 'jpeg';
        } catch {}
      }
      // 3. Foto de ML/Odoo (buscar por SKU exacto o base)
      if (!imgBuffer) {
        const sku = (item.sku || '').trim();
        const base = sku.replace(/-[A-Z]{2,}$/, '');
        const mlItem = (cachedStock || []).find(i => i.sku === sku || i.sku === base || (i.sku || '').startsWith(sku)) || cachedVariationSkuMap[sku] || cachedVariationSkuMap[base];
        if (mlItem?.thumbnail) {
          try {
            const imgUrl = mlItem.thumbnail.replace('http://', 'https://');
            const imgRes = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 5000 });
            imgBuffer = Buffer.from(imgRes.data);
            imgExt = 'jpeg';
          } catch {}
        }
      }
      if (imgBuffer) {
        try {
          const imgId = wb.addImage({ buffer: imgBuffer, extension: imgExt });
          ws.addImage(imgId, { tl: { col: 1, row: rowNum - 1 }, ext: { width: 80, height: 60 } });
        } catch {}
      }
      row.getCell(3).value = mapping.ihome || '';
      row.getCell(4).value = item.sku;
      row.getCell(5).value = mapping.description || item.name;
      row.getCell(6).value = item.qty;
      row.getCell(7).value = mapping.fob || '';
      // Link ML
      const skuForLink = (item.sku || '').trim();
      const baseForLink = skuForLink.replace(/-[A-Z]{2,}$/, '');
      const mlForLink = (cachedStock || []).find(i => i.sku === skuForLink || i.sku === baseForLink || (i.sku || '').startsWith(skuForLink)) || cachedVariationSkuMap[skuForLink] || cachedVariationSkuMap[baseForLink];
      const mlLink = mlForLink?.permalink || (mlForLink?.id ? `https://articulo.mercadolibre.com.uy/${mlForLink.id.replace('MLU','MLU-')}` : '');
      if (mlLink) {
        row.getCell(8).value = { text: mlLink, hyperlink: mlLink };
        row.getCell(8).font = { color: { argb: 'FF2563EB' }, underline: true, size: 9 };
      }
      totalQty += item.qty || 0;
    }

    // Total
    const totalRow = ws.getRow(5 + items.length + 1);
    totalRow.getCell(5).value = 'TOTAL';
    totalRow.getCell(5).font = { bold: true };
    totalRow.getCell(6).value = totalQty;
    totalRow.getCell(6).font = { bold: true };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=order_MA_' + new Date().toISOString().slice(0, 10) + '.xlsx');
    await wb.xlsx.write(res);
    res.end();
  } catch(e) {
    console.error('[orden/exportar]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Google Trends ──

// Interés en el tiempo para hasta 5 keywords
app.get('/api/trends/interest', requireToken, async (req, res) => {
  const keywords = (req.query.keywords || '').split(',').map(k => k.trim()).filter(Boolean).slice(0, 5);
  if (!keywords.length) return res.status(400).json({ error: 'keywords requerido (separadas por coma)' });
  const geo = req.query.geo || 'US';
  const months = parseInt(req.query.months) || 24;
  const startTime = new Date();
  startTime.setMonth(startTime.getMonth() - months);

  try {
    const raw = await googleTrends.interestOverTime({ keyword: keywords, startTime, geo });
    const data = JSON.parse(raw);
    const timeline = (data.default?.timelineData || []).map(t => ({
      date: t.formattedAxisTime,
      timestamp: t.time,
      values: t.value,
      formatted: t.formattedTime,
    }));
    res.json({ keywords, geo, timeline, total_points: timeline.length });
  } catch(e) {
    console.error('[trends]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Queries relacionadas (top y rising)
app.get('/api/trends/related', requireToken, async (req, res) => {
  const keyword = (req.query.keyword || '').trim();
  if (!keyword) return res.status(400).json({ error: 'keyword requerido' });
  const geo = req.query.geo || 'US';

  try {
    const raw = await googleTrends.relatedQueries({ keyword, startTime: new Date(Date.now() - 365*24*60*60*1000), geo });
    const data = JSON.parse(raw);
    const ranked = data.default?.rankedList || [];
    const top = (ranked[0]?.rankedKeyword || []).slice(0, 15).map(k => ({ query: k.query, value: k.value }));
    const rising = (ranked[1]?.rankedKeyword || []).slice(0, 15).map(k => ({ query: k.query, value: k.formattedValue }));
    res.json({ keyword, geo, top, rising });
  } catch(e) {
    console.error('[trends related]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Interés por región
app.get('/api/trends/regions', requireToken, async (req, res) => {
  const keyword = (req.query.keyword || '').trim();
  if (!keyword) return res.status(400).json({ error: 'keyword requerido' });

  try {
    const raw = await googleTrends.interestByRegion({ keyword, startTime: new Date(Date.now() - 365*24*60*60*1000), geo: 'US' });
    const data = JSON.parse(raw);
    const regions = (data.default?.geoMapData || []).slice(0, 20).map(r => ({ name: r.geoName, value: r.value[0] }));
    res.json({ keyword, regions });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  console.log(`Iniciá el flujo OAuth en http://localhost:${PORT}/login`);
});
