# Reporting funding adapter — W4 / Ops #320

Accountable lead: **Ops**. Pure reporting only. Owned paths: this document,
`server/usage-accounting-funding.ts`, and
`tests/unit/usage-accounting-funding.test.ts`. No runtime hookup or installation.

## H-WIRE-4 — written before implementation

Problem/evidence: Security #17, `docs/usage-accounting-security.md` at
`c7a0755c`, “Reporting evidence is not dispatch authority”, rules 1–6, records
that TaskRequester v1 is display metadata and no admitted native root/payer
producer exists. W0 provides closed numeric evidence seams, not funding
authentication. Treating a valid-looking requester, current parent or policy
label as authority would manufacture a reassuring budget from missing evidence.

One change/why: implement a pure, closed reporting adapter which separately
validates source-backed policy, original task/add and occurrence-time membership,
requester input/proposal bindings and independent payer/root evidence. It emits
#293 allocations only when the independently vetted native witnesses support
them; otherwise it reports concrete unavailable reasons and keeps observed usage
separate. No native evidence reader is installed or registered.

Expected/measurement: fixed USD 0.1 own + 0.2 requested + 0.3 Team yields observed
0.6, supported eligible 0.1 and exempt 0.5 only with complete independent fixture
evidence. Old/unknown requester defaults own only inside a verified in-scope
task. Replies alone do not confer requested exemption. Missing payer/root/task/
parent/coverage leaves remainder null. Test cross-role policies, wrong birth,
mixed/overflowing witnesses, reparenting, Monday and DST boundaries. Inspect the
diff for authority/runtime changes and run the normal sealed gate once after
implementation, followed by mandatory detached landing checks.

Falsifier: any display record or self-claimed trust mints funding, unrelated policy
pays, current parent replaces event-time history, missing evidence becomes zero
or USD 2000 headroom, numeric usage disappears, or a producer/capability/root is
registered. Owner-turn treatment is outside this task.

First gate: **MISS**. The shape-only validation envelope used an empty required
stream list, which #293 correctly rejects; this prevented even complete fixture
policy/membership/root evidence from being accepted. It did not grant funding.

### H-WIRE-4a — repair the validation envelope

Evidence: all supported funding fixtures failed closed with invalid evidence;
#293 requires a nonempty `requiredStreams` even when validating one metadata row.
Change: give only the internal shape-validation envelope one inert stream name;
retain the real input stream inventory and its coverage checks unchanged.
Expected: complete independent fixtures produce the exact split and all missing
or conflicting witnesses still produce unknown funding and null remainder. Also
correct the current-parent-substitution fixture to remain a valid numeric
contract while lying about its parent; a future-effective numeric membership
otherwise fails before funding validation. Falsifier: any missing witness starts
passing, real stream coverage changes, or supported fixtures still fail.
Stage result: **HIT**, all 76 fixed funding cases pass in the sealed affected
stage (288 ms). The exact split and the unavailable/adversarial paths both pass;
real input streams and runtime wiring are unchanged. Corrected normal gate and
mandatory detached landing result follow below.

### H-WIRE-4b — use the already-reviewed bounded gate invocation

Corrected gate: **MISS**, despite all 76 funding cases passing. The detached
service had no inherited `VITEST_MAX_WORKERS` setting. The unbounded suite hit
W0's unchanged 100 ms work guard and two existing role-message 5-second harness
deadlines. The earlier unbuilt worktree also lacked the systemd CLI's required
`dist/server/plugin-updater.js`; the normal isolated build now exists.

One invocation correction, not a source or limit change: use W0/#331's reviewed
`TZ=UTC VITEST_MAX_WORKERS=4 scripts/check.sh --fast`, explicitly inherited by the
detached service, with all 20 CPUs available. First isolate the doubtful collector
and role-message stages at that fan-out, then run the unchanged normal gate and
mandatory landing hooks with the same setting. Expected: the existing numeric,
100 ms, memory, callback, timeout and funding checks pass without changing any
assertion. Falsifier: any effective-cap failure remains; stop and report its exact
evidence rather than retrying unchanged or relaxing a guard.
Stage result: **HIT**, four selected collector/role-message checks pass in 51.33 s
(the name-filtered stage skips 227 unrelated cases; it is not the full gate).
The unchanged 100,000-attempt/65-source case measures 20.16 s ingestion, 23.31 s
replay and 7.13 s update/publication; maximum active work is 8.88 ms, parent fs
p95/max under load is 0.8/3.86 ms, heap/RSS stays below 33.42/199.74 MB. These are
synthetic harness results, not live reads or source admission.
Full normal gate result: **HIT**, `ops320-funding-gate4.service` exits 0 with
471 files, 7,341 passing tests and six existing skips in 207 s; protocol, PATCHES,
typechecking, lint and formatting pass. The genuine sealed descendants all retain
`VITEST_MAX_WORKERS=4`, with CPUs 0–19 available and no CPU quota or affinity
restriction. Mandatory detached landing remains required.

## Contract and independent evidence boundary

`projectReportingFunding(raw, { policyRef, asOf, staleAfterMs }, sources?)` is a
pure synchronous reporting projection over W0's closed `AccountingInput` numeric
contract. It does not discover files, read the network, register anything, write
spend, debit, dispatch, pause or stop. It is not imported by runtime code. Invalid
numeric envelopes fail with `invalid-accounting-input:<code>`; unavailable
funding evidence instead returns bounded reason codes without exception text.

The optional `ReportingFundingSources` callbacks are a **server-private,
independently sourced dependency boundary**, not a new trust primitive or
admission mechanism. They return closed, getter-free metadata projections. They
are not tool/client JSON, copied task fields, a caller-created root table, or
proof that an arbitrary supplied implementation is authentic. Supported fixture
results demonstrate the adapter's reading of already-verified witnesses, not
live authentication. This task installs **none** of these readers.

The reader admitted later must independently check these source facts, rather
than reformatting the proposed task or funding DTO:

| Port | Required source and binding |
| --- | --- |
| `originalTask(key)` | Actual original `add` event, keyed by queue and task number **and exact original birth**; native queue-session identity; complete original requester capture status; membership/reparent history from birth through the occurrence. Not the assigned event, today's display task, or today's parent. |
| `read("proposal", ref)` | Original native queue-add proposal/capture, bound to that task birth and queue session, proposal time, the exact requester record and **all** admitted inputs for the proposing turn. No user/agent-supplied `origin` or title/approval substitute. |
| `read("input", ref)` | Actual host-admitted input and its native acceptance time/session. For role messages, independently resolve the native role-message identity, sender and kind. A queued display record alone does not prove this. Preserve unknown capture explicitly; overflow or missing capture is unavailable. |
| `payer(factId)` | Independent native fact → task-birth → payer/scope/policy/root witness. A task's current role, observed worker role, project label or requester does not prove its payer. |
| `nativeRoot(ref)` | The independently vetted native store backing #293's existing `trusted-native/1` record, including its actual `evidenceRef`. A matching `provenance` string, requester record or arbitrary lookup is insufficient. No such producer is admitted today. |
| `read("policy", ref)` and `read("cap", sourceRef)` | Reporting policy plus independently checked owner decision/order establishing that role's initiative, cap, effective time, basis and zone. A display policy object or another department's policy is insufficient. For a relayed Board order verify its owner words/source, not simply the poster. |
| `read("rule", REPORTING_RULE_REF)` | Canonical owner answer `dr-e108f47f8033`, source `answer`, picked `Initiative, unless asked for`, with the actual recording time. Prose and an approval link do not establish a requester. |
| `read("team", ref)` | Independent owner Team exemption source `bp-b7f97619`, scoped to the actual Team initiative/scope. Never borrow Design's policy. |
| `policyCoverage(policyRef, from, through)` | Independently complete whole-policy subject and stream inventory covering the Pacific week through `asOf`, not a task subset relabelled complete. Its required streams must exactly match W0's; W0 still checks stream gaps, freshness, price and identity. |

### Closed records supplied by those readers

Every record below contains exactly the named keys; version tags are literals.
References are nonempty bounded metadata identifiers, times are canonical UTC
ISO strings. Task keys are `{ queue, task, addedAt }`. No raw chat, prompt, title,
request prose, request body, approval dialog or full source document is accepted.
Native readers must project at the source; never pass such a payload to the
adapter and rely on stripping it here.

- Policy: `{ v: "reporting-policy/1", policy: ReportingPolicy, initiative }`.
- Cap: `{ v: "budget-source/1", ref, from: "owner", kind: "answer" | "order",
  role, initiative, effectiveAt, weeklyUsd, basis, timeZone }`.
- Rule: `{ v: "funding-rule-source/1", ref, from: "owner", source: "answer",
  picked: "Initiative, unless asked for", recordedAt }`.
- Task: `{ v: "task-add/1", ref, queue, queueSession, add, requesterState,
  proposalRef, history, historyThrough }`. `add` is the source-projected original
  `{ v: 1, op: "add", id, ts, origin }`; `ts` is the original native millisecond
  birth. `history` contains closed #293 `TaskMembership` rows, strictly ordered
  from birth. Its final horizon must cover the occurrence and not exceed `asOf`.
- `requesterState` is `recorded`, `legacy-absent`, `overflow` or `unavailable`.
  Only independently verified historical **absence** can use `legacy-absent`,
  with both `origin` and `proposalRef` null. A modern missing/unread field is
  `unavailable`, not historical absence. `recorded` requires closed, valid v1
  requester metadata plus original proposal and input witnesses. Unknown-only
  metadata is allowed only when independently captured and bound, not invented
  to fill a missing witness.
- Proposal: `{ v: "task-proposal/1", ref, task, queueSession, proposedAt,
  origin, inputRefs }`. `origin` is that complete captured v1 record. `inputRefs`
  is a unique ordered one-to-one list of the admitted input witnesses.
- Input: `{ v: "requester-input/1", ref, queueSession, acceptedAt, input }`.
  `input` exactly equals the corresponding original requester's closed v1 input.
  Acceptance precedes proposal; proposal precedes original add.
- Payer: `{ v: "funding-payer/1", ref, factId, task, role, policyRef, scopeRef,
  rootRef, kind: "department" | "team", teamSourceRef, recordedAt }`. Department
  witnesses need a policy and null Team source; Team witnesses need null policy
  and the independent Team source.
- Root: unchanged closed #293 `DispatchRoot`, forwarded from `nativeRoot` only.
  Its scope, payer, policy and scope reference must agree with the independent
  witnesses, and its occurrence cannot follow the usage occurrence. Conflicting
  witnesses for one root invalidate every allocation sharing it.
- Team: `{ v: "team-source/1", ref, from: "owner", scopeRef, initiative,
  effectiveAt, uncapped: true }`.
- Coverage: `{ v: "funding-coverage/1", policyRef, from, through, observedAt,
  requiredStreams, wholePolicySubject: true }`.

Bounds: W0 page row limit (256); 32 requester inputs; 10 owner-forwarding hints;
256-character references; 256 history rows and at most 65,536 history bytes per
task; at most 4,096 source lookups per projection. Hitting a funding bound cannot
return complete funding or a remainder. Source errors are reduced to
`source-unavailable`; private error text is never returned.

## Reporting decisions, not authority

Eligibility, usage, occurrence-time membership and payer evidence are separate.
All numeric initiative usage remains visible even when funding is unavailable.
Input allocations, roots, policies and current memberships are **not** funding
witnesses: the adapter replaces those rows from the independent ports and never
modifies its input. Existing numeric aliases, snapshots, prices and coverage are
left to #293/W0's exact deterministic evaluation.

Inside an independently verified policy initiative and task:

- Legacy absence or a completely bound unknown-only requester is own work.
- An actual owner input or another role's question/request is requested work.
- A role reply (including `forOwner`/`ownerIds`) is not a request exemption. Nor
  is the payer role's own question/request. Owner-turn treatment is not added.
- Multiple requested inputs stay requested. Mixed own/requested input scopes
  are unknown; missing or overflowing evidence never yields a partial exemption.
- Team is separately exempt only with its independent payer and Team source.
- Missing task/birth, historical parent, payer, policy, requester binding or
  native root is unknown, not own or exempt. Policy mismatch fails closed.

Design remains USD 2000, list estimate, Monday–Sunday `America/Los_Angeles`.
Generic source-backed policy support creates no policy/cap. No foreign spend is
read or written. No capability, root registration, R0/RTPI admission, permission,
debit, stop or pause is produced.

Output contains independent `observed` usage, supported #293 rows, a separate
`budget` or null, and precise `gaps`. `remainingUsd` is null at **both** the top
level and nested budget whenever any funding prerequisite or numeric coverage is
missing. Supported eligible/exempt values remain lower bounds under partial
coverage. No admitted native producer means the live/default result is funding
unavailable, no forwarded roots, unknown allocations, retained observed spend,
and null remainder — never USD 2000 presumed available.

## Verification and C0 handoff

The unit fixtures are fixed synthetic projections, not authenticated live
sources. They cover the exact 0.1/0.2/0.3 split, old absence versus missing
binding, unknown, owner/browser/Telegram and peer requests, replies/self/hints,
multiple/mixed/overflowing inputs, original birth/proposal/session mismatches,
cross-role/unsupported cap/policy, missing payer/root/coverage/Team sources,
reparenting, conflicting roots, numeric gaps, Monday and both DST boundaries,
source exceptions, payload/accessor rejection and the W0 page limit. Existing
transitive importer guards also have to stay green; no runtime import is added.

Gate result: **HIT**, the normal `TZ=UTC VITEST_MAX_WORKERS=4 scripts/check.sh
--fast` passes all 471 files / 7,341 tests (six existing skips), including the 76
funding fixtures and unchanged numeric/privacy/importer/crash/lock checks. The
normal worktree build also passes. In the full gate, W0's unchanged 100,000-row
case updates/publishes in 11.49 s, uses at most 30.74 ms per active work unit,
and retains parent fs p95/max 1.3/11.45 ms and heap/RSS below 33.57/239.79 MB.
Earlier failed gates remain failed; no guard or assertion was relaxed.

Landing runs detached with the same inherited four-worker setting and normal
mandatory checks; the queue completion supplies the resulting receipt/commit.
There is **no deploy/install/restart** for this task. Undo is a normal revert of
this patch's three files through `wt`; there is no live state to undo.

**Unresolved before C0 admission:** native original-task/proposal/input, payer,
root and whole-policy coverage readers are not admitted by this task. S0's
reviewed boundary is unchanged. Their actual source existence, full input/birth/
incarnation bindings, independent principal readback and permitted runtime
admission must be proved separately. A future caller must not turn these test
ports into JSON/tool endpoints or fill them from display DTOs. The supported
fixture path is not an authority-source receipt or activation approval.
