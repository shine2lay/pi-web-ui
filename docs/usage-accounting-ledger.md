# H-AUTOCOST-7 — live numeric usage ledger (Ops #306)

**Wrong / evidence:** in-memory helper and application sessions have no transcript file. `SessionManager.inMemory()` is used by subagent/ephemeral chats, plugin completion, both decision readers, and goal wizard/reviewer sessions. The transcript reader cannot recover their usage.

**One change / why:** observe finalized SDK usage and asynchronously append an allowlisted numeric record, with conversation/session identity and the parent captured at helper spawn. This retains usage that would otherwise disappear without changing model requests or chat execution.

**Expected / measurement:** synthetic tests produce exactly one record per finalized usage event, including persistent chats, helpers with parents, app calls, cache warming, compaction, branch summaries, and error/aborted assistant messages with usage. Planted content never reaches disk; blocked/failing storage does not block or fail a session. After installation, a 15-minute look-only check finds new allowlisted lines, helper parent IDs, and 0700/0600 permissions.

**Disproof:** missing in-memory helper usage; any content, prompt, tool data, summary or error in a record; or storage failure/delay changing a chat's execution.

**Result: PENDING, not an accepted HIT.** Sealed assigned tests **26/26 passed** (2026-10-20 22:20 UTC, 31 ms tests / 245 ms total); server/tests typechecks, targeted formatting/lint, diff checks and the normal landing gate passed. Code `9c805232` (land receipt `131-9224b1`) was installed through `pi-web-deploy` after its dry run, 2026-10-20 15:31 Pacific. The live numeric/schema/permissions observation passed, but positive helper-parent evidence and a passing big-chat-copy health stage remain outstanding. Accountable lead: Ops.

## Storage and switch

`<dataDir>/usage-ledger/YYYY-MM.jsonl` (live dataDir: `~/.pi-web-ui`), directory 0700, monthly files 0600. Files are kept; there is no pruning or rotation beyond monthly partitioning by observation time in UTC. One serialized asynchronous queue per data directory, one append per line. Permission, settings or write failures skip that record, emit only a fixed warning at most once a minute, and never propagate into a session. There is no content/error logging and no model invocation.

`<dataDir>/usage-ledger.json` accepts `{"enabled": true}` (default when absent); `{"enabled": false}` stops writes without a restart. It is read asynchronously before each queued append. Invalid or unreadable settings skip the append rather than overriding a possible off switch. No settings file is created by this change. Turning off does not remove earlier records.

## Closed format

Every record has exactly these fields (and `app` only for origin `app`):

- `v`: `usage-ledger/1`; `at`: observation ISO timestamp; `occurredAt`: SDK message/entry timestamp as ISO.
- `kind`: `assistant | cache_warm | compaction | branch_summary`.
- `provider`, `model`, `modelSource`: SDK response model preferred (`response`); otherwise the requested/current model (`requested`). Aggregate/cache usage has no response model; it is marked requested, not claimed as a measured routed model.
- `responseId`: SDK response identifier or null; `stopReason`: SDK stop enum or null for non-assistant usage. Never an error message.
- `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`: finite nonnegative numbers. Native total preferred; otherwise component sum. Missing optional cache classes become zero. Invalid present counters are rejected rather than coerced.
- `costTotal`: SDK's finite nonnegative reported cost or null when unavailable. No inferred prices or budget authority.
- `conversationId`, `sessionId`, `sessionFile` (null for in-memory), `persist` (actual SDK persistence state).
- `origin`: `chat | helper | app`; `parentConversationId`: spawner/goal owner when known, otherwise null.
- `app`: fixed allowlisted name, only for app sessions: `plugin-llm`, `decision-model`, `decision-bounded-model`, `goal-wizard`, `goal-reviewer`.

No raw object is spread or serialized. Content, prompts, tool data, notes, summaries, details and errors are never read by the projection. At roughly a few hundred bytes per call, actual size varies with identifiers and session paths; no fixed 300-byte guarantee.

## Hook coverage and SDK limits

`attachUsageLedger(session, meta)` subscribes once per session; repeated registration updates metadata without another listener. Metadata is snapshotted at the event, before any asynchronous storage. No transcript is read, replayed or backfilled.

- `message_end`: assistant usage only, including errors and aborts that report usage. Persistent and in-memory chats use the same hook. Response IDs are preserved for downstream transcript/ledger deduplication.
- `entry_appended`: `usage` of kind `cache_warm`, and usage-bearing compaction/branch-summary entries when emitted. Other arbitrary usage categories are not relabelled.
- `compaction_start`/`compaction_end`: requested model is captured before compaction; usage is taken from the result, using the newly appended compaction entry's timestamp/identity when available. The SDK exposes aggregate compaction usage, not every underlying summarizer retry. Without an entry timestamp, observation time is used.
- SDK 1.0.1's `navigateTree()` returns `summaryEntry` but does **not** emit it to public session subscribers. The existing rewind call forwards that result to `recordUsageLedgerEntry`; no SDK monkey-patching or model request changes. Both paths share deduplication.

New/reopened/rebuilt/forked chats attach at runtime registration, with reattachment on binding. Helpers use the parent selected **before** asynchronous creation (not whichever chat is active at completion). `delegate_task` uses the same spawn path. Temporary chats remain origin `chat`, persist false. All five isolated application session creation sites attach before their first prompt; goal sessions preserve their known owning conversation.

Missing SDK usage (including unreported failed attempts), extensions' private model calls that emit none of these events, and summarizer sub-attempt identities are not invented. Null response IDs/unknown response models are not proof of independent billable attempts. The future meter must deduplicate persistent assistant records against transcript entries by responseId and conservatively handle aggregate records; this module does not change the collector, capture contract, membership map, budgets, spend files or accounting policy.

## Verification / undo

Run the assigned numeric unit tests in a sealed environment and the normal `wt land` gate. Install only through `pi-web-deploy` (dry-run first). Look-only production inspection prints counts/key names/mode checks only, never field values or transcript content. It must not start a helper or model call to manufacture evidence.

Undo writing immediately with `{"enabled": false}` in the ledger's settings file; existing records stay intact. Code rollback is via `pi-web-deploy rollback`, never a manual service restart.

## Live observation — 2026-10-20

Look-only inspection printed counts and allowlisted key names, never ledger field values or transcripts. No helper or model call was started for evidence.

- At 15:35 Pacific: 33 complete, exact-allowlisted records. After the 15-minute window: 321 records, **288 additional**; 319 assistant and 2 cache-warm records in total.
- At 15:58: **516** complete records (514 assistant, 2 cache-warm). One directory 0700 and one monthly file 0600. Zero unexpected/missing keys, malformed JSON, invalid numeric/cost fields, incomplete lines or duplicate response identities.
- Zero naturally occurring helper/app records in that observation. Unit coverage is not a substitute for the required live helper-parent receipt. This is missing positive evidence, not proof that an observed helper call was dropped.
- Deploy's server, page, reply and log checks passed; big-chat COPY did not open within its ordinary 300-second deadline. Installation is live, but deployment completion is **not** an all-checks-passed receipt.

### H-AUTOCOST-7-DEPLOY-1 — isolated health stage: MISS

**Wrong / evidence:** big-chat COPY timed out while the restart resumed ten active chats; the other four checks passed. A previous incident passed the unchanged checker after restart load settled. This suggests load, but does not prove it caused this failure.

**One action / why:** repeat only the existing big-chat COPY stage on the unchanged installed build, retaining selection, deadlines, picture assertions and cleanup. No source-chat changes, restart, settings changes or model calls.

**Expected / measurement:** a passing isolated stage plus the four existing passes establishes all five health checks; the original failure remains recorded. Another failure or a changed build disproves this hypothesis.

**Observed:** the isolated stage also exited 1 after about five minutes. Its bounded diagnostic emitted a failure count, not raw exceptions, content or snapshots; the exact internal cause is not established. No third retry or relaxed assertion is counted as progress. Ops lead has the request for bounded investigation and a passing same-build checker receipt (`rm-2024567a`). Acceptance remains open.
