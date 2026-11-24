'use strict';
// Demonstration data, flagged is_demo = 1 so it can be removed in one click.
const fs = require('fs');
const path = require('path');
const { db, now, tx, UPLOAD_DIR } = require('./db');
const auth = require('./auth');

const ago = min => new Date(Date.now() - min * 60000).toISOString();
const ahead = min => new Date(Date.now() + min * 60000).toISOString();

function ins(table, row) {
  const keys = Object.keys(row);
  const r = db.prepare(`INSERT INTO ${table}(${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map(k => row[k]));
  return Number(r.lastInsertRowid);
}
function tl(eventId, at, userId, code, p = {}, visibility = 'shared') {
  db.prepare('INSERT INTO timeline(event_id, at, user_id, kind, visibility, message) VALUES (?,?,?,?,?,?)')
    .run(eventId, at, userId, 'status', visibility, JSON.stringify({ c: code, p }));
}
function note(eventId, at, userId, message, kind = 'note', visibility = 'internal', severity = null) {
  db.prepare('INSERT INTO timeline(event_id, at, user_id, kind, visibility, severity, message) VALUES (?,?,?,?,?,?,?)')
    .run(eventId, at, userId, kind, visibility, severity, message);
}

function load(adminId) {
  if (db.prepare('SELECT 1 FROM events WHERE is_demo = 1').get()) return { already_loaded: true };
  const password = auth.randomPassword(10);
  const hash = auth.hashPassword(password);
  return tx(() => {
    const H = {};
    const hotels = [
      ['atlas', 'Hôtel Atlas Menara (démo)', 'Marrakech', 'RAK', 4, 'Avenue de la Menara, Marrakech', 31.6195, -8.0230, 140, 12, 650, 820, 160, 120],
      ['palm', 'Palmeraie Airport Hotel (démo)', 'Marrakech', 'RAK', 3, 'Route de l\'aéroport, Marrakech', 31.6120, -8.0450, 90, 8, 600, 760, 150, 110],
      ['agdal', 'Hôtel Agdal Gardens (démo)', 'Marrakech', 'RAK', 4, 'Boulevard Mohammed VI, Marrakech', 31.6080, -8.0050, 60, 14, 640, 800, 150, 110],
      ['gueliz', 'Hôtel Guéliz Centre (démo)', 'Marrakech', 'RAK', 4, 'Avenue Mohammed V, Marrakech', 31.6340, -8.0100, 70, 18, 620, 780, 150, 110],
      ['ocean', 'Hôtel Océan Nouaceur (démo)', 'Casablanca', 'CMN', 4, 'Zone aéroportuaire, Nouaceur', 33.3800, -7.5700, 160, 10, 700, 880, 170, 130],
      ['saiss', 'Hôtel Saïss Fès (démo)', 'Fès', 'FEZ', 4, 'Route de l\'aéroport, Fès', 33.9600, -4.9900, 110, 15, 620, 790, 150, 110],
      ['detroit', 'Hôtel Détroit Tanger (démo)', 'Tanger', 'TNG', 4, 'Route de Rabat, Tanger', 35.7400, -5.8800, 120, 18, 680, 850, 160, 120],
      ['andalous', 'Hôtel Andalous Salé (démo)', 'Rabat', 'RBA', 3, 'Route de l\'aéroport, Salé', 34.0450, -6.7700, 80, 10, 640, 800, 150, 110]
    ];
    for (const [k, name, city, ap, stars, address, lat, lng, cap, dist, rs, rd, din, tray] of hotels) {
      H[k] = ins('hotels', { name, city, airport_code: ap, stars, address, lat, lng, capacity: cap, distance_min: dist, rate_single: rs, rate_double: rd,
        rate_dinner: din, rate_tray: tray, agreement_status: 'signed', direct_billing: 1, phone: '+212 5 00 00 00 00', contact_name: 'Réception de nuit',
        email: `resa.${k}@demo.local`, accessible_rooms: Math.round(cap / 30), is_demo: 1, created_at: now() });
    }
    const C = {};
    const carriers = [
      ['atlas', 'Atlas Tours Transport (démo)', 'Marrakech', 'Marrakech, Agadir, Essaouira', 'AGR-TT-2041', 1300, 800, 2500, 4500, 6100],
      ['menara', 'Menara Bus Services (démo)', 'Marrakech', 'Marrakech, Safi', 'AGR-TT-4120', 1300, 800, 2500, 4500, 6100],
      ['rif', 'Rif Voyages (démo)', 'Fès', 'Fès, Rabat, Casablanca', 'AGR-TT-1188', 1350, 850, 2600, 4500, 6000],
      ['detroit', 'Détroit Express Cars (démo)', 'Tanger', 'Tanger, Tétouan', 'AGR-TT-3307', 1300, 800, 2500, 4600, 6200]
    ];
    for (const [k, name, city, regions, lic, cl, cm, c1, c2, c4] of carriers) {
      C[k] = ins('carriers', { name, city, regions, licence_no: lic, licence_expiry: '2027-12-31', insurance_expiry: '2027-06-30', phone: '+212 6 00 00 00 00',
        contact_name: 'Dispatch', email: `dispatch.${k}@demo.local`, agreement_status: 'signed', cost_local: cl, cost_minibus: cm, cost_ic100: c1, cost_ic250: c2, cost_ic400: c4, is_demo: 1, created_at: now() });
    }
    const V = {};
    const plates = { atlas: ['21544-A-26', '21545-A-26', '21546-A-26', '21547-A-26', '30871-B-26'], rif: ['18802-A-24', '18803-A-24', '18804-A-24', '18805-A-24'], detroit: ['40212-A-40', '40213-A-40'], menara: ['50110-A-26', '50111-A-26'] };
    for (const [k, list] of Object.entries(plates)) {
      V[k] = list.map((plate, i) => ins('vehicles', { carrier_id: C[k], plate, kind: (k === 'atlas' && i === 4) ? 'minibus' : 'coach', seats: (k === 'atlas' && i === 4) ? 17 : 50, year: 2021, insurance_expiry: '2027-03-31', is_demo: 1 }));
    }
    const U = {};
    const users = [
      ['desk', 'cellule@demo.local', 'Salma Cellule 24/7', 'desk', {}],
      ['agentRak', 'agent.rak@demo.local', 'Yassine Agent Marrakech', 'agent', { base_city: 'Marrakech' }],
      ['agentCmn', 'agent.cmn@demo.local', 'Imane Agent Casablanca', 'agent', { base_city: 'Casablanca' }],
      ['carrierAtlas', 'dispatch.atlas@demo.local', 'Dispatch Atlas Tours', 'carrier', { carrier_id: C.atlas }],
      ['carrierRif', 'dispatch.rif@demo.local', 'Dispatch Rif Voyages', 'carrier', { carrier_id: C.rif }],
      ['d1', 'chauffeur1@demo.local', 'Mohamed (chauffeur)', 'driver', { carrier_id: C.atlas }],
      ['d2', 'chauffeur2@demo.local', 'Rachid (chauffeur)', 'driver', { carrier_id: C.atlas }],
      ['d3', 'chauffeur3@demo.local', 'Hamid (chauffeur)', 'driver', { carrier_id: C.atlas }],
      ['d4', 'chauffeur4@demo.local', 'Karim (chauffeur)', 'driver', { carrier_id: C.atlas }],
      ['d5', 'chauffeur5@demo.local', 'Said (chauffeur)', 'driver', { carrier_id: C.rif }],
      ['d6', 'chauffeur6@demo.local', 'Omar (chauffeur)', 'driver', { carrier_id: C.rif }],
      ['d7', 'chauffeur7@demo.local', 'Aziz (chauffeur)', 'driver', { carrier_id: C.rif }],
      ['d8', 'chauffeur8@demo.local', 'Nabil (chauffeur)', 'driver', { carrier_id: C.rif }],
      ['hotelAtlas', 'reception.atlas@demo.local', 'Réception Atlas Menara', 'hotel', { hotel_id: H.atlas }],
      ['hotelPalm', 'reception.palmeraie@demo.local', 'Réception Palmeraie', 'hotel', { hotel_id: H.palm }],
      ['ryanair', 'occ@demo.local', 'Ryanair OCC Dublin', 'ryanair', { lang: 'en' }]
    ];
    for (const [k, email, name, role, extra] of users) {
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) continue;
      U[k] = ins('users', { email, name, role, password_hash: hash, lang: extra.lang || 'fr', carrier_id: extra.carrier_id || null, hotel_id: extra.hotel_id || null,
        base_city: extra.base_city || null, phone: '+212 6 11 22 33 44', is_demo: 1, created_at: now() });
    }

    // Event 1: active hotel night at Marrakech
    const e1 = ins('events', { ref: 'EV-DEMO-001', type: 'hotel', status: 'in_progress', flight_no: 'FR 2563', route: 'RAK-BVA', reason: 'technical',
      airport_code: 'RAK', pax_total: 180, pax_hotel: 153, pax_prm: 2, pax_um: 1, pax_welcomed: 150, vouchers_issued: 148, eta: ago(170),
      new_departure: ahead(11 * 60), requester_name: 'Ryanair OCC', requester_phone: '+353 1 000 0000', requester_email: 'occ@demo.local',
      created_by: U.ryanair || adminId, alert_at: ago(175), plan_confirmed_at: ago(152), refreshments_qty: 0, notes_internal: 'Deux PMR fauteuil : véhicule adapté demandé.',
      notes_shared: 'Retour prévu demain matin, vol de remplacement FR 2563A.', is_demo: 1, created_at: ago(175), updated_at: ago(2) });
    const a1 = ins('event_hotels', { event_id: e1, hotel_id: H.atlas, status: 'in_house', rooms_single_req: 36, rooms_double_req: 30, rooms_single_conf: 36, rooms_double_conf: 30,
      pax_planned: 96, pax_checked_in: 94, dinners: 94, requested_at: ago(170), confirmed_at: ago(158), first_checkin_at: ago(60) });
    const a2 = ins('event_hotels', { event_id: e1, hotel_id: H.palm, status: 'confirmed', rooms_single_req: 25, rooms_double_req: 16, rooms_single_conf: 25, rooms_double_conf: 16,
      pax_planned: 57, requested_at: ago(166), confirmed_at: ago(150) });
    const m = (row) => ins('missions', { requested_at: ago(160), ...row });
    m({ event_id: e1, leg: 'outbound', hotel_id: H.atlas, from_label: 'Marrakech Menara (RAK)', to_label: 'Hôtel Atlas Menara (démo)', band: 'local', kind: 'coach', carrier_id: C.atlas,
      vehicle_id: V.atlas[0], driver_id: U.d1, status: 'arrived', pax_on_board: 48, accepted_at: ago(158), en_route_at: ago(150), at_pickup_at: ago(105), boarding_at: ago(95),
      departed_at: ago(80), arrived_at: ago(62), last_lat: 31.6195, last_lng: -8.0230, last_pos_at: ago(62) });
    m({ event_id: e1, leg: 'outbound', hotel_id: H.atlas, from_label: 'Marrakech Menara (RAK)', to_label: 'Hôtel Atlas Menara (démo)', band: 'local', kind: 'coach', carrier_id: C.atlas,
      vehicle_id: V.atlas[1], driver_id: U.d2, status: 'arrived', pax_on_board: 46, accepted_at: ago(157), en_route_at: ago(149), at_pickup_at: ago(100), boarding_at: ago(90),
      departed_at: ago(76), arrived_at: ago(58), last_lat: 31.6193, last_lng: -8.0233, last_pos_at: ago(58) });
    const m3 = m({ event_id: e1, leg: 'outbound', hotel_id: H.palm, from_label: 'Marrakech Menara (RAK)', to_label: 'Palmeraie Airport Hotel (démo)', band: 'local', kind: 'coach', carrier_id: C.atlas,
      vehicle_id: V.atlas[2], driver_id: U.d3, status: 'departed', pax_on_board: 44, accepted_at: ago(156), en_route_at: ago(140), at_pickup_at: ago(98), boarding_at: ago(30),
      departed_at: ago(9), last_lat: 31.6100, last_lng: -8.0380, last_pos_at: ago(0.5), last_speed: 11 });
    m({ event_id: e1, leg: 'outbound', hotel_id: H.palm, from_label: 'Marrakech Menara (RAK)', to_label: 'Palmeraie Airport Hotel (démo)', band: 'local', kind: 'minibus', carrier_id: C.atlas,
      vehicle_id: V.atlas[4], driver_id: U.d4, status: 'boarding', pax_on_board: 9, accepted_at: ago(150), en_route_at: ago(120), at_pickup_at: ago(40), boarding_at: ago(12),
      last_lat: 31.6072, last_lng: -8.0352, last_pos_at: ago(1) });
    const track = [[31.6072, -8.0352], [31.6078, -8.0362], [31.6085, -8.0370], [31.6092, -8.0376], [31.6100, -8.0380]];
    track.forEach(([lat, lng], i) => db.prepare('INSERT INTO positions(mission_id, lat, lng, speed, at) VALUES (?,?,?,?,?)').run(m3, lat, lng, 10, ago(9 - i * 2)));
    m({ event_id: e1, leg: 'return', hotel_id: H.atlas, from_label: 'Hôtel Atlas Menara (démo)', to_label: 'Marrakech Menara (RAK)', band: 'local', kind: 'coach', carrier_id: C.atlas,
      status: 'requested', scheduled_at: ahead(8 * 60), requested_at: ago(20) });
    m({ event_id: e1, leg: 'return', hotel_id: H.atlas, from_label: 'Hôtel Atlas Menara (démo)', to_label: 'Marrakech Menara (RAK)', band: 'local', kind: 'coach', carrier_id: C.atlas,
      status: 'requested', scheduled_at: ahead(8 * 60), requested_at: ago(20) });
    if (U.agentRak) db.prepare('INSERT INTO event_agents(event_id, user_id, assigned_at) VALUES (?,?,?)').run(e1, U.agentRak, ago(150));
    tl(e1, ago(175), U.ryanair, 'event_created', { by_role: 'ryanair' });
    tl(e1, ago(170), U.desk, 'hotel_requested', { hotel: 'Hôtel Atlas Menara (démo)', single: 36, double: 30 }, 'internal');
    tl(e1, ago(158), U.hotelAtlas, 'hotel_confirmed', { hotel: 'Hôtel Atlas Menara (démo)', rooms: 66 });
    tl(e1, ago(152), U.desk, 'plan_confirmed', { hotels: ['Hôtel Atlas Menara (démo)', 'Palmeraie Airport Hotel (démo)'], coaches: 4 });
    tl(e1, ago(105), U.d1, 'mission_at_pickup', { plate: '21544-A-26', leg: 'outbound' });
    tl(e1, ago(80), U.d1, 'mission_departed', { plate: '21544-A-26', leg: 'outbound', pax: 48, to: 'Hôtel Atlas Menara (démo)' });
    tl(e1, ago(62), U.d1, 'mission_arrived', { plate: '21544-A-26', leg: 'outbound', pax: 48, to: 'Hôtel Atlas Menara (démo)' });
    tl(e1, ago(60), U.hotelAtlas, 'hotel_in_house', { hotel: 'Hôtel Atlas Menara (démo)', pax: 48 });
    tl(e1, ago(9), U.d3, 'mission_departed', { plate: '21546-A-26', leg: 'outbound', pax: 44, to: 'Palmeraie Airport Hotel (démo)' });
    note(e1, ago(35), U.agentRak, 'Un passager malvoyant accompagné jusqu\'au minibus. Bagages PMR chargés.', 'note', 'internal');
    note(e1, ago(25), U.agentRak, 'Minibus en attente de 9 passagers retardés au contrôle des bagages.', 'incident', 'internal', 'low');

    // Event 2: active transfer, Fès flight diverted to Casablanca
    const e2 = ins('events', { ref: 'EV-DEMO-002', type: 'transfer', status: 'in_progress', flight_no: 'FR 7130', route: 'CRL-FEZ', reason: 'fog',
      airport_code: 'CMN', dest_airport_code: 'FEZ', pax_total: 186, pax_prm: 1, pax_um: 0, pax_welcomed: 186, vouchers_issued: 0, eta: ago(120),
      requester_name: 'Ryanair OCC', requester_phone: '+353 1 000 0000', created_by: U.ryanair || adminId, alert_at: ago(130), plan_confirmed_at: ago(112),
      refreshments_qty: 186, is_demo: 1, created_at: ago(130), updated_at: ago(3) });
    const route = [[33.3675, -7.5898], [33.60, -7.40], [33.92, -6.95], [34.00, -6.55], [33.90, -6.05], [33.95, -5.55]];
    const e2m = [];
    for (let i = 0; i < 4; i++) {
      const p = route[Math.min(route.length - 1, 3 + (i % 3))];
      const id = m({ event_id: e2, leg: 'intercity', from_label: 'Casablanca Mohammed V (CMN)', to_label: 'Fès-Saïss (FEZ)', band: 'ic400', kind: 'coach', carrier_id: C.rif,
        vehicle_id: V.rif[i], driver_id: [U.d5, U.d6, U.d7, U.d8][i], status: 'departed', pax_on_board: [50, 50, 48, 38][i], requested_at: ago(125), accepted_at: ago(120),
        en_route_at: ago(118), at_pickup_at: ago(70 - i * 3), boarding_at: ago(60), departed_at: ago(50 - i * 2), last_lat: p[0] + i * 0.01, last_lng: p[1] - i * 0.02, last_pos_at: ago(1), last_speed: 24 });
      e2m.push(id);
    }
    route.slice(0, 4).forEach(([lat, lng], i) => db.prepare('INSERT INTO positions(mission_id, lat, lng, speed, at) VALUES (?,?,?,?,?)').run(e2m[0], lat, lng, 24, ago(50 - i * 12)));
    if (U.agentCmn) db.prepare('INSERT INTO event_agents(event_id, user_id, assigned_at) VALUES (?,?,?)').run(e2, U.agentCmn, ago(110));
    tl(e2, ago(130), U.ryanair, 'event_created', { by_role: 'ryanair' });
    tl(e2, ago(112), U.desk, 'plan_confirmed', { hotels: [], coaches: 4 });
    tl(e2, ago(70), U.d5, 'mission_at_pickup', { plate: '18802-A-24', leg: 'intercity' });
    tl(e2, ago(50), U.d5, 'mission_departed', { plate: '18802-A-24', leg: 'intercity', pax: 50, to: 'Fès-Saïss (FEZ)' });

    // Event 3: closed hotel night at Tanger, invoice issued
    const e3 = ins('events', { ref: 'EV-DEMO-003', type: 'hotel', status: 'closed', flight_no: 'FR 8215', route: 'TNG-MAD', reason: 'weather', airport_code: 'TNG',
      pax_total: 172, pax_hotel: 140, pax_welcomed: 168, vouchers_issued: 140, alert_at: ago(6 * 1440), plan_confirmed_at: ago(6 * 1440 - 24),
      closed_at: ago(5 * 1440), summary_sent_at: ago(5 * 1440 - 300), invoice_status: 'issued', invoice_no: 'BC-RYR-DEMO-0001', invoice_issued_at: ago(3 * 1440),
      created_by: U.ryanair || adminId, is_demo: 1, created_at: ago(6 * 1440), updated_at: ago(3 * 1440) });
    ins('event_hotels', { event_id: e3, hotel_id: H.detroit, status: 'checked_out', rooms_single_req: 40, rooms_double_req: 50, rooms_single_conf: 40, rooms_double_conf: 50,
      pax_planned: 140, pax_checked_in: 138, pax_checked_out: 138, dinners: 138, breakfasts: 138, requested_at: ago(6 * 1440 - 5), confirmed_at: ago(6 * 1440 - 20),
      first_checkin_at: ago(6 * 1440 - 120), checkout_at: ago(5 * 1440 + 200), invoice_no: 'FA-2611-118', invoice_amount: 98650, invoice_status: 'approved', invoice_checked_at: ago(4 * 1440) });
    for (let i = 0; i < 3; i++) {
      for (const leg of ['outbound', 'return']) {
        m({ event_id: e3, leg, hotel_id: H.detroit, band: 'local', kind: 'coach', carrier_id: null, status: 'completed', pax_on_board: [48, 48, 42][i],
          from_label: leg === 'outbound' ? 'Tanger Ibn Battouta (TNG)' : 'Hôtel Détroit Tanger (démo)', to_label: leg === 'outbound' ? 'Hôtel Détroit Tanger (démo)' : 'Tanger Ibn Battouta (TNG)',
          requested_at: ago(6 * 1440 - 10), en_route_at: ago(6 * 1440 - 30), at_pickup_at: leg === 'outbound' ? ago(6 * 1440 - 75) : ago(5 * 1440 + 260),
          departed_at: ago(6 * 1440 - 95), arrived_at: leg === 'outbound' ? ago(6 * 1440 - 115) : ago(5 * 1440 + 200), completed_at: ago(5 * 1440) });
      }
    }
    tl(e3, ago(6 * 1440), U.ryanair, 'event_created', { by_role: 'ryanair' });
    tl(e3, ago(5 * 1440), U.desk, 'event_closed');
    tl(e3, ago(3 * 1440), adminId, 'invoice_issued', { number: 'BC-RYR-DEMO-0001' });

    // Event 4: cancelled before departure
    const e4 = ins('events', { ref: 'EV-DEMO-004', type: 'hotel', status: 'cancelled', flight_no: 'FR 1984', route: 'AGA-STN', reason: 'technical', airport_code: 'AGA',
      pax_total: 175, pax_hotel: 160, alert_at: ago(2 * 1440), plan_confirmed_at: ago(2 * 1440 - 26), cancelled_at: ago(2 * 1440 - 50), cancel_stage: 'before_departure',
      created_by: U.ryanair || adminId, is_demo: 1, created_at: ago(2 * 1440), updated_at: ago(2 * 1440 - 50) });
    tl(e4, ago(2 * 1440), U.ryanair, 'event_created', { by_role: 'ryanair' });
    tl(e4, ago(2 * 1440 - 50), U.ryanair, 'event_cancelled', { stage: 'before_departure', reason: 'Avion réparé, départ maintenu' });

    // a few passengers on event 1
    const names = ['Martin Dupont', 'Sarah Johnson', 'Lucas Moreau', 'Emma Wilson', 'Hugo Bernard', 'Chloé Petit', 'Thomas Leroy', 'Amina Benali', 'James Smith', 'Léa Garnier'];
    names.forEach((name, i) => ins('passengers', { event_id: e1, name, pnr: `QX${4100 + i}`, prm: i === 3 ? 1 : 0, um: i === 7 ? 1 : 0,
      event_hotel_id: i < 6 ? a1 : a2, room_no: i < 5 ? String(210 + i) : null, status: i < 5 ? 'at_hotel' : (i < 8 ? 'boarded' : 'welcomed'), updated_at: now() }));

    return { loaded: true, password, accounts: users.map(u => ({ email: u[1], role: u[3] })) };
  });
}

function purge() {
  return tx(() => {
    const demoUsers = db.prepare('SELECT id FROM users WHERE is_demo = 1').all().map(r => r.id);
    const files = db.prepare('SELECT stored_name FROM attachments WHERE event_id IN (SELECT id FROM events WHERE is_demo = 1)').all();
    const ev = db.prepare('DELETE FROM events WHERE is_demo = 1').run().changes;
    if (demoUsers.length) {
      const q = demoUsers.map(() => '?').join(',');
      db.prepare(`DELETE FROM event_agents WHERE user_id IN (${q})`).run(...demoUsers);
      db.prepare(`UPDATE missions SET driver_id = NULL WHERE driver_id IN (${q})`).run(...demoUsers);
      db.prepare(`UPDATE events SET created_by = NULL WHERE created_by IN (${q})`).run(...demoUsers);
      db.prepare(`UPDATE timeline SET user_id = NULL WHERE user_id IN (${q})`).run(...demoUsers);
      db.prepare(`UPDATE attachments SET uploaded_by = NULL WHERE uploaded_by IN (${q})`).run(...demoUsers);
      db.prepare(`UPDATE event_hotels SET invoice_checked_by = NULL WHERE invoice_checked_by IN (${q})`).run(...demoUsers);
    }
    const users = db.prepare('DELETE FROM users WHERE is_demo = 1').run().changes;
    db.prepare('UPDATE missions SET vehicle_id = NULL WHERE vehicle_id IN (SELECT id FROM vehicles WHERE is_demo = 1)').run();
    db.prepare('DELETE FROM vehicles WHERE is_demo = 1 OR carrier_id IN (SELECT id FROM carriers WHERE is_demo = 1)').run();
    db.prepare('UPDATE users SET carrier_id = NULL WHERE carrier_id IN (SELECT id FROM carriers WHERE is_demo = 1)').run();
    db.prepare('UPDATE missions SET carrier_id = NULL WHERE carrier_id IN (SELECT id FROM carriers WHERE is_demo = 1)').run();
    db.prepare('DELETE FROM solicitations WHERE carrier_id IN (SELECT id FROM carriers WHERE is_demo = 1) OR hotel_id IN (SELECT id FROM hotels WHERE is_demo = 1)').run();
    const carriers = db.prepare('DELETE FROM carriers WHERE is_demo = 1').run().changes;
    db.prepare('UPDATE users SET hotel_id = NULL WHERE hotel_id IN (SELECT id FROM hotels WHERE is_demo = 1)').run();
    const hotels = db.prepare('DELETE FROM hotels WHERE is_demo = 1 AND id NOT IN (SELECT hotel_id FROM event_hotels) AND id NOT IN (SELECT hotel_id FROM missions WHERE hotel_id IS NOT NULL)').run().changes;
    for (const f of files) { try { fs.unlinkSync(path.join(UPLOAD_DIR, f.stored_name)); } catch (_) { /* ignore */ } }
    return { events: ev, users, carriers, hotels };
  });
}

module.exports = { load, purge };
