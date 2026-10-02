/**
 * new-chat-default: which model a new chat starts on.
 *
 * Upstream, a new chat takes the model and thinking level of the chat that was open, and a fresh chat
 * otherwise takes the model its folder remembers (any window's pick for that folder), and only then the
 * global default model. So the global default hardly ever applied: a new chat started on whatever the
 * last chat used, and queued tasks started on old per-folder picks.
 *
 * Here the global default model, when one is set (Settings, the model picker's ☆), is what every new chat
 * starts on: New chat, a role's chat, a queued task's chat, a fresh chat moved to another folder. It runs
 * at that model's own thinking level (pi's per-model level, else pi's default level). Without a global
 * default, nothing changes: the open chat's model carries over, then the folder's memory.
 * A model picked in a chat stays with that chat.
 */

/** What a new chat takes over from the chat that was open: nothing when a global default is set. */
export function carryOverToNewChat<M, T>(
	globalDefault: string | undefined,
	open: { model?: M | null; thinking?: T | null } | undefined,
): { model: M | null; thinking: T | null } {
	if (globalDefault) return { model: null, thinking: null };
	return { model: open?.model ?? null, thinking: open?.thinking ?? null };
}

/** The model ("provider/id") a fresh chat starts on: the global default when set, else its folder's memory. */
export function freshChatModel(globalDefault: string | undefined, folderModel: string | undefined): string | undefined {
	return globalDefault || folderModel || undefined;
}
