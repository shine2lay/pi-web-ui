# Operational States: OpenViking Memory Dashboard (`openviking-dashboard`)

Part of [spec.md](spec.md) (`.temper/features/openviking-dashboard/spec.md`), moved there byte-identically by architecture #531. The section number is unchanged, so a `spec.md` §4 citation still names this text.

### 4. Operational States (Never Conflated)
Behaviour contract only. Each state's visuals (token, label, glyph + `data-icon`, border) are owned by `.temper/features/openviking-dashboard/design.md` §Screen States; values by `.temper/design/tokens.json`.
- **`live`:** `/health` `"ok"`, age `<= cadence`, `> 0` events/24h (`data-health-state="healthy"`).
- **`stale`:** `/health` `"ok"`, age `> cadence` (`> 30s`, `> 5m`, `> 15m`; entries per `R-SNAPSHOT-STALE-1` below) or `pending_wt_land_syncs` non-empty (`data-health-state="stale"`, `[data-stale-badge="true"]`).
- **`stale_badge` names the true reason (ruling rm-b5272a3e, backend #138 row 32):** `observer.stale_badge` is `"> 30s"|"pending sync"|null`; `entries.stale_badge` and `audit.stale_badge` are `"> 15m"|"pending sync"|null`. **Age wins:** when age `> cadence` and a sync is pending, the badge is the age value. `"pending sync"` appears only when age `<= cadence` and `pending_wt_land_syncs` is non-empty; `null` when not stale. `[data-stale-badge="true"]` marks stale for both causes. **No false age:** a sync-caused stale never reports an age (never `"> 15m"` on data within cadence).
- **`R-SNAPSHOT-STALE-1` — entries age is not snapshot age alone (ruling rm-3a23be76, fixes QA #136 F5; replaces backend #157's two-cadence allowance, `f4ea71cf`):** `entries.stale_badge` is `"> 15m"` iff snapshot age (now − `panel_updated_at`) `> 15m` AND NOT (a build in flight that started `< 5m` ago). Young rebuild in flight -> no badge; failed build (none in flight, age grows) -> `"> 15m"`; build hung past `5m` -> `"> 15m"`. Label unchanged; `"pending sync"` precedence unchanged (age wins, with age as defined here).
- **`empty`:** `/health` `"ok"`, `0` events/24h (`data-health-state="zero-activity"`).
- **`error` (`R-FAIL-1..3`):** `/health` fails (`data-health-state="server-unreachable"`). `:1933` fields return `null` -> `— (Unreachable)` (`data-unreachable-value="true"`), never `0`/`Healthy`; JSONL panels still show counts + staleness.
- **`/health` alone decides `server-unreachable`:** a listing or content read that fails under an answering `/health` is a partial answer, not an unreachable server — the rows that read are returned and flagged by `entries_partial`/`unread_count` (spec.md §3a), never an empty list in `error`.
- **`loading`:** `[data-screen-state="loading"]` skeletons; never fake `0` counters.
- **No role liveness (v1):** nothing measures it: no panel, label or header may state or imply a role is live, online or healthy; folder count never feeds `screen_state`, `mode_label` or a degraded verdict.
- **`last_reachable_at` `null`:** no `/health` `"ok"` since this server started; never a duration, `0` or dash that could read as recent.
- **`last_reachable_at` gates nothing:** best-effort; feeds no `screen_state`, `mode_label`, degraded verdict or alarm.

### 4a. Entries Listing Is a Snapshot (backend #155, `7c38790`; rulings rm-8e4a1631, rm-6b69cf03)
- **Never fans out per request:** the server builds the listing at start and every `15m`, single-flight (a tick during a build joins it); `GET /api/openviking/entries` returns the latest snapshot.
- **What a response describes:** `panel_updated_at` = that build's finish; `entries_partial`/`unread_count` describe that build within the request's scope; `scope`/`role` slice the snapshot.
- **Before the first build:** a request awaits the build in flight.
- **Failures keep what is held:** a failed build keeps the last snapshot; a partial build never replaces a complete one.
- **Still live per request:** `/health` (it alone decides `server-unreachable`, §4) and `?uri=` (one live single read, spec.md §3a).
- **`/health` down (backend #153 reading, accepted):** `entries: []`, `health_state: "server-unreachable"`, `unread_count` = every read unit in scope (`17` for `scope=all` without `role`), `entries_partial: true`, whatever the snapshot holds. Why: `entries_partial: false` with `[]` would claim a complete empty list.
