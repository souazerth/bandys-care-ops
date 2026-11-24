'use strict';
const { db, now, getSettings } = require('./db');

const MISSION_ORDER = ['requested', 'accepted', 'en_route', 'at_pickup', 'boarding', 'departed', 'arrived', 'completed'];
const isStaff = u => u && (u.role === 'admin' || u.role === 'desk');
const ms = iso => (iso ? new Date(iso).getTime() : null);
const minutesBetween = (a, b) => (a && b ? Math.round((ms(b) - ms(a)) / 60000) : null);
const sum = (arr, f) => arr.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const maxIso = arr => arr.filter(Boolean).sort().pop() || null;
const minIso = arr => arr.filter(Boolean).sort()[0] || null;

function addBusinessDays(iso, days) {
  const d = new Date(iso);
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) added++;
  }
  return d.toISOString();
}

/* ---------- visibility ---------- */
function canSeeEvent(user, eventId) {
  switch (user.role) {
    case 'admin': case 'desk': case 'ryanair': return true;
    case 'agent': return !!db.prepare('SELECT 1 FROM event_agents WHERE event_id = ? AND user_id = ?').get(eventId, user.id);
    case 'hotel': return !!db.prepare('SELECT 1 FROM event_hotels WHERE event_id = ? AND hotel_id = ?').get(eventId, user.hotel_id);
    case 'carrier': return !!db.prepare('SELECT 1 FROM missions WHERE event_id = ? AND carrier_id = ?').get(eventId, user.carrier_id);
    case 'driver': return !!db.prepare('SELECT 1 FROM missions WHERE event_id = ? AND driver_id = ?').get(eventId, user.id);
    default: return false;
  }
}
function eventFilterSql(user) {
  switch (user.role) {
    case 'admin': case 'desk': case 'ryanair': return { sql: '1 = 1', args: [] };
    case 'agent': return { sql: 'e.id IN (SELECT event_id FROM event_agents WHERE user_id = ?)', args: [user.id] };
    case 'hotel': return { sql: 'e.id IN (SELECT event_id FROM event_hotels WHERE hotel_id = ?)', args: [user.hotel_id ?? -1] };
    case 'carrier': return { sql: 'e.id IN (SELECT event_id FROM missions WHERE carrier_id = ?)', args: [user.carrier_id ?? -1] };
    case 'driver': return { sql: 'e.id IN (SELECT event_id FROM missions WHERE driver_id = ?)', args: [user.id] };
    default: return { sql: '1 = 0', args: [] };
  }
}

/* ---------- loading ---------- */
function loadEvent(id) {
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!ev) return null;
  const airport = db.prepare('SELECT * FROM airports WHERE code = ?').get(ev.airport_code);
  const dest = ev.dest_airport_code ? db.prepare('SELECT * FROM airports WHERE code = ?').get(ev.dest_airport_code) : null;
  const hotels = db.prepare(`SELECT eh.*, h.name AS hotel_name, h.city AS hotel_city, h.address AS hotel_address,
      h.phone AS hotel_phone, h.lat AS hotel_lat, h.lng AS hotel_lng, h.stars AS hotel_stars
    FROM event_hotels eh JOIN hotels h ON h.id = eh.hotel_id WHERE eh.event_id = ? ORDER BY eh.id`).all(id);
  const missions = db.prepare(`SELECT m.*, c.name AS carrier_name, c.phone AS carrier_phone,
      c.cost_local, c.cost_minibus, c.cost_ic100, c.cost_ic250, c.cost_ic400,
      v.plate AS vehicle_plate, v.seats AS vehicle_seats, u.name AS driver_name, u.phone AS driver_phone,
      h.name AS hotel_name
    FROM missions m LEFT JOIN carriers c ON c.id = m.carrier_id LEFT JOIN vehicles v ON v.id = m.vehicle_id
    LEFT JOIN users u ON u.id = m.driver_id LEFT JOIN hotels h ON h.id = m.hotel_id
    WHERE m.event_id = ? ORDER BY m.id`).all(id);
  const agents = db.prepare(`SELECT u.id, u.name, u.phone, u.base_city, ea.assigned_at FROM event_agents ea
    JOIN users u ON u.id = ea.user_id WHERE ea.event_id = ? ORDER BY u.name`).all(id);
  const timeline = db.prepare(`SELECT t.*, u.name AS user_name, u.role AS user_role FROM timeline t
    LEFT JOIN users u ON u.id = t.user_id WHERE t.event_id = ? ORDER BY t.at DESC, t.id DESC`).all(id);
  const extras = db.prepare('SELECT * FROM extra_lines WHERE event_id = ? ORDER BY id').all(id);
  const attachments = db.prepare(`SELECT a.id, a.event_hotel_id, a.kind, a.filename, a.mime, a.size, a.at, u.name AS uploaded_by_name
    FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by WHERE a.event_id = ? ORDER BY a.at DESC`).all(id);
  const paxStats = db.prepare(`SELECT COUNT(*) AS n, SUM(status='welcomed') AS welcomed, SUM(status='boarded') AS boarded,
      SUM(status='at_hotel') AS at_hotel, SUM(status='returned') AS returned FROM passengers WHERE event_id = ?`).get(id);
  return { ev, airport, dest, hotels, missions, agents, timeline, extras, attachments, paxStats };
}

/* ---------- derived state ---------- */
const activeMission = m => m.status !== 'cancelled' && m.status !== 'refused';
const reached = (m, st) => MISSION_ORDER.indexOf(m.status) >= MISSION_ORDER.indexOf(st);

function derive(ctx, S) {
  const { ev, missions, hotels, airport } = ctx;
  const outLegs = missions.filter(m => (m.leg === 'outbound' || m.leg === 'intercity') && activeMission(m));
  const retLegs = missions.filter(m => m.leg === 'return' && activeMission(m));
  const transit = arr => sum(arr.filter(m => m.status === 'boarding' || m.status === 'departed'), m => m.pax_on_board);
  const done = arr => sum(arr.filter(m => m.status === 'arrived' || m.status === 'completed'), m => m.pax_on_board);
  const hostedAllocs = hotels.filter(h => h.status === 'in_house' || h.status === 'checked_out');
  const counts = {
    pax_total: ev.pax_total,
    pax_hotel: ev.pax_hotel ?? ev.pax_total,
    welcomed: ev.pax_welcomed,
    vouchers: ev.vouchers_issued,
    in_transit_out: transit(outLegs),
    delivered_out: done(outLegs),
    hosted: sum(hotels, h => h.pax_checked_in),
    checked_out: sum(hotels, h => h.pax_checked_out),
    in_transit_ret: transit(retLegs),
    returned: done(retLegs),
    rooms_req: sum(hotels.filter(h => h.status !== 'refused'), h => h.rooms_single_req + h.rooms_double_req),
    rooms_conf: sum(hotels.filter(h => h.status !== 'refused'), h => h.rooms_single_conf + h.rooms_double_conf),
    rooms_used: sum(hostedAllocs, h => h.rooms_single_conf + h.rooms_double_conf),
    missions_total: missions.filter(activeMission).length,
    missions_pending: missions.filter(m => m.status === 'requested').length,
    missions_moving: missions.filter(m => ['en_route', 'departed'].includes(m.status)).length,
    missions_on_site: missions.filter(m => ['at_pickup', 'boarding'].includes(m.status)).length,
    missions_done: missions.filter(m => ['arrived', 'completed'].includes(m.status)).length
  };
  const firstOnSite = minIso(outLegs.map(m => m.at_pickup_at));
  const firstDeparted = minIso(outLegs.map(m => m.boarding_at || m.departed_at));
  const allOutArrived = outLegs.length > 0 && outLegs.every(m => reached(m, 'arrived')) ? maxIso(outLegs.map(m => m.arrived_at)) : null;
  const liveAllocs = hotels.filter(h => h.status !== 'refused');
  const allHosted = liveAllocs.length > 0 && liveAllocs.every(h => h.status === 'in_house' || h.status === 'checked_out')
    ? maxIso(liveAllocs.map(h => h.first_checkin_at)) : null;
  const allReturned = retLegs.length > 0 && retLegs.every(m => reached(m, 'arrived')) ? maxIso(retLegs.map(m => m.arrived_at)) : null;

  // a step is partial when it has started but is not finished everywhere (some coaches arrived, some hotels in house...)
  const someOutArrived = outLegs.some(m => reached(m, 'arrived'));
  const someHosted = liveAllocs.some(h => h.status === 'in_house' || h.status === 'checked_out');
  const someReturned = retLegs.some(m => reached(m, 'arrived'));
  const steps = ev.type === 'hotel'
    ? [['alert', ev.alert_at], ['plan', ev.plan_confirmed_at], ['coaches_on_site', firstOnSite], ['boarded', firstDeparted],
      ['at_hotel', allOutArrived, someOutArrived], ['hosted', allHosted, someHosted], ['returned', allReturned, someReturned],
      ['closed', ev.closed_at], ['invoiced', ev.invoice_issued_at]]
    : [['alert', ev.alert_at], ['plan', ev.plan_confirmed_at], ['coaches_on_site', firstOnSite], ['boarded', firstDeparted],
      ['arrived', allOutArrived, someOutArrived], ['closed', ev.closed_at], ['invoiced', ev.invoice_issued_at]];
  let current = 0;
  steps.forEach(([, at, partial], i) => { if (at || partial) current = i; });
  const phase = ev.status === 'cancelled' ? 'cancelled' : steps[current][0];

  // SLA
  const t = Date.now();
  const coachTarget = (airport && airport.category === 2) ? S.sla.coach_cat2_min : S.sla.coach_cat1_min;
  const slaItem = (startIso, doneIso, targetMin, applicable = true) => {
    if (!applicable || !startIso) return { applicable: false };
    const due = new Date(ms(startIso) + targetMin * 60000).toISOString();
    const elapsed = doneIso ? minutesBetween(startIso, doneIso) : Math.round((t - ms(startIso)) / 60000);
    const met = doneIso ? elapsed <= targetMin : (t > ms(due) ? false : null);
    return { applicable: true, target_min: targetMin, due_at: due, done_at: doneIso || null, elapsed_min: elapsed, met };
  };
  const stopped = ev.status === 'cancelled';
  const sla = {
    plan: slaItem(ev.alert_at, ev.plan_confirmed_at, S.sla.plan_min, !stopped || !!ev.plan_confirmed_at),
    coach: slaItem(ev.alert_at, firstOnSite, coachTarget, outLegs.length > 0 || (!stopped && !ev.closed_at))
  };
  if (ev.type === 'hotel') {
    const pct = counts.pax_hotel > 0 ? Math.round((counts.hosted / counts.pax_hotel) * 1000) / 10 : null;
    sla.accommodation = { applicable: true, target_pct: S.sla.accommodation_pct, pct, met: ev.closed_at && pct != null ? pct >= S.sla.accommodation_pct : null };
  } else sla.accommodation = { applicable: false };
  if (ev.closed_at) {
    const sDue = new Date(ms(ev.closed_at) + S.sla.summary_h * 3600000).toISOString();
    sla.summary = { applicable: true, due_at: sDue, done_at: ev.summary_sent_at, met: ev.summary_sent_at ? ev.summary_sent_at <= sDue : (t > ms(sDue) ? false : null) };
    const iDue = addBusinessDays(ev.closed_at, S.sla.invoice_bdays);
    sla.invoice = { applicable: true, due_at: iDue, done_at: ev.invoice_issued_at, met: ev.invoice_issued_at ? ev.invoice_issued_at <= iDue : (t > ms(iDue) ? false : null) };
  } else { sla.summary = { applicable: false }; sla.invoice = { applicable: false }; }

  // alerts for the desk
  const alerts = [];
  if (ev.status !== 'closed' && ev.status !== 'cancelled') {
    for (const k of ['plan', 'coach']) {
      const s = sla[k];
      if (s.applicable && !s.done_at) {
        const left = Math.round((ms(s.due_at) - t) / 60000);
        if (left < 0) alerts.push({ level: 'red', code: `sla_${k}_late`, minutes: -left });
        else if (left <= 10) alerts.push({ level: 'amber', code: `sla_${k}_soon`, minutes: left });
      }
    }
    for (const m of missions) {
      if (m.status === 'requested' && (t - ms(m.requested_at)) > 15 * 60000) alerts.push({ level: 'amber', code: 'mission_unaccepted', ref: m.id });
      if (['en_route', 'departed'].includes(m.status) && m.last_pos_at && (t - ms(m.last_pos_at)) > 10 * 60000) alerts.push({ level: 'amber', code: 'gps_stale', ref: m.id });
    }
    for (const h of hotels) {
      if (h.status === 'requested' && (t - ms(h.requested_at)) > 20 * 60000) alerts.push({ level: 'amber', code: 'hotel_unconfirmed', ref: h.hotel_name });
    }
    if (ev.type === 'hotel' && ev.plan_confirmed_at && counts.rooms_conf > 0 && counts.pax_hotel > 0) {
      const capacity = sum(hotels.filter(h => h.status !== 'refused'), h => h.rooms_single_conf + 2 * h.rooms_double_conf);
      if (capacity < counts.pax_hotel) alerts.push({ level: 'red', code: 'rooms_short', minutes: counts.pax_hotel - capacity });
    }
    if (ev.pax_prm > 0) alerts.push({ level: 'info', code: 'prm', minutes: ev.pax_prm });
    if (ev.pax_um > 0) alerts.push({ level: 'info', code: 'um', minutes: ev.pax_um });
  }
  return { counts, steps: steps.map(([key, at, partial]) => ({ key, at, partial: !at && !!partial })), current, phase, sla, alerts };
}

/* ---------- billing (montage 2) ---------- */
const dispatched = m => m.status !== 'refused' && !!(m.en_route_at || m.at_pickup_at || m.departed_at || m.arrived_at || m.completed_at);
const BAND_LABEL = {
  local: { fr: 'transfert local (30 km au plus)', en: 'local transfer (up to 30 km)' },
  ic100: { fr: 'interurbain, 100 km au plus', en: 'intercity, up to 100 km' },
  ic250: { fr: 'interurbain, de 101 à 250 km', en: 'intercity, 101 to 250 km' },
  ic400: { fr: 'interurbain, de 251 à 400 km', en: 'intercity, 251 to 400 km' }
};
const KIND_LABEL = {
  coach: { fr: 'Autocar 50 places', en: '50-seat coach' },
  minibus: { fr: 'Minibus 17 places', en: '17-seat minibus' },
  adapted: { fr: 'Véhicule adapté PMR', en: 'Adapted vehicle (PRM)' }
};
function missionSellPrice(m, P) {
  if (m.price_sell != null) return Number(m.price_sell);
  if (m.band === 'local') return m.kind === 'minibus' ? P.minibus_local : (m.kind === 'adapted' ? P.adapted_local : P.coach_local);
  return P[m.band];
}
function missionCost(m, C) {
  if (m.cost_buy != null) return Number(m.cost_buy);
  if (m.band === 'local') {
    if (m.kind === 'minibus') return m.cost_minibus ?? C.minibus_local ?? null;
    return m.cost_local ?? C.coach_local ?? null;
  }
  const carrierCost = { ic100: m.cost_ic100, ic250: m.cost_ic250, ic400: m.cost_ic400 }[m.band];
  return carrierCost ?? C[m.band] ?? null;
}

function computeInvoice(ctx, S, derived, withCosts) {
  const { ev, missions, hotels, extras } = ctx;
  const P = S.prices, V = S.vat, C = S.costs;
  const lines = [];
  const cancelledBefore = ev.status === 'cancelled' && ev.cancel_stage === 'before_departure';
  const coordUnit = ev.type === 'hotel' ? P.coord_hotel : P.coord_transfer;
  lines.push({
    code: 'coordination', qty: 1, unit: cancelledBefore ? coordUnit * 0.5 : coordUnit, vat: V.fees,
    label: {
      fr: `Frais de coordination, Événement ${ev.type === 'hotel' ? 'Hôtel' : 'Transfert'}${cancelledBefore ? ' (annulation avant départ, 50 %)' : ''}`,
      en: `Coordination fee, ${ev.type === 'hotel' ? 'Hotel' : 'Transfer'} Event${cancelledBefore ? ' (cancelled before departure, 50%)' : ''}`
    },
    cost: 0
  });
  const groups = new Map();
  for (const m of missions.filter(dispatched)) {
    const unit = missionSellPrice(m, P);
    const key = `${m.kind}|${m.band}|${unit}`;
    const g = groups.get(key) || { kind: m.kind, band: m.band, unit, qty: 0, cost: 0, costUnknown: false };
    g.qty += 1;
    const c = missionCost(m, C);
    if (c == null) g.costUnknown = true; else g.cost += c;
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    lines.push({
      code: 'transport', qty: g.qty, unit: g.unit, vat: V.transport,
      label: { fr: `${KIND_LABEL[g.kind].fr}, ${BAND_LABEL[g.band].fr}`, en: `${KIND_LABEL[g.kind].en}, ${BAND_LABEL[g.band].en}` },
      cost: g.cost, cost_unknown: g.costUnknown
    });
  }
  const roomsUsed = derived.counts.rooms_used;
  if (ev.type === 'hotel' && roomsUsed > 0) {
    lines.push({
      code: 'hotel_mgmt', qty: roomsUsed, unit: P.hotel_mgmt_per_room, vat: V.fees,
      label: { fr: 'Frais de gestion hôtelière (par chambre et par nuit)', en: 'Hotel management fee (per room per night)' }, cost: 0
    });
  }
  if (ev.refreshments_qty > 0) {
    lines.push({
      code: 'refreshment', qty: ev.refreshments_qty, unit: P.refreshment, vat: V.refreshment,
      label: { fr: 'Collations (eau et en-cas)', en: 'Refreshment packs (water and snack)' },
      cost: C.refreshment != null ? C.refreshment * ev.refreshments_qty : 0, cost_unknown: C.refreshment == null
    });
  }
  for (const x of extras) {
    lines.push({ code: 'extra', id: x.id, qty: x.qty, unit: x.unit_price, vat: x.vat, label: { fr: x.label, en: x.label }, cost: x.cost ?? 0, cost_unknown: x.cost == null });
  }
  for (const l of lines) l.amount = Math.round(l.qty * l.unit * 100) / 100;
  const baseByVat = {};
  for (const l of lines) baseByVat[l.vat] = (baseByVat[l.vat] || 0) + l.amount;
  const subtotal = sum(lines, l => l.amount);

  // service credits
  const missed = [];
  if (derived.sla.plan.met === false && ev.sla_plan_imputable) missed.push('plan');
  if (derived.sla.coach.met === false && ev.sla_coach_imputable) missed.push('coach');
  if (derived.sla.accommodation.met === false && ev.sla_accom_imputable) missed.push('accommodation');
  const creditPct = Math.min(missed.length * S.sla.credit_pct, S.sla.credit_cap_pct);
  if (creditPct > 0) {
    for (const [rate, base] of Object.entries(baseByVat)) {
      const amount = -Math.round(base * creditPct) / 100;
      lines.push({ code: 'sla_credit', qty: 1, unit: amount, amount, vat: Number(rate), cost: 0,
        label: { fr: `Pénalité de service (${creditPct} %), base TVA ${rate} %`, en: `Service credit (${creditPct}%), VAT base ${rate}%` } });
    }
  }
  const ht = Math.round(sum(lines, l => l.amount) * 100) / 100;
  const vatTotals = {};
  for (const l of lines) vatTotals[l.vat] = (vatTotals[l.vat] || 0) + l.amount * l.vat / 100;
  for (const k of Object.keys(vatTotals)) vatTotals[k] = Math.round(vatTotals[k] * 100) / 100;
  const vat = Math.round(sum(Object.values(vatTotals), v => v) * 100) / 100;
  const out = {
    status: ev.invoice_status, number: ev.invoice_no, issued_at: ev.invoice_issued_at, paid_at: ev.invoice_paid_at,
    lines: lines.map(l => {
      const o = { code: l.code, id: l.id, label: l.label, qty: l.qty, unit: l.unit, vat: l.vat, amount: l.amount };
      if (withCosts) { o.cost = l.cost; o.cost_unknown = !!l.cost_unknown; }
      return o;
    }),
    subtotal_before_credit: Math.round(subtotal * 100) / 100,
    credit_pct: creditPct, missed_sla: missed,
    ht, vat_totals: vatTotals, vat, ttc: Math.round((ht + vat) * 100) / 100,
    hotel_invoices: hotels.map(h => ({ id: h.id, hotel: h.hotel_name, invoice_no: h.invoice_no, amount: h.invoice_amount, status: h.invoice_status, checked_at: h.invoice_checked_at }))
  };
  if (withCosts) {
    const staff = ev.type === 'hotel' ? (C.staff_hotel || 0) : (C.staff_transfer || 0);
    const costs = sum(lines, l => l.cost || 0) + (ev.status === 'cancelled' && !derived.counts.missions_done ? 0 : staff);
    out.costs = Math.round(costs * 100) / 100;
    out.staff_cost = staff;
    out.costs_incomplete = lines.some(l => l.cost_unknown);
    out.margin = Math.round((ht - costs) * 100) / 100;
    out.margin_pct = ht > 0 ? Math.round(((ht - costs) / ht) * 1000) / 10 : null;
  }
  return out;
}

/* ---------- serialization per role ---------- */
function pick(o, keys) { const r = {}; for (const k of keys) r[k] = o[k]; return r; }

const EVENT_BASE = ['id', 'ref', 'type', 'status', 'flight_no', 'route', 'reason', 'airport_code', 'dest_airport_code', 'pax_total', 'pax_hotel',
  'pax_prm', 'pax_um', 'pax_welcomed', 'vouchers_issued', 'eta', 'new_departure', 'alert_at', 'plan_confirmed_at', 'closed_at', 'cancelled_at',
  'cancel_stage', 'summary_sent_at', 'refreshments_qty', 'notes_shared', 'invoice_status', 'invoice_no', 'invoice_issued_at', 'invoice_paid_at',
  'created_at', 'updated_at', 'is_demo'];
const MISSION_PUBLIC = ['id', 'event_id', 'leg', 'hotel_id', 'hotel_name', 'from_label', 'to_label', 'band', 'kind', 'carrier_id', 'carrier_name',
  'vehicle_id', 'vehicle_plate', 'vehicle_seats', 'driver_id', 'driver_name', 'status', 'pax_on_board', 'scheduled_at', 'requested_at', 'accepted_at',
  'en_route_at', 'at_pickup_at', 'boarding_at', 'departed_at', 'arrived_at', 'completed_at', 'cancelled_at', 'last_lat', 'last_lng', 'last_pos_at',
  'last_speed', 'notes', 'plan_key', 'seats'];
const ALLOC_PUBLIC = ['id', 'event_id', 'hotel_id', 'hotel_name', 'hotel_city', 'hotel_address', 'hotel_phone', 'hotel_lat', 'hotel_lng', 'hotel_stars',
  'status', 'rooms_single_req', 'rooms_double_req', 'rooms_single_conf', 'rooms_double_conf', 'pax_planned', 'pax_checked_in', 'pax_checked_out',
  'dinners', 'trays', 'breakfasts', 'requested_at', 'confirmed_at', 'first_checkin_at', 'checkout_at'];
const ALLOC_INVOICE = ['invoice_no', 'invoice_amount', 'invoice_status', 'invoice_note', 'invoice_checked_at'];

function airportOut(a) { return a ? pick(a, ['code', 'name', 'city', 'category', 'lat', 'lng']) : null; }

function serializeEvent(ctx, user, S, { full = true } = {}) {
  const derived = derive(ctx, S);
  const { ev } = ctx;
  const role = user.role;
  const staff = isStaff(user);
  const o = pick(ev, EVENT_BASE);
  o.airport = airportOut(ctx.airport);
  o.dest_airport = airportOut(ctx.dest);
  Object.assign(o, { counts: derived.counts, steps: derived.steps, current: derived.current, phase: derived.phase, sla: derived.sla });
  if (staff || role === 'agent') Object.assign(o, pick(ev, ['agent_state', 'agent_deadline_at']));
  if (staff || role === 'agent') o.alerts = derived.alerts;
  if (staff || role === 'ryanair' || role === 'agent') Object.assign(o, pick(ev, ['requester_name', 'requester_phone', 'requester_email']));
  if (staff || role === 'agent') o.notes_internal = ev.notes_internal;
  if (staff) Object.assign(o, pick(ev, ['sla_plan_imputable', 'sla_coach_imputable', 'sla_accom_imputable']));
  if (!full) {
    o.hotel_names = ctx.hotels.filter(h => h.status !== 'refused').map(h => h.hotel_name);
    if (role === 'hotel') {
      const mine = ctx.hotels.find(h => h.hotel_id === user.hotel_id);
      o.my_allocation = mine ? pick(mine, [...ALLOC_PUBLIC, ...ALLOC_INVOICE]) : null;
    }
    if (role === 'carrier' || role === 'driver') {
      o.my_missions = ctx.missions.filter(m => (role === 'carrier' ? m.carrier_id === user.carrier_id : m.driver_id === user.id)).length;
    }
    return o;
  }

  // hotels
  let allocs = ctx.hotels;
  if (role === 'hotel') allocs = allocs.filter(h => h.hotel_id === user.hotel_id);
  if (role === 'carrier' || role === 'driver') {
    const hotelIds = new Set(ctx.missions.filter(m => role === 'carrier' ? m.carrier_id === user.carrier_id : m.driver_id === user.id).map(m => m.hotel_id));
    allocs = allocs.filter(h => hotelIds.has(h.hotel_id));
  }
  o.hotels = allocs.map(h => {
    const r = pick(h, ALLOC_PUBLIC);
    if (staff || role === 'ryanair' || role === 'hotel') Object.assign(r, pick(h, ALLOC_INVOICE));
    if (staff || role === 'hotel' || role === 'agent') r.notes = h.notes;
    if (role === 'carrier' || role === 'driver') { for (const k of ['rooms_single_req', 'rooms_double_req', 'rooms_single_conf', 'rooms_double_conf', 'dinners', 'trays', 'breakfasts']) delete r[k]; }
    return r;
  });

  // missions
  let missions = ctx.missions;
  if (role === 'carrier') missions = missions.filter(m => m.carrier_id === user.carrier_id);
  if (role === 'driver') missions = missions.filter(m => m.driver_id === user.id);
  if (role === 'hotel') missions = missions.filter(m => m.hotel_id === user.hotel_id);
  o.missions = missions.map(m => {
    const r = pick(m, MISSION_PUBLIC);
    try { r.stops = m.stops ? JSON.parse(m.stops) : null; } catch (_) { r.stops = null; }
    if (staff || role === 'agent' || role === 'carrier' || role === 'driver') { r.driver_phone = m.driver_phone; r.carrier_phone = m.carrier_phone; }
    if (role === 'admin') { r.price_sell = missionSellPrice(m, S.prices); r.cost_buy = missionCost(m, S.costs); r.price_override = m.price_sell; r.cost_override = m.cost_buy; }
    return r;
  });

  if (staff || role === 'agent' || role === 'ryanair') o.agents = ctx.agents.map(a => ({ id: a.id, name: a.name, phone: staff || role === 'agent' ? a.phone : undefined, base_city: a.base_city }));

  // timeline
  const tl = ctx.timeline;
  o.timeline = (staff || role === 'agent' ? tl : tl.filter(t => t.visibility === 'shared')).map(t => ({
    id: t.id, at: t.at, kind: t.kind, visibility: t.visibility, severity: t.severity, message: t.message,
    user_name: t.user_name, user_role: t.user_role
  }));
  if (role === 'hotel' || role === 'carrier' || role === 'driver') o.timeline = o.timeline.filter(t => t.kind === 'note' || t.kind === 'status').slice(0, 30);

  // attachments
  let att = ctx.attachments;
  if (role === 'hotel') { const ids = new Set(allocs.map(a => a.id)); att = att.filter(a => a.event_hotel_id && ids.has(a.event_hotel_id)); }
  else if (role === 'ryanair') att = att.filter(a => a.kind === 'hotel_invoice' || a.kind === 'report' || a.kind === 'rooming_list');
  else if (role === 'carrier' || role === 'driver') att = [];
  o.attachments = att;

  o.passenger_stats = ctx.paxStats;

  // invoice
  if (role === 'admin') o.invoice = computeInvoice(ctx, S, derived, true);
  else if (role === 'desk' || role === 'ryanair') o.invoice = computeInvoice(ctx, S, derived, false);
  if (staff) o.extras = ctx.extras;
  return o;
}

function eventSummary(id, user, S) {
  const ctx = loadEvent(id);
  return ctx ? serializeEvent(ctx, user, S, { full: false }) : null;
}

function nextEventRef() {
  const d = new Date();
  const prefix = `EV-${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, '0')}-`;
  const last = db.prepare("SELECT ref FROM events WHERE ref LIKE ? ORDER BY id DESC LIMIT 1").get(prefix + '%');
  const n = last ? parseInt(last.ref.slice(prefix.length), 10) + 1 : 1;
  return prefix + String(n).padStart(3, '0');
}

function addTimeline(eventId, userId, message, { kind = 'note', visibility = 'internal', severity = null } = {}) {
  db.prepare('INSERT INTO timeline(event_id, at, user_id, kind, visibility, severity, message) VALUES (?,?,?,?,?,?,?)')
    .run(eventId, now(), userId || null, kind, visibility, severity, message);
  db.prepare('UPDATE events SET updated_at = ? WHERE id = ?').run(now(), eventId);
}

module.exports = {
  MISSION_ORDER, isStaff, canSeeEvent, eventFilterSql, loadEvent, derive, computeInvoice, serializeEvent, eventSummary,
  nextEventRef, addTimeline, missionSellPrice, missionCost, getSettings, addBusinessDays, dispatched
};
