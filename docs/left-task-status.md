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

**Result:** (pending)
