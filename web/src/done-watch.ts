/**
 * done-any-chat: which chats' run ends make the "done" cue.
 *
 * Upstream's diffStreamingCues (streaming-cues.ts) tracks every chat in the list. Two kinds of row
 * should not sound:
 * - subagents: their parent chat is still running and sounds when it finishes; otherwise a
 *   parallel fan-out sounds once per subagent;
 * - history rows (`live === false`): they aren't running at all.
 * The open chat reaches diffStreamingCues separately (activeId), so an open subagent still gets its
 * own start / done cues.
 */
export function cueConversations<T extends { isSubagent?: boolean; live?: boolean }>(list: readonly T[]): T[] {
	return list.filter((c) => !c.isSubagent && c.live !== false);
}

/**
 * queue-main-chat: the "done" cues left once the chats whose task asks its main chat are taken out (the
 * run stopped to wait for the main chat's answer; nothing says the user is needed). The list is read when
 * the cue goes off (done-settle waits a moment first), so a question asked as the run ended counts too.
 */
export function withoutAskingChats<T extends { id: string }>(
	cues: readonly T[],
	list: readonly { id: string; queueAsking?: boolean }[] | undefined,
): T[] {
	const asking = new Set((list ?? []).filter((c) => c.queueAsking).map((c) => c.id));
	return cues.filter((c) => !asking.has(c.id));
}
