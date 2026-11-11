# Feature Design Spec: OpenViking Memory Dashboard (`openviking-dashboard`)

Grounded in `.temper/features/openviking-dashboard/brief.md`, `.temper/design/DESIGN.md`, `.temper/design/tokens.json`, and the OpenViking contract. Read-only `pi-web-ui` surface: no memory mutation controls.

## First View, Disclosure Tiers & Breakpoints (`320px`, `390px`, `1440px`)

- **Tier 1 — Glanceable First View:**
  1. **Status Header (`[data-component="status-header"]`, `30s`):** Title, mode badge (`Active`, `Degraded Local Fallback`, or `Offline`; it describes the daemon, never roles), the count `N role memory folders` (no liveness claim), icon (`data-icon`), age (`[data-age]`), and cadence.
  2. **3 Summary Cards (`[data-component="summary-card"]`, each `data-panel-updated-at`, max 5 `[data-field]` text fields):**
     - **System & Daemon Health (`data-card-id="system-health"`, `30s`):** Daemon bind, mode pill + icon, queue depth (`null` in v1: `unavailable`, never `0`), panel age/cadence.
     - **Context & Token Injection (`data-card-id="context-injection"`, `5m`):** 5-slot hit rate, health pill + icon, avg tokens + turns sampled, panel age/cadence.
     - **Commit & Guard Governance (`data-card-id="commit-governance"`, `15m`):** `N session commits` (24h; never a bare `commits`), health pill + icon, shared promotions + guard rejections, panel age/cadence.
  3. **3 Workspace Tabs (`[role="tablist"]` -> 3 `button[role="tab"][data-tab]`):**
     - **Tab 1 — `5-Slot Context Mount` (`data-tab="mount-map"`, `5m`):** 5 rows (`Slot 1` Project L1 Overview, `Slot 2` Shared Entity Status, `Slot 3` Top Matching Spec, `Slot 4` Personal Role Memories, `Slot 5` Sibling Project Docs) with URI prefix, hit rate, avg tokens, status badge, `(?)` tooltip, and age.
     - **Tab 2 — `Memory Namespace Explorer` (`data-tab="namespace-explorer"`, `15m`):** Expandable rows (`[data-component="memory-row"]`) across `viking://resources/`, `viking://user/memories/`, and role-isolated `viking://agent/memories/`, with URI, role/scope pill, `L0 / L1 / L2` badge, single-line `L0` abstract, and age.
     - **Tab 3 — `Commit & Guard Audit` (`data-tab="commit-audit"`, `15m`):** Expandable rows (`[data-component="audit-row"]`) with event age, action badge (`commit` = session commits only, `role_memory_write`, `promote_shared`, `reject_noise`, `sidecar_timeout`), role, URI, and one-line `L0` summary.
- **Tier 2 — Concept Tooltips (`[role="tooltip"]`):** Every contract badge (`L0`/`L1`/`L2`, `Slot 1–5`, `Commit Guard`, `Degraded Local Fallback`, `Sidecar Timeout`) pairs with a `>= 24x24px` `button[data-slot="tooltip-trigger"]` (`(?)`, `aria-describedby`) opening a keyboard-accessible `[role="tooltip"]`.
- **Tier 3 — Reader Drawer (`[data-component="reader-drawer"]`):** Click or `Enter`/`Space` on any row sets `aria-expanded="true"` and opens the drawer (`role="dialog"`) with `L0 Abstract`, `L1 Overview`, and `L2 Full Content` tabs (`[data-drawer-tab="l0"|"l1"|"l2"]`) plus provenance. `Escape` or `[data-slot="drawer-close"]` closes it and returns focus to the row.
- **Responsive Layout:** `1440px`: 3-column summary grid (`repeat(3, minmax(0, 1fr))`, `16px` gap) and `520px` right drawer. `390px`/`320px`: single-column stack (`16px`/`12px` padding), stacked row cards, `100vw` modal bottom-sheet drawer (`Tab`/`Shift+Tab` stay inside), `0px` horizontal overflow, body `>= 16px`, labels `>= 12px`.

## Screen States

Only copy of the state visuals (behaviour: `.temper/features/openviking-dashboard/spec.md` §4). Each state pairs its token from `.temper/design/tokens.json` with a distinct label, icon (`data-icon`), and border style so colour is never the sole cue:
- **`live` (`Healthy`):** Token `status-healthy-fg`/`status-healthy-bg`, label `Active` or `Healthy`, glyph `●` (`data-icon="circle-check"`), `solid` border (`data-health-state="healthy"`).
- **`loading`:** `[data-screen-state="loading"]` skeletons; never fake `0` counters. Pills are `Loading…` skeletons (`data-skeleton="true"`) with no status glyph, `data-icon` or tone.
- **`stale` (`Stale` — Past Cadence):** Token `status-stale-fg`/`status-stale-bg`, label `Stale` (header `Degraded Local Fallback`), glyph `◐` (`data-icon="clock-stale"`), `dashed` border (`data-health-state="stale"`), plus visible `[data-stale-badge="true"]` naming exceeded cadence (`> 30s`, `> 5m`, or `> 15m`).
- **`empty` (`Zero Activity` — Online, 0 Events):** Token `status-zero-fg`/`status-zero-bg`, label `Zero Activity`, glyph `◌` (`data-icon="circle-empty"`), `dotted` border (`data-health-state="zero-activity"`). Panels with no events state `0 events in window (server online)`—never `Healthy`, `Stale`, or `Server Unreachable`.
- **`error` (`Server Unreachable` / `Offline` — Cannot Reach `127.0.0.1:1933`):** Token `status-unreachable-fg`/`status-unreachable-bg`, label `Server Unreachable` (header `Offline`), glyph `✕` (`data-icon="octagon-x"`), `double` border (`data-health-state="server-unreachable"`). `:1933`-sourced figures render `— (Unreachable)` (`data-unreachable-value="true"`), **never** `0` or `Healthy`. Local-JSONL figures keep count, `data-age` and staleness, never `Unreachable`, and say `from local audit log` (card 3; Tab 3 rows stay listed, reader shows local `L0`, `L1`/`L2` `Unavailable while offline`) or `from local metrics log` (card 2, Tab 1).
- **Per-card pills:** Each summary card's pill shows its own panel's `health_state` (card 1 `observer.health_state`, card 2 `metrics.health_state`, card 3 `changelog.health_state`), never the screen state copied onto all three. The local-log panels (cards 2 and 3) are never `Server Unreachable`. In `error`, card 1 reads `Server Unreachable` and cards 2 and 3 read `Stale (> 5m cadence)` / `Stale (> 15m cadence)` once their logs pass cadence. In `stale` with a degraded rollout, card 1 reads `Stale (syncs waiting to land)`. In `empty`, card 1 stays `Healthy` and cards 2 and 3 read `Zero Activity`.
- **Header badge and ages:** The badge text is only `observer.mode_label` (`Active`, `Degraded Local Fallback`, `Offline`); freshness sits beside it. The daemon's only age is `observer.checked_at`, the request time: `Checked 4s ago`, or `No answer from 127.0.0.1:1933 · checked 4s ago` when offline. Never print a last-seen or last-contact time; every visible age sits in an element whose `data-source-field` names its timestamp field.
- **Interactive States:** `default` (`bg-surface`), `hover` (`bg-hover`), `focus` (`:focus-visible` `2px solid var(--accent-primary)`), `active` (`accent-primary`), `disabled` (`opacity: 0.5`, `aria-disabled="true"`). Selected tabs, filters and drawer tiers use the `accent-primary` border and underline, never a status tone.

## Endpoint Shapes & Figure-to-Server-Field Contract (Zero Client Roll-Up Math)

Browser code only formats values, **never sums, averages, percentages or health verdicts**; every figure declares `data-source-field` and `data-age`:

| UI Figure | `GET /api/openviking/` | Exact Server Field (`data-source-field`) | Age (`data-age`) | Cadence |
|---|---|---|---|---|
| Header mode & role memory folders | `overview` | `observer.mode_label`, `observer.role_memory_folder_count` | `observer.checked_at` | `30s` |
| Daemon bind & queue depth | `overview` | `observer.daemon_bind`, `observer.queue_depth` | `observer.checked_at` | `30s` |
| 5-slot hit rate & avg tokens | `overview` | `metrics.{slot_hit_rate_pct,avg_injected_tokens,turns_sampled_24h}` | `metrics.last_recorded_at` | `5m` |
| 24h session commits, promotions, rejects | `overview` | `changelog.{session_commits_24h,promotions_24h,rejected_24h}` | `changelog.last_event_at` | `15m` |
| Per-slot mount row metrics | `overview` | `slots[].{slot_id,uri_prefix,hit_rate_pct,avg_tokens,state}` | `slots[].last_sampled_at` | `5m` |
| Namespace explorer rows | `entries` | `entries[].{uri,scope,role,layers,l0_abstract,l1_overview,l2_content}` | `entries[].updated_at` | `15m` |
| Commit & guard audit rows | `audit` | `events[].{id,action,role,uri,l0_abstract,guard_verdict}` | `events[].ts` | `15m` |

## Show&Tell

Prototype link: `/showtell/#/d/d_openviking_dashboard`.

### Prototype-Only Chrome Excluded from Production

Banned from production (quote verbatim into Architecture's `spec.md`):
- **`#stateStrip` (`<div id="stateStrip">`):** Never render, mount, or CSS-hide `#stateStrip`; `document.getElementById("stateStrip")` must be `null`.
- **`data-st-state` (`[data-st-state]`):** Never emit `data-st-state` on any element.
- **`window.__hidePrototypeChrome` and `?proto=0`:** Never define `window.__hidePrototypeChrome` or branch on `?proto=`.
- **`?state=` and `?scenario=` URL overrides:** Derive states exclusively from `/api/openviking/*` responses, never query parameters.
- **`<script id="openviking-fixture-data" type="application/json">` and `window.__OPENVIKING_FIXTURE__`:** Fetch live `/api/openviking/*` endpoints; never embed static fixture payloads.

## Reference Screenshots

```text
.temper/features/openviking-dashboard/shots/live-1440-dark@2x.png
.temper/features/openviking-dashboard/shots/live-1440-light@2x.png
.temper/features/openviking-dashboard/shots/live-390-dark@2x.png
.temper/features/openviking-dashboard/shots/live-320-dark@2x.png
```
