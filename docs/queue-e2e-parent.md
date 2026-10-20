# queue-e2e-parent: the queue's browser tests give their new tasks a parent

Ops #275 (essential maintenance of Ops' own tools; lead Ops). PATCHES.md entry `queue-e2e-parent`. Test-only:
no app code changes, nothing to install.

## H-QUEUE-E2E-PARENT-1

- **Wrong (evidence).** Ops #267 found `tests/queue-panel-test.mjs` failing with "no approval dialog" at its
  first plan, already on mine 0ce9bd8b, before #267's own change (Ops note n242). Since pi-queue 4209f68
  (2026-10-18, task #221, the work registry), `queue_add` refuses a new task that names no project,
  initiative or `standalone: true`, before any dialog opens ("Not added: say where this task belongs.";
  pi-queue `tests/work.test.ts`, "a new task must say where it belongs: refused … before any dialog").
  Nine pi-web-ui browser tests add new tasks through the real pi-queue with plans that name none of the
  three: per-chat-dialogs, queue-autonomy, queue-blocked, queue-lanes, queue-main-chat, queue-panel,
  queue-profiles, queue-side-by-side and telegram-answers (grep: 0 parent fields in each;
  roles-answer-test, which passes, already gives `standalone: true`). None of the nine is in the land gate
  (`scripts/check.sh`), so they broke unnoticed.
- **Change.** One change: every new-task plan these tests send to `queue_add` (a mock model's tool call, or
  a test fixture's direct call) gets `standalone: true`. Plan changes (a call with `id`) stay as they are,
  because a plan change keeps the task's parent.
- **Why it should work.** The refusal is the first thing `queue_add` does for a new task without a parent;
  with `standalone: true` it goes on to the plan check and the approval dialog as before the registry.
- **Expected, and how it's measured.** Every one of the nine gets past its first new task (the approval
  dialog opens, or the task is added at once where Auto approve is on), and the tests that failed only for
  this reason pass in full. Measured with a sealed run of the nine before and after the change
  (`node tests/run-sealed.mjs --jobs=4 <the nine>`): each test's pass or fail and its first failing check.
- **Disproved if.** With the field added, a test still shows no dialog (or no added task) at its first
  `queue_add`.
- A test that still fails after the fix for another reason is recorded here with its error line and gets
  its own fix task in Ops' queue; it isn't fixed in this change. No new gate step and no new checker (the
  owner wants fast lands).

## Before

Sealed run `pi-sealed-2026-10-20T04-40-01-867Z` on mine 05129317 (this branch before the change), against
pi-queue main 8e532de: **0 of 9 passed**. Each test's first failing check:

| Test | Before | First failing check |
| --- | --- | --- |
| per-chat-dialogs | fail (2 checks passed) | "chat A shows up in the list" (before any `queue_add`), then "A's row gets the ?" |
| queue-autonomy | fail | `page.waitForFunction: Timeout 30000ms exceeded` in `tasks()` after its first `/fixture add` (the task never came) |
| queue-blocked | fail (22 passed) | `queue_add takes after "temper #2" (another queue's task)`: the answer was "notAdded" |
| queue-lanes | fail (0 passed) | `dialog 1 shows the plan "Write lane A's first file"`, then "Error: no approval dialog" |
| queue-main-chat | fail (1 passed) | `all five are queued — []` |
| queue-panel | fail (1 passed) | `dialog 1 shows the plan "Rename the settings button"`, then "Error: no approval dialog" |
| queue-profiles | fail | `locator.waitFor: Timeout 30000ms exceeded` waiting for `.dialog-inline` at its first `add` |
| queue-side-by-side | fail (0 passed) | `dialog 1 shows the plan "Polish the settings page"`, then "Error: no approval dialog" |
| telegram-answers | fail (25 passed) | "Error: no Telegram message for the plan's pop-up" |

Eight of the nine stop at their first new task. per-chat-dialogs' first failure comes earlier, before its
model calls `queue_add`; its second is the missing dialog.

## Change

Tests only (`tests/`), 9 files:

- `standalone: true` on the new-task plans the mock models send: per-chat-dialogs (`PLAN_A`, `PLAN_B`),
  queue-lanes (`PLANS`), queue-main-chat (`plan()`), queue-panel (`PLANS`), telegram-answers (`PLAN`); at the
  new-task call in queue-blocked ("After docs") and queue-side-by-side (`PLANS`; `LOOP`, a plan change of #3,
  keeps its parent).
- The fixtures of queue-autonomy and queue-profiles, which call `queue_add` directly: `standalone: true` when
  the call has no `id` (`add`, `incomplete`, `override`, `invalid`); `update` and `clear` change a plan and
  stay as they were.

## After

The change on the same base (05129317) and the same pi-queue (8e532de), sealed runs of the nine:

- Run 1, `pi-sealed-2026-10-20T04-45-21-600Z` (with the build): **9 of 9 passed**.
- Run 2, `pi-sealed-2026-10-20T04-47-58-853Z` (`--no-build`, the same code, right after run 1; 21:48-21:50
  PDT, load average about 22 on 20 cores while a pi-web-deploy install built and checked alongside): **7 of
  9 passed**. queue-panel and queue-main-chat failed later checks, each long after its first new tasks were
  approved and added.

| Test | Run 1 | Run 2 |
| --- | --- | --- |
| per-chat-dialogs | pass (35 checks) | pass (35) |
| queue-autonomy | pass | pass |
| queue-blocked | pass (28) | pass (28) |
| queue-lanes | pass (53) | pass (53) |
| queue-main-chat | pass (47) | fail after 39 passed ("all five are queued", #1-#4 finished): at "#5: the owner stops the task's run", `Error: [mc-window-b] state never matched` (`B.waitForState`: #5's chat open and streaming, 15 s) |
| queue-panel | pass (44) | fail, 42 passed (among them `dialog 1 shows the plan "Rename the settings button"`): "A: done cues for #2's chat and the queue's chat's turn, none for #1's asking chat (2), one start tick (that turn) — start +1, done +1" (window B: done +2), and "the mock got no unscripted messages (no reminders, no continues) — queue chat: a user message" |
| queue-profiles | pass | pass |
| queue-side-by-side | pass (29) | pass (29) |
| telegram-answers | pass (48) | pass (48) |

Checks = the test's ✓ lines; queue-autonomy and queue-profiles print one PASS line instead. Logs:
`~/.cache/pi/queue-e2e-parent/{before,after,after2}/<test>.log`.

## Result: H-QUEUE-E2E-PARENT-1 HIT

HIT for each of the nine: per-chat-dialogs, queue-autonomy, queue-blocked, queue-lanes, queue-main-chat,
queue-panel, queue-profiles, queue-side-by-side and telegram-answers. In both runs after the change every one
got past its first new task (the dialog opened, or the fixture's task was added), so the disproof (no dialog
at the first `queue_add`) never showed, and run 1 passed all nine in full: every test that failed only for
the missing parent passes.

Other failures, not the parent's and not fixed here:

- Run 2's three failed checks in queue-panel and queue-main-chat (above).
- Before the change, per-chat-dialogs' first check, "chat A shows up in the list" (10 s, before its model
  calls `queue_add` at 4 s). It passed in both runs after.

The same code passed them all in run 1, and run 2 and the before run ran under heavy load, so they look like
timing; whether in the tests or in the app (the queue chat's unscripted user message could be an extra
wake-up) is for their own Ops task, requested from the Ops lead chat with these error lines (rm-f4fecfd2).
The nine stay outside the land gate (no new gate step; the owner wants fast lands).
