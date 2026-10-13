# Component V — independent message-guard acceptance

**Authoring and comparator controls are not candidate acceptance.** This opt-in corpus contains no production import, registration, alternate policy implementation, C law-oracle import or E/A/U admission oracle. The pinned plans are its oracle; literal expected answers live in `cases.mjs`. `requirements.mjs` is the complete requirement catalogue, with exact parent section anchors. The runner emits the full requirement → case → result matrix and hashes both case assertions and every harness file.

PLAN-v2 controls conflicts with URGENT-PROPOSAL: protected notices bypass **depth only**, consume the ordinary **20/hour**, and also obey all smaller protected caps. Grants cover at most five shared accepted business sends for 60 minutes, lower upper-hop 11, Owner explicit finite upper hop (12–16 for five at 12). No root/message/day cap, 16+4 allowance, automatic approval, action authority or hold change is introduced.

## Run the available V stages

From an owned worktree, after all authoring is complete:

```sh
PI_SEALED_MODEL=none scripts/sealed.sh node --test tests/role-message-guard-acceptance/local.test.mjs
PI_SEALED_MODEL=none scripts/sealed.sh node tests/role-message-guard-acceptance/run.mjs --plan --parents /home/shinelay/company-lab/shared/role-message-approval-plan-2026-10-12 --out /home/shinelay/company-lab/shared/role-message-approval-plan-2026-10-12/split/acceptance/UNBOUND-RESULTS.json
```

The first runs structural coverage, exact contract/previous-source checks, ownership, clean and deliberately broken comparator controls, and actual prior-reader cases once. It never manufactures a native pass. The second validates all four parent hashes and writes a **NOT RUN** matrix; expected exit **2**, not zero. `--out` must name a new `.json` receipt under the existing private split evidence folder or sealed root; old receipts are never overwritten. A missing adapter, unsupported category or missing native evidence is NOT RUN, never a green stub or skipped acceptance.

Normal repository checks and ordinary `wt land` still apply. These `.mjs` files are deliberately outside automatic unit/root-smoke discovery. Default repository checks must not turn unfinished integration into apparent green qualification. There is no server, port, model, browser login, live role send, incident mint, approval, service restart or installer in either V stage. Fixture file handling is confined to a sealed `mkdtemp` tree, removed in `finally`.

## What the actual old-reader stage proves

`previous-reader.mjs` reads the previous commit **9fe5b68cd451cdb3123475408b9898c9efc3ff90** from git, verifies the exact role-messages blob and SHA256, and bundles its entire repository import closure from that same commit in memory. It executes the real `RoleMessages` constructor, `send`, `setPaused`/save and FYI `tick` methods with a synthetic recording host, not an imitation or monkey-patched method. The closure's file hashes accompany the result.

It checks synthetic postchange-compatible ordinary/control/protected records (legacy ordinary kinds, including >6), per-record words/id/state/causal/Owner/routing/initiative preservation, 19→20 acceptance and 21 rejection across home/task activity, FYI note/no turn/dedup, and both **synthetic** FE32 containment-terminal and H7 task-id-terminal seventh-hop refusals. Those terminal fixtures have no real task, role, message id or payload and are not retransmissions.

Two deliberate broken controls expose real baseline hazards: the old writer drops new **top-level** grant/usage/incident fields, and abusing legacy `kind: report` for agent control traffic bypasses its hourly accounting. A test correctly detecting a hazard is a PASS **of the hazard observation**, not a compatibility approval. An untouched separate audit file proves only that the old writer did not touch it, **not** atomic sidecar publication. No candidate serializer, registered native adapter, real producer or installer is qualified by these observations. The integrated candidate-old-reader round trip and rollback/reinstall cases remain NOT RUN until #122 binds them.

## #122 invocation and adapter contract

Only #122 may bind/execute the final harness against its actual registered native adapters. It must retain these exact case, requirement and harness hashes; do not weaken assertions to make a candidate pass. Use:

```sh
PI_SEALED_MODEL=none scripts/sealed.sh node tests/role-message-guard-acceptance/run.mjs --parents /home/shinelay/company-lab/shared/role-message-approval-plan-2026-10-12 --adapter tests/<122-owned-native-binding>.mjs --out /home/shinelay/company-lab/shared/role-message-approval-plan-2026-10-12/split/integration/BOUND-RESULTS.json
```

The test binding must be an existing test file inside the repository (no symlink escape). It exports `default`:

- `mode: "sealed_registered_native"`, `candidateCommit: <40-hex exact combined source revision>`.
- `binding`: version, contractCommit, contractSha256, policyDocumentSha256, harnessSha256, caseSha256 and requirementSha256 exactly as returned by `corpusBinding()` in `harness.mjs`. The contract is the single landed `role-message-guard/v1`, not copied interfaces.
- `supports(caseId): Promise<boolean> | boolean`: true only for a supported actual native path. Capability absence is NOT RUN. Do not remove unavailable rows from the corpus.
- `evidenceFor(area)`: `{registered: true, fixtureOnly: false, sha256: <64-hex>}` referencing retained native source/registration/qualification evidence. A caller assertion or fixture HMAC alone is not this evidence. **P125 currently found no qualified native protected producer**, so protected positive areas cannot be represented as implemented from synthetic hooks. Negative readiness evidence can independently prove an explicit missing capability.
- `open(input, caseId)`: create a fresh synthetic sealed session implementing `act(command)`, `observe()` and `close()`. The adapter receives ONLY input and commands, never golden expected answers or the traceability matrix. The harness executes one scenario at a time, closes it even on failure, does not retry, and redacts thrown adapter errors.
- `observe()`: `{facts, evidence: {nativePath: true, sourceCommit: candidateCommit, sha256: <64-hex>}}`. Facts are derived from actual E store/legacy/audit receipts, A native requests/AskHub events, I invocation/causal/home routing, U qualified native receipt/template, and recorded `GuardTransportPort` dispatch/wake calls. Expected answers must not be recomputed by candidate policy or fed back as facts. The harness compares all golden fact fields and the complete `effects` schema; unexpected/missing effect keys fail. It prints only authored assertion paths, never actual output values, fixture bodies, model requests, prompt/tool contents or thrown errors.

A binding declaration and hash-shaped string are **necessary bookkeeping, not proof** of native registration. #122's independent combined Architecture/Security review must inspect the concrete adapter, its source/evidence and actual observations. In particular, an adapter may not return `cases[i].expected`, use a manual urgency flag as a registered producer, or translate a refusal into success. A PASS report always retains `qualified: false`; candidate acceptance plus release readiness belongs to #122, not this test script.

### Fixture interpretation (fixed, not permissive defaults)

`input` is a known-case scenario, not a production request body. Each case starts at trusted epoch 1800000000000, synthetic role-a home/current invocation, verified root-A/parent-A at hop 7, scope-A and recipient role-b, zero ordinary/protected usage, no grant, no holds, fresh qualified immutable incident **only when that case explicitly supplies `incident`**, and an explicit transport barrier. Referenced symbolic paths are resolved only inside the session's sealed synthetic directory. No real identity is renamed or assigned. A `grant` fixture has native request/generation/task/root/scope/quantity/upper-hop/decision bindings matching this scenario unless a specific wrong-* variant changes that one binding. Owner/lower proofs must be obtained through the native adapter, not accepted from the fixture's `source` string.

Counters in `input` are independently seeded durable accepted records and distinct native episodes, including pending live slots, not silently rewritten policy constants. Keep all other caps below their limits for a single-cap test (earlier-hour episode openings can have current-hour deliveries). Ordinary messages are charged across origin home/task chats and recipients. Safe finite retention values are selected by E/I, not by V; `selectedRetentionPoolAtMaximum` fills the actual selected finite bound, then attempts growth without pruning active/inflight records. Zero/unsafe/infinite limits are not accepted evidence.

Each `act` is one explicit adapter action; its `effects` are deltas since the previous observation, from actual durable accepted-state/transport recording, not success strings. Admissions are observed before releasing the fake transport barrier; dispatch is tested in separate explicit steps. Accepted receipts add a legacy record and ordinary use exactly once; granted business additionally uses one shared grant; protected additionally charges its three protected counters and (initial only) new-incident accounting. Control request/decision persistence itself is `recorded` and not a role communication; initial/decision **notifications** are separately metered `control_send` commands. A human Owner answer has zero agent-message usage. Zero-effect assertions cover action/queue/question/reader/judge/scope/hold/fallback/interrupt/batching/body-capture violations.

Crash fixtures deliberately stop the actual native writer/transport at the named boundary during setup, retain that evidence, then `crash_recover_probe` measures recovery only (not an automatic new send). Confirmed commit cases assert the exact retained acceptance/use/words; unknown cases must retain reservations and allow only authoritative same-identity queries, never speculative refund/resend. `previouslyCommitted` seeds an actual committed identity before the step. Source/hold revalidation happens separately at admission and dispatch. Fake host callbacks may record dispatch/notes only: they must never start a model/task/action.

`native_ui_probe` and regressions use synthetic native adapters and sealed UI components: desktop/phone, full dialog detail, keyboard/focus/a11y, exact states, browser/authorised-Telegram separation, reports/quiet turns/FYI/queue holds. They do not use a live chat or real human answer. The two `release_evidence` cases **inspect retained source-bound receipts only**; they do not run installs, reviews, probes or lift holds. If the required receipt is absent they are NOT RUN, not a request to manufacture it. V completion requires no such final receipts.

## Results and undo boundaries

Outcome vocabulary: PASS = an executed assertion matched; FAIL = an executed assertion/error failed; NOT RUN = adapter/capability/evidence missing. Local comparator passes and old-reader hazard observations are separate from the native result matrix. There is no `skip`/todo result. Exit 0 requires every bound row to pass; any failed row exits 1; any unavailable row with no failures exits 2. This does not assert live qualification, action success or human acknowledgement.

Rollback cases require hard depth 6 + ordinary20, disabled grants AND protected exemptions, preserved current accepted words/counts/provenance/audits and no old data snapshot. Reinstall cannot resurrect revoked/expired grants. An actual old-reader accounting failure blocks deployment, not a reason to change the installer or lose data. Inert V source can be undone by reverting its one ordinary commit; no live state or service has been changed. P125's urgent blocker, all existing safety/consent/hold limits and previously rejected notices remain unchanged.
