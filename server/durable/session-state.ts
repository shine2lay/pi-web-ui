import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type { JsonObject } from "@earendil-works/pi-durable";
import { defineDoc } from "@earendil-works/pi-durable";
import type { Conversation, ConversationId, Cursor, EntryId, EntryRecord, Storage } from "@earendil-works/pi-durable";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { FileEntry, SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";

export const CUSTOM_ENTRY_KIND = "app.pi.custom";
export const SESSION_ENTRY_KIND = "app.pi.session";
/** Same version/scope/fork semantics as W1-D; reading never creates or rewrites it. */
export const MigrationDoc = defineDoc<JsonObject>({
	kind: "pi-web-ui.migration",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({}),
	checkpointWhen: () => true,
});

export function jsonValue(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

/** Append-only archival reads. Never use raw entry.model to hydrate active model context. */
export async function readContextFrom(
	storage: Storage,
	conversationId: ConversationId,
	after?: EntryId,
): Promise<readonly EntryRecord[]> {
	const entries: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanEntries(
			{
				conversationId,
				order: "ascending",
				...(after === undefined ? {} : { minEntryId: (Number(after) + 1) as EntryId }),
			},
			512,
			cursor,
			BACKGROUND_CONTEXT,
		);
		entries.push(...page.items);
		cursor = page.next;
	} while (cursor);
	return entries;
}

/** Stable SDK facade, rebuilt from durable's edited, head-bound context after invalidation. */
export class DurableSessionState {
	readonly sessionManager: SessionManager;
	private manager: SessionManager;
	private tail?: EntryId;
	private readonly metadata = new Map<EntryId, EntryRecord>();
	private viewKey = "";
	private writes: Promise<void> = Promise.resolve();
	private writeError: unknown;
	private syncing: Promise<void> | undefined;

	constructor(
		readonly conversation: Conversation,
		readonly storage: Storage,
		private cwd: string,
		private id: string,
	) {
		this.manager = SessionManager.inMemory(cwd, { id });
		// Runners retain this object. Forward public calls to the current projection, without SDK-private mutation.
		this.sessionManager = new Proxy(this.manager, {
			get: (_target, key) => {
				const value = Reflect.get(this.manager, key);
				return typeof value === "function" ? value.bind(this.manager) : value;
			},
		});
	}
	async sync(): Promise<void> {
		if (this.syncing) return this.syncing;
		this.syncing = this.syncNow().finally(() => {
			this.syncing = undefined;
		});
		return this.syncing;
	}
	private async syncNow(): Promise<void> {
		await this.flush();
		const appended = await readContextFrom(this.storage, this.conversation.id, this.tail);
		for (const entry of appended) {
			if ([CUSTOM_ENTRY_KIND, SESSION_ENTRY_KIND, "legacy.custom"].includes(entry.kind))
				this.metadata.set(entry.id, entry);
			this.tail = entry.id;
		}
		// Conversation.context owns the incremental range cache and invalidates it for edits and head changes.
		const view = await this.conversation.context(BACKGROUND_CONTEXT);
		const document = await this.storage.findDocument(
			{ kind: "pi-web-ui.migration", scope: { kind: "conversation", conversationId: this.conversation.id } },
			"current",
			BACKGROUND_CONTEXT,
		);
		const migration = document
			? (await this.storage.document(document.id, "current", BACKGROUND_CONTEXT))?.value
			: undefined;
		const key = `${this.tail ?? 0}/${view.head?.id ?? 0}/${view.entries.at(-1)?.id ?? 0}/${JSON.stringify(migration ?? null)}`;
		if (this.viewKey === key) return;
		const sourceHeader = migration?.header as Record<string, JsonValue> | undefined;
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id: typeof sourceHeader?.id === "string" ? sourceHeader.id : this.id,
			cwd: typeof sourceHeader?.cwd === "string" ? sourceHeader.cwd : this.cwd,
			timestamp: typeof sourceHeader?.timestamp === "string" ? sourceHeader.timestamp : new Date().toISOString(),
		};
		const entries: FileEntry[] = [header];
		let parentId: string | null = null;
		const add = (entry: Omit<SessionEntry, "parentId">) => {
			entries.push({ ...entry, parentId } as SessionEntry);
			parentId = entry.id;
		};
		const selected = new Set(
			Array.isArray(migration?.branch) ? migration.branch.filter((id): id is string => typeof id === "string") : [],
		);
		const mapping = migration?.entryIds as Record<string, JsonValue> | undefined;
		const activeIds = new Set(view.entries.map((entry) => entry.id));
		if (typeof migration?.title === "string")
			add({
				type: "session_info",
				id: `durable-title-${migration.headId}`,
				timestamp: header.timestamp,
				name: migration.title,
			} as SessionEntry);
		for (const entry of this.metadata.values()) {
			const data = entry.data as Record<string, JsonValue> | undefined;
			if (!data) continue;
			const stamp = typeof data.timestamp === "string" ? data.timestamp : header.timestamp;
			if (entry.kind === "legacy.custom") {
				if (
					typeof data.id !== "string" ||
					!selected.has(data.id) ||
					mapping?.[data.id] !== entry.id ||
					typeof data.customType !== "string"
				)
					continue;
				add({
					type: "custom",
					id: data.id,
					timestamp: stamp,
					customType: data.customType,
					data: data.data,
				} as SessionEntry);
			} else {
				// A later migration snapshot supersedes old native materialization; do not resurrect stale state.
				if (!activeIds.has(entry.id) || (typeof migration?.headId === "number" && entry.id <= migration.headId))
					continue;
				const id = typeof data.localId === "string" ? data.localId : `durable-meta-${entry.id}`;
				if (entry.kind === CUSTOM_ENTRY_KIND && typeof data.customType === "string")
					add({ type: "custom", id, timestamp: stamp, customType: data.customType, data: data.data } as SessionEntry);
				else if (entry.kind === SESSION_ENTRY_KIND && typeof data.name === "string")
					add({ type: "session_info", id, timestamp: stamp, name: data.name } as SessionEntry);
			}
		}
		const ids = new Map<object, string>();
		view.contributions.forEach((messages, n) =>
			messages.forEach((message, m) => ids.set(message, `durable-${view.entries[n]!.id}-${m}`)),
		);
		view.messages.forEach((message, n) =>
			add({
				type: "message",
				id: ids.get(message) ?? `durable-context-${view.entries.at(-1)?.id ?? 0}-${n}`,
				timestamp: header.timestamp,
				message: message as Message,
			} as SessionEntry),
		);
		this.manager = SessionManager.inMemory(header.cwd, { id: header.id }, entries);
		this.viewKey = key;
	}
	appendEntry(customType: string, data: unknown): void {
		const localId = this.manager.appendCustomEntry(customType, data);
		this.enqueue(CUSTOM_ENTRY_KIND, { customType, data: jsonValue(data), localId });
	}
	setName(name: string): void {
		const localId = this.manager.appendSessionInfo(name);
		this.enqueue(SESSION_ENTRY_KIND, { name, localId });
	}
	private enqueue(kind: string, data: JsonValue): void {
		this.writes = this.writes.then(async () => {
			if (this.writeError) return;
			try {
				await this.conversation.commit(async (tx) => {
					await tx.appendEntry(this.conversation.id, { kind, data });
				}, BACKGROUND_CONTEXT);
			} catch (error) {
				this.writeError = error;
			}
		});
	}
	async flush(): Promise<void> {
		await this.writes;
		if (this.writeError) throw this.writeError;
	}
}
