# Board authored drafts and genuine results (#593)

## Hypothesis before editing

Ops is accountable. **H-BOARD-DRAFT-RESULT-1**: at base
`4f32b06e2d2f8dec63a4258ac6575ba2cbac7b92`, `BoardForm` and `BoardCloseForm`
leave their inputs editable during `boardRequest`. Both call `onDone` after
any successful result, without checking edits or the editor lifetime.
`receiveBoardResult` matches only `reqId`, not operation/close target. The post
wire trims title/text and sorts recipients, while the close wire trims/omits
its note. Those wire representations cannot reconstruct the complete authored
source, including whitespace and inactive recipient choices.

One bounded repair will retain complete immutable source and current-edit
snapshots before awaiting, associate each request with its real operation and
editor revision/lifetime, and allow only an admitted, matching genuine result
to finish the unchanged submitted editor. Local admission alone is never
posted/closed. Expected: false/rejected/deferred admission, unknown outcomes,
B/ABA edits, target changes and unmount/reopen preserve originals and newer
edits. A dropped field, normalized original, early or wrong-result close,
duplicate dispatch, automatic recovery action or authority journal is a MISS.

Tests and genuine original-source controls are prepared before the production
repair. The final isolated run must demonstrate the actual baseline's late
successful-result loss for both editable forms, not a fake missing-API failure.
All data is synthetic; there are no real posts/closes, chats, messages, profiles,
models, app servers, live changes, landing or deployment.

## Explicit pre-implementation question and answer

Question: may both source-bearing post and close use #585, or must close have a
separate note-only callback? What exact source may the host checkpoint?

Actual answer: #570 host decision **rm-a7bfa763**, relayed by Ops to this task:
ACCEPT the `BoardDraftSource` union/accessor. BOTH source-bearing `board_post`
and `board_close` use `appAdmit`, with complete exact immutable source and the
ORIGINAL packet before true; read the accessor before clone/await. Close note
and original id/editor/revision are INERT DATA, never a close/grant/authority
receipt and NEVER replayed from recovery. Empty/no-note close is still M with
its actual typed source (no invented text). Local true needs genuine
`board_result` matching reqId/op/close-id plus unchanged editor/resource/
revision/lifetime. Keep native kind/recipient authorization, inactive picked
order and raw whitespace. No ownerWords/grant/config/capability source, no
eligible-path fallback. Recovery is look/edit only; a fresh submit needs fresh
native authority. #570 owns purpose schema/checkpoint and actual host result
echo. This is the host's technical answer, not owner consent or integrated proof.

## Scope and integration boundary

Only these five files belong to this handoff:

- `web/src/roles-state.ts` (Board helpers only)
- `web/src/components/RolesView.tsx` (BoardForm/BoardCloseForm and their imports only)
- `tests/unit/durable-board-admission.test.ts`
- `tests/durable-board-admission-test.mjs`
- `docs/durable-board-admission.md`

The shared #585 registry does not make an action eligible for journaling.
#570 owns explicit authored-source schema policy, the actual durable checkpoint,
host/result echo, reload recovery and integrated rollback/full-gate proof.
E is authored title/text or close note, with exact kind/recipient/post context.
T watch/list operations stay transient. Close execution is M: never replay it
from recovery, never infer consent from a retained note, never journal grants,
configuration or approval state. Board validation/authority and all existing
limits remain unchanged. RoleAnswerDialog and unrelated Roles controls are not
part of this repair.

## Exact caller/host contract

`BoardDraftSource` is an immutable `{ editorId: string, revision: number, form }`.
`form` is exactly one of these closed shapes:

```ts
type BoardDraftForm =
	| Readonly<{
			type: "board_post";
			kind: UiBoardPostKind;
			toAll: boolean;
			picked: readonly string[];
			title: string;
			text: string;
	  }>
	| Readonly<{ type: "board_close"; id: string; note: string }>;
```

Every field is copied explicitly and frozen, including `picked`; no authority
fields are copied from a broader object. `picked` keeps its authored selection
order even when `toAll` makes it inactive. Title/text/note keep raw whitespace.
The separate existing wire still trims title/text/note, sorts active recipients
and omits an empty/whitespace-only close note. No native validation/limits change.

Exports from `web/src/roles-state.ts`:

- `createBoardDraft(form: BoardDraftForm): BoardDraftSource` starts a UUID lifetime.
- `reviseBoardDraft(source: BoardDraftSource, form: BoardDraftForm): BoardDraftSource`
  retains a complete current edit and advances its revision, including A → B → A.
- `getBoardAdmissionSource(message: ClientMessage): BoardDraftSource | undefined`
  is an exact-object-identity WeakMap lookup. The registered #570 `appAdmit`
  handler must call it on the ORIGINAL packet synchronously before clone/await.
  Cloning first loses the association; no guessed reconstruction is valid.
- `getBoardDraftRecoveries(): readonly BoardDraftRecovery[]` returns immutable
  `{ current, attempts, restoredSources }` records. Each attempt has exact `reqId`,
  immutable submitted `source`, admission state and optional outcome. Current
  edits are independent of submitted originals; timeout/unmount/resource changes
  do not remove them. These are page-memory inspection records, NOT durability,
  authorization or a generic journal. Only approved authored source is eligible
  for the host's explicit checkpoint purpose, not this whole envelope/results.
- `restoreBoardDraft(value: unknown): boolean` strictly accepts the complete
  closed source shape, rejects additional/authority fields, accessors, sparse
  recipient arrays and conflicting same-editor/revision content, and retains it
  as inert `restoredSources`. It does not overwrite a current edit or display,
  open, submit, publish, close, retry or replay anything. #570 must provide actual
  durable recovery presentation; this partition only exposes complete content.
- `boardRequest(ask: BoardAsk, source: BoardDraftSource, answerMs = BOARD_ANSWER_MS): Promise<BoardResult>`
  snapshots source and the original complete frozen packet before `appAdmit`.
  There is NO `appSend` fallback on either eligible path. It registers the
  correlation before admission, buffers a real early answer, and accepts success
  only after strict true AND a genuine matching `reqId`/`op`/nonempty result id;
  close success must name the exact submitted post id. Early success cannot
  outrun false/rejected admission. The first matching result wins; duplicate,
  malformed, missing, wrong-operation, wrong-target and stale answers are inert.

The existing 20,000 ms answer deadline still starts before dispatch/admission.
Failure, unbound admission and unknown timeout never become synthetic success.
The warning remains `no answer from the server: look at the board before trying
again`. A timeout does not cancel the host or authorize replay; late activity
cannot finish the expired editor request. Only an explicit fresh user action may
retry. Form completion also rechecks live mounted lifetime, original resource
and unchanged revision at the final callback boundary (including the nested-await
microtask gap). Two submissions before a render share one pending operation.
A changed close target is a fresh lifetime even if it changes A → B → A.

### What #570 must still do

1. Pair this caller commit with #585 and the actual original-packet admission
   handler. Unbound admission deliberately fails closed; this caller must NOT be
   installed alone. Read the source accessor before cloning/awaiting and checkpoint
   the full approved source plus required original-packet context before true.
2. Apply the explicit authored-purpose schema/eligibility policy. Board kinds and
   recipients still go through native Board validation/authorization. Retaining
   an `order` or a close note proves no owner consent, grant or capability.
3. Keep close execution M: checkpoint its note/context as INERT DATA, never replay
   its packet or infer close/owner approval from recovery. Empty/no-note close
   invents no authored text and has the same genuine-result guard.
4. Echo the real native `board_result` (original reqId, op and actual post id);
   local true/ACK/queue admission does not mean posted or closed. Never turn a
   checkpoint ACK into a successful BoardResult.
5. Integrate complete-current-edit and original-source checkpoint/reload/recovery,
   explicit look/edit presentation and fresh native authority on any new submit.
   Prove real persistence/reload, result echo, close non-replay, paired rollback
   and the unchanged sealed full release gate. None is claimed by these caller
   fixture tests. No App/use-chat/protocol/server/authority edit is in this commit.

## Verification and handoff

The first focused pass had 208/208 unit checks, both genuine old-component loss
controls, build, full typecheck and targeted lint/format pass. The native suite
then exposed an oracle error on its first close case: the fixture first mounts a
post editor before switching to close, but `originals` compared against record
zero instead of the submitted editor. No production failure was observed there.

**H-BOARD-ORACLE-IDENTITY-1:** select the recovery record by the actual attempt's
editor id, and also compare the exact captured admission source and request id.
This should exercise every close scenario without weakening any source/content
assertion. A mismatch in the actual submitted editor/source or a failing remaining
native scenario would falsify the oracle-only explanation. Only that changed
native suite is rerun; the passed source/unit/baseline checks are not repeated.

**H-BOARD-DRAFT-RESULT-1: HIT at the caller boundary.** Both genuine original
components lose the newer editable draft on late actual success; the repaired
real components retain complete originals and current B/ABA edits, inactive
recipients, kind and post context. Real-store checks include malformed/early/
missing/duplicate/wrong-op/wrong-id/stale results, admission failures, deadlines,
unmount/reopen/cancel, resource ABA, duplicate actions and the nested-await edit
gap. Server failures retain source; explicit fresh retries use new request ids.
Look-only restore sends nothing. Transient watch/list packets and native paused/
authority behavior remain on their existing paths. No generic authority journal,
real action, profile, model or app server was used.

**H-BOARD-ORACLE-IDENTITY-1: HIT.** After only the oracle correction, all 38 native
cases pass with zero page/console errors. The original loss controls pass by
loading BOTH original production files verbatim from
`4f32b06e2d2f8dec63a4258ac6575ba2cbac7b92` (adding component exports only),
not by substituting fake failures or mocking the request helper.

Checks run in this worktree:

```sh
VITEST_MAX_WORKERS=2 scripts/sealed.sh env TZ=UTC npx vitest run tests/unit/durable-board-admission.test.ts tests/unit/app-admit.test.ts tests/unit/role-board.test.ts tests/unit/roles-view.test.ts tests/unit/roles-live.test.ts tests/unit/roles-answer-ui.test.ts
scripts/sealed.sh node tests/durable-board-admission-test.mjs --baseline
scripts/sealed.sh node tests/durable-board-admission-test.mjs
npm run typecheck
npm run build
npx oxlint web/src/roles-state.ts web/src/components/RolesView.tsx tests/unit/durable-board-admission.test.ts tests/durable-board-admission-test.mjs
npx prettier --check web/src/roles-state.ts web/src/components/RolesView.tsx tests/unit/durable-board-admission.test.ts tests/durable-board-admission-test.mjs docs/durable-board-admission.md
git diff --check
```

Result: **208/208 unit tests across six files; 2/2 genuine baseline loss controls;
38/38 native browser cases; all five typechecks and build pass; targeted lint has
0 warnings/0 errors; targeted format/diff checks pass.** Build has only its
existing >500 kB chunk-size warning. The corrected native suite alone was rerun;
no unchanged passing suite was repeated. The full release gate is #570's job.

### Commit handoff and undo

The exact five-file caller commit is delivered in #593's queue completion and
handoff to #570. It is based on #585's
`4f32b06e2d2f8dec63a4258ac6575ba2cbac7b92`; cherry-pick only this caller commit
into #570's paired worktree, preserving other callers' disjoint Board-unrelated
changes. There is no independent landing/deploy or claim of host durability.

Undo before integration: omit this commit. Undo after cherry-pick: reverse this
single caller commit **together with the corresponding host integration**, in an
integration worktree; do not reset over newer unrelated work. A later live release
needs #570's proved paired rollback, not an isolated caller reinstall. This
partition itself makes no live change and needs no live rollback.
