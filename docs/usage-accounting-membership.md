# Task/session membership — inert metadata map

## H-AUTOCOST-6 (written before implementation)

Wrong/evidence: the #293 contract has event-time parent snapshots, but nothing
maps persisted chat files to original queue tasks. An assignment's timestamp is
later than the original add; applying today's parent to older calls is wrong.

One change: a deterministic, read-only metadata map using queue replay, original
adds, registry project/initiative history and explicit session/parent IDs only.
No title, folder, role, prose or time-proximity match is allowed.

Expected: fixed synthetic task/chat/fork/delegate/helper/re-run and mid-week
reparent fixtures produce exactly the specified membership and history rows.
Home/ad-hoc/unnamed-helper sessions remain not in any task. Missing/unreadable
records give explicit gaps. Planted plans, contents and tool results are never
accessed or emitted. Falsifier: backward application of a latest parent, any
heuristic assignment, a home chat assigned by proximity, or leaked payload.

Ops #305 · automatic-cost-accounting · accountable lead: Ops.
No production importer, source scan, filesystem access, model call, timer,
queue/registry/session write, installation or deployment. Contract #293,
collector #300, capture #301 and the task-4 session reader remain unchanged.
The normal unchanged landing gate is required separately from fixed unit cases.
Undo: revert this task's commit; no journal or live-state migration exists.

## API

`server/usage-accounting-membership.ts` exports:

- `mapUsageMembership(sources, clock?)`: pure, deterministic mapping of explicitly
  supplied metadata pages. `clock` measures the work budget; timestamps come only
  from the records, never from the current clock.
- `MEMBERSHIP_LIMITS`: the five pinned numeric caps, tested against #300.
  `MembershipSourceBatch` is structurally checked against #300's batch type in
  tests. Neither a runtime nor a type-only collector dependency is introduced.
- Source-side allowlists: `projectMembershipSessionEntry`,
  `projectMembershipRegistryEvent`, `projectMembershipConversation`,
  `projectMembershipDelegate`. Non-queue session messages are skipped by type;
  their bodies are never opened. The map also applies these projectors itself.
- `taskMembershipAt(map, file, occurredAt, origin)`: conservative lookup of the
  unique file interval and latest **earlier-or-equal** canonical parent snapshot.
  It returns a detached #293 `TaskMembership`, or null before assignment, for an
  unassigned file, for `origin: app`, or if **any** source gap exists. Inspect
  `gaps` to distinguish unassigned from insufficient evidence. A future adapter
  must supply the native occurrence time and origin, not today's time.
- `membershipSourceBatches(map, context)`: only canonical parent snapshots enter
  #300's `rows.memberships`. No file mapping or gap object is put in NumericRows.
  Native stream/incarnation/adapter, coverage times and one cursor token per
  chunk are injected, never invented from row counts or timestamps. At most 256
  rows per batch. Every batch is `partial/reported-gap`, even on a clean map:
  metadata alone cannot establish usage/occurrence coverage or budget authority.
  A token-count mismatch returns no batches rather than fabricating tokens.

Each `MembershipPage` has `status`, `bytesRead` and `records`; session pages also
have `file`. Status is complete, partial, missing, unreadable or unsupported.
Missing/unreadable/unsupported pages supply no evidence. Partial pages preserve
known metadata but carry an explicit gap. No default source paths or readers
exist. Adapters must report unreadable/invalid JSON as a status, not exception
text. `bytesRead` counts skipped payload bytes too; it is injected source
information, not authenticated by this module.

Output (`v: usage-membership-map/1`):

- `memberships`: `{queue, task, addedAt, file, sessionId, from, until}`. The task
  key uses the original queue file, numeric task ID and original add time.
  Intervals are half-open; null `until` means no later recorded reassignment,
  **not** a claim that the source is complete. Finishing a task does not erase
  ownership of its own historical chat. A recorded later task/file binding closes
  the earlier interval. A fork inherits at its own creation, not at a parent's
  later reassignment; a same-session-ID copy shares the explicit bindings.
- `parentHistory`: exact #293 rows with
  `{queue, task, addedAt, project, initiative, effectiveAt}`. Task-parent and
  project-to-initiative events are composed at their effective times; unchanged
  snapshots are coalesced. Parent clears
  preserve older rows. Assigned's later timestamp never replaces add's birth.
- `notInAnyTask`: known session file/ID pairs without any witnessed membership.
  With gaps this is an **unmapped** set, not proof there never was a task. Null
  file app observations do not mint fake session/file rows.
- `gaps`: fixed `{code, file, task}` metadata only, no raw errors or prose.
  Codes include source status, missing add/header/session/parent, ambiguous file
  or membership, parent cycle, registry sequence, event-time order, in-chat task,
  invalid metadata and byte/record/work limits. A capacity/shape failure clears
  every derived row rather than returning a deceptively usable partial join.

## Boundary and replay

The map consumes bounded **metadata pages** projected at the source. It never
serializes, hashes or copies a session/model/request body. The projection
helpers access only whitelisted own data properties; plans, messages, contents,
tool arguments/results, names, roles, cwd and summaries are not traversed or
returned. Accessors on allowed metadata fields fail closed; accessors on forbidden
payload fields are not touched. Fixed fixtures include both planted private text
and throwing payload properties. There is no input discovery or filesystem call.

Limits pin #300-compatible values (unit-tested for parity, without importing its
inert module): 262,144 native bytes per call (including skipped bytes),
independently capped projected bytes, 256 records per page, 64 session
sources, 10,000 total input records/derived rows and a measured 100 ms work budget.
This is a bounded stateless metadata unit, not an unbounded history scanner.
A large/truncated native source must be reported as a gap; this task does not
invent paging cursors, retention completeness or a live adapter. An input page
must already be bounded before allocation in a later wiring task.

Queue authority is `server/task-queue.ts`'s `taskQueueAll`, using the metadata
projection of pi-queue's v1 operations. `add.ts` is the original birth;
`assigned.ts` is not. Start+chat is replayed, so rejected chat changes and edits
after task completion do not establish new bindings/parents. An assignment names
its original queue file and task; the add must actually exist there. A re-run in
a fresh chat reuses that key. A copied queue cannot mint fresh task births; among
same-ID queue copies only a uniquely recorded original queue reference can choose
an original file. Ambiguity is a gap, not a filename tie-break.

Registry history follows pi-queue/work-store.ts v1 `seq`, `ts`, project.create and
project.change.changes.initiative. No latest-state index replaces event history.
Task links are only an index and cannot replace a missing original queue add.
A missing sequence stops replay; regressing times are gaps. A project seen only
after a task's birth is not applied backwards. Missing parent metadata is explicit
and cannot be turned into a verified call link by `taskMembershipAt`.

A native session header supplies id, timestamp and optional parentSession (a file
path). Fork/clone ancestry is followed transitively; copied pre-fork assignment
entries are not new assignments. Same-session-ID resume/copy files share witnessed
bindings, not a filename convention. Cycles and inconsistent witnesses are gaps.
No task is inferred from a title, path prefix, folder, role, prose or proximity.
A home chat with queue entries is not itself a task chat; an in-chat task lacking
a separately recorded task file is an explicit unsupported association.

## Helper and delegate witnesses

Ops lead's late fact (same approved scope): #306 is building an append-only usage
ledger. No #306 code is read/imported or required here. The **synthetic** helper
witness interface uses its field names directly:

`{v: "usage-ledger/1", conversationId, sessionId, sessionFile, persist, origin,
parentConversationId, at, occurredAt}`.

Conversation ID is not session ID. Both helper and parent need explicit, time-valid
conversation-to-file/session witnesses. The parent record selected is the latest
one at or before `occurredAt` (fallback `at` when absent), never a later record
backfilled into the past. The child inherits the task its parent file belonged to
at that observation time. Repeated observations may extend the same binding, or
record its next interval when the parent's task changes; the last record is not
applied to earlier observations. A helper without a named parent remains outside
tasks. Conflicting spawn-parent IDs are gaps. `origin: app` never supplies an edge
or a parent witness, even when it names a task file; callers must pass that native
origin into the lookup so app overhead is always unassigned.

ACP source inspection found `delegate-tool.ts` returns `details: undefined`:
its current parent transcript has the runId in prose, not a durable structured
parent witness. That prose is forbidden here. The prospective delegate interface
is `{runId, parentFile, file, ts}` with an explicit source-owned ID/file/parent
witness. Fixtures exercise it, **not** an installed ACP producer. A real source
without this witness must be marked unsupported; it cannot be recovered by reading
a message, prompt or tool result. This task does not change that producer.

## Verification

First fixed check: **MISS (36/39 passed)**. Exact map/history and privacy cases
passed. The two collector checks gave the test adapter an unknown retention
start (`retainedFrom: null`), which correctly prevents a committed cursor. The
inert-source assertion also confused the required `usage-ledger/1` version tag
with a native ledger path.

### H-AUTOCOST-6-CHECK-1

Evidence/change: repair only that test evidence: give the synthetic adapter its
known fixed retention start; distinguish absolute ledger paths from a version
identifier. The map remains unchanged. Expect all 39 fixed cases, including
collector commits and the version-bearing projector, to pass. Disproved by any
map/history/privacy mismatch or a still-rejected batch. Final result and the
unchanged normal landing gate were pending at that checkpoint.

**H-AUTOCOST-6: HIT on the fixed synthetic bar.**
**H-AUTOCOST-6-CHECK-1: HIT.** First repaired fixed check: 39/39 passed with
`TZ=UTC scripts/sealed.sh node_modules/.bin/vitest run tests/unit/usage-accounting-membership.test.ts`.
The exact fixture has eight file memberships, five parent-history snapshots and
five unassigned sessions, with no gaps. Collector accepts the fixed batch and
both chunks of the 300-row case. Native/projection budgets, forbidden-property
accessors and planted-text checks pass. Prettier, test typecheck and module lint
also pass. No production importer exists.

### H-AUTOCOST-6-INERT-1

First normal gate: **MISS**. The combined gate and its automatic solo fallback
both found the same collector isolation failure: this module imported the inert
collector for limits and a batch type. The solo gate otherwise passed 7,068 tests;
the exact membership cases still passed. Nothing landed.

One change: remove that dependency entirely. Pin only the five numeric limits
this module uses, and describe the structural batch shape using #293 types.
Unit tests must prove limit parity and assignment to #300's batch type. No
collector, contract, capture or reader edit, no guard bypass and no wiring.
Expect unchanged exact rows and all fixed/collector isolation checks to pass,
then the unchanged normal gate. Disproved by a dependency match, limit or batch
type mismatch, changed fixture rows, or another gate failure.

**H-AUTOCOST-6-INERT-1: HIT on the repaired fixed/isolation bar.** All 40
membership tests and all 83 unchanged collector tests pass together (123/123),
including exact rows, all batch commits, policy parity and the no-dependency
assertion. Full typecheck, scoped oxlint, Prettier and a fresh sealed build pass.
The detached normal landing gate remains pending; it must also succeed.

The unchanged normal gate remains a **landing prerequisite**, not a claim made
by the unit result: detached `wt land` must succeed before #305 is done. Its
receipt names the final checked commit, including a rebase if mine moved.
No install or deployment is part of that receipt.

The unit file checks exact fixture rows,
negative association cases, event-time parents, ignored replay events, helper
ledger observations, app overhead, explicit gaps, collisions/cycles, source and
projected budgets, accessors and planted-text exclusion. It also submits fixed
and 256/44-row batches to the unchanged collector using in-memory **test-only**
numeric I/O, and asserts no production importer. Nothing reads a real chat,
queue, registry or usage ledger, and nothing installs or deploys this module.
