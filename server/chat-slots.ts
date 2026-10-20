/**
 * chat-slots (Ops #266, docs/chat-slots.md): which open chats take one of a project's
 * MAX_OPEN_CONVERSATIONS slots, which blank chats may close by themselves, and when.
 *
 * Pure, so the rules are unit-tested. The engines read their chats' facts into these shapes:
 * agent-service (pi) and dsh-agent-service (DSH).
 */
import { MAX_OPEN_CONVERSATIONS } from "./conversation-limits.js";

/** The one message a full project shows, wherever a chat is refused (new chat, reopen, fork, takeover, subagent). */
export const OPEN_CHATS_FULL_MESSAGE = `This project has ${MAX_OPEN_CONVERSATIONS} open chats, the most it can hold. Close one in the left list (✕) to open another.`;

/** What makes a chat blank: the test a new chat already uses to reuse one (newChatNow's isBlank). */
export interface BlankFacts {
	messageCount: number;
	terminalCount: number;
	hasQueueEntries: boolean;
	/** A Team participant the participant plugin keeps (retainedParticipant). */
	participant: boolean;
}

export function isBlankChat(f: BlankFacts): boolean {
	return f.messageCount === 0 && f.terminalCount === 0 && !f.hasQueueEntries && !f.participant;
}

/** Does this open chat take one of its project's slots? Subagent and throwaway (ephemeral) chats never
 *  did; a blank chat doesn't either, so blank chats nobody can see can't fill a project. */
export function countsTowardCap(c: { isSubagent: boolean; isEphemeral?: boolean; blank: boolean }): boolean {
	return !c.isSubagent && !c.isEphemeral && !c.blank;
}

/** Everything that decides whether a blank chat may close by itself. */
export interface CloseFacts extends BlankFacts {
	isSubagent: boolean;
	isEphemeral: boolean;
	/** Streaming, a send on its way, compacting, a wizard or a review running. */
	running: boolean;
	/** A connected window has it as its active chat. */
	openInWindow: boolean;
	/** It is a role's home chat. */
	homeChat: boolean;
	/** It is a queued task's chat (the queue opened it). */
	taskChat: boolean;
	/** An unsent draft is saved for its composer. */
	draft: boolean;
	/** A live subagent chat points at it as its parent. */
	liveChild: boolean;
	/** A send was tried in it since it became active (a first send that failed can leave it blank). */
	prompted: boolean;
	/** It is in the left list (listed): the owner can see it and close it himself. */
	listed: boolean;
	/** A pi-subagents run of it is still going, or it is still owed a wake-up. */
	backgroundWork: boolean;
}

export type CloseHold =
	| "messages"
	| "terminals"
	| "queue entries"
	| "participant"
	| "subagent"
	| "ephemeral"
	| "running"
	| "open in a window"
	| "home chat"
	| "task chat"
	| "draft"
	| "live subagent"
	| "send tried"
	| "listed"
	| "background work";

/** Why this chat must stay open, or null when it is blank and nothing needs it (it may close). */
export function blankCloseHold(f: CloseFacts): CloseHold | null {
	if (f.messageCount > 0) return "messages";
	if (f.terminalCount > 0) return "terminals";
	if (f.hasQueueEntries) return "queue entries";
	if (f.participant) return "participant";
	if (f.isSubagent) return "subagent";
	if (f.isEphemeral) return "ephemeral";
	if (f.running) return "running";
	if (f.openInWindow) return "open in a window";
	if (f.homeChat) return "home chat";
	if (f.taskChat) return "task chat";
	if (f.draft) return "draft";
	if (f.liveChild) return "live subagent";
	if (f.prompted) return "send tried";
	if (f.listed) return "listed";
	if (f.backgroundWork) return "background work";
	return null;
}

const DEFAULT_IDLE_MS = 10 * 60_000;
const DEFAULT_EVERY_MS = 60_000;

/** The sweep's timing: a blank chat closes after 10 minutes unseen, checked every minute.
 *  PI_WEB_BLANK_CHAT_IDLE_MS / PI_WEB_BLANK_CHAT_SWEEP_MS change them (the sealed test runs it fast). */
export function blankSweepTiming(env: Record<string, string | undefined> = process.env): {
	idleMs: number;
	everyMs: number;
} {
	const read = (raw: string | undefined, fallback: number): number => {
		const n = Number.parseInt(String(raw ?? ""), 10);
		return Number.isFinite(n) && n > 0 ? n : fallback;
	};
	return {
		idleMs: read(env.PI_WEB_BLANK_CHAT_IDLE_MS, DEFAULT_IDLE_MS),
		everyMs: read(env.PI_WEB_BLANK_CHAT_SWEEP_MS, DEFAULT_EVERY_MS),
	};
}

/** One open chat as the sweep sees it on a tick. */
export interface SweepChat {
	id: string;
	/** blankCloseHold returned null: blank and nothing needs it (a window showing it is a hold too). */
	closable: boolean;
}

/**
 * The blank-chat sweep's memory: when each open chat was last needed (shown in a connected window,
 * not blank, or held for any other reason). A chat closes once it has gone unneeded for `idleMs`.
 * A chat seen for the first time starts its clock then, so a new chat always gets the full time.
 */
export class BlankChatSweep {
	private readonly lastNeeded = new Map<string, number>();

	constructor(readonly idleMs: number) {}

	/** One tick over every open chat; returns the ids to close now. Forgets chats that are gone. */
	tick(now: number, chats: Iterable<SweepChat>): string[] {
		const due: string[] = [];
		const present = new Set<string>();
		for (const c of chats) {
			present.add(c.id);
			const since = this.lastNeeded.get(c.id);
			if (!c.closable || since === undefined) {
				this.lastNeeded.set(c.id, now);
				continue;
			}
			if (now - since >= this.idleMs) due.push(c.id);
		}
		for (const id of this.lastNeeded.keys()) if (!present.has(id)) this.lastNeeded.delete(id);
		return due;
	}

	/** How many chats it is keeping a clock for (tests). */
	get size(): number {
		return this.lastNeeded.size;
	}
}
