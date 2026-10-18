# Left panel: each task chat's waiting or blocked status

Ops #213 (owner, 2026-10-18). Accountable lead: Ops.

Owner, Oct 18: "if a task is waiting, lets have a waiting status, like testing, if its waiting on another task then it's blocked, right now if ilook over the left panel, i see 199 is not doing anything idk if its waiting on something or not".

## H-LEFT-STATUS-1

**Wrong, and the evidence.** In the left panel a queued task's chat that is waiting or blocked looks the same as an idle chat: no dot, no label, just "N messages" or its last TL;DR. The owner's report about #199, which has waited since Oct 17 15:42 on "the reminder fix's install, then a look-only day…", is the evidence.

**One change, and why it should fix it.** Show the task's own queue status on its chat's row, as a short label on the row's second line:

- "Waiting: <what it waits on>" for a queue_wait;
- "Blocked on #12, temper #38" when it waits on tasks, "Blocked: <need>" when it waits on a need (or on a lead's result);
- "Needs decision" when its question is with the owner (stuck); while its question is with its queue's lead (asking), the Queue panel's words: "Asking Ops", "Asking <role>'s lead" or "Asking the main chat";
- "Paused" when the owner paused it or its whole queue (checked first). That includes a task at work: a paused task keeps its status, so once its chat finishes the step it was on, the idle chat says "Paused" rather than looking idle.

The server already keeps every open chat's queue (taskQueueOfConv's cache). A pure function (`server/queue-chat-status.ts`) turns a task into an optional `queueStatus` on the row, using the task chat's own record (the truth about the task) over its queue chat's copy, and the queue chat's record for the owner's pause. The rows get it where they get their queue-home links. A working chat keeps its running dot and gets no label; ready, done and dropped tasks get none.

**Expected result, and how it is measured.** Unit tests map each status to the right label (waiting, blocked on tasks, blocked on a need or a lead, stuck, asking, paused first, working and finished none, long text cut short). Live, #199's row reads "Waiting: the reminder fix's install…", and a blocked task (if one is open) reads "Blocked on …". Measured by the unit tests and one look-only live screenshot after install.

**What would prove it wrong.** A waiting or blocked task chat shows no label or the wrong one, or a working or finished chat gets a label.

**Limits.** No change to the queue's behaviour, task statuses or pi-queue; no labels on chats that aren't open queued tasks; no new reads of chat files (only the queue state the server already caches). Minimal checks.

**Details Ops chose.**

- The label sits on the row's second line (where "N messages" or the TL;DR goes), with the TL;DR after it when there is one. Task chats' titles are long ("Queue #213: Left panel: …"), so a label after the title would be cut off by the title's "…".
- Colours follow the Queue panel and the TL;DR lines, so a kind means the same everywhere: blocked in the Blocked colour (cyan), "Needs decision" in the needs-you amber, paused grey and dotted like the Queue panel's Paused badge, waiting and asking in blue. The plan's amber for waiting would have looked the same as "Needs decision".
- No "Needs decision" or "Asking …" label when the row already shows the "?" badge; no label while the chat is running.
- No protocol version bump: the new field is optional, so an old page with the new server (or the other way round) just shows no label.
- The tooltip gives the whole text, since when (and how long), and for a wait how often it is checked and when it gives up.

**Result:** HIT (2026-10-18 11:15-11:20, d5989391 installed 11:11; pi-web-deploy's checks server, page, reply, big chat and log all passed).

- Unit tests: tests/unit/queue-chat-status.test.ts maps every status to its label and passes in the sealed gate.
- Live, look only (headless Chrome as its own client `carry-on:ops-live-look-213`, nothing clicked but the left bar's "All chats" view; script and shots in ~/kept-from-tmp/2026-10-18/left-task-status-live/):
  - #199's row reads "Waiting: the reminder fix's install, then a look-only day of real le…" (cut with "…"); its tooltip reads "Waiting on “the reminder fix's install, then a look-only day of real lead reminders (ends early on a fault or once 3 are measured)” / Since Sat 15:42 (19h) / Checked every 10 min; gives up Oct 19 07:42".
  - Leads view: 20 task rows. The 8 parked Ops tasks read "Waiting: …", the other roles' 9 paused tasks read "Paused" (temper #68, #70 and marketing #3 are blocked and paused: paused comes first), the 3 working chats (#206, #213, #216) keep their running dot and no label.
  - Recent chats: the same 8 "Waiting: …" rows, the 3 working task chats without a label; no label on any non-task row or any History row (#199's History entry has none).
  - axe on all 17 labels, dark and light: no serious or critical issue.
- No task was blocked (and not paused) or waiting on the owner at the time, so "Blocked on …" and "Needs decision" were seen only in the unit tests, not live.
