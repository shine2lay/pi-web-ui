# Native serialized owner-answer / recall commits

Task 671 host half. This changes only pi-web-ui. pi-queue owns the native records, replay,
eligibility, endpoint lifecycle, commands, owner-record validation and notification recovery.
No model-facing tool or second state journal is added.

## Hypotheses and status

- **Admission:** `answerStuck` previously reserved `stuckAnswers` in memory, then sent the answer.
  A restart or failed delivery could erase that reservation. One parent-queue writer lane and a
  canonical `owner_admission` before delivery should make exactly one of recall or owner admission
  win. Falsified if both commit, or recall succeeds after an admitted-but-undelivered answer is
  replayed. **Authored tests, not run.**
- **Occurrence:** wording-only signatures and process-local `stuck-N` identifiers can match a
  later identical question after restart. Include the native occurrence in signatures and derive
  bound card IDs from that signature. Falsified if an old card answers a later revision/escalation.
  **Authored tests, not run.** Legacy unbound cards retain the previous IDs/signatures.
- **Notification:** a recorded consult followed by a void `sendUserMessage` is not durable delivery.
  Reuse native `sendCustomMessage` in its synchronous idle branch, with a checked occurrence tag
  on the message itself. Falsified by a false delivered ACK, duplicate saved card after restart,
  stale/held/source-invalid delivery, or any model turn. **Authored tests, not run.**
- **Aftermath:** the native commit command now ends at `finish`. Dispatching `question-after`
  after that commit promise resolves should preserve notification/recovery without retaining
  the writer lane. Falsified if delayed aftermath blocks the next commit or notification failure
  undoes the transition. **Authored tests, not run.**

- **Unbound acceptance:** generic `resolveQuestion` resolves before any durable native acceptance,
  and the existing decisions recorder logs failed writes without stopping that resolution. Absence
  of a legacy record is therefore not proof that the owner has not answered. Append a metadata-only
  native acceptance marker before resolution and check it at final recall consumption. On failure,
  preserve the answer and fence recall; after restart refuse pre-coverage questions rather than
  inventing a clean history. Falsified if a generic accepted answer permits a fresh recall, if a
  persistence failure blocks that answer, or if restart drops the exclusion. **Tests not run.**

## Modules and reuse

- `server/queue-question-port.ts`: structural mirror of the fixed v1 commit protocol and the
  optional card guard below. Registry lookup requires exactly one endpoint per session ID.
- `server/queue-question-commit.ts`: parent-path-keyed promise lanes, opaque one-use tokens,
  final identity/writer checks, synchronous ACK and uncertainty poison.
- `server/queue-question-durability.ts`: existing native `SessionManager` capability detection,
  exact saved-byte/receipt verification and `fsyncSync`; never edits records itself.
- `server/queue-question-native.ts`: native session/identity/current-home resolution, shared by
  commit admission and card delivery; opening uses the existing queue client path.
- `server/queue-question-owner.ts`: deterministic owner receipt for the exact binding and answer,
  so a retry after delivery failure can identify the same acceptance.
- `server/queue-question-acceptance.ts`: metadata-only generic acceptance markers and the
  conservative restart/uncertain-history fence; it never infers a task or relays an answer.
- `server/queue-question-card.ts`: one source-session delivery lane and tagged native messages.
  `server/prompt-start-guard.ts` recognizes its existing synchronous no-turn wrapper by original
  and installed method identity; delivery calls that wrapper normally, never bypasses it.
- `server/queue-host.ts`: optional methods on the existing host installation, not a parallel host.
- `server/agent-service.ts`: thin native install/dispose wiring and existing owner acceptance
  boundaries. `server/stuck-asks.ts` retains ownership of card identity/signatures.

## Commit contract and native integration

```ts
commitQuestion?(
  sourceSessionId: string,
  binding: QuestionBinding,
  change: QuestionChange,
): Promise<QuestionCommitResult>;
consumeQuestionCommit?(
  token: string,
  workerSessionId: string,
): { request: QuestionCommit; finish(result: QuestionCommitResult): void } | undefined;
```

`QuestionBinding`, change/result/actor types match pi-queue's `question-commit-port.ts`.
The global registry is `Symbol.for("pi-queue.question-commits.v1")`, containing
`Map<sessionId, Set<endpoint>>`; absent or multiply registered endpoints refuse authority.
The host does not accept a role/home supplied in a change and never opens a caller by a claimed ID.
It opens the bound queue/worker without a model prompt, then resolves source identity and the
queue's accountable department/current home from actual native sessions and role records.

The host dispatches `/queue question-commit <opaque token>` using the existing
`AgentService.queueRunCommand` -> `AgentSession.prompt` -> registered `/queue` command route.
That route refuses a missing `/queue` command instead of sending the line to a model.
The worker must synchronously do:

```ts
const cap = host.consumeQuestionCommit(token, nativeWorkerSessionId);
if (!cap) return;
const result = endpoint.commit(cap.request);
cap.finish(result); // no await between consume, commit and finish
```

The parent implementation must catch author exceptions into `uncertain` before `finish`.
`finish` checks the canonical append and fsync, and may throw if that proof fails; the host's
commit result is then `uncertain`, not success. An absent finish after a microtask boundary also
poisons the occurrence. A token is removed on its first consumption attempt and is scoped to
one actual worker. Poison is keyed to the whole question occurrence, not just the revision, so
an in-memory revision increment after a failed append does not permit a second transition.
Poison is in-process safety state, not a new recovery journal; native replay owns restart repair.

The endpoint owns all final task/parent state, pause/stop, source, provenance, occurrence and
revision guards immediately before its append. Existing controls stay synchronous in the same
JS writer; they are not moved into an async lock. The host intentionally does **not** require
`endpoint.binding(id)` to equal the request before committing: native duplicate recall accepts
an old binding with the exact recorded retraction and current revision = old revision + 1.
Finished/dropped tasks and newly stale attempts remain the native author's decision.

After a recall result of `committed` or `already`, the coordinator releases its commit lane and
separately dispatches `/queue question-after <receipt rid>`. It does not await that notification
in the commit result, and does not do this for owner admissions/refused/uncertain results.
The native command reports the parent and runs normal consult routing; the host does not call
card delivery independently. Failure is logged and the canonical retraction remains retryable.
This command must never prompt the worker; the real `/queue` command handles it natively.

## Actual owner acceptance boundaries

1. AskHub's `answerStuck` (also Telegram/role-card answers) persists admission before the existing
   answer sender. The in-memory map still deduplicates in-flight UI submissions, but is no longer
   the acceptance proof. Delivery failure deletes only that UI marker, never the admission.
2. Queue-tab bound dispatch uses that same handler. Existing queue/target/question guards remain;
   native binding is included in signatures and stable bound card IDs, so same-wording
   re-escalation and a restarted counter cannot accept the old card.
3. Direct plain native owner input in a stuck worker is admitted before `promptInLine` can defer
   or fail delivery. Slash commands, extension input, non-owner wakes and unbound legacy tasks
   keep their prior path. This uses the native worker input's existing answer semantics, not
   keyword/prose inference.
4. pi-queue's ordinary `owner_record` relay must retain its existing record validation, then call
   `commitQuestion(parentSessionId, binding, { kind: "owner", ..., record })` before `/queue relay`.
   The worker revalidates the native record in its final author. The host passes `record` through;
   it neither creates a substitute record nor treats source prose as consent.

5. Generic `askUser` records its actual native session ID/path when presenting a dialog and
   preserves them across client takeover. Before a noncancelled `resolveQuestion` resolves it,
   the host rechecks that source against native sessions and its current department home, then
   synchronously appends and fsyncs `queue-unbound-owner-acceptance`. The marker contains only
   `{ v: 1, rid, at, sessionId }`: no question, answer, tool payload, inferred task or new consent.
   A cancelled dialog or a source that is not a current department home does not create a marker.

### Conservative unbound-answer exclusion

Generic dialogs still have no native queue occurrence binding; a title containing `#N` does not
establish one. Instead, final recall capability consumption scans only native acceptance metadata
in the author's current home, on every saved branch. An acceptance at or after `question.at`
refuses a fresh recall because its relation is unknown. This preserves the owner's answer without
claiming it authorizes any queue action. Existing decision records and `owner_record` validation
remain unchanged; the host never reads their prose to infer consent.

Append/fsync/source failures are logged and poison recall for the affected home and time interval
(or all sources when native identity is missing); they **do not block ordinary generic answers**.
There is no secondary file/journal whose write is assumed to succeed after the primary write
failed. Because legacy decision recording is best-effort, absence of a legacy record cannot prove
nonacceptance. A host's complete observation interval starts at construction. It precisely refuses
fresh recall for questions at or before that start, including all still-open pre-start questions
after a restart, even when no acceptance marker survived. New questions strictly after that start
can qualify if no later acceptance/failure applies. This is deliberately conservative: an unrelated
generic answer can exclude another open question in the same home, and restart cannot grant a
fresh recall for an older question merely because its acceptance history looks empty.

The exact prior revision of an existing recall still reaches the native author, which may only
return its validated duplicate receipt or refuse; it cannot append a second recall. This preserves
idempotent notification recovery without letting the ambiguity fence reopen a transition. Native
source/current-home, stop/pause, task status and receipt guards remain in force. Bound direct/stuck
owner admissions are unaffected by this generic fence.

## Guarded recall-card delivery interface

```ts
deliverQuestionCard?(
  sourceSessionId: string,
  tag: string,
  card: string,
  binding?: QuestionBinding,
): Promise<
  | { status: "delivered" | "already" }
  | { status: "pending" | "refused" | "uncertain"; reason: string }
>;

// Optional extension on the registered worker endpoint; commit protocol is unchanged.
checkCard?(request: {
  binding: QuestionBinding;
  actor: QuestionActor;
  tag: string;
  card: string;
}): { allowed: true } | { allowed: false; reason: string };
```

The binding parameter is optional only for API compatibility: this implementation **refuses**
missing bindings/guards. Supply the current recalled occurrence binding, not the pre-recall
revision. Before any opening, the caller must already be a registered current home. After the
per-source lane wait and all session-opening awaits, the host resolves that home and accountable
actor again. Immediately before the idle append it calls the worker's synchronous `checkCard`.

The native guard must revalidate actual endpoint/session, worker and parent binding, current
revision/tag, recalled/unanswered state, holds/stops, source authority and current accountable
home. It must compare the supplied text with the canonical native consult card; caller text is
not evidence. It must not append, yield, invoke a model or accept a stale receipt just because
its old consult is saved. The host performs no await between this guard and the native append.

The saved custom message is `customType: "queue-question-card"`, `display: true`,
`details: { tag }`. Its JSONL entry is the correlation receipt—there is no outbox file or second
state journal. The host verifies the exact append and fsync before `delivered`; `already` checks
that the tagged entry exists on the active saved branch, including after restart.

**Display, not wake:** `sendCustomMessage(..., { triggerTurn: false })` starts neither a lead nor
a worker model turn. In a busy/compacting lead it would be a memory buffer, so the host returns
`pending` without sending. Native recalled-only `opsConsult` must retry the same tag from its
consult receipt on lead `agent_settled` / `session_start`, including when a receipt already exists.
A delivery invoked inside a tool turn normally stays pending until that turn settles. The queue
reply can show the fresh tag for a separate lead decision. No automatic decision or worker wake
is implied by a displayed card. Ordinary consult and Rule24 delivery paths are unchanged here.

## Native-only durability and other limits

- A supported writer is an established, flushed, persisted native `SessionManager` with the
  exact native append/persist methods. Both queue and worker must qualify for commits.
  The host checks a regular existing file, stable inode/size, exact appended JSONL and fsync.
- Durable/async wrappers and unsaved/in-memory writers explicitly refuse recall. No
  `await save()` of a void adapter is used as evidence. Unsupported source adapters leave
  legacy owner-answer paths in place; this is not a claim of durable-engine recall support.
- Guarantees cover one native host process and its synchronous writers. Another OS writer,
  incompatible SDK method replacement or partial/uncertain persistence is not repaired here.
  Uncertainty blocks further commits in this host and remains visible.
- Native saved transcript/card presence does not prove a human read a card or a browser/Telegram
  notification arrived. Recovery can display an already saved message; no delivery ACK is
  fabricated from `sendUserMessage` or a memory reservation.
- Parent native guards and recovery remain required. The ordinary host suite uses a synthetic
  author; the separate coupled suite below loads the real author and actual generic dialog
  acceptance, but remains unexecuted and does not cover all owner-record validation paths.

## Coupled proof hypothesis

The isolated host author stub and queue host stub can each pass while disagreeing at the real
boundary. Couple the actual queue extension/tools/endpoint to the real host coordinator and SDK
command route, using only temporary native sessions. Expect exactly one canonical winning op in
each owner/recall ordering, durable exclusion after reopening every session and recreating both
runtimes, and one fresh tagged card without a worker/lead turn. Either double acceptance, lost
restart admission, wrong replay, or an unintended model call falsifies the hypothesis.
**Coupled source authored; not executed.**

## Authored verification, deliberately not executed

`tests/fixtures/question-commit-host.ts` uses disposable native SDK JSONL sessions, synthetic
role records, the actual installed host/coordinator, `AgentService.queueRunCommand` and native
SDK command dispatch. It never starts a server/model or reads real role/session files.

- `tests/unit/queue-question-commit.test.ts`: both race orderings, restart before delivery,
  duplicate receipts, same-turn holds, source/home changes, ambiguous registration, one-use
  tokens, missing synchronous ACK, poison, async writer refusal, real saved-byte replay, and
  a delayed post-commit native aftermath that does not retain the writer lane.
- `tests/unit/queue-question-owner.test.ts`: actual Queue-tab, AskHub/Telegram and direct input
  boundaries; failed delivery retains admission; identical-text stale cards after restart;
  legacy and unsupported-adapter compatibility.
- `tests/unit/queue-question-card.test.ts`: real native custom-message append/replay through the
  existing prompt-start guard, busy/idle,
  SDK post-append failure/retry, current-home recheck after waits, missing guard/binding,
  canonical-text guard and stale/answered/held/source-invalid/done refusals.
- `tests/unit/queue-question-acceptance.test.ts`: actual dialog presentation/resolution, metadata
  persisted before resolution, final-consumption interleaving, append/fsync failures preserving
  the answer, cancellation/non-home behavior, earlier acceptances, uncertain legacy history,
  missing native identity, reconstructed restart and duplicate-receipt compatibility.

### Opt-in coupled production-queue proof

`tests/coupled/queue-question-native.test.ts` and `native-queue-world.ts` use the actual queue
extension from the explicitly named canonical pi-queue worktree only. The shared
`queue-source-path.ts` resolver requires `PI_QUEUE_NATIVE_SOURCE`, checks the package identity
and rejects a main checkout or symlink; there is no installed-package/main-clone fallback.
For this task the approved source is `/home/shinelay/projects/pi-queue-ops-task-671`; a future
replay must create its own worktree at the recorded queue commit and name that path explicitly. The config aliases the queue's package imports
to this host's real SDK/typebox dependencies using ESM resolution, never the queue test stubs.
The normal unit-suite include excludes this opt-in coupled file.

`setup-question-sandbox.ts` replaces HOME and every relevant pi/web/role/work data directory
before application imports. The fixture registers the production extension's tools, commands and
hooks on a temporary native SessionManager-backed API. It reuses the host fixture's real
`AgentService.queueRunCommand` / `AgentSession.prompt` dispatch and no-turn message writer.
Only initial ordinary consult user-message requests are counted rather than delivered; recalled
cards go through the actual guarded native host sender. No provider or server is constructed.

Two deterministic race cases pause the actual commit dispatch, observe the second call entering
the real coordinator unchanged, then release the first. They assert one canonical winner,
original question/plan restoration, no resume/worker send, and native disk replay. Restart means
reopening all three SDK session managers and recreating extension contexts/endpoints plus host
coordinator/card lanes in this test process—not killing an OS process. The recall-first case
persists a pending consult while the lead is busy, then retries and deduplicates its card through
native startup/settled recovery. The owner-first case never delivers the accepted answer and
requires the persisted admission to reject recall after that reconstruction. Two additional cases
use actual generic dialog presentation/resolution against the production queue tool: a durable
unbound acceptance excludes recall after reconstruction without creating an owner admission, and
a failed marker preserves the answer while restart's incomplete-history fence still refuses recall.

After authorization, run from `/home/shinelay/projects/pi-web-ui-ops-task-671` through the existing
sealed/CPU-entry launcher (commands documented only; **not run here**):

```sh
scripts/sealed.sh env PI_QUEUE_NATIVE_SOURCE=/home/shinelay/projects/pi-queue-ops-task-671 \
  node node_modules/vitest/vitest.mjs run --config vitest.question-coupled.config.ts
scripts/sealed.sh node node_modules/typescript/bin/tsc --noEmit -p tsconfig.question-coupled.json
```

The supplemental tsconfig includes the coupled source; it does not suppress types or alter the
normal suite. These race, dialog and reconstruction cases are not an exhaustive crash/power-loss proof,
a real transport acknowledgement, or evidence of actual human observation.

No tests, build, compiler, formatter, server, live queue or model operation was run for this
subtask. The parent must run the targeted suites, coupled proof and normal checks once authorized,
and report the conservative generic-dialog/restart exclusion honestly.
No commit, land, install or restart is included.

## Forward disable only

Do not blanket-revert the host to legacy stale-card readers or memory-only acceptance. If recall
must be disabled, forward-disable its exposed capability while retaining occurrence signatures,
old-card rejection, canonical owner admissions, generic acceptance metadata and fail-closed
history checks. Preserve all native queue/acceptance/card history and ordinary owner answers.
Disabling a capability grants no permission to clear records, weaken holds/source checks or
re-enable an older card. A backward host revert is not a safe operational undo.
