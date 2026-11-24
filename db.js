'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'care-ops.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  phone TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin','desk','agent','carrier','driver','hotel','ryanair')),
  password_hash TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'fr',
  carrier_id INTEGER REFERENCES carriers(id),
  hotel_id INTEGER REFERENCES hotels(id),
  base_city TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS airports (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  category INTEGER NOT NULL DEFAULT 1,
  lat REAL, lng REAL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS hotels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  city TEXT,
  airport_code TEXT REFERENCES airports(code),
  stars INTEGER,
  address TEXT,
  lat REAL, lng REAL,
  phone TEXT, email TEXT, contact_name TEXT,
  capacity INTEGER,
  distance_min INTEGER,
  rate_single REAL, rate_double REAL, rate_dinner REAL, rate_tray REAL,
  agreement_status TEXT NOT NULL DEFAULT 'prospect',
  agreement_end TEXT,
  direct_billing INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS carriers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  city TEXT,
  regions TEXT,
  licence_no TEXT, licence_expiry TEXT, insurance_expiry TEXT,
  phone TEXT, email TEXT, contact_name TEXT,
  agreement_status TEXT NOT NULL DEFAULT 'prospect',
  cost_local REAL, cost_minibus REAL, cost_ic100 REAL, cost_ic250 REAL, cost_ic400 REAL,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  carrier_id INTEGER NOT NULL REFERENCES carriers(id),
  plate TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'coach' CHECK (kind IN ('coach','minibus','adapted')),
  seats INTEGER,
  year INTEGER,
  insurance_expiry TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  is_demo INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('hotel','transfer')),
  status TEXT NOT NULL DEFAULT 'alert',
  flight_no TEXT,
  route TEXT,
  reason TEXT,
  airport_code TEXT NOT NULL REFERENCES airports(code),
  dest_airport_code TEXT REFERENCES airports(code),
  pax_total INTEGER NOT NULL DEFAULT 0,
  pax_hotel INTEGER,
  pax_prm INTEGER NOT NULL DEFAULT 0,
  pax_um INTEGER NOT NULL DEFAULT 0,
  pax_welcomed INTEGER NOT NULL DEFAULT 0,
  vouchers_issued INTEGER NOT NULL DEFAULT 0,
  eta TEXT,
  new_departure TEXT,
  requester_name TEXT, requester_phone TEXT, requester_email TEXT,
  created_by INTEGER REFERENCES users(id),
  alert_at TEXT NOT NULL,
  plan_confirmed_at TEXT,
  closed_at TEXT,
  cancelled_at TEXT,
  cancel_stage TEXT,
  summary_sent_at TEXT,
  refreshments_qty INTEGER NOT NULL DEFAULT 0,
  notes_internal TEXT,
  notes_shared TEXT,
  invoice_status TEXT NOT NULL DEFAULT 'none',
  invoice_no TEXT,
  invoice_issued_at TEXT,
  invoice_paid_at TEXT,
  sla_plan_imputable INTEGER NOT NULL DEFAULT 1,
  sla_coach_imputable INTEGER NOT NULL DEFAULT 1,
  sla_accom_imputable INTEGER NOT NULL DEFAULT 1,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS event_hotels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id),
  status TEXT NOT NULL DEFAULT 'requested',
  rooms_single_req INTEGER NOT NULL DEFAULT 0,
  rooms_double_req INTEGER NOT NULL DEFAULT 0,
  rooms_single_conf INTEGER NOT NULL DEFAULT 0,
  rooms_double_conf INTEGER NOT NULL DEFAULT 0,
  pax_planned INTEGER NOT NULL DEFAULT 0,
  pax_checked_in INTEGER NOT NULL DEFAULT 0,
  pax_checked_out INTEGER NOT NULL DEFAULT 0,
  dinners INTEGER NOT NULL DEFAULT 0,
  trays INTEGER NOT NULL DEFAULT 0,
  breakfasts INTEGER NOT NULL DEFAULT 0,
  requested_at TEXT NOT NULL,
  confirmed_at TEXT,
  first_checkin_at TEXT,
  checkout_at TEXT,
  invoice_no TEXT,
  invoice_amount REAL,
  invoice_status TEXT NOT NULL DEFAULT 'awaited',
  invoice_note TEXT,
  invoice_checked_by INTEGER REFERENCES users(id),
  invoice_checked_at TEXT,
  notes TEXT
);
CREATE TABLE IF NOT EXISTS missions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  leg TEXT NOT NULL CHECK (leg IN ('outbound','return','intercity','other')),
  hotel_id INTEGER REFERENCES hotels(id),
  from_label TEXT, to_label TEXT,
  band TEXT NOT NULL DEFAULT 'local' CHECK (band IN ('local','ic100','ic250','ic400')),
  kind TEXT NOT NULL DEFAULT 'coach' CHECK (kind IN ('coach','minibus','adapted')),
  carrier_id INTEGER REFERENCES carriers(id),
  vehicle_id INTEGER REFERENCES vehicles(id),
  driver_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'requested',
  pax_on_board INTEGER NOT NULL DEFAULT 0,
  scheduled_at TEXT,
  requested_at TEXT NOT NULL,
  accepted_at TEXT, en_route_at TEXT, at_pickup_at TEXT, boarding_at TEXT,
  departed_at TEXT, arrived_at TEXT, completed_at TEXT, cancelled_at TEXT,
  last_lat REAL, last_lng REAL, last_pos_at TEXT, last_speed REAL,
  price_sell REAL, cost_buy REAL,
  notes TEXT
);
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  lat REAL NOT NULL, lng REAL NOT NULL, accuracy REAL, speed REAL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_positions_mission ON positions(mission_id, at);
CREATE TABLE IF NOT EXISTS event_agents (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
CREATE TABLE IF NOT EXISTS passengers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  pnr TEXT, phone TEXT,
  prm INTEGER NOT NULL DEFAULT 0,
  um INTEGER NOT NULL DEFAULT 0,
  event_hotel_id INTEGER REFERENCES event_hotels(id) ON DELETE SET NULL,
  room_no TEXT,
  status TEXT NOT NULL DEFAULT 'expected',
  notes TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'note',
  visibility TEXT NOT NULL DEFAULT 'internal',
  severity TEXT,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_timeline_event ON timeline(event_id, at);
CREATE TABLE IF NOT EXISTS extra_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  vat REAL NOT NULL DEFAULT 20,
  cost REAL
);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  event_hotel_id INTEGER REFERENCES event_hotels(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'document',
  filename TEXT NOT NULL,
  mime TEXT,
  size INTEGER,
  stored_name TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  details TEXT
);
`);

function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
// dispatch agent (v1.1)
addColumn('passengers', 'group_key', 'TEXT');
addColumn('passengers', 'title', 'TEXT');
addColumn('passengers', 'seat', 'TEXT');
addColumn('passengers', 'ssr', 'TEXT');
addColumn('passengers', 'infant', 'INTEGER NOT NULL DEFAULT 0');
addColumn('passengers', 'mission_out_id', 'INTEGER');
addColumn('passengers', 'mission_ret_id', 'INTEGER');
addColumn('missions', 'stops', 'TEXT');
addColumn('missions', 'seats', 'INTEGER');
addColumn('missions', 'plan_key', 'TEXT');
addColumn('missions', 'manifest_sent_at', 'TEXT');
addColumn('events', 'agent_state', "TEXT NOT NULL DEFAULT 'idle'");
addColumn('events', 'agent_started_at', 'TEXT');
addColumn('events', 'agent_deadline_at', 'TEXT');
addColumn('events', 'agent_seats_announced', 'INTEGER');
addColumn('hotels', 'accessible_rooms', 'INTEGER');
db.exec(`
CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  attachment_id INTEGER,
  filename TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  data TEXT NOT NULL,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  confirmed_at TEXT
);
CREATE TABLE IF NOT EXISTS solicitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('carrier','hotel')),
  carrier_id INTEGER REFERENCES carriers(id),
  hotel_id INTEGER REFERENCES hotels(id),
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'sent',
  email_to TEXT,
  pax_requested INTEGER,
  sent_at TEXT NOT NULL,
  deadline_at TEXT,
  reminded_at TEXT,
  viewed_at TEXT,
  answered_at TEXT,
  answered_via TEXT,
  answered_by INTEGER,
  coaches INTEGER, coach_seats INTEGER, minibuses INTEGER, minibus_seats INTEGER, adapted INTEGER, adapted_seats INTEGER, eta_min INTEGER,
  pax_capacity INTEGER, rooms_single INTEGER, rooms_double INTEGER, rooms_accessible INTEGER,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_sol_event ON solicitations(event_id);
CREATE TABLE IF NOT EXISTS dispatch_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'proposed',
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  validated_at TEXT,
  validated_by INTEGER
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  kind TEXT,
  to_email TEXT,
  to_name TEXT,
  subject TEXT NOT NULL,
  text TEXT,
  html TEXT,
  attachments TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
`);

const now = () => new Date().toISOString();

const DEFAULT_SETTINGS = {
  prices: {
    coord_hotel: 5000, coord_transfer: 3000, hotel_mgmt_per_room: 50,
    coach_local: 2400, minibus_local: 1200, adapted_local: 2400,
    ic100: 3500, ic250: 6200, ic400: 8500, refreshment: 40
  },
  vat: { transport: 10, fees: 20, refreshment: 20 },
  sla: {
    plan_min: 30, coach_cat1_min: 90, coach_cat2_min: 150, accommodation_pct: 98,
    summary_h: 24, invoice_bdays: 5, credit_pct: 5, credit_cap_pct: 10
  },
  costs: {
    coach_local: 1300, minibus_local: null, ic100: null, ic250: 4500, ic400: null,
    refreshment: 25, staff_hotel: 2000, staff_transfer: 1200
  },
  agent: {
    auto_launch: 1, reply_window_min: 10, reminder_after_min: 5, max_carriers: 4, max_hotels: 4,
    coach_seats: 50, minibus_seats: 17, adapted_seats: 8, multi_stop: 1, max_stop_gap_min: 15, return_lead_min: 180
  },
  company: {
    name: "Bandy's Cars", desk_phone: '', desk_email: '',
    invoice_prefix: 'BC-RYR-', next_invoice: 1
  }
};

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  for (const r of rows) {
    try { out[r.key] = { ...(out[r.key] || {}), ...JSON.parse(r.value) }; } catch (_) { /* ignore */ }
  }
  return out;
}
function saveSettingsSection(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

const AIRPORTS = [
  ['RAK', 'Marrakech Menara', 'Marrakech', 1, 31.6069, -8.0363],
  ['CMN', 'Casablanca Mohammed V', 'Casablanca', 1, 33.3675, -7.5898],
  ['AGA', 'Agadir Al Massira', 'Agadir', 1, 30.3250, -9.4131],
  ['FEZ', 'Fès-Saïss', 'Fès', 1, 33.9273, -4.9779],
  ['TNG', 'Tanger Ibn Battouta', 'Tanger', 1, 35.7269, -5.9169],
  ['RBA', 'Rabat-Salé', 'Rabat', 1, 34.0515, -6.7515],
  ['NDR', 'Nador Al Aroui', 'Nador', 2, 34.9888, -3.0282],
  ['OUD', 'Oujda Angads', 'Oujda', 2, 34.7872, -1.9240],
  ['TTU', 'Tétouan Sania Ramel', 'Tétouan', 2, 35.5944, -5.3200],
  ['ESU', 'Essaouira Mogador', 'Essaouira', 2, 31.3975, -9.6817],
  ['OZZ', 'Ouarzazate', 'Ouarzazate', 2, 30.9391, -6.9094],
  ['BEM', 'Béni Mellal', 'Béni Mellal', 2, 32.4019, -6.3159],
  ['VIL', 'Dakhla', 'Dakhla', 2, 23.7183, -15.9320],
  ['ERH', 'Errachidia Moulay Ali Chérif', 'Errachidia', 2, 31.9475, -4.3983]
];
const insAirport = db.prepare('INSERT OR IGNORE INTO airports(code, name, city, category, lat, lng) VALUES (?,?,?,?,?,?)');
for (const a of AIRPORTS) insAirport.run(...a);

function audit(userId, action, entity, entityId, details) {
  db.prepare('INSERT INTO audit(at, user_id, action, entity, entity_id, details) VALUES (?,?,?,?,?,?)')
    .run(now(), userId || null, action, entity || null, entityId == null ? null : String(entityId),
      details == null ? null : (typeof details === 'string' ? details : JSON.stringify(details)));
}

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, now, getSettings, saveSettingsSection, audit, tx, DATA_DIR, UPLOAD_DIR, DEFAULT_SETTINGS };
