'use strict';
const path = require('path');
const express = require('express');
const { db, now, audit } = require('./db');
const auth = require('./auth');
const routes = require('./routes');
const agent = require('./agent');
const mailer = require('./mailer');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/* first administrator */
function bootstrapAdmin() {
  const hasAdmin = db.prepare("SELECT 1 FROM users WHERE role = 'admin' AND active = 1").get();
  if (hasAdmin) return;
  const email = process.env.ADMIN_EMAIL || 'admin@bandyscars.local';
  const given = process.env.ADMIN_PASSWORD;
  const password = given && given.length >= 8 ? given : auth.randomPassword(14);
  db.prepare(`INSERT INTO users(email, name, role, password_hash, lang, must_change_password, created_at)
    VALUES (?, ?, 'admin', ?, 'fr', ?, ?)`).run(email, process.env.ADMIN_NAME || 'Administrateur', auth.hashPassword(password), given ? 0 : 1, now());
  audit(null, 'bootstrap_admin', 'user', email);
  console.log('==============================================================');
  console.log(' Compte administrateur créé');
  console.log(`   E-mail       : ${email}`);
  console.log(`   Mot de passe : ${given ? '(celui de ADMIN_PASSWORD)' : password}`);
  console.log('==============================================================');
}
bootstrapAdmin();

// housekeeping: expired sessions, and personal data kept no longer than needed
// (passenger names and GPS traces are deleted 90 days after the event invoice is paid, or 180 days after the event)
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS) || 90;
function housekeeping() {
  const t = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
  const paidBefore = new Date(t - RETENTION_DAYS * 86400000).toISOString();
  const oldEvent = new Date(t - 2 * RETENTION_DAYS * 86400000).toISOString();
  const ids = db.prepare('SELECT id FROM events WHERE (invoice_paid_at IS NOT NULL AND invoice_paid_at < ?) OR alert_at < ?').all(paidBefore, oldEvent).map(r => r.id);
  for (const id of ids) {
    db.prepare('DELETE FROM passengers WHERE event_id = ?').run(id);
    db.prepare('DELETE FROM positions WHERE mission_id IN (SELECT id FROM missions WHERE event_id = ?)').run(id);
  }
}
housekeeping();
setInterval(housekeeping, 3600000).unref();
// dispatch agent: reminders, deadlines, e-mail retries
setInterval(() => { try { agent.tick(); } catch (e) { console.error(e); } }, 15000).unref();

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://*.basemaps.cartocdn.com",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; '));
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use((req, res, next) => { mailer.rememberBaseUrl(req); next(); });
// reply page for coach operators and hotels (link sent by e-mail, no account needed)
app.get('/r/:token', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.sendFile(path.join(PUBLIC_DIR, 'reply.html')); });

// API: JSON only. A JSON content type on writes also blocks cross-site form posts.
app.use('/api', express.json({ limit: '12mb' }), auth.authMiddleware, (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    return res.status(415).json({ error: 'json_required' });
  }
  next();
}, routes);
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

app.use(express.static(PUBLIC_DIR, {
  index: false,
  setHeaders: (res, file) => {
    if (/\/vendor\//.test(file)) res.setHeader('Cache-Control', 'public, max-age=604800');
    else res.setHeader('Cache-Control', 'no-cache');
  }
}));
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'file_too_large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
  res.status(500).json({ error: 'server_error' });
});

app.listen(PORT, () => console.log(`Bandy's Care Ops en ligne sur le port ${PORT}`));
