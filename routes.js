'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, now, getSettings, saveSettingsSection, audit, tx, UPLOAD_DIR } = require('./db');
const auth = require('./auth');
const L = require('./logic');
const rt = require('./realtime');
const agent = require('./agent');
const mailer = require('./mailer');
const parser = require('./parse');

const router = express.Router();
const { requireAuth, requireRole } = auth;
const STAFF = ['admin', 'desk'];
const ALL_ROLES = ['admin', 'desk', 'agent', 'carrier', 'driver', 'hotel', 'ryanair'];

/* ---------- helpers ---------- */
const str = (v, max = 500) => (v == null || v === '' ? null : String(v).trim().slice(0, max));
const int = v => (v == null || v === '' || isNaN(Number(v)) ? null : Math.max(0, Math.round(Number(v))));
const num = v => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
const bool = v => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
const isoOrNull = v => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };
const bad = (res, error, status = 400) => res.status(status).json({ error });
const secure = req => req.secure || req.headers['x-forwarded-proto'] === 'https';

function sys(eventId, userId, code, params = {}, visibility = 'shared') {
  L.addTimeline(eventId, userId, JSON.stringify({ c: code, p: params }), { kind: 'status', visibility });
}
function touch(eventId) { db.prepare('UPDATE events SET updated_at = ? WHERE id = ?').run(now(), eventId); }
function getEventOr404(req, res) {
  const id = Number(req.params.id);
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!ev) { bad(res, 'not_found', 404); return null; }
  if (!L.canSeeEvent(req.user, id)) { bad(res, 'forbidden', 403); return null; }
  return ev;
}
function updateRow(table, id, fields) {
  const keys = Object.keys(fields).filter(k => fields[k] !== undefined);
  if (!keys.length) return;
  db.prepare(`UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => fields[k]), id);
}
function sendEvent(req, res, id) {
  const ctx = L.loadEvent(id);
  res.json(L.serializeEvent(ctx, req.user, getSettings()));
}

/* ---------- auth ---------- */
router.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return bad(res, 'missing_credentials');
  const key = `${req.ip}|${String(email).toLowerCase()}`;
  if (!auth.loginThrottle(key)) return bad(res, 'too_many_attempts', 429);
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim());
  if (!u || !u.active || !auth.verifyPassword(String(password), u.password_hash)) {
    audit(u ? u.id : null, 'login_failed', 'user', u ? u.id : null, String(email).slice(0, 120));
    return bad(res, 'invalid_credentials', 401);
  }
  auth.loginReset(key);
  auth.createSession(res, u.id, secure(req));
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), u.id);
  audit(u.id, 'login', 'user', u.id);
  res.json({ ok: true });
});
router.post('/auth/logout', (req, res) => { auth.clearSession(req, res, secure(req)); res.json({ ok: true }); });

router.get('/me', requireAuth, (req, res) => {
  const u = { ...req.user };
  if (u.hotel_id) u.hotel = db.prepare('SELECT id, name, city FROM hotels WHERE id = ?').get(u.hotel_id);
  if (u.carrier_id) u.carrier = db.prepare('SELECT id, name, city FROM carriers WHERE id = ?').get(u.carrier_id);
  const S = getSettings();
  u.company = { name: S.company.name, desk_phone: S.company.desk_phone, desk_email: S.company.desk_email };
  res.json(u);
});
router.patch('/me', requireAuth, (req, res) => {
  const b = req.body || {};
  const f = {};
  if (b.lang === 'fr' || b.lang === 'en') f.lang = b.lang;
  if (b.name) f.name = str(b.name, 120);
  if (b.phone !== undefined) f.phone = str(b.phone, 40);
  updateRow('users', req.user.id, f);
  res.json({ ok: true });
});
router.post('/me/password', requireAuth, (req, res) => {
  const { current, next } = req.body || {};
  if (!next || String(next).length < 8) return bad(res, 'password_too_short');
  const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!auth.verifyPassword(String(current || ''), u.password_hash)) return bad(res, 'invalid_current_password');
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(auth.hashPassword(String(next)), req.user.id);
  audit(req.user.id, 'password_changed', 'user', req.user.id);
  res.json({ ok: true });
});

router.get('/stream', requireAuth, (req, res) => rt.attach(req, res));

/* ---------- reference data ---------- */
router.get('/airports', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM airports ORDER BY category, code').all());
});
router.patch('/airports/:code', requireRole('admin'), (req, res) => {
  const b = req.body || {};
  const a = db.prepare('SELECT * FROM airports WHERE code = ?').get(req.params.code);
  if (!a) return bad(res, 'not_found', 404);
  const f = {};
  if (b.name) f.name = str(b.name, 120);
  if (b.city) f.city = str(b.city, 80);
  if (b.category === 1 || b.category === 2 || b.category === '1' || b.category === '2') f.category = Number(b.category);
  if (b.lat !== undefined) f.lat = num(b.lat);
  if (b.lng !== undefined) f.lng = num(b.lng);
  if (b.active !== undefined) f.active = bool(b.active);
  const keys = Object.keys(f);
  if (keys.length) db.prepare(`UPDATE airports SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE code = ?`).run(...keys.map(k => f[k]), a.code);
  audit(req.user.id, 'update', 'airport', a.code, f);
  rt.refChanged('airports');
  res.json({ ok: true });
});

const HOTEL_FIELDS = {
  name: v => str(v, 160), city: v => str(v, 80), airport_code: v => str(v, 3), stars: int, address: v => str(v, 300),
  lat: num, lng: num, phone: v => str(v, 40), email: v => str(v, 160), contact_name: v => str(v, 120), capacity: int, accessible_rooms: int,
  distance_min: int, rate_single: num, rate_double: num, rate_dinner: num, rate_tray: num,
  agreement_status: v => (['prospect', 'negotiation', 'signed', 'suspended'].includes(v) ? v : 'prospect'),
  agreement_end: v => str(v, 20), direct_billing: bool, notes: v => str(v, 2000), active: bool
};
const HOTEL_SELF_FIELDS = ['phone', 'email', 'contact_name', 'capacity', 'accessible_rooms', 'address'];
function readFields(b, spec, allowed) {
  const f = {};
  for (const [k, fn] of Object.entries(spec)) {
    if (allowed && !allowed.includes(k)) continue;
    if (b[k] !== undefined) f[k] = fn(b[k]);
  }
  return f;
}

router.get('/hotels', requireRole('admin', 'desk', 'agent', 'ryanair', 'hotel'), (req, res) => {
  if (req.user.role === 'hotel') return res.json(db.prepare('SELECT * FROM hotels WHERE id = ?').all(req.user.hotel_id ?? -1));
  const rows = db.prepare('SELECT * FROM hotels ORDER BY active DESC, airport_code, name').all();
  if (req.user.role === 'agent') return res.json(rows.filter(h => h.active).map(h => ({ id: h.id, name: h.name, city: h.city, airport_code: h.airport_code, address: h.address, phone: h.phone, contact_name: h.contact_name, lat: h.lat, lng: h.lng, stars: h.stars })));
  if (req.user.role === 'ryanair') return res.json(rows.filter(h => h.active && h.agreement_status !== 'prospect').map(h => { const r = { ...h }; delete r.notes; return r; }));
  res.json(rows);
});
router.post('/hotels', requireRole(...STAFF), (req, res) => {
  const f = readFields(req.body || {}, HOTEL_FIELDS);
  if (!f.name) return bad(res, 'name_required');
  f.created_at = now();
  const keys = Object.keys(f);
  const r = db.prepare(`INSERT INTO hotels(${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map(k => f[k]));
  audit(req.user.id, 'create', 'hotel', r.lastInsertRowid, f.name);
  rt.refChanged('hotels');
  res.json({ id: Number(r.lastInsertRowid) });
});
router.patch('/hotels/:id', requireRole('admin', 'desk', 'hotel'), (req, res) => {
  const id = Number(req.params.id);
  if (req.user.role === 'hotel' && req.user.hotel_id !== id) return bad(res, 'forbidden', 403);
  const f = readFields(req.body || {}, HOTEL_FIELDS, req.user.role === 'hotel' ? HOTEL_SELF_FIELDS : null);
  updateRow('hotels', id, f);
  audit(req.user.id, 'update', 'hotel', id, f);
  rt.refChanged('hotels');
  res.json({ ok: true });
});

const CARRIER_FIELDS = {
  name: v => str(v, 160), city: v => str(v, 80), regions: v => str(v, 200), licence_no: v => str(v, 80),
  licence_expiry: v => str(v, 20), insurance_expiry: v => str(v, 20), phone: v => str(v, 40), email: v => str(v, 160),
  contact_name: v => str(v, 120), agreement_status: v => (['prospect', 'negotiation', 'signed', 'suspended'].includes(v) ? v : 'prospect'),
  notes: v => str(v, 2000), active: bool,
  cost_local: num, cost_minibus: num, cost_ic100: num, cost_ic250: num, cost_ic400: num
};
const COST_KEYS = ['cost_local', 'cost_minibus', 'cost_ic100', 'cost_ic250', 'cost_ic400'];
function carrierOut(c, user) {
  if (user.role === 'admin') return c;
  const r = { ...c };
  for (const k of COST_KEYS) delete r[k];
  if (user.role !== 'desk') delete r.notes;
  return r;
}
router.get('/carriers', requireRole('admin', 'desk', 'carrier'), (req, res) => {
  const rows = req.user.role === 'carrier'
    ? db.prepare('SELECT * FROM carriers WHERE id = ?').all(req.user.carrier_id ?? -1)
    : db.prepare('SELECT * FROM carriers ORDER BY active DESC, name').all();
  res.json(rows.map(c => carrierOut(c, req.user)));
});
router.post('/carriers', requireRole(...STAFF), (req, res) => {
  const f = readFields(req.body || {}, CARRIER_FIELDS);
  if (req.user.role !== 'admin') for (const k of COST_KEYS) delete f[k];
  if (!f.name) return bad(res, 'name_required');
  f.created_at = now();
  const keys = Object.keys(f);
  const r = db.prepare(`INSERT INTO carriers(${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map(k => f[k]));
  audit(req.user.id, 'create', 'carrier', r.lastInsertRowid, f.name);
  rt.refChanged('carriers');
  res.json({ id: Number(r.lastInsertRowid) });
});
router.patch('/carriers/:id', requireRole(...STAFF), (req, res) => {
  const f = readFields(req.body || {}, CARRIER_FIELDS);
  if (req.user.role !== 'admin') for (const k of COST_KEYS) delete f[k];
  updateRow('carriers', Number(req.params.id), f);
  audit(req.user.id, 'update', 'carrier', req.params.id, f);
  rt.refChanged('carriers');
  res.json({ ok: true });
});

const VEHICLE_FIELDS = {
  carrier_id: int, plate: v => str(v, 30), kind: v => (['coach', 'minibus', 'adapted'].includes(v) ? v : 'coach'),
  seats: int, year: int, insurance_expiry: v => str(v, 20), active: bool
};
router.get('/vehicles', requireRole('admin', 'desk', 'carrier'), (req, res) => {
  if (req.user.role === 'carrier') return res.json(db.prepare('SELECT * FROM vehicles WHERE carrier_id = ? ORDER BY active DESC, plate').all(req.user.carrier_id ?? -1));
  const cid = int(req.query.carrier_id);
  res.json(cid ? db.prepare('SELECT * FROM vehicles WHERE carrier_id = ? ORDER BY active DESC, plate').all(cid)
    : db.prepare('SELECT v.*, c.name AS carrier_name FROM vehicles v JOIN carriers c ON c.id = v.carrier_id ORDER BY c.name, v.plate').all());
});
router.post('/vehicles', requireRole('admin', 'desk', 'carrier'), (req, res) => {
  const f = readFields(req.body || {}, VEHICLE_FIELDS);
  if (req.user.role === 'carrier') f.carrier_id = req.user.carrier_id;
  if (!f.carrier_id || !f.plate) return bad(res, 'carrier_and_plate_required');
  const keys = Object.keys(f);
  const r = db.prepare(`INSERT INTO vehicles(${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map(k => f[k]));
  audit(req.user.id, 'create', 'vehicle', r.lastInsertRowid, f.plate);
  rt.refChanged('vehicles');
  res.json({ id: Number(r.lastInsertRowid) });
});
router.patch('/vehicles/:id', requireRole('admin', 'desk', 'carrier'), (req, res) => {
  const v = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(Number(req.params.id));
  if (!v) return bad(res, 'not_found', 404);
  if (req.user.role === 'carrier' && v.carrier_id !== req.user.carrier_id) return bad(res, 'forbidden', 403);
  const f = readFields(req.body || {}, VEHICLE_FIELDS);
  if (req.user.role === 'carrier') delete f.carrier_id;
  updateRow('vehicles', v.id, f);
  audit(req.user.id, 'update', 'vehicle', v.id, f);
  rt.refChanged('vehicles');
  res.json({ ok: true });
});

/* ---------- users ---------- */
const USER_OUT = 'u.id, u.email, u.name, u.phone, u.role, u.lang, u.carrier_id, u.hotel_id, u.base_city, u.active, u.created_at, u.last_login_at, c.name AS carrier_name, h.name AS hotel_name';
router.get('/users', requireRole('admin', 'desk', 'carrier'), (req, res) => {
  const base = `SELECT ${USER_OUT} FROM users u LEFT JOIN carriers c ON c.id = u.carrier_id LEFT JOIN hotels h ON h.id = u.hotel_id`;
  if (req.user.role === 'admin') return res.json(db.prepare(`${base} ORDER BY u.role, u.name`).all());
  if (req.user.role === 'carrier') return res.json(db.prepare(`${base} WHERE u.role = 'driver' AND u.carrier_id = ? ORDER BY u.name`).all(req.user.carrier_id ?? -1));
  // desk: people that can be assigned
  res.json(db.prepare(`${base} WHERE u.role IN ('agent','driver','desk') AND u.active = 1 ORDER BY u.role, u.name`).all());
});
router.post('/users', requireRole('admin', 'carrier'), (req, res) => {
  const b = req.body || {};
  const role = req.user.role === 'carrier' ? 'driver' : b.role;
  if (!ALL_ROLES.includes(role)) return bad(res, 'invalid_role');
  const email = str(b.email, 160);
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) return bad(res, 'invalid_email');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return bad(res, 'email_exists');
  const temp = b.password && String(b.password).length >= 8 ? String(b.password) : auth.randomPassword();
  const carrierId = req.user.role === 'carrier' ? req.user.carrier_id : (['carrier', 'driver'].includes(role) ? int(b.carrier_id) : null);
  const hotelId = role === 'hotel' ? int(b.hotel_id) : null;
  if (['carrier', 'driver'].includes(role) && !carrierId) return bad(res, 'carrier_required');
  if (role === 'hotel' && !hotelId) return bad(res, 'hotel_required');
  const r = db.prepare(`INSERT INTO users(email, name, phone, role, password_hash, lang, carrier_id, hotel_id, base_city, must_change_password, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,1,?)`).run(email, str(b.name, 120) || email, str(b.phone, 40), role, auth.hashPassword(temp),
    b.lang === 'en' ? 'en' : (role === 'ryanair' ? 'en' : 'fr'), carrierId, hotelId, str(b.base_city, 80), now());
  audit(req.user.id, 'create', 'user', r.lastInsertRowid, { email, role });
  res.json({ id: Number(r.lastInsertRowid), temp_password: temp });
});
router.patch('/users/:id', requireRole('admin', 'carrier'), (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return bad(res, 'not_found', 404);
  if (req.user.role === 'carrier' && !(u.role === 'driver' && u.carrier_id === req.user.carrier_id)) return bad(res, 'forbidden', 403);
  const b = req.body || {};
  const f = {};
  if (b.name !== undefined) f.name = str(b.name, 120);
  if (b.phone !== undefined) f.phone = str(b.phone, 40);
  if (b.base_city !== undefined) f.base_city = str(b.base_city, 80);
  if (b.active !== undefined) f.active = bool(b.active);
  if (b.lang === 'fr' || b.lang === 'en') f.lang = b.lang;
  if (req.user.role === 'admin') {
    if (b.email !== undefined && b.email !== u.email) {
      const email = str(b.email, 160);
      if (!email || db.prepare('SELECT 1 FROM users WHERE email = ? AND id <> ?').get(email, id)) return bad(res, 'email_exists');
      f.email = email;
    }
    if (b.role !== undefined && ALL_ROLES.includes(b.role)) f.role = b.role;
    if (b.carrier_id !== undefined) f.carrier_id = int(b.carrier_id);
    if (b.hotel_id !== undefined) f.hotel_id = int(b.hotel_id);
    if (id === req.user.id && (f.active === 0 || (f.role && f.role !== 'admin'))) return bad(res, 'cannot_demote_self');
  }
  updateRow('users', id, f);
  if (f.active === 0) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  audit(req.user.id, 'update', 'user', id, f);
  res.json({ ok: true });
});
router.post('/users/:id/reset-password', requireRole('admin', 'carrier'), (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return bad(res, 'not_found', 404);
  if (req.user.role === 'carrier' && !(u.role === 'driver' && u.carrier_id === req.user.carrier_id)) return bad(res, 'forbidden', 403);
  const temp = auth.randomPassword();
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(auth.hashPassword(temp), id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  audit(req.user.id, 'reset_password', 'user', id);
  res.json({ temp_password: temp });
});

/* ---------- settings ---------- */
router.get('/settings', requireRole('admin', 'desk', 'ryanair'), (req, res) => {
  const S = getSettings();
  if (req.user.role === 'admin') return res.json({ ...S, smtp: { configured: mailer.configured(), host: mailer.smtpConfig().host, from: mailer.smtpConfig().from, public_url: mailer.baseUrl() } });
  res.json({ prices: S.prices, vat: S.vat, sla: S.sla, agent: req.user.role === 'desk' ? S.agent : undefined, company: { name: S.company.name, desk_phone: S.company.desk_phone, desk_email: S.company.desk_email } });
});
router.put('/settings', requireRole('admin'), (req, res) => {
  const b = req.body || {};
  const S = getSettings();
  for (const section of ['prices', 'vat', 'sla', 'costs', 'agent']) {
    if (!b[section]) continue;
    const next = { ...S[section] };
    for (const k of Object.keys(next)) if (b[section][k] !== undefined) next[k] = b[section][k] === '' || b[section][k] === null ? null : Number(b[section][k]);
    saveSettingsSection(section, next);
  }
  if (b.company) {
    const next = { ...S.company };
    for (const k of ['name', 'desk_phone', 'desk_email', 'invoice_prefix']) if (b.company[k] !== undefined) next[k] = str(b.company[k], 120) || '';
    if (b.company.next_invoice !== undefined) next.next_invoice = Math.max(1, int(b.company.next_invoice) || 1);
    saveSettingsSection('company', next);
  }
  audit(req.user.id, 'update', 'settings', null, b);
  res.json(getSettings());
});

/* ---------- events ---------- */
router.get('/events', requireAuth, (req, res) => {
  const S = getSettings();
  const f = L.eventFilterSql(req.user);
  const where = [f.sql];
  const args = [...f.args];
  const scope = req.query.scope || 'active';
  if (scope === 'active') where.push("(e.status NOT IN ('closed','cancelled') OR e.closed_at > ? OR e.cancelled_at > ?)"), args.push(new Date(Date.now() - 12 * 3600000).toISOString(), new Date(Date.now() - 12 * 3600000).toISOString());
  if (req.query.airport) { where.push('e.airport_code = ?'); args.push(String(req.query.airport)); }
  if (req.query.type) { where.push('e.type = ?'); args.push(String(req.query.type)); }
  if (req.query.status) { where.push('e.status = ?'); args.push(String(req.query.status)); }
  if (req.query.from) { where.push('e.alert_at >= ?'); args.push(isoOrNull(req.query.from) || '0'); }
  if (req.query.to) { where.push('e.alert_at <= ?'); args.push(isoOrNull(req.query.to) || '9'); }
  if (req.query.q) { where.push('(e.ref LIKE ? OR e.flight_no LIKE ? OR e.route LIKE ?)'); const q = `%${String(req.query.q)}%`; args.push(q, q, q); }
  const limit = Math.min(500, int(req.query.limit) || 200);
  const ids = db.prepare(`SELECT e.id FROM events e WHERE ${where.join(' AND ')} ORDER BY e.alert_at DESC LIMIT ${limit}`).all(...args);
  res.json(ids.map(r => L.eventSummary(r.id, req.user, S)).filter(Boolean));
});

const EVENT_CREATE = {
  type: v => (v === 'transfer' ? 'transfer' : 'hotel'), flight_no: v => str(v, 20), route: v => str(v, 40), reason: v => str(v, 40),
  airport_code: v => str(v, 3), dest_airport_code: v => str(v, 3), pax_total: int, pax_hotel: int, pax_prm: int, pax_um: int,
  eta: isoOrNull, new_departure: isoOrNull, requester_name: v => str(v, 120), requester_phone: v => str(v, 40),
  requester_email: v => str(v, 160), notes_shared: v => str(v, 2000)
};
router.post('/events', requireRole('admin', 'desk', 'ryanair'), (req, res) => {
  const b = req.body || {};
  const f = readFields(b, EVENT_CREATE);
  if (!f.airport_code || !db.prepare('SELECT 1 FROM airports WHERE code = ?').get(f.airport_code)) return bad(res, 'airport_required');
  if (f.type === 'transfer' && (!f.dest_airport_code || !db.prepare('SELECT 1 FROM airports WHERE code = ?').get(f.dest_airport_code))) return bad(res, 'destination_required');
  if (!f.pax_total) return bad(res, 'pax_required');
  if (f.type !== 'transfer') f.dest_airport_code = null;
  if (req.user.role === 'ryanair') {
    f.requester_name = f.requester_name || req.user.name;
    f.requester_phone = f.requester_phone || req.user.phone;
    f.requester_email = f.requester_email || req.user.email;
  }
  if (L.isStaff(req.user)) f.notes_internal = str(b.notes_internal, 2000);
  const alertAt = (L.isStaff(req.user) && isoOrNull(b.alert_at)) || now();
  const id = tx(() => {
    const ref = L.nextEventRef();
    const row = { ...f, ref, status: 'alert', alert_at: alertAt, created_by: req.user.id, created_at: now(), updated_at: now() };
    const keys = Object.keys(row);
    const r = db.prepare(`INSERT INTO events(${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map(k => row[k]));
    return Number(r.lastInsertRowid);
  });
  sys(id, req.user.id, 'event_created', { by_role: req.user.role });
  audit(req.user.id, 'create', 'event', id);
  rt.eventChanged(id, { created: true });
  res.json({ id });
});

router.get('/events/:id', requireAuth, (req, res) => {
  const ev = getEventOr404(req, res); if (!ev) return;
  sendEvent(req, res, ev.id);
});

router.patch('/events/:id', requireRole('admin', 'desk', 'ryanair', 'agent'), (req, res) => {
  const ev = getEventOr404(req, res); if (!ev) return;
  const b = req.body || {};
  let f = {};
  if (L.isStaff(req.user)) {
    f = readFields(b, { ...EVENT_CREATE, notes_internal: v => str(v, 2000), refreshments_qty: int, pax_welcomed: int, vouchers_issued: int,
      sla_plan_imputable: bool, sla_coach_imputable: bool, sla_accom_imputable: bool, alert_at: isoOrNull });
    if (f.alert_at === null) delete f.alert_at;
    if (f.type) delete f.type;
    if (f.airport_code && !db.prepare('SELECT 1 FROM airports WHERE code = ?').get(f.airport_code)) return bad(res, 'airport_required');
    if (req.user.role !== 'admin') { delete f.sla_plan_imputable; delete f.sla_coach_imputable; delete f.sla_accom_imputable; }
  } else if (req.user.role === 'ryanair') {
    if (ev.status === 'closed' || ev.status === 'cancelled') return bad(res, 'event_closed');
    f = readFields(b, EVENT_CREATE, ['pax_total', 'pax_hotel', 'pax_prm', 'pax_um', 'eta', 'new_departure', 'notes_shared', 'requester_name', 'requester_phone', 'requester_email', 'flight_no', 'route']);
  } else if (req.user.role === 'agent') {
    f = readFields(b, { pax_welcomed: int, vouchers_issued: int, refreshments_qty: int, notes_internal: v => str(v, 2000) });
  }
  if (!Object.keys(f).length) return res.json({ ok: true });
  f.updated_at = now();
  updateRow('events', ev.id, f);
  if (f.new_departure && f.new_departure !== ev.new_departure) sys(ev.id, req.user.id, 'new_departure', { at: f.new_departure });
  if ((f.pax_total != null && f.pax_total !== ev.pax_total) || (f.pax_hotel != null && f.pax_hotel !== ev.pax_hotel)) sys(ev.id, req.user.id, 'pax_updated', { total: f.pax_total ?? ev.pax_total, hotel: f.pax_hotel ?? ev.pax_hotel });
  audit(req.user.id, 'update', 'event', ev.id, f);
  rt.eventChanged(ev.id);
  res.json({ ok: true });
});

router.post('/events/:id/confirm-plan', requireRole(...STAFF), (req, res) => {
  const ev = getEventOr404(req, res); if (!ev) return;
  if (ev.status === 'closed' || ev.status === 'cancelled') return bad(res, 'event_closed');
  if (!ev.plan_confirmed_at) {
    db.prepare("UPDATE events SET plan_confirmed_at = ?, status = 'in_progress', updated_at = ? WHERE id = ?").run(now(), now(), ev.id);
    const hotels = db.prepare(`SELECT h.name FROM event_hotels eh JOIN hotels h ON h.id = eh.hotel_id WHERE eh.event_id = ? AND eh.status <> 'refused'`).all(ev.id).map(h => h.name);
    const coaches = db.prepare(`SELECT COUNT(*) AS n FROM missions WHERE event_id = ? AND status NOT IN ('cancelled','refused')`).get(ev.id).n;
    sys(ev.id, req.user.id, 'plan_confirmed', { hotels, coaches });
  }
  rt.eventChanged(ev.id);
  sendEvent(req, res, ev.id);
});
router.post('/events/:id/close', requireRole(...STAFF), (req, res) => {
  const ev = getEventOr404(req, res); if (!ev) return;
  if (ev.status === 'cancelled') return bad(res, 'event_cancelled');
  if (!ev.closed_at) {
    db.prepare("UPDATE events SET closed_at = ?, status = 'closed', plan_confirmed_at = COALESCE(plan_confirmed_at, ?), updated_at = ? WHERE id = ?").run(now(), now(), now(), ev.id);
    db.prepare("UPDATE missions SET status = 'completed', completed_at = ? WHERE event_id = ? AND status = 'arrived'").run(now(), ev.id);
    // coaches that never left and rooms never confirmed are no longer needed
    db.prepare("UPDATE missions SET status = 'cancelled', cancelled_at = ? WHERE event_id = ? AND status IN ('requested','accepted')").run(now(), ev.id);
    db.prepare("UPDATE event_hotels SET status = 'cancelled' WHERE event_id = ? AND status = 'requested'").run(ev.id);
    sys(ev.id, req.user.id, 'event_closed');
  }
  rt.eventChanged(ev.id);
  sendEvent(req, res, ev.id);
});
router.post('/events/:id/reopen', requireRole('admin'), (req, res) => {
  const ev = getEventOr404(req, res); if (!ev) return;
  if (ev.invoice_status === 'issued' || ev.invoice_status === 'paid') return bad(res, 'invoice_already_issued');
  db.prepare("UPDATE events SET closed_at = NULL, cancelled_at = NULL, cancel_stage = NULL, status = CASE WHEN plan_confirmed_at IS NULL THEN 'alert' ELSE 'in_progress' END, updated_at = ? WHERE id = ?").run(now(), ev.id);
  sys(ev.id, req.user.id, 'event_reopened', {}, 'internal');
  rt.eventChanged(ev.id);
  sendEvent(req, res, ev.id);
});
router.post('/events/:id/cancel', requireRole('admin', 'desk', 'ryanair'), (req, res) => {
  const ev = getEventOr404(req, res); if (!ev) return;
  if (ev.status === 'closed' || ev.status === 'cancelled') return bad(res, 'event_closed');
  const missions = db.prepare('SELECT * FROM missions WHERE event_id = ?').all(ev.id);
  const stage = missions.some(L.dispatched) ? 'after_departure' : 'before_departure';
  tx(() => {
    db.prepare("UPDATE events SET status = 'cancelled', cancelled_at = ?, cancel_stage = ?, updated_at = ? WHERE id = ?").run(now(), stage, now(), ev.id);
    db.prepare("UPDATE missions SET status = 'cancelled', cancelled_at = ? WHERE event_id = ? AND status IN ('requested','accepted')").run(now(), ev.id);
    db.prepare("UPDATE event_hotels SET status = 'cancelled' WHERE event_id = ? AND status = 'requested'").run(ev.id);
  });
  sys(ev.id, req.user.id, 'event_cancelled', { stage, reason: str((req.body || {}).reason, 300) });
  audit(req.user.id, 'cancel', 'event', ev.id, { stage });
  rt.eventChanged(ev.id);
  sendEvent(req, res, ev.id);
});
router.post('/events/:id/summary-sent', requireRole(...STAFF), (req, res) => {
  const ev = getEventOr404(req, res); if (!ev) return;
  db.prepare('UPDATE events SET summary_sent_at = COALESCE(summary_sent_at, ?), updated_at = ? WHERE id = ?').run(now(), now(), ev.id);
  sys(ev.id, req.user.id, 'summary_sent');
  rt.eventChanged(ev.id);
  sendEvent(req, res, ev.id);
});

router.post('/events/:id/notes', requireAuth, (req, res) => {
  const ev = getEventOr404(req, res); if (!ev) return;
  const b = req.body || {};
  const message = str(b.message, 2000);
  if (!message) return bad(res, 'message_required');
  const kind = b.kind === 'incident' ? 'incident' : 'note';
  let visibility = b.visibility === 'shared' ? 'shared' : 'internal';
  if (!L.isStaff(req.user) && req.user.role !== 'agent') visibility = 'shared';
  const severity = kind === 'incident' ? (['low', 'medium', 'high'].includes(b.severity) ? b.severity : 'medium') : null;
  L.addTimeline(ev.id, req.user.id, message, { kind, visibility, severity });
  audit(req.user.id, 'note', 'event', ev.id, kind);
  rt.eventChanged(ev.id, kind === 'incident' ? { incident: true } : {});
  res.json({ ok: true });
});

/* agents */
router.post('/events/:id/agents', requireRole(...STAFF), (req, res) => {
  const ev = getEventOr404(req, res); if (!ev) return;
  const uid = int((req.body || {}).user_id);
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND role IN ('agent','desk') AND active = 1").get(uid);
  if (!u) return bad(res, 'agent_not_found');
  db.prepare('INSERT OR IGNORE INTO event_agents(event_id, user_id, assigned_at) VALUES (?,?,?)').run(ev.id, uid, now());
  sys(ev.id, req.user.id, 'agent_assigned', { name: u.name }, 'internal');
  rt.eventChanged(ev.id);
  res.json({ ok: true });
});
router.delete('/events/:id/agents/:uid', requireRole(...STAFF), (req, res) => {
  const ev = getEventOr404(req, res); if (!ev) return;
  db.prepare('DELETE FROM event_agents WHERE event_id = ? AND user_id = ?').run(ev.id, Number(req.params.uid));
  rt.eventChanged(ev.id);
  res.json({ ok: true });
});

/* hotel allocations */
router.post('/events/:id/hotels', requireRole(...STAFF), (req, res) => {
  const ev = getEventOr404(req, res); if (!ev) return;
  const b = req.body || {};
  const hotel = db.prepare('SELECT * FROM hotels WHERE id = ? AND active = 1').get(int(b.hotel_id));
  if (!hotel) return bad(res, 'hotel_not_found');
  if (db.prepare("SELECT 1 FROM event_hotels WHERE event_id = ? AND hotel_id = ? AND status NOT IN ('refused','cancelled')").get(ev.id, hotel.id)) return bad(res, 'hotel_already_added');
  const r = db.prepare(`INSERT INTO event_hotels(event_id, hotel_id, rooms_single_req, rooms_double_req, pax_planned, requested_at, notes)
    VALUES (?,?,?,?,?,?,?)`).run(ev.id, hotel.id, int(b.rooms_single_req) || 0, int(b.rooms_double_req) || 0, int(b.pax_planned) || 0, now(), str(b.notes, 1000));
  sys(ev.id, req.user.id, 'hotel_requested', { hotel: hotel.name, single: int(b.rooms_single_req) || 0, double: int(b.rooms_double_req) || 0 }, 'internal');
  touch(ev.id);
  rt.eventChanged(ev.id);
  res.json({ id: Number(r.lastInsertRowid) });
});
router.patch('/event-hotels/:id', requireRole('admin', 'desk', 'hotel', 'agent'), (req, res) => {
  const a = db.prepare('SELECT eh.*, h.name AS hotel_name FROM event_hotels eh JOIN hotels h ON h.id = eh.hotel_id WHERE eh.id = ?').get(Number(req.params.id));
  if (!a) return bad(res, 'not_found', 404);
  if (!L.canSeeEvent(req.user, a.event_id)) return bad(res, 'forbidden', 403);
  if (req.user.role === 'hotel' && a.hotel_id !== req.user.hotel_id) return bad(res, 'forbidden', 403);
  const b = req.body || {};
  const spec = {
    status: v => (['requested', 'confirmed', 'refused', 'in_house', 'checked_out', 'cancelled'].includes(v) ? v : undefined),
    rooms_single_req: int, rooms_double_req: int, rooms_single_conf: int, rooms_double_conf: int, pax_planned: int,
    pax_checked_in: int, pax_checked_out: int, dinners: int, trays: int, breakfasts: int,
    invoice_no: v => str(v, 60), invoice_amount: num, invoice_note: v => str(v, 1000), notes: v => str(v, 2000),
    invoice_status: v => (['awaited', 'received', 'approved', 'disputed'].includes(v) ? v : undefined)
  };
  const allowed = {
    admin: null, desk: null,
    hotel: ['status', 'rooms_single_conf', 'rooms_double_conf', 'pax_checked_in', 'pax_checked_out', 'dinners', 'trays', 'breakfasts', 'invoice_no', 'invoice_amount', 'notes'],
    agent: ['pax_checked_in', 'pax_checked_out', 'status', 'notes']
  }[req.user.role];
  const f = readFields(b, spec, allowed);
  for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k];
  if (req.user.role === 'hotel' && f.status && !['confirmed', 'refused', 'in_house', 'checked_out'].includes(f.status)) delete f.status;
  if (req.user.role === 'agent' && f.status && !['in_house', 'checked_out'].includes(f.status)) delete f.status;
  const t = now();
  if (f.pax_checked_in > 0 && !f.status && (a.status === 'confirmed' || a.status === 'requested')) f.status = 'in_house';
  if (f.status === 'confirmed' && !a.confirmed_at) f.confirmed_at = t;
  if (f.status === 'confirmed' && f.rooms_single_conf == null && f.rooms_double_conf == null && !a.rooms_single_conf && !a.rooms_double_conf) {
    f.rooms_single_conf = a.rooms_single_req; f.rooms_double_conf = a.rooms_double_req;
  }
  if (f.status === 'in_house') { if (!a.first_checkin_at) f.first_checkin_at = t; if (!a.confirmed_at) f.confirmed_at = t; }
  if (f.status === 'checked_out' && !a.checkout_at) f.checkout_at = t;
  if ((f.invoice_no || f.invoice_amount != null) && req.user.role === 'hotel' && a.invoice_status === 'awaited') f.invoice_status = 'received';
  if (f.invoice_status === 'approved' || f.invoice_status === 'disputed') { f.invoice_checked_by = req.user.id; f.invoice_checked_at = t; }
  updateRow('event_hotels', a.id, f);
  if (f.status && f.status !== a.status) {
    const rooms = (f.rooms_single_conf ?? a.rooms_single_conf) + (f.rooms_double_conf ?? a.rooms_double_conf);
    sys(a.event_id, req.user.id, `hotel_${f.status}`, { hotel: a.hotel_name, rooms, pax: f.pax_checked_in ?? a.pax_checked_in },
      ['confirmed', 'in_house', 'checked_out', 'refused'].includes(f.status) ? 'shared' : 'internal');
  } else if (f.pax_checked_in != null && f.pax_checked_in !== a.pax_checked_in) {
    sys(a.event_id, req.user.id, 'hotel_checkin_count', { hotel: a.hotel_name, pax: f.pax_checked_in });
  }
  if (f.invoice_status && f.invoice_status !== a.invoice_status) sys(a.event_id, req.user.id, `hotel_invoice_${f.invoice_status}`, { hotel: a.hotel_name, amount: f.invoice_amount ?? a.invoice_amount }, f.invoice_status === 'received' ? 'internal' : 'shared');
  audit(req.user.id, 'update', 'event_hotel', a.id, f);
  touch(a.event_id);
  rt.eventChanged(a.event_id);
  res.json({ ok: true });
});
router.delete('/event-hotels/:id', requireRole(...STAFF), (req, res) => {
  const a = db.prepare('SELECT * FROM event_hotels WHERE id = ?').get(Number(req.params.id));
  if (!a) return bad(res, 'not_found', 404);
  if (a.pax_checked_in > 0) return bad(res, 'guests_checked_in');
  db.prepare('DELETE FROM event_hotels WHERE id = ?').run(a.id);
  touch(a.event_id);
  rt.eventChanged(a.event_id);
  res.json({ ok: true });
});

/* missions */
function defaultLabels(ev, leg, hotelId) {
  const ap = db.prepare('SELECT name, code FROM airports WHERE code = ?').get(ev.airport_code);
  const h = hotelId ? db.prepare('SELECT name FROM hotels WHERE id = ?').get(hotelId) : null;
  const apLabel = ap ? `${ap.name} (${ap.code})` : ev.airport_code;
  if (leg === 'outbound') return [apLabel, h ? h.name : ''];
  if (leg === 'return') return [h ? h.name : '', apLabel];
  if (leg === 'intercity') {
    const d = db.prepare('SELECT name, code FROM airports WHERE code = ?').get(ev.dest_airport_code);
    return [apLabel, d ? `${d.name} (${d.code})` : ''];
  }
  return ['', ''];
}
router.post('/events/:id/missions', requireRole(...STAFF), (req, res) => {
  const ev = getEventOr404(req, res); if (!ev) return;
  const b = req.body || {};
  const leg = ['outbound', 'return', 'intercity', 'other'].includes(b.leg) ? b.leg : (ev.type === 'transfer' ? 'intercity' : 'outbound');
  const band = ['local', 'ic100', 'ic250', 'ic400'].includes(b.band) ? b.band : (leg === 'intercity' ? 'ic250' : 'local');
  const kind = ['coach', 'minibus', 'adapted'].includes(b.kind) ? b.kind : 'coach';
  const hotelId = int(b.hotel_id);
  const carrierId = int(b.carrier_id);
  const [fromD, toD] = defaultLabels(ev, leg, hotelId);
  const count = Math.min(20, Math.max(1, int(b.count) || 1));
  const ids = tx(() => {
    const out = [];
    for (let i = 0; i < count; i++) {
      const r = db.prepare(`INSERT INTO missions(event_id, leg, hotel_id, from_label, to_label, band, kind, carrier_id, scheduled_at, requested_at, notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(ev.id, leg, hotelId, str(b.from_label, 200) || fromD, str(b.to_label, 200) || toD, band, kind,
        carrierId, isoOrNull(b.scheduled_at), now(), str(b.notes, 1000));
      out.push(Number(r.lastInsertRowid));
    }
    return out;
  });
  const carrier = carrierId ? db.prepare('SELECT name FROM carriers WHERE id = ?').get(carrierId) : null;
  sys(ev.id, req.user.id, 'missions_requested', { count, leg, carrier: carrier ? carrier.name : null }, 'internal');
  touch(ev.id);
  rt.eventChanged(ev.id);
  res.json({ ids });
});

function getMissionOr404(req, res) {
  const m = db.prepare('SELECT * FROM missions WHERE id = ?').get(Number(req.params.id));
  if (!m) { bad(res, 'not_found', 404); return null; }
  const u = req.user;
  const ok = L.isStaff(u) || (u.role === 'carrier' && m.carrier_id === u.carrier_id) || (u.role === 'driver' && m.driver_id === u.id)
    || (u.role === 'agent' && L.canSeeEvent(u, m.event_id));
  if (!ok) { bad(res, 'forbidden', 403); return null; }
  return m;
}
router.patch('/missions/:id', requireRole('admin', 'desk', 'carrier', 'driver'), (req, res) => {
  const m = getMissionOr404(req, res); if (!m) return;
  const b = req.body || {};
  const f = {};
  if (L.isStaff(req.user)) {
    Object.assign(f, readFields(b, {
      leg: v => (['outbound', 'return', 'intercity', 'other'].includes(v) ? v : undefined),
      band: v => (['local', 'ic100', 'ic250', 'ic400'].includes(v) ? v : undefined),
      kind: v => (['coach', 'minibus', 'adapted'].includes(v) ? v : undefined),
      hotel_id: int, carrier_id: int, vehicle_id: int, driver_id: int, from_label: v => str(v, 200), to_label: v => str(v, 200),
      scheduled_at: isoOrNull, notes: v => str(v, 1000), pax_on_board: int
    }));
    if (req.user.role === 'admin') Object.assign(f, readFields(b, { price_sell: num, cost_buy: num }));
  } else if (req.user.role === 'carrier') {
    Object.assign(f, readFields(b, { vehicle_id: int, driver_id: int, notes: v => str(v, 1000) }));
    if (f.vehicle_id && !db.prepare('SELECT 1 FROM vehicles WHERE id = ? AND carrier_id = ?').get(f.vehicle_id, req.user.carrier_id)) return bad(res, 'vehicle_not_yours');
    if (f.driver_id && !db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'driver' AND carrier_id = ?").get(f.driver_id, req.user.carrier_id)) return bad(res, 'driver_not_yours');
  } else {
    Object.assign(f, readFields(b, { notes: v => str(v, 1000) }));
  }
  for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k];
  if (f.carrier_id !== undefined && f.carrier_id !== m.carrier_id) { f.vehicle_id = f.vehicle_id ?? null; f.driver_id = f.driver_id ?? null; }
  updateRow('missions', m.id, f);
  if (f.driver_id && f.driver_id !== m.driver_id) { try { agent.sendDriverManifest(m.id); } catch (_) { /* best effort */ } }
  if ((f.vehicle_id && f.vehicle_id !== m.vehicle_id) || (f.driver_id && f.driver_id !== m.driver_id)) {
    const v = db.prepare('SELECT plate FROM vehicles WHERE id = ?').get(f.vehicle_id ?? m.vehicle_id);
    const d = db.prepare('SELECT name FROM users WHERE id = ?').get(f.driver_id ?? m.driver_id);
    sys(m.event_id, req.user.id, 'mission_assigned', { mission: m.id, plate: v ? v.plate : null, driver: d ? d.name : null }, 'internal');
  }
  audit(req.user.id, 'update', 'mission', m.id, f);
  touch(m.event_id);
  rt.eventChanged(m.event_id);
  res.json({ ok: true });
});

const STATUS_BY_ROLE = {
  admin: L.MISSION_ORDER.concat(['cancelled', 'refused']),
  desk: L.MISSION_ORDER.concat(['cancelled', 'refused']),
  carrier: ['accepted', 'refused', 'en_route', 'at_pickup', 'boarding', 'departed', 'arrived', 'completed'],
  driver: ['accepted', 'en_route', 'at_pickup', 'boarding', 'departed', 'arrived', 'completed'],
  agent: ['at_pickup', 'boarding', 'departed', 'arrived']
};
router.post('/missions/:id/status', requireRole('admin', 'desk', 'carrier', 'driver', 'agent'), (req, res) => {
  const m = getMissionOr404(req, res); if (!m) return;
  const b = req.body || {};
  const status = String(b.status || '');
  if (!STATUS_BY_ROLE[req.user.role].includes(status)) return bad(res, 'status_not_allowed');
  const ev = db.prepare('SELECT status FROM events WHERE id = ?').get(m.event_id);
  if (ev.status === 'cancelled' && !L.isStaff(req.user)) return bad(res, 'event_cancelled');
  const t = now();
  const f = { status };
  const stamp = { accepted: 'accepted_at', en_route: 'en_route_at', at_pickup: 'at_pickup_at', boarding: 'boarding_at', departed: 'departed_at', arrived: 'arrived_at', completed: 'completed_at', cancelled: 'cancelled_at' }[status];
  if (stamp && !m[stamp]) f[stamp] = t;
  // fill earlier steps that were skipped, so timings stay coherent
  const idx = L.MISSION_ORDER.indexOf(status);
  if (idx > 0) {
    for (const st of L.MISSION_ORDER.slice(1, idx)) {
      const k = { accepted: 'accepted_at', en_route: 'en_route_at', at_pickup: 'at_pickup_at', boarding: 'boarding_at', departed: 'departed_at', arrived: 'arrived_at' }[st];
      if (k && !m[k] && !f[k]) f[k] = t;
    }
  }
  if (b.pax_on_board !== undefined && b.pax_on_board !== null && b.pax_on_board !== '') f.pax_on_board = int(b.pax_on_board);
  updateRow('missions', m.id, f);
  const full = db.prepare(`SELECT m.*, v.plate, h.name AS hotel_name FROM missions m LEFT JOIN vehicles v ON v.id = m.vehicle_id LEFT JOIN hotels h ON h.id = m.hotel_id WHERE m.id = ?`).get(m.id);
  const shared = ['accepted', 'at_pickup', 'departed', 'arrived', 'cancelled', 'refused'].includes(status);
  sys(m.event_id, req.user.id, `mission_${status}`, { mission: m.id, plate: full.plate, leg: full.leg, pax: full.pax_on_board, to: full.to_label }, shared ? 'shared' : 'internal');
  // automatic hotel arrival: when an outbound coach reaches the hotel, flag the allocation as in house
  if (status === 'arrived' && full.leg === 'outbound' && full.hotel_id) {
    const a = db.prepare("SELECT * FROM event_hotels WHERE event_id = ? AND hotel_id = ? AND status IN ('requested','confirmed')").get(m.event_id, full.hotel_id);
    if (a) {
      db.prepare("UPDATE event_hotels SET status = 'in_house', first_checkin_at = COALESCE(first_checkin_at, ?), confirmed_at = COALESCE(confirmed_at, ?) WHERE id = ?").run(t, t, a.id);
      sys(m.event_id, null, 'hotel_in_house', { hotel: full.hotel_name, pax: a.pax_checked_in }, 'shared');
    }
  }
  if (status === 'boarding' || status === 'departed') {
    if (full.leg === 'return' && full.hotel_id) {
      const a = db.prepare("SELECT * FROM event_hotels WHERE event_id = ? AND hotel_id = ? AND status = 'in_house'").get(m.event_id, full.hotel_id);
      if (a && status === 'departed') {
        const leaving = db.prepare("SELECT COALESCE(SUM(pax_on_board),0) AS n FROM missions WHERE event_id = ? AND leg = 'return' AND hotel_id = ? AND status IN ('departed','arrived','completed')").get(m.event_id, full.hotel_id).n;
        if (leaving >= a.pax_checked_in && a.pax_checked_in > 0) {
          db.prepare("UPDATE event_hotels SET status = 'checked_out', checkout_at = COALESCE(checkout_at, ?), pax_checked_out = ? WHERE id = ?").run(t, a.pax_checked_in, a.id);
          sys(m.event_id, null, 'hotel_checked_out', { hotel: full.hotel_name, pax: a.pax_checked_in }, 'shared');
        }
      }
    }
  }
  audit(req.user.id, 'mission_status', 'mission', m.id, f);
  touch(m.event_id);
  rt.eventChanged(m.event_id);
  res.json({ ok: true });
});
router.post('/missions/:id/position', requireRole('driver', 'carrier', 'admin', 'desk'), (req, res) => {
  const m = getMissionOr404(req, res); if (!m) return;
  const b = req.body || {};
  const lat = num(b.lat), lng = num(b.lng);
  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return bad(res, 'invalid_position');
  if (['completed', 'cancelled', 'refused'].includes(m.status)) return res.json({ ok: true, ignored: true });
  const t = now();
  const speed = num(b.speed), accuracy = num(b.accuracy);
  db.prepare('INSERT INTO positions(mission_id, lat, lng, accuracy, speed, at) VALUES (?,?,?,?,?,?)').run(m.id, lat, lng, accuracy, speed, t);
  db.prepare('UPDATE missions SET last_lat = ?, last_lng = ?, last_pos_at = ?, last_speed = ? WHERE id = ?').run(lat, lng, t, speed, m.id);
  rt.positionChanged(m.event_id, { mission_id: m.id, lat, lng, at: t, speed });
  res.json({ ok: true });
});
router.get('/missions/:id/track', requireAuth, (req, res) => {
  const m = db.prepare('SELECT * FROM missions WHERE id = ?').get(Number(req.params.id));
  if (!m || !L.canSeeEvent(req.user, m.event_id)) return bad(res, 'not_found', 404);
  if (req.user.role === 'hotel' && m.hotel_id !== req.user.hotel_id) return bad(res, 'forbidden', 403);
  res.json(db.prepare('SELECT lat, lng, at, speed FROM positions WHERE mission_id = ? ORDER BY at DESC LIMIT 500').all(m.id).reverse());
});
router.delete('/missions/:id', requireRole(...STAFF), (req, res) => {
  const m = getMissionOr404(req, res); if (!m) return;
  if (L.dispatched(m)) return bad(res, 'mission_already_dispatched');
  db.prepare('DELETE FROM missions WHERE id = ?').run(m.id);
  touch(m.event_id);
  rt.eventChanged(m.event_id);
  res.json({ ok: true });
});

router.get('/my/missions', requireRole('carrier', 'driver'), (req, res) => {
  const col = req.user.role === 'carrier' ? 'm.carrier_id' : 'm.driver_id';
  const val = req.user.role === 'carrier' ? req.user.carrier_id ?? -1 : req.user.id;
  const rows = db.prepare(`SELECT m.*, e.ref, e.flight_no, e.route, e.type AS event_type, e.status AS event_status, e.airport_code, e.pax_total,
      e.pax_prm, e.pax_um, e.new_departure, v.plate AS vehicle_plate, u.name AS driver_name, u.phone AS driver_phone, h.name AS hotel_name,
      h.address AS hotel_address, h.phone AS hotel_phone, h.lat AS hotel_lat, h.lng AS hotel_lng, a.name AS airport_name, a.lat AS airport_lat, a.lng AS airport_lng
    FROM missions m JOIN events e ON e.id = m.event_id JOIN airports a ON a.code = e.airport_code
    LEFT JOIN vehicles v ON v.id = m.vehicle_id LEFT JOIN users u ON u.id = m.driver_id LEFT JOIN hotels h ON h.id = m.hotel_id
    WHERE ${col} = ? AND (m.status NOT IN ('completed','cancelled','refused') OR m.requested_at > ?)
    ORDER BY CASE WHEN m.status IN ('completed','cancelled','refused') THEN 1 ELSE 0 END, COALESCE(m.scheduled_at, m.requested_at)`)
    .all(val, new Date(Date.now() - 3 * 86400000).toISOString());
  const S = getSettings();
  res.json(rows.map(r => {
    for (const k of COST_KEYS) delete r[k];
    delete r.price_sell; delete r.cost_buy;
    const dest = r.leg === 'intercity' ? db.prepare('SELECT a.* FROM events e JOIN airports a ON a.code = e.dest_airport_code WHERE e.id = ?').get(r.event_id) : null;
    r.dest_lat = dest ? dest.lat : null; r.dest_lng = dest ? dest.lng : null;
    r.desk_phone = S.company.desk_phone;
    try { r.stops = r.stops ? JSON.parse(r.stops) : null; } catch (_) { r.stops = null; }
    const col = r.leg === 'return' ? 'mission_ret_id' : 'mission_out_id';
    r.manifest = db.prepare(`SELECT p.name, p.pnr, p.prm, p.um, p.infant, h.name AS hotel_name FROM passengers p
      LEFT JOIN event_hotels eh ON eh.id = p.event_hotel_id LEFT JOIN hotels h ON h.id = eh.hotel_id WHERE p.${col} = ? ORDER BY h.name, p.group_key, p.name`).all(r.id);
    return r;
  }));
});

/* passengers */
router.get('/events/:id/passengers', requireRole('admin', 'desk', 'agent', 'ryanair', 'hotel'), (req, res) => {
  const ev = getEventOr404(req, res); if (!ev) return;
  let rows = db.prepare(`SELECT p.*, h.name AS hotel_name FROM passengers p LEFT JOIN event_hotels eh ON eh.id = p.event_hotel_id
    LEFT JOIN hotels h ON h.id = eh.hotel_id WHERE p.event_id = ? ORDER BY p.name`).all(ev.id);
  if (req.user.role === 'hotel') {
    const ids = new Set(db.prepare('SELECT id FROM event_hotels WHERE event_id = ? AND hotel_id = ?').all(ev.id, req.user.hotel_id).map(r => r.id));
    rows = rows.filter(p => ids.has(p.event_hotel_id)).map(p => ({ id: p.id, name: p.name, prm: p.prm, um: p.um, room_no: p.room_no, status: p.status, event_hotel_id: p.event_hotel_id }));
  }
  res.json(rows);
});
router.post('/events/:id/passengers', requireRole('admin', 'desk', 'agent', 'ryanair'), (req, res) => {
  const ev = getEventOr404(req, res); if (!ev) return;
  const list = Array.isArray((req.body || {}).passengers) ? req.body.passengers.slice(0, 400) : [];
  if (!list.length) return bad(res, 'empty_list');
  const t = now();
  const n = tx(() => {
    let c = 0;
    const ins = db.prepare('INSERT INTO passengers(event_id, name, pnr, phone, prm, um, updated_at) VALUES (?,?,?,?,?,?,?)');
    for (const p of list) {
      const name = str(p.name, 160);
      if (!name) continue;
      ins.run(ev.id, name, str(p.pnr, 20), str(p.phone, 40), bool(p.prm), bool(p.um), t); c++;
    }
    return c;
  });
  sys(ev.id, req.user.id, 'passengers_imported', { count: n }, 'internal');
  rt.eventChanged(ev.id);
  res.json({ count: n });
});
router.patch('/passengers/:id', requireRole('admin', 'desk', 'agent', 'hotel'), (req, res) => {
  const p = db.prepare('SELECT * FROM passengers WHERE id = ?').get(Number(req.params.id));
  if (!p || !L.canSeeEvent(req.user, p.event_id)) return bad(res, 'not_found', 404);
  const b = req.body || {};
  const spec = {
    status: v => (['expected', 'welcomed', 'boarded', 'at_hotel', 'returned', 'declined', 'no_show'].includes(v) ? v : undefined),
    event_hotel_id: int, room_no: v => str(v, 20), notes: v => str(v, 500), prm: bool, um: bool, name: v => str(v, 160), pnr: v => str(v, 20), phone: v => str(v, 40)
  };
  let allowed = null;
  if (req.user.role === 'hotel') {
    const a = p.event_hotel_id ? db.prepare('SELECT hotel_id FROM event_hotels WHERE id = ?').get(p.event_hotel_id) : null;
    if (!a || a.hotel_id !== req.user.hotel_id) return bad(res, 'forbidden', 403);
    allowed = ['room_no', 'status'];
  } else if (req.user.role === 'agent') allowed = ['status', 'event_hotel_id', 'room_no', 'notes'];
  const f = readFields(b, spec, allowed);
  for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k];
  if (f.event_hotel_id && !db.prepare('SELECT 1 FROM event_hotels WHERE id = ? AND event_id = ?').get(f.event_hotel_id, p.event_id)) return bad(res, 'invalid_hotel');
  f.updated_at = now();
  updateRow('passengers', p.id, f);
  rt.eventChanged(p.event_id, { passengers: true });
  res.json({ ok: true });
});
router.delete('/passengers/:id', requireRole(...STAFF), (req, res) => {
  const p = db.prepare('SELECT * FROM passengers WHERE id = ?').get(Number(req.params.id));
  if (!p) return bad(res, 'not_found', 404);
  db.prepare('DELETE FROM passengers WHERE id = ?').run(p.id);
  rt.eventChanged(p.event_id, { passengers: true });
  res.json({ ok: true });
});

/* attachments */
const MAX_UPLOAD = 8 * 1024 * 1024;
router.post('/events/:id/attachments', requireRole('admin', 'desk', 'agent', 'hotel', 'ryanair'), (req, res) => {
  const ev = getEventOr404(req, res); if (!ev) return;
  const b = req.body || {};
  const filename = (str(b.filename, 160) || 'document').replace(/[^\w.\- ()À-ÿ]/g, '_');
  const data = typeof b.data === 'string' ? Buffer.from(b.data.replace(/^data:[^;]+;base64,/, ''), 'base64') : null;
  if (!data || !data.length) return bad(res, 'empty_file');
  if (data.length > MAX_UPLOAD) return bad(res, 'file_too_large');
  let kind = ['hotel_invoice', 'rooming_list', 'manifest', 'report', 'photo', 'document'].includes(b.kind) ? b.kind : 'document';
  let ehId = int(b.event_hotel_id);
  if (req.user.role === 'hotel') {
    const a = db.prepare('SELECT id FROM event_hotels WHERE event_id = ? AND hotel_id = ?').get(ev.id, req.user.hotel_id);
    if (!a) return bad(res, 'forbidden', 403);
    ehId = a.id;
    if (!['hotel_invoice', 'rooming_list'].includes(kind)) kind = 'hotel_invoice';
  }
  if (req.user.role === 'ryanair') kind = 'manifest';
  const stored = `${ev.id}-${crypto.randomBytes(12).toString('hex')}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), data);
  const mime = str(b.mime, 100) || 'application/octet-stream';
  const r = db.prepare('INSERT INTO attachments(event_id, event_hotel_id, kind, filename, mime, size, stored_name, uploaded_by, at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(ev.id, ehId, kind, filename, mime, data.length, stored, req.user.id, now());
  sys(ev.id, req.user.id, 'attachment_added', { kind, filename }, 'internal');
  const attId = Number(r.lastInsertRowid);
  if (kind === 'manifest') {
    parser.parseFile(data, filename, mime).then(parsed => {
      if (parsed.stats.total) agent.createImport(ev.id, parsed, { attachmentId: attId, filename, userId: req.user.id });
      else L.addTimeline(ev.id, null, JSON.stringify({ c: 'agent_list_unreadable', p: { filename } }), { kind: 'agent', visibility: 'internal' });
      rt.eventChanged(ev.id, { agent: true });
    }).catch(e => { L.addTimeline(ev.id, null, JSON.stringify({ c: 'agent_list_unreadable', p: { filename, error: e.code || 'parse' } }), { kind: 'agent', visibility: 'internal' }); rt.eventChanged(ev.id); });
  }
  rt.eventChanged(ev.id);
  res.json({ id: attId });
});
router.get('/attachments/:id', requireAuth, (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(req.params.id));
  if (!a || !L.canSeeEvent(req.user, a.event_id)) return bad(res, 'not_found', 404);
  const r = req.user.role;
  if (r === 'carrier' || r === 'driver') return bad(res, 'forbidden', 403);
  if (r === 'hotel') {
    const eh = a.event_hotel_id ? db.prepare('SELECT hotel_id FROM event_hotels WHERE id = ?').get(a.event_hotel_id) : null;
    if (!eh || eh.hotel_id !== req.user.hotel_id) return bad(res, 'forbidden', 403);
  }
  if (r === 'ryanair' && !['hotel_invoice', 'report', 'rooming_list', 'manifest'].includes(a.kind)) return bad(res, 'forbidden', 403);
  const file = path.join(UPLOAD_DIR, a.stored_name);
  if (!fs.existsSync(file)) return bad(res, 'file_missing', 404);
  // only PDFs and images are displayed in the browser; anything else is downloaded and sandboxed
  const inline = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(a.mime);
  res.setHeader('Content-Type', inline ? a.mime : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!inline) res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  fs.createReadStream(file).pipe(res);
});
router.delete('/attachments/:id', requireRole(...STAFF), (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(req.params.id));
  if (!a) return bad(res, 'not_found', 404);
  db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
  try { fs.unlinkSync(path.join(UPLOAD_DIR, a.stored_name)); } catch (_) { /* already gone */ }
  rt.eventChanged(a.event_id);
  res.json({ ok: true });
});

/* billing */
router.post('/events/:id/extras', requireRole(...STAFF), (req, res) => {
  const ev = getEventOr404(req, res); if (!ev) return;
  if (ev.invoice_status === 'issued' || ev.invoice_status === 'paid') return bad(res, 'invoice_already_issued');
  const b = req.body || {};
  const label = str(b.label, 200);
  if (!label) return bad(res, 'label_required');
  db.prepare('INSERT INTO extra_lines(event_id, label, qty, unit_price, vat, cost) VALUES (?,?,?,?,?,?)')
    .run(ev.id, label, num(b.qty) ?? 1, num(b.unit_price) ?? 0, num(b.vat) ?? 20, req.user.role === 'admin' ? num(b.cost) : null);
  touch(ev.id); rt.eventChanged(ev.id);
  res.json({ ok: true });
});
router.delete('/extras/:id', requireRole(...STAFF), (req, res) => {
  const x = db.prepare('SELECT * FROM extra_lines WHERE id = ?').get(Number(req.params.id));
  if (!x) return bad(res, 'not_found', 404);
  const ev = db.prepare('SELECT invoice_status FROM events WHERE id = ?').get(x.event_id);
  if (ev.invoice_status === 'issued' || ev.invoice_status === 'paid') return bad(res, 'invoice_already_issued');
  db.prepare('DELETE FROM extra_lines WHERE id = ?').run(x.id);
  touch(x.event_id); rt.eventChanged(x.event_id);
  res.json({ ok: true });
});
router.post('/events/:id/invoice/issue', requireRole('admin'), (req, res) => {
  const ev = getEventOr404(req, res); if (!ev) return;
  if (ev.status !== 'closed' && ev.status !== 'cancelled') return bad(res, 'event_not_closed');
  if (ev.invoice_status === 'issued' || ev.invoice_status === 'paid') return bad(res, 'invoice_already_issued');
  const number = tx(() => {
    const S = getSettings();
    const n = ev.invoice_no || `${S.company.invoice_prefix}${new Date().getUTCFullYear()}-${String(S.company.next_invoice).padStart(4, '0')}`;
    if (!ev.invoice_no) saveSettingsSection('company', { ...S.company, next_invoice: S.company.next_invoice + 1 });
    db.prepare("UPDATE events SET invoice_status = 'issued', invoice_no = ?, invoice_issued_at = ?, updated_at = ? WHERE id = ?").run(n, now(), now(), ev.id);
    return n;
  });
  sys(ev.id, req.user.id, 'invoice_issued', { number });
  audit(req.user.id, 'invoice_issued', 'event', ev.id, number);
  rt.eventChanged(ev.id);
  sendEvent(req, res, ev.id);
});
router.post('/events/:id/invoice/paid', requireRole('admin'), (req, res) => {
  const ev = getEventOr404(req, res); if (!ev) return;
  if (ev.invoice_status !== 'issued') return bad(res, 'invoice_not_issued');
  db.prepare("UPDATE events SET invoice_status = 'paid', invoice_paid_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), ev.id);
  sys(ev.id, req.user.id, 'invoice_paid', {}, 'internal');
  audit(req.user.id, 'invoice_paid', 'event', ev.id);
  rt.eventChanged(ev.id);
  sendEvent(req, res, ev.id);
});
router.post('/events/:id/invoice/reopen', requireRole('admin'), (req, res) => {
  const ev = getEventOr404(req, res); if (!ev) return;
  if (ev.invoice_status !== 'issued') return bad(res, 'invoice_not_issued');
  db.prepare("UPDATE events SET invoice_status = 'draft', invoice_issued_at = NULL, updated_at = ? WHERE id = ?").run(now(), ev.id);
  sys(ev.id, req.user.id, 'invoice_reopened', { number: ev.invoice_no }, 'internal');
  audit(req.user.id, 'invoice_reopened', 'event', ev.id);
  rt.eventChanged(ev.id);
  sendEvent(req, res, ev.id);
});

router.get('/billing', requireRole('admin', 'desk', 'ryanair'), (req, res) => {
  const S = getSettings();
  const from = isoOrNull(req.query.from) || '0000';
  const to = isoOrNull(req.query.to) || '9999';
  const ids = db.prepare('SELECT id FROM events WHERE alert_at >= ? AND alert_at <= ? ORDER BY alert_at DESC LIMIT 1000').all(from, to);
  const out = [];
  for (const { id } of ids) {
    const ctx = L.loadEvent(id);
    const d = L.derive(ctx, S);
    const inv = L.computeInvoice(ctx, S, d, req.user.role === 'admin');
    out.push({
      id, ref: ctx.ev.ref, flight_no: ctx.ev.flight_no, airport_code: ctx.ev.airport_code, type: ctx.ev.type, status: ctx.ev.status,
      alert_at: ctx.ev.alert_at, closed_at: ctx.ev.closed_at, invoice_status: ctx.ev.invoice_status, invoice_no: ctx.ev.invoice_no,
      invoice_issued_at: ctx.ev.invoice_issued_at, invoice_paid_at: ctx.ev.invoice_paid_at, invoice_due_at: d.sla.invoice.due_at || null,
      ht: inv.ht, vat: inv.vat, ttc: inv.ttc, credit_pct: inv.credit_pct,
      costs: inv.costs, margin: inv.margin, margin_pct: inv.margin_pct, costs_incomplete: inv.costs_incomplete,
      hotel_invoices: inv.hotel_invoices
    });
  }
  res.json(out);
});

/* reports */
router.get('/reports', requireRole('admin', 'desk', 'ryanair'), (req, res) => {
  const S = getSettings();
  const from = isoOrNull(req.query.from) || new Date(Date.now() - 90 * 86400000).toISOString();
  const to = isoOrNull(req.query.to) || new Date().toISOString();
  const ids = db.prepare('SELECT id FROM events WHERE alert_at >= ? AND alert_at <= ? ORDER BY alert_at').all(from, to);
  const rep = {
    from, to, events: 0, hotel_events: 0, transfer_events: 0, cancelled: 0, pax_total: 0, pax_hosted: 0, pax_transferred: 0, rooms_used: 0, coaches: 0,
    by_airport: {}, sla: { plan: [0, 0], coach: [0, 0], accommodation: [0, 0], summary: [0, 0], invoice: [0, 0] },
    avg_plan_min: null, avg_coach_min: null, revenue_ht: 0, costs: 0, margin: 0, incidents: 0, rows: []
  };
  const planTimes = [], coachTimes = [];
  for (const { id } of ids) {
    const ctx = L.loadEvent(id);
    const d = L.derive(ctx, S);
    const inv = L.computeInvoice(ctx, S, d, req.user.role === 'admin');
    const e = ctx.ev;
    rep.events++;
    if (e.status === 'cancelled') rep.cancelled++;
    if (e.type === 'hotel') rep.hotel_events++; else rep.transfer_events++;
    rep.pax_total += e.pax_total;
    rep.pax_hosted += d.counts.hosted;
    if (e.type === 'transfer') rep.pax_transferred += d.counts.delivered_out;
    rep.rooms_used += d.counts.rooms_used;
    rep.coaches += ctx.missions.filter(L.dispatched).length;
    const ba = rep.by_airport[e.airport_code] || (rep.by_airport[e.airport_code] = { events: 0, pax: 0 });
    ba.events++; ba.pax += e.pax_total;
    for (const k of Object.keys(rep.sla)) {
      const s = d.sla[k];
      if (s && s.applicable && s.met !== null && s.met !== undefined) { rep.sla[k][1]++; if (s.met) rep.sla[k][0]++; }
    }
    if (d.sla.plan.done_at) planTimes.push(d.sla.plan.elapsed_min);
    if (d.sla.coach.applicable && d.sla.coach.done_at) coachTimes.push(d.sla.coach.elapsed_min);
    rep.incidents += ctx.timeline.filter(t => t.kind === 'incident').length;
    rep.revenue_ht += inv.ht;
    if (req.user.role === 'admin') { rep.costs += inv.costs; rep.margin += inv.margin; }
    rep.rows.push({ id, ref: e.ref, alert_at: e.alert_at, type: e.type, status: e.status, airport_code: e.airport_code, flight_no: e.flight_no,
      pax_total: e.pax_total, hosted: d.counts.hosted, plan_min: d.sla.plan.done_at ? d.sla.plan.elapsed_min : null,
      coach_min: d.sla.coach.done_at ? d.sla.coach.elapsed_min : null, plan_met: d.sla.plan.met, coach_met: d.sla.coach.met, ht: inv.ht,
      margin: req.user.role === 'admin' ? inv.margin : undefined });
  }
  const avg = a => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : null);
  rep.avg_plan_min = avg(planTimes); rep.avg_coach_min = avg(coachTimes);
  if (req.user.role !== 'admin') { delete rep.costs; delete rep.margin; }
  if (req.user.role === 'desk') { delete rep.revenue_ht; rep.rows.forEach(r => { delete r.ht; }); }
  res.json(rep);
});

router.get('/export/events.csv', requireRole('admin', 'ryanair'), (req, res) => {
  const S = getSettings();
  const from = isoOrNull(req.query.from) || '0000';
  const to = isoOrNull(req.query.to) || '9999';
  const ids = db.prepare('SELECT id FROM events WHERE alert_at >= ? AND alert_at <= ? ORDER BY alert_at').all(from, to);
  const head = ['ref', 'type', 'status', 'flight', 'route', 'airport', 'destination', 'alert_at', 'plan_confirmed_at', 'closed_at', 'pax_total',
    'pax_hosted', 'rooms_used', 'coaches', 'plan_min', 'coach_min', 'invoice_no', 'invoice_status', 'ht', 'vat', 'ttc'];
  if (req.user.role === 'admin') head.push('costs', 'margin');
  const esc = v => { const s = v == null ? '' : String(v); return /[";,\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [head.join(';')];
  for (const { id } of ids) {
    const ctx = L.loadEvent(id); const d = L.derive(ctx, S); const inv = L.computeInvoice(ctx, S, d, req.user.role === 'admin'); const e = ctx.ev;
    const row = [e.ref, e.type, e.status, e.flight_no, e.route, e.airport_code, e.dest_airport_code, e.alert_at, e.plan_confirmed_at, e.closed_at,
      e.pax_total, d.counts.hosted, d.counts.rooms_used, ctx.missions.filter(L.dispatched).length, d.sla.plan.done_at ? d.sla.plan.elapsed_min : '',
      d.sla.coach.done_at ? d.sla.coach.elapsed_min : '', e.invoice_no, e.invoice_status, inv.ht, inv.vat, inv.ttc];
    if (req.user.role === 'admin') row.push(inv.costs, inv.margin);
    lines.push(row.map(esc).join(';'));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="evenements.csv"');
  res.send('﻿' + lines.join('\n'));
});

/* live map + dashboard */
router.get('/live', requireAuth, (req, res) => {
  const f = L.eventFilterSql(req.user);
  const evs = db.prepare(`SELECT e.id, e.ref, e.flight_no, e.airport_code, e.type, e.status FROM events e
    WHERE ${f.sql} AND e.status NOT IN ('closed','cancelled')`).all(...f.args);
  const ids = evs.map(e => e.id);
  let missions = ids.length ? db.prepare(`SELECT m.id, m.event_id, m.leg, m.status, m.pax_on_board, m.last_lat, m.last_lng, m.last_pos_at, m.last_speed,
      m.from_label, m.to_label, m.carrier_id, m.driver_id, m.hotel_id, v.plate AS vehicle_plate, c.name AS carrier_name
    FROM missions m LEFT JOIN vehicles v ON v.id = m.vehicle_id LEFT JOIN carriers c ON c.id = m.carrier_id
    WHERE m.event_id IN (${ids.map(() => '?').join(',')}) AND m.status NOT IN ('cancelled','refused','completed')`).all(...ids) : [];
  if (req.user.role === 'carrier') missions = missions.filter(m => m.carrier_id === req.user.carrier_id);
  if (req.user.role === 'driver') missions = missions.filter(m => m.driver_id === req.user.id);
  if (req.user.role === 'hotel') missions = missions.filter(m => m.hotel_id === req.user.hotel_id);
  const hotels = ids.length ? db.prepare(`SELECT DISTINCT h.id, h.name, h.lat, h.lng, eh.event_id, eh.status, eh.pax_checked_in FROM event_hotels eh
    JOIN hotels h ON h.id = eh.hotel_id WHERE eh.event_id IN (${ids.map(() => '?').join(',')}) AND eh.status NOT IN ('refused','cancelled')`).all(...ids) : [];
  res.json({
    events: evs,
    missions,
    hotels: req.user.role === 'hotel' ? hotels.filter(h => h.id === req.user.hotel_id) : hotels,
    airports: db.prepare('SELECT code, name, city, category, lat, lng FROM airports WHERE active = 1').all()
  });
});

router.get('/dashboard', requireRole('admin', 'desk', 'ryanair', 'agent'), (req, res) => {
  const S = getSettings();
  const f = L.eventFilterSql(req.user);
  const active = db.prepare(`SELECT e.id FROM events e WHERE ${f.sql} AND e.status NOT IN ('closed','cancelled') ORDER BY e.alert_at DESC`).all(...f.args)
    .map(r => L.eventSummary(r.id, req.user, S));
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const month = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(pax_total),0) AS pax FROM events e WHERE ${f.sql} AND e.alert_at >= ?`).get(...f.args, monthStart.toISOString());
  const kpis = {
    active_events: active.length,
    pax_in_care: active.reduce((s, e) => s + (e.status === 'cancelled' ? 0 : e.pax_total), 0),
    hosted_now: active.reduce((s, e) => s + Math.max(0, e.counts.hosted - e.counts.checked_out), 0),
    coaches_moving: active.reduce((s, e) => s + e.counts.missions_moving, 0),
    coaches_on_site: active.reduce((s, e) => s + e.counts.missions_on_site, 0),
    rooms_conf: active.reduce((s, e) => s + e.counts.rooms_conf, 0),
    month_events: month.n, month_pax: month.pax,
    alerts_red: active.reduce((s, e) => s + (e.alerts || []).filter(a => a.level === 'red').length, 0),
    online_users: L.isStaff(req.user) ? rt.connectedCount() : undefined
  };
  if (L.isStaff(req.user)) {
    kpis.hotel_invoices_to_check = db.prepare("SELECT COUNT(*) AS n FROM event_hotels WHERE invoice_status = 'received'").get().n;
    kpis.invoices_to_issue = db.prepare("SELECT COUNT(*) AS n FROM events WHERE status IN ('closed','cancelled') AND invoice_status IN ('none','draft')").get().n;
  }
  const recent = L.isStaff(req.user) || req.user.role === 'ryanair'
    ? db.prepare(`SELECT t.id, t.event_id, t.at, t.kind, t.message, t.severity, t.visibility, e.ref, u.name AS user_name FROM timeline t
        JOIN events e ON e.id = t.event_id LEFT JOIN users u ON u.id = t.user_id
        ${req.user.role === 'ryanair' ? "WHERE t.visibility = 'shared'" : ''} ORDER BY t.at DESC, t.id DESC LIMIT 25`).all()
    : [];
  res.json({ kpis, active, recent });
});

router.get('/audit', requireRole('admin'), (req, res) => {
  const limit = Math.min(500, int(req.query.limit) || 200);
  res.json(db.prepare(`SELECT a.*, u.name AS user_name, u.role AS user_role FROM audit a LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.id DESC LIMIT ${limit}`).all());
});

/* ---------- public reply link (no account needed) ---------- */
const pubHits = new Map();
function publicLimit(req, res) {
  const t = Date.now(); const k = req.ip;
  const r = pubHits.get(k) || { n: 0, first: t };
  if (t - r.first > 600000) { r.n = 0; r.first = t; }
  r.n++; pubHits.set(k, r);
  if (r.n > 120) { bad(res, 'too_many_attempts', 429); return false; }
  return true;
}
function publicSol(token) {
  if (!/^[a-f0-9]{48}$/.test(String(token))) return null;
  return db.prepare(`SELECT s.*, e.flight_no, e.route, e.type AS event_type, e.status AS event_status, e.agent_state, e.pax_prm, e.alert_at,
      a.name AS airport_name, a.city AS airport_city, d.name AS dest_name, COALESCE(c.name, h.name) AS supplier_name
    FROM solicitations s JOIN events e ON e.id = s.event_id JOIN airports a ON a.code = e.airport_code LEFT JOIN airports d ON d.code = e.dest_airport_code
    LEFT JOIN carriers c ON c.id = s.carrier_id LEFT JOIN hotels h ON h.id = s.hotel_id WHERE s.token = ?`).get(token);
}
router.get('/public/sol/:token', (req, res) => {
  if (!publicLimit(req, res)) return;
  const s = publicSol(req.params.token);
  if (!s) return bad(res, 'not_found', 404);
  if (!s.viewed_at) db.prepare('UPDATE solicitations SET viewed_at = ? WHERE id = ?').run(now(), s.id);
  const S = getSettings();
  const closed = s.status === 'cancelled' || ['closed', 'cancelled'].includes(s.event_status) || s.agent_state === 'validated';
  res.json({
    company: S.company.name, desk_phone: S.company.desk_phone, kind: s.kind, supplier: s.supplier_name, flight: s.flight_no, route: s.route,
    airport: s.airport_name, city: s.airport_city, destination: s.event_type === 'transfer' ? s.dest_name : null, pax: s.pax_requested, prm: s.pax_prm,
    deadline_at: s.deadline_at, status: s.status, closed, defaults: { coach_seats: S.agent.coach_seats, minibus_seats: S.agent.minibus_seats },
    answer: s.answered_at ? { coaches: s.coaches, coach_seats: s.coach_seats, minibuses: s.minibuses, minibus_seats: s.minibus_seats, adapted: s.adapted, eta_min: s.eta_min,
      pax_capacity: s.pax_capacity, rooms_single: s.rooms_single, rooms_double: s.rooms_double, rooms_accessible: s.rooms_accessible, note: s.note, answered_at: s.answered_at } : null
  });
});
router.post('/public/sol/:token', (req, res) => {
  if (!publicLimit(req, res)) return;
  const s = publicSol(req.params.token);
  if (!s) return bad(res, 'not_found', 404);
  try { agent.answer(s.id, req.body || {}, 'email', null); res.json({ ok: true }); } catch (e) { agentErr(res, e); }
});

/* ---------- dispatch agent ---------- */
const agentErr = (res, e) => res.status(e.status || 400).json({ error: e.message || 'generic' });
function solOut(s) {
  const o = { ...s }; delete o.token; return o;
}
router.get('/events/:id/agent', requireRole('admin', 'desk', 'agent'), (req, res) => {
  const ev = getEventOr404(req, res); if (!ev) return;
  const sols = db.prepare(`SELECT s.*, COALESCE(c.name, h.name) AS name, COALESCE(c.phone, h.phone) AS phone, COALESCE(c.contact_name, h.contact_name) AS contact_name
    FROM solicitations s LEFT JOIN carriers c ON c.id = s.carrier_id LEFT JOIN hotels h ON h.id = s.hotel_id WHERE s.event_id = ? ORDER BY s.kind, s.id`).all(ev.id).map(solOut);
  const imports = db.prepare("SELECT * FROM imports WHERE event_id = ? AND status = 'pending' ORDER BY id DESC").all(ev.id).map(i => ({ ...i, data: JSON.parse(i.data) }));
  const plan = db.prepare("SELECT * FROM dispatch_plans WHERE event_id = ? AND status IN ('proposed','validated') ORDER BY id DESC LIMIT 1").get(ev.id);
  const outbox = L.isStaff(req.user) ? db.prepare('SELECT id, kind, to_email, to_name, subject, status, error, created_at, sent_at FROM outbox WHERE event_id = ? ORDER BY id DESC LIMIT 200').all(ev.id) : [];
  res.json({
    state: ev.agent_state, started_at: ev.agent_started_at, deadline_at: ev.agent_deadline_at, seats_announced: ev.agent_seats_announced,
    needs: agent.eventNeeds(ev), solicitations: sols, imports, plan: plan ? { ...plan, data: JSON.parse(plan.data) } : null,
    outbox, smtp_configured: mailer.configured()
  });
});
router.post('/events/:id/agent/import', requireRole('admin', 'desk', 'agent'), async (req, res) => {
  const ev = getEventOr404(req, res); if (!ev) return;
  const b = req.body || {};
  const filename = (str(b.filename, 160) || 'liste').replace(/[^\w.\- ()À-ÿ]/g, '_');
  const data = typeof b.data === 'string' ? Buffer.from(b.data.replace(/^data:[^;]+;base64,/, ''), 'base64') : (typeof b.text === 'string' ? Buffer.from(b.text, 'utf8') : null);
  if (!data || !data.length) return bad(res, 'empty_file');
  if (data.length > MAX_UPLOAD) return bad(res, 'file_too_large');
  let parsed;
  try { parsed = await parser.parseFile(data, b.text ? 'liste.txt' : filename, str(b.mime, 100) || ''); }
  catch (e) { return bad(res, e.code === 'old_word_format' ? 'old_word_format' : 'unreadable_file'); }
  if (!parsed.stats.total) return res.status(400).json({ error: 'no_passenger_found', skipped: parsed.skipped.slice(0, 10) });
  let attId = null;
  if (!b.text) {
    const stored = `${ev.id}-${crypto.randomBytes(12).toString('hex')}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, stored), data);
    attId = Number(db.prepare('INSERT INTO attachments(event_id, kind, filename, mime, size, stored_name, uploaded_by, at) VALUES (?,?,?,?,?,?,?,?)')
      .run(ev.id, 'manifest', filename, str(b.mime, 100) || 'application/octet-stream', data.length, stored, req.user.id, now()).lastInsertRowid);
  }
  const id = agent.createImport(ev.id, parsed, { attachmentId: attId, filename: b.text ? null : filename, userId: req.user.id });
  res.json({ id, parsed });
});
router.post('/events/:id/agent/imports/:iid/confirm', requireRole('admin', 'desk', 'agent'), (req, res) => {
  const ev = getEventOr404(req, res); if (!ev) return;
  const b = req.body || {};
  try { res.json({ count: agent.confirmImport(ev.id, Number(req.params.iid), b.passengers, b.mode === 'append' ? 'append' : 'replace', req.user.id) }); }
  catch (e) { agentErr(res, e); }
});
router.post('/events/:id/agent/imports/:iid/discard', requireRole('admin', 'desk', 'agent'), (req, res) => {
  const ev = getEventOr404(req, res); if (!ev) return;
  db.prepare("UPDATE imports SET status = 'discarded' WHERE id = ? AND event_id = ?").run(Number(req.params.iid), ev.id);
  rt.eventChanged(ev.id, { agent: true });
  res.json({ ok: true });
});
router.post('/events/:id/agent/launch', requireRole(...STAFF), (req, res) => {
  const ev = getEventOr404(req, res); if (!ev) return;
  try { res.json(agent.launch(ev.id, req.user.id, { force: !!(req.body || {}).force })); } catch (e) { agentErr(res, e); }
});
router.post('/events/:id/agent/solicit', requireRole(...STAFF), (req, res) => {
  const ev = getEventOr404(req, res); if (!ev) return;
  const b = req.body || {};
  try { agent.solicitExtra(ev.id, b.kind === 'hotel' ? 'hotel' : 'carrier', int(b.id), req.user.id); res.json({ ok: true }); } catch (e) { agentErr(res, e); }
});
router.post('/events/:id/agent/compute', requireRole(...STAFF), (req, res) => {
  const ev = getEventOr404(req, res); if (!ev) return;
  if (!['soliciting', 'proposed'].includes(ev.agent_state)) return bad(res, 'agent_not_running');
  const id = agent.maybePropose(ev.id, { force: true });
  if (!id) return bad(res, 'no_passengers');
  res.json({ plan_id: id });
});
router.post('/events/:id/agent/validate', requireRole(...STAFF), (req, res) => {
  const ev = getEventOr404(req, res); if (!ev) return;
  try { res.json(agent.validate(ev.id, int((req.body || {}).plan_id), req.user.id)); } catch (e) { agentErr(res, e); }
});
router.post('/solicitations/:id/remind', requireRole(...STAFF), (req, res) => {
  res.json({ ok: agent.remind(Number(req.params.id)) });
});
router.post('/solicitations/:id/answer', requireRole('admin', 'desk', 'carrier', 'hotel'), (req, res) => {
  const s = db.prepare('SELECT * FROM solicitations WHERE id = ?').get(Number(req.params.id));
  if (!s) return bad(res, 'not_found', 404);
  if (req.user.role === 'carrier' && !(s.kind === 'carrier' && s.carrier_id === req.user.carrier_id)) return bad(res, 'forbidden', 403);
  if (req.user.role === 'hotel' && !(s.kind === 'hotel' && s.hotel_id === req.user.hotel_id)) return bad(res, 'forbidden', 403);
  try { res.json(solOut(agent.answer(s.id, req.body || {}, L.isStaff(req.user) ? 'desk' : 'app', req.user.id))); } catch (e) { agentErr(res, e); }
});
router.get('/my/solicitations', requireRole('carrier', 'hotel'), (req, res) => {
  const col = req.user.role === 'carrier' ? 's.carrier_id' : 's.hotel_id';
  const val = req.user.role === 'carrier' ? req.user.carrier_id ?? -1 : req.user.hotel_id ?? -1;
  const rows = db.prepare(`SELECT s.*, e.ref, e.flight_no, e.route, e.type AS event_type, e.airport_code, e.dest_airport_code, e.pax_prm, e.agent_state,
      a.name AS airport_name, a.city AS airport_city FROM solicitations s JOIN events e ON e.id = s.event_id JOIN airports a ON a.code = e.airport_code
    WHERE ${col} = ? AND s.sent_at > ? AND e.status NOT IN ('closed','cancelled') ORDER BY s.id DESC`).all(val, new Date(Date.now() - 86400000).toISOString());
  res.json(rows.map(solOut));
});
router.get('/outbox/:id', requireRole(...STAFF), (req, res) => {
  const o = db.prepare('SELECT id, event_id, kind, to_email, to_name, subject, html, status, error, created_at, sent_at FROM outbox WHERE id = ?').get(Number(req.params.id));
  if (!o) return bad(res, 'not_found', 404);
  res.json(o);
});
router.post('/admin/smtp-test', requireRole('admin'), async (req, res) => {
  const v = await mailer.verify();
  if (v.ok) mailer.queue({ kind: 'test', to: req.user.email, subject: "Test d'envoi · Bandy's Care Ops", blocks: [{ p: "La messagerie est correctement configurée." }] });
  res.json(v);
});

/* database backup (admin) */
router.get('/admin/backup', requireRole('admin'), (req, res) => {
  const file = path.join(require('os').tmpdir(), `care-ops-backup-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  audit(req.user.id, 'backup_downloaded', 'system');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="care-ops-${new Date().toISOString().slice(0, 10)}.db"`);
  const stream = fs.createReadStream(file);
  stream.pipe(res);
  stream.on('close', () => fs.unlink(file, () => {}));
});

/* demo data */
router.post('/admin/demo', requireRole('admin'), (req, res) => {
  const demo = require('./demo');
  const r = demo.load(req.user.id);
  audit(req.user.id, 'demo_loaded', 'system', null, r);
  rt.refChanged('all');
  res.json(r);
});
router.delete('/admin/demo', requireRole('admin'), (req, res) => {
  const demo = require('./demo');
  const r = demo.purge();
  audit(req.user.id, 'demo_purged', 'system', null, r);
  rt.refChanged('all');
  res.json(r);
});

module.exports = router;
