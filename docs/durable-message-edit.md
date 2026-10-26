# Message edit admission — Ops #588 handoff

Accountable lead: Ops. Source base: `48cec10e20ecc3870f0e2422fb990160c00e215d`.
Scope: Message / MessageList only; App integration belongs to #570 (c108).
This branch must not land or deploy independently.

## H-MESSAGE-EDIT-ADMISSION-1 (recorded before implementation)

Evidence: #582 `components.md` G1 / A1 / common matrix identifies a void
`Message.onEdit -> MessageList.onEdit -> App.onEditMessage` chain. Message
unconditionally closes its editor immediately after invoking the callback.
App can still be resolving original image references, and its send can fail.
Both Message submit paths also trim nonempty authored text.

Change: introduce a separately named `onEditAdmit(...): Promise<boolean>`,
propagate it unchanged through MessageList, capture complete original text and
attachment metadata before invoking it, and gate cleanup on literal true plus
resource, editor-instance and monotonically increasing revision ownership.
Use a synchronous operation lock, not only React's disabled state.

Expected result: deferred, false, rejected, missing and non-true admission keep
originals and current drafts; an older completion cannot close newer text,
attachments, reopened editors or another session/resource; duplicate gestures
invoke admission once. Measure using actual mounted components in jsdom and
isolated Chromium, including MessageList forwarding and the actual old component
as a negative control. Falsified by any early close, changed/dropped attachment,
trimmed nonempty text, duplicate call, or stale cleanup.

Outcome: implementation complete; final check results are recorded below. This is
callback-boundary proof, not proof of App attachment resolution, persistence,
socket delivery, execution, rollback, or migration.

## H-MESSAGE-SYNC-THROW-LOCK-1 (review correction before final checks)

Review found that a callback throwing synchronously skips the await suspension,
so catch could release the lock before a second same-stack Enter/click or stale
context action. Keep the lock through one microtask even in that catch. Expected:
duplicate gestures call even a synchronously throwing admission only once and
keep the draft/original. Falsified by two calls from the same gesture batch.
Unit and native checks include this case; no retry ban is introduced.

## Explicit integration contract for #570 / c108

```ts
type EditAdmission = (
  messageId: string,
  text: string,
  attachments?: PromptAttachment[],
) => Promise<boolean>;

// App supplies both; MessageList forwards to every existing editable route.
<MessageList onEditAdmit={boundEditAdmission} editContextKey={realTargetGeneration} />
```

`EditAdmission` is exported from `web/src/components/Message.tsx`. It uses the
existing edit argument types. `onEdit` remains source-compatible but is never
invoked by Message, never awaited as a receipt and never used as a fallback.
An existing App that supplies only `onEdit` can still open and keep an editor,
but attempts report that admission is unavailable and send nothing. This
intentional staged behavior is why the branch must be combined, not deployed.

The parent must bind `boundEditAdmission` to the **original** conversation,
session and lifetime/generation before any asynchronous attachment resolution.
It must retain that original even if its displayed resource changes. Resolving
`imageUrl` must use that captured target, preserve the entire attachment set and
metadata/references, and fail honestly if any needed bytes cannot be resolved.
Do not return success for a partial set, for a void callback, a socket enqueue,
or an execution/ACK guess. Return literal `true` only after #570's actual durable
admission contract owns the complete original; return `false` or reject on
failure/unknown. Rejection never invokes another send path. This component does
not implement the resolver, persistence, socket policy or durable recovery.

`editContextKey` is required at runtime for an admission attempt. It must be a
nonempty genuine parent-provided resource generation, changed on conversation,
session or session-lifetime retargeting, including reusing the same IDs. It is
**not target authority**. Neither message IDs, callback identity, the current
active conversation, a locally invented counter nor a synthesized constant is a
substitute. #570 must supply and prove the real binding. MessageList adds its
actual displayed `state.conversationId` and `state.sessionId` to that supplied
key for cleanup fencing, but cannot fill in an absent parent generation.
Missing/blank keys submit nothing and keep originals/drafts with an explicit
notice. No absent binding is claimed safe.

Message snapshots exact nonempty authored text (trim tests emptiness only) and
structured-clones the complete attachment array before invoking the callback.
A second copy goes to the callback so resolver mutations cannot change the
retained original or editor. Snapshots remain in memory and are inspectable in
the kept-original details; this is not reload-safe recovery. Direct reask uses
the same capture/admission/locking path, not the legacy callback. An open editor
is never overwritten by a stale direct-reask action.

A synchronous operation token prevents duplicate click/Enter/context-menu
invocations while admission is pending. Only a resolved literal true may close,
and only with the same mounted resource object, operation, editor instance and
unchanged monotonic revision. Text A-B-A, attachment removal/addition or even
starting an asynchronous file read advances that revision. Cancel/reopen gets
a new editor instance without releasing the pending operation's ownership.
Message/context A-B-A creates a new resource object, invalidating old cleanup.
A context change keeps the old draft visible but blocks it from submitting into
the new resource: explicit cancel/reopen is needed. Unmount invalidates UI
cleanup; it does not cancel or authorize replays of the parent's submitted work.
False/rejection/unknown reports uncertainty rather than claiming persistence or
execution. No automatic retry/replay is added.

Unrelated read/expand/copy/plugin/rewind/queue callbacks remain synchronous and
unchanged. Previously read-only folded-history rows stay read-only.

## Behavioral checks

- `tests/unit/durable-message-edit.test.ts` mounts real Message and MessageList
  (not a reducer surrogate or static source assertion). It exercises deferred
  success, false/rejection/throw/nontrue, missing callback/binding, exact Unicode
  and whitespace, all attachment/reference forms, callback/prop mutation,
  newer text/attachments, revision and target A-B-A, session changes,
  same-ID reopen/unmount, in-progress file reads and duplicate gestures.
- `tests/durable-message-edit-test.mjs` bundles the real components into an
  ephemeral loopback fixture and uses a new headless Chromium context/profile.
  It never starts the app, reads a chat, uses an owner's browser or calls a model.
  The negative control compiles the actual pre-fix Message at the pinned source
  base above and proves a void callback immediately closes the editor. Missing
  old source or Chromium fails; it is not silently skipped. Native FileReader,
  context-menu reask, MessageList session changes and preservation are checked.
- The synthetic admission callback delays like an original-image resolver; it is
  **not** the real App resolver. #570 still owes actual target/byte resolution,
  host callback wiring, durable ownership, socket/persistence behavior,
  reload/rollback proof and its unchanged integrated gate/normal `wt land`.

Run from this worktree, under sealed isolation:

```sh
scripts/sealed.sh env VITEST_MAX_WORKERS=1 npx vitest run tests/unit/durable-message-edit.test.ts --maxWorkers=1
scripts/sealed.sh node tests/durable-message-edit-test.mjs
scripts/sealed.sh npm run typecheck
scripts/sealed.sh npm run build
scripts/sealed.sh npx prettier --check web/src/components/Message.tsx web/src/components/MessageList.tsx tests/unit/durable-message-edit.test.ts tests/durable-message-edit-test.mjs docs/durable-message-edit.md
```

### Verification setup correction

First verification: native Chromium passed all 31 preservation assertions and
its actual old-component negative control; full build passed. The unit run was
blocked before loading this test because `happy-dom` is not a dependency
(`ERR_MODULE_NOT_FOUND`); the four related suites passed 60 tests. Typecheck
caught the incomplete synthetic `UiState` assertion in this new fixture.

H-TEST-SETUP-1: using the repo's existing jsdom dependency and a complete
`satisfies UiState` fixture should let the actual component suite run and make
its synthetic state type-checked without changing production code. Falsified by
another setup/import/type error or a behavioral failure. No missing-import
result counts as component proof. Outcome HIT: the component suite loaded and
33 of 34 cases passed; full typecheck passed.

H-STREAMING-ASSERT-1: the remaining fixture incorrectly expected a streaming
message to be editable, although Message has always disallowed that. Keep the
existing read-only boundary and test that streaming rows do not expose editing
or invoke admission; keep forwarding tests on editable window/digest rows.
Expected: all cases pass without any production change; falsified by a failing
editable route or an admission call from a streaming row. Native rerun passed
32 preservation assertions, including synchronous-throw duplicate actions;
full build and typecheck also passed. Final focused results follow below.

### Final results (2026-10-26)

- H-MESSAGE-EDIT-ADMISSION-1: **HIT** for this callback slice. All 34 actual
  component cases passed, plus 60 existing attachment/copy/fold/digest tests:
  **94/94**, five files, sealed single-worker run.
- H-MESSAGE-SYNC-THROW-LOCK-1: **HIT**. Same-stack duplicate edit gestures and
  direct-context actions invoked a synchronously throwing callback once, while
  retaining the original/draft; no fallback was called.
- H-STREAMING-ASSERT-1: **HIT**. Streaming stays read-only; editable window and
  digest paths forward and await the explicit callback.
- Isolated native Chromium: **PASS, 32 preservation assertions**, actual pinned
  pre-fix void/immediate-close negative control, no page errors. No real app,
  chat, owner profile or model was used.
- Full `npm run typecheck`: **PASS** (server/web/tests/desktop/page-picker).
- Full `npm run build`: **PASS**; only existing bundle-size advisories.
- Focused Prettier check and `git diff --check`: **PASS**.

The unchanged integrated gate, real App/host wiring, target/attachment resolver,
reload, persistence, socket and rollback checks are **not run or claimed** here;
#570 owns them before its normal combined landing/deployment. An independent
review delegation could not start because the shared subagent pool was full;
this handoff records self-review and actual component/native proof, not an
independent reviewer receipt.

## Handoff and undo

Commit only the two owned components and the three new test/doc files. #570
combines the clean pinned handoff commit with its parent/host wiring, then runs
its normal unchanged gate and landing. No standalone land, deployment,
migration, release or activation is part of #588. Before combination, undo is
simply not cherry-picking this branch; after combination, revert it together
with its matching parent callback wiring, not one half by itself.
