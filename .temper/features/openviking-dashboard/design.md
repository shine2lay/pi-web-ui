# Feature Design Spec: OpenViking Memory Dashboard (`openviking-dashboard`)

Grounded in `.temper/features/openviking-dashboard/brief.md`, `.temper/design/DESIGN.md`, `.temper/design/tokens.json`, and the OpenViking architecture contract (`openviking-contract.md`). Read-only surface in `pi-web-ui`; zero memory mutation controls exist anywhere.

## First View, Disclosure Tiers & Breakpoints (`320px`, `390px`, `1440px`)

- **Tier 1 — Glanceable First View:**
  1. **Status Header (`[data-component="status-header"]`, `30s`):** Title, mode badge (`Active`, `Degraded Local Fallback`, or `Offline`; it describes the daemon, never roles), the count `N role memory folders` (no liveness claim), icon (`data-icon`), age (`[data-age]`), and cadence.
  2. **3 Summary Cards (`[data-component="summary-card"]`, max 5 `[data-field]` text fields each):**
     - **System & Daemon Health (`data-card-id="system-health"`, `30s`, `data-panel-updated-at`):** Online roles, mode pill + icon, daemon bind + queue depth, panel age/cadence.
     - **Context & Token Injection (`data-card-id="context-injection"`, `5m`, `data-panel-updated-at`):** 5-slot hit rate, health pill + icon, avg tokens + turns sampled, panel age/cadence.
     - **Commit & Guard Governance (`data-card-id="commit-governance"`, `15m`, `data-panel-updated-at`):** 24h commits, health pill + icon, shared promotions + guard rejections, panel age/cadence.
  3. **3 Workspace Tabs (`[role="tablist"]` -> 3 `button[role="tab"][data-tab]`):**
     - **Tab 1 — `5-Slot Context Mount` (`data-tab="mount-map"`, `5m`):** 5 rows (`Slot 1` Project L1 Overview, `Slot 2` Shared Entity Status, `Slot 3` Top Matching Spec, `Slot 4` Personal Role Memories, `Slot 5` Sibling Project Docs) with URI prefix, hit rate, avg tokens, status badge, `(?)` tooltip, and age.
     - **Tab 2 — `Memory Namespace Explorer` (`data-tab="namespace-explorer"`, `15m`):** Expandable rows (`[data-component="memory-row"]`) across `viking://resources/`, `viking://user/memories/`, and role-isolated `viking://agent/memories/`, with URI, role/scope pill, `L0 / L1 / L2` badge, single-line `L0` abstract, and age.
     - **Tab 3 — `Commit & Guard Audit` (`data-tab="commit-audit"`, `15m`):** Expandable rows (`[data-component="audit-row"]`) with event age, action badge (`commit`, `promote_shared`, `reject_noise`, `sidecar_timeout`), role, URI, and one-line `L0` summary.
- **Tier 2 — Concept Tooltips (`[role="tooltip"]`):** Every contract badge (`L0`/`L1`/`L2`, `Slot 1–5`, `Commit Guard`, `Degraded Local Fallback`, `Sidecar Timeout`) pairs with a `>= 24x24px` `button[data-slot="tooltip-trigger"]` (`(?)`, `aria-describedby`) opening a keyboard-accessible `[role="tooltip"]`.
- **Tier 3 — Reader Drawer (`[data-component="reader-drawer"]`):** Clicking or pressing `Enter`/`Space` on any row flips `aria-expanded` (`"false"` <-> `"true"`) and opens the drawer (`role="dialog"`) with `L0 Abstract`, `L1 Overview`, and `L2 Full Content` tabs (`[data-drawer-tab="l0"|"l1"|"l2"]`) plus provenance. `Escape` or `[data-slot="drawer-close"]` closes it.
- **Responsive Layout:** `1440px`: 3-column summary grid (`repeat(3, minmax(0, 1fr))`, `16px` gap) and `520px` right drawer. `390px`/`320px`: single-column stack (`16px`/`12px` padding), stacked row cards, `100vw` drawer, `0px` horizontal overflow, body `>= 16px`, labels `>= 12px`.

## Screen States

Every state pairs its token from `.temper/design/tokens.json` with a distinct label, icon (`data-icon`), and border style so colour is never the sole cue:
- **`live` (`Healthy`):** Token `status-healthy-fg`/`status-healthy-bg`, label `Active` or `Healthy`, glyph `●` (`data-icon="circle-check"`), `solid` border (`data-health-state="healthy"`).
- **`loading`:** `[data-screen-state="loading"]` skeletons; never renders fake `0` counters.
- **`stale` (`Stale` — Past Cadence):** Token `status-stale-fg`/`status-stale-bg`, label `Stale` (header `Degraded Local Fallback`), glyph `◐` (`data-icon="clock-stale"`), `dashed` border (`data-health-state="stale"`), plus visible `[data-stale-badge="true"]` naming exceeded cadence (`> 30s`, `> 5m`, or `> 15m`).
- **`empty` (`Zero Activity` — Online, 0 Events):** Token `status-zero-fg`/`status-zero-bg`, label `Zero Activity`, glyph `◌` (`data-icon="circle-empty"`), `dotted` border (`data-health-state="zero-activity"`). States `0 events in window (server online)`—never `Healthy`, `Stale`, or `Server Unreachable`.
- **`error` (`Server Unreachable` / `Offline` — Cannot Reach `127.0.0.1:1933`):** Token `status-unreachable-fg`/`status-unreachable-bg`, label `Server Unreachable` (header `Offline`), glyph `✕` (`data-icon="octagon-x"`), `double` border (`data-health-state="server-unreachable"`). Unreachable `:1933` figures render `— (Unreachable)` (`data-unreachable-value="true"`), **never** `0` or `Healthy`.
- **Interactive States:** `default` (`bg-surface`), `hover` (`bg-hover`), `focus` (`:focus-visible` `2px solid var(--accent-primary)`), `active` (`accent-primary`), `disabled` (`opacity: 0.5`, `aria-disabled="true"`).

## Endpoint Shapes & Figure-to-Server-Field Contract (Zero Client Roll-Up Math)

Browser code formats values only and **never computes sums, averages, percentages, or health verdicts**. Every figure declares `data-source-field` and `data-age`:

| UI Figure | Endpoint | Exact Server Field (`data-source-field`) | Age (`data-age`) | Cadence |
|---|---|---|---|---|
| Header mode & role memory folders | `GET /api/openviking/overview` | `observer.mode_label`, `observer.role_memory_folder_count` | `observer.checked_at` | `30s` |
| Daemon bind & queue depth | `GET /api/openviking/overview` | `observer.daemon_bind`, `observer.queue_depth` | `observer.checked_at` | `30s` |
| 5-slot hit rate & avg tokens | `GET /api/openviking/overview` | `metrics.slot_hit_rate_pct`, `metrics.avg_injected_tokens`, `metrics.turns_sampled_24h` | `metrics.last_recorded_at` | `5m` |
| 24h commits, promotions, rejects | `GET /api/openviking/overview` | `changelog.commits_24h`, `changelog.promotions_24h`, `changelog.rejected_24h` | `changelog.last_event_at` | `15m` |
| Per-slot mount row metrics | `GET /api/openviking/overview` | `slots[].slot_id`, `slots[].uri_prefix`, `slots[].hit_rate_pct`, `slots[].avg_tokens`, `slots[].state` | `slots[].last_sampled_at` | `5m` |
| Namespace explorer rows | `GET /api/openviking/entries` | `entries[].uri`, `entries[].scope`, `entries[].role`, `entries[].layers`, `entries[].l0_abstract`, `entries[].l1_overview`, `entries[].l2_content` | `entries[].updated_at` | `15m` |
| Commit & guard audit rows | `GET /api/openviking/audit` | `events[].id`, `events[].action`, `events[].role`, `events[].uri`, `events[].l0_abstract`, `events[].guard_verdict` | `events[].ts` | `15m` |

## Show&Tell

Prototype link: `/showtell/#/d/d_openviking_dashboard` (`d_openviking_dashboard`).

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
