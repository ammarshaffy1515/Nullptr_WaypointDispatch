import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { db, seed, ensureSeeded, verify, RUN_DATE, DEMO_OUTLET } from './db.js';
import { plan, finalize, validate, priorityOf, toHHMM } from './planner.js';

const app = express();
app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.resolve('public')));

const now = () => new Date().toISOString();
const all = (sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }

function log(user, type, ref, message, payload = null, id = crypto.randomUUID(), clientAt = null) {
  run('INSERT OR IGNORE INTO events (id, at, actor, role, type, ref, message, payload, client_at) VALUES (?,?,?,?,?,?,?,?,?)',
    id, now(), user?.name ?? 'system', user?.role ?? 'system', type, ref, message, payload ? JSON.stringify(payload) : null, clientAt);
}

// ---------- auth ----------
function auth(...roles) {
  return (req, res, next) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const s = token && get('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?', token);
    if (!s) return res.status(401).json({ error: 'Please sign in again.' });
    if (roles.length && !roles.includes(s.role)) return res.status(403).json({ error: 'Not available for your role.' });
    req.user = s; next();
  };
}
const h = (fn) => (req, res) => { try { const r = fn(req, res); if (r !== undefined) res.json(r); } catch (e) { res.status(e.status || 500).json({ error: e.message, ...(e.extra || {}) }); if (!e.status) console.error(e); } };
const publicUser = ({ password_hash, ...u }) => u;

app.post('/api/login', h((req) => {
  const u = get('SELECT * FROM users WHERE username = ?', String(req.body.username || '').trim().toLowerCase());
  if (!u || !verify(String(req.body.password || ''), u.password_hash)) throw new HttpError(401, 'Wrong username or password.');
  const token = crypto.randomBytes(24).toString('hex');
  run('INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)', token, u.id, now());
  return { token, user: publicUser(u) };
}));
app.get('/api/me', auth(), h((req) => ({ user: publicUser(req.user) })));
app.post('/api/reset', auth('dispatcher'), h(() => { seed(); return { ok: true }; }));

// ---------- shared ----------
function nextOperatingDay(date) {
  return get('SELECT date, dow_name FROM calendar WHERE date > ? AND is_operating = 1 ORDER BY date LIMIT 1', date) || { date: 'next run', dow_name: '' };
}
function runInfo() {
  const r = get('SELECT * FROM runs WHERE run_date = ?', RUN_DATE);
  const cal = get('SELECT * FROM calendar WHERE date = ?', RUN_DATE);
  const counts = Object.fromEntries(all('SELECT status, COUNT(*) n FROM orders WHERE run_date = ? GROUP BY status', RUN_DATE).map((x) => [x.status, x.n]));
  return { ...r, calendar: cal, next_run: nextOperatingDay(RUN_DATE), counts, validation: r.validation ? JSON.parse(r.validation) : null };
}
app.get('/api/run', auth(), h(() => runInfo()));

function ctxFromDb() {
  const vehicles = all('SELECT * FROM vehicles').map((v) => ({ ...v, fuel_remaining_l: v.weekly_fuel_quota_l - v.fuel_used_week_l }));
  const travel = Object.fromEntries(all('SELECT * FROM district_travel').map((d) => [d.district, d]));
  const allowance = Object.fromEntries(all('SELECT * FROM service_allowance').map((a) => [`${a.brand}|${a.dock_type}`, a.service_allowance_min]));
  return {
    vehicles: vehicles.filter((v) => v.status === 'available'), workshop: vehicles.filter((v) => v.status === 'in_workshop'),
    byId: Object.fromEntries(vehicles.map((v) => [v.vehicle_id, v])), travel, allowance,
  };
}
const ORDER_SQL = `SELECT o.*, ou.dock_type, ou.parking_constraint, ou.mall_window, ou.window_open_time, ou.window_close_time, ou.deferred_yesterday, ou.days_since_last_served
  FROM orders o JOIN outlets ou ON ou.outlet_id = o.outlet_id`;

// ---------- store manager ----------
const UNIT = { 'Fresh|ambient': [7.6, 0.042], 'Fresh|chilled': [7.7, 0.04], 'Style|ambient': [4.2, 0.07], 'Tech|ambient': [38, 0.25] };
app.get('/api/store', auth('store'), h((req) => {
  const outlet = get('SELECT * FROM outlets WHERE outlet_id = ?', req.user.outlet_id);
  const orders = all(`${ORDER_SQL} WHERE o.outlet_id = ? ORDER BY o.run_date, o.temp_requirement`, req.user.outlet_id).map((o) => {
    const stop = o.trip_id && get('SELECT * FROM stops WHERE trip_id = ? AND outlet_id = ?', o.trip_id, o.outlet_id);
    const trip = o.trip_id && get('SELECT * FROM trips WHERE id = ?', o.trip_id);
    const ahead = stop && trip?.status === 'departed' ? get("SELECT COUNT(*) n FROM stops WHERE trip_id = ? AND seq < ? AND status = 'pending'", o.trip_id, stop.seq).n : null;
    return { ...o, eta: stop ? toHHMM(stop.eta_min) : null, stop, trip: trip && { vehicle_id: trip.vehicle_id, status: trip.status, departed_at: trip.departed_at }, stops_ahead: ahead };
  });
  return { outlet, run: runInfo(), orders, notices: all("SELECT * FROM events WHERE ref = ? AND type IN ('order_deferred','shortfall','stop_completed','order_planned') ORDER BY at DESC LIMIT 10", req.user.outlet_id) };
}));
app.post('/api/store/orders', auth('store'), h((req) => {
  const outlet = get('SELECT * FROM outlets WHERE outlet_id = ?', req.user.outlet_id);
  const temp = req.body.temp_requirement === 'chilled' ? 'chilled' : 'ambient';
  if (temp === 'chilled' && outlet.brand !== 'Fresh') throw new HttpError(400, 'Only Fresh outlets order chilled goods.');
  const units = Math.round(Number(req.body.order_units));
  if (!(units > 0 && units <= 2000)) throw new HttpError(400, 'Enter between 1 and 2000 units.');
  const r = get('SELECT * FROM runs WHERE run_date = ?', RUN_DATE);
  const late = r.status !== 'open';
  const runDate = late ? nextOperatingDay(RUN_DATE).date : RUN_DATE;
  if (get('SELECT 1 FROM orders WHERE outlet_id = ? AND run_date = ? AND temp_requirement = ?', outlet.outlet_id, runDate, temp))
    throw new HttpError(409, `You already have a ${temp === 'chilled' ? 'chilled' : 'dry'} order for ${runDate}. Contact the dispatcher to change it.`);
  const [kg, m3] = UNIT[`${outlet.brand}|${temp}`];
  const id = `WP-${outlet.outlet_id.slice(3)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  run(`INSERT INTO orders (id, run_date, outlet_id, brand, district, depot, temp_requirement, order_units, order_weight_kg, order_volume_m3, status, source, placed_at, placed_by)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'confirmed', 'portal', ?, ?)`, id, runDate, outlet.outlet_id, outlet.brand, outlet.district, outlet.depot, temp, units,
  Math.round(units * kg * 10) / 10, Math.round(units * m3 * 1000) / 1000, now(), req.user.name);
  log(req.user, 'order_placed', outlet.outlet_id, `${outlet.outlet_id} placed ${id} (${units} ${temp} units) for ${runDate}${late ? ' (after cutoff, moved to next run)' : ''}`);
  return { id, run_date: runDate, late };
}));
app.post('/api/store/orders/:id/receipt', auth('store'), h((req) => {
  const o = get('SELECT * FROM orders WHERE id = ? AND outlet_id = ?', req.params.id, req.user.outlet_id);
  if (!o) throw new HttpError(404, 'Order not found.');
  if (!['delivered', 'partial'].includes(o.delivery_status)) throw new HttpError(400, 'You can confirm receipt once the driver records the delivery.');
  const status = req.body.status === 'issue' ? 'issue' : 'ok';
  run("UPDATE orders SET receipt_status = ?, receipt_note = ?, status = 'received' WHERE id = ?", status, req.body.note || null, o.id);
  log(req.user, status === 'ok' ? 'receipt_ok' : 'receipt_issue', o.outlet_id, status === 'ok' ? `${o.outlet_id} confirmed receipt of ${o.id}` : `${o.outlet_id} reported an issue with ${o.id}: ${req.body.issue_type || ''} ${req.body.note || ''}`.trim());
  return { ok: true };
}));

// ---------- dispatcher ----------
app.post('/api/run/close', auth('dispatcher'), h((req) => {
  const r = get('SELECT * FROM runs WHERE run_date = ?', RUN_DATE);
  if (r.status !== 'open') throw new HttpError(400, 'Orders are already closed for this run.');
  run("UPDATE runs SET status = 'closed', closed_at = ? WHERE run_date = ?", now(), RUN_DATE);
  log(req.user, 'orders_closed', RUN_DATE, `Order cutoff closed for ${RUN_DATE}: ${get('SELECT COUNT(*) n FROM orders WHERE run_date = ?', RUN_DATE).n} confirmed orders in the queue`);
  return runInfo();
}));

function persistTrips(trips) {
  const insT = db.prepare(`INSERT INTO trips (run_date, vehicle_id, trip_no, depot, brand, district, window, depart_min, minutes, km, fuel_l, weight, volume, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'planned')`);
  const insS = db.prepare("INSERT INTO stops (trip_id, seq, outlet_id, eta_min, status) VALUES (?,?,?,?, 'pending')");
  for (const t of trips) {
    const id = Number(insT.run(RUN_DATE, t.vehicle_id, t.trip_no, t.depot, t.brand, t.district, t.window, t.depart_min, t.minutes, t.km, t.fuel_l, t.weight, t.volume).lastInsertRowid);
    for (const s of t.stops) {
      insS.run(id, s.seq, s.outlet_id, s.eta);
      for (const o of s.orders) run("UPDATE orders SET trip_id = ?, stop_seq = ?, status = 'planned', deferral_reason = NULL, deferred_by = NULL WHERE id = ?", id, s.seq, o.id);
    }
  }
}
function rosterDemoDriver() {
  const t = get(`SELECT t.vehicle_id FROM orders o JOIN trips t ON t.id = o.trip_id WHERE o.outlet_id = ? AND o.run_date = ? ORDER BY t.depart_min LIMIT 1`, DEMO_OUTLET, RUN_DATE)
    || get("SELECT vehicle_id FROM trips WHERE run_date = ? AND depot = 'Peliyagoda' ORDER BY depart_min LIMIT 1", RUN_DATE);
  run("UPDATE users SET vehicle_id = ? WHERE username = 'driver'", t?.vehicle_id ?? null);
}
function storeValidation() {
  const ctx = ctxFromDb();
  const trips = all('SELECT * FROM trips WHERE run_date = ?', RUN_DATE).map((t) => ({ ...t, orders: all(`${ORDER_SQL} WHERE o.trip_id = ?`, t.id) }));
  const errors = validate(trips, ctx, ctx.byId, new Set(ctx.vehicles.map((v) => v.vehicle_id)));
  const v = { ok: errors.length === 0, errors, checked_at: now(), trips: trips.length };
  run('UPDATE runs SET validation = ? WHERE run_date = ?', JSON.stringify(v), RUN_DATE);
  return v;
}

app.post('/api/run/plan', auth('dispatcher'), h((req) => {
  const r = get('SELECT * FROM runs WHERE run_date = ?', RUN_DATE);
  if (r.status === 'open') throw new HttpError(400, 'Close orders before planning so the queue is final.');
  if (r.status === 'released') throw new HttpError(400, 'The plan is already released to the dock.');
  const ctx = ctxFromDb();
  const orders = all(`${ORDER_SQL} WHERE o.run_date = ?`, RUN_DATE);
  const result = plan(orders, ctx);
  tx(() => {
    run('DELETE FROM stops WHERE trip_id IN (SELECT id FROM trips WHERE run_date = ?)', RUN_DATE);
    run('DELETE FROM trips WHERE run_date = ?', RUN_DATE);
    run("UPDATE orders SET trip_id = NULL, stop_seq = NULL, status = 'confirmed' WHERE run_date = ?", RUN_DATE);
    for (const o of orders) { const p = result.priorities.get(o.id); run('UPDATE orders SET priority = ?, priority_why = ? WHERE id = ?', p.score, p.why.join('; '), o.id); }
    persistTrips(result.trips);
    for (const d of result.deferred) {
      run("UPDATE orders SET status = 'deferred', deferral_reason = ?, deferred_by = 'engine', consecutive_deferral = ? WHERE id = ?", d.reason, d.order.deferred_yesterday ? 1 : 0, d.order.id);
    }
    run("UPDATE runs SET status = 'planned', planned_at = ? WHERE run_date = ?", now(), RUN_DATE);
    rosterDemoDriver();
  });
  const v = storeValidation();
  log(req.user, 'plan_generated', RUN_DATE, `Plan generated: ${result.trips.length} trips, ${orders.length - result.deferred.length} orders served, ${result.deferred.length} deferred. Constraint check ${v.ok ? 'passed' : 'FAILED'}.`);
  return planView();
}));

function planView() {
  const ctx = ctxFromDb();
  const trips = all('SELECT * FROM trips WHERE run_date = ? ORDER BY depot, brand, vehicle_id, trip_no', RUN_DATE).map((t) => {
    const v = ctx.byId[t.vehicle_id];
    const stops = all('SELECT * FROM stops WHERE trip_id = ? ORDER BY seq', t.id).map((s) => ({ ...s, eta: toHHMM(s.eta_min), orders: all(`${ORDER_SQL} WHERE o.trip_id = ? AND o.outlet_id = ?`, t.id, s.outlet_id) }));
    return { ...t, depart: toHHMM(t.depart_min), vehicle: v, stops };
  });
  const deferred = all(`${ORDER_SQL} WHERE o.run_date = ? AND o.status = 'deferred' ORDER BY o.consecutive_deferral DESC, o.priority DESC`, RUN_DATE);
  const unplanned = all(`${ORDER_SQL} WHERE o.run_date = ? AND o.status = 'confirmed'`, RUN_DATE);
  const fleet = Object.values(ctx.byId).map((v) => ({ ...v, fuel_remaining_l: v.weekly_fuel_quota_l - v.fuel_used_week_l }));
  return { run: runInfo(), trips, deferred, unplanned, fleet };
}
app.get('/api/plan', auth('dispatcher'), h(() => planView()));
app.get('/api/orders', auth('dispatcher'), h(() => all(`${ORDER_SQL} WHERE o.run_date >= ? ORDER BY o.run_date, o.depot, o.brand, o.district`, RUN_DATE).map((o) => ({ ...o, preview_priority: priorityOf(o) }))));

// Rebuild a vehicle's trips (sequence, ETAs, totals) after a manual change.
function rebuildVehicle(vehicleId, ctx) {
  const v = ctx.byId[vehicleId];
  const trips = all('SELECT * FROM trips WHERE run_date = ? AND vehicle_id = ?', RUN_DATE, vehicleId).map((t) => ({ ...t, orders: all(`${ORDER_SQL} WHERE o.trip_id = ?`, t.id) }));
  const vs = new Map([[vehicleId, { vehicle: { ...v, fuel_remaining_l: v.weekly_fuel_quota_l - v.fuel_used_week_l }, trips }]]);
  const { trips: out } = finalize(vs, ctx);
  for (const t of trips.filter((x) => !x.orders.length)) run('DELETE FROM trips WHERE id = ?', t.id);
  for (const t of out) {
    run('UPDATE trips SET trip_no = ?, depart_min = ?, minutes = ?, km = ?, fuel_l = ?, weight = ?, volume = ? WHERE id = ?', t.trip_no, t.depart_min, t.minutes, t.km, t.fuel_l, t.weight, t.volume, t.id);
    run('DELETE FROM stops WHERE trip_id = ?', t.id);
    for (const s of t.stops) {
      run("INSERT INTO stops (trip_id, seq, outlet_id, eta_min, status) VALUES (?,?,?,?, 'pending')", t.id, s.seq, s.outlet_id, s.eta);
      for (const o of s.orders) run('UPDATE orders SET stop_seq = ? WHERE id = ?', s.seq, o.id);
    }
  }
}
function requirePlanned() {
  const r = get('SELECT * FROM runs WHERE run_date = ?', RUN_DATE);
  if (r.status !== 'planned') throw new HttpError(400, r.status === 'released' ? 'The plan is released; changes now go through the dock.' : 'Generate a plan first.');
}

app.post('/api/orders/:id/defer', auth('dispatcher'), h((req) => {
  requirePlanned();
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 5) throw new HttpError(400, 'Record a reason so the store and the next dispatcher know why.');
  const o = get(`${ORDER_SQL} WHERE o.id = ?`, req.params.id);
  if (!o?.trip_id) throw new HttpError(400, 'Only planned orders can be deferred.');
  const vid = get('SELECT vehicle_id FROM trips WHERE id = ?', o.trip_id).vehicle_id;
  tx(() => {
    run("UPDATE orders SET status = 'deferred', trip_id = NULL, stop_seq = NULL, deferral_reason = ?, deferred_by = ?, consecutive_deferral = ? WHERE id = ?", reason, req.user.name, o.deferred_yesterday, o.id);
    rebuildVehicle(vid, ctxFromDb());
  });
  log(req.user, 'manual_defer', o.outlet_id, `${req.user.name} deferred ${o.id} (${o.outlet_id}): ${reason}`);
  return { ...planView(), validation: storeValidation() };
}));

app.post('/api/orders/:id/assign', auth('dispatcher'), h((req) => {
  requirePlanned();
  const ctx = ctxFromDb();
  const o = get(`${ORDER_SQL} WHERE o.id = ?`, req.params.id);
  if (!o) throw new HttpError(404, 'Order not found.');
  let target = req.body.trip_id ? get('SELECT * FROM trips WHERE id = ?', req.body.trip_id) : null;
  const vehicleId = target?.vehicle_id || req.body.vehicle_id;
  if (!ctx.byId[vehicleId]) throw new HttpError(400, 'Choose a trip or vehicle.');
  // simulate the change for this vehicle and validate before writing
  const trips = all('SELECT * FROM trips WHERE run_date = ? AND vehicle_id = ?', RUN_DATE, vehicleId).map((t) => ({ ...t, orders: all(`${ORDER_SQL} WHERE o.trip_id = ? AND o.id != ?`, t.id, o.id) }));
  if (target) trips.find((t) => t.id === target.id).orders.push(o);
  else trips.push({ id: null, vehicle_id: vehicleId, trip_no: trips.length + 1, brand: o.brand, district: o.district, depot: o.depot, orders: [o] });
  const errors = validate(trips, ctx, ctx.byId, new Set(ctx.vehicles.map((v) => v.vehicle_id)));
  if (errors.length) throw new HttpError(422, 'This change breaks an operating constraint.', { errors });
  const prevVid = o.trip_id && get('SELECT vehicle_id FROM trips WHERE id = ?', o.trip_id).vehicle_id;
  tx(() => {
    if (!target) {
      const id = Number(run(`INSERT INTO trips (run_date, vehicle_id, trip_no, depot, brand, district, window, depart_min, minutes, km, fuel_l, weight, volume, status) VALUES (?,?,?,?,?,?,?,0,0,0,0,0,0,'planned')`,
        RUN_DATE, vehicleId, trips.length, o.depot, o.brand, o.district, o.brand === 'Fresh' ? 'predawn' : 'daytime').lastInsertRowid);
      target = { id };
    }
    run("UPDATE orders SET trip_id = ?, status = 'planned', deferral_reason = NULL, deferred_by = NULL WHERE id = ?", target.id, o.id);
    rebuildVehicle(vehicleId, ctx);
    if (prevVid && prevVid !== vehicleId) rebuildVehicle(prevVid, ctx);
  });
  log(req.user, 'manual_assign', o.outlet_id, `${req.user.name} assigned ${o.id} (${o.outlet_id}) to ${vehicleId}`);
  return { ...planView(), validation: storeValidation() };
}));

app.post('/api/run/release', auth('dispatcher'), h((req) => {
  requirePlanned();
  const v = storeValidation();
  if (!v.ok) throw new HttpError(422, 'Fix the constraint violations before releasing.', { errors: v.errors });
  tx(() => {
    run("UPDATE runs SET status = 'released', released_at = ? WHERE run_date = ?", now(), RUN_DATE);
    for (const o of all('SELECT o.*, t.vehicle_id FROM orders o JOIN trips t ON t.id = o.trip_id WHERE o.run_date = ?', RUN_DATE)) {
      const s = get('SELECT eta_min FROM stops WHERE trip_id = ? AND outlet_id = ?', o.trip_id, o.outlet_id);
      log(req.user, 'order_planned', o.outlet_id, `${o.id} is scheduled on ${o.vehicle_id}, expected around ${toHHMM(s.eta_min)}`);
    }
    for (const o of all("SELECT * FROM orders WHERE run_date = ? AND status = 'deferred'", RUN_DATE)) {
      log(req.user, 'order_deferred', o.outlet_id, `${o.id} could not be delivered on ${RUN_DATE} and moves to the ${nextOperatingDay(RUN_DATE).date} run. Reason: ${o.deferral_reason}`);
    }
  });
  log(req.user, 'plan_released', RUN_DATE, 'Plan released to loaders, drivers and stores');
  return planView();
}));

app.get('/api/live', auth('dispatcher'), h(() => {
  const trips = all('SELECT t.*, (SELECT COUNT(*) FROM stops s WHERE s.trip_id = t.id) total, (SELECT COUNT(*) FROM stops s WHERE s.trip_id = t.id AND s.status != \'pending\' AND s.status != \'arrived\') done FROM trips t WHERE run_date = ? ORDER BY depart_min', RUN_DATE)
    .map((t) => ({ ...t, depart: toHHMM(t.depart_min), stops: all('SELECT seq, outlet_id, status, eta_min, recorded_offline, completed_at FROM stops WHERE trip_id = ? ORDER BY seq', t.id).map((s) => ({ ...s, eta: toHHMM(s.eta_min) })) }));
  const alerts = all("SELECT * FROM events WHERE type IN ('shortfall','stop_failed','stop_partial','receipt_issue','sync_conflict') ORDER BY at DESC LIMIT 30");
  const feed = all('SELECT * FROM events ORDER BY at DESC LIMIT 40');
  return { run: runInfo(), trips, alerts, feed };
}));

// ---------- loader ----------
app.get('/api/loader/trips', auth('loader'), h((req) => {
  const r = get('SELECT status FROM runs WHERE run_date = ?', RUN_DATE);
  const trips = r.status === 'released' ? all('SELECT t.*, v.type vtype, v.temp vtemp FROM trips t JOIN vehicles v ON v.vehicle_id = t.vehicle_id WHERE t.run_date = ? AND t.depot = ? ORDER BY t.depart_min, t.vehicle_id', RUN_DATE, req.query.depot || req.user.depot)
    .map((t) => ({ ...t, depart: toHHMM(t.depart_min), orders: get('SELECT COUNT(*) n FROM orders WHERE trip_id = ?', t.id).n })) : [];
  return { run_status: r.status, trips };
}));
function tripDetail(id) {
  const t = get('SELECT t.*, v.type vtype, v.temp vtemp, v.weight_cap_kg, v.volume_cap_m3 FROM trips t JOIN vehicles v ON v.vehicle_id = t.vehicle_id WHERE t.id = ?', id);
  if (!t) throw new HttpError(404, 'Trip not found.');
  t.depart = toHHMM(t.depart_min);
  t.stops = all('SELECT s.*, ou.dock_type, ou.parking_constraint, ou.window_open_time, ou.window_close_time, ou.district FROM stops s JOIN outlets ou ON ou.outlet_id = s.outlet_id WHERE trip_id = ? ORDER BY seq', id)
    .map((s) => ({ ...s, eta: toHHMM(s.eta_min), pod_signature: undefined, pod_photo: s.pod_photo ? true : null, orders: all('SELECT * FROM orders WHERE trip_id = ? AND outlet_id = ?', id, s.outlet_id) }));
  return t;
}
app.get('/api/trips/:id', auth('loader', 'driver', 'dispatcher'), h((req) => tripDetail(req.params.id)));
app.post('/api/trips/:id/load', auth('loader'), h((req) => {
  const t = get('SELECT * FROM trips WHERE id = ?', req.params.id);
  if (!t || t.status !== 'planned') throw new HttpError(400, 'This trip has already been loaded.');
  const items = req.body.items || [];
  const orders = all('SELECT * FROM orders WHERE trip_id = ?', t.id);
  if (items.length !== orders.length) throw new HttpError(400, 'Check every order before confirming the load.');
  tx(() => {
    for (const it of items) {
      const o = orders.find((x) => x.id === it.order_id); if (!o) continue;
      const st = ['ok', 'missing', 'damaged', 'short'].includes(it.status) ? it.status : 'ok';
      run("UPDATE orders SET load_status = ?, load_note = ?, status = ? WHERE id = ?", st, it.note || null, st === 'missing' ? 'short_loaded' : 'loaded', o.id);
      if (st !== 'ok') log(req.user, 'shortfall', o.outlet_id, `Loading shortfall on ${t.vehicle_id}: ${o.id} for ${o.outlet_id} is ${st}${it.note ? ` (${it.note})` : ''}. Store notified before departure.`);
    }
    run("UPDATE trips SET status = 'loaded', loaded_at = ? WHERE id = ?", now(), t.id);
  });
  log(req.user, 'trip_loaded', t.vehicle_id, `${t.vehicle_id} trip ${t.trip_no} loaded in reverse stop order and cleared to depart`);
  return tripDetail(t.id);
}));

// ---------- driver (offline-first) ----------
app.get('/api/driver/manifest', auth('driver'), h((req) => {
  const ids = all('SELECT id FROM trips WHERE run_date = ? AND vehicle_id = ? ORDER BY trip_no', RUN_DATE, req.user.vehicle_id || '');
  const r = get('SELECT status FROM runs WHERE run_date = ?', RUN_DATE);
  return { run_date: RUN_DATE, run_status: r.status, vehicle: req.user.vehicle_id && get('SELECT * FROM vehicles WHERE vehicle_id = ?', req.user.vehicle_id), trips: r.status === 'released' ? ids.map((x) => tripDetail(x.id)) : [], synced_at: now() };
}));

// Apply queued driver events. Each event carries a client-generated UUID, so
// replays after a dropped connection are ignored instead of double-applied.
app.post('/api/sync', auth('driver'), h((req) => {
  const results = [];
  for (const ev of (req.body.events || []).slice(0, 200)) {
    if (get('SELECT 1 FROM events WHERE id = ?', ev.id)) { results.push({ id: ev.id, status: 'duplicate' }); continue; }
    try {
      tx(() => applyDriverEvent(req.user, ev));
      results.push({ id: ev.id, status: 'applied' });
    } catch (e) {
      log(req.user, 'sync_conflict', req.user.vehicle_id, `Sync conflict from ${req.user.vehicle_id}: ${e.message}`, { ev: { ...ev, payload: { ...ev.payload, signature: undefined, photo: undefined } } }, ev.id, ev.client_at);
      results.push({ id: ev.id, status: 'rejected', reason: e.message });
    }
  }
  return { results, synced_at: now() };
}));

function applyDriverEvent(user, ev) {
  const off = ev.offline ? ' (recorded offline)' : '';
  const trip = get('SELECT * FROM trips WHERE id = ?', ev.trip_id);
  if (!trip || trip.vehicle_id !== user.vehicle_id) throw new Error('This trip is no longer assigned to your vehicle.');
  run('UPDATE trips SET last_sync_at = ? WHERE id = ?', now(), trip.id);
  if (ev.type === 'depart') {
    if (trip.status === 'planned') throw new Error('The dock has not confirmed loading for this trip yet.');
    if (trip.status !== 'loaded') return log(user, 'noop', trip.vehicle_id, 'already departed', null, ev.id, ev.client_at);
    run("UPDATE trips SET status = 'departed', departed_at = ? WHERE id = ?", ev.client_at || now(), trip.id);
    run("UPDATE orders SET status = 'out_for_delivery' WHERE trip_id = ? AND status = 'loaded'", trip.id);
    return log(user, 'trip_departed', trip.vehicle_id, `${trip.vehicle_id} departed on trip ${trip.trip_no}${off}`, null, ev.id, ev.client_at);
  }
  const stop = get('SELECT * FROM stops WHERE id = ? AND trip_id = ?', ev.stop_id, trip.id);
  if (!stop) throw new Error('This stop was removed from your route by the dispatcher.');
  if (ev.type === 'arrive') {
    if (stop.status === 'pending') run("UPDATE stops SET status = 'arrived', arrived_at = ? WHERE id = ?", ev.client_at || now(), stop.id);
    return log(user, 'stop_arrived', stop.outlet_id, `${trip.vehicle_id} arrived at ${stop.outlet_id}${off}`, null, ev.id, ev.client_at);
  }
  if (ev.type === 'complete') {
    const p = ev.payload || {};
    if (!['delivered', 'partial', 'failed'].includes(p.outcome)) throw new Error('Unknown delivery outcome.');
    if (['delivered', 'partial', 'failed'].includes(stop.status)) throw new Error(`Stop ${stop.outlet_id} was already recorded as ${stop.status}.`);
    if (p.outcome !== 'failed' && !String(p.pod_name || '').trim()) throw new Error('Proof of delivery needs the receiver name.');
    run('UPDATE stops SET status = ?, completed_at = ?, pod_name = ?, pod_signature = ?, pod_photo = ?, note = ?, recorded_offline = ? WHERE id = ?',
      p.outcome, ev.client_at || now(), p.pod_name || null, p.signature || null, p.photo || null, p.note || null, ev.offline ? 1 : 0, stop.id);
    for (const o of all('SELECT * FROM orders WHERE trip_id = ? AND outlet_id = ?', trip.id, stop.outlet_id)) {
      const units = p.units?.[o.id] ?? (o.load_status === 'missing' ? 0 : o.order_units);
      const ds = p.outcome === 'failed' ? 'failed' : units < o.order_units ? 'partial' : 'delivered';
      run('UPDATE orders SET delivery_status = ?, delivered_units = ?, delivery_note = ?, status = ? WHERE id = ?', ds, p.outcome === 'failed' ? 0 : units, p.note || null, ds, o.id);
    }
    const left = get("SELECT COUNT(*) n FROM stops WHERE trip_id = ? AND status IN ('pending','arrived')", trip.id).n;
    if (!left) run("UPDATE trips SET status = 'completed', completed_at = ? WHERE id = ?", now(), trip.id);
    const type = p.outcome === 'failed' ? 'stop_failed' : p.outcome === 'partial' ? 'stop_partial' : 'stop_completed';
    return log(user, type, stop.outlet_id, `${trip.vehicle_id} ${p.outcome === 'failed' ? `could not deliver to ${stop.outlet_id}: ${p.note || 'no reason'}` : `${p.outcome} at ${stop.outlet_id}, signed by ${p.pod_name}`}${off}`, null, ev.id, ev.client_at);
  }
  throw new Error('Unknown event type.');
}

app.get('/api/stops/:id/pod', auth('dispatcher', 'store'), h((req) => {
  const s = get('SELECT outlet_id, pod_name, pod_signature, pod_photo, completed_at, note, recorded_offline FROM stops WHERE id = ?', req.params.id);
  if (!s || (req.user.role === 'store' && s.outlet_id !== req.user.outlet_id)) throw new HttpError(404, 'Not found');
  return s;
}));

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('*', (req, res) => res.sendFile(path.resolve('public/index.html')));

const s = ensureSeeded();
if (s) console.log(`Seeded ${s.orders} orders for ${RUN_DATE}`);
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Waypoint Dispatch on http://localhost:${port}`));
