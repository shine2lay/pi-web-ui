# Operational States: OpenViking Memory Dashboard (`openviking-dashboard`)

Part of [spec.md](spec.md) (`.temper/features/openviking-dashboard/spec.md`), moved there byte-identically by architecture #531. The section number is unchanged, so a `spec.md` §4 citation still names this text.

### 4. Operational States (Never Conflated)
Behaviour contract only. Each state's visuals (token, label, glyph + `data-icon`, border) are owned by `.temper/features/openviking-dashboard/design.md` §Screen States; values by `.temper/design/tokens.json`.
- **`live`:** `/health` `"ok"`, age `<= cadence`, `> 0` events/24h (`data-health-state="healthy"`).
- **`stale`:** `/health` `"ok"`, age `> cadence` (`> 30s`, `> 5m`, `> 15m`) or `pending_wt_land_syncs` non-empty (`data-health-state="stale"`, `[data-stale-badge="true"]`).
- **`stale_badge` names the true reason (ruling rm-b5272a3e, backend #138 row 32):** `observer.stale_badge` is `"> 30s"|"pending sync"|null`; `entries.stale_badge` and `audit.stale_badge` are `"> 15m"|"pending sync"|null`. **Age wins:** when age `> cadence` and a sync is pending, the badge is the age value. `"pending sync"` appears only when age `<= cadence` and `pending_wt_land_syncs` is non-empty; `null` when not stale. `[data-stale-badge="true"]` marks stale for both causes. **No false age:** a sync-caused stale never reports an age (never `"> 15m"` on data within cadence).
- **`empty`:** `/health` `"ok"`, `0` events/24h (`data-health-state="zero-activity"`).
- **`error` (`R-FAIL-1..3`):** `/health` fails (`data-health-state="server-unreachable"`). `:1933` fields return `null` -> `— (Unreachable)` (`data-unreachable-value="true"`), never `0`/`Healthy`; JSONL panels still show counts + staleness.
- **`loading`:** `[data-screen-state="loading"]` skeletons; never fake `0` counters.
- **No role liveness (v1):** nothing measures it: no panel, label or header may state or imply a role is live, online or healthy; folder count never feeds `screen_state`, `mode_label` or a degraded verdict.
- **`last_reachable_at` `null`:** no `/health` `"ok"` since this server started; never a duration, `0` or dash that could read as recent.
- **`last_reachable_at` gates nothing:** best-effort; feeds no `screen_state`, `mode_label`, degraded verdict or alarm.
