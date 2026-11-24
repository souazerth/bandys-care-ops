'use strict';
const crypto = require('crypto');
const { db, now } = require('./db');

const COOKIE = 'cops_sid';
const SESSION_DAYS = 30;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [algo, saltHex, hashHex] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
  } catch (_) { return false; }
}
function randomPassword(len = 12) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createSession(res, userId, secure) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  db.prepare('INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(token, userId, now(), expires.toISOString());
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secure ? '; Secure' : ''}`);
  return token;
}
function clearSession(req, res, secure) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
}

const PUBLIC_USER_FIELDS = 'id, email, name, phone, role, lang, carrier_id, hotel_id, base_city, must_change_password, active';

function userFromRequest(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = db.prepare(`SELECT s.expires_at, ${PUBLIC_USER_FIELDS.split(', ').map(f => 'u.' + f).join(', ')}
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token);
  if (!row || !row.active) return null;
  if (row.expires_at < now()) { db.prepare('DELETE FROM sessions WHERE token = ?').run(token); return null; }
  delete row.expires_at;
  return row;
}

function authMiddleware(req, res, next) {
  req.user = userFromRequest(req);
  next();
}
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'auth_required' });
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'auth_required' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}

// Simple in-memory throttle for login attempts
const attempts = new Map();
function loginThrottle(key) {
  const t = Date.now();
  const rec = attempts.get(key) || { n: 0, first: t };
  if (t - rec.first > 15 * 60000) { rec.n = 0; rec.first = t; }
  rec.n += 1;
  attempts.set(key, rec);
  return rec.n <= 10;
}
function loginReset(key) { attempts.delete(key); }

module.exports = {
  hashPassword, verifyPassword, randomPassword, createSession, clearSession,
  authMiddleware, requireAuth, requireRole, loginThrottle, loginReset, PUBLIC_USER_FIELDS
};
