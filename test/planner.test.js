import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
process.env.DB_PATH = 'var/test.db';
const { seed, db, readCsv } = await import('../src/db.js');
const { plan, validate } = await import('../src/planner.js');

seed();
const all = (s) => db.prepare(s).all();
const vehicles = all('SELECT * FROM vehicles').map((v) => ({ ...v, fuel_remaining_l: v.weekly_fuel_quota_l - v.fuel_used_week_l }));
const ctx = {
  vehicles: vehicles.filter((v) => v.status === 'available'), workshop: vehicles.filter((v) => v.status === 'in_workshop'),
  travel: Object.fromEntries(all('SELECT * FROM district_travel').map((d) => [d.district, d])),
  allowance: Object.fromEntries(all('SELECT * FROM service_allowance').map((a) => [`${a.brand}|${a.dock_type}`, a.service_allowance_min])),
};
const byId = Object.fromEntries(vehicles.map((v) => [v.vehicle_id, v]));
const outlets = Object.fromEntries(all('SELECT * FROM outlets').map((o) => [o.outlet_id, o]));
const orders = readCsv('task2b_peak_day_scenarios.csv').map((r) => ({ ...r, id: r.order_ref, ...outlets[r.outlet_id], deferred_yesterday: r.deferred_yesterday, days_since_last_served: r.days_since_last_served }));

test('peak-day plan respects every operating constraint', () => {
  const r = plan(orders, ctx);
  const errors = validate(r.trips, ctx, byId, new Set(ctx.vehicles.map((v) => v.vehicle_id)));
  assert.deepEqual(errors, []);
  const served = r.trips.reduce((s, t) => s + t.orders.length, 0);
  assert.equal(served + r.deferred.length, orders.length);
  assert.ok(r.deferred.every((d) => d.reason.length > 10));
  console.log(`served ${served}, deferred ${r.deferred.length}, trips ${r.trips.length}`);
  for (const d of r.deferred) console.log(' deferred', d.order.id, d.order.outlet_id, d.order.brand, d.order.temp_requirement, d.order.parking_constraint, '|', d.reason);
  // export in Task 2B format for the official checker
  fs.writeFileSync('var/submission_task2b.csv', 'scenario,order_ref,decision,vehicle_id,trip_id\n' + orders.map((o) => {
    const t = r.trips.find((x) => x.orders.includes(o));
    return `S1,${o.order_ref},${t ? 'served' : 'deferred'},${t ? t.vehicle_id : ''},${t ? t.trip_no : ''}`;
  }).join('\n') + '\n');
});

test('validator catches a chilled order on an ambient truck', () => {
  const amb = ctx.vehicles.find((v) => v.temp === 'ambient' && v.type === 'truck' && v.depot === 'Peliyagoda');
  const chilled = orders.find((o) => o.temp_requirement === 'chilled' && o.parking_constraint === 'normal' && o.depot === 'Peliyagoda');
  const errors = validate([{ vehicle_id: amb.vehicle_id, trip_no: 1, brand: chilled.brand, orders: [chilled] }], ctx, byId, new Set([amb.vehicle_id]));
  assert.ok(errors.some((e) => e.includes('chilled')));
});
