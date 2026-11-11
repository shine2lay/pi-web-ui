# Feature Brief: OpenViking Memory Dashboard (`openviking-dashboard`)

## User Moment
- Opening Pi Web UI on desktop or mobile to answer in 5 seconds (`m90930`, `m90948`): *"Is OpenViking actively working right now across our chats and tasks, what is it injecting and committing, and what lives inside our Shared and Per-Role memories?"*
- Browsing Shared Repo Resources (`viking://resources/`), Shared Craft Preferences (`viking://user/default/memories/preferences/`), and the 15 Roles' Personal Memories (`viking://user/<role>/memories/`) with `L0 -> L1 -> L2` progressive disclosure (`server/index.ts`, `web/index.html`).

## Metrics vs Noise
- **Tier 1 — 5-Second First View (shown immediately at the top):**
  - **Live Active Status Header:** Shows whether OpenViking (`http://127.0.0.1:1933/health` + `/home/shinelay/.pi/openviking/rollout-state.json`) is `Active`, `Degraded Local Fallback`, or `Offline` (with `N role memory folders`; no role liveness exists in v1), plus last activity timestamp ("Last injection: 2m ago · Last commit: 8m ago").
  - **3 Grouped Summary Cards (max 5 text fields per card, never a flat list):**
    1. **Live Injection & Retrieval Card:** Today's Mode 1 Lead folded `L0` injections, Mode 2 Worker Turn-1 pre-fetches (`Preferences` + `Project Facts`), retrieval latency/hit rate (`/api/v1/observer/system`), and 200K lead session commits (`metrics.jsonl`).
    2. **Two-Layer Memory Store Card:** Item counts across **Layer 1 Shared** (`6` repo resource trees, `8` craft preference domains, shared entities and events) and **Layer 2 Personal** (`15` roles' `viking://agent/memories/instructions/preferences.md`, `viking://agent/memories/cases`, and `viking://agent/memories/experiences`), plus last `wt land` sync status (`resource-sync-state.json`).
    3. **Guardrails & Commit Audit Card:** Post-task `queue_done` commits, `rm-*` deduplicated role messages, and blocked worker preference write attempts (`R-PREF-WRITE-GUARD-1` from `memory-changelog.jsonl`).
  - **3 Scannable Workspace Tabs:**
    - **Live Activity (`metrics.jsonl` & `memory-changelog.jsonl`):** Recent injections, `queue_done` commits, and `wt land` syncs as compact 1-line rows (time, role/task badge, action pill, token/item count, status).
    - **Memory Explorer (Layer 1 Shared vs. Layer 2 Per-Role):** Layer & role/repo selector + grouped item cards showing title, category badge, **1-sentence `L0` abstract**, and updated time.
    - **Guardrail & Changelog Audit:** Filterable stream of memory writes (`add`/`update`/`delete`), blocked worker preference writes (`reject_preference_candidate`), and promotions.
- **Tier 2 — Progressive Disclosure in `(?)` Tooltips (`role="tooltip"`):**
  - Explains contract mechanics (Mode 1 Lead turn-end `L0` card vs. Mode 2 Worker Turn-1 pre-fetch, `140,000`-token worker `pi-acp` threshold vs. `200K` lead commit-and-evict, and `R-PREF-WRITE-GUARD-1`) only on hover/focus.
- **Tier 3 — Click-to-Expand `L0 / L1 / L2` Drawer:**
  - Clicking any memory or resource item opens a clean reader drawer with `L0 Abstract`, `L1 Overview`, and `L2 Full Content` tabs (`GET /api/v1/content/{abstract,overview,read}`) plus changelog provenance.
- **Noise cut from primary view:** Full `L1` and `L2` markdown walls in list rows, raw internal AGFS storage paths, 64-character hashes, and `#stateStrip` prototype chrome in production.

## Non-Goals
- **No direct worker preference bypass or unauthenticated mutation:** The dashboard is an observability and inspection surface; it must never bypass `R-URI-REWRITE-1` or `R-PREF-WRITE-GUARD-1`.
- **Never fake live health when `:1933` is down:** If `openviking.service` is unreachable, surface `Offline / Degraded Fallback` visibly rather than rendering stale or zeroed counters as healthy.

## Acceptance Checks
- Default first view renders the Live Active Status Header, 3 Summary Cards, and tabbed workspace (`Live Activity`, `Memory Explorer`, `Guardrail & Changelog Audit`) with zero horizontal overflow, zero text overlap, and zero console/page errors across `320px`, `390px`, and `1440px` in light and dark modes (`ui-check` exit 0).
- Every contract concept badge (`Mode 1 L0`, `Mode 2 Turn-1`, `Write Guard`, `wt land Sync`) provides an accessible `(?)` tooltip (`role="tooltip"`), and clicking any memory/resource row opens the `L0 / L1 / L2` reader drawer without dumping full markdown in the list view.
- Server endpoints return real live data from `http://127.0.0.1:1933` and `/home/shinelay/.pi/openviking/{memory-changelog.jsonl,metrics.jsonl,rollout-state.json,resource-sync-state.json}`, and `wt check` + `doc-check` + `ui-check` pass with 0 violations.
