# GoalBar authored-intent admission (Ops #589)

## Hypothesis recorded before implementation

Accountable lead: Ops. H-GOAL-ADMISSION-1: the original `set` and
`startWizard` in `web/src/components/GoalBar.tsx` trim the authored text,
call synchronous `appSend`, ignore its boolean result, then unconditionally
clear the input. A refused send loses the draft. Component-local state also
loses the source on unmount and can carry it to another conversation.

One change: capture the complete original goal/wizard message and original
`activeConversationId` before awaiting #585's exact-true `appAdmit`, retain
conversation-scoped in-memory editor/recovery state, and permit cleanup only
for the same editor lifetime, view generation and edit revision. Expected:
false, nontrue, rejected (including committed-then-rejected), pending and stale
completions preserve exact text/options/target; an unchanged current editor
clears only after literal true. Text, option, target and lifetime ABA must not
permit cleanup. The genuine pinned old component must reproduce the loss.
A lost or retargeted source, duplicate admission while pending, control routed
through generic admission, or automatic goal/wizard start on recovery falsifies
this hypothesis.

## Scope and integration contract

Base/API pin: HOME-accepted #585
`4f32b06e2d2f8dec63a4258ac6575ba2cbac7b92`.
`appAdmit(msg: ClientMessage): Promise<boolean>`; no handler means false;
only exact true admits; there is no `appSend` fallback.

Only this component, its unit/browser checks and this document belong to #589.
No App/protocol/host edits, land, install, deployment, model, real chat/profile,
server checkpoint, integrated no-loss or W3 rollback claim belongs here.

The component's exported `GoalAuthoredIntent` requires `conversationId: string`
on the complete `set_goal` or `start_goal_wizard` message. This is the actual
`activeConversationId` prop captured at submission, not a guessed session ID or
server receipt. Interface clarification: #570 (peer handoff c108, 2026-10-26)
prepared an optional `conversationId` field in its shared protocol/host; this
caller always supplies it. That shared work is not checked or landed by #589.

#570 MUST bind that exact identity synchronously on entry to its installed
admission handler before cloning or awaiting, reject mismatched current identity
before checkpoint, validate source/session/ownership and schema eligibility,
checkpoint the entire intent, and preserve the binding through dispatch. Its
host must check its O(1) active-conversation getter before effects. It must not
substitute a later active conversation or use the live synchronous `appSend`
path. If the original target cannot be bound safely it must refuse, not retarget.
The inert #585 registry supplies none of this. No separate source accessor is
needed: every authored text/option/target is already present in the exact frozen
message handed to the handler. No SID is fabricated here.

The submitted object is frozen and includes exact authored text (trim is used
only for emptiness), selected review/wizard model when nonempty, maxRounds,
locked and conversationId. T `list_models` and M preference/lock/clear
controls remain live synchronous `appSend` actions with existing authorization;
no control gets journaled or replayed here.

## Recovery and cleanup boundaries

Goal drafts and submitted originals live only in this browser module's memory,
keyed by the real conversation ID, with no timer or implicit expiry. Navigating
or remounting recovers the original editor/options and admission status without
sending anything. This is not browser-reload, process-crash or durable recovery.
#570 still owes full-payload checkpoint, readable/editable/exportable durable
recovery, correlated downstream acknowledgement and safe retirement, persistence,
restore and lossless rollback evidence, and the unchanged integrated full gate.

A synchronous pending guard prevents duplicate Enter/click admissions of either
kind, including across navigation/remount. Edits remain possible while pending.
Every text, option and collapse edit advances a revision (including A→B→A).
Conversation navigation creates a new keyed editor lifetime. Changes between
inactive/active/wizard views invalidate the view generation. A late result may
update the retained attempt's status, but never clean a different revision,
resource or lifetime. Server preference updates do not overwrite an authored
editor. Clear-goal retains its live behavior without replacing a newer draft.

Only exact true may clear the unchanged current input; even then the complete
submitted original remains readable in recovery details. Local true is neither
server persistence, execution nor permission to retire the last recoverable copy.
False means admission was not confirmed, not proof nothing happened. Rejection
is uncertain even with `payloadCommitted: true`; no exception grants cleanup or
automatic retry. Separate manual submissions retain separate original intents;
there is no automatic replay or recovery-triggered start.

## Evidence

H-GOAL-ADMISSION-1: **HIT for this caller slice**, not integrated durability.
Tests were authored before the component repair; fixed-input preservation
assertions exercise the real component. Final checks on 2026-10-26:

- `scripts/sealed.sh env VITEST_MAX_WORKERS=4 npm test -- tests/unit/durable-goal-admission.test.ts tests/unit/app-admit.test.ts tests/unit/app-globals.test.ts`:
  101 passed (63 real-GoalBar cases, 29 registry cases, 9 live-global cases).
  GoalBar cases mount the actual React component in StrictMode with native DOM
  events, comparing complete messages and visible/recoverable drafts/options.
- `scripts/sealed.sh node tests/durable-goal-admission-test.mjs`:
  63 complete-intent/UI checks passed in isolated native Chromium, plus two
  genuine pinned-old loss controls; no page errors. Both old authored actions
  call the real `appSend` returning false and nevertheless empty the editor
  and trim away original whitespace. The new preservation assertions contradict
  those observed old results; the control is not a simulated old handler.
- Browser checks cover both message kinds, exact whitespace/options/target,
  pending and duplicate actions, false/nontrue/rejected/committed-then-rejected,
  text/option/collapse ABA, conversation ABA with independent drafts, remount
  before/after late completion, active-goal/wizard view ABA, server-default
  updates and T/M live controls. Recovery never auto-starts either action.
  Unit cases additionally cover missing handler/target, synchronous throw,
  pre-submit option selection, same-event duplicate clicks/Enter, unsent-draft
  recovery and retaining multiple uncertain originals beside newer edits.
- `scripts/sealed.sh npm run build` and `scripts/sealed.sh npm run typecheck`:
  passed (normal build and all five configured typecheck projects).
- Targeted `oxlint` on the three source/test files: zero warnings/errors;
  Prettier check on all four files and `git diff --check`: passed.

All data is synthetic; the fixture serves only its in-memory component bundle
on an ephemeral loopback port and uses a fresh temporary Chromium context.
No application server, live data/settings, original browser profile, model,
land, install or deploy was used. These checks are not #570's unchanged integrated
full gate, persistence/reload, checkpoint/dispatch, restore or lossless rollback
proof. Do not independently land this caller without the real host binding.
