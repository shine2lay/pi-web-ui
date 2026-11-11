# Architecture Spec: OpenViking Memory Dashboard (`openviking-dashboard`)

Pinned to `.temper/features/openviking-dashboard/design.md` (`design #263`, `5db1eb93`), `.temper/features/openviking-dashboard/brief.md` (`product #65`, `a69a2470`), and `/home/shinelay/architecture-dept/conventions/openviking-contract.md`.

## API and State Contract

### 1. Read-Only & Sources
- **Read-Only:** Zero write actions (`design.md` has no re-sync, backfill, eviction, promotion, or edit). `server/index.ts` exposes only `GET /api/openviking/{overview,entries,audit}` (`2000ms` timeout; non-`GET` -> `405`). No writes to `:1933` or `/home/shinelay/.pi/openviking/`.
- **Sources:** `http://127.0.0.1:1933` (`/health`, `/api/v1/system/status`, `/api/v1/observer/{system,queue}`, `/api/v1/fs/ls`, `/api/v1/content/{abstract,overview,read}`) and `/home/shinelay/.pi/openviking/{memory-changelog.jsonl,metrics.jsonl,rollout-state.json,resource-sync-state.json,migration-verification.json,seen-role-messages.json}`.

### 2. Cross-Role Isolation (`R-NAMESPACE-1`, `R-ISOLATION-1`)
- Role memories (`viking://agent/memories/...`) are isolated per role (`X-OpenViking-Agent: <role>`).
- **Allowed across roles:** Counts, sizes, `modTime`, latencies, sync states (`/api/v1/fs/ls`, `metrics.jsonl`).
- **Forbidden across roles:** Never expose another role's `viking://agent/memories/...` content (`l0_abstract`, `l1_overview`, `l2_content`, `summary_1line`). `/api/openviking/entries` reads `/api/v1/content/*` **only** for shared URIs (`viking://resources/...`, `viking://user/default/memories/...`); cross-role `agent` rows set `l0_abstract: "[Isolated per-role memory — metadata only (R-ISOLATION-1)]"` and `l1_overview`/`l2_content: null` (`403`). `/api/openviking/audit` redacts `summary_1line` on `agent` rows.

### 3. Endpoints (`server/index.ts`)
- **`GET /api/openviking/overview` (`200`):** `{ screen_state: "live"|"stale"|"empty"|"error", observer, metrics, changelog, slots, auxiliary: { rollout, resource_sync, migration, dedup } }`.
- **`GET /api/openviking/entries?scope=all|resources|user|agent&role=<role>` (`200`, `15m`):** `{ panel_updated_at, health_state, stale_badge: "> 15m"|null, entries }` (`updated_at`, `provenance`).
- **`GET /api/openviking/audit?limit=50` (`200`, `15m`):** `{ panel_updated_at, health_state, stale_badge: "> 15m"|null, events }` (`action`: `"commit"|"promote_shared"|"reject_noise"|"sidecar_timeout"`, `guard_verdict`: `"allowed"|"rejected"|"degraded_skip"`).

### 4. Operational States (Never Conflated)
- **`live` (`Healthy`):** `/health` `"ok"`, age `<= cadence`, `> 0` events/24h (`status-healthy-fg`, `●` `circle-check`, `solid`, `data-health-state="healthy"`).
- **`stale` (`Stale`):** `/health` `"ok"`, age `> cadence` (`> 30s`, `> 5m`, `> 15m`) or `pending_wt_land_syncs` non-empty (`status-stale-fg`, `Stale` / `Degraded Local Fallback`, `◐` `clock-stale`, `dashed`, `data-health-state="stale"`, `[data-stale-badge="true"]`).
- **`empty` (`Zero Activity`):** `/health` `"ok"`, `0` events/24h (`status-zero-fg`, `◌` `circle-empty`, `dotted`, `data-health-state="zero-activity"`, `"0 events in window (server online)"`).
- **`error` (`Server Unreachable` / `Offline`, `R-FAIL-1..3`):** `/health` fails (`status-unreachable-fg`, `✕` `octagon-x`, `double`, `data-health-state="server-unreachable"`). `:1933` fields return `null` -> `— (Unreachable)` (`data-unreachable-value="true"`), never `0`/`Healthy`; JSONL panels still show counts + staleness.
- **`loading`:** `[data-screen-state="loading"]` skeletons; never fake `0` counters.

## Canonical State and Formula Owners

Browser code formats values only and **never** computes sums, averages, percentages, or health verdicts (`A07`).

| Figure (`data-source-field`) | Source (`:1933` / `/home/shinelay/.pi/openviking/`) | Formula / Field | Cadence |
|---|---|---|---|
| `observer.mode_label` | `/health` + `/api/v1/observer/system` + `rollout-state.json` | `"Offline"` if down; `"Degraded Local Fallback"` if stale; else `"Active (15/15 Roles Live)"` | `30s` |
| `observer.roles_online_count`, `observer.roles_total_count` | `/api/v1/fs/ls?uri=viking://agent/memories` | Reachable roles (`0..15`, `null` if down); total `15` | `30s` |
| `observer.daemon_bind`, `observer.queue_depth` | `/health` (bind only) | `"127.0.0.1:1933"`; queue depth **unavailable in v1** (`R-QUEUE-DEPTH-1`, G1) | `30s` |
| `metrics.slot_hit_rate_pct`, `metrics.avg_injected_tokens`, `metrics.turns_sampled_24h` | `metrics.jsonl` (`turn_start`, 24h) | Injected count; `%` with `l0_hits > 0`; mean `tokens_est` (G2) | `5m` |
| `changelog.commits_24h`, `changelog.promotions_24h`, `changelog.rejected_24h` | `memory-changelog.jsonl` (24h) | `session_commit`; `preference_write`+`resource_sync`; `preference_write_blocked` (G4) | `15m` |
| `slots[].slot_id`, `slots[].uri_prefix`, `slots[].hit_rate_pct`, `slots[].avg_tokens`, `slots[].state` | `metrics.jsonl` (`turn_start`, 24h) | Slots 1–5; per-slot telemetry if present, else `null` / `"unmeasured-gap"` (G3) | `5m` |
| `entries[].uri`, `entries[].scope`, `entries[].role`, `entries[].layers`, `entries[].l0_abstract`, `entries[].l1_overview`, `entries[].l2_content` | `/api/v1/fs/ls` + `/api/v1/content/*` | Lists `resources`, `user/default/memories` (G8), `agent/memories`; redacts `agent` content | `15m` |
| `events[].id`, `events[].action`, `events[].role`, `events[].uri`, `events[].l0_abstract`, `events[].guard_verdict`, `events[].ts` | `memory-changelog.jsonl` + `metrics.jsonl` | Maps live actions to `commit`, `promote_shared`, `reject_noise`, `sidecar_timeout`; redacts `agent` `summary_1line` | `15m` |

### Contract-vs-Live Gaps for Ops
- **G1 — SETTLED:** `result.status` is an ASCII table; render unavailable, never `0`, never scraped (`R-QUEUE-DEPTH-1`, §8b).
- **G2 (`metrics.jsonl` vs. §8):** §8 `l0_hit_count`, `l1_expanded_count`, `injected_tokens_est`, `extracted_count`, `dedup_skipped_count` -> live `l0_hits`, `l1_reads`, `tokens_est`, `extracted`, `dedup_skipped`.
- **G3 (Per-slot metrics):** Logs turn totals (`l0_hits`, `tokens_est`), not per-slot (`Slot 1..5`). Return `null` (`"unmeasured-gap"`) until Ops logs `slots[]`.
- **G4 (`memory-changelog.jsonl` vs. §9):** §9 `add|update|delete|reject_preference_candidate` -> live `session_commit`, `preference_write`, `resource_sync`, `preference_write_blocked`.
- **G5 (`rollout-state.json`):** Only `{"pending_wt_land_syncs":[...]}` (no `stage`/`updated_at`); report `stage: null`.
- **G6 (`migration-verification.json`):** `checked_at`/`source_files[]` vs. §9 `verified_at`/`total_checked`.
- **G7 (`seen-role-messages.json`):** `{"seen":{...},"updatedAt":"..."}` vs. §6 flat map.
- **G8 — SETTLED:** wording only; canonical form `viking://user/default/memories` (`R-URI-CANONICAL-1`, §8b).

## Obsolete Code and Tests to Delete

- **Greenfield (`0` files):** No obsolete OpenViking dashboard files/tests in `server/` or `web/`. No shims for `window.__OPENVIKING_FIXTURE__` (Rule 23).

## Prototype-Only Chrome Excluded from Production

Verbatim from `.temper/features/openviking-dashboard/design.md`:

- **`#stateStrip` (`<div id="stateStrip">`):** Never render, mount, or CSS-hide `#stateStrip`; `document.getElementById("stateStrip")` must be `null`. *Prod:* Omit `#stateStrip`.
- **`data-st-state` (`[data-st-state]`):** Never emit `data-st-state` on any element. *Prod:* Bind `data-health-state` and `data-screen-state`.
- **`window.__hidePrototypeChrome` and `?proto=0`:** Never define `window.__hidePrototypeChrome` or branch on `?proto=`. *Prod:* Zero prototype globals/switches.
- **`?state=` and `?scenario=` URL overrides:** Derive states exclusively from `/api/openviking/*` responses, never query parameters. *Prod:* Compute states server-side.
- **`<script id="openviking-fixture-data" type="application/json">` and `window.__OPENVIKING_FIXTURE__`:** Fetch live `/api/openviking/*` endpoints; never embed static fixture payloads. *Prod:* Fetch `/api/openviking/*`.
