# Roles: sent requests and arrows between departments

Ops #205, third of the owner's "Finish Roles' easy gaps" tasks (2026-10-18). Accountable lead: Ops.

## H-ROLES-SENT-1

**Wrong, and the evidence.** A role panel's "Asked of others" line said "Missing", no card said who a role is waiting on (`hasRel: false`), and the arrow key said between-department message tracking was not connected (`web/src/roles-exact-view.ts`). Yet the role-message store (`server/role-messages.ts`) holds every open request's sender and receiver; the page already counts them per receiver with `openRequestsTo`.

**One change, and why it should fix it.** Project the open requests by sender and by pair, by `openRequestsTo`'s own rules (kind request or question, no reply, not failed; a role to itself never counts), and draw them:

- `openRequestsFrom(role, keep)`: how many, and the newest (to whom, kind, first line, time). Sent as an optional `UiRoleOverview.sent`.
- `openPairs()`: each sender → receiver pair with a count and the newest time. Sent as an optional `UiRolesOverview.openPairs`.
- Only roles on the page count, as sender and as receiver; anything else is skipped.
- The panel line reads like "Requests in": "N open · newest to Temper, 3 h ago: <first line>".
- The graph draws one arrow per pair in the supplied design's between-department style (`#4A82C0`, curved toward the centre, the two directions split apart, head at the receiver, an "N open" label), under the owner-ask arrows, which stay as they were; hover dims unrelated arrows and cards like the owner arrows do.
- A card says "Waiting on Temper" or "Waiting on N roles"; the key explains what the arrows mean.

**Expected result, and how it is measured.** At one moment, the number of role-to-role arrows equals the number of sender → receiver pairs (both on the page) with open requests or questions in the store, each pointing from sender to receiver, and the Ops panel's sent count equals the store's count of Ops's open ones. Measured by the unit tests on fixed stores and one look-only live screenshot after install, compared with the store read at that moment.

**What would prove it wrong.** An answered or failed request shows, a pair is missing, or an arrow points the wrong way.

**Limits.** No sending, answering, closing or marking from the page; only a message's first line. No new reads beyond the store the overview already holds in memory, no writes, chat loading or model calls. Minimal checks (owner, Oct 17: "build ship it, only test minimally").

**Result:** (pending the live check)
