# Roles: own-work budget on the card, spending first in its panel

Ops #265 (owner, 2026-10-19 about 18:50, in the Ops home chat: picked "Show it on the main view" over counting all spending, both, or leaving it). Accountable lead: Ops.

## H-BUDGET-CARD-1

**Wrong, and the evidence.** The main view showed no budget or spending at all. Live look, 2026-10-19 18:48, 1400×1000: no spend or budget text visible without a click. Design's $579.65 of $2,000 showed only in the You panel and at the bottom of Design's panel: its "Spending this week" heading sat at y=1549 in a 916 px frame, in a panel that scrolls 3695 px.

**One change, and why it should fix it.** A spend line and bar on the cards of roles whose tally is reported, and the spending section first in their panels.

- `web/src/roles-exact-view.ts`, `exactCardSpend`: a reported tally with figures (`ExactSpend.reported`: state ok, stale or over) gives the card the feed's exact figures, "$579.65 of $2,000 this week", or "Budget used up" when over; a bar as wide as the ratio, coloured by the You panel's rule (now one function, `spendColor`): red over, amber stale or last received data, blue otherwise; and a name for screen readers, "Design own-work budget: $579.65 of $2,000 this week". No budget, an old week, an unreadable file or figures the model can't read give no line, never "$0".
- `web/src/roles-u0/surface.html`: the line sits under the card's lanes row in the lanes text's style (11.5 px Geist Mono, #B9BEC5), with a 4 px bar, both in one `role="img"` carrying that name. A reported role's panel opens with "Spending this week" first, right under its title line. Every other panel keeps the section where it was (`spendBelow`), and so do the native view (`web/src/roles-u0/native.ts`) and the supplied design's reference model (`tests/roles-u0/reference-model.js`), so the same-input pixel comparison is unchanged.
- Layout: the line makes the card 48 px taller (146.8 px against 98.4 px: the figures take two lines in a 150 px card, then the bar). Arrow labels route around the taller card (`obstacleHalfHeight`). On wide screens the card stays centred on its ring spot. Under about 1300 px wide the inner ring's 250 px floor puts Ops and COO close beside the side cards, so `exactCardShifts` keeps the card's edge on the tighter side where the design puts it and lets it grow toward the roomier side (at 1050 px Design grows 24 px down instead of 24 px into Ops). Other cards keep their spots; the phone column stacks measured heights and needs nothing.
- Unchanged: how spend is read and counted (`server/roles-spend.ts`, spend.json), `projectSpend`, the You panel's figures. No line for requested work, and no budgets for other departments.

**Expected result, and how it is measured.** Design's card shows "$579.65 of $2,000 this week" (or the then-current figure) without a click, on desktop dark and light and on a phone; its panel's spending heading sits inside the first screen (top < frame height) without scrolling; the other 14 cards are unchanged and no two cards overlap. Measured by the unit tests, the sealed browser check, and a live look (1400×1000 dark and light, 390×844 phone).

**What would prove it wrong.** The line is missing, any card shows "$0", cards overlap or get clipped, or the heading still needs a scroll.

**Limits.** At 1050 px (the sealed laptop check) the ring already had four corner touches of 13×5 to 14×7 px before this change (COO/QA, COO/RollCall, Data/Ops, Design/Ops). With the line, Design also touches Docs's corner, 29×5 px: the room between Ops and Docs there is about 10 px short of the taller card. Nothing deeper than 10 px, and none at 1440 px or on a phone. Undo: revert this commit, then `pi-web-deploy`.

**Result (sealed):** `tests/unit/roles-exact.test.ts` 106 of 106 (new: exact text, width, colour and name; no line for no tally, none, old week, unreadable, or figures the model can't read, seven cases; over; stale and last received; panel order; the shift). `tests/roles-exact-test.mjs`: 15 of 15 component checks. Design's card 146.77 px tall with "$1,240.50 of $2,000 this week" (the harness's figure) and a 62% bar; no other card shows spend text; no overlap, nothing outside the canvas or clipped at 1440 px and 390 px; at 1050 px only the corner touches above. Design's panel opens with "Spending this week" first, its top 218 px in a 1300 px frame unscrolled; on the phone sheet 191 px in 844. Reference frames: 0 different pixels except phone-stale (20 px), the older rounded-edge mismatch `docs/roles-retry-pill.md` describes, which the code before this change shows too (with phone-disconnected 26 px in that run).

**Live:** pending.
