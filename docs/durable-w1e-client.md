# Durable W1-E: patient connection and selected client ports

Accountable lead: Ops. Scope: requested pi-durable-cutover W1-E (#566).
This commit is client-only, not an install or cutover. W2 owns server wiring.

## Hypothesis, written before implementation

H-CLIENT-WS-UI-W1E-1 (approved task plan): the browser treated a single late
pong during a server freeze as a broken connection. Raising the quiet period
to 10,000 ms and the note delay to 2,500 ms, while re-pinging rather than
closing an OPEN socket, should eliminate client-induced drops during 5 s and
10 s freezes. Measure the real hook with a synthetic socket and fake clock:
no close or reconnect note through 12.5 s; re-ping after that; replacement only
after more than 30 s of sustained failure. A close or banner in either short
freeze falsifies the hypothesis. Existing big-frame and adaptive slow-link
allowances must remain, not be replaced with a more aggressive timeout.

The selected UI ports should fit the fork without changing server contracts:
fixed-input parser/merge checks and DOM tests must prove contiguous history
paging, quote-to-draft without sending, safe explicit follow-up clicks and an
editable but unsendable initializing Pi composer. A lost draft, arbitrary
markup execution, duplicate page, scroll jump or unbound prompt falsifies that
part. Results are recorded below after the checks, not assumed from the code.

## Source layout and upstream adaptation

The plan describes upstream's `dist/public/app.js` / `public/styles.css`.
This fork builds its client from `web/src/`; generated files are not edited.
`server/` and `package.json` are untouched. The source for the selected ports
was the published `pi-web-ui@0.111.0` package (MIT), not an upstream merge.

- `web/src/conn-health.ts`, `web/src/use-chat.ts`: 10 s quiet period, 2.5 s
  additional delay before the calm waiting note, 5 s re-ping cadence and a
  separate sustained-failure clock. A ping is not a socket close. Buffered
  traffic cannot answer a fresh wake probe; only its matching pong can.
  `pageshow`, `visibilitychange` and resume probe an OPEN socket immediately;
  a non-OPEN socket or reconnect backoff is retried immediately on wake.
  Actual close/error still uses the existing reconnect pathway, independently
  of the OPEN-socket patience. Existing slow-link adaptation is retained.
- `web/src/history-paging.ts`: normalize the approved `historyWindow`
  (`hasEarlier`, `hiddenCount`, `earliestIndex`) and upstream `historyStart`
  onto the fork's `messagesStart`. When the new protocol is advertised, send
  `load_earlier_messages` with `conversationId`, `beforeIndex`, `limit:30` and
  compatibility `count:30`. Legacy servers still receive `load_older`.
  `earlier_messages` accepts `historyWindow.earliestIndex`, `historyStart`,
  `start`, or a start inferred from the returned page size. The response must
  name the conversation. Merge only contiguous pages; ignore other-chat,
  duplicate, stale and gapped results. Keep already loaded history on resync.
- `web/src/components/MessageList.tsx`: explicit 30-item load button and
  near-top paging with request deduplication and DOM-anchor scroll retention.
  Existing exchange-digest paging stays in charge of its folded-history view.
- `web/src/components/SelectionQuoteButton.tsx`, `web/src/quote-selection.ts`:
  floating Quote pill only for text in one assistant's message; multiline
  Markdown blockquote goes into the draft, never directly to the server.
  Enter accepts the active selection; Escape dismisses it; IME is preserved.
- `web/src/action-suggestions.ts`, `web/src/components/SuggestionChips.tsx`:
  support `[[action:suggest:Label|Prompt text]]` plus upstream's comma and
  `prompt=` form. Hide markers in assistant prose, not user text or Markdown
  code examples. Deduplicate follow-ups and hide incomplete streaming markers.
  Render labels as React text; only a deliberate click sends the normal prompt.
  Disabled before the Pi session exists and while the containing reply streams.
- `web/src/components/ChatInput.tsx`: `sessionInitializingNotice` while ready
  but without a Pi session. Drafts remain editable and retained; prompt
  submission is blocked until initialized. DSH is not subject to Pi session ids.
- `themes/flow-light.css`: dynamic theme discovery already feeds the selector,
  so no hard-coded list is added. Port the light palette, monochrome accent,
  terminal palette and borderless canvas. Preserve the fork's expandable tool
  cards: upstream's flow-base assumes a different inline renderer and would
  hide the existing tool bodies. Add the fork's contrast tokens explicitly.

## Verification and outcome

First focused run: 92/93 passed, including all three real-hook 5/10/12.5 s
freeze checks. The Quote DOM test missed its first animation frame. Before
repair, H-QUOTE-FIXTURE-CLOCK-1: installing fake timers at real wall time, then
moving Date backwards to the fixture epoch, leaves fake-timers' frame epoch
unchanged (`16 - ((clock.now - startTimestamp) % 16)`), so the first frame can
fall after the test's 20 ms tick. Install the clock at the fixture epoch instead.
Expected: the first frame runs at 16 ms and the existing UI assertion passes;
a still-missing Quote pill after that would falsify this fixture diagnosis.
No production workaround or weakened assertion. HIT: the focused rerun passed
all 21 tests, including the unchanged Quote-pill/Enter assertions. The original
run's 12 connection-health and 60 theme-contrast checks also passed.

H-CLIENT-WS-UI-W1E-1: HIT on the synthetic proof. The real hook kept its socket
open with no banner at 5 s, 10 s and 12.5 s; later silence produced the calm
note and re-pings, and replacement only after sustained failure beyond 30 s.
Wake/real-close, protocol paging, quote, chip, initialization and theme checks
passed. These are client proofs, not a claim about live server freezes or W2.

Before the final regression check, H-INITIALIZED-SEND-FIXTURE-1: the existing
send-failure DOM fixture supplies `ready:true` but no session id. With async
initialization that deliberately means "not initialized", so it cannot exercise
its intended failed-send path. Supply a synthetic session id in that fixture;
retain its original send-failure and IME assertions. Expected: those existing
assertions still pass; if not, the fixture-only explanation is insufficient.

Independent read-only review found no P0/P1 issues and confirmed the fixture
repair. Before its bounded follow-up fixes:

- H-WAKE-HANDSHAKE-1: a wake/network event currently cancels even a handshake
  another wake event just started. Restore the fork's existing 1.5 s fresh-attempt
  guard (not a new limit). Paired wake events must leave the new attempt alone,
  while an old CONNECTING attempt is retried; either failed assertion is a miss.
- H-CHIP-PENDING-1: unnumbered chip prompts bypass the existing optimistic-send
  list, leaving chips visible until the server starts streaming. Give chip sends
  the normal `newPromptId()` so pending state hides them immediately. Assert the
  identifier and real-hook pending entry; no pending entry falsifies the fix.
- H-PROBE-TRACE-1: every dead quiet socket now has a probe, so testing `checking`
  mislabels silence as wake-probe failure. Test `waking` instead, matching the
  adjacent patience decision; review the two branches against the pure state
  cases. A normal quiet probe reported as a wake probe is a miss.
- H-QUOTE-FOCUS-1: a cancelled touch pointer can leave `selecting` stuck, and
  document-wide Enter can steal keystrokes from an unrelated input. Treat
  pointercancel as selection completion; ignore Enter from editables outside
  the composer. The existing quote fixture will simulate cancellation and an
  unrelated input before accepting Enter; a missing pill or stolen Enter fails.

Final bounded regression: **189/189 passed across six files**, including all
23 W1-E pure/DOM/real-hook tests, 12 connection-health tests, 60 contrast tests,
5 initialized send-failure/IME tests, 45 message-window tests and 44 existing
optimistic-send tests. H-INITIALIZED-SEND-FIXTURE-1, H-WAKE-HANDSHAKE-1,
H-CHIP-PENDING-1 and H-QUOTE-FOCUS-1: HIT on these synthetic checks. The new
chip test confirms the real hook records its pending prompt before any server
streaming update. H-PROBE-TRACE-1: HIT by source review of the wake-vs-silence
branches; this is not a live reconnect-trace observation.

`npm run build` and sealed web/test TypeScript checks passed after the fixes.
Synthetic fixtures only: no real chats, provider calls, model traffic, live UI
edits, service restart or pi-web-deploy in this task.

Focused command: `scripts/sealed.sh npx vitest run tests/unit/ws-probe-and-ui.test.ts
tests/unit/conn-health.test.ts tests/unit/accent-contrast.test.ts
tests/unit/chatinput-send-notice.test.ts tests/unit/message-window.test.ts
tests/unit/pending-sends.test.ts`.
Build: `npm run build`. Landing: the normal detached `wt land` gate.

### Landing-gate repair

First normal landing request `199-65568b` rebased onto the current `mine`, then
refused to land: 8,193 tests passed and 15 were skipped; the two failures were
both in `tests/unit/locales.test.ts`. The existing eight downloadable language
packs were missing the new `sessionInitializingNotice` key. All non-unit gate
steps passed. This was an integration MISS, not a client-probe failure.

Before repair, H-LOCALE-INITNOTICE-1: adding the one new notice in every existing
language pack will restore the repository's exact key/placeholder invariant
without weakening its checks or changing runtime behavior. Verify the four
existing locale tests and W1-E tests, then retry the normal detached landing
gate. Any remaining locale failure or UI regression falsifies this repair.

H-LOCALE-INITNOTICE-1: HIT on the focused repair check: all four unchanged
language-pack tests and all 23 W1-E tests passed (27/27), and `npm run build`
passed again on the rebased tree. The complete normal landing gate remains
required; this result does not waive it.

## Undo and integration boundary

Revert this client commit and build/install through the normal approved
release path. It changes no stored chats or settings and needs no migration.
No live install is authorized by this task. W2 must supply actual async-init
snapshots and the advertised paging protocol; legacy operation remains valid
before those server changes land.
