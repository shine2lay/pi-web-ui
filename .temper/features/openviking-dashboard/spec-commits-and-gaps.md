# Session Commits and Contract-vs-Live Gaps: OpenViking Memory Dashboard (`openviking-dashboard`)

Part of [spec.md](spec.md) (`.temper/features/openviking-dashboard/spec.md`) §Canonical State and Formula Owners, moved there byte-identically by architecture #531.

### Session Commits (`changelog.session_commits_24h`, was `commits_24h`; ruling rm-9724bae9)
- **Counts only a session committing its own work:** `queue_done` session commits + lead-200k session commits (live: `add` to `viking://session/<id>`, `source` `queue_done` / `session_commit_200k`; pre-rename name `session_commit`).
- **Excludes:** one-time `migration` role-memory writes; `lead_direct` role-memory writes; any other write (`add`/`update`, any name) that is not a session committing its own work.
- **Classify by meaning, never one event name:** the Ops rename collapsed `session_commit` into `add`; one Backend classifier covers old and new names, and no future rename may silently re-include excluded writes.
- **Label:** panel `"N session commits"`, never bare `"commits"`; JSON field `session_commits_24h`.
- **Worked example** (backend #133 blind verify, 2026-11-11): old count `381` = `72` `queue_done` + `17` lead-200k + `266` `migration` + `26` `lead_direct`; correct `89` (`72` + `17`). Any excluded write in the count is a regression.

### Contract-vs-Live Gaps for Ops
- **G1 — SETTLED:** `result.status` is an ASCII table; render unavailable, never `0`, never scraped (`R-QUEUE-DEPTH-1`, §8b).
- **G2 (`metrics.jsonl`):** §8 `{l0_hit,l1_expanded,extracted,dedup_skipped}_count`, `injected_tokens_est` -> live `{l0_hits,l1_reads,extracted,dedup_skipped,tokens_est}`.
- **G3 (per-slot):** turn totals only; `null` / `"unmeasured-gap"` until Ops logs `slots[]`.
- **G4 — PASS live (Ops #810):** writers emit contract `action`s; old rows keep `{session_commit,preference_write,resource_sync,preference_write_blocked}`.
- **G5 (`rollout-state.json`):** Only `{"pending_wt_land_syncs":[...]}`; report `stage: null`.
- **G6 (`migration-verification.json`):** `checked_at`/`source_files[]` vs. §9 `verified_at`/`total_checked`.
- **G7 (`seen-role-messages.json`):** absent live; contract §4.4 Live status.
- **G8 — SETTLED:** wording only; canonical form `viking://user/default/memories` (`R-URI-CANONICAL-1`, §8b).
