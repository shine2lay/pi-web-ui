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

/** One writer per chat. Re-check choices INSIDE the lane after async auth/key work. */
export interface ModelChangeLane {
	modelChangeTail?: Promise<unknown>;
}
export function inModelChangeLane<T>(lane: ModelChangeLane, change: () => Promise<T>): Promise<T> {
	const next = (lane.modelChangeTail ?? Promise.resolve()).catch(() => {}).then(change);
	lane.modelChangeTail = next.catch(() => {});
	return next;
}
