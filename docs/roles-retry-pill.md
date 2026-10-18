# Roles: the status pill retries; no freshness banner

Ops #215 (owner, 2026-10-18: "lets also remove this … from roles page, make the status on the top right clickable for retry instead"). Accountable lead: Ops.

## H-ROLES-RETRY-PILL-1

**Wrong, and the evidence.** A full-width banner said "Some owner asks could not be confirmed. The received list may be incomplete. Open the original chats for anything not shown here.", with a "Retry now" button, and the owner finds it useless (m56472). `web/src/roles-exact-view.ts` showed it whenever the source wasn't fully confirmed (`banner.show: unavailable`). By the code that includes the first seconds after every page open: the first update after a watch is a replay that confirms nothing (`lookedAgain` in `web/src/roles-state.ts`). An unchanged overview is only confirmed by the server's next heartbeat, up to 30 s later (`RolesWatch` in `server/roles-overview.ts`, `heartbeatMs` 30 000).

**One change, and why it should fix it.** Hide the banner and let the status pill do its job.

- The live adapter sets `banner.show` false, the way the helper row was removed (`ready: false`). The supplied template keeps its banner markup, unused, so the same-input reference comparison still covers it.
- The pill (`web/src/roles-u0/surface.html`) gets a native button inside its `role="status"` div. A click, Enter or Space runs the banner's old action, `actions.reload()` (a fresh `roles_watch`). It is always clickable: a retry when the status isn't live, a refresh when live.
- The banner's reason moves into the pill's tooltip: its title and body, then "Click to retry"; "Click to refresh" when live. The button's name is the pill's text plus "Retry now" or "Refresh now".
- Landed after #206 (roles-small-fixes), which reworded the same pill: its "Asks unconfirmed: …" labels stay, and its reasons (`ASKS_UNCONFIRMED`) are the tooltip's body when the feed is connected but the asks can't be confirmed. #206's phone tall-header geometry check used the stale banner to make a tall header; without the banner the header changes only through the pill's text, so that step now checks the stale and live headers (`tests/roles-exact-test.mjs`, "phone, stale header").
- The button is styled to look exactly as before (no background, border or padding; inherited colour and font). A stretched `::before` makes the whole pill the click target and carries the focus ring.

**Expected result, and how it is measured.**

- Unit tests (`tests/unit/roles-exact.test.ts`): the banner is hidden in every source state, the tooltip holds the reason, and one pill click calls reload once.
- The supplied-reference pixel comparison (`tests/roles-exact-test.mjs`, reference frames) still finds 0 different pixels, so the pill looks the same.
- Live, look only: no banner row; the pill's tooltip gives the reason; a click reloads (the page sends `roles_watch`, and the pill's time changes).

**What would prove it wrong.** The banner shows in any state, a click (or Enter, or Space) doesn't reload, or the pill looks different.

**Limits.** No change to the Roles data, other sections, the inbox's own empty text ("Current owner asks could not be confirmed.") or the answer flow. The replay-then-heartbeat timing above is unchanged: right after a page open or a click, the pill can say "Asks unconfirmed: still checking" in amber for up to 30 s. Minimal checks (owner m55390). Undo: revert this commit, then `pi-web-deploy`.

**Result:** unit tests hit (83 of 83 in `tests/unit/roles-exact.test.ts`, after the rebase on #206 and #207). Sealed browser check: all 14 component checks pass (a click, Enter and Space send three `roles_watch`; no alert row in the error, disconnected and stale states). Reference frames: the pill's own crop (`state-chip`) 0 different pixels, and desktop, phone, loading and empty-inbox 0. phone-stale (20 px) and phone-disconnected (26 px) differ only at y 275-369, rounded card edges well below the header, in the same pixels with and without this change (Oct 18 10:28 and 10:31 runs; phone-disconnected is intermittent, 0 in one of them): an older mismatch this change leaves alone.

Live (look only, 2026-10-18 13:28-13:29 PDT, 6901c168 installed 13:19, pi-web-deploy's checks all passed, `pi-web-deploy result` 0; own clients, desktop dark and light):

- No banner: no alert row and none of the banner's words, in either theme and after the click.
- The status was "Asks unconfirmed: some roles not read · last received 13:28" (amber). The pill is one native button inside the `role="status"` div. Its tooltip is the banner's old title and body, then "Click to retry". Its name is the pill's text plus "Retry now". The native tooltip shows under the real pointer (headful Chromium on its own X display; crop kept).
- It looks as before: the button has no background, border or padding; its colour, font (550 13px) and family are the pill's own; pointer cursor. The pill is 421×32 with a 1px border and 999px radius. The header before (#206's look at 11:10) and after match apart from the time.
- One click sent exactly one `roles_watch`; a fresh overview came 1.5 s later, and the pill's time changed from 13:28 to 13:29.
- axe on the pill: no serious or critical findings; text contrast 10.77:1; no page errors.
- Not seen live: the live status's "Click to refresh" (the asks weren't all confirmed during the look) and Enter and Space. The unit tests and the sealed browser check cover those.

**Hit.** Screenshots and numbers: `~/kept-from-tmp/2026-10-18/roles-retry-pill-live/out1/`.
