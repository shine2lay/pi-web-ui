# Roles: small known issues pass

Ops #206 (owner 2026-10-18, "create those tasks and queue them"). Accountable lead: Ops. The small issues left from Security's two reviews and the floating-header check, one commit each. Minimal checks (owner: "build ship it, only test minimally"). Undo: `pi-web-deploy rollback`, or revert the commit and deploy.

Sources: `/home/shinelay/security-lab/roles-answer/REVIEW-5f2cddad-filter.md` (N1, N3) and `/home/shinelay/security-lab/roles-exact/REVIEW-f0a35666.md` (N1, N2, N3); the floating-header live check, `/home/shinelay/kept-from-tmp/2026-10-17/roles-floating-header/live-diagnostic/result.json`.

## H-SMALL-1: answer filter (REVIEW-5f2cddad-filter N1)

**Wrong, and the evidence.** "One external-data path can produce an allowed title. In an MCP form elicitation, each field's pop-up title is built from the server's schema ... so it can be 'Add to the queue?'." The page's allow-list (`roleAnswerKindAllowed`, `server/roles-asks.ts`) checked only the title, so such a pop-up would be answerable on the Roles page.

**One change, and why.** Accept a plan title only in pi-queue's own confirm shape: `ctx.ui.confirm(title, "### Task #...")` gives exactly one Yes/No field (`value`, options yes/Yes and no/No), no typed answer, and a body starting "### Task #". An elicitation pop-up is a select or input with no body, so it can't match. The same check serves the overview (which attaches an answer target only when allowed) and the answer path (`askViewOf`), so nothing else changes. Narrows only.

**Expected, and how it's measured.** Unit tests (`tests/unit/roles-answer.test.ts`, `roles-overview.test.ts`): pi-queue's real confirm stays answerable; an elicitation select, an elicitation input, a body not from the queue, no body, a typed answer and select-style yes/no labels all stay Open chat.

**What would prove it wrong.** An elicitation-shaped ask with the plan title gets an Answer button, or pi-queue's own plan confirm loses it.

**Result:** unit tests hit. Live: no owner asks were open during the look (2026-10-18 11:10), so there was nothing to answer or to show as Open chat, and the page showed no Answer button. Hit, proven by the unit tests only.

## H-SMALL-2: answer dialog kind and departure (REVIEW-5f2cddad-filter N3)

**Wrong, and the evidence.** "The dialog doesn't name the ask's kind, and an open dialog isn't closed when its item leaves the list (the server refuses the stale answer)."

**One change, and why.** The dialog header reads "role · Plan to approve / Question / Stuck task" (`roleAnswerKindKey`), and the dialog closes itself once a live, whole list no longer holds its ask (`roleAnswerGone`, `web/src/roles-answer-model.ts`). It never closes while an answer is being sent or after it was sent (so the receipt stays readable), and not when the list can't say for sure (not live, partial, cut by "N more").

**Expected, and how it's measured.** Unit tests: each kind names itself; the dialog closes for a missing ask (also the same key with another id) on a live list, and stays open while sending, after sending, on a list that can't tell, and on a cut list.

**What would prove it wrong.** A dialog stays open over a stale ask on a live list, or one closes while its answer is on its way.

**Result:** unit tests hit. Live: no owner asks were open during the look, so there was no dialog to open. Hit, proven by the unit tests only.

## H-SMALL-3: why asks can't be confirmed (REVIEW-f0a35666 N2)

**Wrong, and the evidence.** "When the feed is connected but asks can't be confirmed (partial, decision or not-live), the banner is hidden and the freshness label is a green 'Reported status' ... it doesn't give the reason." Since `5b1afe1f` the label was already amber ("Incomplete status") with a banner, but still without the reason.

**One change, and why.** For a connected feed whose asks can't be confirmed, the amber label names the reason and the banner explains it, in fixed words: "Asks unconfirmed: still checking", "... some roles not read", "... a stuck task's question is missing" (`ASKS_UNCONFIRMED`, `web/src/roles-exact-view.ts`). Wording only.

**Expected, and how it's measured.** Unit test (`tests/unit/roles-exact.test.ts`): for awaiting, partial and decision, the label reads "Asks unconfirmed: <reason> · last received 12:00" in amber (`#F0B95A`), never green, and the banner shows the reason instead of the generic "may be incomplete".

**What would prove it wrong.** Any of the three shows a green label or the generic wording.

**Result:** unit test hit. Live hit: the page shows the amber "Asks unconfirmed: some roles not read · last received 11:10" (#F0B95A) with its banner, where it showed a green "Reported status" before. The reason is real: Ops had 11 started task chats, and the page reads asks from at most 8 per role (`TASK_CHATS_READ`), so an ask in a later chat could be missing.

## H-SMALL-4: "N more" tasks (REVIEW-f0a35666 N3)

**Wrong, and the evidence.** "Each role lists at most 20 active and 20 queued tasks (RECORD_LIMIT) ... a 'N more' line would make the cut visible." Checked: `5b1afe1f` added a `taskOmission` line that already counts both cuts (the page cuts the active list, the server the queued one). One gap was left: one hidden task read "1 more tasks".

**One change, and why.** Singular for one task. Nothing else needed.

**Expected, and how it's measured.** Unit test: 21 active, 0 queued says "1 more task not shown here"; 25 active and 22 queued says "7 more tasks not shown here".

**What would prove it wrong.** A cut list without the line, a wrong count, or "1 more tasks".

**Result:** unit test hit. Live hit: Design's panel reads "11 more tasks not shown here. Open the full queue.", the 11 queued tasks the feed holds back.

## H-SMALL-5: report sections over 1,000 lines (REVIEW-f0a35666 N1)

**Wrong, and the evidence.** "More than 1,000 non-empty lines makes the binder throw ('bounded list required') when the owner opens that role's report."

**Finding, before any change.** Architecture's six-am removal (AGENTS rule 25) already took the report sections off the Roles page: no report value is bound anywhere in the page (`web/src/roles-exact-view.ts`, `web/src/roles-u0/surface.html`), so no report can reach the binder. Nothing to cap. The sealed check's long-report step still clicked the removed "6 am report" button and timed out; it now asserts that the section is absent.

**Expected, and how it's measured.** The sealed check (`tests/roles-exact-test.mjs`) delivers a report of over 1,000 lines, opens the role's panel, and finds no report section and no binder failure.

**What would prove it wrong.** A report section shows on the page again.

**Result:** hit by removal (sealed check passes). Live: the panel has no report section.

## H-SMALL-6: phone header covering a card

**Wrong, and the evidence.** The live check on 2026-10-17 measured 4.76 px between the floating header and the top card at 390 px, and one overlap.

**First hypothesis (from the plan), disproved before any change.** "The reserved space is too small: add an 8 px minimum." Measured with the sealed geometry check: once settled, the gap is already 30-39 px at every width (desktop 39.38, laptop 32.16, phone 30.41), because the reserved space is the header's height plus 24 px. The live record shows why it dropped: the graph's min-height was 855 px while the plan needed 918 px (620 + 298 px header space), so the graph was mid-animation.

**Revised hypothesis.** The cards are placed (as percentages) for a graph height the graph doesn't have at that moment:

- after the header grows, the design's `transition: min-height 340ms` animates the graph up to the new height, so for up to 340 ms it is shorter than planned and the cards sit higher (before the fix, phone with a tall header: min-height 852.85 px against 896 px planned);
- after the header shrinks, the plan reads the graph's old, taller height before the smaller reserved space lets it shrink, and nothing plans again until the next update (diagnosis run, phone, header shrinks back: planned 896 px, graph 768 px, gap 6.35 px).

**One change, and why.** Keep the graph exactly at the planned height before paint: no min-height animation in the floating layout (`web/src/roles-u0/surface.html`), and when the header or the graph changed size while the values were applied, plan again in the same frame (`refit()` in `web/src/roles-exact-view.ts`, at most 3 more passes in `RolesExactView.tsx`). The reserved space itself is unchanged.

**Expected, and how it's measured.** The sealed geometry check (`tests/roles-exact-test.mjs`), now demanding 8 px (was 4) and the graph's height equal to the plan's (the SVG viewBox), at 1440, 1050 and 390 px, with a disconnected and a stale banner, and on a phone with a tall header and after it shrinks back. Desktop gaps stay as they were.

**What would prove it wrong.** Any case under 8 px or with the graph off its plan, or a changed desktop layout.

**Result:** sealed check hit (14 of 14). Phone: 30.41 px settled, 29.7 px with a tall header (graph 896 px = plan), 30.41 px after it shrinks back (was 6.35 px, graph 768 px against a 896 px plan). Desktop gaps unchanged: 39.38 px (1440), 37.13 px (with a banner), 32.16 px (1050), 9.41 px (department panel). Without the fix the same check fails (min-height 852.85 px against 896 px; 6.35 px after the shrink). Live hit: the smallest gap between the floating header and any card was 15.41 px on desktop (1400 px, dark and light) and 15.36 px at 390 px, in every frame for 4 s from the first card (221, 222 and 241 frames; none under 8 px, none off the plan), with the graph at its planned height (840 and 953 px). Before: 4.76 px and one overlap. The header's height didn't change during the look; the sealed check covers one that grows and shrinks.

## Live look

Look-only, 2026-10-18 11:10, on 570f5259 and d5989391 (both contain 9f6b878f): own carry-on clients, GET only, the socket limited to hello and roles_watch. Desktop 1400 px dark and light and phone 390 px dark: no page errors, no serious or critical axe findings on the header, no sideways scroll. Scripts and receipts: `~/kept-from-tmp/2026-10-18/roles-small-fixes-live/` (`look.mjs`, `panel.mjs`, `out/`, `out-panel/`).
