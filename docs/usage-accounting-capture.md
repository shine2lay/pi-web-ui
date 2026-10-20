# Numeric capture boundary — projection only

Ops #301 · automatic-cost-accounting · accountable lead: Ops.

## H-AUTOCOST-2 (written before implementation)

Wrong, with evidence: the #293 public-source inventory shows assistant-only
`server/serialize.ts` usage omits SDK cache-warming, compaction and nested tool
usage. SDK entry IDs and ACP wait/report totals do not establish immutable actual
attempt identity, historical task birth or payer cause. Current amounts do not
universally prove list-price basis/rate version or a free zero.

One change: a closed metadata-only numeric projection with explicit injected
native-evidence seams. Validate before projection; keep observations, attempts,
report/snapshot totals, subject membership and budget cause separate. No raw
message/event/session/model objects enter this API. No source adapter is installed.

Expected fixed results: main 0.10 + warm 0.02 + compaction 0.03 + delegate
0.04 = 0.19 in synthetic known list observations; exact replay/fork deduplicates;
a distinct retry adds 0.10. A mapped alias counts once only when its canonical
fact exists; a Pi/Temper map alone leaves the missing Temper feed unknown. Unproven
IDs, prices, zeros, overlap and membership stay unknown. A failed attempt with reported
usage retains it; a failure without usage is not free. The original parent add
and the membership effective at occurrence survive observation/reparent/resume.

Falsifier: lost/duplicated attempt, payload retained or echoed, a guessed call,
rate, provider/model, role/payer/root/policy, or a passing synthetic fixture
portrayed as a registered producer. No current-rate backpricing.

Acceptance checks: sealed build and the unchanged normal `wt land` gate, including
the 102 assigned fixed cases. The land receipt records the final result; synthetic
evidence never establishes live producer coverage.

Initial isolated check: 101/102; the fixture reader incorrectly returned price
evidence with a null amount instead of unavailable. The boundary correctly flagged
that malformed evidence. H-AUTOCOST-2F1: returning null for unavailable fixture price
evidence should preserve the unchanged exact unknown/unpriced expectation without
an invalid-evidence fault. Any changed monetary/classification expectation would
falsify this correction; only the fixture reader changed, not the expected output.

Pre-test review controls: the draft used observation time in revision 0 and could
conflict on replay; a durable native `sourceStamp` now preserves the first source
observation in the fact/allocation while retaining the latest observer separately.
The draft also checked canonical task existence without proving that this attempt
belonged to that task. The native attempt witness must now carry that original
association, matching the raw task identity before parent history can bind it.
Both counterexamples have fixed regressions; neither is a live-producer proof.

## Public API and exact allowed inputs

`server/usage-accounting-capture.ts` imports **only** the unchanged #293 contract.
There are no callers in production, I/O, runtime listeners, registry functions,
model/provider execution, environment reads or installed adapters.

- `captureUsage(raw: unknown, readers?: CaptureEvidenceReaders): CaptureResult`
  accepts exactly the `CaptureProjection` schema, version `numeric-capture/1`.
  Missing keys, extra keys at any depth, symbols, accessors, nonenumerable fields
  and nonplain records fail with a fixed code. No invalid value/error is echoed,
  logged, hashed or retained. References are at most 256 restricted characters;
  times are validated canonical UTC milliseconds; token counts are nullable
  nonnegative safe integers; USD uses #293's bounded decimal-text convention.
- Source is exactly `pi-sdk/1.0.1`, `acp/deb0e772`, or
  `temper/legacy-summary`. This is a source-convention selector, **not** an
  authentication token. `stream`/`event` are native metadata, not file paths,
  byte offsets, wait IDs or new call IDs made from a filename.
- Actual `occurredAt` (nullable) stays separate from `observedAt` and task birth.
  Actual `provider`/`model` are nullable; there is no default provider/model.
  `kind` is assistant/cache-warm/compaction/branch-summary/delegate; branch-summary
  maps to #293's compaction class while the observation preserves the distinction.
  `shape` separates an actual attempt from a report or run snapshot; `outcome`
  is a fixed success/error/aborted/unavailable enum, never an error string.
- `identity` is a native producer/incarnation/attempt tuple or null. No session
  entry ID, first eight characters, content hash, copy path, offset or wait result
  establishes it. The original incarnation must survive replay/restart/fork;
  a genuinely new retry needs its own actual attempt stamp.
- `usageEvidence` distinguishes reported usage from initialized/default zeros.
  `tokenConvention` is a known Pi normalized convention, raw-inclusive, or unknown.
  `tokens` contains only input/output/cacheRead/cacheWrite/reasoning/cacheWrite1h/
  total, each nullable. Optional SDK fields must become null when unavailable,
  **not** a guessed zero. Reasoning is an output subset and 1h cache writes a
  cacheWrite subset; neither adds another token class. Mismatched totals/subsets
  invalidate normalization. Unsupported conventions preserve raw numbers only.
- `price` contains amountUsd/basis/rateVersion/evidenceRef/zero, all explicitly
  nullable where appropriate. No raw model object/rate table/SDK body is accepted.
  A declared basis/rate is not evidence; a reader must independently match the
  amount, actual provider/model, occurrence window, convention and evidence ref.
  Known list cost additionally requires a version; a known zero needs explicit
  source evidence and explicit marking. No current-rate lookup or backpricing.
- `subject` contains only an observed role, native session ref and native run ref.
  **Role is an unverified observed subject, not a payer.** `task` contains only
  canonical queue/task/original addedAt, not requester/title/lead/approval/prose.
  `ancestry` can only say missing/mixed/unknown; it cannot supply a native root.

Only a prospective source-owned adapter may construct these records from approved
native sources. Never pass a whole `AgentMessage`, `AgentSessionEvent`, model,
`Event.data`, session entry, tool arguments/results, session file or payload bag
and then ask capture to strip it. Project the listed fields **at the source**.
SDK numeric floats may be retained as decimal text only when an explicit adapter
can represent the reported amount within the decimal bound without rounding or
exponent notation; otherwise amount is unavailable. Such legacy observations do
not establish list/invoice basis. The `reported*` fields and `unprovenUsd` are
non-budget, nonadditive diagnostics, not a second ledger.

### Injected evidence seams (none implemented/registered)

The optional process-local `CaptureEvidenceReaders` take only source/stream/event
or a frozen bounded original task ref. They return closed metadata or null. They
are **not JSON trust flags** and are not accepted inside the raw projection.
Exceptions and malformed/overbound evidence become fixed faults, not error text.
Synthetic closures in tests implement these seams only for known fixtures.

1. `attempt(source, stream, event)`: independently vet the native attempt and
   return original identity, occurrence, provider/model/kind, session/run, original
   queue/task/add association, durable first `sourceStamp`, overlap classification
   and optional canonical same-attempt identity/evidence ref. All actual call
   fields must match. Source identity cannot be authenticated by a familiar
   `evidenceRef` string. Unknown overlap leaves identity unresolved; a real
   same-call map emits a #293 alias, not a new canonical fact. Missing canonical
   leaves still fault downstream, including a mapped Pi/Temper call without a
   Temper numeric producer. A new container/session/copy must not mint a new
   incarnation for an old call. New observations retain the stable revision-0
   first-source stamp and original binding. Numeric corrections are **not**
   invented as new attempts or revisions here; conflicting revision-0 input is
   a #293 conflict requiring original history and a separately designed producer.
2. `price(source, stream, event)`: independently vet and return exact amount,
   provider/model, basis, rate version, evidence ref, valid occurrence window,
   exclusive convention and explicit-zero evidence. The reader cannot re-read
   today's rate and certify yesterday's cost. Known provider-reported/invoice
   bases stay separate from the unknown list basis; they never add to it.
3. `parentHistory(task)`: read a **validated canonical parent** history, not a
   child assignment/latest registry link. Return at most 1024 closed #293
   memberships, or unavailable. A native attempt-to-original-task match is
   required first. Original `add` must exist at `effectiveAt === addedAt`;
   conflicting versions fail; select the latest membership no later than call
   occurrence. Wrong queue/task/birth, child assignment time, missing original
   history and foreign valid tasks cannot establish a binding. Native source
   validation/authenticity belongs to this missing reader, not the JSON schema.

Even a successful fixture result says `projectionOnly: true` and
`producerRegistered: false`. `captureCapabilities()` reports **unavailable**
installed native attempts, prices, original task binding and native cause for
all sources. There is no root/policy/payer injection API: `roots` and `policies`
are always empty and allocation is unknown/missing-root or mixed-root. Task,
project/initiative and observed-role grouping never establishes funding. No
single global gross subtotal is applied to every role. With no approved interval
producer, `coverage` is empty, required streams are explicit, source facts are
partial and `producer-unavailable` is emitted. No observation time is fabricated
into a coverage interval, and absent occurrence is not replaced by task birth.
Consequently the #293 consumer cannot claim a complete balance/headroom.

## Source capability inventory and hook findings

This is a **public-code-only** review, not a scan of actual sessions, SDK/provider
execution, model call, private role folder, API/DB fetch or Temper run.
Reviewed own worktree starts at #293 `ffb1c66e3d97c207e57cf2cb35c85306c91ecf09`;
bundled `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` are 1.0.1;
ACP source is `deb0e772e32c2f561b9ec2bfe6ee8f4391b3f9b7`;
queue source reviewed is `547b5320cbad15a4e78b3b575339899b0f155cf2`.
Temper facts below are the bounded public-source/owner reply already recorded
in `docs/usage-accounting-contract.md`, **not** a new engine inspection or feed.

The SDK's `docs/sdk.md`, `docs/session-format.md`, `docs/message-types.md`,
`docs/extensions.md`, `docs/compaction.md` and the relevant
`examples/sdk/06-extensions.ts`, `examples/sdk/11-sessions.ts`,
`examples/extensions/custom-compaction.ts`, `examples/extensions/usage-bar.ts`,
`examples/extensions/cache-warmup.ts` were read completely before conclusions.
The table's SDK paths are relative to
`node_modules/@earendil-works/pi-coding-agent/`; Pi-AI paths name that package.

| Approved-source input / exact seam inspected | Supported numeric information | Not available / unsafe substitute |
| --- | --- | --- |
| SDK `dist/core/agent-session.js:738-756`, public `message_end` via `subscribe()`; `@earendil-works/pi-ai/dist/types.d.ts:289-309,372-395` | In a future adapter, assistant provider, responseModel when actually returned and source-established as actual, timestamp with established semantics, Usage scalar fields and stopReason enum. Reported usage on an error/abort may be useful. Selected model alone must not be promoted to actual model; absent native proof, actual model is null. | Listener runs **before** session append; the event/whole message may not enter capture. `responseId` is optional and not a universal distinct-attempt stamp. Appended entry ID is not call identity. Initialized zero counters and success/error status alone do not establish that usage was reported. |
| SDK `dist/core/cache-warmer.js:237-253`; `dist/core/agent-session.js:179` emits `entry_appended` from `onWarmed`; `dist/core/session-manager.js:864-878` | Successful cache-warm reported provider/model metadata and usage, projected at source; standalone usage entries are not context messages. The persisted responseModel-or-model fallback alone cannot certify actual routed model; absent native proof, actual model remains null. | Errors/aborts/exceptions and invalidated runs do not append usage here. Append timestamp is not an immutable attempt-start occurrence. Failure coverage, native attempt/time/root/task stamps are unavailable; never initiate warming to prove capture. |
| SDK `dist/core/agent-session.js:2199-2230,2488-2511`, `compaction_end`; extension `session_compact`; `dist/core/session-manager.js:880-899` | `result.usage` / saved compaction usage only; successful summaries count outside assistant messages. | Result/entry carries summary/details and must never cross boundary. No universal per-attempt provider/model/native ID in the compaction usage record; aggregate nested usage can cover multiple calls. Missing/failed result cannot be assumed free. |
| SDK `dist/core/agent-session.js:3284-3314`, `session_tree` / returned `summaryEntry` | Branch-summary numeric usage when reported; classify as compaction for #293. | No native attempt mapping or complete failures. Do not import summary text/details. Session tree/fork/copy preserves history but entry IDs/new file paths do not establish original incarnation. |
| SDK `dist/core/agent-session.js:3345-3398`, `getSessionStats()` | Numeric aggregate includes assistant, usage, branch-summary/compaction and tool-result usage. | Reconciliation/report observation only, **never another attempt** beside leaves. It is not a complete native call ledger or price-basis guarantee. |
| `@earendil-works/pi-ai/dist/api/anthropic-messages.js:462-470,624-650`; `dist/api/openai-responses-shared.js:440-455` | Pi normalized exclusive input/output/cacheRead/cacheWrite: Anthropic uses separate classes; Responses subtracts cached/write tokens from inclusive input. Reasoning and 1h writes are subsets. | Raw inclusive provider input cannot be passed as Pi exclusive input. Optional/default counters and model cost calculation do not record historical rate provenance or invoice basis. Missing convention or inconsistent supplied total is unknown, never guessed normalization. |
| ACP `src/delegate-tool.ts:490-509,649-680,1003-1047,1343-1348,1824-1826,1885-1892` | Existing `makeEventApplier().onUsage` supplies numeric accumulated usage; `accumulateUsage`, `buildWaitResult`, `buildCancelResult`, separate/merged reporting and `usageReported` guard explain overlap. | onUsage aggregate lacks durable original per-attempt provider/model/time/native mapping. Wait/merged report totals are nonadditive, not attempts; `safeCost()` drops all-zero costs, which does not prove free. Raw JSON stdout, results, artifacts and delegate files are not capture inputs. |
| Queue `queue.ts:494-547` add/update/start/assigned; `index.ts:1044-1095` launch; `work-store.ts:116-146` TaskLink | Canonical queue `add.ts` is original birth; parent changes have effective event time. Existing TaskLink has queue/task/added and latest parent as index metadata. | Child assigned.ts is launch time, not original add; `from.file`, task number, latest TaskLink parent, display requester/lead/approval/title or current resumer do not prove original attempt membership or budget cause. Native atomic task capture still missing. |
| Temper bounded #293 reply `rm-99a8aa33` / source map | Legacy reported numeric total may be an unproven non-budget observation. Existing reconciliation differs from summing all reports/leaves. | No approved safe per-call numeric cursor feed or queue binding, explicit basis/rate/zero provenance, native Pi/call map or root producer. All are unavailable here. No direct API/DB/engine access or unbounded Event.data adapter. |

### Minimal prospective production files and prerequisites (proposal, not code)

Keep these **separate** owner-approved follow-up tasks; they can proceed alongside
independent collector/Roles work from #293. They are not implied authorizations
from this fixture API and no native scope/R0/RTPI producer is proposed here.

1. **Ops / SDK-facing field projection:** new
   `extensions/usage-accounting-native.ts` and
   `tests/unit/usage-accounting-native.test.ts` only, with a dedicated source doc.
   At documented `message_end`, `entry_appended`, `compaction_end` and
   `session_tree` seams, project only the listed scalar metadata **before** calling
   `captureUsage`. Never send whole events/entries. This file alone cannot create
   durable actual IDs, failure coverage or missing compaction provider/model.
   First agree a supported source-owned numeric call observer API with the SDK
   owner: durable incarnation/attempt+retry, occurrence, actual model, reported-
   usage presence, failure/warm/compaction/nested-call coverage and versioned
   pricing evidence. No SDK patch, hook install, monkeypatch or upgrade is done
   or silently authorized. Until supplied, leave those capabilities unavailable;
   a message/entry-listener-only adapter is not complete and must not claim so.
2. **Ops / queue metadata producer:** new
   `/home/shinelay/projects/pi-queue/usage-accounting-metadata.ts` and its own
   test/fixture/doc. A later explicitly assigned tiny call site at `launch()`
   (`index.ts:1044-1095`) must capture original `add` and canonical parent event
   history **before** `host.startChat`, not derive it from assigned.ts. Use the
   actual canonical queue identity and native original add timestamp, validate
   the source chain, preserve on replay/reparent/resume, and join it to native
   actual attempts. Do not pass `from.file`/plans/launch body to capture or use
   the work registry's latest link as historical proof. Exact shared call-site
   ownership must be assigned before edits; no queue/schema/runtime change here.
3. **Ops / ACP numeric leaf mapping:** new
   `/home/shinelay/projects/billion-context-pi/src/usage-accounting-metadata.ts`
   and an exclusive test/doc. A later assigned hook at
   `makeEventApplier().onUsage` / delegate launch/report lifecycle must receive
   original per-attempt stamps from the supported native observer **before**
   accumulation, retain copy/restart/fork ancestry and leaf-to-report mappings,
   and label reports/waits/snapshots nonadditive. Existing aggregated onUsage
   cannot implement this by itself. Do not parse raw stdout/results/artifacts
   into this boundary or mint a call from a delegate/wait/report ID.
4. **Temper-owned feed:** request Temper's bounded versioned numeric cursor feed
   and source capability contract: actual native call/event/run/agent IDs,
   instance incarnation, occurrence/provider/model, exclusive token classes,
   reported failure usage, decimal amount/basis/rate/zero evidence and coverage;
   original Pi `llm_call_id` mapping for same-call aliases. Their owner chooses
   exclusive engine/feed files; Ops must not implement a DB/Event.data scraper
   or guess their public endpoint. Task/native cause remain unknown absent a
   separately approved supported source, irrespective of successful fixtures.
5. **Ops / eventual bridge, after delivered producers and review:** new
   `server/usage-accounting-wiring.ts` with its own integration test and doc,
   consuming `captureUsage` and the #300 collector public API. Agree its API
   against the landed independent collector, not private implementation guesses.
   Preserve exact source revisions/durable first stamps and atomically commit
   projected records before cursor advance. Source inventory must enumerate
   real missing/partial streams and intervals, not just report a healthy tail.
   A separately scoped runtime import/install/release plan is required; #301
   performs no deploy and adds no production importer. Roles integration stays
   solely with the Roles adapter task. Neither bridge nor display can invent
   payer/policy/own-requested-team roots, rewrite manual spend or enforce a cap.

## Fixed verification inventory

`tests/fixtures/usage-accounting-capture/known.json` has a complete closed numeric
input, synthetic readers, original add/reparent history and exact **every-field**
accounting/observation/fault output. `cases.json` fixes the four attempt amounts,
retry total, null token vector, absent-reader/failure/legacy fault classifications
and both Pacific DST/Monday boundaries. Fixtures explicitly use `fixture-only:*`
evidence; an accepted object, alias or string authenticates nothing live.

Assigned cases cover failed/aborted usage and missing usage/default zero; price
basis/rate/model/window/convention/amount gaps; reported/invoice separation and
explicit zero; raw-inclusive/unknown tokens and overlapping subclasses; stable
replay/fork vs real retry; Pi/ACP alias with/without mapping and a Pi/Temper map
whose missing canonical feed remains unknown; merged/separate/wait/snapshot
nonadditivity; legacy Temper amounts; original add vs assignment/wrong birth/
foreign valid task/latest parent/conflicting history; observed helper roles and
mixed home ancestry; UTC occurrence/Pacific DST; hostile content/extra/hidden/
symbol/accessor keys and bounded refs/tokens/decimal amounts; unavailable readers
and exception redaction; no mutable input retention or producer/runtime imports.
The #293 contract is unchanged, normal gates are unchanged, all roots/allocations
remain unknown and no source/SDK/settings/services/foreign-role data are changed.
