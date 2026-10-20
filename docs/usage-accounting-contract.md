# Usage accounting contract v1 — inert reporting foundation

Ops #293 · project `automatic-cost-accounting` · accountable lead: Ops.

**Status: interface frozen for synthetic consumers; not a live meter.** This
module has no I/O, production importer, timer, service, native-authority
registration, budget debit or stop. No collection, backfill, installation or
activation is included. Producer coverage and authenticated allocation remain
incomplete; a complete automatic budget numerator is **not READY**.

## H-AUTOCOST-0

Wrong, with evidence: `server/roles-spend.ts:1-177` reads manual v1 `spend.json`;
there is no shared numeric accounting/attribution contract.

One change: an inert, closed, versioned accounting contract, exact decimal
fixtures and pure validators/projections. Independent producers/readers can
implement against it without guessing overlap or eligibility.

Expected: exact totals and explicit coverage on fixed known cases. Disproof:
duplicate/omitted costs, unsupported price certainty, or exemption/headroom
inferred from display metadata. Verification result is recorded at the end.

## Decisions and provenance

- Owner approved this foundation's plan in Ops (request m61256); no runtime
  collection, new authority, spending, stop or deployment is approved here.
- Architecture `rm-2474e787` answers `rm-780e2318`: separate `usage-fact/1` and
  `allocation/1`; native aliases for shared Pi/Temper charges; immutable root
  and event-time policy facts; no installed authenticated own/requested ROOT.
  Reporting-only collector/UI need no Owner decision. Origin/R0/RTPI remain
  unregistered/inert. Membership is not eligibility; helpers' payer is separate
  from origin. Corrections retain history.
- Temper `rm-99a8aa33` answers `rm-3489930b`: current summaries are not a
  historical per-call ledger; price basis/zeros and immutable attribution are
  unproven. No safe per-call endpoint or supported task binding exists. Future
  numeric cursor feed/origin stamp is a proposal, not approved/implemented.
- Ops forwarded both inputs in `rm-7b0329ce`; the previous dependency is
  satisfied for **this inert contract**, not for complete live accounting.
- Public canonical decision `dr-9f87e79c317d`, source `answer`, from `owner`,
  was checked in the shared decision-record store, not an identity folder.
  It selects "$2,000 per week" for System Arch in Temper, list-price chats and
  workflow runs including subscription use; unrelated requests stay outside,
  and activation/publish/buy/task approvals remain separate. Policies must be
  generic source-backed refs, **not hard-coded Design-only**. The contract
  registers neither this policy nor Design's at runtime.

## Frozen public interface

`server/usage-accounting-contract.ts` is the single interface source:

- `parseAccountingInput(unknown)` rejects unknown fields, unsupported versions,
  unsafe/noninteger tokens, invalid UTC dates, wrong identities/binding times,
  floating/exponent/negative money, mismatched currencies and unpriced zeros.
  It returns a typed v1 envelope or a bounded validation code. There are no
  payload bags, prompts, contents, tool arguments/results or error strings.
- `UsageFact` (`v: "usage-fact/1"`): identity, occurrence, actual provider/model,
  assistant/cache-warm/compaction/delegate kind, four nullable numeric token
  classes, separate price bases, numeric-source provenance/coverage, nullable
  task/session/run links. An actual retry/warm/compaction is its own attempt.
- `Allocation` (`v: "allocation/1"`): separate fact ID, root ref or null,
  own/requested/Team/unknown, policy ref, payer role, record time and closed
  reason. A display requester/creator/approval/lead, prose, initiative name or
  the existence of a task link can never supply it.
- `DispatchRoot` and `ReportingPolicy` are read-only **fixture/projection**
  records from an eventual vetted native store. Supplying a string labelled
  `trusted-native/1` to a pure function does not authenticate it or install a
  root. A future collector MUST verify provenance against a supported approved
  native source before populating `roots`; absent source means empty roots and
  unknown allocation. This is not an authority-registration API.
- `IdentityAlias`: prospective native same-call mapping, with evidence ref,
  explicit canonical fact. It is not a match by timestamp/model/amount/content.
- `RunSnapshot`: producer/incarnation/run upsert, never an additional charge.
  Ended snapshot/list-equivalent totals can check complete mapped leaves;
  missing leaves, coverage or reconciliation become faults, not fake zero.
- `SourceCoverage`: required-stream inventory, covered occurrence interval,
  observation time and completeness; no declared stream coverage means no
  complete current numerator. A stream list alone does not prove it includes
  every cost-bearing path: the collector owns that source inventory.
- `TaskMembership`: original canonical queue/task/add identity and immutable
  project/initiative/effective-time snapshot. `memberships` is canonical parent
  history, not today's display projection. Native capture must validate it.
- `accountUsage(input, {policyRef, asOf, staleAfterMs})`: pure report with
  gross observation subtotal, deduplicated known list subtotal, verified-own
  lower bound, exempt/other-policy/unallocated subtotals, unpriced/unresolved
  counts, other bases, faults, coverage, freshness and nullable remaining USD.
  No budget permission or automatic stop follows from the returned balance.

### Exact arithmetic and price certainty

All money is USD decimal text: at most 18 whole and 12 fractional digits per
input amount. BigInt pico-dollar arithmetic gives exact sums; output strips
trailing zeros. `quoteListUsd()` takes versioned USD-per-million rates for
**exclusive** input/output/cache-read/cache-write token classes; native producers
must normalize overlapping provider conventions. Missing classes return null;
sub-pico-dollar results fail `price-precision`, never silently round. The rate
version and actual model/provider are required facts, not a default 3/15 model.

`list-estimate`, `provider-reported` and `invoice` amounts remain separate.
Neither subscription list estimates nor provider-reported numbers prove invoice
accuracy. A known list amount needs a rate version. Missing/unproven/unknown
model means null, not USD zero. A source-backed, versioned known zero is allowed.
Unsupported currencies must be projected as unknown USD-equivalent, not relabelled
USD. Current unmarked Temper zero does not qualify as a known free call.

### Identity, replay, overlap and corrections

`factId()` encodes `["usage-fact/1", producer, incarnation, attempt]`; source event
IDs are preserved separately. A process restart must retain the original source
incarnation and actual attempt stamp, not mint fresh identities for replay.
Fork/copy history retains original stamps and counts once; real retries count
again. A foreign file path, byte offset, session filename or wait response is
not an actual charge identity. Source-event collisions, unresolved identity,
conflicting aliases, cycles, missing targets and inconsistent charge data are
faults, never an excuse to choose a cheaper observation or add all of them.

An alias selects an explicit canonical producer observation. Comparable known
prices, token classes and actual provider/model/time/kind must agree; conflicting
attribution or event-time task membership invalidates allocation. No guessing
cross-source precedence from maximum dollars or latest file order. An alias's
unknown price cannot certify its canonical observation's otherwise unknown cost.

Facts and allocations have revision 0, then consecutive revisions with explicit
`supersedes`. Exact same-revision replay is idempotent; missing history/conflicting
same revision is a fault. Selected corrections never add to prior revisions.
Original occurrence and membership may not be rewritten by a later correction;
retain the entire source history. A collector's durable cursor must atomically
persist these records before advancing and tolerate reread after a crash.

ACP separate totals, merged tool-result reports and repeated waits are reporting
views of the same attempts, not new calls. Native mappings or original stamps
are required; absent identity stays unresolved. Temper agent/run/Pi-session
aggregates and their leaves must never all add. Run snapshots are upserts by
producer/incarnation/execution, including resumed observations, not additive
turns. `reconcileTemperUsd()` demonstrates exact current numeric precedence:
per agent max(ended amount, sum(call ends)); retired attempts count; interrupted
agents use available calls; parked note is a **display floor**, not additional
spend; final stored totals win. That projection is **not** a list-price ledger
or an extra charge beside leaves; unmarked basis/coverage remains unknown.

### Task, event time, allocation and policy

`taskId()` includes queue, task number and original **add** timestamp. Resolve the
original add through the canonical parent queue. Child assignment time is later
and is not a substitute. Reused task numbers, foreign queue IDs, missing history
and mismatched parent snapshots cannot establish verified bindings. Gross known
cost is still visible when binding is wrong; budget allocation becomes unknown.

Later project reparenting does not rewrite earlier calls. Pick the canonical
snapshot effective at each call's occurrence. Budget membership is separately
recorded at dispatch/call time. Feedback inherits only a verified root; a new
request is a new root. Missing/mixed ancestry and home-chat turns without a
trusted source remain unallocated/unknown. Root origin does not assign a
helper's cost to another role; payer must independently match verified records.

Use call occurrence, not task-add, resumer, observation or file-import time.
Weeks are Monday–Sunday `America/Los_Angeles`, including DST; `pacificWeekStartUtc()`
computes the precise Monday instant. Full coverage starts no later than that
instant and extends through as-of. `staleAfterMs` is an explicit reader setting,
not an extra policy limit. Incomplete producer/price/identity/allocation/binding,
stale observations or conflicts make remaining USD **null/UNKNOWN**, never a
green balance. Subtotals, including a zero lower bound, are not a complete total.

Existing Design own-goal USD 2000 Pacific-week and requested/Team exemptions
remain. Other source-backed scoped policies (including Architecture's above)
can be represented without reinterpretation. No spending, activation, cap,
stop, pause, consent or review boundary changes. No foreign `spend.json` or its
`stopped` value is read or overwritten by this module.

## Source/boundary map and concrete missing producers

Only public source code and a shared canonical Owner decision were read. No
real-session scan/test or provider/model/workflow call was made.

| Source rechecked | Numeric facts / boundary | Missing before complete automatic numerator |
| --- | --- | --- |
| `server/roles-spend.ts:1-177` | Strict manual v1 display; existing regular-file/no-link protections. | Automatic typed reader, coverage display; no manual-file overwrite. |
| `server/serialize.ts:296` | `usageCost` projects assistant `usage.cost.total` only. Numeric UI projection, not a ledger, price-basis guarantee or complete cache-warm tally. | Original attempt/source identity, basis, nonassistant usage and safe native projection. |
| SDK 1.0.1 `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:3340-3398` | `getSessionStats()` sums all entries: assistant, nonmessage usage, compaction/branch summary and tool-result usage. Aggregate is not another charge. | Prospective actual-attempt/kind stamps incl failed/aborted **reported** usage, copy/fork provenance, price version and immutable allocation cause. A failure without recorded usage is unknown, not free. |
| SDK `dist/core/cache-warmer.js:237-253`, `dist/core/session-manager.js:864` | Successful nonerror/nonaborted `appendUsage("cache_warm", provider, responseModel ?? model, usage, ...)`. Assistant-only scans omit it. | Same native call/root/task capture for warming; do not start warming for proof. |
| `/home/shinelay/projects/billion-context-pi/src/delegate-tool.ts:231-242,491-509,647-680,1003-1047,1824-1826,1885-1892` | Numeric usage accumulation; separate/merged report and wait `usageReported` guard. `safeCost()` drops all-zero, not proof of free. | Durable original attempt/leaf-to-report mappings across replay and native root inheritance; copied report must not mint a charge. |
| `/home/shinelay/projects/pi-queue/work-store.ts:116-146`, `queue.ts:494-547`, `index.ts:1064-1085`; `server/task-queue.ts:129,552,1019` | Registry TaskLink keyed queue/task/original added; queue parent authority. Child assignment lacks original birth and has a later `ts`. | Supported native producer that captures validated original add and event-time parent atomically at launch/call, preserving across retries/reparent. Display/registry latest state alone is insufficient. |
| `server/work-records.ts:1-14,71-79` | Display reader skips task links/state; metadata is not budget cause. | No authenticated native own/requested ROOT is installed. Reporting-only source needs separate owner-role review; root/R0/RTPI activation is NOT a dependency of fixture-based readers and is NOT approved. |
| `/home/shinelay/temper-ai/temper_ai/llm/service.py:324-341,460-485` | Prefers provider `total_cost_usd`, else estimates; stored branch/basis unmarked. Pi estimate and absent-to-zero are not universal list/invoice certainty. | Temper-owned versioned numeric feed with actual model/token classes, price basis/version/status and coverage; never copy raw responses. |
| `/home/shinelay/temper-ai/temper_ai/observability/run_totals.py:43-167` | `_spend_rows():99-115` numeric SQL JSON projections only; reconciliation as above. Floats/legacy missing-to-zero cannot establish decimal price certainty. | Event.id + instance, Pi `llm_call_id` UUID5 replay identity and explicit Pi/leaf/run alias mapping; failures may have missing usage. |
| Temper `api/routes.py:523-526`, `api/data_service.py:625-638` (public source at `c25cbdec2552bc47fa1897043b91ce44b486f1cb`; bounded reply at `ba93355ecd12`) | GET `/api/workflows?limit=&offset=` summary listing scans newest 1000 starts; not historical coverage. No safe per-call endpoint. | Future numeric cursor feed with event/call/run/agent IDs, occurrence/provider/model/token/basis/coverage and optional trusted-launcher `origin_ref` atomically bound to execution, preserved on resume/parent fork. No supported queue/task/project/initiative binding now; `caller.action` after launch is best effort. Never use full `/api/workflows/{id}`, arbitrary Event.data/error strings, inputs, names, paths or latest resumer as substitutes. |

Bundled SDK docs fully read: `docs/sdk.md`, `docs/session-format.md`,
`docs/extensions.md`, `docs/message-types.md`, `examples/sdk/06-extensions.ts`.
No SDK/package change or runtime hook is proposed/installed here. Hook-specific
follow-up must read remaining linked docs relevant to the chosen hook.

## Noncolliding follow-up assignments and real dependency edges

All tasks use the landed #293 interface and synthetic fixtures; no P3 dependency.
Collector, capture and Roles adapter can run **side by side**. Wiring/activation
is separate, depends on tested delivered producers, and needs its own approved
plan. Explicit UNKNOWN lets reporting proceed without waiting for new authority.

| Assignment / owner | Exclusive module, test, doc | Result/dependency |
| --- | --- | --- |
| Collector / Ops | `server/usage-accounting-collector.ts`; `tests/unit/usage-accounting-collector.test.ts`; `docs/usage-accounting-collector.md` | Numeric-only adapter/cursor/append-only persistence/replay using this contract. No real/private scan bypass. Unsupported source/basis/cause remains unknown. Temper source needs Temper's feed result, not DB scraping. |
| Native capture boundary / Ops (coordinate producer owners) | `server/usage-accounting-capture.ts`; `tests/unit/usage-accounting-capture.test.ts`; `docs/usage-accounting-capture.md` | Native numeric identity/cause/task snapshot projection into the contract, no registration of held authority. Separate prospective queue/ACP producer tasks need exclusive files assigned by their owner; Temper owns any engine/feed changes. Exact prerequisites are in the source table. No manual/model classification. |
| Roles adapter / Ops | `server/usage-accounting-roles.ts`; `tests/unit/usage-accounting-roles.test.ts`; `docs/usage-accounting-roles.md` | Fixture-backed reader of report with separate basis, gross/dedup, lower bound, exemptions, unallocated/unpriced, coverage/as-of/faults and UNKNOWN remainder. Sole owner of eventual `roles-spend.ts` integration; do not overwrite foreign/manual state or claim a stop. |

Shared groundwork is this contract only. Each task owns its own module/test/doc.
A final wiring task consumes all three tested outputs; producer implementation,
consent review and release are distinct results, not permission inferred from
the accounting schema. The source-backed runtime-cause and complete numeric feed
are **concrete missing producers**, not blockers to parallel inert readers.

## Fixed verification and current limitation

`tests/fixtures/usage-accounting/ledger.json` is fully synthetic and explicitly
uses `fixture-only:*` root evidence; no actual authenticated root is claimed.
`numbers.json` fixes exact decimal prices/rates/tokens and both DST transitions.
`tests/unit/usage-accounting-contract.test.ts` covers main+warm; ACP separate,
merged/wait replay; Temper snapshots/leaf/Pi alias and current reconciliation;
fork/retry/compaction; unknown/zero/basis/price conflicts; binding/reparent; native
requested/Team/unknown/mixed home turns/helper payer; generic policy refs; Pacific
Monday/DST; partial/stale/as-of, correction history and malformed foreign records.
Red controls reproduce assistant-only omission, ACP `.16` vs `.13`, run+leaves
`.20` vs `.10`, false zero/headroom and latest-parent substitution.

Pre-gate adversarial review found a counterexample to the first projection:
an unpriced primary with a priced alias could bypass snapshot comparison, and
conflicting snapshot replay could change the fault count. H-AUTOCOST-0 is not
accepted on that draft. H-AUTOCOST-0A: reconcile snapshots against the same
merged per-basis charge identities used in totals; unavailable comparison is
partial, and each ambiguous snapshot version is excluded deterministically.
Known alias membership conflicts also invalidate allocation independently of a
null primary binding. Expect no headroom for a mismatched/unpriced snapshot and
the same report for each permutation/replay of contradictory snapshots.
Disproof: any alias-supplied price bypasses comparison, conflicting membership
retains allocation, or replay order changes the report. Fixed regressions are
included in the required final gate; its result is recorded with task #293.

A second pre-gate review found cross-week run leaves missing from the week-only
reconciliation lookup. H-AUTOCOST-0B: retain merged evidence for all observed
covered attempts, applying the Pacific-week filter only to report subtotals.
Expect a reconciled USD `.20` cross-week run to show exactly `.10` in the
current week with complete synthetic coverage. Disproof: historical cost enters
the current numerator or a valid earlier leaf still makes reconciliation fail.
The exact positive control is included in the required final gate.

Verification gate: after the isolated build, normal `wt land` runs the unchanged
`scripts/check.sh --fast` (including these fixed cases, full unit tests, all five
typechecks, lint, formatting, protocol and patch checks). The immutable land
receipt and task #293 completion record the actual HIT/MISS; this document does
not preclaim a pass. A moved base triggers normal rebase/rechecks, never a bypass.

Contract and source map deliberately expose incomplete native identity/cause/basis/coverage;
passing synthetic cases will not establish live coverage, invoice accuracy or
permission to install/activate. No normal test, threshold or land check is removed.
