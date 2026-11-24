'use strict';
// Passenger list reader for Ryanair lists sent as Word (.docx), PDF, CSV or plain text.
// Runs locally: no external AI service. Returns a preview the desk checks before saving.
const path = require('path');

const TITLES = ['MR', 'MRS', 'MS', 'MISS', 'MSTR', 'MSTRS', 'CHD', 'INF', 'DR', 'M', 'MME', 'MLLE', 'MASTER'];
const PRM_CODES = ['WCHR', 'WCHS', 'WCHC', 'BLND', 'DEAF', 'DPNA', 'MAAS', 'MEDA', 'PRM', 'PMR', 'WHEELCHAIR'];
const UM_CODES = ['UMNR', 'UM', 'UNACCOMPANIED'];
const HEADER = {
  name: /^(passenger|passager|pax)?\s*(full\s*)?(name|nom)s?\b|^passenger$|^passager$|nom\s*(et|&)\s*pr[ée]nom|name\s*\/\s*first/i,
  last: /^(last\s*name|surname|family\s*name|nom\s*de\s*famille|nom)$/i,
  first: /^(first\s*name|given\s*name|pr[ée]nom)s?$/i,
  title: /^(title|titre|civ(ilit[ée])?|salutation)$/i,
  pnr: /pnr|booking|r[ée]servation|record\s*loc|dossier|^ref/i,
  seat: /^(seat|si[èe]ge)s?$/i,
  ssr: /ssr|special|assist|pmr|prm|remarks?|remarques?|observations?/i,
  phone: /phone|t[ée]l[ée]?phone|^t[ée]l|contact|mobile|gsm/i,
  num: /^(no|n°|nr|#|seq|num[ée]ro)\.?$/i
};

const decode = s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const strip = s => decode(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/* ---------- text extraction ---------- */
async function extractDocx(buffer) {
  const mammoth = require('mammoth');
  const { value: htmlStr } = await mammoth.convertToHtml({ buffer });
  const rows = [];
  let rest = htmlStr;
  const tableRe = /<table[\s\S]*?<\/table>/gi;
  for (const table of htmlStr.match(tableRe) || []) {
    for (const tr of table.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
      const cells = (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(strip);
      if (cells.some(Boolean)) rows.push({ cells, table: true });
    }
  }
  rest = rest.replace(tableRe, '');
  for (const p of rest.match(/<(p|h\d|li)[^>]*>[\s\S]*?<\/\1>/gi) || []) {
    const text = strip(p);
    if (text) rows.push({ cells: [text], table: false });
  }
  return rows;
}

async function extractPdf(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, disableFontFace: true, isEvalSupported: false });
  const doc = await task.promise;
  const rows = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const items = content.items.filter(i => i.str && i.str.trim()).map(i => ({ x: i.transform[4], y: i.transform[5], w: i.width, s: i.str }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of items) {
      const line = lines.find(l => Math.abs(l.y - it.y) < 3);
      if (line) line.items.push(it); else lines.push({ y: it.y, items: [it] });
    }
    for (const l of lines) {
      l.items.sort((a, b) => a.x - b.x);
      const cells = [];
      let cur = null;
      for (const it of l.items) {
        if (cur && it.x - (cur.x + cur.w) < 6) { cur.s += (it.x - (cur.x + cur.w) > 1.5 ? ' ' : '') + it.s; cur.w = it.x + it.w - cur.x; }
        else { cur = { ...it }; cells.push(cur); }
      }
      rows.push({ cells: cells.map(c => c.s.trim()).filter(Boolean), table: cells.length > 1 });
    }
  }
  await task.destroy();
  return rows;
}

function extractText(buffer) {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  return text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
    const cells = l.includes('\t') ? l.split('\t') : (l.split(';').length > 2 ? l.split(';') : (l.split(',').length > 3 ? l.split(',') : [l]));
    return { cells: cells.map(c => c.trim().replace(/^"|"$/g, '')), table: cells.length > 1 };
  });
}

async function extractRows(buffer, filename = '', mime = '') {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.docx' || /wordprocessingml/.test(mime)) return extractDocx(buffer);
  if (ext === '.pdf' || mime === 'application/pdf' || buffer.slice(0, 4).toString() === '%PDF') return extractPdf(buffer);
  if (ext === '.doc') throw Object.assign(new Error('doc_format'), { code: 'old_word_format' });
  return extractText(buffer);
}

/* ---------- passenger detection ---------- */
const up = s => String(s || '').toUpperCase();
const isPnr = tok => /^[A-Z0-9]{6}$/.test(tok) && /[A-Z]/.test(tok) && /\d/.test(tok) && !/^FR\d{4}$/.test(tok);
function findCodes(text) {
  const words = up(text).split(/[^A-Z]+/).filter(Boolean);
  return {
    prm: words.some(w => PRM_CODES.includes(w)),
    um: words.some(w => UM_CODES.includes(w)),
    infant: words.includes('INF') || words.includes('INFT') || words.includes('INFANT') || words.includes('BEBE'),
    ssr: [...new Set(words.filter(w => PRM_CODES.includes(w) || UM_CODES.includes(w) || ['INF', 'INFT'].includes(w)))].join(' ')
  };
}
function titleCase(s) { return String(s).toLowerCase().replace(/(^|[\s'-])\p{L}/gu, m => m.toUpperCase()); }
function niceName(last, first) {
  const l = String(last || '').trim().toUpperCase();
  const f = titleCase(String(first || '').trim());
  return [l, f].filter(Boolean).join(' ');
}
function splitName(raw) {
  // "DUPONT/MARTIN MR", "Dupont, Martin", "MR Martin DUPONT", "Martin Dupont"
  let s = String(raw || '').replace(/\s+/g, ' ').trim();
  let title = null;
  const tm = s.match(new RegExp(`(?:^|\\s)(${TITLES.join('|')})\\.?$`, 'i'));
  if (tm) { title = tm[1].toUpperCase(); s = s.slice(0, tm.index).trim(); }
  const tb = s.match(new RegExp(`^(${TITLES.join('|')})\\.?\\s+`, 'i'));
  if (tb) { title = title || tb[1].toUpperCase(); s = s.slice(tb[0].length).trim(); }
  if (s.includes('/')) { const [l, f] = s.split('/'); return { name: niceName(l, f), title, surname: up(l).trim() }; }
  if (s.includes(',')) { const [l, f] = s.split(','); return { name: niceName(l, f), title, surname: up(l).trim() }; }
  const parts = s.split(' ').filter(Boolean);
  if (parts.length === 1) return { name: up(parts[0]), title, surname: up(parts[0]) };
  // an all-caps word is the surname
  const capIdx = parts.findIndex(p => p.length > 1 && p === p.toUpperCase() && /\p{L}/u.test(p));
  if (capIdx >= 0 && parts.some(p => p !== p.toUpperCase())) {
    const last = parts.filter(p => p === p.toUpperCase()).join(' ');
    const first = parts.filter(p => p !== p.toUpperCase()).join(' ');
    return { name: niceName(last, first), title, surname: up(last) };
  }
  const last = parts[parts.length - 1];
  return { name: niceName(last, parts.slice(0, -1).join(' ')), title, surname: up(last) };
}
const looksLikeName = s => /\p{L}{2,}/u.test(s) && !/\d{3,}/.test(s);
const SKIP_LINE = /\b(total|page|manifest|flight|vol\s|status|liste\s+des|passenger\s+list|passagers|passengers|printed|imprim|ryanair\s+dac)\b/i;

function mapHeader(cells) {
  const map = {};
  cells.forEach((c, i) => {
    const t = String(c).trim();
    for (const [k, re] of Object.entries(HEADER)) {
      if (map[k] == null && re.test(t)) { map[k] = i; break; }
    }
  });
  const hasName = map.name != null || map.last != null;
  return hasName && Object.keys(map).length >= 2 ? map : null;
}

function fromMappedRow(cells, map) {
  const get = k => (map[k] != null ? String(cells[map[k]] || '').trim() : '');
  let parsed;
  if (map.last != null && map.first != null) parsed = { name: niceName(get('last'), get('first')), title: null, surname: up(get('last')) };
  else parsed = splitName(get('name') || get('last'));
  const titleCell = up(get('title')).replace('.', '');
  if (titleCell && TITLES.includes(titleCell)) parsed.title = titleCell;
  const rowText = cells.join(' ');
  const codes = findCodes(`${get('ssr')} ${parsed.title || ''} ${rowText}`);
  const pnrCell = up(get('pnr')).replace(/\s/g, '');
  const pnr = isPnr(pnrCell) || /^[A-Z0-9]{5,8}$/.test(pnrCell) ? pnrCell : (rowText.toUpperCase().split(/[^A-Z0-9]+/).find(isPnr) || null);
  const seatCell = up(get('seat'));
  return {
    name: parsed.name, title: parsed.title, surname: parsed.surname, pnr,
    seat: /^\d{1,2}[A-K]$/.test(seatCell) ? seatCell : null,
    phone: (get('phone').match(/\+?\d[\d\s.-]{6,}\d/) || [null])[0],
    prm: codes.prm ? 1 : 0, um: codes.um ? 1 : 0, infant: codes.infant || parsed.title === 'INF' ? 1 : 0, ssr: codes.ssr || null
  };
}

function fromFreeLine(text) {
  let s = text.replace(/^\s*\d{1,4}[.)\-\s]+/, '').trim();
  const U = s.toUpperCase();
  const pnrM = U.match(/\b(?:PNR|BOOKING|R[ÉE]SA(?:RVATION)?|REF)\s*[:#]?\s*([A-Z0-9]{5,8})\b/) || [null, U.split(/[^A-Z0-9]+/).find(isPnr)];
  const pnr = pnrM && pnrM[1] ? pnrM[1] : null;
  const seat = (U.match(/\b(?:SEAT|SI[EÈ]GE)?\s*(\d{1,2}[A-F])\b/) || [null, null])[1];
  const phone = (s.match(/\+\d[\d\s.-]{7,}\d|\b0\d[\d\s.-]{7,}\d/) || [null])[0];
  const codes = findCodes(s);
  // name = text before the first separator, PNR or code
  let namePart = s.split(/\s[-–|]\s|\bPNR\b|\bBOOKING\b|\bR[ée]sa/i)[0];
  if (pnr) namePart = namePart.replace(new RegExp(`\\b${pnr}\\b`, 'i'), '');
  namePart = namePart.replace(/\b(WCHR|WCHS|WCHC|BLND|DEAF|DPNA|MAAS|MEDA|UMNR)\b/gi, '').replace(/\b\d{1,2}[A-F]\b/g, '').replace(/\+?\d[\d\s.-]{6,}\d/g, '').trim();
  if (!looksLikeName(namePart)) return null;
  const parsed = splitName(namePart);
  if (!parsed.name || parsed.name.length < 3) return null;
  // free text needs some evidence that the line is a passenger, not a heading or a sentence
  const words = namePart.split(/[\s/,]+/).filter(Boolean);
  const strong = pnr || parsed.title || /^[\p{L}' -]{2,40}\/\s*\p{L}/u.test(namePart) || /^[\p{L}' -]{2,40},\s*\p{Lu}/u.test(namePart) || codes.prm || codes.um || codes.infant;
  const properNoun = words.length >= 2 && words.length <= 5 && words.every(w => /^\p{Lu}/u.test(w));
  if (!strong && !properNoun) return null;
  return { name: parsed.name, title: parsed.title, surname: parsed.surname, pnr, seat, phone, prm: codes.prm ? 1 : 0, um: codes.um ? 1 : 0, infant: codes.infant || parsed.title === 'INF' ? 1 : 0, ssr: codes.ssr || null };
}

function parsePassengers(rows) {
  const passengers = [];
  const skipped = [];
  let map = null;
  let flight = null;
  for (const row of rows) {
    const cells = row.cells.map(c => String(c).trim()).filter((c, i, a) => row.table || c);
    const text = cells.join(' ').trim();
    if (!text) continue;
    const fm = text.toUpperCase().match(/\bFR\s?(\d{3,4})\b/);
    if (fm && !flight) flight = `FR ${fm[1]}`;
    const header = row.table ? mapHeader(cells) : null;
    if (header) { map = header; continue; }
    let p = null;
    if (map && row.table && cells.length >= Math.max(...Object.values(map)) - 1) {
      const nameCell = cells[map.name ?? map.last] || '';
      if (looksLikeName(nameCell) && !SKIP_LINE.test(nameCell)) p = fromMappedRow(cells, map);
    }
    if (!p && !SKIP_LINE.test(text)) p = fromFreeLine(text);
    if (p) passengers.push({ ...p, line: text.slice(0, 160) });
    else if (text.length > 2) skipped.push(text.slice(0, 160));
  }
  // families: same PNR; without PNR, consecutive passengers with the same surname
  let lastKey = null, lastSurname = null, n = 0;
  for (const p of passengers) {
    if (p.pnr) p.group_key = p.pnr;
    else if (lastSurname && p.surname === lastSurname && lastKey) p.group_key = lastKey;
    else p.group_key = `G${++n}`;
    lastKey = p.group_key; lastSurname = p.surname;
    delete p.surname;
  }
  const stats = {
    total: passengers.length,
    seats: passengers.filter(p => !p.infant).length,
    infants: passengers.filter(p => p.infant).length,
    prm: passengers.filter(p => p.prm).length,
    um: passengers.filter(p => p.um).length,
    groups: new Set(passengers.map(p => p.group_key)).size,
    without_pnr: passengers.filter(p => !p.pnr).length
  };
  return { flight, passengers, skipped: skipped.slice(0, 80), stats };
}

async function parseFile(buffer, filename, mime) {
  const rows = await extractRows(buffer, filename, mime);
  return parsePassengers(rows);
}

module.exports = { parseFile, parsePassengers, extractRows, splitName };
