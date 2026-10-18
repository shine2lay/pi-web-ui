# Roles: how far each role's current task has got

Ops #207 (owner, 2026-10-18: "create those tasks and queue them"). Accountable lead: Ops.

## H-ROLES-EVIDENCE-1

**Wrong, and the evidence.** Every role panel's Completion evidence row said "Not connected" for Built, Checked, Installed, Live and Confirmed: the view hard-coded it (`web/src/roles-exact-view.ts`, `at: "Not connected"` in `box()`). Nothing could fill it, because no record linked a task to the commit it landed: wt knew branches and lands, pi-web-deploy knew installs, the queue knew tasks and their chats, but nothing tied a chat to a branch.

**One change, and why it should fix it.** wt records which chat made each branch and which commit each land put on the base (agent-tools 3e2e2bc, its README's wt section); the Roles overview joins those records with pi-web-deploy's own and shows the times.

- The records, in wt's state folder (`WT_STATE`, or `~/.local/state/wt`), append-only, 0600, kept 90 days, ids, paths and times only:
  - `branches.jsonl`, written by `wt new`: `{v: 1, at, repo, branch, worktree, session?, chat?}`. `session` is the chat's transcript (`PI_SESSION_FILE`), `chat` its id (`PI_SESSION_ID`), each only when set. The terminal-mode bash now exports both like the plain bash does (`terminalSessionEnvPrefix` in `server/terminals.ts`), so a chat in either mode is recorded.
  - `lands.jsonl`, written by `wt land` once the base branch has fast-forwarded (its checks passed): `{v: 1, at, repo, branch, commit, committedAt}`.
- The join (`server/roles-evidence.ts`): a task's own chat (its transcript, from the queue) → the branch records that chat made (every id a record holds must name it; a record naming two chats names none) → the lands of those branches (a land belongs to the newest record of its repo and branch made before it, so a reused branch name never gives one task another task's commit) → the newest of them.
- The five steps:
  - Built: the landed commit's commit time.
  - Checked: the land's time (wt lands only after the gate passed).
  - Installed, pi-web-ui only: when the first pi-web-deploy install that went in with it ended. That is the first line of `~/projects/.pi-web-ui-stage/history.jsonl` that swapped in, came up, wasn't rolled back and passed all its checks, whose commit is the landed commit or contains it (`git merge-base --is-ancestor`, asked once per pair and remembered: the answer never changes).
  - Live, pi-web-ui only: the live build (`~/projects/pi-web-ui/dist/.pi-web-deploy.json`) contains it now; its time is that install's checks.
  - Confirmed: the queue task was marked done after Live (after Checked for other repos).
- What a step says without a time: "not yet" (the task has a record but hasn't got that far), "Not tracked for <repo>" (Installed and Live outside pi-web-ui: only pi-web-deploy's installs are followed), "Not recorded" (no record links the task's chat to a branch: older tasks, nothing guessed, no backfill; an older server).
- Sent as an optional `UiRoleTask.evidence` (no protocol bump). The page checks every step (`evidenceOf` in `web/src/roles-useful-model.ts`) and draws the row for the role's current task (`exactEvidence` in `web/src/roles-exact-view.ts`): times in the supplied design's done style, "not yet" in its pending style, the rest in the page's missing-data style.

**Expected result, and how it is measured.** For the next pi-web-ui task landed after this change (this task's own branch, `roles-evidence`, was the first recorded), its role's row shows Checked equal to its `lands.jsonl` time and Installed equal to its pi-web-deploy install's end (`history.jsonl`, the time `pi-web-deploy result <sha>` reports done), within a minute; Built equals the commit's time. Measured by the unit tests on fixed record files (`tests/unit/roles-evidence.test.ts`) and one look-only live check after install, comparing the row with the record files.

**What would prove it wrong.** The row's times disagree with wt's and pi-web-deploy's own records, or a task shows another task's commit.

**Limits.** The overview only reads: four bounded plain files, re-read only when their size or time changes, plus at most one git ancestry question per install and landed commit pair. It loads no chat, calls no model and writes nothing; the records hold no message text. wt's landing, its gate and pi-web-deploy's behaviour are unchanged. Installs of other repos (temper-deploy, pi add-ons) aren't followed. Minimal checks (owner, Oct 17: "build ship it, only test minimally").

**Undo.** `pi-web-deploy rollback`, or revert this commit and deploy; revert agent-tools 3e2e2bc to stop the records (the files are inert).

**Result, first live look (Oct 18 10:34, 92f7c21d installed; the page's own feed, read by a look-only pseudo client, compared with the record files):**

- The times match to the millisecond. Task #207 (this change, pi-web-ui): Built 10:12:51 (the commit), Checked 10:19:57 (`lands.jsonl`), Installed 10:22:00 (the install's end in `history.jsonl`; `pi-web-deploy result 92f7c21d` reported "10:22 deploy of 92f7c21d: live, and the checks all passed"), Live 10:25:01 (that install's checks). Task #212 (pi-worktree): Built 09:40:07 and Checked 09:41:20, Installed and Live "Not tracked for pi-worktree".
- Tasks with a branch but no land say "not yet"; older tasks say "Not recorded". No task showed a commit its own chat didn't land.
- On the page, the Ops and Backend rows (dark, light, phone) equal their current tasks' evidence; contrast 9.93. Both current tasks were older ("Not recorded"), so no row on the page showed times yet.
- One miss: Ops #214 and #215 said "Not recorded" though their chats had made branches. See H-ROLES-EVIDENCE-2.

## H-ROLES-EVIDENCE-2

**Wrong, and the evidence.** In that look, Ops tasks #214 and #215 said "Not recorded" although `branches.jsonl` held branches their chats made (two and one), while #213, made the same way, said "not yet". The overview resolves a task's chat file only for a role's first `ROLES_TASK_CHATS_MAX` (8) started tasks, the chats whose TL;DR lines it reads, and the evidence took the file from there. Ops had 10 open tasks; #214 and #215 were the 9th and 10th.

**One change, and why it should fix it.** When that capped scan didn't resolve a task's chat file, the evidence takes it from the task's own queue record (`info?.file ?? t.chat?.file` in `server/roles-overview.ts`). The evidence only compares file names, so this still reads no chat.

**Expected result, and how it is measured.** A unit test with nine started tasks: the ninth one's chat made a branch, so its row says "not yet", not "Not recorded" (the test fails without the change). Live: open tasks past the 8th, like #214 and #215, say "not yet" or show times.

**What would prove it wrong.** After the install, a started task whose chat made a branch still says "Not recorded", or a task shows a branch another chat made.

**Result:**
