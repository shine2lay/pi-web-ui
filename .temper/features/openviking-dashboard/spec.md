---
max_tokens: 2300 # contract outgrew the 2000 default (architecture #521)
---
# Architecture Spec: OpenViking Memory Dashboard (`openviking-dashboard`)

Pinned to `.temper/features/openviking-dashboard/design.md` (`design #274`, `28c2c672`), `.temper/features/openviking-dashboard/brief.md` (`product #65`, `a69a2470`), and `/home/shinelay/architecture-dept/conventions/openviking-contract.md`.

Parts (architecture #531, text moved byte-identically): [spec-states.md](spec-states.md) holds §4 Operational States; [spec-commits-and-gaps.md](spec-commits-and-gaps.md) holds Session Commits and Contract-vs-Live Gaps for Ops. Explorer (#541): [spec-explorer.md](spec-explorer.md) G1-G4, [spec-explorer-writes.md](spec-explorer-writes.md) G5-G7, [spec-explorer-build.md](spec-explorer-build.md) daemon, gaps, deletes, chrome.

## API and State Contract

### 1. Read-Only & Sources
- **Read-Only, Except the Explorer:** `GET /api/openviking/{overview,audit}` (`2000ms` timeout; non-`GET` -> `405`). Writes to `:1933` or `/home/shinelay/.pi/openviking/` exist ONLY on the explorer's owner-initiated edit/delete/undo routes ([spec-explorer-writes.md](spec-explorer-writes.md)).
- **Sources:** `http://127.0.0.1:1933` (`/health`; the explorer's daemon calls are in [spec-explorer-build.md](spec-explorer-build.md)) and `/home/shinelay/.pi/openviking/{memory-changelog.jsonl,metrics.jsonl,rollout-state.json}`. Sync state is `rollout-state.json`'s `pending_wt_land_syncs`, written only by `/home/shinelay/projects/agent-tools/lib/wt-openviking-sync.mjs`; no resource-sync state file exists, so none is a source (ops `rm-d62cd5d6`).

### 2. Cross-Role Isolation (`R-NAMESPACE-1`, `R-ISOLATION-1`)
- Role memories (`viking://agent/memories/...`) are isolated per role (`X-OpenViking-Agent: <role>`).
- **Allowed across roles:** Counts, sizes, `modTime`, latencies, sync states (`/api/v1/fs/ls`, `metrics.jsonl`).
- **Forbidden across roles:** Never expose another role's `viking://agent/memories/...` content. `/api/openviking/audit` redacts `summary_1line` and `l0_abstract` on `agent` rows to `"[Isolated per-role memory — metadata only (R-ISOLATION-1)]"`. The owner-only explorer routes read every root ([spec-explorer.md](spec-explorer.md)); role chats stay isolated.

### 3. Endpoints
- **`GET /api/openviking/overview` (`200`):** `{ screen_state: "live"|"stale"|"empty"|"error", health_state, observer: { checked_at, last_commit_at, last_reachable_at } }` (§4); the explorer's health line reads it.
- **`GET /api/openviking/audit?limit=50` (`200`, `15m`):** `{ panel_updated_at, health_state, stale_badge: "> 15m"|"pending sync"|null, events }` (`action`: `"commit"|"role_memory_write"|"promote_shared"|"reject_noise"|"sidecar_timeout"|"owner_edit"|"owner_delete"` (G7), `guard_verdict`: `"allowed"|"rejected"|"degraded_skip"`).

### 4. Operational States (Never Conflated)
In [spec-states.md](spec-states.md).

## Canonical State and Formula Owners

Browser code formats values only and **never** computes sums, averages, percentages, or health verdicts (`A07`).

| Figure (`data-source-field`) | Source (§1) | Formula / Field | Cadence |
|---|---|---|---|
| `screen_state`, `health_state` | `/health` + `metrics.jsonl` + `memory-changelog.jsonl` + `rollout-state.json` | `error` if `/health` fails; `stale` if degraded or a reading is past its cadence; `empty` if no reading has 24h activity; else `live` (§4) | per request |
| `observer.last_commit_at` | `memory-changelog.jsonl` | Newest session commit (see below), else `null` | per request |
| `observer.last_reachable_at` | Last `/health` `"ok"` (in-memory) | ISO, held while down, else `null` (§4); not `checked_at` (request time) | `30s` |
| `events[].{id,action,role,uri,l0_abstract,guard_verdict,ts}` | `memory-changelog.jsonl` + `metrics.jsonl` | §3 `action` by URI namespace + `source`, never the verb (contract `R-CHANGELOG-1d`): `commit` = session commits only; other personal-URI writes (`migration`, `lead_direct`) = `role_memory_write` | `15m` |

Session Commits and Contract-vs-Live Gaps for Ops: [spec-commits-and-gaps.md](spec-commits-and-gaps.md).

## Obsolete Code and Tests to Delete

One list for the feature, in [spec-explorer-build.md](spec-explorer-build.md).

## Prototype-Only Chrome Excluded from Production

Verbatim from `.temper/features/openviking-dashboard/design.md`:

- **`#stateStrip` (`<div id="stateStrip">`):** Never render, mount, or CSS-hide `#stateStrip`; `document.getElementById("stateStrip")` must be `null`. *Prod:* Omit `#stateStrip`.
- **`data-st-state` (`[data-st-state]`):** Never emit `data-st-state` on any element. *Prod:* Bind `data-health-state` and `data-screen-state`.
- **`window.__hidePrototypeChrome` and `?proto=0`:** Never define `window.__hidePrototypeChrome` or branch on `?proto=`. *Prod:* Zero prototype globals/switches.
- **`?state=` and `?scenario=` URL overrides:** Derive states exclusively from `/api/openviking/*` responses, never query parameters. *Prod:* Compute states server-side.
- **`<script id="openviking-fixture-data" type="application/json">` and `window.__OPENVIKING_FIXTURE__`:** Fetch live `/api/openviking/*` endpoints; never embed static fixture payloads. *Prod:* Fetch `/api/openviking/*`.
