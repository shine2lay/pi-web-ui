# Feature Design Spec: OpenViking Memory Dashboard (`openviking-dashboard`)

Grounded in `.temper/features/openviking-dashboard/brief.md`, `.temper/design/DESIGN.md`, `.temper/design/tokens.json`, and the OpenViking contract. Read-only `pi-web-ui` surface: no memory mutation controls.

## First View, Disclosure Tiers & Breakpoints (`320px`, `390px`, `1440px`)

- **Tier 1 — Glanceable First View:**
  1. **Status Header (`[data-component="status-header"]`, `30s`):** Title, mode badge (`observer.mode_label` only: `Active`, `Degraded Local Fallback`, `Offline`), the count `N role memory folders` (no liveness claim), icon, age and cadence.
  2. **3 Summary Cards (`[data-component="summary-card"]`, each `data-panel-updated-at`, max 5 `[data-field]` text fields):**
     - **System & Daemon Health (`data-card-id="system-health"`, `30s`):** Daemon bind, health pill + icon, queue depth (`null` in v1: `unavailable`, never `0`), panel age/cadence.
     - **Context & Token Injection (`data-card-id="context-injection"`, `5m`):** 5-slot hit rate, health pill + icon, avg tokens + turns sampled, panel age/cadence.
     - **Commit & Guard Governance (`data-card-id="commit-governance"`, `15m`):** `N session commits` (24h; never a bare `commits`), health pill + icon, shared promotions + guard rejections, panel age/cadence.
  3. **3 Workspace Tabs (`[role="tablist"]` -> 3 `button[role="tab"][data-tab]`):**
     - **Tab 1 — `5-Slot Context Mount` (`data-tab="mount-map"`, `5m`):** 5 rows (labels exactly as `server/openviking/types.ts`) with URI prefix, hit rate, avg tokens, status badge, `(?)` tooltip, and age.
     - **Tab 2 — `Memory Namespace Explorer` (`data-tab="namespace-explorer"`, `15m`):** Expandable rows (`[data-component="memory-row"]`) across `viking://resources/`, `viking://user/memories/`, and role-isolated `viking://agent/memories/`, with URI, role/scope pill, `L0 / L1 / L2` badge, one-line `L0` abstract, and age.
     - **Tab 3 — `Commit & Guard Audit` (`data-tab="commit-audit"`, `15m`):** Expandable rows (`[data-component="audit-row"]`) with event age, action badge (`commit` = session commits only, `role_memory_write`, `promote_shared`, `reject_noise`, `sidecar_timeout`), role, URI, and one-line `L0` summary.
- **Tier 2 — Concept Tooltips (`[role="tooltip"]`):** Every contract badge (`L0`/`L1`/`L2`, `Slot 1–5`, `Commit Guard`, `Degraded Local Fallback`, `Sidecar Timeout`) has a `>= 24x24px` keyboard `(?)` trigger (`aria-describedby`).
- **Tier 3 — Reader Drawer (`[data-component="reader-drawer"]`):** Click or `Enter`/`Space` on any row sets `aria-expanded="true"` and opens the drawer (`role="dialog"`): `L0 Abstract`, `L1 Overview`, `L2 Full Content` tabs + provenance. `Escape` or `[data-slot="drawer-close"]` closes it and returns focus to the row.
- **Responsive Layout:** `1440px`: 3-column summary grid (`16px` gap), `520px` right drawer. `390px`/`320px`: single-column stack (`16px`/`12px` padding), `100vw` modal bottom-sheet drawer (`Tab`/`Shift+Tab` stay inside), `0px` horizontal overflow, body `>= 16px`, labels `>= 12px`.

## Screen States

Only copy of the state visuals (behaviour: `.temper/features/openviking-dashboard/spec-states.md` §4). Each state has its own token, label, icon (`data-icon`) and border, so colour is never the sole cue:
- **`live` (`Healthy`):** Token `status-healthy-fg`/`status-healthy-bg`, label `Active` or `Healthy`, glyph `●` (`data-icon="circle-check"`), `solid` border (`data-health-state="healthy"`).
- **`loading`:** `[data-screen-state="loading"]` skeletons; never fake `0` counters; pills read `Loading…`, no status glyph or `data-icon`.
- **`stale` (past cadence or a sync pending):** Token `status-stale-fg`/`status-stale-bg`, label `Stale` (header `Degraded Local Fallback`), glyph `◐` (`data-icon="clock-stale"`), `dashed` border (`data-health-state="stale"`), plus visible `[data-stale-badge="true"]` printing that source's `stale_badge` verbatim (§4): never wording the page composes, an age it derives, or a duration beside `pending sync`; `null` = no pill.
- **`empty` (online, 0 events):** Token `status-zero-fg`/`status-zero-bg`, label `Zero Activity`, glyph `◌` (`data-icon="circle-empty"`), `dotted` border (`data-health-state="zero-activity"`). Panels with no events state `0 events in window (server online)`—never `Healthy`, `Stale`, or `Server Unreachable`.
- **`error` (cannot reach `127.0.0.1:1933`):** Token `status-unreachable-fg`/`status-unreachable-bg`, label `Server Unreachable` (header `Offline`), glyph `✕` (`data-icon="octagon-x"`), `double` border (`data-health-state="server-unreachable"`). `:1933`-sourced figures render `— (Unreachable)` (`data-unreachable-value="true"`), **never** `0` or `Healthy`. Local-JSONL figures keep count and age: `from local audit log` (card 3/Tab 3) or `from local metrics log` (card 2/Tab 1). A reader layer reads `Unavailable while offline` only where `:1933` serves it; isolated and structurally empty layers, and the Tab 3 note, keep their own reason.
- **Per-card pills:** each pill shows its own panel's `health_state`, not the screen's; local-log cards 2-3 are never `Server Unreachable`. `error`: card 1 `Server Unreachable`, cards 2-3 `Stale (> 5m)`/`(> 15m)` (every pill prints its `stale_badge` verbatim). Degraded `stale`: card 1 `Stale (pending sync)`, footer `Answers, but 2 worktree syncs are still waiting to land` (`auxiliary.rollout.pending_wt_land_syncs`). `empty`: card 1 `Healthy`.
- **Ages:** the daemon's check age is `observer.checked_at` (request time): `Checked 4s ago`; offline `No answer from 127.0.0.1:1933 · checked 4s ago`. Each visible age names its timestamp in `data-source-field`.
- **Last answered (`error` only):** muted line under that, `Last answered 18m ago` (now minus `observer.last_reachable_at`; under 60s `3s`, never `0m`/`just now`); `null`: `No successful contact since the dashboard server started`. Not shown elsewhere; gates nothing.
- **Interactive States:** per `.temper/design/DESIGN.md`; selected tabs, filters and tiers use the accent, never a status tone.

## Endpoint Shapes & Figure-to-Server-Field Contract (Zero Client Roll-Up Math)

| UI Figure (`overview` unless noted) | `data-source-field` | `data-age` |
|---|---|---|
| Header mode, folders, daemon bind, queue depth | `observer.{mode_label,role_memory_folder_count,daemon_bind,queue_depth}` | `observer.checked_at` |
| 5-slot hit rate & avg tokens | `metrics.{slot_hit_rate_pct,avg_injected_tokens,turns_sampled_24h}` | `metrics.last_recorded_at` |
| 24h session commits, promotions, rejects | `changelog.{session_commits_24h,promotions_24h,rejected_24h}` | `changelog.last_event_at` |
| Per-slot mount row metrics | `slots[].{slot_id,uri_prefix,hit_rate_pct,avg_tokens,state}` | `slots[].last_sampled_at` |
| Namespace explorer rows (`entries`) | `entries[].{uri,scope,role,layers,l0_abstract,l1_overview,l2_content}` | `entries[].updated_at` |
| Commit & guard audit rows (`audit`) | `events[].{id,action,role,uri,l0_abstract,guard_verdict}` | `events[].ts` |

## Show&Tell

Prototype link: `/showtell/#/d/d_openviking_dashboard`.

### Prototype-Only Chrome Excluded from Production

Banned from production (quote verbatim into Architecture's `spec.md`):
- **`#stateStrip`:** Never render, mount, or CSS-hide it; `document.getElementById("stateStrip")` must be `null`.
- **`data-st-state`:** Never emit it on any element.
- **`window.__hidePrototypeChrome` and `?proto=0`:** Never define `window.__hidePrototypeChrome` or branch on `?proto=`.
- **`?state=` and `?scenario=` URL overrides:** Derive states exclusively from `/api/openviking/*` responses, never query parameters.
- **`<script id="openviking-fixture-data" type="application/json">` and `window.__OPENVIKING_FIXTURE__`:** Fetch live `/api/openviking/*` endpoints; never embed static fixture payloads.

## Reference Screenshots

```text
.temper/features/openviking-dashboard/shots/live-{1440-dark,1440-light,390-dark,320-dark}@2x.png
```
