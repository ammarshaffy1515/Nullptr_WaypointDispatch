import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const DB_PATH = process.env.DB_PATH || path.resolve('var/waypoint.db');
export const RUN_DATE = process.env.RUN_DATE || '2026-04-30';
export const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'waypoint2026';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

export function readCsv(name) {
  const [head, ...rows] = fs.readFileSync(path.join(DATA_DIR, name), 'utf8').trim().split(/\r?\n/);
  const cols = head.split(',');
  return rows.map((r) => {
    const v = r.split(',');
    return Object.fromEntries(cols.map((c, i) => {
      const x = v[i] ?? '';
      return [c, x !== '' && !Number.isNaN(Number(x)) && !/^\d\d:\d\d/.test(x) && !/^\d{4}-/.test(x) ? Number(x) : x];
    }));
  });
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS outlets (outlet_id TEXT PRIMARY KEY, brand TEXT, district TEXT, depot TEXT, dock_type TEXT, parking_constraint TEXT, mall_window TEXT, window_open_time TEXT, window_close_time TEXT, days_since_last_served INTEGER DEFAULT 1, deferred_yesterday INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS vehicles (vehicle_id TEXT PRIMARY KEY, type TEXT, temp TEXT, weight_cap_kg REAL, volume_cap_m3 REAL, fuel_type TEXT, km_per_l REAL, weekly_fuel_quota_l REAL, depot TEXT, status TEXT, fuel_used_week_l REAL);
CREATE TABLE IF NOT EXISTS district_travel (district TEXT PRIMARY KEY, depot TEXT, road_class TEXT, free_flow_kmh REAL, depot_to_district_km REAL, depot_to_district_freeflow_min REAL, inter_stop_km REAL, inter_stop_freeflow_min REAL);
CREATE TABLE IF NOT EXISTS service_allowance (brand TEXT, dock_type TEXT, service_allowance_min REAL, PRIMARY KEY (brand, dock_type));
CREATE TABLE IF NOT EXISTS calendar (date TEXT PRIMARY KEY, dow_name TEXT, is_payday INTEGER, festival TEXT, festival_ramp REAL, is_holiday INTEGER, monsoon INTEGER, is_operating INTEGER);
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT, role TEXT, name TEXT, outlet_id TEXT, vehicle_id TEXT, depot TEXT);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER, created_at TEXT);
CREATE TABLE IF NOT EXISTS runs (run_date TEXT PRIMARY KEY, status TEXT, closed_at TEXT, planned_at TEXT, released_at TEXT, validation TEXT);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, run_date TEXT, outlet_id TEXT REFERENCES outlets, brand TEXT, district TEXT, depot TEXT,
  temp_requirement TEXT, order_units INTEGER, order_weight_kg REAL, order_volume_m3 REAL,
  status TEXT, source TEXT, placed_at TEXT, placed_by TEXT,
  trip_id INTEGER, stop_seq INTEGER, priority REAL, priority_why TEXT,
  deferral_reason TEXT, deferred_by TEXT, consecutive_deferral INTEGER DEFAULT 0,
  load_status TEXT, load_note TEXT, delivery_status TEXT, delivered_units INTEGER, delivery_note TEXT,
  receipt_status TEXT, receipt_note TEXT);
CREATE TABLE IF NOT EXISTS trips (id INTEGER PRIMARY KEY, run_date TEXT, vehicle_id TEXT, trip_no INTEGER, depot TEXT, brand TEXT, district TEXT, window TEXT,
  depart_min INTEGER, minutes REAL, km REAL, fuel_l REAL, weight REAL, volume REAL, status TEXT, loaded_at TEXT, departed_at TEXT, completed_at TEXT, last_sync_at TEXT);
CREATE TABLE IF NOT EXISTS stops (id INTEGER PRIMARY KEY, trip_id INTEGER REFERENCES trips ON DELETE CASCADE, seq INTEGER, outlet_id TEXT, eta_min INTEGER, status TEXT,
  arrived_at TEXT, completed_at TEXT, pod_name TEXT, pod_signature TEXT, pod_photo TEXT, note TEXT, recorded_offline INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, at TEXT, actor TEXT, role TEXT, type TEXT, ref TEXT, message TEXT, payload TEXT, client_at TEXT);
`;

export const hash = (pw, salt = crypto.randomBytes(8).toString('hex')) => `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
export const verify = (pw, stored) => { const [salt] = stored.split(':'); return hash(pw, salt) === stored; };

function insertAll(table, rows) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const st = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  for (const r of rows) st.run(...cols.map((c) => r[c]));
}

// Demo store manager outlet (Fresh, Colombo). Its two orders are NOT pre-seeded:
// the judge places them as the store manager in step 1 of the walkthrough.
export const DEMO_OUTLET = process.env.DEMO_OUTLET || 'OUT004';

export function seed() {
  db.exec(`DROP TABLE IF EXISTS stops; DROP TABLE IF EXISTS trips; DROP TABLE IF EXISTS orders; DROP TABLE IF EXISTS runs; DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS outlets; DROP TABLE IF EXISTS vehicles; DROP TABLE IF EXISTS district_travel; DROP TABLE IF EXISTS service_allowance; DROP TABLE IF EXISTS calendar;`);
  db.exec(SCHEMA);
  db.exec('BEGIN');
  const scn = readCsv('task2b_peak_day_scenarios.csv');
  const fleet = Object.fromEntries(readCsv('task2b_peak_day_fleet.csv').map((r) => [r.vehicle_id, r.status]));
  const history = {};
  for (const r of scn) history[r.outlet_id] = r;
  insertAll('outlets', readCsv('outlets.csv').map((o) => ({ ...o, days_since_last_served: history[o.outlet_id]?.days_since_last_served ?? 1, deferred_yesterday: history[o.outlet_id]?.deferred_yesterday ?? 0 })));
  // Fuel already used earlier in the week (Mon-Wed) — deterministic so the demo is reproducible.
  insertAll('vehicles', readCsv('vehicles.csv').map((v) => {
    const n = Number(v.vehicle_id.slice(3));
    return { ...v, status: fleet[v.vehicle_id] === 'available' ? 'available' : (fleet[v.vehicle_id] || 'off_roster'), fuel_used_week_l: Math.round(v.weekly_fuel_quota_l * (0.35 + ((n * 37) % 45) / 100)) };
  }));
  insertAll('district_travel', readCsv('district_travel.csv'));
  insertAll('service_allowance', readCsv('service_allowance.csv'));
  insertAll('calendar', readCsv('calendar.csv').map(({ date, dow_name, is_payday, festival, festival_ramp, is_holiday, monsoon, is_operating }) => ({ date, dow_name, is_payday, festival, festival_ramp, is_holiday, monsoon, is_operating })));

  db.prepare('INSERT INTO runs (run_date, status) VALUES (?, ?)').run(RUN_DATE, 'open');
  const ins = db.prepare(`INSERT INTO orders (id, run_date, outlet_id, brand, district, depot, temp_requirement, order_units, order_weight_kg, order_volume_m3, status, source, placed_at, placed_by)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'confirmed', ?, ?, ?)`);
  let i = 0;
  for (const r of scn) {
    if (r.outlet_id === DEMO_OUTLET) continue;
    // placed through the portal yesterday between 09:00 and 15:50, before the 16:00 cutoff
    const t = 9 * 60 + ((i++ * 47) % 410);
    ins.run(r.order_ref, RUN_DATE, r.outlet_id, r.brand, r.district, r.depot, r.temp_requirement, r.order_units, r.order_weight_kg, r.order_volume_m3,
      'portal', `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`, `Manager ${r.outlet_id}`);
  }
  const users = [
    { username: 'dispatcher', role: 'dispatcher', name: 'Nirosha Perera', depot: 'Peliyagoda' },
    { username: 'loader', role: 'loader', name: 'Ruwan Silva', depot: 'Peliyagoda' },
    { username: 'driver', role: 'driver', name: 'Kasun Jayasuriya', vehicle_id: null, depot: 'Peliyagoda' },
    { username: 'store', role: 'store', name: 'Fathima Rizvi', outlet_id: DEMO_OUTLET },
  ];
  for (const u of users) db.prepare('INSERT INTO users (username, password_hash, role, name, outlet_id, vehicle_id, depot) VALUES (?,?,?,?,?,?,?)')
    .run(u.username, hash(DEMO_PASSWORD), u.role, u.name, u.outlet_id ?? null, u.vehicle_id ?? null, u.depot ?? null);
  db.exec('COMMIT');
  return { orders: i };
}

export function ensureSeeded() {
  const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runs'").get();
  if (!has || process.env.RESEED_ON_BOOT === 'true') return seed();
  return null;
}
