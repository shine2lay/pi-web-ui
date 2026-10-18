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

**Result: HIT.** Look-only live check 2026-10-18 10:41 PDT on live build 92f7c21d, which carries ca613762 (`~/kept-from-tmp/2026-10-18/roles-sent-live/look.mjs`, `out-1/result.json`, `out-1/roles-graph.png`).

- Store at that moment: 1,000 messages, 7 open requests or questions in 6 sender → receiver pairs (ops → architecture 1; temper → coo 1, frontend 1, ops 2, qa 1, security 1). Left out: 298 answered, 0 failed, 694 fyi or reply, 1 to itself, 0 off the page. A second look found the same pairs.
- The feed's `openPairs` equal the store's. The graph draws 6 role-to-role arrows, one per pair, each head at the receiver, each label naming the same two roles and the same count.
- All 15 "Asked of others" lines match the store: Ops "1 open · newest to System architecture, 4 days ago: …" (first line equal to the store's), temper 6 open, the other 13 "0 open". Cards: Ops "Waiting on System architecture", temper "Waiting on 5 roles", no line on the other 13.
- Owner-ask arrows: `ownerEdges` is the same code before and after, drawn on top of the new arrows. None showed in this look because the asks list couldn't be confirmed then, and by the existing rule the page draws none in that state.
- 0 page errors; the page sent only `hello` and `roles_watch`.
- Install: ca613762's own install (09:59) had the big-chat check time out (that check is flaky and doesn't touch the Roles page); the next two installs carrying it, 5e41baa6 (10:13) and 92f7c21d (10:22), passed all five checks, and `pi-web-deploy result ca613762` gives 0.

Known, not fixed here:

- The key's text is updated, but the page doesn't show the key: the owner removed the Legend row on 2026-10-17 (d9cc7e41, `ready: false`). Each arrow's label still says what it means to screen readers.
- When the page shows last-received data, the arrows dim to 0.55, as in the supplied design (its edge code: `lastKnown ? '0.55' : '0.95'`). Then the "N open" label is 4.0:1 against its background (4.5:1 needed) and the line 2.2:1 (3:1 needed); at full strength they are 10.0:1 and 4.4:1. Dimming them like the cards (0.8) would give 7.3:1 and 3.5:1: a candidate for another pass. axe can't run in the Roles frame, so contrast was computed from the colours.
