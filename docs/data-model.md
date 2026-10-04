# Data model

```mermaid
erDiagram
  OUTLETS ||--o{ ORDERS : places
  RUNS ||--o{ ORDERS : "groups by delivery date"
  RUNS ||--o{ TRIPS : contains
  VEHICLES ||--o{ TRIPS : "runs (max 2/day)"
  TRIPS ||--o{ STOPS : "sequenced"
  TRIPS ||--o{ ORDERS : carries
  OUTLETS ||--o{ STOPS : "visited at"
  USERS ||--o{ SESSIONS : has
  USERS }o--o| OUTLETS : "store manager of"
  USERS }o--o| VEHICLES : "driver of"
  DISTRICT_TRAVEL ||--o{ OUTLETS : "travel standard"
  SERVICE_ALLOWANCE ||--o{ STOPS : "handling time"
  CALENDAR ||--|| RUNS : "date context"

  OUTLETS { text outlet_id PK
    text brand
    text district
    text depot
    text dock_type
    text parking_constraint
    text mall_window
    text window_open_time
    text window_close_time
    int days_since_last_served
    int deferred_yesterday }
  VEHICLES { text vehicle_id PK
    text type
    text temp
    real weight_cap_kg
    real volume_cap_m3
    real km_per_l
    real weekly_fuel_quota_l
    real fuel_used_week_l
    text depot
    text status }
  RUNS { text run_date PK
    text status "open|closed|planned|released"
    text validation "JSON result of constraint check" }
  ORDERS { text id PK
    text run_date FK
    text outlet_id FK
    text temp_requirement
    real order_weight_kg
    real order_volume_m3
    text status
    int trip_id FK
    real priority
    text deferral_reason
    text deferred_by
    int consecutive_deferral
    text load_status
    text delivery_status
    text receipt_status }
  TRIPS { int id PK
    text vehicle_id FK
    int trip_no
    text brand
    text district
    text window "predawn|daytime"
    int depart_min
    real minutes
    real km
    real fuel_l
    text status "planned|loaded|departed|completed"
    text last_sync_at }
  STOPS { int id PK
    int trip_id FK
    int seq
    text outlet_id FK
    int eta_min
    text status
    text pod_name
    text pod_signature
    text pod_photo
    int recorded_offline }
  EVENTS { text id PK "client UUID for driver events"
    text at
    text client_at
    text actor
    text type
    text ref
    text message }
  USERS { int id PK
    text username
    text role
    text outlet_id
    text vehicle_id }
```

## Notes

- **Reference tables** (`outlets`, `vehicles`, `district_travel`, `service_allowance`, `calendar`) are loaded unchanged from the shared datasets. `vehicles.status` comes from `task2b_peak_day_fleet.csv` (`available` / `in_workshop`; vehicles not listed are `off_roster`). `fuel_used_week_l` is seeded deterministically to represent Monday to Wednesday consumption.
- **Seed day**: Thursday 2026-04-30 (payday, Vesak festival ramp 0.9, monsoon). The orders are the 85 orders from `task2b_peak_day_scenarios.csv`. The demo store's own two orders are left out so the judge places them in step 1. `deferred_yesterday` and `days_since_last_served` sit on the outlet and feed the priority score.
- **events** is append-only. Driver events use the client's UUID as the primary key, so retrying a sync can never apply the same delivery twice.
- **Time** is stored as minutes after midnight for planning (`depart_min`, `eta_min`) and as ISO timestamps for what actually happened.
