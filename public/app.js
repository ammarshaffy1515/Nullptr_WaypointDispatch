// Waypoint Dispatch — single-page client for all four roles.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const S = { token: store.get('wp_token'), user: store.get('wp_user'), tab: store.get('wp_tab', 'overview'), view: null, timer: null };

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3200); }
async function api(path, opts = {}) {
  const res = await fetch(path, { method: opts.body ? 'POST' : 'GET', ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${S.token}` }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { logout(); throw new Error('Session expired'); }
  if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.errors = data.errors; throw e; }
  return data;
}
function logout() { store.del('wp_token'); store.del('wp_user'); S.token = null; S.user = null; render(); }
const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
const brandTag = (b) => `<span class="tag brand-${b}">${b}</span>`;
const tempTag = (t) => t === 'chilled' ? '<span class="pill info">❄ chilled</span>' : '<span class="pill">dry</span>';
const pct = (a, b) => Math.min(100, Math.round((a / b) * 100));
const meter = (label, a, b, unit) => { const p = pct(a, b); return `<div class="meter"><span>${label}</span><div class="bar ${p > 95 ? 'full' : p > 80 ? 'hot' : ''}"><i style="width:${p}%"></i></div><span class="mono">${a.toFixed(unit === 'm³' ? 1 : 0)}/${b} ${unit}</span></div>`; };
const STATUS = {
  confirmed: ['Confirmed', 'info'], planned: ['Scheduled', 'ok'], deferred: ['Deferred', 'warn'], loaded: ['Loaded', 'ok'], short_loaded: ['Short at dock', 'bad'],
  out_for_delivery: ['Out for delivery', 'info'], delivered: ['Delivered', 'ok'], partial: ['Partly delivered', 'warn'], failed: ['Not delivered', 'bad'], received: ['Receipt confirmed', 'ok'],
};
const statusPill = (s) => { const [l, c] = STATUS[s] || [s, '']; return `<span class="pill ${c}">${l}</span>`; };

// ---------------- offline outbox (driver) ----------------
const net = {
  get simulated() { return store.get('wp_sim_offline', false); },
  get online() { return navigator.onLine && !this.simulated; },
};
const outbox = { list: () => store.get('wp_outbox', []), add(ev) { const l = outbox.list(); l.push(ev); store.set('wp_outbox', l); }, set: (l) => store.set('wp_outbox', l) };
async function syncOutbox() {
  const pending = outbox.list();
  if (!pending.length || !net.online || S.user?.role !== 'driver') return;
  try {
    const { results } = await api('/api/sync', { body: { events: pending } });
    const rejected = results.filter((r) => r.status === 'rejected');
    const done = new Set(results.map((r) => r.id));
    outbox.set(outbox.list().filter((e) => !done.has(e.id)));
    if (rejected.length) store.set('wp_conflicts', [...store.get('wp_conflicts', []), ...rejected.map((r) => ({ ...r, at: new Date().toISOString() }))]);
    toast(`Synced ${results.length - rejected.length} record(s)${rejected.length ? `, ${rejected.length} need attention` : ''}`);
    await loadManifest();
  } catch (e) { /* stay queued; retry on next online event */ }
  if (S.user?.role === 'driver') render();
}
window.addEventListener('online', syncOutbox);
window.addEventListener('offline', () => S.user?.role === 'driver' && render());
setInterval(syncOutbox, 15000);

// ---------------- shell ----------------
function shell(content, { narrow = false } = {}) {
  const u = S.user;
  return `<header class="top"><div class="logo"><i></i>Waypoint <span style="font-weight:400;opacity:.8">Dispatch</span></div>
    <span class="pill" id="runpill"></span>
    <div class="who"><span class="name">${esc(u.name)}</span><span class="pill">${{ dispatcher: 'Dispatcher', loader: 'Loader', driver: 'Driver', store: 'Store manager' }[u.role]}</span><button id="logout">Sign out</button></div></header>
    <main class="${narrow ? 'narrow' : ''}">${content}</main>`;
}
function runPill(run) {
  const c = run?.calendar; if (!c) return '';
  const flags = [c.is_payday ? 'payday' : '', c.festival_ramp > 0 ? `festival ramp ${c.festival_ramp}` : '', c.monsoon ? 'monsoon' : ''].filter(Boolean).join(' · ');
  return `Run ${c.dow_name} ${run.run_date}${flags ? ` · ${flags}` : ''}`;
}
function mount(html, opts) {
  $('#app').innerHTML = shell(html, opts);
  $('#logout').onclick = logout;
}

async function render() {
  clearInterval(S.timer);
  if (!S.token) return renderLogin();
  try {
    if (S.user.role === 'dispatcher') await renderDispatcher();
    if (S.user.role === 'loader') await renderLoader();
    if (S.user.role === 'driver') await renderDriver();
    if (S.user.role === 'store') await renderStore();
  } catch (e) { if (S.token) toast(e.message); }
}

// ---------------- login ----------------
function renderLogin() {
  $('#app').innerHTML = `<div class="login stack">
    <div class="row"><div class="logo" style="font-weight:700;font-size:20px;color:var(--brand)">Waypoint Dispatch</div></div>
    <p class="muted">One delivery plan for Waypoint Fresh, Style and Tech, from order to receipt.</p>
    <form class="card stack" id="lf">
      <div><label for="u">Username</label><input id="u" autocomplete="username" required></div>
      <div><label for="p">Password</label><input id="p" type="password" autocomplete="current-password" required></div>
      <button class="btn block">Sign in</button>
    </form>
    <div class="card flat stack demo-accounts"><b>Demo accounts</b><span class="small muted">Password for all: <code>waypoint2026</code>. Follow the walkthrough in the README.</span>
      ${[['store', 'Store manager · OUT004 Fresh Colombo'], ['dispatcher', 'Dispatcher · Peliyagoda planning office'], ['loader', 'Loader · Peliyagoda dock (tablet)'], ['driver', 'Driver · phone']].map(([u, d], i) => `<button class="list-item" data-u="${u}"><b>${i + 1}. ${u}</b> <span class="muted small">${d}</span></button>`).join('')}
    </div></div>`;
  $('#app').querySelectorAll('[data-u]').forEach((b) => b.onclick = () => { $('#u').value = b.dataset.u; $('#p').value = 'waypoint2026'; $('#lf').requestSubmit(); });
  $('#lf').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/login', { body: { username: $('#u').value, password: $('#p').value } });
      S.token = r.token; S.user = r.user; store.set('wp_token', r.token); store.set('wp_user', r.user); S.tab = 'overview'; render();
    } catch (err) { toast(err.message); }
  };
}

// ---------------- dispatcher ----------------
async function renderDispatcher() {
  const tabs = [['overview', 'Run & queue'], ['plan', 'Plan & deferrals'], ['live', 'Live tracking']];
  const body = `<div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div><div id="tab"></div>`;
  mount(body);
  $('#app').querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { S.tab = b.dataset.tab; store.set('wp_tab', S.tab); renderDispatcher(); });
  if (!tabs.some(([k]) => k === S.tab)) S.tab = 'overview';
  if (S.tab === 'overview') await dispOverview();
  if (S.tab === 'plan') await dispPlan();
  if (S.tab === 'live') { await dispLive(); S.timer = setInterval(() => dispLive().catch(() => {}), 5000); }
}
function stepper(status) {
  const steps = [['open', 'Orders open (cutoff 16:00)'], ['closed', 'Orders closed'], ['planned', 'Plan generated'], ['released', 'Released to dock & drivers']];
  const idx = steps.findIndex(([k]) => k === status);
  return `<div class="stepper">${steps.map(([, l], i) => `<div class="${i < idx ? 'done' : i === idx ? 'now' : ''}">${i + 1}. ${l}</div>`).join('')}</div>`;
}
async function dispOverview() {
  const [run, orders] = await Promise.all([api('/api/run'), api('/api/orders')]);
  $('#runpill').textContent = runPill(run);
  const cur = orders.filter((o) => o.run_date === run.run_date);
  const sum = (k, f = () => true) => cur.filter(f).reduce((s, o) => s + o[k], 0);
  const next = orders.filter((o) => o.run_date !== run.run_date);
  $('#tab').innerHTML = `<div class="stack">
    <div class="card stack"><div class="row between"><h2>Delivery run · ${run.calendar.dow_name} ${run.run_date}</h2>
      <div class="row">${run.status === 'open' ? '<button class="btn" id="close">Close orders</button>' : ''}
      ${['closed', 'planned'].includes(run.status) ? `<button class="btn" id="plan">${run.status === 'planned' ? 'Re-run allocation' : 'Generate plan'}</button>` : ''}
      ${run.status === 'planned' ? '<button class="btn warn" id="release">Release plan</button>' : ''}
      <button class="btn ghost sm" id="reset" title="Reseed the demo day">Reset demo</button></div></div>
      ${stepper(run.status)}
      ${run.calendar.is_payday || run.calendar.festival_ramp ? `<div class="banner warn">Peak day: payday${run.calendar.festival_ramp ? `, ${Math.round(run.calendar.festival_ramp * 9)} of 9 days into the Vesak ramp` : ''}${run.calendar.monsoon ? ', monsoon travel' : ''}. Next operating day is <b>${run.next_run.dow_name} ${run.next_run.date}</b> (the day after is a holiday), so deferrals wait two days.</div>` : ''}
    </div>
    <div class="grid g4">
      <div class="card kpi"><b>${cur.length}</b><span>confirmed orders in queue</span></div>
      <div class="card kpi"><b>${(sum('order_weight_kg') / 1000).toFixed(1)} t</b><span>${sum('order_volume_m3').toFixed(0)} m³ to move</span></div>
      <div class="card kpi"><b>${cur.filter((o) => o.temp_requirement === 'chilled').length}</b><span>chilled orders (need reefers)</span></div>
      <div class="card kpi"><b>${cur.filter((o) => o.deferred_yesterday).length}</b><span>outlets skipped on the last run</span></div>
    </div>
    <div class="card"><div class="row between"><h3>Order queue</h3><span class="small muted">Priority = previous deferral, days since served, perishability, value</span></div>
      <div class="tablewrap"><table><thead><tr><th>Order</th><th>Outlet</th><th>Brand</th><th>Depot · district</th><th>Type</th><th>Units</th><th>kg</th><th>m³</th><th>Access</th><th>Placed</th><th>Priority</th><th>Status</th></tr></thead><tbody>
      ${cur.sort((a, b) => b.preview_priority.score - a.preview_priority.score).map((o) => `<tr><td class="mono">${esc(o.id)}</td><td>${o.outlet_id}</td><td>${brandTag(o.brand)}</td><td>${o.depot} · ${o.district}</td><td>${tempTag(o.temp_requirement)}</td><td class="mono">${o.order_units}</td><td class="mono">${o.order_weight_kg}</td><td class="mono">${o.order_volume_m3}</td>
        <td class="small">${o.parking_constraint === 'van_only' ? '<span class="pill warn">van only</span>' : o.parking_constraint === 'mall_dock' ? `<span class="pill">mall ${o.mall_window}</span>` : o.dock_type.replace('_', ' ')}</td><td class="small">${o.placed_at?.length > 5 ? fmtTime(o.placed_at) : esc(o.placed_at)}</td>
        <td class="small" title="${esc(o.preview_priority.why.join('; '))}">${o.preview_priority.score}${o.deferred_yesterday ? ' <span class="pill bad">skipped last run</span>' : ''}</td><td>${statusPill(o.status)}</td></tr>`).join('')}
      </tbody></table></div></div>
    ${next.length ? `<div class="card"><h3>Received after cutoff → ${run.next_run.date} run</h3><table><tbody>${next.map((o) => `<tr><td>${o.id}</td><td>${o.outlet_id}</td><td>${tempTag(o.temp_requirement)}</td><td>${o.order_units} units</td></tr>`).join('')}</tbody></table></div>` : ''}
  </div>`;
  const act = (id, path, msg) => $(id) && ($(id).onclick = async () => { try { await api(path, { body: {} }); toast(msg); if (path.includes('plan')) { S.tab = 'plan'; store.set('wp_tab', 'plan'); } renderDispatcher(); } catch (e) { toast(e.message); } });
  act('#close', '/api/run/close', 'Orders closed: queue is final');
  act('#plan', '/api/run/plan', 'Allocation complete');
  act('#release', '/api/run/release', 'Plan released to loaders, drivers and stores');
  $('#reset').onclick = async () => { if (!confirm('Reset the demo day to its seeded state?')) return; await api('/api/reset', { body: {} }); store.del('wp_outbox'); store.del('wp_conflicts'); toast('Demo reset'); logout(); };
}

async function dispPlan() {
  const p = await api('/api/plan');
  $('#runpill').textContent = runPill(p.run);
  if (!p.trips.length && !p.deferred.length) { $('#tab').innerHTML = `<div class="card">No plan yet. ${p.run.status === 'open' ? 'Close orders first, then generate a plan.' : 'Generate a plan from the Run & queue tab.'}</div>`; return; }
  const v = p.run.validation;
  const editable = p.run.status === 'planned';
  const served = p.trips.reduce((s, t) => s + t.stops.reduce((a, st) => a + st.orders.length, 0), 0);
  const fleetUsed = new Set(p.trips.map((t) => t.vehicle_id)).size;
  const avail = p.fleet.filter((f) => f.status === 'available').length;
  const vehicleOptions = (o) => p.fleet.filter((f) => f.status === 'available' && f.depot === o.depot && (o.temp_requirement !== 'chilled' || f.temp === 'reefer') && (o.parking_constraint !== 'van_only' || f.type === 'van'));
  const tripOptions = (o) => p.trips.filter((t) => t.depot === o.depot && t.brand === o.brand && t.district === o.district && (o.temp_requirement !== 'chilled' || t.vehicle.temp === 'reefer') && (o.parking_constraint !== 'van_only' || t.vehicle.type === 'van'));
  const byDepot = {};
  for (const t of p.trips) (byDepot[t.depot] ||= []).push(t);
  $('#tab').innerHTML = `<div class="stack">
    <div class="grid g4">
      <div class="card kpi"><b>${served}</b><span>orders served</span></div>
      <div class="card kpi"><b style="color:var(--warn)">${p.deferred.length}</b><span>deferred to ${p.run.next_run.date}</span></div>
      <div class="card kpi"><b>${p.trips.length}</b><span>trips on ${fleetUsed} of ${avail} available vehicles</span></div>
      <div class="card kpi"><b>${p.fleet.filter((f) => f.status === 'in_workshop').length}</b><span>vehicles in workshop today</span></div>
    </div>
    ${v ? `<div class="banner ${v.ok ? 'ok' : 'bad'}"><b>${v.ok ? '✓ Constraint check passed' : '✕ Constraint check failed'}</b> · capacity (kg & m³), reefer for chilled, van-only access, one brand/district per trip, 2 trips/vehicle, pre-dawn 270 min & daytime 480 min windows, outlet & mall windows, weekly fuel quota.${v.errors.length ? `<ul class="errors">${v.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}</div>` : ''}
    ${p.run.status === 'released' ? '<div class="banner info">Plan released. Loaders, drivers and stores can see it. Changes are locked.</div>' : '<div class="banner info">Review the plan, adjust deferrals if needed, then release it from the Run & queue tab.</div>'}
    <div class="card"><div class="row between"><h3>Deferred orders (${p.deferred.length})</h3><span class="small muted">Each deferral keeps its reason; stores are notified on release.</span></div>
      <div class="tablewrap"><table><thead><tr><th>Order</th><th>Outlet</th><th>Brand</th><th>Need</th><th>Size</th><th>Reason</th>${editable ? '<th>Serve instead</th>' : ''}</tr></thead><tbody>
      ${p.deferred.map((o) => `<tr><td class="mono">${o.id}</td><td>${o.outlet_id}<br><span class="small muted">${o.depot} · ${o.district}</span>${o.consecutive_deferral ? '<br><span class="pill bad">2nd run in a row</span>' : ''}</td><td>${brandTag(o.brand)}</td>
        <td>${tempTag(o.temp_requirement)}${o.parking_constraint === 'van_only' ? ' <span class="pill warn">van only</span>' : ''}</td><td class="mono small">${o.order_weight_kg} kg<br>${o.order_volume_m3} m³</td>
        <td class="small">${esc(o.deferral_reason)}<br><span class="muted">by ${esc(o.deferred_by)}</span></td>
        ${editable ? `<td><div class="row" style="flex-wrap:nowrap"><select data-assign="${o.id}" style="min-width:170px"><option value="">Choose trip or vehicle…</option>
          ${tripOptions(o).map((t) => `<option value="t:${t.id}">${t.vehicle_id} trip ${t.trip_no} (${t.weight.toFixed(0)} kg)</option>`).join('')}
          ${vehicleOptions(o).map((f) => `<option value="v:${f.vehicle_id}">New trip · ${f.vehicle_id} ${f.type}/${f.temp}</option>`).join('')}</select><button class="btn sm" data-go="${o.id}">Assign</button></div><div class="errors" data-err="${o.id}"></div></td>` : ''}</tr>`).join('') || '<tr><td colspan="7" class="muted">Nothing deferred.</td></tr>'}
      </tbody></table></div></div>
    ${Object.entries(byDepot).map(([depot, trips]) => `<h3>${depot} depot · ${trips.length} trips</h3><div class="grid g2">${trips.map((t) => `
      <div class="card trip ${t.brand}"><div class="row between"><div><b>${t.vehicle_id}</b> · trip ${t.trip_no} <span class="small muted">${t.vehicle.type} · ${t.vehicle.temp}</span></div><div>${brandTag(t.brand)} <span class="pill">${t.district}</span> <span class="pill">${t.window === 'predawn' ? 'pre-dawn' : 'daytime'} · dep ${t.depart}</span></div></div>
        <div class="stack" style="margin-top:8px">${meter('Weight', t.weight, t.vehicle.weight_cap_kg, 'kg')}${meter('Volume', t.volume, t.vehicle.volume_cap_m3, 'm³')}${meter('Time', t.minutes, t.window === 'predawn' ? 270 : 480, 'min')}<div class="small muted">${t.km.toFixed(0)} km · ${t.fuel_l.toFixed(1)} L fuel (${(t.vehicle.weekly_fuel_quota_l - t.vehicle.fuel_used_week_l).toFixed(0)} L of weekly quota left before this run)</div></div>
        <ul class="stops">${t.stops.map((s) => `<li><span class="seq">${s.seq + 1}</span><div class="grow"><b>${s.outlet_id}</b> <span class="small muted">ETA ${s.eta} · window ${s.orders[0].window_open_time}–${s.orders[0].window_close_time}</span>
          ${s.orders.map((o) => `<div class="row small">${tempTag(o.temp_requirement)} <span class="mono">${o.id}</span> ${o.order_units} u · ${o.order_weight_kg} kg ${editable ? `<button class="btn ghost sm" data-defer="${o.id}">Defer</button>` : ''}</div>`).join('')}</div></li>`).join('')}</ul></div>`).join('')}</div>`).join('')}
  </div>`;
  $('#tab').querySelectorAll('[data-defer]').forEach((b) => b.onclick = async () => {
    const reason = prompt(`Why defer ${b.dataset.defer}? The store will see this reason.`);
    if (!reason) return;
    try { await api(`/api/orders/${b.dataset.defer}/defer`, { body: { reason } }); toast('Order deferred and plan re-sequenced'); dispPlan(); } catch (e) { toast(e.message); }
  });
  $('#tab').querySelectorAll('[data-go]').forEach((b) => b.onclick = async () => {
    const id = b.dataset.go; const val = $(`[data-assign="${id}"]`).value; const err = $(`[data-err="${id}"]`);
    if (!val) return toast('Pick a trip or vehicle');
    const [k, x] = val.split(':');
    try { await api(`/api/orders/${id}/assign`, { body: k === 't' ? { trip_id: Number(x) } : { vehicle_id: x } }); toast('Assigned. Constraint check passed.'); dispPlan(); } catch (e) { err.innerHTML = `${esc(e.message)}${(e.errors || []).map((x2) => `<li>${esc(x2)}</li>`).join('')}`; }
  });
}

async function dispLive() {
  const d = await api('/api/live');
  if (!$('#tab')) return;
  $('#runpill').textContent = runPill(d.run);
  const minsAgo = (iso) => iso ? Math.round((Date.now() - new Date(iso)) / 60000) : null;
  $('#tab').innerHTML = `<div class="grid" style="grid-template-columns:minmax(0,2fr) minmax(280px,1fr)">
    <div class="stack"><div class="card"><h3>Trips</h3><div class="tablewrap"><table><thead><tr><th>Vehicle</th><th>Brand · district</th><th>Departs</th><th>Status</th><th>Progress</th><th>Last sync</th></tr></thead><tbody>
      ${d.trips.map((t) => `<tr><td><b>${t.vehicle_id}</b> #${t.trip_no}</td><td>${brandTag(t.brand)} ${t.district}</td><td class="mono">${t.depart}</td><td>${{ planned: '<span class="pill">at dock</span>', loaded: '<span class="pill info">loaded</span>', departed: '<span class="pill ok">on road</span>', completed: '<span class="pill ok">complete</span>' }[t.status]}</td>
        <td style="min-width:140px"><div class="row" style="gap:3px">${t.stops.map((s) => `<span class="seq ${s.status}" title="${s.outlet_id} ${s.status}${s.recorded_offline ? ' (recorded offline)' : ''}">${s.recorded_offline ? '⇣' : s.seq + 1}</span>`).join('')}</div></td>
        <td class="small">${t.last_sync_at ? `${minsAgo(t.last_sync_at)} min ago` : t.status === 'departed' ? '<span class="pill warn">no signal yet</span>' : '–'}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No trips yet.</td></tr>'}
    </tbody></table></div><p class="small muted">⇣ = recorded by the driver while offline and reconciled on reconnect.</p></div></div>
    <div class="stack"><div class="card"><h3>Needs attention (${d.alerts.length})</h3><div class="feed">${d.alerts.map((a) => `<div><span class="pill ${a.type === 'receipt_issue' || a.type === 'stop_failed' || a.type === 'sync_conflict' ? 'bad' : 'warn'}">${a.type.replace('_', ' ')}</span> ${esc(a.message)}<br><span class="small muted">${fmtTime(a.at)} · ${esc(a.actor)}</span></div>`).join('') || '<span class="muted">All clear.</span>'}</div></div>
      <div class="card"><h3>Activity</h3><div class="feed">${d.feed.map((a) => `<div>${esc(a.message)}<br><span class="small muted">${fmtTime(a.at)} · ${esc(a.actor)}${a.client_at && a.client_at !== a.at ? ` · recorded ${fmtTime(a.client_at)}` : ''}</span></div>`).join('')}</div></div></div></div>`;
}

// ---------------- loader ----------------
async function renderLoader() {
  const depot = store.get('wp_depot', S.user.depot);
  const sel = S.view?.trip;
  if (sel) return loaderTrip(sel);
  const d = await api(`/api/loader/trips?depot=${depot}`);
  mount(`<div class="stack"><div class="row between"><h2>Dock · ${depot}</h2><select id="depot" style="width:auto"><option ${depot === 'Peliyagoda' ? 'selected' : ''}>Peliyagoda</option><option ${depot === 'Kandy' ? 'selected' : ''}>Kandy</option></select></div>
    ${d.run_status !== 'released' ? '<div class="banner warn">The dispatcher has not released today\'s plan yet. This list updates when it does.</div>' : ''}
    ${d.trips.map((t) => `<button class="list-item" data-trip="${t.id}"><div class="row between"><b>${t.vehicle_id} · trip ${t.trip_no}</b>${t.status === 'planned' ? '<span class="pill warn">to load</span>' : `<span class="pill ok">${t.status}</span>`}</div>
      <div class="small muted">${t.brand} · ${t.district} · departs ${t.depart} · ${t.orders} orders · ${t.vtype}/${t.vtemp}</div></button>`).join('')}</div>`, { narrow: true });
  $('#depot').onchange = (e) => { store.set('wp_depot', e.target.value); renderLoader(); };
  $('#app').querySelectorAll('[data-trip]').forEach((b) => b.onclick = () => { S.view = { trip: Number(b.dataset.trip) }; renderLoader(); });
  S.timer = setInterval(() => { if (!S.view?.trip && S.user?.role === 'loader') renderLoader(); }, 10000);
}
async function loaderTrip(id) {
  const t = await api(`/api/trips/${id}`);
  const checks = S.view.checks ||= {};
  const orders = [...t.stops].reverse().flatMap((s) => s.orders.map((o) => ({ ...o, stop: s })));
  const draw = () => {
    mount(`<div class="stack"><button class="btn ghost sm" id="back">← All trips</button>
      <div class="card"><div class="row between"><h2>${t.vehicle_id} · trip ${t.trip_no}</h2>${brandTag(t.brand)}</div><div class="small muted">${t.vtype}/${t.vtemp} · ${t.district} · departs ${t.depart} · ${t.weight.toFixed(0)}/${t.weight_cap_kg} kg · ${t.volume.toFixed(1)}/${t.volume_cap_m3} m³</div></div>
      <div class="banner info">Load from the front of this list: the <b>last stop goes in first</b> so the first stop is at the doors.</div>
      ${orders.map((o, i) => { const c = checks[o.id] || {}; return `<div class="card"><div class="row between"><b>${i + 1}. Stop ${o.stop.seq + 1} · ${o.outlet_id}</b>${tempTag(o.temp_requirement)}</div>
        <div class="small muted">${o.id} · ${o.order_units} units · ${o.order_weight_kg} kg · ${o.order_volume_m3} m³ · ${o.stop.dock_type.replace('_', ' ')}</div>
        ${t.status === 'planned' ? `<div class="seg" style="margin-top:8px">${[['ok', 'Loaded', 'ok'], ['short', 'Short', 'warn'], ['missing', 'Missing', 'bad']].map(([k, l, c2]) => `<button data-o="${o.id}" data-s="${k}" class="${c.status === k ? `on ${c2}` : ''}">${l}</button>`).join('')}</div>
        ${c.status && c.status !== 'ok' ? `<input data-note="${o.id}" placeholder="What is missing or damaged?" value="${esc(c.note || '')}" style="margin-top:6px">` : ''}` : `<div style="margin-top:6px">${o.load_status === 'ok' ? '<span class="pill ok">loaded</span>' : `<span class="pill bad">${o.load_status}</span> ${esc(o.load_note || '')}`}</div>`}</div>`; }).join('')}
      ${t.status === 'planned' ? `<button class="btn block" id="confirm" ${orders.every((o) => checks[o.id]?.status) ? '' : 'disabled'}>Confirm load (${Object.keys(checks).length}/${orders.length} checked)</button><button class="btn ghost block" id="allok">Mark all loaded</button>` : '<div class="banner ok">Load confirmed. The driver can depart.</div>'}</div>`, { narrow: true });
    $('#back').onclick = () => { S.view = null; renderLoader(); };
    $('#app').querySelectorAll('[data-o]').forEach((b) => b.onclick = () => { checks[b.dataset.o] = { ...checks[b.dataset.o], status: b.dataset.s }; draw(); });
    $('#app').querySelectorAll('[data-note]').forEach((inp) => inp.oninput = () => { checks[inp.dataset.note].note = inp.value; });
    if ($('#allok')) $('#allok').onclick = () => { orders.forEach((o) => { if (!checks[o.id]) checks[o.id] = { status: 'ok' }; }); draw(); };
    if ($('#confirm')) $('#confirm').onclick = async () => {
      try { await api(`/api/trips/${id}/load`, { body: { items: orders.map((o) => ({ order_id: o.id, ...checks[o.id] })) } }); toast('Load confirmed'); S.view = { trip: id }; loaderTrip(id); } catch (e) { toast(e.message); }
    };
  };
  draw();
}

// ---------------- driver (offline-first) ----------------
async function loadManifest() {
  if (!net.online) return store.get('wp_manifest');
  try { const m = await api('/api/driver/manifest'); applyOutbox(m); store.set('wp_manifest', m); return m; } catch { return store.get('wp_manifest'); }
}
// Re-apply still-queued local events on top of a fresh server manifest.
function applyOutbox(m) {
  for (const ev of outbox.list()) {
    const t = m.trips.find((x) => x.id === ev.trip_id); if (!t) continue;
    if (ev.type === 'depart') t.status = 'departed';
    const s = t.stops.find((x) => x.id === ev.stop_id); if (!s) continue;
    if (ev.type === 'arrive' && s.status === 'pending') s.status = 'arrived';
    if (ev.type === 'complete') { s.status = ev.payload.outcome; s.pod_name = ev.payload.pod_name; s._queued = true; }
  }
}
function record(m, ev) {
  ev = { id: crypto.randomUUID(), client_at: new Date().toISOString(), offline: !net.online, ...ev };
  outbox.add(ev); applyOutbox(m); store.set('wp_manifest', m);
  syncOutbox();
}
async function renderDriver() {
  const m = await loadManifest();
  const pending = outbox.list().length; const conflicts = store.get('wp_conflicts', []);
  const status = `${!net.online ? `<div class="banner offline">● No signal. Working offline. ${pending} record(s) saved on this phone and will sync automatically.</div>` : pending ? `<div class="banner warn">Syncing ${pending} record(s)…</div>` : `<div class="banner ok">Online · all records synced${m?.synced_at ? ` · ${fmtTime(m.synced_at)}` : ''}</div>`}
    ${conflicts.length ? `<div class="banner bad"><div class="grow"><b>${conflicts.length} record(s) need attention.</b> The dispatcher has been alerted.<ul class="errors">${conflicts.map((c) => `<li>${esc(c.reason)}</li>`).join('')}</ul></div><button class="btn sm ghost" id="clearc">Dismiss</button></div>` : ''}
    <label class="row small" style="justify-content:flex-end;gap:6px"><input type="checkbox" id="sim" style="width:auto" ${net.simulated ? 'checked' : ''}> Simulate no signal (demo)</label>`;
  if (!m) { mount(`${status}<div class="card">No route downloaded yet. Connect once at the depot to download today's route.</div>`, { narrow: true }); return bindDriver(m); }
  const v = S.view || {};
  if (v.stop) return driverStop(m, v.trip, v.stop, status);
  if (v.trip) return driverTrip(m, v.trip, status);
  mount(`<div class="stack">${status}<h2>Today · ${m.vehicle ? `${m.vehicle.vehicle_id} (${m.vehicle.type}, ${m.vehicle.temp})` : 'no vehicle'}</h2>
    ${m.run_status !== 'released' ? '<div class="banner warn">Today\'s route has not been released yet.</div>' : ''}
    ${m.trips.map((t) => `<button class="list-item" data-trip="${t.id}"><div class="row between"><b>Trip ${t.trip_no} · ${t.district}</b>${{ planned: '<span class="pill warn">loading</span>', loaded: '<span class="pill info">ready</span>', departed: '<span class="pill ok">on road</span>', completed: '<span class="pill ok">done</span>' }[t.status]}</div>
      <div class="small muted">${t.brand} · depart ${t.depart} · ${t.stops.length} stops · ${t.stops.filter((s) => !['pending', 'arrived'].includes(s.status)).length} done</div></button>`).join('')}</div>`, { narrow: true });
  $('#app').querySelectorAll('[data-trip]').forEach((b) => b.onclick = () => { S.view = { trip: Number(b.dataset.trip) }; renderDriver(); });
  bindDriver(m);
}
function bindDriver() {
  if ($('#sim')) $('#sim').onchange = (e) => { store.set('wp_sim_offline', e.target.checked); if (!e.target.checked) syncOutbox(); else render(); };
  if ($('#clearc')) $('#clearc').onclick = () => { store.del('wp_conflicts'); render(); };
}
function driverTrip(m, tid, status) {
  const t = m.trips.find((x) => x.id === tid); if (!t) { S.view = null; return renderDriver(); }
  mount(`<div class="stack">${status}<button class="btn ghost sm" id="back">← Trips</button>
    <div class="card"><div class="row between"><h2>Trip ${t.trip_no} · ${t.district}</h2>${brandTag(t.brand)}</div><div class="small muted">${t.vehicle_id} · depart ${t.depart} · ${t.weight.toFixed(0)} kg</div></div>
    ${t.status === 'planned' ? '<div class="banner warn">Waiting for the dock to confirm loading.</div>' : ''}
    ${t.status === 'loaded' ? '<button class="btn block" id="depart">Start trip</button>' : ''}
    ${t.stops.some((s) => s.orders.some((o) => o.load_status && o.load_status !== 'ok')) ? '<div class="banner bad">Loading shortfall on this trip. Affected stops are marked; the stores have been told.</div>' : ''}
    ${t.stops.map((s) => `<button class="list-item" data-stop="${s.id}" ${t.status === 'departed' || t.status === 'completed' ? '' : 'disabled'}><div class="row"><span class="seq ${s.status}">${s.seq + 1}</span><b class="grow">${s.outlet_id}</b><span class="mono">ETA ${s.eta}</span></div>
      <div class="small muted" style="margin-left:30px">${s.dock_type.replace('_', ' ')}${s.parking_constraint !== 'normal' ? ` · ${s.parking_constraint.replace('_', ' ')}` : ''} · window ${s.window_open_time}–${s.window_close_time} · ${s.orders.length} order(s)${s.orders.some((o) => o.load_status && o.load_status !== 'ok') ? ' · <b style="color:var(--bad)">short-loaded</b>' : ''}${s._queued ? ' · <b>saved offline</b>' : ''}</div></button>`).join('')}</div>`, { narrow: true });
  $('#back').onclick = () => { S.view = null; renderDriver(); };
  if ($('#depart')) $('#depart').onclick = () => { record(m, { type: 'depart', trip_id: t.id }); toast('Trip started'); renderDriver(); };
  $('#app').querySelectorAll('[data-stop]').forEach((b) => b.onclick = () => { S.view = { trip: tid, stop: Number(b.dataset.stop) }; renderDriver(); });
  bindDriver();
}
function driverStop(m, tid, sid, status) {
  const t = m.trips.find((x) => x.id === tid); const s = t?.stops.find((x) => x.id === sid);
  if (!s) { S.view = { trip: tid }; return renderDriver(); }
  const f = S.view.form ||= { outcome: 'delivered', units: {}, pod_name: '', note: '', photo: null, signature: null };
  const done = !['pending', 'arrived'].includes(s.status);
  mount(`<div class="stack">${status}<button class="btn ghost sm" id="back">← Stops</button>
    <div class="card"><div class="row between"><h2>Stop ${s.seq + 1} · ${s.outlet_id}</h2><span class="mono">ETA ${s.eta}</span></div><div class="small muted">${s.district} · ${s.dock_type.replace('_', ' ')} · window ${s.window_open_time}–${s.window_close_time}</div>
      ${s.orders.map((o) => `<div class="row small" style="margin-top:6px">${tempTag(o.temp_requirement)} ${o.id} · ${o.order_units} units${o.load_status && o.load_status !== 'ok' ? ` <span class="pill bad">${o.load_status} at dock</span>` : ''}</div>`).join('')}</div>
    ${done ? `<div class="banner ${s.status === 'failed' ? 'bad' : 'ok'}">Recorded as <b>${s.status}</b>${s.pod_name ? `, signed by ${esc(s.pod_name)}` : ''}${s._queued ? ' · waiting to sync' : ''}.</div>` : `
      ${s.status === 'pending' ? '<button class="btn block ghost" id="arrive">I have arrived</button>' : '<div class="banner info">Arrived. Record the outcome when unloading is done.</div>'}
      <div class="card stack"><div class="seg">${[['delivered', 'Delivered', 'ok'], ['partial', 'Partial', 'warn'], ['failed', 'Failed', 'bad']].map(([k, l, c]) => `<button data-out="${k}" class="${f.outcome === k ? `on ${c}` : ''}">${l}</button>`).join('')}</div>
        ${f.outcome === 'partial' ? s.orders.map((o) => `<div><label>Units delivered · ${o.id} (of ${o.order_units})</label><input type="number" min="0" max="${o.order_units}" data-units="${o.id}" value="${f.units[o.id] ?? (o.load_status === 'missing' ? 0 : o.order_units)}"></div>`).join('') : ''}
        ${f.outcome !== 'failed' ? `<div><label>Received by</label><input id="podname" value="${esc(f.pod_name)}" placeholder="Name of store staff"></div>
        <div><label>Signature</label><canvas class="sig" id="sig"></canvas><button class="btn ghost sm" id="sigclear" style="margin-top:4px">Clear</button></div>
        <div><label>Photo of goods (optional)</label><input type="file" accept="image/*" capture="environment" id="photo">${f.photo ? '<span class="small muted">Photo attached ✓</span>' : ''}</div>` : ''}
        <div><label>${f.outcome === 'failed' ? 'Why could you not deliver?' : 'Notes (damage, shortages)'}</label><textarea id="note" rows="2">${esc(f.note)}</textarea></div>
        <button class="btn block" id="save">Save ${net.online ? '' : 'offline '}record</button></div>`}</div>`, { narrow: true });
  $('#back').onclick = () => { S.view = { trip: tid }; renderDriver(); };
  bindDriver();
  if (done) return;
  if ($('#arrive')) $('#arrive').onclick = () => { record(m, { type: 'arrive', trip_id: tid, stop_id: sid }); renderDriver(); };
  $('#app').querySelectorAll('[data-out]').forEach((b) => b.onclick = () => { f.outcome = b.dataset.out; renderDriver(); });
  $('#app').querySelectorAll('[data-units]').forEach((i) => i.oninput = () => { f.units[i.dataset.units] = Number(i.value); });
  if ($('#podname')) $('#podname').oninput = (e) => { f.pod_name = e.target.value; };
  $('#note').oninput = (e) => { f.note = e.target.value; };
  const c = $('#sig');
  if (c) {
    const ctx = c.getContext('2d'); c.width = c.clientWidth; c.height = 140; ctx.lineWidth = 2; ctx.lineCap = 'round';
    if (f.signature) { const img = new Image(); img.onload = () => ctx.drawImage(img, 0, 0); img.src = f.signature; }
    let drawing = false; const pos = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    c.onpointerdown = (e) => { drawing = true; ctx.beginPath(); ctx.moveTo(...pos(e)); };
    c.onpointermove = (e) => { if (drawing) { ctx.lineTo(...pos(e)); ctx.stroke(); } };
    c.onpointerup = c.onpointerleave = () => { if (drawing) { drawing = false; f.signature = c.toDataURL('image/png'); } };
    $('#sigclear').onclick = () => { ctx.clearRect(0, 0, c.width, c.height); f.signature = null; };
    $('#photo').onchange = (e) => {
      const file = e.target.files[0]; if (!file) return;
      const img = new Image(); img.onload = () => { const k = Math.min(1, 800 / img.width); const cv = document.createElement('canvas'); cv.width = img.width * k; cv.height = img.height * k; cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height); f.photo = cv.toDataURL('image/jpeg', 0.6); renderDriver(); };
      img.src = URL.createObjectURL(file);
    };
  }
  $('#save').onclick = () => {
    if (f.outcome !== 'failed' && !f.pod_name.trim()) return toast('Enter who received the goods');
    if (f.outcome === 'failed' && f.note.trim().length < 3) return toast('Say why the delivery failed');
    if (s.status === 'pending') record(m, { type: 'arrive', trip_id: tid, stop_id: sid });
    record(m, { type: 'complete', trip_id: tid, stop_id: sid, payload: { outcome: f.outcome, pod_name: f.pod_name, note: f.note, photo: f.photo, signature: f.signature, units: f.outcome === 'partial' ? f.units : undefined } });
    toast(net.online ? 'Delivery recorded' : 'Saved on this phone. Will sync when signal returns');
    S.view = { trip: tid }; renderDriver();
  };
}

// ---------------- store manager ----------------
async function renderStore() {
  const d = await api('/api/store');
  const o = d.outlet; const run = d.run;
  const steps = (x) => {
    const order = ['confirmed', 'planned', 'loaded', 'out_for_delivery', 'delivered', 'received'];
    const map = { short_loaded: 2, partial: 4, failed: 4, deferred: 1 };
    const i = map[x.status] ?? order.indexOf(x.status);
    return `<div class="timeline">${order.map((_, k) => `<span class="${k <= i ? (x.status === 'deferred' && k === 1) || (x.status === 'failed' && k === 4) ? 'bad' : (x.status === 'short_loaded' && k === 2) || (x.status === 'partial' && k === 4) ? 'warn' : 'on' : ''}"></span>`).join('')}</div><div class="row between small muted"><span>Placed</span><span>Scheduled</span><span>Loaded</span><span>On road</span><span>Delivered</span><span>Received</span></div>`;
  };
  mount(`<div class="stack">
    <div class="row between"><div><h2>${o.outlet_id} · Waypoint ${o.brand}</h2><div class="small muted">${o.district} · ${o.dock_type.replace('_', ' ')} · receiving window ${o.window_open_time}–${o.window_close_time}</div></div></div>
    ${d.notices.filter((n) => n.type === 'order_deferred' || n.type === 'shortfall').map((n) => `<div class="banner warn"><b>${n.type === 'shortfall' ? 'Loading shortfall' : 'Order deferred'}:</b> ${esc(n.message)}</div>`).join('')}
    <div class="card stack"><div class="row between"><h3>Place an order</h3>${run.status === 'open' ? `<span class="pill ok">Open for ${run.calendar.dow_name} ${run.run_date} · closes 16:00</span>` : `<span class="pill warn">Cutoff passed · new orders go to ${run.next_run.dow_name} ${run.next_run.date}</span>`}</div>
      <form id="of" class="row" style="align-items:flex-end">
        <div class="grow" style="min-width:140px"><label>Goods</label><select id="ot">${o.brand === 'Fresh' ? '<option value="ambient">Dry groceries</option><option value="chilled">Chilled & frozen</option>' : '<option value="ambient">Stock</option>'}</select></div>
        <div style="width:120px"><label>Units / cases</label><input id="ou" type="number" min="1" max="2000" value="40" required></div>
        <button class="btn">Submit order</button></form>
      <span class="small muted">You get a confirmation number straight away. Weight and volume are estimated from the units.</span></div>
    <h3>Your deliveries</h3>
    ${d.orders.map((x) => `<div class="card stack"><div class="row between"><div><b>${x.temp_requirement === 'chilled' ? 'Chilled & frozen' : 'Dry'} · ${x.order_units} units</b> <span class="small muted mono">${x.id}</span></div>${statusPill(x.status)}</div>
      <div class="small muted">For ${x.run_date} · ${x.order_weight_kg} kg</div>${steps(x)}
      ${x.status === 'deferred' ? `<div class="banner warn">${run.status === 'released' ? `Moved to the <b>${run.next_run.dow_name} ${run.next_run.date}</b> run. Reason: ${esc(x.deferral_reason)}${x.consecutive_deferral ? ' This outlet is now top priority on the next run.' : ''}` : 'Planning is in progress.'}</div>` : ''}
      ${x.eta && run.status === 'released' && !['delivered', 'partial', 'failed', 'received'].includes(x.status) ? `<div class="banner info">Expected around <b>${x.eta}</b> on ${x.trip.vehicle_id}${x.stops_ahead != null ? ` · ${x.stops_ahead} stop(s) before you` : ''}. Plan receiving staff for this time.</div>` : ''}
      ${x.load_status && x.load_status !== 'ok' ? `<div class="banner bad">The dock flagged this order as <b>${x.load_status}</b> before departure${x.load_note ? `: ${esc(x.load_note)}` : ''}.</div>` : ''}
      ${['delivered', 'partial', 'failed'].includes(x.status) ? `<div class="banner ${x.status === 'failed' ? 'bad' : 'ok'}">Driver recorded <b>${x.status}</b>${x.delivered_units != null ? ` · ${x.delivered_units}/${x.order_units} units` : ''}${x.stop?.pod_name ? ` · signed by ${esc(x.stop.pod_name)}` : ''} at ${fmtTime(x.stop?.completed_at)}${x.delivery_note ? ` · “${esc(x.delivery_note)}”` : ''}${x.stop?.recorded_offline ? ' · recorded offline' : ''} <button class="btn ghost sm" data-pod="${x.stop?.id}">View proof</button></div>` : ''}
      ${['delivered', 'partial'].includes(x.status) ? `<div class="row"><button class="btn ok" data-ok="${x.id}">Everything arrived</button><select data-it="${x.id}" style="width:auto"><option value="short">Short delivery</option><option value="damaged">Damaged goods</option><option value="wrong">Wrong items</option><option value="temperature">Temperature problem</option></select><button class="btn ghost" data-issue="${x.id}">Report issue</button></div>` : ''}
      ${x.status === 'received' ? `<div class="banner ${x.receipt_status === 'ok' ? 'ok' : 'bad'}">${x.receipt_status === 'ok' ? 'You confirmed receipt.' : `You reported: ${esc(x.receipt_note)}`}</div>` : ''}
    </div>`).join('') || '<div class="card muted">No orders yet.</div>'}
  </div><dialog id="dlg"></dialog>`);
  $('#runpill').textContent = runPill(run);
  $('#of').onsubmit = async (e) => {
    e.preventDefault();
    try { const r = await api('/api/store/orders', { body: { temp_requirement: $('#ot').value, order_units: $('#ou').value } }); toast(`Order ${r.id} confirmed for ${r.run_date}${r.late ? ' (after cutoff)' : ''}`); renderStore(); } catch (err) { toast(err.message); }
  };
  $('#app').querySelectorAll('[data-ok]').forEach((b) => b.onclick = async () => { await api(`/api/store/orders/${b.dataset.ok}/receipt`, { body: { status: 'ok' } }); toast('Receipt confirmed'); renderStore(); });
  $('#app').querySelectorAll('[data-issue]').forEach((b) => b.onclick = async () => {
    const note = prompt('Describe the issue (what and how many):'); if (!note) return;
    const it = $(`[data-it="${b.dataset.issue}"]`).value;
    await api(`/api/store/orders/${b.dataset.issue}/receipt`, { body: { status: 'issue', issue_type: it, note: `${it}: ${note}` } }); toast('Issue sent to the dispatcher'); renderStore();
  });
  $('#app').querySelectorAll('[data-pod]').forEach((b) => b.onclick = async () => {
    const p = await api(`/api/stops/${b.dataset.pod}/pod`); const dlg = $('#dlg');
    dlg.innerHTML = `<div class="stack"><h3>Proof of delivery · ${p.outlet_id}</h3><div>Received by <b>${esc(p.pod_name || '–')}</b> at ${fmtTime(p.completed_at)}${p.recorded_offline ? ' (recorded offline, synced later)' : ''}</div>
      ${p.pod_signature ? `<img src="${p.pod_signature}" alt="signature" style="width:100%;border:1px solid var(--line);border-radius:8px">` : '<span class="muted">No signature</span>'}${p.pod_photo ? `<img src="${p.pod_photo}" alt="delivery photo" style="width:100%;border-radius:8px">` : ''}${p.note ? `<div>Note: ${esc(p.note)}</div>` : ''}<button class="btn" id="dclose">Close</button></div>`;
    dlg.showModal(); $('#dclose').onclick = () => dlg.close();
  });
  S.timer = setInterval(() => { if (S.user?.role === 'store' && !document.activeElement?.matches('input,select,textarea') && !$('#dlg')?.open) renderStore(); }, 15000);
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
render();
