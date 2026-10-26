import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationId, Cursor, EntryId, Harness, Storage } from "@earendil-works/pi-durable";
import { IdleSessionCache } from "./sqlite-storage.js";
import { DurableSessionState } from "./session-state.js";

export interface WorkspaceSession {
	id: string;
	name?: string;
}
export function durableConversationId(id: string): ConversationId {
	const value = Number(id);
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid durable conversation id: ${id}`);
	return value as ConversationId;
}

/** Durable records live in SQLite; only the SDK compatibility projection expires after ten idle minutes. */
export class WorkspaceSessions {
	private readonly states: IdleSessionCache<DurableSessionState>;
	constructor(
		readonly harness: Harness,
		readonly storage: Storage,
		readonly cwd: string,
		now?: () => number,
		readonly hostId: (id: string) => string = (id) => id,
	) {
		this.states = new IdleSessionCache(now);
	}
	async conversation(id: string): Promise<Conversation> {
		const conversation = await this.harness.conversation(durableConversationId(id), BACKGROUND_CONTEXT);
		if (!conversation) throw new Error(`Durable conversation not found: ${id}`);
		return conversation;
	}
	async state(id: string): Promise<DurableSessionState> {
		let state = this.states.get(id);
		if (!state) {
			state = new DurableSessionState(await this.conversation(id), this.storage, this.cwd, this.hostId(id));
			await state.sync();
			this.states.set(id, state);
		}
		return state;
	}
	pin(id: string): () => void {
		return this.states.pin(id);
	}
	evictIdle(protectedIds: ReadonlySet<string> = new Set()): string[] {
		return this.states.evict(protectedIds);
	}
	get cachedCount(): number {
		return this.states.size;
	}
	clear(): void {
		this.states.clear();
	}
	async list(): Promise<WorkspaceSession[]> {
		const result: WorkspaceSession[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await this.storage.scanConversations({ order: "descending" }, 256, cursor, BACKGROUND_CONTEXT);
			for (const conversation of page.items) {
				if (conversation.owner || Number(conversation.id) === 0) continue;
				const state = await this.state(String(conversation.id));
				await state.sync();
				const name = state.sessionManager.getSessionName();
				result.push({ id: String(conversation.id), ...(typeof name === "string" ? { name } : {}) });
			}
			cursor = page.next;
		} while (cursor);
		return result;
	}
	async fork(id: string, at: EntryId): Promise<string> {
		const conversation = await this.conversation(id);
		const fork = await conversation.fork(at, { ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
		return String(fork.id);
	}
}
