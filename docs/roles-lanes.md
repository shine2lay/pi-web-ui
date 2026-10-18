# Roles: task lanes on each card

Ops #203, first of the owner's "Finish Roles' easy gaps" tasks (2026-10-18). Accountable lead: Ops.

## H-ROLES-LANES-1

**Wrong, and the evidence.** Every role card showed task lanes as "Not recorded", and the role panel said "Task-lane occupancy is not recorded". The view hard-coded both (`web/src/roles-exact-view.ts`, `lanes: []`, `lanesText: NR`). Yet the queue state the Roles overview already reads holds the queue's lanesAtOnce and every started task.

**One change, and why it should fix it.** Project both numbers in the overview from the queue it already replays, with the Queue panel's own rules, and draw them:

- M = the queue's lanesAtOnce, 2 when it was never set (`server/protocol.ts`, `UiTaskQueue.lanesAtOnce`).
- N = the lanes held by started open tasks in chats of their own: working, asking, stuck, waiting or blocked, the Queue panel's "Working in their own chats". Parked tasks keep their lane (Ops note n189), owner-paused ones too. Two started tasks in one lane hold one lane. A task worked on in the queue's own chat has no lane and doesn't count. N never exceeds M.
- Sent as an optional `UiRoleQueue.lanes: { atOnce, inUse }`; the page takes it only from a readable queue with whole numbers 0 ≤ N ≤ M ≤ 8.
- The card draws M pills, the first N in the supplied design's "working" style (`#7DB8FF`) and the rest in its "free" style (`#4A4F57` outline), with "N of M lanes in use"; the role panel's Task lanes line says the same sentence.

**Expected result, and how it is measured.** The Ops card shows the same numbers as the Ops Queue panel at the same moment: M = its "Lanes at once", N = the distinct lanes of its "Working in their own chats" tasks. A role without a readable queue still says "Not recorded". Measured by the unit tests on fixed queues and one look-only live screenshot after install.

**What would prove it wrong.** The numbers differ from the Queue panel, a role with no queue shows numbers, or N ever exceeds M.

**Limits.** No new reads, writes, chat loading or model calls in the overview; no change to how the queue runs lanes or to any queue setting. Minimal checks (owner, Oct 17: "build ship it, only test minimally").

**Result:**
