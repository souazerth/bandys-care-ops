'use strict';
// Dispatch agent: availability requests to coach operators and hotels, passenger dispatch, lists and notifications.
// Runs entirely inside the application (no external AI service).
const crypto = require('crypto');
const { db, now, getSettings, tx, audit } = require('./db');
const L = require('./logic');
const rt = require('./realtime');
const mailer = require('./mailer');

const TZ = 'Africa/Casablanca';
const hhmm = iso => (iso ? new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '');
const dayTime = iso => (iso ? new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '');
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const KIND_FR = { coach: 'Autocar', minibus: 'Minibus', adapted: 'Véhicule PMR' };

function log(eventId, code, params = {}, visibility = 'internal') {
  L.addTimeline(eventId, null, JSON.stringify({ c: code, p: params }), { kind: 'agent', visibility });
}
function notifySupplier(sol) {
  rt.notify(u => (sol.kind === 'carrier' ? u.role === 'carrier' && u.carrier_id === sol.carrier_id : u.role === 'hotel' && u.hotel_id === sol.hotel_id), { scope: 'sol', id: sol.id });
}

/* ---------- needs ---------- */
function eventNeeds(ev) {
  const p = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(infant),0) AS inf, COALESCE(SUM(prm),0) AS prm, COALESCE(SUM(um),0) AS um FROM passengers WHERE event_id = ? AND status NOT IN ('declined','no_show')").get(ev.id);
  if (p.n > 0) return { seats: p.n - p.inf, infants: p.inf, prm: p.prm, um: p.um, from: 'list' };
  const imp = db.prepare("SELECT data FROM imports WHERE event_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1").get(ev.id);
  if (imp) { const st = JSON.parse(imp.data).stats; return { seats: st.seats, infants: st.infants, prm: st.prm, um: st.um, from: 'import' }; }
  const seats = ev.type === 'hotel' ? (ev.pax_hotel ?? ev.pax_total) : ev.pax_total;
  return { seats, infants: 0, prm: ev.pax_prm, um: ev.pax_um, from: 'event' };
}

/* ---------- supplier selection ---------- */
function selectCarriers(airport, S, exclude = []) {
  const city = norm(airport.city);
  const score = c => (norm(c.city) === city ? 2 : 0) + (norm(c.regions).includes(city) ? 1 : 0) + (c.agreement_status === 'signed' ? 0.5 : 0);
  const all = db.prepare("SELECT * FROM carriers WHERE active = 1 AND agreement_status IN ('signed','negotiation')").all()
    .filter(c => !exclude.includes(c.id)).sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
  // operators based in or serving the airport city first; others only when fewer than two local ones exist
  const local = all.filter(c => score(c) >= 1);
  return (local.length >= 2 ? local : all).slice(0, S.agent.max_carriers);
}
function selectHotels(ev, S, exclude = []) {
  return db.prepare("SELECT * FROM hotels WHERE active = 1 AND agreement_status IN ('signed','negotiation') AND airport_code = ?").all(ev.airport_code)
    .filter(h => !exclude.includes(h.id)).sort((a, b) => (a.distance_min ?? 999) - (b.distance_min ?? 999)).slice(0, S.agent.max_hotels);
}

/* ---------- requests ---------- */
function requestEmail(sol, ev, airport, dest, entity, reminder = false) {
  const url = `${mailer.baseUrl()}/r/${sol.token}`;
  const S = getSettings();
  const wantedBy = new Date(new Date(ev.alert_at).getTime() + (airport.category === 2 ? S.sla.coach_cat2_min : S.sla.coach_cat1_min) * 60000).toISOString();
  const rows = [['Vol', `${ev.flight_no || '-'} ${ev.route || ''}`.trim()], ['Aéroport', airport.name],
    ...(sol.kind === 'carrier' && ev.type === 'transfer' && dest ? [['Destination', `${dest.name} (${dest.code})`]] : []),
    ['Passagers', `${sol.pax_requested}${ev.pax_prm ? ` dont ${ev.pax_prm} PMR` : ''}`],
    ...(sol.kind === 'carrier' ? [['Au terminal avant', hhmm(wantedBy)]] : [['Nuit du', dayTime(ev.alert_at).split(' ').slice(0, 2).join(' ')]]),
    ['Réponse attendue avant', hhmm(sol.deadline_at)]];
  const blocks = sol.kind === 'carrier'
    ? [{ p: `Bonjour ${entity.contact_name || entity.name},` },
      { p: `Ryanair nous demande de prendre en charge des passagers à ${airport.city}. Pouvez-vous nous indiquer combien d'autocars (50 places) et de minibus (17 places) vous pouvez fournir, et dans quel délai ?` },
      { table: { head: [], rows } }, { button: { label: 'Indiquer ma disponibilité', url } },
      { note: 'Vous pouvez aussi répondre depuis votre espace dans l\'application Bandy\'s Care Ops.' }]
    : [{ p: `Bonjour ${entity.contact_name || entity.name},` },
      { p: `Ryanair nous demande d'héberger cette nuit des passagers à ${airport.city}. Combien de passagers pouvez-vous accueillir, et combien de chambres single, double et accessibles sont disponibles ?` },
      { table: { head: [], rows } }, { button: { label: 'Indiquer ma disponibilité', url } },
      { note: 'Dîner et petit-déjeuner selon la convention. Les chambres sont facturées directement à Ryanair aux tarifs nets convenus.' }];
  const subject = `${reminder ? 'Relance : ' : ''}${sol.kind === 'carrier' ? 'Disponibilité autocars' : 'Disponibilité chambres'} · ${sol.pax_requested} passagers · ${airport.city} · réponse avant ${hhmm(sol.deadline_at)}`;
  mailer.queue({ eventId: ev.id, kind: sol.kind === 'carrier' ? 'carrier_request' : 'hotel_request', to: entity.email, toName: entity.contact_name || entity.name, subject, blocks });
}

function createSolicitation(ev, airport, dest, kind, entity, seats, deadline) {
  const token = crypto.randomBytes(24).toString('hex');
  const r = db.prepare(`INSERT INTO solicitations(event_id, kind, carrier_id, hotel_id, token, status, email_to, pax_requested, sent_at, deadline_at)
    VALUES (?,?,?,?,?,'sent',?,?,?,?)`).run(ev.id, kind, kind === 'carrier' ? entity.id : null, kind === 'hotel' ? entity.id : null, token, entity.email || null, seats, now(), deadline);
  const sol = db.prepare('SELECT * FROM solicitations WHERE id = ?').get(Number(r.lastInsertRowid));
  requestEmail(sol, ev, airport, dest, entity);
  notifySupplier(sol);
  return sol;
}

function launch(eventId, userId, { force = false } = {}) {
  const S = getSettings();
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!ev) throw Object.assign(new Error('not_found'), { status: 404 });
  if (ev.status === 'closed' || ev.status === 'cancelled') throw Object.assign(new Error('event_closed'), { status: 400 });
  if (ev.agent_state === 'validated') throw Object.assign(new Error('plan_already_validated'), { status: 400 });
  if (ev.agent_state !== 'idle' && !force) return { already: true };
  const needs = eventNeeds(ev);
  if (!needs.seats) throw Object.assign(new Error('no_passengers'), { status: 400 });
  const airport = db.prepare('SELECT * FROM airports WHERE code = ?').get(ev.airport_code);
  const dest = ev.dest_airport_code ? db.prepare('SELECT * FROM airports WHERE code = ?').get(ev.dest_airport_code) : null;
  const deadline = new Date(Date.now() + S.agent.reply_window_min * 60000).toISOString();
  let carriers = [], hotels = [];
  tx(() => {
    if (force) {
      db.prepare("UPDATE solicitations SET status = 'cancelled' WHERE event_id = ? AND status = 'sent'").run(ev.id);
      db.prepare("UPDATE dispatch_plans SET status = 'superseded' WHERE event_id = ? AND status = 'proposed'").run(ev.id);
    }
    db.prepare("UPDATE events SET agent_state = 'soliciting', agent_started_at = ?, agent_deadline_at = ?, agent_seats_announced = ?, updated_at = ? WHERE id = ?")
      .run(now(), deadline, needs.seats, now(), ev.id);
  });
  const fresh = db.prepare('SELECT * FROM events WHERE id = ?').get(ev.id);
  const answeredCarriers = db.prepare("SELECT carrier_id FROM solicitations WHERE event_id = ? AND kind = 'carrier' AND status IN ('answered','declined')").all(ev.id).map(r => r.carrier_id);
  const answeredHotels = db.prepare("SELECT hotel_id FROM solicitations WHERE event_id = ? AND kind = 'hotel' AND status IN ('answered','declined')").all(ev.id).map(r => r.hotel_id);
  carriers = selectCarriers(airport, S, answeredCarriers);
  for (const c of carriers) createSolicitation(fresh, airport, dest, 'carrier', c, needs.seats, deadline);
  if (ev.type === 'hotel') {
    hotels = selectHotels(ev, S, answeredHotels);
    for (const h of hotels) createSolicitation(fresh, airport, dest, 'hotel', h, needs.seats, deadline);
  }
  // local agent: the field agent based in the airport city, if none is assigned yet
  if (!db.prepare('SELECT 1 FROM event_agents WHERE event_id = ?').get(ev.id)) {
    const agentUser = db.prepare("SELECT * FROM users WHERE role = 'agent' AND active = 1").all().find(u => norm(u.base_city) === norm(airport.city));
    if (agentUser) {
      db.prepare('INSERT OR IGNORE INTO event_agents(event_id, user_id, assigned_at) VALUES (?,?,?)').run(ev.id, agentUser.id, now());
      log(ev.id, 'agent_assigned_local', { name: agentUser.name });
    }
  }
  log(ev.id, 'agent_solicited', { seats: needs.seats, carriers: carriers.map(c => c.name), hotels: hotels.map(h => h.name), deadline });
  if (!carriers.length) log(ev.id, 'agent_no_carrier');
  if (ev.type === 'hotel' && !hotels.length) log(ev.id, 'agent_no_hotel');
  audit(userId, 'agent_launch', 'event', ev.id, { carriers: carriers.length, hotels: hotels.length });
  rt.eventChanged(ev.id, { agent: true });
  return { carriers: carriers.length, hotels: hotels.length, deadline };
}

function solicitExtra(eventId, kind, entityId, userId) {
  const S = getSettings();
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!ev || ev.agent_state === 'idle' || ev.agent_state === 'validated') throw Object.assign(new Error('agent_not_running'), { status: 400 });
  const entity = db.prepare(`SELECT * FROM ${kind === 'carrier' ? 'carriers' : 'hotels'} WHERE id = ? AND active = 1`).get(entityId);
  if (!entity) throw Object.assign(new Error('not_found'), { status: 404 });
  if (db.prepare(`SELECT 1 FROM solicitations WHERE event_id = ? AND ${kind === 'carrier' ? 'carrier_id' : 'hotel_id'} = ? AND status <> 'cancelled'`).get(eventId, entityId))
    throw Object.assign(new Error('already_solicited'), { status: 400 });
  const airport = db.prepare('SELECT * FROM airports WHERE code = ?').get(ev.airport_code);
  const dest = ev.dest_airport_code ? db.prepare('SELECT * FROM airports WHERE code = ?').get(ev.dest_airport_code) : null;
  const deadline = ev.agent_deadline_at && ev.agent_deadline_at > now() ? ev.agent_deadline_at : new Date(Date.now() + S.agent.reply_window_min * 60000).toISOString();
  if (ev.agent_state === 'proposed') db.prepare("UPDATE events SET agent_state = 'soliciting', agent_deadline_at = ? WHERE id = ?").run(deadline, eventId);
  createSolicitation(db.prepare('SELECT * FROM events WHERE id = ?').get(eventId), airport, dest, kind, entity, eventNeeds(ev).seats, deadline);
  log(eventId, 'agent_solicited_extra', { name: entity.name });
  audit(userId, 'agent_solicit_extra', kind, entityId);
  rt.eventChanged(eventId, { agent: true });
}

function remind(solId) {
  const sol = db.prepare('SELECT * FROM solicitations WHERE id = ?').get(solId);
  if (!sol || sol.status !== 'sent') return false;
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(sol.event_id);
  const airport = db.prepare('SELECT * FROM airports WHERE code = ?').get(ev.airport_code);
  const dest = ev.dest_airport_code ? db.prepare('SELECT * FROM airports WHERE code = ?').get(ev.dest_airport_code) : null;
  const entity = db.prepare(`SELECT * FROM ${sol.kind === 'carrier' ? 'carriers' : 'hotels'} WHERE id = ?`).get(sol.carrier_id || sol.hotel_id);
  requestEmail(sol, ev, airport, dest, entity, true);
  db.prepare('UPDATE solicitations SET reminded_at = ? WHERE id = ?').run(now(), sol.id);
  log(ev.id, 'agent_reminder', { name: entity.name });
  rt.eventChanged(ev.id, { agent: true });
  return true;
}

/* ---------- answers ---------- */
const nn = v => (v === '' || v == null || isNaN(Number(v)) ? null : Math.max(0, Math.round(Number(v))));
function answer(solId, body, via, userId) {
  const S = getSettings();
  const sol = db.prepare('SELECT * FROM solicitations WHERE id = ?').get(solId);
  if (!sol) throw Object.assign(new Error('not_found'), { status: 404 });
  if (sol.status === 'cancelled') throw Object.assign(new Error('request_closed'), { status: 400 });
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(sol.event_id);
  if (ev.status === 'closed' || ev.status === 'cancelled' || ev.agent_state === 'validated') throw Object.assign(new Error('request_closed'), { status: 400 });
  const f = { note: body.note ? String(body.note).slice(0, 500) : null };
  if (sol.kind === 'carrier') {
    Object.assign(f, { coaches: nn(body.coaches) ?? 0, coach_seats: nn(body.coach_seats) || S.agent.coach_seats, minibuses: nn(body.minibuses) ?? 0,
      minibus_seats: nn(body.minibus_seats) || S.agent.minibus_seats, adapted: nn(body.adapted) ?? 0, adapted_seats: nn(body.adapted_seats) || S.agent.adapted_seats,
      eta_min: nn(body.eta_min) });
  } else {
    Object.assign(f, { pax_capacity: nn(body.pax_capacity) ?? 0, rooms_single: nn(body.rooms_single), rooms_double: nn(body.rooms_double), rooms_accessible: nn(body.rooms_accessible) });
    if (!f.pax_capacity && (f.rooms_single || f.rooms_double)) f.pax_capacity = (f.rooms_single || 0) + 2 * (f.rooms_double || 0);
  }
  const capacity = sol.kind === 'carrier' ? f.coaches + f.minibuses + f.adapted : f.pax_capacity;
  const declined = body.decline === true || body.decline === 1 || body.decline === 'true' || !capacity;
  f.status = declined ? 'declined' : 'answered';
  f.answered_at = now(); f.answered_via = via; f.answered_by = userId || null;
  const keys = Object.keys(f);
  db.prepare(`UPDATE solicitations SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => f[k]), sol.id);
  const name = db.prepare(`SELECT name FROM ${sol.kind === 'carrier' ? 'carriers' : 'hotels'} WHERE id = ?`).get(sol.carrier_id || sol.hotel_id).name;
  const summary = declined ? null : (sol.kind === 'carrier'
    ? { coaches: f.coaches, minibuses: f.minibuses, adapted: f.adapted, eta: f.eta_min }
    : { pax: f.pax_capacity, single: f.rooms_single, double: f.rooms_double });
  log(ev.id, declined ? 'agent_reply_declined' : (sol.kind === 'carrier' ? 'agent_reply_carrier' : 'agent_reply_hotel'), { name, via, ...(summary || {}) });
  audit(userId, 'solicitation_answer', 'solicitation', sol.id, { via, ...f });
  notifySupplier(sol);
  rt.eventChanged(ev.id, { agent: true });
  // a reply arriving after a plan was proposed refreshes that plan
  maybePropose(ev.id, { force: ev.agent_state === 'proposed' });
  return db.prepare('SELECT * FROM solicitations WHERE id = ?').get(sol.id);
}

/* ---------- dispatch ---------- */
function haversineKm(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const hasPos = x => x && x.lat != null && x.lng != null;
function gapMinutes(a, b) {
  if (a === b) return 0;
  if (hasPos(a) && hasPos(b)) return Math.round(haversineKm(a, b) * 1.3 / 30 * 60); // road distance about 1.3 times straight line, 30 km/h in town
  if (a.distance_min != null && b.distance_min != null) return Math.abs(a.distance_min - b.distance_min);
  return Infinity;
}
function fromAirport(node, airport) {
  if (node.distance_min != null) return node.distance_min;
  if (hasPos(node) && hasPos(airport)) return Math.round(haversineKm(node, airport) * 1.3 / 30 * 60);
  return 999;
}

function computePlan(eventId) {
  const S = getSettings();
  const A = S.agent;
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  const airport = db.prepare('SELECT * FROM airports WHERE code = ?').get(ev.airport_code);
  const dest = ev.dest_airport_code ? db.prepare('SELECT * FROM airports WHERE code = ?').get(ev.dest_airport_code) : null;
  const pax = db.prepare("SELECT * FROM passengers WHERE event_id = ? AND status NOT IN ('declined','no_show') ORDER BY id").all(eventId);
  const sols = db.prepare(`SELECT s.*, c.name AS carrier_name, h.name AS hotel_name, h.lat, h.lng, h.distance_min
    FROM solicitations s LEFT JOIN carriers c ON c.id = s.carrier_id LEFT JOIN hotels h ON h.id = s.hotel_id
    WHERE s.event_id = ? AND s.status = 'answered'`).all(eventId);
  const warnings = [];

  // families (same PNR) travel and sleep together
  const gmap = new Map();
  for (const p of pax) {
    const k = p.group_key || ('P' + p.id);
    if (!gmap.has(k)) gmap.set(k, { key: k, members: [] });
    gmap.get(k).members.push(p);
  }
  const groups = [...gmap.values()].map(g => ({
    ...g, seats: Math.max(1, g.members.filter(m => !m.infant).length), prm: g.members.filter(m => m.prm).length,
    wheelchair: g.members.some(m => /WCHC|WCHS/.test(m.ssr || '')), um: g.members.some(m => m.um)
  }));

  // 1. hotels
  let nodes = [];
  const unassignedHotel = [];
  if (ev.type === 'hotel') {
    const offers = sols.filter(s => s.kind === 'hotel' && s.pax_capacity > 0).map(s => ({
      type: 'hotel', id: s.hotel_id, name: s.hotel_name, cap: s.pax_capacity, rem: s.pax_capacity, accRem: s.rooms_accessible,
      rooms_single: s.rooms_single, rooms_double: s.rooms_double, lat: s.lat, lng: s.lng, distance_min: s.distance_min, groups: []
    })).sort((a, b) => fromAirport(a, airport) - fromAirport(b, airport) || b.cap - a.cap);
    if (!offers.length) warnings.push({ code: 'no_hotel_offer' });
    const order = [...groups].sort((a, b) => (b.prm > 0) - (a.prm > 0) || (b.um ? 1 : 0) - (a.um ? 1 : 0) || b.seats - a.seats);
    for (const g of order) {
      let h = offers.find(o => o.rem >= g.seats && (!g.prm || o.accRem == null || o.accRem >= g.prm));
      if (!h && g.prm) { h = offers.find(o => o.rem >= g.seats); if (h) warnings.push({ code: 'prm_room', params: { name: h.name } }); }
      if (h) { h.groups.push(g); h.rem -= g.seats; if (g.prm && h.accRem != null) h.accRem = Math.max(0, h.accRem - g.prm); continue; }
      const free = offers.reduce((s, o) => s + Math.max(0, o.rem), 0);
      if (free >= g.seats && g.seats > 1) {
        const left = [...g.members]; let part = 0;
        for (const o of offers) {
          if (!left.length || o.rem <= 0) continue;
          const take = []; let seats = 0;
          while (left.length && (left[0].infant || seats < o.rem)) { const m = left.shift(); take.push(m); if (!m.infant) seats++; }
          if (take.length) { o.groups.push({ ...g, key: `${g.key}#${++part}`, members: take, seats: Math.max(1, seats) }); o.rem -= seats; }
        }
        warnings.push({ code: 'group_split', params: { group: g.key, size: g.members.length } });
      } else unassignedHotel.push(...g.members);
    }
    nodes = offers.filter(o => o.groups.length);
    if (unassignedHotel.length) warnings.push({ code: 'hotels_short', params: { n: unassignedHotel.length } });
  } else if (dest) {
    nodes = [{ type: 'airport', id: dest.code, name: `${dest.name} (${dest.code})`, lat: dest.lat, lng: dest.lng, groups }];
  }

  // 2. vehicles offered by the coach operators
  const pool = [];
  for (const s of sols.filter(x => x.kind === 'carrier')) {
    const base = { carrier_id: s.carrier_id, carrier_name: s.carrier_name, eta: s.eta_min ?? 60 };
    for (let i = 0; i < (s.adapted || 0); i++) pool.push({ ...base, kind: 'adapted', seats: s.adapted_seats || A.adapted_seats });
    for (let i = 0; i < (s.coaches || 0); i++) pool.push({ ...base, kind: 'coach', seats: s.coach_seats || A.coach_seats });
    for (let i = 0; i < (s.minibuses || 0); i++) pool.push({ ...base, kind: 'minibus', seats: s.minibus_seats || A.minibus_seats });
  }
  if (!pool.length) warnings.push({ code: 'no_vehicle_offer' });
  pool.sort((a, b) => a.eta - b.eta || b.seats - a.seats);
  const take = pred => { const i = pool.findIndex(pred); return i >= 0 ? pool.splice(i, 1)[0] : null; };
  const vehicles = [];
  const unassignedVehicle = [];
  const open = (v, node) => { const veh = { ...v, stops: [{ node, groups: [] }], load: 0 }; vehicles.push(veh); return veh; };

  // wheelchair users first, in adapted vehicles when offered
  for (const node of nodes) {
    for (const g of node.groups.filter(x => x.wheelchair)) {
      let veh = vehicles.find(v => v.kind === 'adapted' && v.stops[0].node === node && v.seats - v.load >= g.seats);
      if (!veh) { const a = take(x => x.kind === 'adapted' && x.seats >= g.seats); if (a) veh = open(a, node); }
      if (veh) { veh.stops[0].groups.push(g); veh.load += g.seats; g.placed = true; } else warnings.push({ code: 'prm_no_adapted', params: { n: g.prm } });
    }
  }
  const seatsOf = list => list.reduce((s, g) => s + g.seats, 0);
  for (const node of [...nodes].sort((a, b) => seatsOf(b.groups) - seatsOf(a.groups))) {
    const rest = node.groups.filter(g => !g.placed).sort((a, b) => b.seats - a.seats);
    // top up adapted vehicles already going there
    for (const v of vehicles.filter(x => x.stops[0].node === node)) {
      for (let i = 0; i < rest.length;) { if (v.load + rest[i].seats <= v.seats) { v.stops[0].groups.push(rest[i]); v.load += rest[i].seats; rest.splice(i, 1); } else i++; }
    }
    while (rest.length) {
      const need = seatsOf(rest);
      const maxMini = Math.max(0, ...pool.filter(v => v.kind === 'minibus').map(v => v.seats));
      const v = need <= maxMini
        ? (take(x => x.kind === 'minibus' && x.seats >= need) || take(x => x.kind === 'coach') || take(() => true))
        : (take(x => x.kind === 'coach' && x.seats >= Math.min(need, x.seats)) || take(x => x.kind !== 'adapted') || take(() => true));
      if (!v) { for (const g of rest) unassignedVehicle.push(...g.members); break; }
      const veh = open(v, node);
      for (let i = 0; i < rest.length;) { if (veh.load + rest[i].seats <= veh.seats) { veh.stops[0].groups.push(rest[i]); veh.load += rest[i].seats; rest.splice(i, 1); } else i++; }
      if (!veh.load && rest.length) {
        // a family larger than the vehicle: split it
        const g = rest.shift();
        const inVeh = [], out = [...g.members]; let seats = 0;
        while (out.length && (out[0].infant || seats < veh.seats)) { const m = out.shift(); inVeh.push(m); if (!m.infant) seats++; }
        veh.stops[0].groups.push({ ...g, key: g.key + '#a', members: inVeh, seats }); veh.load += seats;
        if (out.length) rest.unshift({ ...g, key: g.key + '#b', members: out, seats: Math.max(1, out.filter(m => !m.infant).length) });
        warnings.push({ code: 'group_split_vehicle', params: { group: g.key } });
      }
    }
  }

  // 3. two stops at most, for hotels close to each other, when it saves a vehicle
  if (A.multi_stop && ev.type === 'hotel') {
    let improved = true;
    while (improved) {
      improved = false;
      const smalls = vehicles.filter(v => v.stops.length === 1 && v.kind !== 'adapted').sort((a, b) => a.load - b.load);
      outer: for (const small of smalls) {
        const hosts = vehicles.filter(h => h !== small && h.kind !== 'adapted' && h.stops.length < 2 && h.seats - h.load >= small.load)
          .sort((a, b) => (a.seats - a.load) - (b.seats - b.load));
        for (const host of hosts) {
          const same = host.stops[0].node === small.stops[0].node;
          if (!same && gapMinutes(host.stops[0].node, small.stops[0].node) > A.max_stop_gap_min) continue;
          if (same) host.stops[0].groups.push(...small.stops[0].groups);
          else host.stops.push({ node: small.stops[0].node, groups: small.stops[0].groups });
          host.load += small.load;
          vehicles.splice(vehicles.indexOf(small), 1);
          pool.push({ carrier_id: small.carrier_id, carrier_name: small.carrier_name, kind: small.kind, seats: small.seats, eta: small.eta });
          improved = true;
          break outer;
        }
      }
    }
    for (const v of vehicles) v.stops.sort((a, b) => fromAirport(a.node, airport) - fromAirport(b.node, airport));
  }
  if (unassignedVehicle.length) warnings.push({ code: 'vehicles_short', params: { n: unassignedVehicle.length } });

  // 4. output
  vehicles.sort((a, b) => fromAirport(a.stops[0].node, airport) - fromAirport(b.stops[0].node, airport) || b.load - a.load);
  const ids = gs => gs.flatMap(g => g.members.map(m => m.id));
  const outVehicles = vehicles.map((v, i) => ({
    key: `V${i + 1}`, carrier_id: v.carrier_id, carrier_name: v.carrier_name, kind: v.kind, seats: v.seats, load: v.load, eta: v.eta,
    stops: v.stops.map(s => ({ type: s.node.type, id: s.node.id, name: s.node.name, passenger_ids: ids(s.groups), seats: seatsOf(s.groups) }))
  }));
  const outHotels = nodes.filter(n => n.type === 'hotel').map(n => {
    let single = 0, double = 0;
    for (const g of n.groups) { double += Math.floor(g.seats / 2); single += g.seats % 2; }
    if (n.rooms_single != null || n.rooms_double != null) {
      // single travellers beyond the single rooms offered take a double room for single use
      if (n.rooms_single != null && single > n.rooms_single) { double += single - n.rooms_single; single = n.rooms_single; }
      if (single + double > (n.rooms_single || 0) + (n.rooms_double || 0)) warnings.push({ code: 'rooms_over', params: { name: n.name } });
    }
    const members = n.groups.flatMap(g => g.members);
    return { hotel_id: n.id, name: n.name, capacity: n.cap, pax: members.length, seats: seatsOf(n.groups), rooms_single: single, rooms_double: double,
      prm: members.filter(m => m.prm).length, um: members.filter(m => m.um).length, passenger_ids: members.map(m => m.id) };
  });
  const returnAt = ev.new_departure ? new Date(new Date(ev.new_departure).getTime() - A.return_lead_min * 60000).toISOString() : null;
  const returns = ev.type === 'hotel' ? outVehicles.map((v, i) => ({ key: `R${i + 1}`, from: v.key, carrier_id: v.carrier_id, carrier_name: v.carrier_name, kind: v.kind,
    seats: v.seats, load: v.load, scheduled_at: returnAt, stops: [...v.stops].reverse() })) : [];
  const spare = {};
  for (const v of pool) { const k = `${v.carrier_id}|${v.kind}`; spare[k] = spare[k] || { carrier_id: v.carrier_id, carrier_name: v.carrier_name, kind: v.kind, count: 0 }; spare[k].count++; }
  if (pax.some(p => p.um)) warnings.push({ code: 'um_present', params: { n: pax.filter(p => p.um).length } });
  if (!db.prepare('SELECT 1 FROM event_agents WHERE event_id = ?').get(eventId)) warnings.push({ code: 'no_agent' });
  const silent = db.prepare(`SELECT COALESCE(c.name, h.name) AS name FROM solicitations s LEFT JOIN carriers c ON c.id = s.carrier_id
    LEFT JOIN hotels h ON h.id = s.hotel_id WHERE s.event_id = ? AND s.status = 'sent'`).all(eventId).map(r => r.name);
  if (silent.length) warnings.push({ code: 'no_reply', params: { names: silent.join(', ') } });
  const seatsNeeded = pax.filter(p => !p.infant).length;
  return {
    computed_at: now(), type: ev.type, last_answer_at: sols.map(s => s.answered_at).sort().pop() || null,
    stats: {
      pax: pax.length, seats: seatsNeeded, infants: pax.filter(p => p.infant).length, groups: groups.length,
      hotel_capacity: sols.filter(s => s.kind === 'hotel').reduce((s, x) => s + (x.pax_capacity || 0), 0),
      seats_offered: sols.filter(s => s.kind === 'carrier').reduce((s, x) => s + (x.coaches || 0) * (x.coach_seats || A.coach_seats) + (x.minibuses || 0) * (x.minibus_seats || A.minibus_seats) + (x.adapted || 0) * (x.adapted_seats || A.adapted_seats), 0),
      hotels_used: outHotels.length, vehicles_used: outVehicles.length,
      unassigned_hotel: unassignedHotel.length, unassigned_vehicle: unassignedVehicle.length
    },
    hotels: outHotels, vehicles: outVehicles, returns, spare: Object.values(spare),
    unassigned: { hotel: unassignedHotel.map(m => m.id), vehicle: unassignedVehicle.map(m => m.id) },
    warnings
  };
}

const warnedWaiting = new Set();
function maybePropose(eventId, { force = false } = {}) {
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!ev) return null;
  if (!(ev.agent_state === 'soliciting' || (force && ev.agent_state === 'proposed'))) return null;
  const paxCount = db.prepare("SELECT COUNT(*) AS n FROM passengers WHERE event_id = ? AND status NOT IN ('declined','no_show')").get(eventId).n;
  const sols = db.prepare("SELECT * FROM solicitations WHERE event_id = ? AND status <> 'cancelled'").all(eventId);
  const deadlinePassed = ev.agent_deadline_at && now() >= ev.agent_deadline_at;
  if (!paxCount) {
    if ((deadlinePassed || force) && !warnedWaiting.has(eventId)) { warnedWaiting.add(eventId); log(eventId, 'agent_waiting_list'); rt.eventChanged(eventId, { agent: true }); }
    return null;
  }
  const S = getSettings();
  const needs = eventNeeds(ev);
  const seatsOffered = sols.filter(s => s.kind === 'carrier' && s.status === 'answered').reduce((s, x) => s + (x.coaches || 0) * (x.coach_seats || S.agent.coach_seats) + (x.minibuses || 0) * (x.minibus_seats || S.agent.minibus_seats) + (x.adapted || 0) * (x.adapted_seats || S.agent.adapted_seats), 0);
  const bedsOffered = sols.filter(s => s.kind === 'hotel' && s.status === 'answered').reduce((s, x) => s + (x.pax_capacity || 0), 0);
  const covers = seatsOffered >= needs.seats && (ev.type !== 'hotel' || bedsOffered >= needs.seats);
  const allDone = sols.length > 0 && sols.every(s => s.status !== 'sent');
  if (!(force || allDone || covers || deadlinePassed)) return null;
  const plan = computePlan(eventId);
  const id = tx(() => {
    db.prepare("UPDATE dispatch_plans SET status = 'superseded' WHERE event_id = ? AND status = 'proposed'").run(eventId);
    const r = db.prepare("INSERT INTO dispatch_plans(event_id, status, data, created_at) VALUES (?, 'proposed', ?, ?)").run(eventId, JSON.stringify(plan), now());
    db.prepare("UPDATE events SET agent_state = 'proposed', updated_at = ? WHERE id = ?").run(now(), eventId);
    return Number(r.lastInsertRowid);
  });
  warnedWaiting.delete(eventId);
  log(eventId, 'agent_plan_proposed', { hotels: plan.stats.hotels_used, vehicles: plan.stats.vehicles_used, pax: plan.stats.pax,
    missing: plan.stats.unassigned_hotel + plan.stats.unassigned_vehicle, reason: force ? 'manual' : covers ? 'covered' : allDone ? 'all_replied' : 'deadline' });
  rt.eventChanged(eventId, { agent: true, plan: true });
  return id;
}

/* ---------- validation and lists ---------- */
function transferBand(a, b) {
  if (!hasPos(a) || !hasPos(b)) return 'ic250';
  const km = haversineKm(a, b) * 1.3;
  return km <= 100 ? 'ic100' : km <= 250 ? 'ic250' : 'ic400';
}

function paxRows(list) {
  return list.map((p, i) => [i + 1, p.name, p.pnr || '', [p.prm ? 'PMR' : '', p.um ? 'UM' : '', p.infant ? 'Bébé' : '', p.ssr && !p.prm && !p.um && !p.infant ? p.ssr : ''].filter(Boolean).join(' '), p.phone || '']);
}

function validate(eventId, planId, userId) {
  const S = getSettings();
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  const row = db.prepare("SELECT * FROM dispatch_plans WHERE id = ? AND event_id = ? AND status = 'proposed'").get(planId, eventId);
  if (!row) throw Object.assign(new Error('plan_not_found'), { status: 404 });
  if (ev.status === 'closed' || ev.status === 'cancelled') throw Object.assign(new Error('event_closed'), { status: 400 });
  const plan = JSON.parse(row.data);
  const airport = db.prepare('SELECT * FROM airports WHERE code = ?').get(ev.airport_code);
  const dest = ev.dest_airport_code ? db.prepare('SELECT * FROM airports WHERE code = ?').get(ev.dest_airport_code) : null;
  const apLabel = `${airport.name} (${airport.code})`;
  const t = now();
  const missionIds = {};
  tx(() => {
    const allocByHotel = {};
    for (const h of plan.hotels) {
      const existing = db.prepare("SELECT * FROM event_hotels WHERE event_id = ? AND hotel_id = ? AND status NOT IN ('refused','cancelled')").get(eventId, h.hotel_id);
      if (existing) {
        db.prepare(`UPDATE event_hotels SET rooms_single_req = ?, rooms_double_req = ?, rooms_single_conf = ?, rooms_double_conf = ?, pax_planned = ?,
          status = CASE WHEN status = 'requested' THEN 'confirmed' ELSE status END, confirmed_at = COALESCE(confirmed_at, ?) WHERE id = ?`)
          .run(h.rooms_single, h.rooms_double, h.rooms_single, h.rooms_double, h.pax, t, existing.id);
        allocByHotel[h.hotel_id] = existing.id;
      } else {
        const r = db.prepare(`INSERT INTO event_hotels(event_id, hotel_id, status, rooms_single_req, rooms_double_req, rooms_single_conf, rooms_double_conf, pax_planned, requested_at, confirmed_at, notes)
          VALUES (?,?,'confirmed',?,?,?,?,?,?,?,?)`).run(eventId, h.hotel_id, h.rooms_single, h.rooms_double, h.rooms_single, h.rooms_double, h.pax, t, t, 'Plan agent');
        allocByHotel[h.hotel_id] = Number(r.lastInsertRowid);
      }
      for (const pid of h.passenger_ids) db.prepare('UPDATE passengers SET event_hotel_id = ?, updated_at = ? WHERE id = ? AND event_id = ?').run(allocByHotel[h.hotel_id], t, pid, eventId);
    }
    const insM = db.prepare(`INSERT INTO missions(event_id, leg, hotel_id, from_label, to_label, band, kind, carrier_id, status, requested_at, accepted_at, scheduled_at, seats, stops, plan_key, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const v of plan.vehicles) {
      const hotelStops = v.stops.filter(s => s.type === 'hotel');
      const stops = v.stops.map(s => ({ hotel_id: s.type === 'hotel' ? s.id : null, name: s.name, pax: s.passenger_ids.length }));
      const r = insM.run(eventId, ev.type === 'hotel' ? 'outbound' : 'intercity', hotelStops[0] ? hotelStops[0].id : null, apLabel, v.stops.map(s => s.name).join(' + '),
        ev.type === 'hotel' ? 'local' : transferBand(airport, dest), v.kind, v.carrier_id, 'accepted', t, t, new Date(Date.now() + (v.eta || 0) * 60000).toISOString(),
        v.seats, JSON.stringify(stops), v.key, `Plan agent ${v.key}`);
      const mid = Number(r.lastInsertRowid);
      missionIds[v.key] = mid;
      for (const s of v.stops) for (const pid of s.passenger_ids) db.prepare('UPDATE passengers SET mission_out_id = ? WHERE id = ? AND event_id = ?').run(mid, pid, eventId);
    }
    for (const v of plan.returns || []) {
      const stops = v.stops.map(s => ({ hotel_id: s.type === 'hotel' ? s.id : null, name: s.name, pax: s.passenger_ids.length }));
      const r = insM.run(eventId, 'return', v.stops[0] && v.stops[0].type === 'hotel' ? v.stops[0].id : null, v.stops.map(s => s.name).join(' + '), apLabel, 'local', v.kind,
        v.carrier_id, 'requested', t, null, v.scheduled_at, v.seats, JSON.stringify(stops), v.key, `Plan agent ${v.key} (retour de ${v.from})`);
      const mid = Number(r.lastInsertRowid);
      missionIds[v.key] = mid;
      for (const s of v.stops) for (const pid of s.passenger_ids) db.prepare('UPDATE passengers SET mission_ret_id = ? WHERE id = ? AND event_id = ?').run(mid, pid, eventId);
    }
    db.prepare("UPDATE dispatch_plans SET status = 'superseded' WHERE event_id = ? AND status = 'proposed' AND id <> ?").run(eventId, planId);
    db.prepare("UPDATE dispatch_plans SET status = 'validated', validated_at = ?, validated_by = ? WHERE id = ?").run(t, userId, planId);
    db.prepare("UPDATE solicitations SET status = 'cancelled' WHERE event_id = ? AND status = 'sent'").run(eventId);
    db.prepare(`UPDATE events SET agent_state = 'validated', plan_confirmed_at = COALESCE(plan_confirmed_at, ?),
      status = CASE WHEN status = 'alert' THEN 'in_progress' ELSE status END, updated_at = ? WHERE id = ?`).run(t, t, eventId);
  });
  L.addTimeline(eventId, userId, JSON.stringify({ c: 'plan_confirmed', p: { hotels: plan.hotels.map(h => h.name), coaches: plan.vehicles.length } }), { kind: 'status', visibility: 'shared' });
  const sent = sendLists(eventId, plan, missionIds);
  log(eventId, 'agent_plan_validated', { vehicles: plan.vehicles.length, hotels: plan.hotels.length, emails: sent });
  audit(userId, 'agent_validate', 'event', eventId, { plan: planId });
  for (const s of db.prepare('SELECT * FROM solicitations WHERE event_id = ?').all(eventId)) notifySupplier(s);
  rt.eventChanged(eventId, { agent: true });
  return { missions: Object.keys(missionIds).length, emails: sent };
}

function sendLists(eventId, plan, missionIds) {
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  const airport = db.prepare('SELECT * FROM airports WHERE code = ?').get(ev.airport_code);
  const pax = Object.fromEntries(db.prepare('SELECT * FROM passengers WHERE event_id = ?').all(eventId).map(p => [p.id, p]));
  const flight = `${ev.flight_no || ev.ref}${ev.route ? ' ' + ev.route : ''}`;
  const vehLabel = v => `${v.key} · ${KIND_FR[v.kind]} ${v.seats} places`;
  const route = v => [`${airport.name}`, ...v.stops.map(s => `${s.name} (${s.passenger_ids.length})`)].join(' → ');
  const head = ['#', 'Passager', 'PNR', 'Assistance', 'Téléphone'];
  const csvFor = vs => mailer.csv([['Véhicule', 'Arrêt', 'Passager', 'PNR', 'Assistance', 'Téléphone'],
    ...vs.flatMap(v => v.stops.flatMap(s => s.passenger_ids.map(id => pax[id]).filter(Boolean).map(p => [v.key, s.name, p.name, p.pnr || '', [p.prm ? 'PMR' : '', p.um ? 'UM' : '', p.infant ? 'Bébé' : ''].filter(Boolean).join(' '), p.phone || ''])))]);
  let count = 0;
  const S = getSettings();
  const usedCarriers = new Set(plan.vehicles.map(v => v.carrier_id));
  const usedHotels = new Set(plan.hotels.map(h => h.hotel_id));
  const sols = db.prepare('SELECT * FROM solicitations WHERE event_id = ?').all(eventId);

  // coach operators
  for (const cid of usedCarriers) {
    const c = db.prepare('SELECT * FROM carriers WHERE id = ?').get(cid);
    const vs = plan.vehicles.filter(v => v.carrier_id === cid);
    const blocks = [{ p: `Bonjour ${c.contact_name || c.name},` },
      { p: `Merci pour votre disponibilité. Nous confirmons ${vs.length} véhicule(s) pour le vol ${flight}. Merci d'affecter un véhicule et un chauffeur à chaque trajet dans l'application ; chaque chauffeur recevra sa liste.` }];
    for (const v of vs) {
      blocks.push({ h: `${vehLabel(v)} · ${v.load} passagers` }, { p: `Trajet : ${route(v)}` });
      for (const s of v.stops) blocks.push({ p: `Arrêt ${s.name}` }, { table: { head, rows: paxRows(s.passenger_ids.map(id => pax[id]).filter(Boolean)) } });
    }
    const rets = (plan.returns || []).filter(r => r.carrier_id === cid);
    if (rets.length) blocks.push({ note: `Retour à l'aéroport : ${rets.length} trajet(s)${rets[0].scheduled_at ? ', départ des hôtels vers ' + hhmm(rets[0].scheduled_at) : ', horaire communiqué dès que Ryanair confirme le vol'}.` });
    mailer.queue({ eventId, kind: 'carrier_lists', to: c.email, toName: c.contact_name || c.name, subject: `Confirmation · ${vs.length} véhicule(s) · vol ${flight}`,
      blocks, attachments: [{ filename: `listes-${ev.ref}-${c.name.replace(/[^\w]+/g, '-')}.csv`, content: csvFor(vs), contentType: 'text/csv' }] });
    count++;
  }
  for (const s of sols.filter(x => x.kind === 'carrier' && x.status === 'answered' && !usedCarriers.has(x.carrier_id))) {
    const c = db.prepare('SELECT * FROM carriers WHERE id = ?').get(s.carrier_id);
    mailer.queue({ eventId, kind: 'carrier_release', to: c.email, toName: c.contact_name || c.name, subject: `Vol ${flight} · vos véhicules ne sont pas nécessaires`,
      blocks: [{ p: `Bonjour ${c.contact_name || c.name},` }, { p: `Merci pour votre réponse rapide. Les besoins sont couverts : vos véhicules ne seront pas mobilisés pour cet événement.` }] });
    count++;
  }
  // hotels
  for (const h of plan.hotels) {
    const hotel = db.prepare('SELECT * FROM hotels WHERE id = ?').get(h.hotel_id);
    const list = h.passenger_ids.map(id => pax[id]).filter(Boolean).sort((a, b) => String(a.group_key).localeCompare(String(b.group_key)) || a.name.localeCompare(b.name));
    const arriving = plan.vehicles.filter(v => v.stops.some(s => s.type === 'hotel' && s.id === h.hotel_id));
    mailer.queue({ eventId, kind: 'hotel_list', to: hotel.email, toName: hotel.contact_name || hotel.name,
      subject: `Liste des passagers · ${h.pax} passagers · vol ${flight}`,
      blocks: [{ p: `Bonjour ${hotel.contact_name || hotel.name},` },
        { p: `Merci pour votre disponibilité. Voici la liste des ${h.pax} passagers à héberger cette nuit : ${h.rooms_single} chambre(s) single et ${h.rooms_double} chambre(s) double. Les familles (même PNR) sont regroupées.` },
        { table: { head, rows: paxRows(list) } },
        { p: `Arrivée : ${arriving.map(v => `${v.key} (${v.stops.find(s => s.id === h.hotel_id).passenger_ids.length} passagers)`).join(', ')}. Suivez l'arrivée des autocars en direct dans l'application.` },
        { note: 'Chambres et repas facturés directement à Ryanair aux tarifs nets de la convention. Merci de déposer votre facture dans l\'application.' }],
      attachments: [{ filename: `rooming-${ev.ref}-${hotel.name.replace(/[^\w]+/g, '-')}.csv`, content: mailer.csv([['Passager', 'PNR', 'Groupe', 'Assistance', 'Téléphone'], ...list.map(p => [p.name, p.pnr || '', p.group_key || '', [p.prm ? 'PMR' : '', p.um ? 'UM' : '', p.infant ? 'Bébé' : ''].filter(Boolean).join(' '), p.phone || ''])]), contentType: 'text/csv' }] });
    count++;
  }
  for (const s of sols.filter(x => x.kind === 'hotel' && x.status === 'answered' && !usedHotels.has(x.hotel_id))) {
    const hotel = db.prepare('SELECT * FROM hotels WHERE id = ?').get(s.hotel_id);
    mailer.queue({ eventId, kind: 'hotel_release', to: hotel.email, toName: hotel.contact_name || hotel.name, subject: `Vol ${flight} · vos chambres ne sont pas nécessaires`,
      blocks: [{ p: `Bonjour ${hotel.contact_name || hotel.name},` }, { p: 'Merci pour votre réponse. Les besoins sont couverts : vous pouvez libérer les chambres proposées pour cet événement.' }] });
    count++;
  }
  // local agents: everything
  const agents = db.prepare("SELECT u.* FROM event_agents ea JOIN users u ON u.id = ea.user_id WHERE ea.event_id = ? AND u.active = 1").all(eventId);
  for (const a of agents) {
    const blocks = [{ p: `Bonjour ${a.name},` }, { p: `Le plan du vol ${flight} est validé : ${plan.stats.pax} passagers, ${plan.vehicles.length} véhicule(s), ${plan.hotels.length} hôtel(s).` }];
    if (plan.hotels.length) blocks.push({ h: 'Hôtels' }, { table: { head: ['Hôtel', 'Passagers', 'Single', 'Double'], rows: plan.hotels.map(h => [h.name, h.pax, h.rooms_single, h.rooms_double]) } });
    for (const v of plan.vehicles) {
      blocks.push({ h: `${vehLabel(v)} · ${v.carrier_name} · ${v.load} passagers` }, { p: `Trajet : ${route(v)}` });
      blocks.push({ table: { head, rows: paxRows(v.stops.flatMap(s => s.passenger_ids).map(id => pax[id]).filter(Boolean)) } });
    }
    if (plan.unassigned.hotel.length || plan.unassigned.vehicle.length) blocks.push({ note: `Passagers sans affectation : ${plan.unassigned.hotel.length + plan.unassigned.vehicle.length}. Voir l'application.` });
    mailer.queue({ eventId, kind: 'agent_lists', to: a.email, toName: a.name, subject: `Plan validé · vol ${flight} · listes par véhicule`, blocks,
      attachments: [{ filename: `listes-${ev.ref}.csv`, content: csvFor(plan.vehicles), contentType: 'text/csv' }] });
    count++;
  }
  // Ryanair requester: summary without names of suppliers' prices
  if (ev.requester_email) {
    mailer.queue({ eventId, kind: 'ryanair_plan', to: ev.requester_email, toName: ev.requester_name, subject: `Care plan confirmed · ${flight} · ${plan.stats.pax} passengers`,
      title: 'Care plan confirmed',
      blocks: [{ p: `The care plan for ${flight} is confirmed: ${plan.stats.pax} passengers, ${plan.vehicles.length} vehicle(s)${plan.hotels.length ? `, ${plan.hotels.length} hotel(s)` : ''}.` },
        ...(plan.hotels.length ? [{ table: { head: ['Hotel', 'Passengers'], rows: plan.hotels.map(h => [h.name, h.pax]) } }] : []),
        { button: { label: 'Follow the event live', url: `${mailer.baseUrl()}/#/events/${eventId}` } }] });
    count++;
  }
  db.prepare('UPDATE missions SET manifest_sent_at = ? WHERE event_id = ? AND plan_key IS NOT NULL AND manifest_sent_at IS NULL').run(now(), eventId);
  return count;
}

// sent when a coach operator (or the desk) assigns a driver to a mission that has a passenger list
function sendDriverManifest(missionId) {
  const m = db.prepare(`SELECT m.*, u.email AS driver_email, u.name AS driver_name, v.plate, e.flight_no, e.route, e.ref, e.airport_code
    FROM missions m JOIN events e ON e.id = m.event_id LEFT JOIN users u ON u.id = m.driver_id LEFT JOIN vehicles v ON v.id = m.vehicle_id WHERE m.id = ?`).get(missionId);
  if (!m || !m.driver_email) return false;
  const col = m.leg === 'return' ? 'mission_ret_id' : 'mission_out_id';
  const list = db.prepare(`SELECT p.*, h.name AS hotel_name FROM passengers p LEFT JOIN event_hotels eh ON eh.id = p.event_hotel_id LEFT JOIN hotels h ON h.id = eh.hotel_id
    WHERE p.${col} = ? ORDER BY h.name, p.group_key, p.name`).all(m.id);
  if (!list.length) return false;
  const stops = m.stops ? JSON.parse(m.stops) : [];
  mailer.queue({ eventId: m.event_id, kind: 'driver_manifest', to: m.driver_email, toName: m.driver_name,
    subject: `Votre liste · ${m.plan_key || '#' + m.id} · vol ${m.flight_no || m.ref} · ${list.length} passagers`,
    blocks: [{ p: `Bonjour ${m.driver_name},` },
      { p: `Trajet : ${m.from_label} → ${m.to_label}${m.plate ? ` · véhicule ${m.plate}` : ''}${m.scheduled_at ? ` · ${dayTime(m.scheduled_at)}` : ''}.` },
      ...(stops.length > 1 ? [{ note: `Deux arrêts : ${stops.map(s => `${s.name} (${s.pax})`).join(' puis ')}.` }] : []),
      { table: { head: ['#', 'Passager', 'PNR', 'Assistance', 'Hôtel'], rows: list.map((p, i) => [i + 1, p.name, p.pnr || '', [p.prm ? 'PMR' : '', p.um ? 'UM' : '', p.infant ? 'Bébé' : ''].filter(Boolean).join(' '), p.hotel_name || '']) } },
      { button: { label: 'Ouvrir mes missions', url: `${mailer.baseUrl()}/` } }] });
  return true;
}

/* ---------- passenger list import ---------- */
function createImport(eventId, parsed, { attachmentId = null, filename = null, userId = null } = {}) {
  const r = db.prepare('INSERT INTO imports(event_id, attachment_id, filename, status, data, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(eventId, attachmentId, filename, 'pending', JSON.stringify(parsed), userId, now());
  const id = Number(r.lastInsertRowid);
  log(eventId, 'agent_list_received', { filename, count: parsed.stats.total, seats: parsed.stats.seats });
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  const S = getSettings();
  if (S.agent.auto_launch && ev.agent_state === 'idle' && ev.status !== 'closed' && ev.status !== 'cancelled' && parsed.stats.seats > 0) {
    try { launch(eventId, userId); } catch (_) { /* reported in the timeline */ }
  }
  rt.eventChanged(eventId, { agent: true });
  return id;
}

function confirmImport(eventId, importId, passengers, mode, userId) {
  const imp = db.prepare("SELECT * FROM imports WHERE id = ? AND event_id = ? AND status = 'pending'").get(importId, eventId);
  if (!imp) throw Object.assign(new Error('import_not_found'), { status: 404 });
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (ev.agent_state === 'validated' && mode === 'replace') throw Object.assign(new Error('plan_already_validated'), { status: 400 });
  const list = (Array.isArray(passengers) && passengers.length ? passengers : JSON.parse(imp.data).passengers).slice(0, 600);
  const t = now();
  const n = tx(() => {
    if (mode === 'replace') db.prepare('DELETE FROM passengers WHERE event_id = ?').run(eventId);
    const ins = db.prepare(`INSERT INTO passengers(event_id, name, pnr, phone, prm, um, infant, title, seat, ssr, group_key, status, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?, 'expected', ?)`);
    let c = 0;
    for (const p of list) {
      const name = String(p.name || '').trim().slice(0, 160);
      if (!name) continue;
      ins.run(eventId, name, p.pnr ? String(p.pnr).slice(0, 20) : null, p.phone ? String(p.phone).slice(0, 40) : null, p.prm ? 1 : 0, p.um ? 1 : 0, p.infant ? 1 : 0,
        p.title ? String(p.title).slice(0, 10) : null, p.seat ? String(p.seat).slice(0, 5) : null, p.ssr ? String(p.ssr).slice(0, 60) : null,
        String(p.group_key || p.pnr || `S${c}`).slice(0, 40), t);
      c++;
    }
    db.prepare("UPDATE imports SET status = 'confirmed', confirmed_at = ? WHERE id = ?").run(t, importId);
    db.prepare("UPDATE imports SET status = 'discarded' WHERE event_id = ? AND status = 'pending' AND id <> ?").run(eventId, importId);
    const st = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(prm),0) AS prm, COALESCE(SUM(um),0) AS um FROM passengers WHERE event_id = ?").get(eventId);
    db.prepare('UPDATE events SET pax_prm = MAX(pax_prm, ?), pax_um = MAX(pax_um, ?), updated_at = ? WHERE id = ?').run(st.prm, st.um, t, eventId);
    return c;
  });
  log(eventId, 'agent_list_confirmed', { count: n });
  audit(userId, 'passenger_list_confirmed', 'event', eventId, { count: n });
  const fresh = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (fresh.agent_state === 'idle' && getSettings().agent.auto_launch) { try { launch(eventId, userId); } catch (_) { /* reported */ } }
  else maybePropose(eventId);
  rt.eventChanged(eventId, { agent: true, passengers: true });
  return n;
}

/* ---------- periodic work ---------- */
function tick() {
  const S = getSettings();
  const t = now();
  for (const ev of db.prepare("SELECT * FROM events WHERE agent_state = 'soliciting' AND status NOT IN ('closed','cancelled')").all()) {
    const remindBefore = new Date(Date.now() - S.agent.reminder_after_min * 60000).toISOString();
    for (const s of db.prepare("SELECT id FROM solicitations WHERE event_id = ? AND status = 'sent' AND reminded_at IS NULL AND sent_at < ? AND deadline_at > ?").all(ev.id, remindBefore, t)) {
      try { remind(s.id); } catch (_) { /* next tick */ }
    }
    try { maybePropose(ev.id); } catch (e) { console.error('agent', e); }
  }
  mailer.retry().catch(() => {});
}

module.exports = { launch, solicitExtra, remind, answer, computePlan, maybePropose, validate, sendDriverManifest, createImport, confirmImport, tick, eventNeeds };
