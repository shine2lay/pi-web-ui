# Escape answers a chat's ask only while the chat is on screen

Ops queue task #239 (accountable lead: Ops; standalone). Found by #225's live look on Oct 18; the owner's standing ask is to fix breakages along the way (m55423). Checks kept minimal at the owner's word (m55390): the focused tests, the landing gate and pi-web-deploy's own checks; no extra rounds and no live look.

## H-ESCAPE-HIDDEN-QUESTION-1: a chat's asks take Escape only while the chat view shows

**Wrong, and the evidence.**

- #225's live look (Oct 18): Escape on the Initiatives tab tried to cancel the question waiting in the Ops lead chat, a question the owner couldn't see (`docs/initiatives-page-exact.md`, "Found in the live look").
- The cause is the app's Escape order (`web/src/shortcut-stack.ts`): one capture listener on the document hands Escape to the newest handler on its stack and stops it there. The chat pane stays mounted, only hidden, behind Roles, Initiatives, Schedules (the scheduler plugin's tab), Terminal, Git and the other plugin tabs, and its three kinds of ask keep their handlers on that stack all along: an extension's select, confirm or input (`web/src/components/Dialog.tsx`, `useEscapeKey(() => respond(null))`), and the question dialog (`web/src/components/DshQuestionDialog.tsx`), mounted twice in `web/src/App.tsx`: the model's question (`chat.question`) and another chat's question answered here (`chat.remoteQuestion`, with its `owner`).
- #225's fix (`9b6c4e73`, H-INITIATIVES-ESCAPE-1) only puts the Initiatives page's own dialogs on top while one is open. With none open, or on any other tab, Escape still cancels the hidden ask, and the chat carries on with "cancelled" without asking again.

**One change.** `Dialog` and `DshQuestionDialog` take an optional `escapeEnabled` (default true, so every other caller is unchanged), and `App.tsx` passes `view === "chat"`, the same test that hides the chat pane. While it is false, the ask's Escape handler passes Escape on (`return false`) instead of cancelling.

It is not `useEscapeKey`'s own `enabled` flag, as the plan first said, because that flag takes the handler off the stack and puts it back on top when it turns true again. A modal opened on another tab (Settings, say) would then lose Escape to the question once the chat came back behind it, where today the modal closes first: the chat view's Escape would change, which the goal rules out. Passing Escape on keeps each handler's place, so in the chat view Escape goes exactly where it went before.

**Expected, and how it's measured.** `tests/unit/hidden-question-escape.test.ts` mounts App's panes cut down to the chat pane with one waiting ask, the Roles and Initiatives panes (the real Initiatives page, as #225's test mounts it, with no page dialog open) and a modal, and presses Escape. For each of the three asks:

- on Roles, Initiatives, Schedules and Terminal, Escape leaves the ask waiting: nothing is sent and the key goes on to the page;
- in the chat view, Escape cancels it as before (`question_answer` with `cancelled: true`, with `owner` for another chat's question; `dialog_response` with `value: null` for an extension's ask);
- back in the chat view after another tab, Escape cancels it again;
- a modal opened on another tab still takes Escape first when the chat comes back behind it, and the next Escape cancels the ask.

One more test holds `App.tsx` to the wiring: every `Dialog` and `DshQuestionDialog` it mounts gets `escapeEnabled={view === "chat"}`. Without the change the test fails; with it, it passes, and `tests/unit/initiatives-page-escape.test.ts` (#225) still passes.

**What would prove it wrong.** Escape on a tab covering the chat still cancels a hidden ask, or Escape in the chat view stops cancelling it (or cancels it where a modal used to close first).

### Other Escape handlers, checked and left unchanged

Only `Dialog` and `DshQuestionDialog` answer a chat's ask (`dialog_response`, `question_answer`); none of the others can, from behind a tab or anywhere:

- `ToolInfoDialog`, `SaveImageDialog`, `RollbackDialog`, `Modal`, `Dropdown` and every floating panel (`use-floating-panel.ts`): on the stack only while open, and each only closes itself. Rollback's Escape closes the dialog without rolling back.
- The other Escape listeners (file preview, global search, image zoom, the Roles page's own frame, `RoleMessageGuardApproval`, menus, inline editors, the chat input) close their own preview, menu, dialog or edit.
- Plugin dialogs (`host.dialogs.*`, the `pluginDialog` listener in `App.tsx`): a plain document listener while one is open, drawn in the chat pane, so the same exposure. Left alone because it is a plugin's ask, not a chat's, and no installed plugin opens one (scheduler, telegram and temper; the scheduler uses the browser's own `window.confirm`). If a plugin starts using `host.dialogs`, the same `view === "chat"` check applies, as a change of its own.

## Results

### H-ESCAPE-HIDDEN-QUESTION-1: hit (Oct 18)

- `tests/unit/hidden-question-escape.test.ts` failed on the old code, 16 of 22: the 12 covering-tab cases (Escape cancelled the hidden ask and stopped there), the 3 "back in the chat view" cases (at their covering-tab step) and the test of App's wiring. The 6 that passed on the old code are the chat-view and modal-order cases, today's behaviour that has to stay. With the change all 22 passed, and `tests/unit/initiatives-page-escape.test.ts` (#225) still passed, 3 of 3.
- The plan's one change named `useEscapeKey`'s `enabled` flag. It was built as "pass Escape on while the chat is hidden" instead, for the reason under "One change": the flag would put the question back above a modal opened on another tab, and the plan's goal keeps the chat view's Escape as it was. Ops, the task's accountable lead, made that call within the plan; it is not the owner's approval.
- Landed as `4b5fc22` (commit `e58a0c4d`, rebased onto `b21a292`) through `wt land` request `43-d8f2a3`, 19:09 to 19:14. Gate `scripts/check.sh --fast`: 436 files, 6225 tests passed, 6 skipped; protocol, PATCHES.md, typecheck, lint and prettier passed.
- Installed with `pi-web-deploy --landed 43-d8f2a3` at 19:15; the server answered after 2 s, and `pi-web-deploy result 4b5fc229` returned 0 with every check passed (server, page, reply, big chat, log).
- No live look, at the owner's word (m55390): the unit test above is the measure.
