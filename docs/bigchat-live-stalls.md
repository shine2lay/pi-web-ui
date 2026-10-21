# Big-chat live-server stalls (Ops #308)

Accountable lead: Ops. Approval: Ops task #308. No real chat edits, model requests, checker retries or softened acceptance. Architecture's bounded read is rm-f7eee87e (reply to rm-63547000).

## Evidence and falsified explanations

Live build `9c805232304e659101d01bfcb7ee36bdaacfbd57` contains the usage ledger, but the first 300-second bigchat failure was on `5d3ff258`, before that ledger existed. A controlled sealed comparison of the same 243,344,844-byte file passed on both 9c805232 (7.6s, 6/6 pictures) and 50a96313 (6.7s, 6/6).

Task #308 froze a new copy with the existing `copyChat` implementation: 243,426,505 bytes, SHA256 `c82b8b18284c0ad8929ea8fa1b3e91bfffa4bd257381fe12263e1a3054182768`. No chat/model/tool contents were printed. Evidence and numeric receipts are retained in `/home/shinelay/kept-from-tmp/2026-10-20-ops308/`.

| Pacific 2026-10-20              | Build    | Result          | Open  | Pictures | Stalls / total / max    |
| ------------------------------- | -------- | --------------- | ----- | -------- | ----------------------- |
| 15:32–15:38 (six-minute window) | 9c805232 | 300s timeout    | none  | none     | 51 / 112.261s / 14.542s |
| 15:53–15:59 (six-minute window) | 9c805232 | 300s timeout    | none  | none     | 41 / 65.843s / 3.776s   |
| 16:49:24–16:50:59, trial1       | 9c805232 | picture failure | 35.1s | 0/6      | 17 / 44.540s / 5.885s   |
| 16:59:20–17:00:12, trial2       | 9c805232 | PASS            | 4.3s  | 6/6      | 2 / 3.046s / 1.920s     |

The two task trials used identical frozen bytes and no concurrent install. Trial2 had no check-page socket close or silence banner before cleanup; its matching snapshot was 489,492 characters and first frame arrived in 1,249ms. Trial1 load8.3–8.9/GC25.774s versus trial2 load1.2–1.4/GC7.517s. These different-duration windows are not a controlled before/after application-fix comparison.

Scope deviation, retained explicitly: trial2's start was596.220s after trial1's start,3.780s short of the approved ten minutes. No exception was authorised. The runner now refuses to start until >=600,000ms after the previous trial's END. At most four task live trials remain the limit; two have been used before this application change.

- H1, repeated socket reconnect/open as every failure's cause: MISS on the task trials. One failure produced a matching snapshot, and the unchanged build later passed. Old timeout loops remain observed, not proof of repeated SDK open.
- H2, global extensions' session-start dominating: MISS on fixed-input sealed stages. No packages:2.5s open/6of6 pictures; all12 installed package paths:8.9s/6of6. Copied-session hooks combined <100ms; all session-start hooks <0.85s. No live credentials or remote MCP config copied, so not a blanket exclusion of all remote startup effects.
- H3, retained checker copy or parsed-session heap alone: cleanup bug confirmed; retained-copy explanation insufficient. Current safe cleanup leaves no copy runtime, yet stalls remain. Four extra parsed managers (~974MB source data) plus the check, all packages, in the bounded sealed scope still passed9.4s/6of6. Heap1.491→1.494GB; GC1.881s total/189ms max. That stage was not a full streaming workload.
- Major GC traces alone do not explain the stalls: near15:32:24, seven major traces across two isolates total638.51ms/max397.74ms, versus a14.542s stall. The broader GC observer still shows substantial heap churn.

The unsafe checker cleanup and uncounted failures were fixed separately in agent-tools `6807ee7eaaac86e5f5137d478d9f09ac89cab650`, land receipt `30-b62e8b`: only a snapshot with the exact copy sessionFile authorises dismissing its id; failed opening reports frame-type counts/max lengths, snapshot match booleans, socket closes and first-frame latency. Both regressions fail with the old code and the final suite passes. Limit300s, picture rule and no retries unchanged.

## H-308-S: eliminate repeated unchanged statistics walks

Before changing app code, Architecture ranked whole-transcript derived work on the shared loop above SDK opening and extension start. `ClientSession.sessionStats` was a per-window250ms memo, timestamped BEFORE compute. Every streaming delta and light-state snapshot uses it. SDK1.0.1 `getSessionStats` walks every entry, then projects context and traverses the branch. A sufficiently slow read expires its own cache; each window repeats the same work. Its output depends on persisted entries/branch and model limits, not partial text deltas.

Measured first, sealed and model-free, on the fixed16,390-entry copied file with a fixed200k context window:16 actual SDK calls cost970.686ms,35.283–167.242ms each. No call exceeded250ms: self-expiration is NOT reproduced on this input (that prediction MISS). Repeated unchanged reads still consume about a second of shared-loop CPU in just16 reads.

One candidate change only: `server/session-stats.ts` keeps a process-wide weak cache per session manager. O(1) revision: leaf plus the SDK's own fileEntries array identity and length. Changing any entry count/branch/reload invalidates immediately. Effective model presence and context-window value are also keys, following SDK `_limitsModel()`. Model object identity is deliberately not a key: provider getters can return fresh-but-equal objects. SDK persisted entries are immutable after append; add-ons must preserve that invariant (in-place mutation would otherwise wait for the next append, rather than the former250ms refresh). Unknown manager layouts keep a250ms memo measured from completion. The SDK still supplies the entire authoritative stats value; no totals or context formula is rewritten. Architecture review `rm-a5950f08` found no missing SDK invalidation and required covering plugin/scheduler polls too. Those now use the same shared cache; id-only plugin/scheduler routing uses the unchanged most-recent selection without building messages/stats. The three explicit tool/preset invalidations remain harmless and preserved.

Expected: sixteen unchanged reads over the old TTL and across four windows do one SDK walk rather than16; slow reads can hit; append/branch/reload/model changes are current immediately; another manager never shares values. Falsification: stale invalidation case, unchanged reads still walking, output mismatch, or measured live stalls unrelated. A passing bigchat on an otherwise idle build is necessary but not proof of a load-dependent stall fix.

Candidate B (headless automatic snapshots) and list fanout, incremental transcript indexes, workers and processes are NOT bundled. A per-Conversation derived-state redesign remains a draft only; no structural split is implemented.

## Verification and result

H-308-S targeted cache result: HIT. Fixed16,390-entry source, four windows and16reads separated by synthetic300ms clock steps: old ClientSession16SDK calls/746.139ms; new1call/98.508ms. This is7.57x less measured repeated work, not a7.57x faster initial SDK calculation or a demonstrated live-stall cure. Restoring the old ClientSession method fails10of12 regressions (2pass); proposed source passes12of12 and all29targeted tests. Full typecheck and full application build pass.

A bounded sealed integration of the candidate with all12package paths and four independently parsed resident managers passes in9.2s,6of6pictures. Receipt `sealed-stats-after-env.json`: heap1.491→1.493GB, GC1.952s/max253ms, max loop delay6.338s; SDK open1.244s, four authoritative getSessionStats calls36.056ms total. This quiet workload is NOT the missing active-streaming reproduction. Its low stats total cannot establish the dominant live-stall caller. Initial16.1s harness receipt is explicitly not a four-resident run: sealed.sh dropped variables supplied before its env fence. A corrected `sealed.sh env ...` invocation proves residents=4 and populated metrics; both mistakes are retained in HYPOTHESES.md.

Architecture's required plugin-poll coverage, id-only getter and effective-limit keys are complete. Their three new regressions each FAIL with the missing/old behavior (identity churn,16uncached polls, missing cheap getter). Restored final source passes all15cache cases and all38targeted cases; full typecheck and application build PASS again. Final bounded four-resident/all-package sealed integration also PASS23.8s/6pictures (`sealed-stats-final.json`): SDK open2.834s, stats4calls106.324ms, GC3.853s/max279ms, max loop delay16.215s. This CPU-constrained quiet stage is functional evidence, NOT a demonstrated stall reduction or dominant-caller attribution. Normal land checks and bounded live proof remain pending. No pi-web-ui candidate has been installed; two of four task live trials have been used. Ops lead's native decision (m00715) interprets existing step7 approval as covering exactly the ordinary deployment's built-in single throwaway reply check, not new owner consent. No separate full check, extra reply, bypass or model-based diagnostic is authorised. Do not claim the task's live cause or whole-fix HIT yet.

Undo: revert the `bigchat-stats` patch and deploy through `pi-web-deploy`. No data migration or persisted cache. A deployment rollback is permitted by this task only if its own build does worse than9c805232 on the live check.
