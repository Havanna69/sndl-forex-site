/**
 * SNDL Forex & Travels — backend server
 * -------------------------------------------------
 * Zero external dependencies: uses only Node's built-in modules,
 * so it runs anywhere Node.js runs without an `npm install` step.
 *
 * Responsibilities:
 *  - Serves the public site (public/index.html) — read-only rates.
 *  - Serves the admin site (admin/index.html) — password-gated rates editor.
 *  - JSON API:
 *      GET  /api/rates    -> public, current rates + date
 *      GET  /api/session  -> is the caller currently logged in as admin?
 *      POST /api/login    -> { password } -> sets an httpOnly session cookie
 *      POST /api/logout   -> clears the session
 *      PUT  /api/rates    -> admin-only, replaces rates + date
 *
 * Data is persisted to plain JSON files under ./data so it survives restarts.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const DATA_DIR = path.join(__dirname, 'data');
const RATES_FILE = path.join(DATA_DIR, 'rates.json');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Bootstrap default rates on first run
// ---------------------------------------------------------------------------
const DEFAULT_RATES = {
  date: new Date().toISOString().slice(0, 10),
  rates: [
    { name: 'US Dollar', buy: '94.00', sell: '101.50' },
    { name: 'Euro', buy: '105.00', sell: '118.80' },
    { name: 'British Pound', buy: '123.00', sell: '137.50' },
    { name: 'UAE Dirham', buy: '22.80', sell: '29.80' },
    { name: 'Australian Dollar', buy: '60.00', sell: '72.60' },
    { name: 'Canadian Dollar', buy: '62.50', sell: '74.20' },
    { name: 'Singapore Dollar', buy: '68.20', sell: '78.50' },
    { name: 'Thai Baht', buy: '2.80', sell: '3.14' },
     { name: 'Japanese Yen (per 100)', buy: '53.00', sell: '68.00' },
     { name: 'Bangla Taka', buy: '0.63', sell: '0.90' },
  ],
};

if (!fs.existsSync(RATES_FILE)) {
  fs.writeFileSync(RATES_FILE, JSON.stringify(DEFAULT_RATES, null, 2));
}

// ---------------------------------------------------------------------------
// Bootstrap admin password on first run
// ---------------------------------------------------------------------------
function hashPassword(password, salt) {
  const derived = crypto.scryptSync(password, salt, 64);
  return derived.toString('hex');
}

function createAdminRecord(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  return { salt, hash };
}

function generateReadablePassword() {
  // e.g. "sndl-7f3k-9dq2" — easy to read off a console, hard to guess
  const part = () => crypto.randomBytes(3).toString('hex');
  return `sndl-${part()}-${part()}`;
}

if (!fs.existsSync(ADMIN_FILE)) {
  const initialPassword = process.env.ADMIN_PASSWORD || generateReadablePassword();
  fs.writeFileSync(ADMIN_FILE, JSON.stringify(createAdminRecord(initialPassword), null, 2));

  console.log('============================================================');
  console.log(' First run: an admin account has been created.');
  if (process.env.ADMIN_PASSWORD) {
    console.log(' Using the password from the ADMIN_PASSWORD environment variable.');
  } else {
    console.log(' Temporary admin password (copy this now, it will not be shown again):');
    console.log('   ' + initialPassword);
    console.log(' Change it any time with: node scripts/set-admin-password.js');
  }
  console.log('============================================================');
}

function verifyPassword(password) {
  const record = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
  const attemptHash = hashPassword(password, record.salt);
  const a = Buffer.from(attemptHash, 'hex');
  const b = Buffer.from(record.hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Sessions (in-memory) + login rate limiting (in-memory)
// ---------------------------------------------------------------------------
const sessions = new Map(); // token -> expiresAt
const loginAttempts = new Map(); // ip -> [timestamps]

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function isSessionValid(token) {
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function isRateLimited(ip) {
  const now = Date.now();
  const attempts = (loginAttempts.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  loginAttempts.set(ip, attempts);
  return attempts.length >= MAX_LOGIN_ATTEMPTS;
}

function recordFailedAttempt(ip) {
  const attempts = loginAttempts.get(ip) || [];
  attempts.push(Date.now());
  loginAttempts.set(ip, attempts);
}

// periodic cleanup so these maps don't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [token, exp] of sessions) if (now > exp) sessions.delete(token);
  for (const [ip, attempts] of loginAttempts) {
    const kept = attempts.filter((t) => now - t < LOGIN_WINDOW_MS);
    if (kept.length) loginAttempts.set(ip, kept);
    else loginAttempts.delete(ip);
  }
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    out[key] = decodeURIComponent(val);
  });
  return out;
}

function readJsonBody(req, maxBytes = 100 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer-when-downgrade');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self' 'unsafe-inline'; " +
      "connect-src 'self';"
  );
}

function requireAdmin(req) {
  const cookies = parseCookies(req);
  return isSessionValid(cookies.sid);
}

function requireHeaderGuard(req) {
  // lightweight CSRF guard: state-changing requests must be same-site fetches
  // that explicitly mark themselves as such (a plain cross-site form post
  // cannot set this custom header).
  return req.headers['x-requested-with'] === 'sndl-admin';
}

function validateRatesPayload(payload) {
  if (!payload || typeof payload !== 'object') return 'Missing body';
  if (typeof payload.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) {
    return 'Invalid date';
  }
  if (!Array.isArray(payload.rates) || payload.rates.length === 0) {
    return 'Rates must be a non-empty list';
  }
  if (payload.rates.length > 60) return 'Too many rows';
  for (const row of payload.rates) {
    if (!row || typeof row !== 'object') return 'Invalid row';
    if (typeof row.name !== 'string' || !row.name.trim() || row.name.length > 60) {
      return 'Each row needs a currency name (max 60 chars)';
    }
    if (typeof row.buy !== 'string' || typeof row.sell !== 'string') {
      return 'Buy/Sell must be text values';
    }
    if (row.buy.length > 20 || row.sell.length > 20) return 'Buy/Sell values too long';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------
async function handleApi(req, res, pathname) {
  const ip = req.socket.remoteAddress || 'unknown';

  if (pathname === '/api/rates' && req.method === 'GET') {
    const rates = JSON.parse(fs.readFileSync(RATES_FILE, 'utf8'));
    return sendJson(res, 200, rates);
  }

  if (pathname === '/api/session' && req.method === 'GET') {
    return sendJson(res, 200, { authenticated: requireAdmin(req) });
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    if (isRateLimited(ip)) {
      return sendJson(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    }
    let body;
    try {
      body = await readJsonBody(req, 2 * 1024);
    } catch (e) {
      return sendJson(res, 400, { error: 'Invalid request' });
    }
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password || !verifyPassword(password)) {
      recordFailedAttempt(ip);
      return sendJson(res, 401, { error: 'Incorrect password' });
    }
    const token = createSession();
    res.setHeader('Set-Cookie', [
      `sid=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; SameSite=Lax` +
        (IS_PROD ? '; Secure' : ''),
    ]);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    if (!requireHeaderGuard(req)) return sendJson(res, 403, { error: 'Bad request' });
    const cookies = parseCookies(req);
    if (cookies.sid) sessions.delete(cookies.sid);
    res.setHeader('Set-Cookie', ['sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax' + (IS_PROD ? '; Secure' : '')]);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/rates' && req.method === 'PUT') {
    if (!requireAdmin(req)) return sendJson(res, 401, { error: 'Not authenticated' });
    if (!requireHeaderGuard(req)) return sendJson(res, 403, { error: 'Bad request' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: 'Invalid request' });
    }
    const err = validateRatesPayload(body);
    if (err) return sendJson(res, 400, { error: err });

    const clean = {
      date: body.date,
      rates: body.rates.map((r) => ({
        name: String(r.name).trim(),
        buy: String(r.buy).trim(),
        sell: String(r.sell).trim(),
      })),
    };
    fs.writeFileSync(RATES_FILE, JSON.stringify(clean, null, 2));
    return sendJson(res, 200, { ok: true });
  }

  sendJson(res, 404, { error: 'Not found' });
}

// ---------------------------------------------------------------------------
// Static file map (no framework — this is a tiny site)
// ---------------------------------------------------------------------------
const STATIC_ROUTES = {
  '/': path.join(__dirname, 'public', 'index.html'),
  '/index.html': path.join(__dirname, 'public', 'index.html'),
  '/about': path.join(__dirname, 'public', 'about.html'),
  '/about.html': path.join(__dirname, 'public', 'about.html'),
  '/admin': path.join(__dirname, 'admin', 'index.html'),
  '/admin/': path.join(__dirname, 'admin', 'index.html'),
};

const server = http.createServer(async (req, res) => {
  setSecurityHeaders(res);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    if (pathname.startsWith('/api/')) {
      return await handleApi(req, res, pathname);
    }

    if (STATIC_ROUTES[pathname]) {
      return sendFile(res, STATIC_ROUTES[pathname], 'text/html; charset=utf-8');
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log(`SNDL Forex & Travels server running on http://localhost:${PORT}`);
  console.log(`  Public site: http://localhost:${PORT}/`);
  console.log(`  Admin page:  http://localhost:${PORT}/admin`);
});
