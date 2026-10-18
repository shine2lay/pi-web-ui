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

**Result:**
