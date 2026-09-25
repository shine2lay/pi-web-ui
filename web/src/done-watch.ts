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
