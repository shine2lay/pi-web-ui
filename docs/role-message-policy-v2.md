# Doubled role-message policy (Ops #453)

Accountable lead: Ops. Owner requested double and chose Both (67477/67481).

## Hypothesis H-MSG-DOUBLE-1 — not yet measured

Evidence: the active native, host, core and approval adapters enforce 20/hour,
6 free, lower through 11, Owner from 12 and grants of at most 5. The Owner's
new policy is recorded in global AGENTS 29 but is not active. Consistently
versioning the expanded domain and selecting one shared active policy should
reduce unnecessary approval interruptions without changing authentication,
authority or consent. Expected: 40/41 hourly and 12/13/22/23 depth boundaries,
new quantities 10 accepted and 11 refused; existing records remain exact.
Falsifiers: any active path retains old limits, permits an excess, expands an
old grant, evicts still-chargeable usage, loses an accepted handoff, or fails
a safety/normal gate. Record HIT/MISS and actual receipts after measurement.

## Compatibility and activation design (before edits)

Two normal checked land/install phases are required: the previous reader's
`guardStateIsValid` accepts only store v1 and grant maximumUses <= 5.

1. Compatibility reader: keep active GuardPolicyV1 (20/6/11/12/max5). Add
   immutable GuardPolicyV2 (40/12/22/23/max10), a versioned binding quantity
   domain and a reader for mixed v1/v2 histories. Keep V1's type, literal
   values, fixtures, hashes and rollback_depth_6 semantics unchanged. All new
   requests use the selected active policy. Existing binding/decision/grant
   bounds are interpreted with their recorded version, never today's policy.
   Do not rewrite stores during startup. A normal atomic core transaction
   marks the store v2 when it first contains a v2 approval binding. Keep the
   journal envelope and operation/receipt ABI v1: changing an operation key
   on activation would reopen idempotent operations. Their digests stay exact.
   The original reader must reject v2 stores, not silently reinterpret them.
2. After a verified compatibility installation, activate V2 by changing only
   the shared active-policy selection and the documented activation state.
   Native/fallback, host, core, quantity validation, schema and explanations
   read the same selection. Native fallback is depth-only through the active
   free boundary, not an approval bypass. No ladder/wake/hold switch changes.

Lower requests must fit the remaining band exactly: 13–22, max10, never
clamped. Owner's finite default band is 23–32; it cannot expand from a later
hop. No distinct lower approver may still use Owner fallback at an earlier
hop, with at most ten sends and the same fixed upper endpoint. Decisions on
old pending requests retain original quantity/tier/scope/expiry. one_send is
exactly one. Every grant still expires one hour after its actual decision.

## Undo before deployment

Before V2 records exist, the compatibility phase can use the normal installer's
previous-build rollback. After activation, never install the pre-compatibility
build. Retain the compatibility reader and normally land/deploy a forward
inverse of the active-policy selection (V2 -> V1). It must still read new data,
preserve words/usage/accepted delivery and keep existing grant fields exact;
new sends obey the restored stricter limits and cannot use lower authority
above the restored lower ceiling. Do not restore settings, message or journal
snapshots. Unknown/corrupt/unsupported versions fail closed.

## Fixed-input proof and rollout receipts

Not yet activated. Tests use isolated temporary stores, never real chats or live sends.
Keep frozen V1 replay/golden vectors explicitly bound to V1. Add V2 native,
host and core boundaries, hourly floods/reload/multiple capped roles, mixed
legacy requests/grants/TTL/uses, first-answer/scoping/authentication/holds,
atomic recovery/concurrency/restart, old-reader rejection, and counterfactual
old-policy controls. Independent static review precedes the normal sealed gate.
Each install includes the normal authorised installer health checks and
passive startup policy metadata only; no live tool-schema/request dumps.

### Compatibility phase fixed-input proof

- Independent read-only review `sa-db8533d1`: no production safety defect;
  all reported test blockers and inverse-policy coverage gap resolved. Final
  verdict no P0/P1/static blockers, compatibility-only installation subject
  to normal gates. No activation approval or runtime change inferred.
- Focused-fix4 `ops-453-focused-fix4.service`, invocation
  `cde3f894bccf4a0288eb174cf2975ac8`, `/tmp/ops-453-focused-fix4.log`, exit0:
  116/116 core/host tests. Fresh-start39/39 and full typecheck passed in
  focused-fix3. The original focused run covered the other22 files; normal
  full gate follows. Previous-reader e2e candidate is explicitly V1-bound;
  its historical hard6 assertions and pinned previous implementation remain.

### Failed pre-install attempts (preserved)

- Typecheck attempt 1: four fixture errors. Test consumers incorrectly used the
  policy version as the frozen contract ABI; retain the original v1 consumer pin.
  Owner questions expose quantity through `ownerQuestion.binding.quantity`.
- Focused sealed attempt 1: `ops-453-focused.service`, invocation
  `5305374905124478af30bc8c40ce5821`, `/tmp/ops-453-focused.log` (0600), exit1:
  595 passed,9 failed,1 skipped across25 files. No production boundary assertion
  failed. New tests assumed the core returns its internal duplicate wrapper
  (it returns the original accepted result), tried a second request in an
  occupied scope slot, used the wrong question field, or expected unavailable
  rather than the old reader's fail-closed unknown. Five legacy log assertions
  omitted the new passive marker. Fix test/API binding only; preserve their
  V1 numeric/log vectors and explicitly bind the fresh-start helper to V1.
  Re-run only the three affected test files after fixes, then the normal gate.
- Focused-fix attempt 1: `ops-453-focused-fix1.service`, invocation
  `3e057d5935ad40789af5dc49a1aa6634`, `/tmp/ops-453-focused-fix1.log`, exit1
  before tests. A line-number patch drift deleted a fresh-start `why` declaration
  and one unchanged-store assertion. Independent review caught both and a stale
  duplicate log assertion. Restore exact declarations/assertions with targeted
  text edits; no production code change. Review also requested a decisive
  V2-lower-grant/inverse-V1 refusal case; add it with unchanged grants/usage/
  requests/outbox assertions. Next attempt is only this diagnosed stage.
- Focused-fix attempt2: `ops-453-focused-fix2.service`, invocation
  `a1b698dfe24f4a68a09c803948499286`, `/tmp/ops-453-focused-fix2.log`, exit1
  before tests: the added inverse case named an unimported V1 constant. Use
  this suite's existing frozen literal `policy` instead; production unchanged.
- Focused-fix attempt3: `ops-453-focused-fix3.service`, invocation
  `1b79094959a142548570fce0c56ea0cb`, `/tmp/ops-453-focused-fix3.log`, exit1:
  typecheck passed;153 tests passed,2 failed. A forged-generation decision had
  correctly reserved its operation id, so a different decision with the same id
  returned identity_conflict. Assert that refusal, then use a distinct valid
  operation id. New stores require explicit startup recover before read; the
  previous-reader proof had only checked that pre-recovery fence. Exercise
  previous-reader recover with exact unsupported-schema refusal, compatibility
  recover/read of the same mixed bytes, and byte-identical file assertions.
  The inverse lower-authority refusal case passed. Production unchanged.

- Compatibility full gate1 `ops-453-compat-gate.service`, invocation
  `a7c82862efc3497e8e44064f86de6ddb`, `/tmp/ops-453-compat-gate.log`, exit1:
  build, protocol, PATCHES, typecheck and lint passed;7794 unit tests passed,
  11 skipped,1 failed. Failure is this change's tool description hygiene
  (994 characters, maximum700); formatting failed on one newly wrapped e2e
  assertion. E2e did not start. No unrelated failure or live change.
  H-MSG-DESC-1: remove duplicated explanatory prose from only the description,
  retain the shared Owner routing text, delivery/wake semantics and all active
  policy boundaries; apply the exact formatter-requested line wrapping.
  Expected: description at most700 characters with unchanged numeric policy
  and routing, formatting and hygiene stage green. Falsifier: lost behavior
  explanation, wrong boundary, over700 or another diagnosed-stage failure.
  Diagnosed-stage result HIT: sealed Prettier on both changed files passed;
  hygiene4/4 and policy/schema4/4 passed. No cap/threshold relaxation. Then
  run the required normal full gate/build/e2e on the corrected source.

- Compatibility full gate2 `ops-453-compat-gate2.service`, invocation
  `59cd6da70971408ab8fa90a04361a68b`, `/tmp/ops-453-compat-gate2.log`, exit1:
  protocol/PATCHES/typecheck/lint/format passed;7794 unit tests passed,
  11 skipped,1 failed. Gate2 stopped before build/PTY/e2e. Existing
  board-routing regression requires the explicit
  description sentence about sending common information on the Board.
  H-MSG-DESC-1 MISS on preserving that wording, despite its diagnosed-stage
  hygiene/policy tests passing; no unrelated failure or live change.
  H-MSG-DESC-2: restore only the explicit common-information sentence while
  retaining the shorter description. Expected: original routing regression,
  hygiene and policy/schema tests pass together within700 characters;
  falsifier: any of those checks fails. Diagnose these stages before the
  next normal full gate; preserve the existing test, not weaken its assertion.
  Diagnosed-stage HIT: all40 tests in role-messages, hygiene and policy/schema
  passed together; formatting on both changed files and diff check passed.

- Compatibility full gate3 `ops-453-compat-gate3.service`, invocation
  `2103e87b9be54ce9b589c49193fe3367`, `/tmp/ops-453-compat-gate3.log`, exit1:
  normal sealed gate passed (483 files,7795 tests,11 skipped; protocol,
  PATCHES,typecheck,lint,format,build,real PTY). E2e4/5 passed in
  `/tmp/ops-453-compat-e2e3/summary.json`; previous-reader case failed
  `V_CONTRACT_PIN_MISMATCH` before execution. No seal hits, leaks or new
  session directories in any e2e. Nothing landed or installed.
  Diagnosis: the frozen acceptance loader pins the exact original
  `server/role-message-guard-contract.ts` SHA256
  `79a5a1e1a704ecfbb36a70fc1b210ee6e27575013843122cf202a84592b4c7af`
  at `04fe491fb3afc3b42462ad782b2099c7971c7008`. HEAD still has those exact
  bytes; adding expanded types to that original module breaks the frozen
  source identity despite the unchanged V1 literal/validator/golden behavior.
  H-MSG-CONTRACT-FREEZE-1 (Architecture-adopted design, qualification pending): restore
  the original contract source identity, put the explicit expanded domain
  in a separate V2 contract overlay and adapt only affected type callers.
  Do not edit pins, relax verification, copy expected vectors or silently
  widen V1 exported serialized types. Expected: original pin and previous-reader
  proof pass unchanged, expanded types/runtime boundary tests remain green;
  falsifier: any pin mismatch, duplicated drifting legacy definition, lost
  typing, changed old authority or safety/normal gate failure.
  Architecture narrow read-only advice requested as `rm-6750bd7a`,30min
  checkpoint; Ops remains accountable. Architecture205 delivered bounded
  source advice, not acceptance. Architecture HOME explicitly adopted it in
  `rm-e1eee055` answering `rm-d9fd8990`; Ops proceeds within the existing
  approved two-phase plan, retaining all unexecuted qualification obligations. Ops verified all seven
  source hashes still match that review and the advice custody digest
  `949e68a3a1b6602db97d65b286405f20a0cf3a78c90b6e95e0c95ef9820ce5d5`
  (37289 bytes); metadata digest
  `b8af86aa5016fdb3d13b74a6e0a474ca26da660427ae502b730308165cbe0349`.
  The adopted recommendation is a qualified-V1, selective companion
  overlay with whole-member revision-correlated binding/request/grant/
  decision/question/store/result families and their actual verifier,
  coordinator, transaction callback and approval-context consumers. No
  blanket old-import facade, flat version/quantity unions, whole-contract
  copy, casts to bypass the boundary, or pin/harness changes. Original
  operation/receipt/journal ABI is separate from policy/container revision;
  unchanged authority/transport/incident/usage structures stay original.
  A V2 container may retain exact V1 records; V1 envelopes and persisted
  results must not smuggle V2 records, and write versions cannot downgrade.
  Type-refusal fixtures must exercise these correlations and callbacks,
  including variable-valued cases, before normal runtime qualification.
  All advice is uncompiled/untested and grants no activation clearance.
  Existing static reviewer confirmed no other blocker before the pin-stage
  discovery; that result does not qualify the subsequent correction. The
  implementation restores the original bytes and adds the separate erased
  `server/role-message-guard-contract-v2.ts` with qualified-V1 selective,
  whole-record overlays. Core/host/approval callers opt into explicit Any/V2
  types; known-revision verifier calls keep exact per-call output types.
  Structural readers check nested result/request/first-answer/selection
  revision correlation and reject S2-to-S1 writes and issued-grant rewrites.
  New static variable-valued refusal fixtures and synthetic durable store
  tests cover these boundaries. Original V1 golden/reference assertions
  remain unchanged, using a V1-only adapter that fails on unexpected V2 data.
  First post-correction sealed `npm run typecheck` stopped at the server:
  12 integration errors in three files (approvals 419+, core 183/878/939/990/
  1119/1561, store 795/848/864). Union-valued payloads were placed inside
  individually correlated result envelopes without distributing the whole
  wrapper. No runtime tests ran. Correct the constructors by known-revision
  branches, not casts, a flattened contract or weakened assertions. The store
  now uses a revision-distributed ready-envelope helper; the source peer
  corrected the core/approval wrappers. The next sealed typecheck passed
  server and web, then found four fixture-only errors in two suites: the
  approvals fake needed an explicitly lower-only selection and its existing
  synthetic brand constructor; the new store request needed an explicitly
  lower-only selection rather than a spread union. No runtime tests ran.
  These are constructor fixes, not changes to expected legacy vectors.
  Focused4 `ops-453-compat-focused4.service`, invocation
  `d23d4537f08a412788173b73ccebbf98`, `/tmp/ops-453-compat-focused4.log`
  (0600), exit1: full five-project typecheck passed;27 focused suites ran,
  26 passed,627 tests passed,2 failed,1 skipped. Both failures were
  `TypeError: original is not a function` in the approvals fixture: new
  overload-preserving spies had no explicit mock implementation, while two
  unchanged cases obtain and wrap `getMockImplementation()`. No policy,
  frozen-contract, retention, durable-store or authentication assertion failed.
  H-MSG-FIXTURE-SPY-1: explicitly initialize those spies with their existing
  overloaded synthetic functions. Expected: both original-wrapping cases and
  the complete approvals suite pass, with identical assertions and type
  correlation. Falsifier: another missing implementation, a changed legacy
  expectation, type failure or weakened revision boundary. No production
  edit, test relaxation or unrelated retry is needed. Retest only that
  doubtful stage, then the required normal gate/e2e.
  Diagnosed-stage HIT: `ops-453-compat-focused5.service`, invocation
  `3d38eba47c224f4e94cb2cd313d84a99`, `/tmp/ops-453-compat-focused5.log`
  (0600), exit0: full five-project typecheck and approvals96/96 passed.
  Combined with focused4's other26 passing suites, the affected stage is
  qualified. Independent static delta review found no remaining P0/P1.
  Next build the corrected candidate and run the isolated historical pin/
  previous-reader e2e before the required normal full gate and five e2e cases.
  Isolated historical pin/previous-reader HIT:
  `ops-453-compat-pin4.service`, invocation
  `8669dde10ba74e31bf8b3bc4f7bd29ba`, `/tmp/ops-453-compat-pin4.log`
  (0600), exit0 after a normal sealed build. The unchanged previous-reader
  e2e passed1/1 in `/tmp/ops-453-compat-pin4/summary.json`: original pin,
  legacy hard6, old-hourly control accounting, saved words, reinstall and
  chain continuation all passed; zero fence hits/leaks/new session dirs.
  H-MSG-CONTRACT-FREEZE-1's doubtful stage is HIT.
- Compatibility normal gate4 HIT: `ops-453-compat-gate4.service`, invocation
  `fa8d03d9414d40da898004bbf34a37ec`, `/tmp/ops-453-compat-gate4.log`
  (0600), exit0. Protocol/PATCHES, five-project typecheck, lint, formatting,
  sealed unit tests (485 files,7819 passed,11 skipped), normal build and
  real PTY passed. All five role-message e2e cases passed in
  `/tmp/ops-453-compat-e2e4/summary.json`, with zero fence hits, leaks or new
  session directories. The active selector remains V1. This qualifies the
  compatibility candidate only: no commit, land, install or V2 activation
  is inferred from these checks. Separate checked activation remains owed.

Unchanged: Ops/Temper hourly exemption, one-hour window, all storage and
request/protected/incident/Board capacities, source/privacy/budget/consent,
Owner authentication, pauses, disabled wakes, TTL and no automatic resend.
