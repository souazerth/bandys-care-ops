'use strict';
// Outgoing e-mail. Every message is stored in the outbox table first, then sent by SMTP when configured.
const { db, now, getSettings } = require('./db');

let transport = null;
let lastBaseUrl = null;

function smtpConfig() {
  const port = Number(process.env.SMTP_PORT) || 587;
  return {
    host: process.env.SMTP_HOST || '',
    port,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || process.env.SMTP_USER || ''
  };
}
function configured() { const c = smtpConfig(); return !!(c.host && c.from); }
function getTransport() {
  if (transport) return transport;
  const nodemailer = require('nodemailer');
  const c = smtpConfig();
  transport = nodemailer.createTransport({
    host: c.host, port: c.port, secure: c.secure,
    auth: c.user ? { user: c.user, pass: c.pass } : undefined,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000
  });
  return transport;
}

function rememberBaseUrl(req) {
  if (process.env.PUBLIC_URL || !req.headers.host) return;
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
  lastBaseUrl = `${proto}://${req.headers.host}`;
}
function baseUrl() { return (process.env.PUBLIC_URL || lastBaseUrl || 'http://localhost:3000').replace(/\/$/, ''); }

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Simple branded layout. blocks: [{ p }, { h }, { table: { head: [], rows: [[]] } }, { button: { label, url } }, { note }]
function render({ title, blocks }) {
  const S = getSettings();
  const company = S.company.name || "Bandy's Cars";
  const parts = [];
  const text = [];
  for (const b of blocks) {
    if (b.h) { parts.push(`<h3 style="margin:22px 0 8px;font-size:15px;color:#0F1B2D">${esc(b.h)}</h3>`); text.push('', b.h.toUpperCase()); }
    if (b.p) { parts.push(`<p style="margin:0 0 12px;line-height:1.5">${esc(b.p)}</p>`); text.push(b.p); }
    if (b.note) { parts.push(`<p style="margin:0 0 12px;padding:10px 12px;background:#FBF0DC;border-radius:6px;color:#6B4B14">${esc(b.note)}</p>`); text.push(b.note); }
    if (b.button) {
      parts.push(`<p style="margin:18px 0"><a href="${esc(b.button.url)}" style="display:inline-block;background:#B5602F;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">${esc(b.button.label)}</a></p>`);
      text.push(`${b.button.label} : ${b.button.url}`);
    }
    if (b.table) {
      const th = b.table.head.map(h => `<th style="text-align:left;padding:6px 8px;border-bottom:2px solid #E6E0D5;font-size:12px;color:#6B7280">${esc(h)}</th>`).join('');
      const tr = b.table.rows.map(r => `<tr>${r.map(c => `<td style="padding:6px 8px;border-bottom:1px solid #EFEAE1;font-size:13px">${esc(c)}</td>`).join('')}</tr>`).join('');
      parts.push(`<table style="border-collapse:collapse;width:100%;margin:6px 0 14px">${th ? `<thead><tr>${th}</tr></thead>` : ''}<tbody>${tr}</tbody></table>`);
      text.push(b.table.head.join(' | '));
      for (const r of b.table.rows) text.push(r.join(' | '));
    }
  }
  const html = `<!DOCTYPE html><html><body style="margin:0;background:#F5F2EC;font-family:Arial,Helvetica,sans-serif;color:#17202E">
<div style="max-width:680px;margin:0 auto;padding:24px">
<div style="background:#0F1B2D;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0;font-weight:700">${esc(company)} <span style="color:#E3C27E;font-weight:400">· Cellule 24/7</span></div>
<div style="background:#fff;padding:22px 20px;border-radius:0 0 10px 10px;border:1px solid #E6E0D5;border-top:0">
<h2 style="margin:0 0 14px;font-size:18px">${esc(title)}</h2>${parts.join('\n')}
<p style="margin:22px 0 0;font-size:12px;color:#6B7280">${esc(company)}${S.company.desk_phone ? ' · ' + esc(S.company.desk_phone) : ''}${S.company.desk_email ? ' · ' + esc(S.company.desk_email) : ''}</p>
</div></div></body></html>`;
  return { html, text: [title, '', ...text, '', company].join('\n') };
}

function queue({ eventId = null, kind = null, to, toName = null, subject, title, blocks, attachments = [] }) {
  const { html, text } = render({ title: title || subject, blocks });
  const status = !to ? 'no_address' : (configured() ? 'pending' : 'not_configured');
  const r = db.prepare(`INSERT INTO outbox(event_id, kind, to_email, to_name, subject, text, html, attachments, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(eventId, kind, to || null, toName, subject, text, html,
    attachments.length ? JSON.stringify(attachments.map(a => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64'), contentType: a.contentType }))) : null,
    status, now());
  const id = Number(r.lastInsertRowid);
  if (status === 'pending') setImmediate(() => sendRow(id).catch(() => {}));
  return id;
}

async function sendRow(id) {
  const row = db.prepare('SELECT * FROM outbox WHERE id = ?').get(id);
  if (!row || row.status === 'sent' || !configured()) return;
  try {
    const atts = row.attachments ? JSON.parse(row.attachments).map(a => ({ filename: a.filename, content: Buffer.from(a.content, 'base64'), contentType: a.contentType })) : [];
    await getTransport().sendMail({ from: smtpConfig().from, to: row.to_name ? `"${row.to_name.replace(/"/g, '')}" <${row.to_email}>` : row.to_email,
      subject: row.subject, text: row.text, html: row.html, attachments: atts });
    db.prepare("UPDATE outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1, error = NULL WHERE id = ?").run(now(), id);
  } catch (e) {
    db.prepare("UPDATE outbox SET status = 'failed', attempts = attempts + 1, error = ? WHERE id = ?").run(String(e.message || e).slice(0, 300), id);
  }
}

// retry failed messages (3 attempts) and send messages queued before SMTP was configured
async function retry() {
  if (!configured()) return;
  const fresh = new Date(Date.now() - 2 * 3600000).toISOString();
  const rows = db.prepare(`SELECT id FROM outbox WHERE ((status = 'failed' AND attempts < 3) OR status = 'pending' OR status = 'not_configured') AND created_at > ?
    ORDER BY id LIMIT 20`).all(fresh);
  for (const r of rows) {
    db.prepare("UPDATE outbox SET status = 'pending' WHERE id = ? AND status = 'not_configured'").run(r.id);
    await sendRow(r.id);
  }
}

async function verify() {
  if (!configured()) return { ok: false, error: 'not_configured' };
  try { await getTransport().verify(); return { ok: true }; } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

function csv(rows) {
  const q = v => { const s = v == null ? '' : String(v); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '﻿' + rows.map(r => r.map(q).join(';')).join('\n');
}

module.exports = { queue, sendRow, retry, verify, configured, smtpConfig, rememberBaseUrl, baseUrl, csv, render };
