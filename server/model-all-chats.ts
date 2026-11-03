import { THINKING_LEVELS } from "./queue-profile.js";

/** All-chats is a dated choice, not a default. No transcript or model requests here. */
export interface ModelChoice {
	modelId: string;
	at: number;
	/** All chats also reaches chats whose first model was pinned (subagent template or explicit
	 * model). Presses saved before this existed lack it, so an install never moves a pinned chat. */
	reachesPinned?: boolean;
}

export function validModelChoice(value: unknown): value is ModelChoice {
	if (!value || typeof value !== "object") return false;
	const v = value as Partial<ModelChoice>;
	return (
		typeof v.modelId === "string" &&
		v.modelId.includes("/") &&
		typeof v.at === "number" &&
		Number.isFinite(v.at) &&
		v.at > 0
	);
}

/** Use the current branch, not a model chosen on an abandoned branch. */
export function latestChatModelChoice(createdAt: number, entries: readonly unknown[]): ModelChoice {
	// A bulk application is not a later manual pick. Auth may finish after a
	// second press, so its SDK write time must never veto that second press.
	const bulkEntries = new Set<string>();
	const clickedAt = new Map<string, number>();
	for (const raw of entries) {
		const e = raw as { type?: string; customType?: string; data?: { modelChangeId?: string; at?: number } } | null;
		if (
			e?.type === "custom" &&
			e.customType === "pi-web-ui/all-chats-applied" &&
			typeof e.data?.modelChangeId === "string"
		) {
			bulkEntries.add(e.data.modelChangeId);
		}
		if (
			e?.type === "custom" &&
			e.customType === "pi-web-ui/model-choice" &&
			typeof e.data?.modelChangeId === "string" &&
			typeof e.data.at === "number" &&
			Number.isFinite(e.data.at)
		)
			clickedAt.set(e.data.modelChangeId, e.data.at);
	}
	let choice: ModelChoice = { modelId: "", at: createdAt };
	for (const raw of entries) {
		const e = raw as { id?: string; type?: string; timestamp?: string; provider?: string; modelId?: string } | null;
		if (e?.type !== "model_change" || !e.provider || !e.modelId || (e.id && bulkEntries.has(e.id))) continue;
		const at = (e.id ? clickedAt.get(e.id) : undefined) ?? Date.parse(e.timestamp ?? "");
		if (Number.isFinite(at) && at >= choice.at) choice = { modelId: `${e.provider}/${e.modelId}`, at };
	}
	return choice;
}

/** A later pick wins, including unflushed blank chats (stored outside transcripts).
 * A chat born at/after the press keeps its usual new-chat default. A pinned chat keeps its
 * own model unless a press that reaches pinned chats came after it. */
export function chatModelChoice(
	press: ModelChoice | undefined,
	createdAt: number,
	latest: ModelChoice,
	manual: ModelChoice | undefined,
	pinned = false,
): ModelChoice | undefined {
	const last = manual && manual.at >= latest.at ? manual : latest;
	// SDK creation timestamps have millisecond precision; a same-millisecond
	// creation is not older than the press, even if it has a fractional action tick.
	if (press && (!pinned || press.reachesPinned === true) && createdAt < Math.floor(press.at) && last.at < press.at)
		return press;
	return !pinned && manual && manual.at >= latest.at ? manual : undefined;
}

export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

/** Thinking for all chats: every chat on `from` goes to `to`. Dated like ModelChoice, so a
 * chat older than the move follows it when it next opens. */
export interface ThinkingChoice {
	from: ThinkingLevelName;
	to: ThinkingLevelName;
	at: number;
}

function isThinkingLevel(value: unknown): value is ThinkingLevelName {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Check a requested move before anything is recorded or changed; throws a clear reason. */
export function thinkingMove(from: unknown, to: unknown): { from: ThinkingLevelName; to: ThinkingLevelName } {
	const known = `(one of: ${THINKING_LEVELS.join(", ")})`;
	for (const [name, value] of [
		["from", from],
		["to", to],
	] as const) {
		if (value === undefined || value === null || value === "")
			throw new Error(`Missing "${name}" thinking level ${known}`);
		if (!isThinkingLevel(value)) throw new Error(`Unknown "${name}" thinking level: ${String(value)} ${known}`);
	}
	const move = { from: from as ThinkingLevelName, to: to as ThinkingLevelName };
	if (move.from === move.to) throw new Error(`"from" and "to" are both ${move.from}: nothing to move`);
	return move;
}

export function validThinkingChoice(value: unknown): value is ThinkingChoice {
	if (!value || typeof value !== "object") return false;
	const v = value as Partial<ThinkingChoice>;
	return (
		isThinkingLevel(v.from) &&
		isThinkingLevel(v.to) &&
		v.from !== v.to &&
		typeof v.at === "number" &&
		Number.isFinite(v.at) &&
		v.at > 0
	);
}

/** When the chat's thinking level was last set on its current branch (-Infinity: never). */
export function latestThinkingChangeAt(entries: readonly unknown[]): number {
	let at = Number.NEGATIVE_INFINITY;
	for (const raw of entries) {
		const e = raw as { type?: string; timestamp?: string } | null;
		if (e?.type !== "thinking_level_change") continue;
		const t = Date.parse(e.timestamp ?? "");
		if (Number.isFinite(t) && t > at) at = t;
	}
	return at;
}

/** The level a chat moves to when it opens, or undefined to keep its own. Only a chat older than
 * the move, still on `from`, whose level wasn't set again after the move (a later pick wins). */
export function chatThinkingChoice(
	press: ThinkingChoice | undefined,
	createdAt: number,
	level: string | undefined,
	lastChangeAt: number,
): ThinkingLevelName | undefined {
	if (press && level === press.from && createdAt < Math.floor(press.at) && lastChangeAt < press.at) return press.to;
	return undefined;
}

/** One writer per chat. Re-check choices INSIDE the lane after async auth/key work. */
export interface ModelChangeLane {
	modelChangeTail?: Promise<unknown>;
}
export function inModelChangeLane<T>(lane: ModelChangeLane, change: () => Promise<T>): Promise<T> {
	const next = (lane.modelChangeTail ?? Promise.resolve()).catch(() => {}).then(change);
	lane.modelChangeTail = next.catch(() => {});
	return next;
}
