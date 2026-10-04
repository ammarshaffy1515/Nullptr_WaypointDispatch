# Waypoint Dispatch · Team Nullptr

One delivery system for Waypoint Group's three brands. It covers store ordering, dispatcher planning and allocation, dock loading, offline-first driver delivery with proof of delivery, and store receipt. It is one responsive web app with four role views.

- **Live:** _add Render URL here_
- **Demo video:** _add YouTube link here_
- **Docs:** [architecture](docs/architecture.md) · [data model](docs/data-model.md) · [AI tool disclosure](docs/ai-disclosure.md)

## Seeded accounts

Password for all four: **`waypoint2026`**. The login screen also has one-tap buttons for each account.

| Role | Username | Who / where |
|---|---|---|
| Store manager | `store` | Fathima Rizvi, OUT004 Waypoint Fresh, Colombo |
| Dispatcher | `dispatcher` | Nirosha Perera, Peliyagoda planning office |
| Loader | `loader` | Ruwan Silva, Peliyagoda dock (Kandy selectable) |
| Driver | `driver` | Kasun Jayasuriya, rostered to the vehicle that serves OUT004 |

## Judge walkthrough

The seeded day is **Thursday 30 April 2026**: a payday, 0.9 into the Vesak festival ramp, and monsoon. Friday is Vesak (non-operating), so anything deferred waits until Saturday 2 May. The queue holds the 85 peak-day orders from `task2b_peak_day_scenarios.csv` against the 28 vehicles available in `task2b_peak_day_fleet.csv` (10 are in the workshop). Demand exceeds capacity.

Open phone-sized windows (DevTools device mode works) for the loader and driver. Use a desktop window for the dispatcher.

1. **Store manager places orders** (`store`). Submit *Dry groceries · 40 units*, then *Chilled & frozen · 74 units*. Each gets a confirmation number straight away and shows as **Confirmed**.
2. **Dispatcher closes orders** (`dispatcher`, *Run & queue* tab). Review the ranked queue: priority comes from a skip on the last run, days since served, perishability and value. Click **Close orders**. Any new store order now rolls to the 2 May run.
3. **Dispatcher generates the plan.** Click **Generate plan**. The *Plan & deferrals* tab shows 25 trips with weight, volume, time-window and fuel meters, plus a green **Constraint check passed** banner. About 13 orders are deferred, each with a recorded reason (for example, all refrigerated vehicles at Peliyagoda already committed). OUT004's chilled order is among them.
4. *(Optional)* **Assisted changes.** Pick a trip or vehicle for a deferred order and click **Assign**. If the change breaks a rule (say, chilled goods on an ambient truck), it is refused with the specific violations. **Defer** on any planned order asks for a reason, then re-sequences the trip.
5. **Dispatcher releases the plan.** Back on *Run & queue*, click **Release plan**. Stores now see an ETA or a deferral notice.
6. **Store sees the result** (`store`). The dry order shows *Expected around 06:10 on VEH034*. The chilled order shows the deferral reason and the 2 May date.
7. **Loader loads the truck** (`loader`, phone size). Open **VEH034 · trip 1**. Orders are listed last stop first (load order). Mark one order **Short** with a note, mark the rest **Loaded**, then **Confirm load**. The shortfall alerts the dispatcher and the affected store before departure.
8. **Driver delivers with no signal** (`driver`, phone size). Open the trip and tap **Start trip**. Tick **Simulate no signal (demo)**. A dark offline banner appears; real airplane mode works too. Open stop 1, record **Delivered** with a receiver name and signature (photo optional), and save. The record stays on the phone. Deliver the remaining stops, including **OUT004**, the same way.
9. **Reconnect.** Untick *Simulate no signal*. The outbox syncs, and each event carries a UUID, so retries never double-apply. In the dispatcher's **Live tracking** tab the stops show as complete, with ⇣ marking records captured offline. Shortfall alerts and any sync conflicts appear under *Needs attention*.
10. **Store confirms receipt** (`store`). The dry order shows **Delivered**, who signed and when. **View proof** shows the signature and photo. Click **Everything arrived**, or choose an issue type and **Report issue**. Issues show up in the dispatcher's *Needs attention* panel.

To restart, sign in as `dispatcher` and click **Reset demo**. It reseeds the day.

## Run it locally

```bash
cp .env.example .env      # optional, defaults work
docker compose up --build # http://localhost:3000
```

This builds and starts the whole stack: the Node API, the web app, and the SQLite database on a named volume, seeded from `./data` on first boot. Set `RESEED_ON_BOOT=true` to reset on each start.

Without Docker (Node ≥ 22.13): `npm install && npm start`. Run `npm test` for the allocation-engine tests.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `RUN_DATE` | 2026-04-30 | Seeded delivery run (must be in `calendar.csv`) |
| `DEMO_PASSWORD` | waypoint2026 | Password for the four seeded accounts |
| `DEMO_OUTLET` | OUT004 | Outlet of the seeded store manager |
| `RESEED_ON_BOOT` | false | Wipe and reseed on start |
| `DB_PATH` | var/waypoint.db | SQLite file |

**Deploying (Render):** `render.yaml` is a blueprint for a free Docker web service. Connect the repo under New → Blueprint.

## Planning and allocation engine

`src/planner.js` is pure and unit-tested:

- **Priority:** +100 if the outlet was skipped on the last run (prevents consecutive deferrals), +5 per day since last served, Fresh chilled +30, Fresh dry +20, Tech +10, Style +5.
- **Greedy best-fit:** each order first tops up an open trip for the same depot, brand and district. Failing that, it opens a trip on the cheapest compatible vehicle. Reefers are reserved for chilled goods, vans for van-only outlets, and Style prefers high-volume trucks.
- **Hard constraints checked on every placement:** weight and volume, reefer for chilled, vans for `van_only`, the home depot, one brand and one district per trip, at most 2 trips per vehicle, the published trip-time standard (depot→district + inter-stop + service allowance) inside the 270-minute pre-dawn window (Fresh) and the 480-minute daytime window, every stop's ETA inside its delivery or mall window, and route fuel within the remaining weekly quota.
- **Deferrals** record the binding constraint as a human-readable reason. Consecutive deferrals are flagged.
- **Independent validation** runs before release and before any manual change. It follows `check_allocation.py`, plus windows and fuel. Our peak-day output passes the organisers' checker.

## Degradation and recovery

- **No signal on the road:** the service worker caches the app shell and the driver's route manifest is kept on the phone. Every action is queued in an outbox and synced automatically when connectivity returns (and every 15 s). The banner always shows the pending count.
- **Conflicts:** if an offline record conflicts with the server (for example, a stop already recorded or reassigned), it is rejected, not merged silently. The driver sees it and the dispatcher gets a `sync_conflict` alert.
- **Loading shortfall:** flagged at the dock before departure, so the dispatcher and store know before the truck arrives.
- **Last-sync visibility:** the dispatcher sees each trip's last sync time. Trips that are on the road with no sync yet are marked *no signal yet*.

## Departures from the Designathon submission

We did not submit a Designathon design (a missed deadline), so there is no Day 5 design to follow. The screens here were designed during the Hackathon around the brief's four-role workflow.

## Known limitations

- Demand forecasting for future capacity (the Datathon's subject) is not in this build.
- Sessions are simple bearer tokens and there is no password change. The demo accounts are for judging only.
- ETAs use the published free-flow planning standard. Traffic and road-condition adjustments are left for the Datathon models.
