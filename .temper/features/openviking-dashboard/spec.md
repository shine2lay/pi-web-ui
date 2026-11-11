---
max_tokens: 2300 # contract outgrew the 2000 default (architecture #521)
---
# Architecture Spec: OpenViking Memory Dashboard (`openviking-dashboard`)

Pinned to `.temper/features/openviking-dashboard/design.md` (`design #274`, `28c2c672`), `.temper/features/openviking-dashboard/brief.md` (`product #65`, `a69a2470`), and `/home/shinelay/architecture-dept/conventions/openviking-contract.md`.

Parts (split by architecture #531; text moved byte-identically, section numbers unchanged): [spec-states.md](spec-states.md) holds §4 Operational States; [spec-commits-and-gaps.md](spec-commits-and-gaps.md) holds Session Commits and Contract-vs-Live Gaps for Ops.

## API and State Contract

### 1. Read-Only & Sources
- **Read-Only:** `server/index.ts` exposes only `GET /api/openviking/{overview,entries,audit}` (`2000ms` timeout; non-`GET` -> `405`). No writes to `:1933` or `/home/shinelay/.pi/openviking/`.
- **Sources:** `http://127.0.0.1:1933` (`/health`, `/api/v1/{system/status,observer/system,fs/ls}`, `/api/v1/content/{abstract,overview,read}`) and `/home/shinelay/.pi/openviking/{memory-changelog.jsonl,metrics.jsonl,rollout-state.json,resource-sync-state.json,migration-verification.json,seen-role-messages.json}`.

### 2. Cross-Role Isolation (`R-NAMESPACE-1`, `R-ISOLATION-1`)
- Role memories (`viking://agent/memories/...`) are isolated per role (`X-OpenViking-Agent: <role>`).
- **Allowed across roles:** Counts, sizes, `modTime`, latencies, sync states (`/api/v1/fs/ls`, `metrics.jsonl`).
- **Forbidden across roles:** Never expose another role's `viking://agent/memories/...` content. `/api/openviking/entries` reads `/api/v1/content/*` **only** for shared URIs (`viking://resources/...`, `viking://user/default/memories/...`); cross-role `agent` rows set `l0_abstract: "[Isolated per-role memory — metadata only (R-ISOLATION-1)]"` and `l1_overview`/`l2_content: null` (`403`). `/api/openviking/audit` redacts `summary_1line` on `agent` rows.

### 3. Endpoints
- **`GET /api/openviking/overview` (`200`):** `{ screen_state: "live"|"stale"|"empty"|"error", observer, metrics, changelog, slots, auxiliary: { rollout, resource_sync, migration, dedup } }`.
- **`GET /api/openviking/entries?scope=all|resources|user|agent&role=<role>` (`200`, `15m`):** `{ panel_updated_at, health_state, stale_badge: "> 15m"|null, entries }` (`updated_at`, `provenance`).
- **`GET /api/openviking/audit?limit=50` (`200`, `15m`):** `{ panel_updated_at, health_state, stale_badge: "> 15m"|null, events }` (`action`: `"commit"|"role_memory_write"|"promote_shared"|"reject_noise"|"sidecar_timeout"`, `guard_verdict`: `"allowed"|"rejected"|"degraded_skip"`).

### 4. Operational States (Never Conflated)
In [spec-states.md](spec-states.md).

## Canonical State and Formula Owners

Browser code formats values only and **never** computes sums, averages, percentages, or health verdicts (`A07`).

| Figure (`data-source-field`) | Source (§1) | Formula / Field | Cadence |
|---|---|---|---|
| `observer.mode_label` | `/health` + `/api/v1/observer/system` + `rollout-state.json` | `"Offline"` if down; `"Degraded Local Fallback"` if stale; else `"Active"` | `30s` |
| `observer.role_memory_folder_count`, `observer.roles_total_count` | Wrapper partition enumeration of canonical `viking://user/<role>/memories` (not alias `viking://agent/memories`) | Partitions found (`0..15`, `null` if down) as `"N role memory folders"`; total `15` (role list) | `30s` |
| `observer.daemon_bind`, `observer.queue_depth` | `/health` (bind only) | `"127.0.0.1:1933"`; `queue_depth` always `null` (G1) | `30s` |
| `observer.last_reachable_at` | Last `/health` `"ok"` (in-memory) | ISO, held while down, else `null` (§4); not `checked_at` (request time) | `30s` |
| `metrics.{slot_hit_rate_pct,avg_injected_tokens,turns_sampled_24h}` | `metrics.jsonl` (`turn_start`, 24h) | Injected count; `%` with `l0_hits > 0`; mean `tokens_est` (G2) | `5m` |
| `changelog.{session_commits_24h,promotions_24h,rejected_24h}` | `memory-changelog.jsonl` (24h) | Session commits only (see below); `preference_write`+`resource_sync`; `preference_write_blocked` (G4) | `15m` |
| `slots[].{slot_id,uri_prefix,hit_rate_pct,avg_tokens,state}` | `metrics.jsonl` (`turn_start`, 24h) | Slots 1–5; per-slot telemetry if present, else `null` / `"unmeasured-gap"` (G3) | `5m` |
| `entries[].{uri,scope,role,layers,l0_abstract,l1_overview,l2_content}` | `/api/v1/fs/ls` + `/api/v1/content/*` | Lists `resources`, `user/default/memories` (G8), `user/<role>/memories` | `15m` |
| `events[].{id,action,role,uri,l0_abstract,guard_verdict,ts}` | `memory-changelog.jsonl` + `metrics.jsonl` | §3 `action` by URI namespace + `source`, never the verb (contract `R-CHANGELOG-1d`): `commit` = session commits only; other personal-URI writes (`migration`, `lead_direct`) = `role_memory_write` | `15m` |

Session Commits and Contract-vs-Live Gaps for Ops: [spec-commits-and-gaps.md](spec-commits-and-gaps.md).

## Obsolete Code and Tests to Delete

- **Delete:** `parseQueueDepth` + drift test + `/api/v1/observer/queue` fetch (`server/openviking/observer.ts`, G1); folder-count `isDegraded` condition (`server/openviking/overview.ts`). Else greenfield; no shims (Rule 23).

## Prototype-Only Chrome Excluded from Production

Verbatim from `.temper/features/openviking-dashboard/design.md`:

- **`#stateStrip` (`<div id="stateStrip">`):** Never render, mount, or CSS-hide `#stateStrip`; `document.getElementById("stateStrip")` must be `null`. *Prod:* Omit `#stateStrip`.
- **`data-st-state` (`[data-st-state]`):** Never emit `data-st-state` on any element. *Prod:* Bind `data-health-state` and `data-screen-state`.
- **`window.__hidePrototypeChrome` and `?proto=0`:** Never define `window.__hidePrototypeChrome` or branch on `?proto=`. *Prod:* Zero prototype globals/switches.
- **`?state=` and `?scenario=` URL overrides:** Derive states exclusively from `/api/openviking/*` responses, never query parameters. *Prod:* Compute states server-side.
- **`<script id="openviking-fixture-data" type="application/json">` and `window.__OPENVIKING_FIXTURE__`:** Fetch live `/api/openviking/*` endpoints; never embed static fixture payloads. *Prod:* Fetch `/api/openviking/*`.
