// Allocation engine. Pure functions: no database access, so it can be unit-tested
// and re-run by the dispatcher at any time.
//
// Rules (from the Waypoint operating constraints / published planning standard):
//  - one depot, one brand, one district per trip; vehicle serves only its home depot
//  - chilled orders need a reefer; van_only outlets need a van
//  - weight AND volume capacity per trip
//  - max 2 trips per vehicle per day
//  - Fresh trips share the pre-dawn window (270 min from 03:30), others the daytime window (480 min from 08:00)
//  - trip time = depot->district free-flow + (n-1) inter-stop + service allowance per order
//  - every stop must arrive before its delivery window (or mall window) closes
//  - route fuel must fit the vehicle's remaining weekly fuel quota

export const PREDAWN_START = 3 * 60 + 30;
export const DAYTIME_START = 8 * 60;
export const BUDGET = { predawn: 270, daytime: 480 };
export const MAX_TRIPS = 2;

export const toMin = (hhmm) => { if (!hhmm) return null; const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
export const toHHMM = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(Math.round(min % 60)).padStart(2, '0')}`;

export function priorityOf(o) {
  let score = 0; const why = [];
  if (o.deferred_yesterday) { score += 100; why.push('deferred on the previous run'); }
  if (o.days_since_last_served > 1) { score += 5 * o.days_since_last_served; why.push(`${o.days_since_last_served} days since last delivery`); }
  if (o.brand === 'Fresh') { score += o.temp_requirement === 'chilled' ? 30 : 20; why.push(o.temp_requirement === 'chilled' ? 'perishable chilled stock' : 'daily Fresh replenishment'); }
  if (o.brand === 'Tech') { score += 10; why.push('high-value order'); }
  if (o.brand === 'Style') { score += 5; }
  if (o.parking_constraint === 'van_only') score += 3;
  return { score, why };
}

const windowOf = (o) => (o.brand === 'Fresh' ? 'predawn' : 'daytime');

function tripMinutes(trip, ctx) {
  const d = ctx.travel[trip.district];
  const n = trip.orders.length;
  if (!n) return 0;
  return d.depot_to_district_freeflow_min + (n - 1) * d.inter_stop_freeflow_min +
    trip.orders.reduce((s, o) => s + ctx.allowance[`${o.brand}|${o.dock_type}`], 0);
}

function tripKm(trip, ctx) {
  const d = ctx.travel[trip.district];
  const stops = new Set(trip.orders.map((o) => o.outlet_id)).size;
  return 2 * d.depot_to_district_km + Math.max(0, stops - 1) * d.inter_stop_km;
}

// Sequence stops (earliest-closing window first) and compute ETAs. Returns null if a window is missed.
export function scheduleTrip(trip, start, ctx) {
  const d = ctx.travel[trip.district];
  const byOutlet = new Map();
  for (const o of trip.orders) {
    if (!byOutlet.has(o.outlet_id)) byOutlet.set(o.outlet_id, []);
    byOutlet.get(o.outlet_id).push(o);
  }
  const stops = [...byOutlet.entries()].map(([outlet_id, orders]) => ({ outlet_id, orders, open: toMin(orders[0].window_open_time), close: toMin(orders[0].window_close_time) }))
    .sort((a, b) => a.close - b.close || a.open - b.open);
  let t = start + d.depot_to_district_freeflow_min;
  const out = [];
  for (let i = 0; i < stops.length; i++) {
    if (i > 0) t += d.inter_stop_freeflow_min;
    const eta = Math.max(t, stops[i].open);
    if (eta > stops[i].close) return { ok: false, missed: stops[i].outlet_id };
    const service = stops[i].orders.reduce((s, o) => s + ctx.allowance[`${o.brand}|${o.dock_type}`], 0);
    out.push({ ...stops[i], seq: i, eta, service });
    t = eta + service;
  }
  return { ok: true, stops: out };
}

function vehicleFits(v, o) {
  if (v.depot !== o.depot) return 'depot';
  if (o.temp_requirement === 'chilled' && v.temp !== 'reefer') return 'reefer';
  if (o.parking_constraint === 'van_only' && v.type !== 'van') return 'van';
  return null;
}

// Check whether trip (with orders) is valid given the vehicle's other trips.
function evaluate(vs, trip, ctx) {
  const v = vs.vehicle;
  const w = trip.orders.reduce((s, o) => s + o.order_weight_kg, 0);
  const vol = trip.orders.reduce((s, o) => s + o.order_volume_m3, 0);
  if (w > v.weight_cap_kg + 1e-6) return 'weight';
  if (vol > v.volume_cap_m3 + 1e-6) return 'volume';
  const win = trip.window;
  const others = vs.trips.filter((t) => t !== trip && t.window === win);
  const used = others.reduce((s, t) => s + tripMinutes(t, ctx), 0);
  const mins = tripMinutes(trip, ctx);
  if (used + mins > BUDGET[win] + 1e-6) return 'time';
  const fuelOthers = vs.trips.filter((t) => t !== trip).reduce((s, t) => s + tripKm(t, ctx) / v.km_per_l, 0);
  if (fuelOthers + tripKm(trip, ctx) / v.km_per_l > v.fuel_remaining_l + 1e-6) return 'fuel';
  const start = (win === 'predawn' ? PREDAWN_START : DAYTIME_START) + used;
  const sched = scheduleTrip(trip, start, ctx);
  if (!sched.ok) return 'window';
  return null;
}

const REASONS = {
  weight: 'weight capacity', volume: 'volume capacity', time: 'driving-time window', fuel: 'weekly fuel quota', window: 'delivery window', trips: 'two-trip daily limit',
};

function deferralReason(o, fails, ctx) {
  const compatible = ctx.vehicles.filter((v) => !vehicleFits(v, o));
  const need = o.parking_constraint === 'van_only' ? (o.temp_requirement === 'chilled' ? 'refrigerated van' : 'van') : (o.temp_requirement === 'chilled' ? 'refrigerated vehicle' : 'vehicle');
  if (!compatible.length) {
    const inShop = ctx.workshop.filter((v) => !vehicleFits(v, o)).length;
    return `No ${need} available at ${o.depot}${inShop ? ` (${inShop} in workshop)` : ''}.`;
  }
  const counts = {};
  for (const f of fails) counts[f] = (counts[f] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => REASONS[k]);
  return `${compatible.length === 1 ? `The only ${need}` : `All ${compatible.length} ${need === 'vehicle' ? 'compatible vehicles' : `${need}s`}`} at ${o.depot} ${compatible.length === 1 ? 'is' : 'are'} already committed to higher-priority orders (limited by ${top.join(' and ') || 'capacity'}).`;
}

// ctx: { vehicles (available, with fuel_remaining_l), workshop, travel, allowance }
export function plan(orders, ctx) {
  const ranked = orders.map((o) => ({ o, p: priorityOf(o) }))
    .sort((a, b) => b.p.score - a.p.score || b.o.order_weight_kg - a.o.order_weight_kg);
  const vstate = new Map(ctx.vehicles.map((v) => [v.vehicle_id, { vehicle: v, trips: [] }]));
  const trips = [];
  const deferred = [];

  for (const { o, p } of ranked) {
    const fails = [];
    let placed = false;
    // 1) top up an existing trip (best fit = least spare volume)
    const open = trips.filter((t) => t.depot === o.depot && t.brand === o.brand && t.district === o.district && !vehicleFits(vstate.get(t.vehicle_id).vehicle, o))
      .sort((a, b) => a.spare - b.spare);
    for (const t of open) {
      t.orders.push(o);
      const err = evaluate(vstate.get(t.vehicle_id), t, ctx);
      if (!err) { placed = true; break; }
      t.orders.pop(); fails.push(err);
    }
    // 2) open a new trip on the most suitable spare vehicle
    if (!placed) {
      const cands = [...vstate.values()].filter((vs) => !vehicleFits(vs.vehicle, o))
        .map((vs) => {
          const v = vs.vehicle; let cost = 0;
          if (v.temp === 'reefer' && o.temp_requirement !== 'chilled') cost += 50; // keep reefers for chilled
          if (v.type === 'van' && o.parking_constraint !== 'van_only') cost += 40; // keep vans for van-only outlets
          cost += vs.trips.length * 5; // spread first trips
          cost += o.brand === 'Style' ? -v.volume_cap_m3 / 10 : v.weight_cap_kg / 1000; // Style cubes out
          return { vs, cost };
        }).sort((a, b) => a.cost - b.cost);
      for (const { vs } of cands) {
        if (vs.trips.length >= MAX_TRIPS) { fails.push('trips'); continue; }
        const t = { vehicle_id: vs.vehicle.vehicle_id, depot: o.depot, brand: o.brand, district: o.district, window: windowOf(o), orders: [o] };
        vs.trips.push(t);
        const err = evaluate(vs, t, ctx);
        if (!err) { trips.push(t); placed = true; break; }
        vs.trips.pop(); fails.push(err);
      }
    }
    if (placed) {
      for (const t of trips) t.spare = vstate.get(t.vehicle_id).vehicle.volume_cap_m3 - t.orders.reduce((s, x) => s + x.order_volume_m3, 0);
    } else {
      deferred.push({ order: o, reason: deferralReason(o, fails, ctx), priority: p });
    }
  }
  return finalize(vstate, ctx, deferred, ranked);
}

// Number trips per vehicle (pre-dawn first) and compute schedule + utilisation.
export function finalize(vstate, ctx, deferred = [], ranked = []) {
  const out = [];
  for (const vs of vstate.values()) {
    const v = vs.vehicle;
    const sorted = [...vs.trips].filter((t) => t.orders.length).sort((a, b) => (a.window === b.window ? 0 : a.window === 'predawn' ? -1 : 1));
    const used = { predawn: 0, daytime: 0 };
    sorted.forEach((t, i) => {
      const mins = tripMinutes(t, ctx);
      const start = (t.window === 'predawn' ? PREDAWN_START : DAYTIME_START) + used[t.window];
      used[t.window] += mins;
      const sched = scheduleTrip(t, start, ctx);
      const km = tripKm(t, ctx);
      out.push({
        id: t.id, vehicle_id: v.vehicle_id, trip_no: i + 1, depot: t.depot, brand: t.brand, district: t.district, window: t.window,
        depart_min: start, minutes: mins, km, fuel_l: km / v.km_per_l,
        weight: t.orders.reduce((s, o) => s + o.order_weight_kg, 0), volume: t.orders.reduce((s, o) => s + o.order_volume_m3, 0),
        stops: sched.ok ? sched.stops : [], orders: t.orders,
      });
    });
  }
  return { trips: out, deferred, priorities: new Map(ranked.map(({ o, p }) => [o.id, p])) };
}

// Independent re-check of a full allocation (mirrors check_allocation.py + window/fuel rules).
export function validate(trips, ctx, vehiclesById, availableIds) {
  const errors = [];
  const perVehicle = new Map();
  for (const t of trips) {
    const v = vehiclesById[t.vehicle_id];
    const tag = `${t.vehicle_id} trip ${t.trip_no}`;
    if (!availableIds.has(t.vehicle_id)) errors.push(`${tag}: vehicle is not available today`);
    const os = t.orders;
    if (!os.length) continue;
    if (new Set(os.map((o) => o.brand)).size > 1) errors.push(`${tag}: mixes brands`);
    if (new Set(os.map((o) => o.district)).size > 1) errors.push(`${tag}: mixes districts`);
    if (os.some((o) => o.depot !== v.depot)) errors.push(`${tag}: serves another depot`);
    if (os.some((o) => o.temp_requirement === 'chilled') && v.temp !== 'reefer') errors.push(`${tag}: chilled goods on a non-refrigerated vehicle`);
    if (os.some((o) => o.parking_constraint === 'van_only') && v.type !== 'van') errors.push(`${tag}: truck sent to a van-only outlet`);
    const w = os.reduce((s, o) => s + o.order_weight_kg, 0); const vol = os.reduce((s, o) => s + o.order_volume_m3, 0);
    if (w > v.weight_cap_kg + 1e-6) errors.push(`${tag}: ${w.toFixed(0)} kg exceeds ${v.weight_cap_kg} kg`);
    if (vol > v.volume_cap_m3 + 1e-6) errors.push(`${tag}: ${vol.toFixed(1)} m³ exceeds ${v.volume_cap_m3} m³`);
    if (!perVehicle.has(t.vehicle_id)) perVehicle.set(t.vehicle_id, []);
    perVehicle.get(t.vehicle_id).push(t);
  }
  for (const [vid, ts] of perVehicle) {
    const v = vehiclesById[vid];
    if (ts.length > MAX_TRIPS) errors.push(`${vid}: ${ts.length} trips (max ${MAX_TRIPS})`);
    const mins = { predawn: 0, daytime: 0 }; let fuel = 0;
    for (const t of ts) {
      const tt = { ...t, district: t.orders[0].district, window: t.orders[0].brand === 'Fresh' ? 'predawn' : 'daytime' };
      const m = tripMinutes(tt, ctx);
      const sched = scheduleTrip(tt, (tt.window === 'predawn' ? PREDAWN_START : DAYTIME_START) + mins[tt.window], ctx);
      if (!sched.ok) errors.push(`${vid} trip ${t.trip_no}: misses the delivery window at ${sched.missed}`);
      mins[tt.window] += m; fuel += tripKm(tt, ctx) / v.km_per_l;
    }
    if (mins.predawn > BUDGET.predawn + 1e-6) errors.push(`${vid}: Fresh trips need ${mins.predawn} min; pre-dawn window is ${BUDGET.predawn}`);
    if (mins.daytime > BUDGET.daytime + 1e-6) errors.push(`${vid}: daytime trips need ${mins.daytime} min; daytime window is ${BUDGET.daytime}`);
    if (fuel > v.fuel_remaining_l + 1e-6) errors.push(`${vid}: needs ${fuel.toFixed(0)} L but only ${v.fuel_remaining_l.toFixed(0)} L of weekly quota remains`);
  }
  return errors;
}
