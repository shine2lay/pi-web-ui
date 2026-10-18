/**
 * acp-fold: billion-context-pi (our fork) folds a big, quiet chat: it answers a compaction of its own
 * (details.acp, no model call) so pi's working list keeps only the newest messages. Everything older
 * stays in the chat file, and the add-on still works from the whole chat, so what reaches the model is
 * unchanged. This file reads those folds for the window: the fold's card is not news (no toast, no jump),
 * and "Show older messages" above it shows what the fold took out of the list.
 */

import { buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "./serialize.js";

/** How long a compaction runs before the window shows its progress bar and the chat file gets its
 *  pending marker. billion-context-pi's folds are over well before. */
export const FOLD_QUIET_MS = 1500;

/** Details billion-context-pi put on a compaction it made itself. */
export function isAcpDetails(details: unknown): boolean {
	const acp = details && typeof details === "object" ? (details as { acp?: unknown }).acp : undefined;
	return !!acp && typeof acp === "object";
}

export type AcpFoldEntry = SessionEntry & { type: "compaction"; firstKeptEntryId: string };

export function isAcpFoldEntry(e: SessionEntry): e is AcpFoldEntry {
	return e.type === "compaction" && isAcpDetails((e as { details?: unknown }).details);
}

/** compaction_end's result is a fold's. */
export function isAcpFoldResult(result: unknown): boolean {
	return !!result && typeof result === "object" && isAcpDetails((result as { details?: unknown }).details);
}

/**
 * The messages pi's working list held before the newest fold took them out: the branch read as if it
 * had never been folded (folds left out, their children joined to their parents), up to the fold's
 * first kept entry. null when the branch has no fold.
 */
export function foldedMessagesOf(branch: readonly SessionEntry[]): { foldId: string; messages: AgentMessage[] } | null {
	let fold: AcpFoldEntry | undefined;
	for (let i = branch.length - 1; i >= 0 && !fold; i--) {
		const e = branch[i];
		if (isAcpFoldEntry(e)) fold = e;
	}
	if (!fold) return null;
	const firstKept = fold.firstKeptEntryId;
	const parentOf = new Map<string, string | null>();
	for (const e of branch) if (isAcpFoldEntry(e)) parentOf.set(e.id, e.parentId);
	const unfolded: SessionEntry[] = [];
	for (const e of branch) {
		if (parentOf.has(e.id)) continue;
		let p = e.parentId;
		while (p !== null && parentOf.has(p)) p = parentOf.get(p) ?? null;
		unfolded.push(p === e.parentId ? e : { ...e, parentId: p });
	}
	const projection = buildSessionProjection(unfolded, unfolded[unfolded.length - 1]?.id);
	const kept = projection.entries.findIndex((p) => p.sourceEntry.id === firstKept);
	const messages: AgentMessage[] = [];
	for (let i = 0; i < kept; i++) messages.push(...projection.entries[i].messages);
	return { foldId: fold.id, messages };
}
