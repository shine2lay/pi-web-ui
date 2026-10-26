# Durable queue answers — caller handoff (#592)

## Hypothesis, written before changing the components

**H-QUEUE-ANSWER-RESULT-1 — HIT (caller scope).** At baseline
`4f32b06e2d2f8dec63a4258ac6575ba2cbac7b92`, `StuckAnswer` trims the
answer, sets `sent`, and empties the editor before calling a void `onAnswer`.
`RightPanel` ignores `panelSend`'s transport result. A refused or unknown
operation therefore loses the user's words and temporarily looks sent.

One change: separate consent answers from synchronous panel controls with an
explicit `Promise<boolean>` applied-result callback. Capture the original
host-provided question occurrence and the editor's revision/lifetime before
calling it. Keep the answer editable until a strict `true` for that operation;
only the unchanged submitted typed revision may be cleared. Choice submission
must not erase a typed draft. Never journal, persist or automatically replay
these consent-bearing payloads.

Expected measurement: real React components and an isolated native-browser
fixture retain exact words through pending, refused, unknown, rejected and stale
results, while the pinned real old components reproduce premature clearing.
At most one dispatch per explicit action; pending and applied are distinct.
Falsifier: loss/change of any retained words, cleanup by a stale result, a
transport-only success, duplicate dispatch, or any unbound/legacy fallback.

## Scope and ownership

Ops owns this caller repair. #570 owns App/protocol/backend binding and genuine
result integration. This branch changes only `TaskQueuePanel.tsx`,
`RightPanel.tsx`, this document, and the two `durable-queue-answer` tests.
No standalone landing, deployment, live questions/chats/profiles, model calls,
new persistence, synthetic owner receipt or release-authority claim.

## Exact interface accepted by #570

#570 (peer c108, 2026-10-26) explicitly accepted these readonly types, exported
from `web/src/components/TaskQueuePanel.tsx`:

```ts
export interface TaskQueueAnswerBinding {
	readonly conversationId: string;
	readonly queueId: string;
	readonly taskId: number;
	readonly questionId: string;
	readonly question: string;
	readonly choices: readonly string[];
	readonly detail?: string;
}
export interface TaskQueueAnswerRequest {
	readonly binding: TaskQueueAnswerBinding;
	readonly text: string;
}
export type TaskQueueAnswerResult = (request: TaskQueueAnswerRequest) => Promise<boolean>;
```

`RightPanel` receives `taskQueueAnswerBindings?: readonly TaskQueueAnswerBinding[]`
and `onTaskQueueAnswerResult?: TaskQueueAnswerResult`, alongside the existing
`tldrConversationId` and `taskQueue`. It passes them directly to
`TaskQueuePanel` as `answerBindings`, `onAnswerResult`, `conversationId` and
`queue`, without a void wrapper or `panelSend`. `panelSend` and unrelated
controls remain synchronous. The deprecated direct `onAnswer` prop is
render-only compatibility; it is never invoked, never treated as success.

Host prerequisites and meaning:

- #570 will expose a boot-scoped opaque occurrence ID from the actual AskHub
  ask registered by `ClientSession.reconcileStuckAsks`, together with its real
  queue ID. Never fabricate authority from question text, choices or time.
- Supply bindings from the same authoritative display snapshot. Exactly one
  conversation/queue/task match, nonblank occurrence ID, and exact displayed
  question/ordered choices/detail are required. Presentation guards detect an
  incoherent display; they do not establish authority.
- The caller freezes a fresh request, binding and choices array before invoking
  the callback. `text` is the original complete typed answer or choice,
  including nonempty leading/trailing/internal whitespace. Trimming only
  determines whether submission is empty.
- A strict asynchronous `true` means this exact original answer was actually
  applied to the matching current task/question under the existing owner,
  access and consent rules. False, nontrue, rejection and synchronous
  dispatch-only booleans leave the editor unconfirmed and editable. A genuine
  pending result may stay pending; no invented timeout claims success.
- #570 confirmed the existing `taskQueueAnswer` returns void, and
  `askHub.answer` → `wakeClosedChat` only proves a message/turn started, not
  application. It must not become `true` on that evidence. Send/wake, local
  admission, saving and generic queue refresh are likewise insufficient.
- Missing genuine binding or result support cannot fall back to the old void
  callback, `panelSend`, generic `appAdmit`, storage or replay. The caller
  cannot detect a host that falsely resolves a dispatch result as applied;
  #570 owns proving the real source/result and stale-request rejection.

Local lifetime rules: a synchronous in-flight guard blocks duplicate dispatch;
only a matching live question/editor lifetime can observe its result. A typed
answer may clear only if its exact submitted edit revision is still current;
newer and A→B→A edits survive. A choice never owns or clears the typed draft.
Question occurrence/presentation, task, queue or conversation changes, lost
support, removal, tab close and unmount retire the old cleanup capability.
No result replays an answer or infers consent from retained words.

This is mounted-editor retention, not a new draft persistence system. A tab
unmount/reload does not preserve its former local draft; tests prove an old
result cannot clear a newly reopened editor. #570's broader durable no-data-loss
and restart/rollback requirements remain open and cannot be claimed by this
caller slice. No consent payload is placed in local/session storage or a
recovery journal.

## Verification and remaining work

### Fixture setup correction, before changing its bundler

**H-QUEUE-FIXTURE-CSS-1 — HIT.** The first native-fixture invocation did
not reach Chromium: esbuild followed the real Markdown component's KaTeX CSS
and reported 61 asset/output-path errors (`No loader is configured for
".woff2" files` and `Cannot import ... katex.min.css ... without an output
path configured`). Caller units, the full build and all five typechecks passed;
this setup miss is not browser-behavior evidence.

One change: configure the behavior-only in-memory fixture's `.css` loader as
`empty`, retaining both generations of the genuine components and their logic
while omitting styles/font assets. Expected: the fixture starts, both old loss
controls reproduce the loss, and all current-result/lifetime assertions pass
with zero page errors. Falsifier: startup still fails or any behavior assertion
fails. This fixture does not prove layout or styling. Re-run only the affected
native fixture and changed-file static checks; do not repeat passed suites.

### Final caller evidence (2026-10-26)

Build, typecheck, unit/browser tests and formatting/lint ran inside this task's
worktree with sealed temporary HOME. No live app server, questions, answers,
chats or browser profiles were used.

| Check                                                                                                                                                                                                                                                            | Result                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/sealed.sh env TZ=UTC npm run typecheck`                                                                                                                                                                                                                 | PASS: all five TypeScript projects                                                                                                                |
| `scripts/sealed.sh env TZ=UTC npm run build`                                                                                                                                                                                                                     | PASS: web/server/runtime/vendor builds; ordinary large-chunk warnings                                                                             |
| `scripts/sealed.sh env TZ=UTC npx vitest run --maxWorkers=4 tests/unit/durable-queue-answer.test.ts tests/unit/task-queue-panel.test.ts tests/unit/files-panel-correlation.test.ts tests/unit/files-panel-visibility.test.ts tests/unit/files-wire-path.test.ts` | PASS: 5 files, 121 tests; 5 existing Windows-only skips on Linux. All 47 new real-component tests passed. Suite run once after component changes. |
| `scripts/sealed.sh env TZ=UTC node tests/durable-queue-answer-test.mjs`                                                                                                                                                                                          | PASS after the documented asset-loader correction: 28 native Chromium cases, including 2 real old-component loss controls; zero page errors       |
| Targeted `oxlint` on the two components and two tests                                                                                                                                                                                                            | PASS: 0 warnings, 0 errors                                                                                                                        |
| Targeted `prettier --check` on all five scoped files                                                                                                                                                                                                             | PASS                                                                                                                                              |
| `node --check tests/durable-queue-answer-test.mjs`; `git diff --check`                                                                                                                                                                                           | PASS                                                                                                                                              |

The old controls load **both** old components directly from the pinned git
object, verify their original clearing/void-dispatch source premise, mount
those actual components, and observe empty/disabled input before any genuine
result for both false and true transport acceptance. The repair assertions
verify full text and original request target, editable pending/unconfirmed
states, exact asynchronous `true`, newer/ABA revisions, choices, missing or
incoherent binding, same-text new occurrences, stale task/queue/conversation
and presentation changes, close/reopen/unmount, duplicates, restrictions and
unchanged synchronous removal confirmation. A generic queue refresh does not
settle the callback; synchronous transport `true` cannot clear anything.

The fixture intentionally omits CSS assets and emits esbuild's benign
`import.meta`/IIFE warning for the shared base-URL helper; these are not layout,
base-path or full-application integration proofs. An independent review
subagent was unavailable because the shared live-subagent capacity was full;
no independent review or full repository gate is claimed.

Caller proof does not prove the real host occurrence/result, authenticated
owner authority, generic-journal retirement, durable restart/restore/rollback,
integrated full gate, staged rollout or deployment. #570 still owes those
separately. In particular, it must not resolve `true` merely because an AskHub
answer wakes a chat. Host application/source proof and broader no-data-loss
proof remain open; this is only the accepted callback's caller proof.

Branch: `ops-592-queue-answer`; baseline:
`4f32b06e2d2f8dec63a4258ac6575ba2cbac7b92`. The exact committed handoff pin is
provided in #570's delivery receipt and the queue completion. Retain the branch
for paired integration; do not independently land or deploy it.

Undo before integration: do not cherry-pick the handoff. After paired
integration: revert the caller and paired host glue together under #570's
normal gates; never restore the old premature-clearing behavior alone.
