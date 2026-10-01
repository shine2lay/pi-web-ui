/**
 * queue-grouping: which queue chats have their task chats folded away in the left panel. Kept in the
 * browser (localStorage, like the panel's other toggles), per queue chat by its transcript path: a chat's
 * id changes when the server restarts, its transcript doesn't.
 *
 * Pure functions + unit tests: tests/unit/conv-groups.test.ts.
 */

export const LS_QUEUE_FOLDED = "pi-web-ui:lp-queue-folded";
/** At most this many folded queue chats are remembered (the oldest fold goes first). */
export const QUEUE_FOLDS_MAX = 100;

/** The key a queue chat's fold is kept under. */
export function queueFoldKey(c: { id: string; sessionPath?: string }): string {
	return c.sessionPath ?? c.id;
}

/** The folded queue chats from what localStorage holds (anything unreadable: none). */
export function parseQueueFolds(raw: string | null): Set<string> {
	if (!raw) return new Set();
	try {
		const list: unknown = JSON.parse(raw);
		return new Set(Array.isArray(list) ? list.filter((k): k is string => typeof k === "string") : []);
	} catch {
		return new Set();
	}
}

/** The folds after flipping `key`, newest first, as localStorage keeps them. */
export function toggledQueueFolds(folds: ReadonlySet<string>, key: string): string[] {
	const rest = [...folds].filter((k) => k !== key);
	return (folds.has(key) ? rest : [key, ...rest]).slice(0, QUEUE_FOLDS_MAX);
}
