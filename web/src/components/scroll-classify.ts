/** Pure classification of an onScroll event — no DOM, no refs. The onScroll
 *  handler in MessageList applies the returned actions. Semantics preserved
 *  verbatim from 5cd680b:
 *   - graceActive (programmatic snap window): do nothing — our own jumps must
 *     never be read as upward user intent.
 *   - Large negative jump (dSt <= -500): layout collapse clamp, not a gesture —
 *     no escape.
 *   - Moderate negative jump (-500 < dSt < -4):
 *       · dSh < 0  → layout shift above viewport, NOT user intent; keep the
 *         stick and re-assert the snap (only when currently stuck && !escaped).
 *       · dSh >= 0 → true user wheel-up (content height unchanged) → escape.
 *   - Otherwise (dSt >= -4): no-op from this classifier.
 *  NOTE: while graceActive the handler deliberately does NOT re-assert, so
 *  reassert stays false there — behavior identical to pre-refactor.
 *  userInput (fork, sealed-tests): the user just moved the list UP by hand (wheel up,
 *  finger drag down, PageUp/ArrowUp/Home). Then any upward move is the user leaving the
 *  bottom, whatever its size or the grace window: when the page is busy (a run ending in a
 *  big chat) one flick arrives as a single ≥500 px scroll event, which the size rule alone
 *  reads as a layout collapse, and the stream-end snap then yanked the user back down. */
export function classifyScroll(args: {
	dSt: number;
	dSh: number;
	escaped: boolean;
	graceActive: boolean;
	stuck: boolean;
	userInput?: boolean;
}): { flipEscape: boolean; reassert: boolean } {
	const { dSt, dSh, escaped, graceActive, stuck, userInput } = args;
	if (userInput && dSt < -4) return { flipEscape: true, reassert: false };
	if (graceActive) return { flipEscape: false, reassert: false };
	if (dSt >= -4 || dSt <= -500) return { flipEscape: false, reassert: false };
	if (dSh < 0) {
		// Layout shift, NOT user intent: keep the stick and re-assert the snap —
		// the bottom moved up, follow it.
		return { flipEscape: false, reassert: stuck && !escaped };
	}
	// True user wheel-up: scrollHeight unchanged → escape.
	return { flipEscape: true, reassert: false };
}
