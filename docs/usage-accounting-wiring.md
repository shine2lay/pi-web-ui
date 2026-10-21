# Automatic costs: live wiring plan

Ops #309 · project `automatic-cost-accounting` · accountable lead: **Ops**.

**Planning only.** This document and its checker install nothing. None of the
plans below is a queued task or permission to start a service, read a live
source, create a credential, change a policy, or spend. Ops queues the plans
through the normal approval path after reading the review and admission gates.
The Pi implementation comes first; the Temper reader is admitted separately.

## H-AUTOCOST-WIRING-1 — before writing the plan

Wrong/evidence: the seven foundation documents describe tested but disconnected
components. Only #306 writes live numeric observations. There is no installed
collector I/O/verifier, changed-source follower, complete subject partition,
automatic Roles DTO, or replacement test for the manual figures. The installed
server also has the independently tracked big-chat stall (#308). A whole-file
synchronous meter would make that risk worse. The collector's 16 MiB/10,000-row/
64-source fixture envelope is not a production week's capacity; merely adding a
poller cannot meet the outcome.

One change/why: specify one deterministic, worker-owned numeric meter, delivered
through noncolliding module tasks, with durable incremental cursors, bounded
reconciliation and a cache-only page path. Make source, capacity, funding and
release gaps explicit instead of treating the inert fixtures as live evidence.

Expected/measurement: all five project criteria have named deliveries; every gap
has a lead and an owed result; every task passes the queue's seven-field rules;
Architecture reviews the runtime and dependency shape. Disproof: a missing
criterion, an unowned prerequisite, an unbounded hot-path read, a fabricated
identity/allocation, a dependency used only for ordering, or a rejected task plan.
Result: **HIT for the planning hypothesis only.** The final checker passed all
16 task plans, all five mappings and all 13 owned gaps, and rejected 34 planted
bad-plan controls. Architecture's initial REVISE and all nine applied corrections
are recorded below, with conditional permission to land without a second review.
The normal land receipt is reported by Ops #309; no live meter HIT is claimed.

## Source pins and project acceptance map

Read all seven `docs/usage-accounting-{contract,collector,capture,roles,pi-sessions,membership,ledger}.md`
from `mine` at `a21a7ee2` (2026-10-20). Code pins: #293 `ffb1c66e`, #300
`757b9129`, #301 `8f54b4ce`, #302 `d406f8b9`, #304 `2c446e98`, #305
`cf0a0887` plus proof `bde61820`, #306 `9c805232`, #307 `912a4d2c`.
Later proof updates must not silently become new implementation approvals.

**Late-fact correction (Ops lead, this task, 2026-10-20):** Temper #125 did not
land: lock-wait p95 was 53 ms against a 50 ms bar. Its replacement is an xid8
watermark design. The old `after=<seq>` / commit-ordered-sequence plan below the
foundation is superseded: use route-issued opaque cursors, dedupe by native call
ID, per-page `complete_through`/`stalled`, and 409 on restore/reset. #128 must
deliver that exact read contract before the adapter can start. Data
`rm-809ae9d4` and Temper `rm-0af57cb5` also establish that Pi 0.87.1's `value || 0`
and later-zero overwrites destroy zero provenance; #129 maps **every Pi zero to
null**, and Pi total is null unless all four classes are known. No Pi zero is
proved by that repair. Temper rows still have no task/project fields; native
launch-origin linkage is a separate Temper deliverable. These late facts
supersede earlier route/token assumptions, not the project's five criteria.

The following are the project's **five verbatim done-when items**, read through
the same `readWork()` replay used by `work_project show`, registry sequence 2491,
project version 1. The tool is not exposed in this task chat; only the public
project record and task-index metadata were read, never a chat transcript.

| Criterion | Project done-when item | Landed foundation and remaining delivery |
| --- | --- | --- |
| P1 | Recorded Pi chat, side-call and Temper usage is priced and deduplicated by scripts, with auditable task/project/initiative links; missing prices or provenance are explicitly unknown or unassigned, never silently zero. | #293/#301/#304/#305/#306/#307; W0-W6 provide Pi intake, provenance, durable collection and subject projections; T0-T1 add Temper. Unsupported historical calls remain explicitly unknown, not completed by assertion. |
| P2 | Roles budget figures refresh within one minute of newly recorded usage and roll over on the Pacific Monday automatically, without tally-only LLM prompts or manual per-task updates. | #293 Pacific arithmetic, #302/#307 views; W6 follower + Monday reevaluation, W7 DTO/view, R0 and T1 latency receipts, C0 replacement. |
| P3 | The current budget week is reconciled first, then retained history is processed in a bounded low-priority background pass; restart, replay, cloned-session and overlapping usage sources cannot double-count costs. | #300 durable replay/cursors/requests, #304 ancestry, #305 event-time parents; W0/W1 production capacity/recovery, W2/W3 source indices, W6 priority scheduler; R0/T1 receipts. |
| P4 | The existing own-work budget scope remains intact: requested work and Team in Temper stay exempt; unknown allocation cannot falsely establish budget headroom; no new automatic pause/stop or cap change is introduced. | #293/#302 separate usage and funding, #307 policy-free display; S0 reviews provenance, W4 supplies only supported reporting funding, W5/W7 preserve uncertainty, D0a/D0b/C0 prove the replacement; G13 blocks false non-task completeness. |
| P5 | Known-case synthetic tests cover pricing/cache/side usage, duplicates/replay, missing data, attribution and Pacific/DST week boundaries; changes are landed and installed normally, with a look-only live check of the updated figures and freshness states. | Existing seven unit suites plus the isolated suites named per task; R0 and T1 each have a separate pi-web-deploy step and look-only live check; C0 has its own deploy/look if it changes the display. |

No criterion is marked met by this planning document. Missing coverage can be
truthfully displayed but cannot certify a complete budget numerator.

## Module interfaces: what exists and what it does not do

| Module / API | Inputs -> outputs | Caller obligations / stated gaps |
| --- | --- | --- |
| `server/usage-accounting-contract.ts`: `parseAccountingInput`, `factId`, `taskId`, `quoteListUsd`, `pacificWeekStartUtc`, `observeUsage(raw, {asOf, staleAfterMs, window})`, `accountUsage(raw, {policyRef, asOf, staleAfterMs})` | Closed facts, aliases, memberships, source coverage, revisions and optional roots/policies -> exact decimal reports; policy-free `observed-usage/1` or budget report. | Validation is not authentication. List/provider/invoice bases stay separate. Missing class/model/rate/coverage/identity is unknown. Task/project/initiative membership is not funding. No installed own/requested root source. |
| `server/usage-accounting-collector.ts`: `UsageAccountingCollector.open({inventory, verifier, io, clock?})`; `collect(stream, numericJson, receivedAt)`, `checkpoint()`, `input(asOf)`, `report(...)`, `requests(asOf, historicalFrom?)` | Vetted `usage-inventory/1`, bounded `usage-source-batch/1`, injected durable I/O -> journal-before-cursor commit, replay/quarantine, source requests and reports. | `input()` omits collector faults: never project it as healthy alone. `report()` carries faults but requires a policy. No live I/O, verifier, source inventory or runtime. 256 KiB/256-row batches, 100 ms validation, 169-hour windows; total-store limits need W0 before live history. |
| `server/usage-accounting-capture.ts`: `captureUsage(raw, readers?)`, `captureCapabilities()` | Allowlisted `numeric-capture/1` plus independently checked attempt/price/parent witnesses -> projection-only facts/aliases/unknown allocations and diagnostics. | Do not pass whole SDK events or records for stripping. Capabilities remain unavailable without supported sources. Source selectors do not authenticate. Do not squeeze the new Temper feed into `temper/legacy-summary` or invent roots. |
| `server/usage-accounting-roles.ts`: `projectUsageCost(source, request, manual?)`; `projectObservedUsage(source, {subject, asOf, staleAfterMs, window?})` | Complete `subject-usage/1` partition plus independent role bindings; explicit subject/policy context -> budget view or `usage-observed-view/1`. | Role/task/initiative supported; **project is not a supported subject**. Gross, dedup, own, exempt and other bases are overlapping views, not addends. A global report, filtered leaves plus global heartbeat, or forged policy is invalid. Observed view says funding not evaluated. |
| `server/usage-accounting-pi-sessions.ts`: `new PiSessionUsageReader(limits?).read({file, producer, from, through, observedAt, cursor?})` | Explicit regular session file, occurrence window <=169 hours, last committed anchored cursor -> `pi-session-read/1`, numeric observations, batch, complete-line byte/line/SHA cursor, bounded faults. | Parent/original before copies; restore numeric identity index on restart. Reader stops before out-of-window records; caller cannot skip the cursor to today's bytes. EOF certifies that file's persisted records only. Missing failures, deleted ACP files, fileless calls and summary model provenance remain gaps. `pi-recorded-1` is Pi's call-time recorded estimate, not today's reprice. |
| `server/usage-accounting-membership.ts`: `mapUsageMembership(sources, clock?)`, source-side `projectMembershipSessionEntry`, `projectMembershipRegistryEvent`, `projectMembershipConversation`, `projectMembershipDelegate`, `taskMembershipAt(map, file, occurredAt, origin)`, `membershipSourceBatches(map, context)` | Bounded queue/session/registry/helper **metadata pages** -> original task births, time-valid file intervals, parent snapshots, unmapped set and gaps. | No I/O or paging implemented. 64 sessions/10,000 records/100 ms per map. Any gap makes `taskMembershipAt` null. App origin is unassigned. ACP prose is not a parent witness. Inject native cursors; batches are always partial, not usage-completeness evidence. |
| `server/usage-accounting-ledger.ts`: `attachUsageLedger`, `recordUsageLedgerEntry`, `UsageLedger.enqueue/flush` | Source-side SDK scalar projection and spawn parent -> best-effort `usage-ledger/1` monthly JSONL. | No importer; no durable native call ID when responseId is null. Requested model is not proved actual. Missing cache counters currently become zero; presence is lost. Pi 0.87.1 also permits later zero to overwrite a positive count. No zero can be certified; #129 is conservative nulling, not a presence-preserving producer fix. Writes can be skipped and emit only a warning. Hook coverage is not all-call completeness. Do not reread this as a second charge beside a transcript. |

Read-only existing display seams are `server/roles-overview.ts`, `server/protocol.ts`
with generated web exports, and the Roles useful/panel/exact model/view files.
`server/roles-spend.ts` remains the manual parser. The exact minimal wiring plan
in `docs/usage-accounting-roles.md` is the starting point, not an installed path.

## Runtime shape and invariants

### Process, durable state and page path

1. One lifecycle owner in pi-web-ui starts **one worker thread**, after app state
   directories are known. The worker owns collection, bounded source reads,
   JSON parsing, hashing, replay, numeric indices, aggregation and reconciliation.
   No SDK event listener awaits it. It neither starts agents nor executes models.
   Worker failure cannot fail a chat; the page's old snapshot becomes stale.
   A cheap main-thread lifecycle health check may age scalar snapshot/coverage
   timestamps and latch a deduplicated alarm; it never reads/parses sources or
   performs HTTP. This lets the dead-man detect worker silence, not just errors
   the worker manages to report. It also immediately marks a snapshot stale when
   its `weekStart` differs from the current Pacific week, even if the worker is
   blocked. Start the Worker with W0's measured finite `resourceLimits`; an
   out-of-budget worker terminates into unavailable/stale state, not a server
   crash. Threads share libuv's pool: use bounded worker-local `readSync` and
   synchronous hashing (<=256 KiB per unit), or at most one outstanding pool
   operation for the remaining durable I/O. Measure main-thread fs-callback
   latency as well as event-loop delay; p99 alone does not detect pool starvation.
2. Durable numeric state lives under `<dataDir>/usage-accounting/`, not an identity
   folder or a spend file: 0700 directories, 0600 regular files, no followed
   symlinks/hardlinks, lifetime single writer. Numeric append-only evidence and
   adapter indices/cursors are distinct from the disposable compact page snapshot.
   The source cursor advances only after its exact numeric batch is durably
   committed by #300; an uncertain write requires reopen/replay, not blind retry.
   Keep evidence and corruption receipts; no prune/repair/reset as recovery.
   Reuse the reviewed role-message-guard lock implementation, including the
   ext4 inode-reuse/pid checks, through W0's narrow helper extraction. During a
   deploy overlap a nonowner says **waiting for previous writer**, stays stale,
   and never steals a live lock. Version the store header; an older reader
   refuses a newer major version. Never migrate in place without a kept copy;
   rollback first stops the writer and restores the compatible kept store or
   leaves the old build's meter unavailable, never downgrades evidence silently.
3. W0 extends #300 for **paged, yielding replay** and bounded production working
   sets, preserving the old API/fixtures and commit ordering. W1 supplies its I/O.
   Do not just increase every cap or load a larger journal into one string. Keep
   256 KiB/256-row validation pages, 1 MiB segments and 100 ms per-unit work caps.
   Persist numeric lookup indices; page cold weeks rather than retain all history
   in memory. Production acceptance must exceed the old 16 MiB, 10,000 rows and
   64 sources while proving a finite memory/CPU envelope. Any configured resource
   exhaustion stops safe with a durable capacity fault and UNKNOWN remainder.
4. The worker emits only a bounded, closed `usage-meter-snapshot/1` over its
   message port. Main-thread Roles reads a validated in-memory snapshot copy,
   never the journal, chat files, indices, credential or worker's raw exceptions.
   Snapshot generation IDs, evaluated time, oldest covered/observed timestamps,
   source/storage/funding states and safe fault counts travel with it. A read or
   heartbeat cannot advance native coverage. W5's numeric snapshot builder is
   **worker-only**. A separate `server/usage-accounting-meter-cache.ts` imports
   only W0's meter-contract types and owns the tiny validated DTO cache/getter.
   Roles, protocol and the startup hook never import the builder/accounting
   engine, even transitively. Positive import-graph tests enforce this boundary. On restart there is no reassuring
   balance until worker recovery validates retained state. The compact persisted
   snapshot is diagnostic/cache only, never cursor or coverage authority.
5. Observed task/initiative views use #307, independent of budgets. W5 partitions
   **all** subject leaves before calling `boundSource`; two roles never reuse one
   global report. Verified task/project/initiative links remain audit references
   in private numeric state, not arbitrary paths in public faults. A project
   audit is a union of original task keys at event time, not an invented #302
   `project` subject or a sum of overlapping UI subtotals.
6. For budget views, use #300 `report()` where possible. A subject-scoped observed
   or budget projection must explicitly merge the exact collector/inventory/
   quarantine/storage fault state with subject-valid coverage. W0 adds the safe
   evidence export for this; `input()` alone is prohibited. Unknowns retain known
   subtotals plus faults/counts, never a fabricated complete zero or headroom.

### Intake and the one-minute contract

- W2 follows the monthly #306 ledger by anchored byte/complete-line cursors,
  including UTC month rollover, and W3 follows changed explicit chat/queue/registry
  files. Native lifecycle/change notifications enqueue dirty sources; a bounded
  directory watcher catches closed/CLI sessions and metadata files. A debounced
  5-second safety wake stats only dirty sources/known ledger partitions. It does
  not stat/reparse every chat each minute. Missed/overflowed directory events
  enqueue a bounded inventory reconciliation and expose an inventory gap until
  repaired; new/renamed files must not disappear silently.
- Each worker turn reads <=256 KiB, emits <=256 rows, and yields after at most
  25 ms of its scheduling slice; work beyond a slice resumes from durable state.
  Files or lines over supported limits are partial with fixed faults, not skipped
  into completeness. Expensive work never happens on a Roles request.
- Set collection debounce <=5 seconds, publish at least every 10 seconds while
  dirty, and staleAfterMs = 60,000. Define the primary measured latency precisely:
  **start** = the worker's first observation of the appended bytes (watch event or
  stat), **end** = the active Roles client's acknowledgement of that generation
  ID after render. Require <=60 seconds and record the endpoints and sample
  count. A server push timestamp is only server-push latency, never client-visible
  proof. Fixed fixtures also measure writer append-complete to first observation
  and end-to-end <=60 seconds, so delayed detection cannot disappear from the
  requirement. If natural append-complete time is unavailable, label that limit
  rather than claiming it measured. An off-screen tab gets the latest cached
  generation on opening. At 60 seconds without valid observation/coverage, show
  stale; a new UI read cannot revive it. Fault and policy-only changes also
  invalidate the snapshot.
- The original transcript file and ledger can both describe a call. Use native
  provider+responseId when present and the #304 original/parent entry witnesses;
  retain explicit aliases and revision history. No time/model/amount join, no
  file-offset-as-call, no parent tool report, wait total or run subtotal charge.
  Ledger rows lacking a proved distinct attempt or actual model stay unresolved.
- #306 is lossy/best-effort and currently loses token presence. Its tail can make
  new numeric observations available quickly, but cannot alone certify complete
  all-Pi coverage. Persistent files repair recorded omissions. Fileless aggregate,
  missing-responseId, requested-model and unreported-failure gaps stay visible.
  W2 must not borrow Temper #129's conservative nulling as proof for Pi's
  ledger. For Temper Pi rows, any zero class becomes null and prevents an exact
  list quote; even a cold first call's cache-read 0 or a cache-write 0 is affected.
  Only an Ops-owned Pi producer change preserving absence versus reported zero
  can repair future evidence. O0 first measures the affected share; old rows
  remain partly unknown and are never retrospectively promoted to $0.

### Current week, history and rollover

Priority is **new current-week appends**, then current-week reconciliation, then
one bounded historical unit only when the current lane is caught up. #300's
`requests()` supplies hints, not permission to seek past unread input.

On a fresh install, replay the current week's retained ledger first and subscribe
to its tail immediately. Discover explicit files from supported session/queue
catalog metadata. Existing verified indices give current-window offsets; without
an index, W3 builds one by bounded sequential reads (all branches, no timestamp
sort assumption), projecting only numeric and parent metadata. Old occurrences
are durably staged, not published as historical reconciliation ahead of the
current week. A current-lane fork whose original parent is not indexed pulls
that parent's bounded window into the current lane. Copied entries remain
pending, excluded and flagged until the original is proved; neither count both
nor permanently drop the copies. Test a current-week fork of an unindexed parent.
If Temper pi-worker session files are host-visible, W3 classifies them as
**Temper-owned** and excludes them from Pi charging inventory so T0 owns them;
no host-visibility assumption creates a second charge. A file cannot be declared
current-week complete before this scan proves it; new usage is still surfaced
from the independent ledger tail while startup reconciliation is partial. Old
records do not acquire a new identity.

#304's window-mismatch boundary is real: consume successive <=169-hour windows
with the exact predecessor cursor, keep a stable numeric identity index, and
never mint an offset to jump a prefix. Current/history schedulers may use
separate native streams **only** when W0/W3 have durably specified their independent
cursor/feed lifetime and overlap mapping. Filtered windows are not native cursor
positions. Restoring the numeric index avoids replaying every original chat on
every restart; if an index cannot be proved, rebuild boundedly and mark partial.

Record current reconciliation per source as complete or terminal-with-explicit-gap;
a source with missing history cannot certify a full week, but must not starve
all history forever. Once each inventoried current source has that recorded
outcome and the live tail is caught up, historical work proceeds newest week
first, one <=256 KiB/256-row/25 ms unit at a time with immediate preemption by
new current work. Keep original occurrence, canonical task birth and event-time
parent through replay, clone, correction and reparent. History completion does
not advance today's watermark. Task lifetime totals stay partial until their
whole window has been reconciled; initiative/role default is the Pacific week.

Compute Monday from `pacificWeekStartUtc`, not a fixed seven-day UTC interval.
At the next Pacific Monday (and on startup, clock changes and resume), reevaluate
the current-week snapshot even if no call arrived. Independently, the tiny
main-thread age check rejects any snapshot whose weekStart is not the current
Pacific week; a blocked worker cannot display last week's number as current.
Previous-week evidence stays retained. A newly empty-looking week with missing coverage remains UNKNOWN, not
an automatic $2,000 of permission. Tests cover spring/fall DST and occurrence
versus observation on opposite sides of midnight/Monday.

### Budget scope and manual replacement

This plan changes **no** cap, exemption, permission or enforcement: Design's
own-work $2,000 Monday-Sunday Pacific scope stays; requested work and Team in
Temper remain exempt; there is no automatic pause, stop, debit or cap change.
The foundation also records an existing source-backed Architecture policy
(`dr-9f87e79c317d`); generic code must preserve that fact, not create, activate,
remove or borrow it. W4 binds only policy records approved for its release.

Owner record `dr-e108f47f8033` (Ops n82) supplies the task-based reporting rule:
a task under its department's budgeted initiative counts as own unless its
recorded requester is the owner or another role's question/request. A reply to
the department's own question is not a new requested-work exemption. An older
or unknown requester in a **verified** in-scope task counts as own; a missing
task, payer, event-time parent or source provenance is a different problem and
stays unknown allocation. Do not infer a request from approval, lead or title.
The current requester module still says display-only: W4 must explicitly review
and test the new read-only reporting interpretation against the owner record;
that label is not already an authenticated #293 root producer.

W4 may emit #293 funding only with a separately vetted native evidence binding.
It must not manufacture `DispatchRoot` records or register held Origin/R0/RTPI
capabilities. If the supported reporting evidence cannot satisfy that boundary,
it returns funding unavailable, ships observed figures truthfully, and names the
remaining authority-source gap. C0 cannot call that a complete automatic budget.
This is a gate, not permission to weaken #293 to obtain a number.

W7 initially shows **Automatic — recorded known list subtotal** with source
coverage/freshness/funding labels beside **Manual tally — stale/unverified
reference only** from unchanged `spend.json`. Exact decimal strings never flow
through legacy `projectSpend`'s Number/bar calculation. Unknown fields say UNKNOWN
or not sure; policy-free views say funding not evaluated. No green budget bar.
Requested/Team usage remains visible in initiative totals even when exempt.

C0 drops manual figures from the normal Roles display only after the measured
cut-over bar: (a) exact decimal agreement on all independently fixed known
pricing/duplicate/membership/funding cases, with **zero** mismatches; (b) every
planted unknown/stale/unpriced/unassigned case visibly labelled, with **zero**
false complete totals/remainders; (c) an installed dual-display observation over
24 hours, including restart and a synthetic Monday/DST proof, with all observed
new generations rendered <=60 seconds and no missed changed-source notice;
(d) Data's numeric reconciliation of supported known task slices, with manual
mismatches explained from numeric evidence, not silently fitted to the manual
number. A manual tally is not the oracle. Missing real evidence is not a pass.
No model calls are manufactured for observation. Partial historical sources can
stay labelled partial, but unresolved funding evidence blocks a claimed complete
budget replacement. G13 is another explicit admission gate: outside-task home
and ad-hoc usage is unassigned, so a role doing own work there cannot be certified
complete by counting only task usage. Ops recommends a separately reviewed
host-recorded numeric turn-origin producer (role-message kind, queue card,
schedule, owner message); owner turns stay unassigned until the owner sets their
rule. Counting every home turn as own overcounts requested work and is an
owner-only option, not selected here. Until supported origin evidence and its
reporting interpretation are delivered, retain the manual reference for affected
roles; C0 cannot certify those roles or claim full project replacement. This doc
requests no owner decision and does not queue that new producer. Files and their
stopped values remain untouched; rollback restores the manual reference display,
not spending permissions.

## Remaining gaps and owed results

| Gap | Accountable owner | Concrete result owed / delivery |
| --- | --- | --- |
| G1 principal and Temper key custody | **Security**, coordinated with Temper and Ops | S0 recorded agreement before T0 or any live-feed reader is queued: named read-only collector principal, auth transport, approved key storage/loading/rotation/revocation, network scope, opaque-cursor custody and no-secret diagnostics. `TEMPER_USAGE_FEED_KEYS` empty stays off; no key is created by this plan. |
| G2 production store and finite capacity | **Ops** | W0 paged collector/evidence API and measured resource envelope; W1 private single-writer durable I/O/index, crash recovery and capacity faults. More than 64 files / 10,000 rows / 16 MiB cannot silently truncate a week. |
| G3 Pi token-presence loss | **Ops** | Pi 0.87.1 coerces an absent value to 0 and later zero can overwrite positive counts: no Pi zero is provable (Data rm-809ae9d4, Temper rm-0af57cb5). #129 maps every Pi zero to null and Pi total is null unless all four exclusive classes are known; any such null prevents exact list pricing. W2/T0 preserve partly unknown figures, never $0. Optional O0 first measures the affected-row share and delivers the scoped future Pi producer repair option. #129 is not that repair; non-Pi reported-zero evidence keeps its own source rules. |
| G4 complete supported source inventory/verifier | **Ops**; **Security** reviews trust boundary | W2/W3 enumerate supported/missing paths and retained intervals, validate native IDs, aliases, task births and original event-time parents. A JSON trust label is not verification; inventory overflow/missing watcher events remain partial. |
| G5 fileless/aggregate/ACP provenance | **Ops** | W2 safely projects ledger calls and inherits explicit helper parents; W3 restores file numeric indices. Unreported failures, aggregate subattempts, unknown actual models and ACP without structured parent witness are enumerated exclusions, not inferred charges or free usage. Additional producer work requires its own approved plan if completion needs those sources. |
| G6 policy-backed allocation/payer | **Ops**, **Security** evidence review | W4 source-backed, event-time reporting policy/requester binding or explicit funding unavailable. No native root registration is implied. Scope and payer remain distinct from membership. |
| G7 Temper native feed and coverage | **Temper** | #125 failed its lock-wait gate (53 ms p95 versus 50 ms) and is being redesigned with an xid8 watermark. Owe the revised #125/#128 contract: route-issued opaque cursor, call-ID dedupe independent of seq, per-page complete_through/stalled, 409 after restore/reset, #126 bounded reconciliation/cutover and #127/#129 honest tokens. Legacy coverage stays partial. Ops proposes complete_through lag p95 <=60 seconds and max <=5 minutes; Temper's delivered acceptance must record actual results. T0/T1 consume that delivery, not the superseded after=<seq> route or event DB/full run API. |
| G8 pricing and reconciliation oracle | **Data** | Confirm #127 exclusive input/output/cache-read/cache-write/null/zero rules; T0 uses that existing rule and a source-backed versioned quote fixture. D0a delivers Pi known-slice reconciliation after R0 while D0b delivers Temper after T1; C0 consumes both. Temper's legacy unmarked cost never substitutes for Ops `quoteListUsd`. |
| G9 worker lifecycle/change following/snapshot | **Ops** | W5/W6 closed cache-only snapshot, durable incremental follow, current-first bounded reconciliation, Monday and stale reevaluation, deterministic liveness failure state. No tally LLM or per-chat polling. |
| G10 Roles DTO, honest display and replacement | **Ops** | W7 automatic-plus-manual view with protocol parity; R0/T1 installed receipts; C0 measured removal of manual display only. No spend file write. |
| G11 installed health prerequisite | **Ops** | #308 cause and passing installed big-chat COPY receipt for a build containing #306. #306 is live but its final acceptance remains blocked; the 18 naturally observed helpers/18 valid parents are recorded in Ops n268, not a replacement for health. R0 consumes this result; development tasks need not wait on it. |
| G12 Temper launch-origin attribution | **Temper** | Call rows currently have no task/project fields. Owe a separately specified source-backed launch-origin record linking native call ID to canonical original task birth and event-time project/initiative ancestry, plus capture/cutover/coverage semantics. T0/T1 cannot infer it from agent/model/time/run or a task label: until delivered those calls stay unassigned and cannot establish own-work headroom. Missing origin is not repaired by token counts or an opaque cursor. |
| G13 outside-task home/ad-hoc usage | **Ops**, **Security** provenance review | Outside-task usage is always unassigned today; task-only coverage cannot certify a role whose own work also runs at home. Before C0 admission owe a separately approved host-recorded numeric turn-origin producer and reviewed mapping for role-message kind/queue/schedule/owner origin, or retain the manual reference for affected roles and record replacement incomplete. Recommend the producer option; owner turns remain unassigned until the owner sets a rule. The alternative of counting all home usage as own overcounts requests and needs the owner's decision; no such decision is implied. This producer needs its own complete plan after its source boundary is specified, not invented task IDs or consent in this doc. |

**Temper route to consume, only after delivery:** the revised #128 named-key
numeric calls route, version `temper-usage-calls/1` unless its delivered contract
explicitly revises it; `TEMPER_USAGE_FEED_KEYS` empty = off. The route issues an
**opaque cursor**. Store/replay it byte-for-byte only after durable batch commit;
do not parse it, construct it from seq, or treat seq as commit order. Deduplicate
by native call ID, retaining revision/same-call witnesses. Every page supplies
`complete_through` and `stalled`; row arrival, request time and seq maxima are
not coverage. A 409 after restore/reset quarantines the old cursor, preserves
evidence and starts the delivered bounded reset/reconciliation handshake with
partial status, never a silent cursor-to-zero reset. Auth/off/gap/timeout leaves
the last good cursor intact. Exact route parameter/header/reset/envelope fields
are a required #128 delivery; do not guess a new query spelling here.

The page says **Temper figures complete through HH:MM** (with an explicit timezone
and date when needed). Show a visible **delayed** state when coverage lags more
than one minute or `stalled` is true. Track lack of actual complete_through
progress, including silence. When an enabled required feed has stalled for
**more than five minutes**, latch a deterministic dead-man alarm with a safe
fixed code and last valid complete-through; keep the UI delayed/unknown. Repeated
reads cannot reset its age. A cheap main-thread lifecycle age check (scalar
state only, no file/HTTP/parser work) must detect a blocked/dead worker as well
as a stalled route. Deduplicate alarms per stall episode and clear only on
verified coverage progress. Use the existing operational diagnostic channel;
this plan adds no unsolicited notification destination or permission. An
intentionally disabled/nonrequired feed is unavailable/off, not silently healthy
and not an enabled-feed alarm. Ops's proposed feed bar is coverage lag p95 <=60
seconds, max <=5 minutes; do not call that already accepted by Temper or let it
weaken the project's <=60-second append-to-visible test for newly recorded rows.

Temper amounts are diagnostics on their original basis; **Ops prices supported
exclusive tokens with `quoteListUsd` and a versioned rate source**. For Pi rows,
#129's zero-to-null rule makes any affected class partly unknown, not $0. There
are no task/project fields yet: missing G12 launch-origin stays unassigned.
Cross-Pi/Temper overlap needs an explicit native same-call map; otherwise report
unresolved overlap, never add both and claim complete deduplication.

## Parallel delivery and queue admission

Local IDs below are stable plan labels (including D0a/D0b), **not task numbers**. On queueing, Ops
(or the named department lead) substitutes actual queue references for local IDs
in `after`, retaining each `uses` explanation in the task plan. Every plan names
project `automatic-cost-accounting`. No invented task IDs are sent to queue_add.
External references are actual existing tasks. A removed/dropped prerequisite is
not evidence: a consumer verifies the named result before starting; if absent,
it blocks on the owing lead using queue_blocked.

- **Now, in parallel:** W0 (shared code groundwork) and S0 (Security review).
- **After W0:** W1 store, W2 ledger reader, W3 session/metadata intake, W5 subject
  snapshot can run together. W4 funding uses S0's evidence readback as well as W0.
- **After W5:** W7 page/protocol, while the source/store work continues.
- **After W1-W5:** W6 worker integration. **R0** consumes W6/W7 and #308 health,
  and installs the Pi-first automatic/manual view without a Temper credential.
- **Do not queue T0 before S0 is agreed.** Its complete plan is prepared below;
  it also consumes #128's revised opaque-cursor route, #129's conservative
  zero-to-null mapping, W0 and W4 evidence.
  It can then run alongside the Pi UI/release path. T1 consumes R0 and T0 and
  does the separate Temper integration/install. D0a reconciles Pi slices after
  R0 alongside T0/T1, while D0b reconciles Temper after T1. C0 consumes both
  independent results before removing manual display; G13 stays a separate
  admission gate, not an invented completed dependency. Optional O0 consumes the installed
  numeric evidence to measure the Pi token-presence loss before a producer repair
  is proposed; it is not required just to display honest partly unknown costs.

Shared existing test import guards are deliberately strict. W0 alone migrates
only their blanket no-import assertions into exact allowlists of the planned
runtime modules, with positive architecture tests rejecting every other importer.
It preserves numeric/privacy/unknown-value assertions and module purity. Do not
bypass the guards with alternate imports, dynamic strings or a skipped test.
W0 also owns collector paging changes and the narrow reviewed lock-helper
extraction; W1-W7 own the disjoint modules below. The snapshot builder is an
approved worker-side importer, never the main-thread cache. Positive graph tests
reject any direct or transitive collector/pi-sessions/membership/roles/funding/
store/source import from index.ts, roles-overview.ts, protocol.ts or that cache.
Small integration call sites are assigned only to W6 and W7. Any extension of
these ownership lists requires a coordinated plan change before editing.

Each implementation task follows the same completion discipline: own `wt new`,
claim its paths, write its hypothesis before edits, test fixed units once after
implementation, sealed build when required, detached `wt land`, await its normal
receipt, record HIT/MISS and undo. No implementation task silently installs.
Release tasks list only `pi-web-ui repo` and `pi-web-deploy` touches: the installer
serializes itself; a restart is not an exclusive queue resource. Module overlap
is prevented by ownership and genuine result edges, not artificial global locks.

### Ready task plans

Each fenced block is machine-readable queue-plan data. The seven text fields
are `title`, `goal`, `done_when`, `decided`, `steps`, `verify`, `must_not`.
`queue`, `lead`, `project`, `touches`, `after`, `uses` and `owns` are additional
routing, admission and ownership metadata. In particular, `uses` explains every
edge rather than relying on list order. Security and Data work remains theirs;
Ops does not change their engine, credential or grading modules.

```usage-task
{
  "id": "W0",
  "queue": "ops",
  "lead": "ops",
  "project": "automatic-cost-accounting",
  "title": "Automatic costs: production-safe collector seams and paging groundwork",
  "goal": "Make the frozen collector safe to consume in one bounded worker, with paged recovery, scalable current-week evidence and an explicit closed snapshot seam, before independent adapters are wired.",
  "done_when": "Collector replay yields between bounded pages, fault-bearing evidence and usage-meter-snapshot/1 types plus measured finite Worker limits are landed, the reviewed role-message-guard lock helper is narrowly extracted, exact worker-only importer guards reject transitive main-thread engine imports, and large fixed cases preserve numeric/crash outcomes.",
  "decided": "Lead Ops. Consume the #309 reviewed plan and existing #293/#300/#301/#302/#304/#305/#307 contracts. Preserve exact public outputs and per-batch bounds; add a paged CollectorIO path with backward-compatible legacy injected I/O. Keep all expensive recovery in the worker. Resource limits are operational bounds, never budget caps. No root authority or runtime starts here.",
  "steps": "1. Write H-WIRE-0 from the 16 MiB/10000-row/64-source limits and importer guards. 2. Add server/usage-accounting-meter-contract.ts for closed worker messages, anchored file and opaque feed cursor/index checkpoint metadata, fault-bearing subject evidence, cache generation, source complete_through/stalled/last-progress/alarm status and bounded operational limits. 3. Extend usage-accounting-collector.ts with paged yielding replay and safe evidence export; keep append/sync/checkpoint ordering, revisions, quarantine and source proofs unchanged. Keep current numeric state finitely bounded; page cold history, never load a whole journal string. 4. Preserve the old fixed oracle and add synthetic >10000-row, >64-source and >16 MiB recovery cases; measure a 100000-attempt current week and document finite memory plus update timing. Capacity rejection must be durable/UNKNOWN, not data loss. Document finite Worker resourceLimits plus accepted worker heap and process RSS bounds, and the main-thread fs-callback latency baseline/envelope under meter load. 5. Migrate the listed guards to exact worker-side importers; a positive transitive graph test rejects collector/pi-sessions/membership/roles/funding/store/sources/snapshot-builder from index.ts, roles-overview.ts, protocol.ts and the tiny cache. Preserve all privacy/money assertions. 6. Narrowly extract the reviewed role-message-guard-host.ts lock code into role-message-guard-lock.ts for reuse without behavior changes, retaining ext4 device/inode/pid and live-owner protections; run its unchanged regressions. 7. Land detached normally, no install.",
  "verify": "Sealed stage tests compare all legacy collector/reader/membership outputs, crash-prefix/cursor recovery and fault propagation; larger numeric fixtures prove no truncation and bounded allocation/yields. Fixed current-week update publication budget is below 30 seconds in the worker and measured memory is within the documented finite bound. Guard mutations adding direct or transitive main-thread engine imports fail. Reviewed lock regressions remain unchanged, including ext4 inode reuse with a different pid and no live-lock theft. Resource-limit termination yields stale/unavailable while the host remains healthy. Record main fs-callback latency, worker heap/RSS limits and actual numbers. Normal land checks pass; record HIT/MISS and revert path.",
  "must_not": "No live reads, timer, service import, install, weakened numeric test, payload retention, blind limit increase, journal deletion, spend file change, fabricated root, pause, stop or cap change.",
  "touches": ["pi-web-ui repo"],
  "after": ["ops #309"],
  "uses": {"ops #309": "Landed, Architecture-reviewed runtime shape and exclusive ownership plan."},
  "owns": ["server/usage-accounting-meter-contract.ts", "server/usage-accounting-collector.ts", "server/role-message-guard-lock.ts", "server/role-message-guard-host.ts (lock helper extraction only)", "tests/unit/usage-accounting-meter-contract.test.ts", "tests/unit/usage-accounting-collector.test.ts", "tests/unit/usage-accounting-pi-sessions.test.ts (import guard only)", "tests/unit/usage-accounting-membership.test.ts (import guard only)", "docs/usage-accounting-meter-contract.md"]
}
```

```usage-task
{
  "id": "S0",
  "queue": "security",
  "lead": "security",
  "project": "automatic-cost-accounting",
  "title": "Automatic costs: agree collector principal, evidence trust and feed key custody",
  "goal": "Give the live meter a reviewed least-privilege reporting identity and credential/evidence boundary before any task that reads the Temper feed is queued.",
  "done_when": "Security records an explicit agreement or refusal for the named collector principal, native Pi/task/requester evidence sources, Temper auth and network scope, key custody/rotation/revocation and redacted diagnostics; Ops has a self-contained admission result naming exactly what can be queued.",
  "decided": "Lead Security. Review the worker running as pi-web-ui's existing service user for read-only supported sources, separate from held Origin/R0/RTPI authority. Temper owns TEMPER_USAGE_FEED_KEYS and its route. Use the project's existing protected credential mechanism, never a new ad-hoc secret file or browser credential. Empty key list means off. Agreement is security review, not owner activation or spending approval.",
  "steps": "1. Read the reviewed wiring plan and Temper #128's declared auth design when delivered. 2. Check the proposed same-user worker principal and numeric-only path/grant inventory against the actual supported metadata sources; document same-UID limitations honestly. 3. Review the read-only reporting interpretation of dr-e108f47f8033 and the independent task/payer witnesses, without treating a display label as authenticated root evidence. 4. Agree the exact named principal, protected key load path, rotation/revoke owner, loopback or approved protected transport, no key in URLs/logs/snapshots and failures retaining cursors. 5. Record pass/refusal and the exact owed remediation; send Ops and Temper one bounded result. Land only the review note by normal checks if using the repo.",
  "verify": "Review uses fixed numeric/auth fixtures and source metadata, not a live feed request or model call. The note contains no credential and distinguishes review from activation. Admission checklist proves the browser cannot obtain the feed key and an off/unauthorized feed cannot advance a cursor. Normal doc landing receipt is recorded.",
  "must_not": "Do not create or rotate a key, read chats or private role folders, activate a feed, register held roots, relax authentication, publish access, change permissions or claim owner approval.",
  "touches": ["pi-web-ui repo"],
  "after": ["ops #309"],
  "uses": {"ops #309": "Reviewed process, data boundary, policy provenance and proposed source/key custody package."},
  "owns": ["docs/usage-accounting-security.md"]
}
```

```usage-task
{
  "id": "W1",
  "queue": "ops",
  "lead": "ops",
  "project": "automatic-cost-accounting",
  "title": "Automatic costs: private durable collector store and numeric indices",
  "goal": "Provide the production CollectorIO and durable numeric cursor/index implementation without losing evidence, blocking the server, or making restart rescan every chat.",
  "done_when": "The new store implements W0's paged I/O and numeric-index seam with lifetime single-writer exclusion, 0700/0600 protections, durable journal-before-cursor ordering and evidence-preserving recovery; adversarial filesystem and crash cases pass in temporary directories.",
  "decided": "Lead Ops. All state is under dataDir/usage-accounting, separate from usage-ledger and manual spend. Fixed consecutive journal segment filenames, expected-length append checks, exclusive create, file plus directory fsync and atomic checkpoint replacement are mandatory. Reuse W0's reviewed role-message-guard lock helper, not a new lock algorithm. Live deploy overlap stays waiting for previous writer/stale and never steals the lock. Versioned store header is mandatory: older builds refuse newer majors; migration keeps a compatible copy first. Numeric indices are derived caches, not authority. No pruning, automatic repair or whole-file reads.",
  "steps": "1. Write H-WIRE-1 from #300's missing durable I/O and W0's delivered page bounds. 2. Implement server/usage-accounting-store.ts with bounded worker-local readSync, no-follow path validation, W0's reviewed lock helper and explicit waiting-for-previous-writer state, segment CAS append/sync and scratch/fsync/rename/directory checkpoint. Keep hashing worker-local and any async pool operations serialized to at most one outstanding. 3. Persist numeric attempt/alias/ancestry, source-offset and occurrence-week indices; on mismatch rebuild from numeric journal pages, keeping gaps visible. 4. Inject failures at append, sync, rename and reopen; preserve torn/corrupt bytes and fixed fault receipts. 5. Add finite disk/work/memory accounting, versioned header and capacity alarms without deleting history. Before a store-major migration keep a compatible copy; rollback stops the writer and restores that copy or leaves the older meter unavailable, never silently downgrades newer evidence. 6. Land the module/test/doc through the normal detached gate, no install.",
  "verify": "Temporary-directory tests cover symlinks/hardlinks, reviewed ext4 inode/pid cases, live deploy overlap waiting without lock theft, permission failure, short writes, torn tail, corrupt checkpoint, full frame corruption, reordered recovery and exactly-once replay. Newer store majors are refused by old readers; migration/rollback keeps the old copy and never mutates a newer store in place. Cursor never exceeds durable validated data, unknown remains unknown, original evidence survives. Large paged recovery obeys W0's measured limits and normal land checks pass.",
  "must_not": "No source discovery, live directory scan, real chat read, model/network call, scheduler, service install, evidence deletion, spend write or automatic stop.",
  "touches": ["pi-web-ui repo"],
  "after": ["W0"],
  "uses": {"W0": "Paged CollectorIO, numeric index/checkpoint generation contract, measured resource bounds and the reused reviewed role-message-guard lock helper."},
  "owns": ["server/usage-accounting-store.ts", "tests/unit/usage-accounting-store.test.ts", "docs/usage-accounting-store.md"]
}
```

```usage-task
{
  "id": "W2",
  "queue": "ops",
  "lead": "ops",
  "project": "automatic-cost-accounting",
  "title": "Automatic costs: bounded ledger tail and conservative side-call evidence",
  "goal": "Read #306's newly appended numeric ledger records incrementally so persistent chats, helpers and app side calls become timely evidence without double counting transcripts or upgrading missing provenance.",
  "done_when": "A standalone ledger adapter consumes explicit monthly files through durable anchored cursors, emits closed W0 numeric batches and helper-parent metadata, labels missing attempt/model/token-presence/coverage evidence, and passes rollover, overlap, crash and privacy fixtures.",
  "decided": "Lead Ops. The input is usage-ledger/1, not SDK events or transcripts. Present positive recorded cost with proved model may retain the documented pi-recorded-1 estimate basis, separately labelled rather than an exact token quote; requested model is not actual. Use native provider/responseId maps where proved. A byte offset identifies an observation only, never an independent charge. Pi 0.87.1 value-or-zero and later-zero overwrites destroy zero provenance: every Pi zero class is unknown, total null unless all four classes are known, and affected calls cannot be repriced exactly or treated as free.",
  "steps": "1. Write H-WIRE-2 from the ledger's missing importer and best-effort gaps. 2. Add server/usage-accounting-ledger-source.ts with explicit safe files, <=256 KiB reads, complete-line anchors, UTC month rollover and injected last committed cursors. 3. Project only ledger allowlist fields and preserve first native observations; use a supported same-call witness for aliases to #304, otherwise retain unresolved overlap. 4. Supply time-valid conversation/session/parent metadata for #305; app origin remains unassigned. 5. Emit fixed coverage faults for disabled/skipped/unprovable production, unknown actual model, missing response identity, aggregate calls and legacy token presence, including all zero classes rather than cache alone; expose only numeric affected-row counters for optional O0. 6. Add sealed numeric fixtures and land detached; no runtime importer starts here.",
  "verify": "Fixed main/helper/app/cache/compaction cases, responseId transcript overlap, null IDs, requested model, default cache zeros, torn lines, permission failure, month rollover, cursor-anchor change and replay produce exact facts/faults. Planted content/extra fields never leave the adapter. Test batch assignability and the unchanged #300 acceptance after W0. Normal gate passes.",
  "must_not": "No chat scan, producer hook change, invented native call ID, timestamp/amount match, aggregate-as-leaf charge, current-rate backpricing, false complete coverage, install or budget behavior.",
  "touches": ["pi-web-ui repo"],
  "after": ["W0"],
  "uses": {"W0": "Numeric source/index/cursor envelope, fault merge contract and allowed importer seam."},
  "owns": ["server/usage-accounting-ledger-source.ts", "tests/unit/usage-accounting-ledger-source.test.ts", "docs/usage-accounting-ledger-source.md"]
}
```

```usage-task
{
  "id": "W3",
  "queue": "ops",
  "lead": "ops",
  "project": "automatic-cost-accounting",
  "title": "Automatic costs: changed-session and canonical membership source adapter",
  "goal": "Follow changed supported Pi files and canonical task/registry metadata through bounded pages, preserving original ancestry and event-time links without rescanning every chat or reading content into the server path.",
  "done_when": "A source adapter builds and restores durable numeric occurrence/identity/parent indices, feeds #304 and #305 bounded explicit inputs, emits a complete required-source inventory including gaps, and handles changed/new/renamed files plus missed watcher events without false completeness.",
  "decided": "Lead Ops. Sources are approved session catalog paths, native queue custom-entry metadata, work registry sequence history and explicit helper witnesses. Use original add and event-time parents, never assignment time/latest link/title/prose. Parent/original numeric evidence precedes copies across scheduling lanes. A current fork of an unindexed parent promotes the parent's bounded window into the current lane; copied entries stay pending/excluded/flagged until proved. Host-visible Temper pi-worker files are Temper-owned and excluded from Pi charging so T0 owns them. The existing #304 window-mismatch and #305 page limits remain real; W0 supplies continuation, not permission to skip data.",
  "steps": "1. Write H-WIRE-3 from missing native paging/index/discovery. 2. Add server/usage-accounting-pi-source.ts around the landed #304/#305 pure APIs with source-side allowlists and regular-file/root checks. 3. Build a durable numeric index by bounded sequential windows, stage old occurrences while completing current reconciliation, and restore the index from committed numeric state on restart. Handle >64 total sessions through bounded complete page inventories, not silent source omission or clearing #305 gaps. 4. Consume native dirty notifications and directory events; reconcile inventory boundedly after watcher overflow or file identity changes. 5. Preserve task birth, registry seq, reparent times, fork/resume/helper edges and source gaps; promote an unindexed original parent's bounded window into the current lane before admitting current fork copies. Classify host-visible Temper pi-worker sessions as Temper-owned, excluding them from Pi charging with an explicit coverage owner. ACP without a structured witness remains unsupported. 6. Test and land the exclusive module/test/doc, no live scan or install.",
  "verify": "Synthetic current-plus-old files, out-of-window cursor boundaries, >64 sessions, >10000 metadata events, a current-week fork of an unindexed parent, restart index hydration, rejected reparent edits, missing registry sequence, watcher overflow/new file, truncation and changing anchors are fixed cases. Parent promotion is bounded; copies stay excluded/pending until proved, then count once. Host-visible Temper sessions never charge again beside T0 rows. No full-file synchronous read occurs; per-unit bytes/rows/time stay bounded. Throwing payload properties/planted content prove allowlist isolation. Normal gate passes.",
  "must_not": "No heuristic task/role assignment, global current-state backfill, prefix-skipping cursor, all-chat minute polling, transcript content output, live source read during development, held root, install or budget write.",
  "touches": ["pi-web-ui repo"],
  "after": ["W0"],
  "uses": {"W0": "Paged native metadata/index continuation, complete inventory representation and narrow importer guard migration."},
  "owns": ["server/usage-accounting-pi-source.ts", "tests/unit/usage-accounting-pi-source.test.ts", "docs/usage-accounting-pi-source.md"]
}
```

```usage-task
{
  "id": "W4",
  "queue": "ops",
  "lead": "ops",
  "project": "automatic-cost-accounting",
  "title": "Automatic costs: source-backed reporting funding and requester policy binding",
  "goal": "Apply the owner's existing own-initiative/requested-work reporting rule only to independently verified task and payer evidence, while preserving unknown allocation and all existing permissions.",
  "done_when": "A pure reporting funding adapter validates source-backed policy records and native task/requester/payer witnesses, returns supported allocations or explicit unavailable reasons, and matches exact own/requested/reply/legacy/Team/unknown fixtures without registering authority or manufacturing roots.",
  "decided": "Lead Ops. Use dr-e108f47f8033, existing source-backed policy refs and S0's reviewed evidence boundary. Design own-work remains USD 2000 Pacific-week; generic policy support does not add a cap. Unknown requester within a verified in-scope task defaults own per the recorded rule; missing task/payer/parent provenance does not. A role reply is not a request exemption. TaskRequester v1 was display-only and needs explicit reporting validation, not silent authority promotion.",
  "steps": "1. Write H-WIRE-4 and read the canonical approved decision plus S0 readback. 2. Add server/usage-accounting-funding.ts using only W0 closed evidence, actual original task/add snapshots, requester v1 records and independently supported payer/policy witnesses. 3. Keep eligibility separate from usage/membership; all initiative costs remain visible, requested and Team are separately exempt. 4. Adapt to #293 allocations only when vetted native root evidence exists; otherwise return funding unavailable with a concrete gap, not a forged DispatchRoot. 5. Test old requester absence versus missing binding, owner and peer requests, own-role replies, multiple/mixed inputs, reparent and Monday/DST. 6. Land detached and report any unresolved authority-source result to Ops before C0 admission.",
  "verify": "Fixed USD 0.1 own + 0.2 requested + 0.3 Team yields observed 0.6, supported eligible 0.1 and exempt 0.5 only with complete independent evidence. Missing payer/root/coverage yields null remainder, not USD 2000. Cross-role policy, wrong task birth, reply-only exemption and current-parent substitution fail. No capability/root registry changes appear in the diff; normal gate passes.",
  "must_not": "No new budget policy, cap change, foreign spend read/write, request inference from prose/approval, borrowed Design policy, fabricated root, R0/RTPI registration, permission, debit, pause or stop.",
  "touches": ["pi-web-ui repo"],
  "after": ["W0", "S0"],
  "uses": {"W0": "Closed independent membership/payer/policy evidence seam.", "S0": "Security's supported reporting evidence and principal readback, not root activation."},
  "owns": ["server/usage-accounting-funding.ts", "tests/unit/usage-accounting-funding.test.ts", "docs/usage-accounting-funding.md"]
}
```

```usage-task
{
  "id": "W5",
  "queue": "ops",
  "lead": "ops",
  "project": "automatic-cost-accounting",
  "title": "Automatic costs: subject-scoped snapshot bridge with collector faults",
  "goal": "Build the bounded page snapshot from all verified subject evidence without reusing global totals, dropping collector faults, hiding exempt usage, or requiring a budget policy for ordinary observed costs.",
  "done_when": "A worker-only pure snapshot builder produces the closed per-subject DTO with exact values, independent bindings, faults and UNKNOWN remainder; a separate tiny main-thread cache imports only meter-contract types and exposes its validated DTO/getter without loading the accounting engine.",
  "decided": "Lead Ops. Consume W0's fault-bearing numeric evidence and #302/#307 projections. Null source/policy is unavailable, never a fabricated policy or zero. Role/task/initiative views overlap and are not additive. Role observed usage is source-attributed own and requested mixed. Builder server/usage-accounting-snapshot.ts is worker-only. Separate server/usage-accounting-meter-cache.ts imports only W0 meter-contract types; it validates/ages the closed DTO and performs no filesystem or accounting work. Main-thread module graphs cannot import the builder or engine.",
  "steps": "1. Write H-WIRE-5 from the unsafe input()-alone and global-report failure modes. 2. Add server/usage-accounting-snapshot.ts with explicit subject partitions and independent per-fact role witnesses; preserve all subject leaves, required coverage and nonadditive reconciliation. 3. Use projectObservedUsage for policy-free totals and projectUsageCost only for complete supported policy context, merging all collector/storage/quarantine faults. 4. Build bounded DTOs, safe counts and oldest covered/observed timestamps in the worker builder. Put only message validation, DTO replacement, scalar age/weekStart invalidation and the Roles getter in a separate usage-accounting-meter-cache.ts importing only W0 meter-contract types; do not re-export the builder from the cache. 5. Include initiative requested/Team costs and task lifetime windows; keep private audit links out of public path/fault fields. 6. Land fixed fixtures and normal gate, no runtime start.",
  "verify": "Synthetic cross-role/global/missing binding, task birth, reparent, policy absence, zero versus unpriced, stale reread, collector corruption/quarantine/capacity and mixed initiative cases assert exact DTOs. A deliberate omission of any collector fault must fail. Public DTO contains no stream IDs, file paths, raw errors, roots or credential. Cache getter test asserts zero filesystem access and a pure types-only dependency graph. A planted transitive import of the snapshot builder or any accounting engine module from cache/Roles/protocol/index fails W0's positive graph guard. Week mismatch instantly marks stale even when the worker is blocked. Normal gate passes.",
  "must_not": "No real source reads, timer, production collection, budget inference, global report per role, unsupported project subject, amount through Number/bar logic, spend file write, install or permission change.",
  "touches": ["pi-web-ui repo"],
  "after": ["W0"],
  "uses": {"W0": "Stable fault-bearing evidence export, closed snapshot schema and finite DTO bounds."},
  "owns": ["server/usage-accounting-snapshot.ts (worker-only builder)", "server/usage-accounting-meter-cache.ts (types-only main cache)", "tests/unit/usage-accounting-snapshot.test.ts", "docs/usage-accounting-snapshot.md"]
}
```

```usage-task
{
  "id": "W6",
  "queue": "ops",
  "lead": "ops",
  "project": "automatic-cost-accounting",
  "title": "Automatic costs: worker follower, current-first reconciliation and lifecycle",
  "goal": "Connect the tested Pi adapters, store, verifier, funding and snapshot in one isolated worker that follows new usage within one minute while current-week reconciliation preempts bounded history.",
  "done_when": "The worker and single app lifecycle hook are landed with durable source-follow, explicit inventory/verifier, restart recovery, current-first history scheduling, Pacific Monday and stale reevaluation, bounded validated snapshot publishing, and no synchronous whole-file work on the server thread.",
  "decided": "Lead Ops. Reuse W1-W5, not a second accounting engine. Worker owns all parsing/hash/replay/projection; main imports only the tiny types-only cache, never the builder/engine. Use W0's finite Worker resourceLimits; worker-local bounded readSync/hash avoids the shared libuv pool, with at most one other outstanding pool operation. Collection wake <=5 seconds, publishing <=10 seconds while dirty, staleAfterMs 60000. <=256 KiB/256 rows per unit and <=25 ms scheduler slices. No all-chat polling, no watcher heartbeat as coverage, no live Temper credential in this Pi-first task.",
  "steps": "1. Write H-WIRE-6 and integrate usage-accounting-worker.ts through one small named startup/shutdown/message function in server/index.ts so it rebases independently around #308. Start a Worker with W0's measured resourceLimits; never import the worker builder into index. Worker-local bounded readSync/hash and at most one outstanding pool operation protect the shared threadpool. 2. Open the vetted numeric store, recover collector/index state and enumerate all supported and missing feeds before certifying coverage. 3. Follow ledger append and dirty-file notifications; prioritize new current work, then current reconciliation, then one preemptible historical unit. Record complete or explicit terminal-gap current outcomes so an unrepairable source does not starve history. 4. Reevaluate at the next Pacific Monday and after startup/resume/clock change; stale snapshots remain stale after worker exit or blocked I/O. Add the cheap main-thread scalar lifecycle age check for worker silence, latched diagnostics and immediate stale on weekStart mismatch with the current Pacific week; no parsing, filesystem, engine import or network work in that check. 5. Publish bounded validated generations from the worker builder into the separate W5 cache; carry first-appended-byte observation time and generation ID for client acknowledgements. Worker exit/resource-limit failure leaves stale/unavailable state and cannot fail chats; ordinary stop/switch semantics stay unrelated to budgets. 6. Stage-test and land detached, no install.",
  "verify": "Use temp-only synthetic 100000-attempt week plus historical backlog, watcher loss, duplicate ledger/transcript, crash/restart and blocked I/O. First appended-byte observation to cache <=30 seconds leaves <=30 seconds to actual client generation-ID acknowledgement; fixed inputs also measure append-complete/detection separately. Current fork of an unindexed parent promotes its bounded original window; pending copies cannot charge. Every history unit is preemptible. Monday/DST with a blocked worker makes main cache stale immediately by weekStart. Measure main-thread fs-callback latency under meter load against W0's baseline/envelope, alongside event-loop p99 <=20 ms and worker heap/RSS bounds. Resource-limit termination leaves the server healthy; no engine import or whole-file sync source read occurs on the main path. Normal build/land checks pass.",
  "must_not": "No real chat test, live scan, full history on startup thread, model tally, provider call, producer/root activation, spend mutation, feed key creation, automatic cap/stop/pause, install or restart.",
  "touches": ["pi-web-ui repo"],
  "after": ["W1", "W2", "W3", "W4", "W5"],
  "uses": {"W1": "Durable paged store and numeric index recovery.", "W2": "Safe ledger tail and native overlap/helper evidence.", "W3": "Explicit changed-file inventory, metadata pages and preserved ancestry.", "W4": "Supported reporting funding result or explicit funding-unavailable outcome.", "W5": "Subject snapshot builder/cache and collector-fault propagation."},
  "owns": ["server/usage-accounting-worker.ts", "server/index.ts (meter lifecycle hook only)", "tests/unit/usage-accounting-worker.test.ts", "docs/usage-accounting-worker.md"]
}
```

```usage-task
{
  "id": "W7",
  "queue": "ops",
  "lead": "ops",
  "project": "automatic-cost-accounting",
  "title": "Automatic costs: Roles automatic and manual figures with honest freshness",
  "goal": "Show the new cached automatic figures next to unchanged manual references, preserving exact money, explicit unknowns, source freshness and the current Roles layout.",
  "done_when": "Roles snapshot/protocol and all useful/panel/exact consumers render labelled automatic known list subtotals, separate bases, coverage/funding/counts/timestamps and manual references; no unknown becomes zero or a safety bar, and complete, partial, unavailable and old-server compatibility cases pass.",
  "decided": "Lead Ops. Follow docs/usage-accounting-roles.md's exact minimal plan. Keep readRoleSpend and server/roles-spend.ts unchanged; add optional automatic DTO via the existing protocol export path. Do not pass automatic decimals through projectSpend. No manual figure removal until C0. Initiative totals in the adapter include exemptions; this task does not redesign another page.",
  "steps": "1. Write H-WIRE-7 from manual-only Roles and exact-decimal/unknown display risks. 2. Add a per-role read from W5's types-only usage-accounting-meter-cache.ts in roles-overview.ts, never from its worker snapshot builder. Claim server/protocol.ts and web/src/types.ts, extend the closed optional DTO/generation acknowledgement through the existing protocol path and preserve spend unchanged. 3. Add guarded automatic consumption to roles-useful-model.ts, roles-panel-model.ts and roles-exact-model.ts; use neutral text in roles-exact-view.ts without changing card geometry. 4. Label recorded known list subtotal, manual stale/unverified reference, funding not evaluated or UNKNOWN remainder, age/as-of and separate bases; support Temper figures complete through HH:MM with timezone, delayed and dead-man alarm states without pretending row arrival is coverage. 5. Record the active client's post-render generation-ID acknowledgement over the existing read/view transport and expose its numeric timing for passive verification; a push time alone is labelled server-push latency, not rendered proof. Add one dedicated synthetic protocol/projection/browser-view test file and land detached after a sealed build. No install in this task.",
  "verify": "Exact string values at 12 decimals, known zero, null counts, unpriced, stale old watermark, collector gap, wrong role, no policy and complete evidence render correctly without green balance or inferred allowance. Protocol parity, old snapshots and first-observation-to-client-ack generation IDs pass; model/view tests assert manual fallback, no basis addition and week mismatch stale. Import-graph mutation pulling the builder/engine into the cache or Roles/protocol fails. Normal build and land checks pass.",
  "must_not": "No source scan, journal read on page path, manual parser/spend/stopped write, page redesign, automatic enforcement, hidden unknown, borrowed policy, manual-display removal, install or browser interaction with real chats.",
  "touches": ["pi-web-ui repo"],
  "after": ["W5"],
  "uses": {"W5": "Closed role-scoped DTO and separate types-only main-thread cache getter; the numeric builder stays worker-only."},
  "owns": ["server/roles-overview.ts (automatic cache read only)", "server/protocol.ts (automatic DTO only)", "web/src/types.ts (existing protocol export path)", "web/src/roles-useful-model.ts", "web/src/roles-panel-model.ts", "web/src/roles-exact-model.ts", "web/src/roles-exact-view.ts", "tests/unit/usage-accounting-roles-wiring.test.ts", "docs/usage-accounting-roles-wiring.md"]
}
```

```usage-task
{
  "id": "R0",
  "queue": "ops",
  "lead": "ops",
  "project": "automatic-cost-accounting",
  "title": "Automatic costs: install Pi-first meter and verify live Roles look-only",
  "goal": "Deliver the tested Pi automatic/manual display through the normal installer with measured freshness and installed health, before adding a Temper feed credential.",
  "done_when": "The Pi worker/UI passes pi-web-deploy dry-run/install checks, look-only Roles confirms labels/unknowns/as-of, passive first-byte-observation to client generation-ack latency and current/history behavior have receipts, and installed worker heap/process RSS meet W0's bounds.",
  "decided": "Lead Ops. Consume #308's cause and passing installed big-chat-copy result and W6/W7 builds. Check what is running/waiting before pi-web-deploy; deploy immediately through its serialized queue, never manual restart. No Temper key, live model probe or fabricated usage. Read only numeric status/counts and the requested Roles page, not transcript contents.",
  "steps": "1. Verify consumed commits and #308 receipt, preserving the earlier #306 failed health receipts. 2. Write H-WIRE-R0 and read the pi-web-ui-live-look procedure. 3. Run pi-web-deploy dry-run for the landed result, then the separate pi-web-deploy install step with reason; await pi-web-deploy result from a stable folder and read actual check outcomes, not exit code alone. 4. Take a look-only Roles check through permitted browser tooling and capture labels/timestamps/layout; do not open, send to or alter a chat. 5. Passively record first-byte observation and actual client generation-ID acknowledgement for <=60-second visibility; label push-only timings honestly and any unavailable natural append-complete time. Check installed worker heap and process RSS against W0's documented bounds, current-first progress, fs-callback latency and week-mismatch stale with numeric metrics only; manufacture no model event. 6. Record HIT/MISS and rollback to prior build through pi-web-deploy if health fails; land only the release receipt doc.",
  "verify": "All ordinary deploy health checks including big-chat COPY pass on the installed build. Each observed numeric generation is client-acknowledged within 60 seconds of first appended-byte observation, with endpoints/sample count recorded; fixed append-complete/detection/end-to-end proof remains separate. Installed worker heap and process RSS meet W0's bounds. No stale watermark is refreshed by a read; incomplete/unassigned/unpriced rows are labelled, manual reference stays separate and geometry is intact. Missing natural evidence is recorded as pending, not a fabricated pass; use queue_wait for the passive observation rather than polling.",
  "must_not": "No live chat action, content/model payload read, model probe, timer outside approved worker, key creation, Temper activation, manual tally write, cap change, root registration or manual restart.",
  "touches": ["pi-web-ui repo", "pi-web-deploy"],
  "after": ["W6", "W7", "ops #308"],
  "uses": {"W6": "Landed and stage-tested Pi worker lifecycle and source follower.", "W7": "Landed automatic-plus-manual Roles rendering.", "ops #308": "Cause and passing installed big-chat health receipt; not an ordering preference."},
  "owns": ["docs/usage-accounting-pi-release.md"]
}
```

```usage-task
{
  "id": "T0",
  "queue": "ops",
  "lead": "ops",
  "project": "automatic-cost-accounting",
  "title": "Automatic costs: approved Temper cursor feed adapter and list quotes",
  "goal": "Consume only Temper's delivered named-key numeric route with opaque durable cursors, call-ID dedupe, page coverage and honest list pricing, after Security has agreed the principal and key custody.",
  "done_when": "An inert Temper source adapter matches revised #128's opaque-cursor/version/auth/409 contract and #129/#127 token rules, prices only fully known supported exclusive classes with quoteListUsd, and passes dedupe, coverage, delay/alarm, restore/reset, overlap, off/auth-failure and unknown-price tests without reading a live feed.",
  "decided": "Lead Ops. Queue admission requires S0 agreement first, not merely an after edge. Consume revised #128's delivered numeric calls route, opaque cursor, per-page complete_through/stalled and 409 on restore/reset, with named TEMPER_USAGE_FEED_KEYS; empty stays off. Seq is not commit order; dedupe native call IDs. Temper #125 failed 53 ms versus 50 ms lock-wait p95 and is being redesigned with xid8. Ops prices with versioned list quotes, not legacy cost. For Pi every zero is null and total null unless all four classes are known; non-Pi genuine zero needs its own evidence. No task/project fields exist yet; G12 stays unassigned.",
  "steps": "1. Verify S0 agreement and revised #128/#129 artifacts before queueing/starting; write H-WIRE-T0. 2. Add server/usage-accounting-temper-source.ts with injected HTTP/key loader, bounded requests/pages/timeout and closed validation of issued opaque cursors, call IDs and complete_through/stalled. Preserve the cursor bytes without decoding or reconstructing from seq. 3. Build numeric facts from original call IDs/occurrence/provider/model/exclusive nullable tokens; quoteListUsd uses a source-backed versioned rate table only when every required class is known. Pi zero-to-null makes any affected call partly unknown, never USD 0. 4. Preserve explicit Pi same-call aliases and revisions; absent launch-origin means unassigned task/project, and legacy history stays partial. 5. Commit page evidence before its opaque cursor receipt; off/401/403/timeout retains the last cursor. On 409 preserve/quarantine old cursor and use only the delivered bounded reset/reconciliation handshake with unknown coverage; never silently reset. 6. Add a pure coverage-lag/stall evaluator: delayed above 60 seconds or stalled, latched deduplicated dead-man alarm after more than 5 minutes without coverage progress, and actual-progress-only recovery. Stage-test and land detached, no live request/install.",
  "verify": "Known supported token/rate cases exactly match USD; Pi cacheRead 0, cacheWrite 0, value-or-zero absence and later-zero overwrite all remain null/unpriceable, with total null unless all four classes are known. Genuine non-Pi zero requires source evidence. Out-of-order seq commits, call-ID replay/revision, opaque pagination, crash before cursor receipt and 409 restore/reset never skip or silently certify completeness. Each page coverage controls freshness, not row/seq arrival. Fixed clock cases at 60 seconds and beyond 5 minutes, silence/dead worker and delayed recovery prove labels plus one alarm per episode. Missing launch-origin and cross-Pi overlap remain unassigned/unresolved. Normal gate passes; no key/opaque cursor appears in public DTO/log/error/URL.",
  "must_not": "No queueing before Security agreement, live feed read during development, after-seq assumption, opaque cursor parsing, guessed route/header, reset-to-zero on 409, inferred launch task/project, Pi zero as known/free, database/full-run/Event.data scraper, engine edit, historical rate guess, legacy-total addition, credential file, authority activation or budget change.",
  "touches": ["pi-web-ui repo"],
  "after": ["W0", "W4", "S0", "temper #128", "temper #129"],
  "uses": {"W0": "Collector-native numeric feed/cursor and fault contract.", "W4": "Supported funding evidence or explicit unknown for unmapped Temper calls.", "S0": "Recorded principal, auth transport and key-custody agreement; a pre-queue gate.", "temper #128": "Delivered revised xid8-watermark feed: exact opaque-cursor/auth/version/409 handshake and page complete_through/stalled contract, plus #125-#127 reconciler/cutover coverage; supersedes after-seq.", "temper #129": "Reviewed conservative Pi mapping: every zero is null and total null unless all four classes are known; this is not a presence-preserving producer repair."},
  "owns": ["server/usage-accounting-temper-source.ts", "tests/unit/usage-accounting-temper-source.test.ts", "docs/usage-accounting-temper-source.md"]
}
```

```usage-task
{
  "id": "T1",
  "queue": "ops",
  "lead": "ops",
  "project": "automatic-cost-accounting",
  "title": "Automatic costs: integrate approved Temper feed, install and verify look-only",
  "goal": "Add the reviewed Temper numeric source to the already proven Pi meter without resetting cursors, double counting Pi calls, claiming legacy completeness or changing work controls.",
  "done_when": "The worker uses T0 through S0's existing protected key mechanism, opaque cursor/409 recovery and per-page coverage remain durable, missing/partial/unassigned Temper and delayed/dead-man states are visible, combined stage tests pass, and a separate pi-web-deploy plus look-only Roles check records installed freshness/coverage/overlap results.",
  "decided": "Lead Ops. Consume R0's installed Pi receipt and T0's tested adapter. Temper remains temper-dev only; no separate server or workflow trial. Credential provisioning/route activation is performed only within S0's reviewed custody and existing approvals; if absent, block on the named lead, never invent a key or turn off off-mode. Unknown run/task/payer bindings remain unassigned.",
  "steps": "1. Verify route deployment, S0 admission and key availability without printing it; write H-WIRE-T1. 2. Add the narrow Temper source hook in usage-accounting-worker.ts using injected protected credential loading, opaque cursor receipts and original same-call aliases. Connect T0's scalar coverage/dead-man state to W6's main-thread lifecycle age check so worker silence cannot hide an enabled feed stall; emit one safe operational diagnostic per episode, no new notification destination. 3. Test combined current-first, partly unknown Pi tokens, absent launch-origin, legacy partial, out-of-order seq, call-ID replay, opaque recovery/409, delayed/disabled/silent feed and failure isolation before any live read. 4. Land detached normally. 5. Check running/waiting work, pi-web-deploy dry-run, then a separate pi-web-deploy install and actual result readback. 6. Perform the look-only Roles page check and passive numeric <=60-second observation; record receipt/undo and remaining unknowns without initiating runs.",
  "verify": "Combined fixed Pi/Temper same-call leaf counts once; absent launch-origin is unassigned, Pi zero classes are null and overlap stays unknown without native proof. Test 409 restore/reset with retained evidence and bounded partial reconciliation; seq maxima do not certify commits or coverage. Page says Temper figures complete through HH:MM with timezone and visible delayed state. Enabled coverage stall/silence >5 minutes raises one dead-man alarm, clears only on actual progress and catches a dead worker; disabled mode stays honestly off. Measure proposed complete_through lag p95 <=60 seconds and max <=5 minutes separately from <=60-second first-byte-observation to client generation-ID acknowledgement; record endpoints, samples and unaccepted/missed bars. Do not call a server push a client acknowledgement. Ordinary deploy health/look pass, no model/workflow is started, and passive observation uses queue_wait.",
  "must_not": "No unapproved credential provisioning or feed activation, hidden Temper/test instance, workflow/model trial, database scrape, unknown-as-zero, guessed payer/root, manual spend mutation, cap/stop/pause change or manual restart.",
  "touches": ["pi-web-ui repo", "pi-web-deploy"],
  "after": ["R0", "T0"],
  "uses": {"R0": "Accepted installed Pi worker/UI health, resource and look-only receipt.", "T0": "Tested exact feed/pricing/overlap adapter plus its completed Security and Temper prerequisite artifacts."},
  "owns": ["server/usage-accounting-worker.ts (Temper source hook only)", "server/index.ts (existing scalar lifecycle health check, Temper state only)", "tests/unit/usage-accounting-temper-wiring.test.ts", "docs/usage-accounting-temper-release.md"]
}
```

```usage-task
{
  "id": "O0",
  "queue": "ops",
  "lead": "ops",
  "project": "automatic-cost-accounting",
  "option": true,
  "title": "Automatic costs option: measure Pi token-presence loss before a producer repair",
  "goal": "Measure how much recorded Pi usage cannot be priced exactly because zero and missing token presence were collapsed, then give Ops a scoped future producer repair option instead of guessing its value.",
  "done_when": "A bounded deterministic numeric measurement reports the Pi-row denominator, affected/null-class counts and share with clear coverage limits; a separate repair-option plan identifies the earliest presence-preserving Pi boundary and compatibility/rollback work without changing the SDK or certifying old zeros.",
  "decided": "Lead Ops. This is an optional measurement-and-plan task, not a prerequisite to truthful partly unknown display and not permission to patch Pi. Pi 0.87.1 uses value || 0 and a later zero can overwrite positive counts; every zero is unprovable. #129 maps zero to null and total null unless all four classes are known. Count affected rows with any required null class; do not pretend null distinguishes a true zero from originally missing. Use retained approved numeric meter exports after T1, no new live-feed reader.",
  "steps": "1. Write H-WIRE-O0 and first measure a bounded retained numeric window before proposing a fix. 2. Add scripts/measure-pi-token-presence.mjs over exported numeric rows only: denominator all Pi rows in the stated covered window, affected any required null class, per-class counts, known-priced and unknown-price counts; report exact counts/share and unavailable coverage. 3. Validate on fixed clean/zero/absent/later-overwrite/mixed-provider cases, with no cost imputation. 4. Identify the narrow Pi source boundary that could preserve per-class presence and reported actual zero through overwrite/aggregation; outline the one-version CLI/web SDK and temper-pi-host compatibility, capture schema/version and rollback checks required by Ops rules. 5. Write the future repair option and measured benefit/unknowns for Ops normal approval; land measurement script/test/doc detached only, no implementation or install.",
  "verify": "A fixed ten-row Pi fixture with three affected rows reports 3/10 and 30%, all required-null class counts are correct, later-zero overwrite remains unknown and non-Pi rows never enter the denominator. Empty/missing coverage yields unknown share, not 0%. Test bounded pages and replays without duplicate call counts. Report exact input window/counts and no claim of restored historical truth; normal land checks pass.",
  "must_not": "No SDK/package/provider change, producer hook patch, live feed/chat/model read, credential, model probe, historical zero certification, USD 0 imputation, new rate guess, install, budget cap/stop or automatic queueing of the repair option.",
  "touches": ["pi-web-ui repo"],
  "after": ["T1"],
  "uses": {"T1": "Installed numeric call-ID-deduplicated Pi feed evidence with conservative #129 mapping, window coverage and retained export access; no transcript or raw feed access."},
  "owns": ["scripts/measure-pi-token-presence.mjs", "tests/unit/usage-accounting-pi-presence.test.ts", "docs/usage-accounting-pi-presence-option.md"]
}
```

```usage-task
{
  "id": "D0a",
  "queue": "data",
  "lead": "data",
  "project": "automatic-cost-accounting",
  "title": "Automatic costs: independent Pi-slice reconciliation alongside Temper wiring",
  "goal": "Give Ops an independent deterministic check of supported installed Pi slices and the fixed pricing/token/unknown oracle immediately after R0, without waiting for Temper integration.",
  "done_when": "A Pi reconciliation script, fixed numeric cases and Data's result compare exact expected costs/bases and supported allocations with R0's installed receipts, explain manual discrepancies without fitting, and name all remaining funding/coverage/non-task-origin blockers for C0.",
  "decided": "Lead Data. Run after R0 in parallel with T0/T1, using numeric exports only. Pi zero presence is not proved by value-or-zero or later overwrites; all affected required classes remain null and no exact repricing is claimed. Preserve documented Pi-recorded estimate bases separately. Ops owns quoteListUsd and versioned rates. Task-only cases cannot certify unassigned home/ad-hoc usage; G13 remains a gate. Manual spend is not the oracle.",
  "steps": "1. Write H-WIRE-D0a and verify R0's installed generations and approved numeric evidence access. 2. Add scripts/usage-accounting-reconcile-pi.mjs over bounded numeric exports with exact decimal comparisons and unknown exclusions. 3. Add fixed pricing/cache/side/overlap/replay/requester/reply/Team/reparent/Monday/DST cases and the current fork of an unindexed parent. 4. Reconcile supported installed Pi task slices and preserve distinct estimate/list bases; identify unassigned home/ad-hoc portions without guessing their policy. 5. Return zero-mismatch proof or concrete blockers and manual-discrepancy explanations to Ops; land the exclusive script/test/doc detached normally, no install.",
  "verify": "A planted 0.000001 error, duplicate native call, zero-as-present token, wrong parent, unknown-as-headroom, estimate-as-exact-list and excluded home-turn-as-complete case each fails; exact clean cases pass. Results reproduce from fixed numeric input without a model. Unknown exclusions are counted and never qualify a complete budget. Normal land checks pass and the receipt names installed Pi generations.",
  "must_not": "No transcript/model content, live model or workflow run, Temper feed request, credential, manual spend write, guessed rate/provenance/home-turn rule, app policy change, project completion, install or stop/cap change.",
  "touches": ["pi-web-ui repo"],
  "after": ["R0"],
  "uses": {"R0": "Installed Pi numeric generations, supported task-slice exports, basis/funding gaps and the look-only health/freshness receipt."},
  "owns": ["scripts/usage-accounting-reconcile-pi.mjs", "tests/unit/usage-accounting-reconcile-pi.test.ts", "docs/usage-accounting-reconciliation-pi.md"]
}
```

```usage-task
{
  "id": "D0b",
  "queue": "data",
  "lead": "data",
  "project": "automatic-cost-accounting",
  "title": "Automatic costs: independent Temper-slice and combined-overlap reconciliation",
  "goal": "Give Ops an independent deterministic check of installed Temper list quotes, Pi token nulls, page coverage, missing launch origin and explicit cross-source overlap after T1.",
  "done_when": "A separate Temper reconciliation script, fixed numeric cases and Data's result compare exact supported list costs and native same-call dedupe with T1's installed generations, with every unknown token/origin/coverage exclusion counted and C0 blockers explicit.",
  "decided": "Lead Data. Use #127/#129 exclusive input/output/cache-read/cache-write: every Pi zero is null and total null unless all four are known; only independently proved non-Pi reported zero is zero. Ops quoteListUsd, not Temper legacy cost, sets list amounts. Opaque cursor/complete_through supplies coverage, not seq maxima. Missing G12 launch-origin stays unassigned. This task does not wait for D0a or modify its files.",
  "steps": "1. Write H-WIRE-D0b and verify T1's installed receipts and approved numeric exports. 2. Add scripts/usage-accounting-reconcile-temper.mjs over bounded exports only, with exact decimal comparisons and per-class/coverage/origin exclusions. 3. Test supported prices, Pi zero/overwrite/null totals, proved non-Pi zero, unsupported rate, native same-call overlap, out-of-order seq, opaque replay/409, delayed/stalled coverage and absent launch-origin. 4. Reconcile supported installed Temper slices plus explicit Pi aliases without summing legacy totals or inferring task identity. 5. Return zero-mismatch proof or named blockers and limits to Ops; land the exclusive script/test/doc detached normally, no install.",
  "verify": "Planted legacy-cost-as-list, null-as-zero, duplicate cross-source call, seq-as-coverage, lost opaque cursor, false launch-task and unknown-as-headroom cases fail; independently exact clean cases pass. Fixed numeric input reproduces results without a model. Receipts count every excluded unknown and name actual installed generations. Normal land checks pass.",
  "must_not": "No transcript/model content, live feed/model/workflow request, credential access, guessed Pi zero/rate/origin, spend write, D0a file change, app policy mutation, automatic completion, install or stop/cap change.",
  "touches": ["pi-web-ui repo"],
  "after": ["T1"],
  "uses": {"T1": "Installed Temper generations, conservative token/call-ID/opaque-cursor coverage, explicit combined-source aliases and look-only receipt."},
  "owns": ["scripts/usage-accounting-reconcile-temper.mjs", "tests/unit/usage-accounting-reconcile-temper.test.ts", "docs/usage-accounting-reconciliation-temper.md"]
}
```

```usage-task
{
  "id": "C0",
  "queue": "ops",
  "lead": "ops",
  "project": "automatic-cost-accounting",
  "title": "Automatic costs: prove replacement and remove manual Roles display",
  "goal": "Finish the project's approved replacement outcome by removing manual figures from the normal Roles display only after deterministic known-case agreement, honest unknowns and installed freshness are proved.",
  "done_when": "The exact cut-over bar in this plan passes with Data's known-slice reconciliation and 24-hour passive dual-display receipt, funding provenance is supported rather than fabricated, manual Roles figures are removed from normal display without touching spend files, and the separately deployed page passes a look-only check.",
  "decided": "Lead Ops; Data owns the independent numeric reconciliation result. Fixed known oracles, not manual tally equality, certify amounts. Zero known-case mismatches and zero false complete/zero/headroom unknown cases are required. Every observed update must render within 60 seconds; Monday/DST is proved synthetically. Unsupported funding or unresolved G13 home/ad-hoc turn-origin blocks complete replacement for affected roles; retain their manual reference and record incomplete, never count all home usage as own without the owner. Recommend a separately reviewed numeric turn-origin producer, with owner turns unassigned until he sets a rule. C0 admission checks the delivered resolution first. Retain a reversible reference path and files unchanged.",
  "steps": "1. Before queue admission verify G13's supported turn-origin/reporting result or keep affected roles manual/incomplete; do not infer the owner's rule. Write H-WIRE-C0, consume R0/T1 receipts and both D0a/D0b exact reconciliations, and explain manual discrepancies. 2. Wait on the 24-hour passive dual-display receipt using queue_wait; inspect numeric status only, never manufacture usage. 3. Run all fixed pricing/cache/helper/overlap/requester/Team/reparent/unknown/stale/Monday/DST cut-over cases and assert the measured zero-mismatch bar. 4. Change only the normal Roles exact-view manual display branch, keeping exact automatic labels and rollback reference behavior; leave server/roles-spend.ts and spend.json/stopped untouched. 5. Land detached normally, check running/waiting work, pi-web-deploy dry-run and the separate install step. 6. Make the look-only Roles check, record all five project criterion proofs or remaining gaps for Ops, and provide the reversible display/build rollback.",
  "verify": "Independent known sums agree exactly; every planted unknown remains labelled and has null certified remainder. The passive 24-hour receipt has no late client-acknowledged generation, missing dirty-source event or hidden fault; endpoints and sample count are recorded separately from push/detection timings. Funding witness and G13 turn-origin resolution satisfy the reviewed boundary; a role with unassigned home own-work cannot be called complete. Protocol/browser tests keep exact decimals and rollback manual-reference behavior. Normal gate, installed health and look-only live page pass; no project criterion is marked met merely because a task ended.",
  "must_not": "No deletion/update of spend files or stopped values, automatic work enforcement, budget limit/exemption/permission change, false funding authority, manual number as numeric oracle, model tally/probe, real chat action or manual service restart.",
  "touches": ["pi-web-ui repo", "pi-web-deploy"],
  "after": ["D0a", "D0b"],
  "uses": {"D0a": "Independent Pi exact known-slice/basis/funding reconciliation with R0 installed receipts and non-task-origin exclusions.", "D0b": "Independent Temper exact token/pricing/call-ID/coverage/overlap reconciliation with T1 installed receipts; G13, supported funding and the 24-hour observation remain admission/cut-over gates."},
  "owns": ["web/src/roles-exact-view.ts (manual display branch only)", "tests/unit/usage-accounting-cutover.test.ts", "docs/usage-accounting-cutover.md"]
}
```

## Architecture review and final verification

### Architecture's answer (rm-9a25d418)

Architecture reviewed the complete 689-line corrected draft at 17:03 PDT,
2026-10-20 (sha256 prefix `a4291a42`), plus the existing import-guard tests.
Its recorded verdict: **REVISE; the shape is sound. Land after these corrections;
no second review needed if applied as written.** The answer is design review,
not owner consent, activation, a cap or a stop change.

Architecture found sound: one worker/cache-only page; current week before
preemptible history; collector faults on every subject; unavailable funding
instead of invented roots; measured dual-display cut-over; S0 before T0;
opaque cursors and conservative #129 nulling; genuine result dependencies.

The nine corrections and their disposition:

1. **Worker/main module boundary.** Split the worker-only snapshot builder from
   a tiny cache importing only meter-contract types. W0's exact worker-side
   allowlists and positive transitive graph tests reject collector/pi-sessions/
   membership/roles/funding/store/sources from index, roles-overview, protocol or
   cache. **Applied:** W0, W5, W6, W7; new meter-cache ownership is explicit.
2. **Shared libuv pool and resource isolation.** Use bounded worker readSync
   (<=256 KiB) or <=1 outstanding pool operation, finite Worker resourceLimits,
   main-thread fs-callback latency in W6, installed worker heap/RSS in R0.
   **Applied:** runtime, W0/W1/W6/R0; event-loop p99 alone is not acceptance.
3. **Parent before copies across lanes.** A current fork with an unindexed
   parent promotes the parent's bounded window; copies stay pending, excluded
   and flagged until proved. **Applied:** current/history section, W3/W6 and
   D0a's current-week-fork-of-unindexed-parent fixture.
4. **Reviewed lock and versioned store.** Reuse the ext4 inode/pid-correct
   role-message-guard lock; overlap says waiting for previous writer, stale,
   never steals a live lock. Older builds refuse newer store majors; migration
   keeps a copy and rollback restores a compatible store or remains unavailable.
   **Applied:** W0 narrow helper extraction and W1 format/rollback/tests.
5. **Outside-task usage decision.** Home/ad-hoc usage is unassigned and can make
   own-work totals incomplete. Options are (a) a new host-recorded numeric
   turn-origin producer for role-message kind/queue/schedule/owner origin,
   (b) all home usage own (overcounts requests; owner-only choice), or (c) keep
   manual references for affected roles. Architecture recommends (a), owner
   turns unassigned until the owner sets their rule. **Applied:** G13 owned by
   Ops with Security provenance review; recommendation (a), conservative (c)
   until delivery, no choice of (b), no new producer/owner decision queued by
   this task. C0 admission cannot certify affected roles or full replacement
   while this remains unresolved.
6. **Monday with a blocked worker.** Main's scalar age check immediately marks
   stale if snapshot weekStart differs from the current Pacific week.
   **Applied:** runtime/rollover, separate W5 cache, W6 and W7 fixed cases.
7. **Exact 60-second endpoints.** Start is first worker observation of appended
   bytes (watch/stat), end is client generation-ID acknowledgement after render;
   push time alone is labelled server-push latency. **Applied:** runtime and
   W6/W7/R0/T1/C0; controlled append-to-detection and full end-to-end fixtures
   remain required, with unavailable natural append time disclosed.
8. **Parallel Data work and narrow hooks.** D0a checks Pi after R0 alongside
   T0/T1; D0b checks Temper after T1; C0 consumes both. W6's index hook stays one
   small named function, and W7 claims protocol.ts/types.ts. **Applied:** graph,
   disjoint Data scripts/tests/docs, C0 edges and W6/W7 ownership.
9. **Host-visible Temper worker files.** W3 classifies them as Temper-owned so
   they cannot charge again beside T0 rows. **Applied:** runtime, W3 fixtures.

Ops applied all nine corrections under Architecture's stated no-second-review
condition. It does not claim that Architecture re-read the edited version or
that an implementation is approved/installed. The late Ops facts about Pi-zero
loss, failed #125/xid8/opaque cursor/409/page coverage and absent Temper launch
origin remain explicit; this plan does not wait for Temper to finish.

Checker: `node docs/check-usage-accounting-wiring.mjs` validates each task's seven
text fields against the queue's placeholder/unsettled-phrase/length rules, plus
unique IDs, project/routing, touches, dependencies with named results and the
five acceptance mappings. It reads this document only. It neither queues work
nor reads live numeric sources. `--self-test` runs fixed malformed-plan controls
in memory, with no app/model mock or payload. Final invocation on 2026-10-20:
`node docs/check-usage-accounting-wiring.mjs --self-test` — **PASS, 16 tasks and
34 in-memory negative controls**. Only these two documentation files change.

Undo of #309: revert this document and its checker. There is no runtime change,
installed timer, credential, source read, manual tally change or budget action
to undo. Implementation and release tasks each carry their own undo and receipt.
