/** bigchat-stats: one whole-transcript statistics walk per unchanged shared session, not per window.
 * SDK statistics include all persisted entries and context projection. Partial streaming deltas do
 * not change them; an appended entry, branch move, reload or model-limit change does.
 * SDK entries are immutable after append; add-ons must preserve that invariant too. */
interface StatsModel {
	readonly contextWindow?: number;
}

export interface StatsSession<T> {
	readonly sessionManager?: { getLeafId(): string | null };
	readonly model?: StatsModel;
	readonly routedModel?: { readonly model: StatsModel };
	getSessionStats(): T;
}

interface CachedStats {
	entries: unknown[] | undefined;
	length: number;
	leaf: string | null;
	hasLimits: boolean;
	contextWindow: number | undefined;
	at: number;
	value: unknown;
}

const cache = new WeakMap<object, CachedStats>();
const FALLBACK_MS = 250;

/** Preserve explicit refreshes after tool/preset changes, across every window sharing the manager. */
export function invalidateSessionStats(session: StatsSession<unknown>): void {
	cache.delete(session);
	if (session.sessionManager) cache.delete(session.sessionManager);
}

/** Unknown manager layouts retain the old short memo, timed from completion so a slow read can
 * still hit. The supported SDK's fileEntries array gives an O(1) revision without getEntries(). */
export function sessionStatsOf<T>(session: StatsSession<T>): T {
	const sm = session.sessionManager;
	const own = (sm as { fileEntries?: unknown } | undefined)?.fileEntries;
	const entries = sm && Array.isArray(own) && typeof sm.getLeafId === "function" ? own : undefined;
	const owner = entries ? sm! : session;
	const leaf = entries ? sm!.getLeafId() : null;
	const length = entries?.length ?? -1;
	// SDK _limitsModel() reads only presence and contextWindow. Provider getters may
	// return fresh but equivalent model objects, so object identity is not a revision.
	const limits = session.routedModel?.model ?? session.model;
	const hasLimits = !!limits;
	const contextWindow = limits?.contextWindow;
	const hit = cache.get(owner);
	if (
		hit &&
		hit.entries === entries &&
		hit.length === length &&
		hit.leaf === leaf &&
		hit.hasLimits === hasLimits &&
		hit.contextWindow === contextWindow &&
		(entries !== undefined || Date.now() - hit.at < FALLBACK_MS)
	) {
		return hit.value as T;
	}
	const value = session.getSessionStats();
	cache.set(owner, { entries, length, leaf, hasLimits, contextWindow, at: Date.now(), value });
	return value;
}
