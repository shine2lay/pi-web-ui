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

**Result: HIT** (2026-10-18 09:05 PDT, installed a64522a5; pi-web-deploy checks server, page, reply, bigchat and log all passed).

- Look-only live check (`~/kept-from-tmp/2026-10-18/roles-lanes-live/look.mjs`, own carry-on clients). The Ops Queue panel showed Lanes at once 8, with two tasks working in their own chats (#199 and #203), both in Lane 1. The Ops card said "1 of 8 lanes in use" with 8 pills and 1 busy, the same in readings taken before and after the panel.
- All 13 roles with a readable queue showed pills and the sentence: architecture 0/5, backend 1/4, data 0/3, design 3/3, frontend 1/3, marketing 1/2, ops 1/8, product 1/3, qa 0/2, rollcall 0/2, security 0/4, systems 0/3, temper 2/4. COO and Docs have no queue and still said "Not recorded". N never exceeded M.
- Note: two started tasks that share a lane count as one lane in use, as the Queue panel numbers them (Ops shows 1 lane in use with 2 tasks in their own chats).
- Cosmetic, left as is: on the narrow card the sentence wraps "in use" onto a second line.
