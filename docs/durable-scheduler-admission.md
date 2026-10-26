# Scheduler task draft admission (#590)

## Hypothesis written before changes

Ops is accountable. H-SCHEDULE-ADMISSION-1: at base
`4f32b06e2d2f8dec63a4258ac6575ba2cbac7b92`, `SchedulerPanel.save()` calls
synchronous `appSend(schedule_save)` and unconditionally `setDraft(null)`, even
when send returns false. It also trims authored strings before ownership is
established. One caller repair will capture the complete task and original form,
await #585's exact-true `appAdmit`, retain recoverable originals and current edits,
and close only the unchanged submitted form revision/lifetime. New/update drafts
must survive false, rejection, delay, typing/options B and ABA, close/reopen,
task/workspace switches and component navigation. Any missing field, mutated
snapshot, early/wrong-form close, duplicate pending dispatch, fallback send or
automatically executed recovery falsifies this hypothesis.

Tests were written against the real component before changing it. The genuine
original component is also bundled from that exact base as a negative control;
the final test pass must reproduce its refusal loss, not merely fail on absent
new APIs. All inputs are synthetic. No real scheduler, task, chat, profile,
model, workflow, server mutation or deployment is used. Only this document,
`web/src/components/SchedulerPanel.tsx`,
`tests/unit/durable-scheduler-admission.test.ts` and
`tests/durable-scheduler-admission-test.mjs` belong to this handoff.

### H-SCHEDULE-RESTORE-1 (before the requested interface addition)

#570 requested a look-only `restoreSchedulerDraft(source): boolean` after the
first complete caller pass was green (53 scheduler + 29 registry unit tests,
27 native cases, two genuine old-source controls; build/typecheck/lint/format).
Evidence: getters alone cannot make an archived full form editable after reload.
Change: validate/copy a complete recovered source, retain its original separately,
and offer explicit reopening without replacing an existing current draft.
Expected: new/update originals are editable after an explicit review/open, newer
same-form edits and other drafts survive, identical restores are idempotent,
malformed/conflicting bytes are refused, and no restore dispatches any action.
Any field loss/overwrite/automatic save, enable, run or replay is a miss. Final
verification reruns the touched stages once after this addition; the first pass
was not a failure or an end-to-end workflow retry.

## Caller behavior

Only authored `schedule_save` uses the shared
`appAdmit(message: ClientMessage): Promise<boolean>`. The caller deep-freezes its
complete wire task and an independent complete original form before awaiting.
It does not trim authored text or omit empty optional values:

- Task: optional existing `id`, `name`, `description`, `cwd`, `kind`, `spec`,
  `prompt`, `model`, `thinkingLevel`, `catchUp` (`once` or `skip`). Empty
  description/model/thinking values remain explicit, including update clears.
- Original form: `id`, `name`, `description`, `cwd`, `kind`, `cron`, `preset`,
  `intervalMinutes`, `prompt`, `model`, `thinkingLevel`, boolean `catchUp`.
  Inactive fields are retained too. Whitespace and composed/decomposed Unicode
  are not normalized. Required-field checks still use `trim()` only to decide
  whether Save is available; they do not change the captured strings.
- Explicit existing conversion: cron/preset sends the selected cron string;
  interval sends `max(1, floor(Number(originalMinutes) || 0)) * 60000` as a string.
  The original minute string is separately retained. Existing task-to-form
  interval display rounds milliseconds to minutes (minimum one), unchanged.

Each field edit increments a revision, including options, the current-directory
button, and A → B → A. Every opening gets a new UUID lifetime. A late exact true
closes only the still-open same view with the same revision. Close/reopen,
new-versus-existing task changes, workspace A → B → A, and component unmount all
invalidate the old close authority. New task and existing task drafts are keyed
separately within the actual workspace; no conversation/session is fabricated.
A synchronously set pending flag prevents duplicate dispatch even before React
renders, and survives close/reopen of the same record. Other records can still
be edited/submitted independently.

False, nontrue, unbound handler, synchronous throw, rejection and
`payloadCommitted` rejection retain originals/current values, with visible
uncertainty feedback. Even exact true says **local admission only**, never
server-saved, enabled or executed. There is no fallback send or automatic retry.
Missing selected model/thinking options stay representable when option lists
refresh, rather than displaying an unrelated default.

## Page-local recovery and #570 host contract

The caller keeps immutable submitted originals and independently evolving
current drafts in **page memory**. Closing or navigating away from the panel
retains those copies. Reopening the same task/new-task form in the same workspace
restores its current copy. The expandable recovery view exposes original form,
complete task and current form. Inspecting/reopening never sends a mutation.
Nothing here survives page reload by itself.

Exports from `web/src/components/SchedulerPanel.tsx`:

```ts
interface SchedulerAdmissionSource {
  readonly workspace: string;
  readonly taskId: string | null;
  readonly formId: string;
  readonly revision: number;
  readonly form: Readonly<SchedulerTaskDraft>;
}
getSchedulerAdmissionSource(message: ClientMessage): SchedulerAdmissionSource | undefined;
getSchedulerDraftRecoveries(): readonly SchedulerDraftRecovery[];
restoreSchedulerDraft(source: unknown): boolean;
```

`getSchedulerAdmissionSource` is an exact-message-identity WeakMap lookup. #570's
registered handler must read/copy it **synchronously before its first await or
message clone**. Unknown messages have no source. Every reachable source, form,
task, attempt and public recovery snapshot is immutable. Recoveries include the
workspace, complete current form and attempts (`source`, `message`, and
`pending`/`unconfirmed`/`admitted` phase), plus `restoredSources` containing
separately retained complete recovered originals. These accessors are data, not
permission to send, schedule, enable, run or replay anything.

`restoreSchedulerDraft` is explicitly **LOOK ONLY**. It requires an exact plain
data object with the five source fields and all twelve original form fields:
string text fields (empty optional values allowed), supported kind/preset,
boolean catchUp, nonempty workspace/formId, null-or-nonempty taskId matching the
original id, and a nonnegative safe-integer revision. Missing/extra fields,
accessors, nonplain prototypes, incompatible types or same formId/revision with
different original bytes return false without changing anything. It copies and
freezes accepted data. Literal true means **retained for review only**, including
an idempotent prior restore; it is not admission, execution authority or a server
receipt. Existing current drafts always win, even if the recovered revision
claims to be newer. A recovered original stays separately reviewable and cannot
overwrite newer same-record edits, another draft, pending ownership, the current
workspace or an open editor. Restore never opens a form or sends any message.

The recovery view offers **Open retained draft for review**, which explicitly
opens the current retained editable form with a fresh view lifetime, even when
an archived existing task is absent from the current list. On a fresh page the
recovered original becomes that record's initial current form. If a current
form already exists, the recovered original is displayed separately and that
current form remains unchanged. Any later explicit Save still passes through
normal complete snapshot/admission; reopening/restoring alone never creates,
enables, runs or replays a task.

#570 still owns all of the following integration requirements:

1. Register the shared #585 host handler; exact-schema admit `schedule_save`,
   validate eligibility/ownership using the real workspace/task/form source,
   and checkpoint the complete wire message **and** source form before true.
   The global scheduler does not get a made-up conversation id. Workspace
   ownership and task execution `cwd` are different fields and must both be kept.
2. Preserve current edits separately from the admitted original. Associate
   persistent intent identity with workspace/task/form/revision; a new task has
   `taskId: null`, not an invented persisted scheduler id. Do not infer an ack
   merely from an unchanged/refreshed task list or from `payloadCommitted`.
3. Supply correlated server-result/failure recovery and downstream retirement.
   This caller intentionally retains admitted entries and reopens retained
   values until that contract exists; it does not discard copies on a guessed
   server outcome. Before integration release, wire the look-only restore export
   to validated archived full sources; provide correlated retirement and
   fresh-new-task behavior without deleting newer edits or retiring unrelated/
   ABA/reopened forms. This slice deliberately supplies no destructive retirement
   API. Add that host-bound integration in #570 with paired host/result tests,
   not by treating these exports as durable storage or a server-success callback.
4. A restored task is inspection/editing only. Never automatically call
   `schedule_save`, enable it, run it, or replay mutations. The existing server
   may enable a newly saved task by default: preserving a draft is not consent
   to create/activate it. Explicit future Save still uses normal admission.
5. Prove persistent ownership, reload restoration, rollback/lossless recovery,
   result correlation and the unchanged full release gate on the integrated
   tree. Caller tests alone prove none of these. W3, live-state/backup/restore
   requirements and all existing owner pauses remain unchanged.

T list/history and M toggle/run/delete remain on their existing synchronous
paths. History is a local view, opening requests `schedule_list`, toggle/run
send only their existing messages, delete keeps its existing confirmation,
and running tasks keep the disabled Run button. The old UI has no toggle/run
confirmation; this repair neither removes an existing check nor invents one.
No generic control journaling or replay is introduced. This slice must not be
landed/deployed independently of the registered host.

## Verification

The real-component suite uses React DOM, JSDOM and the actual #585 registry.
The browser suite bundles the real component/registry into an isolated in-memory
HTML fixture, uses a temporary browser HOME and a fresh headless browser, and
never loads the app server. The baseline fixture reads the original component
verbatim with `git show` at the base above; both new/update refusal controls must
prove the same form-preservation assertion genuinely fails and reopening has
lost the authored prompt. No fake API failure substitutes for the old component.

Final commands (sealed temporary HOME; build only inside the worktree):

```sh
scripts/sealed.sh env VITEST_MAX_WORKERS=2 npx vitest run tests/unit/durable-scheduler-admission.test.ts tests/unit/app-admit.test.ts
scripts/sealed.sh node tests/durable-scheduler-admission-test.mjs
scripts/sealed.sh node tests/durable-scheduler-admission-test.mjs --baseline
scripts/sealed.sh npm run build
scripts/sealed.sh npm run typecheck
scripts/sealed.sh npx oxlint web/src/components/SchedulerPanel.tsx tests/unit/durable-scheduler-admission.test.ts tests/durable-scheduler-admission-test.mjs
scripts/sealed.sh npx prettier --check web/src/components/SchedulerPanel.tsx tests/unit/durable-scheduler-admission.test.ts tests/durable-scheduler-admission-test.mjs docs/durable-scheduler-admission.md
git diff --check
```

Result: **H-SCHEDULE-ADMISSION-1 HIT; H-SCHEDULE-RESTORE-1 HIT** on the isolated
caller evidence (2026-10-26):

- 88 real-component unit cases plus 29 shared registry cases: **117 passed**.
  This includes 35 restore-validation/review cases; every original field is
  required and checked, not merely dispatch counts.
- **31 native-browser cases passed**, including fresh-page full-source restore
  into editable new/update forms without dispatch/activation, conflict retention,
  task absence from the refreshed list and malformed-source refusal.
- **Two genuine original-component controls passed by reproducing loss**: new
  and update both unconditionally close on false, the identical preservation
  assertion fails, and reopening has lost the authored prompt.
- Full worktree build and all configured TypeScript targets passed; targeted
  oxlint reported zero warnings/errors; the four-file Prettier check and
  `git diff --check` passed. Build emitted only the existing large-bundle notice.
- No app/scheduler/model/workflow server, real task/chat/profile, independent
  landing, deployment or live scheduler mutation was used.

These are caller checks, not proof of host persistence, actual reload recovery
from durable storage, result retirement, lossless rollback or production
scheduling. A fresh isolated page supplied with a known source tests only the
restore export; #570 still owes the integrated archived-source wiring, current
edit persistence, host/result/recovery/rollback evidence and unchanged full
release gate.

## Handoff and undo

The exact clean commit pin is returned to #570 and HOME with results. No
independent landing, full release gate, installation, migration, deployment or
real schedule changes occur in #590. Undo before integration is to omit this
four-file commit; after integration, revert it only together with its paired
host caller binding, preserving all checkpointed originals/current drafts and
normal backup/rollback gates. Never clear retained ownership to make rollback
or a test appear to pass.
