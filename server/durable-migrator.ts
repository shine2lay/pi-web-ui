/**
 * Offline, append-only JSONL -> pi-durable migration. Never opens a source for writing.
 *
 * H-DURABLE-MIGRATOR-W1D-1: a head over original-order history still scans covered
 * entries (and the first user message pins it to the beginning). Keep immutable raw
 * entries for lookup, then materialize the small active window after them. Large
 * historical omit edits stay BELOW head; only summary replacements are read on a
 * context load. The source UUID and both ID maps survive in documents/manifest.
 *
 * Use only while the target workspace is offline. The directory lock excludes
 * other migrators, not a running Harness. Refuse to overwrite a resumed conversation.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { backup, DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import {
	buildSessionProjection,
	convertToLlm,
	type SessionEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import type {
	ContextEdit,
	ConversationId,
	Cursor,
	DocumentId,
	EntryId,
	EntryRecord,
	JsonObject,
	Storage,
	StorageWrite,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { isAcpFoldEntry } from "./acp-fold.js";

type Message = NonNullable<EntryRecord["model"]>[number];
type Block = JsonObject & { blockId: string; summary: string; active: boolean };
type ContextItem = { key: string; sourceId?: string; blockId?: string; message: Message };
const CTX = BACKGROUND_CONTEXT;
const META_KIND = "pi-web-ui.migration";
const MANIFEST = "migration-manifest.json";
const FORMAT = 1;
const EXCLUDED_CUSTOM = new Set(["acp-status", "acp-export", "acp-rule"]);

export interface MigrationOptions {
	sourceDir: string;
	targetDir: string;
	/** Original parentSession reference -> listed offline file; never follows a live parent path. */
	parentSessionMap?: Readonly<Record<string, string>>;
	dryRun?: boolean;
	/** Verification only: no migration, manifest write or target database open for writing. */
	verify?: boolean;
}
export interface MigrationMapping {
	sourceFile: string;
	sessionId: string;
	cwd: string;
	title: string | null;
	database: string;
	conversationId: number;
	headId: number;
	entryCount: number;
	activeMessages: number;
	blocks: number;
	activeBlocks: number;
	sourceSha256: string;
	stateSha256: string;
}
export interface MigrationReport {
	mode: "migrate" | "dry-run" | "verify";
	sessions: MigrationMapping[];
	migrated: number;
	skipped: number;
	mismatches: number;
}
interface Snapshot {
	file: string;
	header: SessionHeader;
	entries: SessionEntry[];
	branch: SessionEntry[];
	state: JsonObject;
	sourceSha256: string;
	stateSha256: string;
	title: string | null;
	context: ContextItem[];
}
interface Metadata extends JsonObject {
	format: number;
	sessionId: string;
	sourceFile: string;
	sourceSha256: string;
	stateSha256: string;
	entryIds: Record<string, number>;
	entryHashes: Record<string, string>;
	entryOrder: string[];
	contextEntryIds: Record<string, number>;
	contextOrder: number[];
	headId: number;
	mapping: MigrationMapping & JsonObject;
}

function object(value: unknown): JsonObject | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}
function json(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}
function digest(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((item) => canonical(item ?? null)).join(",")}]`;
	const obj = object(value);
	return obj
		? `{${Object.keys(obj)
				.filter((key) => obj[key] !== undefined)
				.sort()
				.map((key) => `${JSON.stringify(key)}:${canonical(obj[key])}`)
				.join(",")}}`
		: (JSON.stringify(value) ?? "null");
}
function same(left: unknown, right: unknown): boolean {
	return canonical(left) === canonical(right);
}
function baseId(id: string): string {
	return id.split("#", 1)[0]!;
}
function text(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content)
		? content
				.filter((part) => part?.type === "text")
				.map((part) => part.text ?? "")
				.join("\n")
		: "";
}
function time(timestamp: string): number {
	const value = Date.parse(timestamp);
	return Number.isFinite(value) ? value : 0;
}
function blocks(state: JsonObject): Block[] {
	if (state.blocks === undefined) return [];
	if (!Array.isArray(state.blocks)) throw new Error("Invalid ACP state: blocks must be an array");
	const seen = new Set<string>();
	return state.blocks.map((value) => {
		const block = object(value);
		if (
			!block ||
			typeof block.blockId !== "string" ||
			typeof block.summary !== "string" ||
			typeof block.active !== "boolean"
		) {
			throw new Error("Invalid ACP block: blockId, summary and active are required");
		}
		if (seen.has(block.blockId)) throw new Error(`Duplicate ACP block ID: ${block.blockId}`);
		seen.add(block.blockId);
		return block as Block;
	});
}

/** Same workspace naming as the durable driver. targetDir is the durable directory itself. */
export function durableDatabaseName(cwd: string): string {
	return `session-${digest(resolve(cwd)).slice(0, 12)}.sqlite`;
}

/** Observation messages are user-role, like native compaction, never new system instructions. */
export function renderMigrationSummary(block: Block, timestamp = 0): Message {
	const topic = typeof block.topic === "string" && block.topic ? ` — ${block.topic}` : "";
	return {
		role: "user",
		content: [{ type: "text", text: `[Observation from compress ${block.blockId}${topic}]\n${block.summary}` }],
		timestamp,
	};
}

function messageOf(entry: SessionEntry): Message | undefined {
	if (entry.type === "custom_message") {
		if (EXCLUDED_CUSTOM.has(entry.customType)) return undefined;
		const content =
			typeof entry.content === "string" ? [{ type: "text" as const, text: entry.content }] : (entry.content ?? []);
		return { role: "user", content, timestamp: time(entry.timestamp) };
	}
	if (entry.type !== "message") return undefined;
	const msg = entry.message;
	if (!object(msg) || typeof msg.role !== "string") throw new Error(`Invalid archived message: ${entry.id}`);
	if (msg.role === "user" || msg.role === "assistant" || msg.role === "toolResult" || msg.role === "system") {
		return { ...msg, content: msg.content ?? (msg.role === "system" ? "" : []) } as Message;
	}
	return convertToLlm([msg])[0];
}
function messageKind(message: Message): string {
	return `pi.${message.role === "toolResult" ? "tool-result" : message.role}`;
}

function rawIds(block: Block, state: JsonObject, entries: SessionEntry[]): string[] {
	const ids = block.effectiveMessageIds ?? block.directMessageIds;
	if (Array.isArray(ids)) {
		if (!ids.every((id) => typeof id === "string")) throw new Error(`Invalid ACP message IDs for ${block.blockId}`);
		return ids.map((id) => baseId(id as string));
	}
	// Older acp-state custom records used range boundaries/refMap rather than effectiveMessageIds.
	const byRef = object(object(state.messageRefs)?.byRef) ?? object(state.refMap) ?? {};
	const boundary = (value: JsonValue | undefined): string | undefined => {
		if (typeof value === "number") return entries[value - 1]?.id;
		if (typeof value !== "string") return undefined;
		const raw = byRef[value];
		return baseId(typeof raw === "string" ? raw : value);
	};
	const start = boundary(block.startEntryId ?? block.startRef);
	const end = boundary(block.endEntryId ?? block.endRef);
	const from = entries.findIndex((entry) => entry.id === start);
	const to = entries.findIndex((entry) => entry.id === end);
	if (from < 0 || to < from) throw new Error(`Unresolvable ACP range for ${block.blockId}`);
	return entries.slice(from, to + 1).map((entry) => entry.id);
}

/** Remove ACP's transport-only compactions and reconnect their children, not native compactions.
 * Keep the original branch/archive intact, including every legacy ID and parent reference. */
function unfoldTransportFolds(branch: SessionEntry[]): SessionEntry[] {
	const parents = new Map(branch.filter(isAcpFoldEntry).map((entry) => [entry.id, entry.parentId]));
	return branch
		.filter((entry) => !parents.has(entry.id))
		.map((entry) => {
			let parentId = entry.parentId;
			while (parentId !== null && parents.has(parentId)) parentId = parents.get(parentId)!;
			return parentId === entry.parentId ? entry : { ...entry, parentId };
		});
}

/** Structural ACP view; request-time tags, nudges and provider transforms are not stored. */
function projectContext(branch: SessionEntry[], state: JsonObject): ContextItem[] {
	const unfolded = unfoldTransportFolds(branch);
	const projection = buildSessionProjection(unfolded, unfolded.at(-1)?.id);
	const items: ContextItem[] = [];
	for (const { sourceEntry: entry, messages } of projection.entries) {
		if (entry.type === "custom_message" && EXCLUDED_CUSTOM.has(entry.customType)) continue;
		const converted = convertToLlm(messages);
		for (let at = 0; at < converted.length; at++) {
			const message = converted[at]!;
			if (
				message.role === "assistant" &&
				!message.content.some((part) => part.type === "toolCall") &&
				!text(message.content).trim()
			)
				continue;
			items.push({ key: converted.length === 1 ? entry.id : `${entry.id}:${at}`, sourceId: entry.id, message });
		}
	}
	const allBlocks = blocks(state);
	const consumed = new Set<string>();
	for (const block of allBlocks) {
		const ids = block.directBlockIds;
		if (ids === undefined) continue;
		if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
			throw new Error(`Invalid ACP consumed block IDs for ${block.blockId}`);
		for (const id of ids) consumed.add(id as string);
	}
	const index = new Map(items.map((item, at) => [item.sourceId!, at]));
	// Legacy syncBlocks recomputes presence after branch selection/native compaction.
	// Synchronize only this projection; persist the original blocks/flags/refs verbatim.
	const active = allBlocks.flatMap((block) => {
		if (consumed.has(block.blockId) || block.expanded) return [];
		// Range-only embedded records predate syncBlocks; keep their explicit inactive
		// flag without trying to resolve archived boundaries absent from this branch.
		if (!block.active && block.effectiveMessageIds === undefined && block.directMessageIds === undefined) return [];
		const ids = rawIds(block, state, branch);
		return ids.some((id) => index.has(id)) || index.has(`acp_summary_${block.blockId}`) ? [{ block, ids }] : [];
	});
	if (active.length === 0) return settleMessages(items);
	const covered = new Set<string>();
	const anchors = active.map(({ block, ids }) => {
		let at = items.length;
		for (const id of ids) {
			covered.add(id);
			at = Math.min(at, index.get(id) ?? items.length);
		}
		return { block, at: at === items.length ? 0 : at };
	});
	// One pairing index: never insert a summary inside an assistant/tool-result run.
	const resultIndex = new Map<string, number>();
	items.forEach(({ message }, at) => {
		if (message.role === "toolResult" && !resultIndex.has(message.toolCallId)) resultIndex.set(message.toolCallId, at);
	});
	const runStart: number[] = [];
	const prefixEnd = [0];
	items.forEach(({ message }, at) => {
		runStart[at] = message.role === "assistant" && items[at - 1]?.message.role === "assistant" ? runStart[at - 1]! : at;
		let end = prefixEnd[at]!;
		if (message.role === "assistant")
			for (const part of message.content)
				if (part.type === "toolCall") end = Math.max(end, (resultIndex.get(part.id) ?? -1) + 1);
		prefixEnd.push(end);
	});
	for (const anchor of anchors) {
		anchor.at = runStart[anchor.at] ?? anchor.at;
		while (prefixEnd[anchor.at]! > anchor.at) anchor.at = prefixEnd[anchor.at]!;
	}
	anchors.sort((a, b) => a.at - b.at);
	const firstUser = items.findIndex((item) => item.message.role === "user");
	const out: ContextItem[] = [];
	let pending = 0;
	for (let at = 0; at <= items.length; at++) {
		while (pending < anchors.length && anchors[pending]!.at === at) {
			const { block } = anchors[pending++]!;
			out.push({ key: block.blockId, blockId: block.blockId, message: renderMigrationSummary(block) });
		}
		const item = items[at];
		if (item && (at === firstUser || !covered.has(item.sourceId!))) out.push(item);
	}
	// ACP removes orphan calls/results after coverage, including individual parallel calls.
	const results = new Set(out.flatMap(({ message }) => (message.role === "toolResult" ? [message.toolCallId] : [])));
	const filtered = out.flatMap((item) => {
		const msg = item.message;
		if (msg.role !== "assistant") return [item];
		const calls = msg.content.filter((part) => part.type === "toolCall");
		if (!calls.length) return [item];
		const surviving = new Set(
			calls.filter((call) => call.name === "compress" || results.has(call.id)).map((call) => call.id),
		);
		return surviving.size
			? [
					{
						...item,
						message: {
							...msg,
							content: msg.content.filter((part) => part.type !== "toolCall" || surviving.has(part.id)),
						},
					},
				]
			: [];
	});
	return settleMessages(filtered);
}

/** pi-durable drops failed assistant turns and orders results beside their calls. */
function settleMessages(items: ContextItem[]): ContextItem[] {
	const kept = items.filter(
		({ message }) => message.role !== "assistant" || !["aborted", "error", "deferred"].includes(message.stopReason),
	);
	const out: ContextItem[] = [];
	for (let at = 0; at < kept.length; at++) {
		const item = kept[at]!;
		if (item.message.role === "toolResult") continue;
		out.push(item);
		if (item.message.role !== "assistant") continue;
		for (const call of item.message.content) {
			if (call.type !== "toolCall") continue;
			let result: ContextItem | undefined;
			for (let next = at + 1; next < kept.length && kept[next]!.message.role !== "assistant"; next++) {
				const candidate = kept[next]!;
				if (candidate.message.role === "toolResult" && candidate.message.toolCallId === call.id) {
					result = candidate;
					break;
				}
			}
			out.push(
				result ?? {
					key: `${item.key}:missing:${call.id}`,
					message: {
						role: "toolResult",
						toolCallId: call.id,
						toolName: call.name,
						content: [{ type: "text", text: "Tool result unavailable: history ends before this call completed." }],
						isError: true,
						details: { reason: "missing_result" },
						timestamp: item.message.timestamp,
					},
				},
			);
		}
	}
	const system = out.findIndex((item) => item.message.role === "system");
	if (system > 0 && out.slice(0, system).every((item) => item.message.role === "user"))
		out.unshift(out.splice(system, 1)[0]!);
	return out;
}

interface OfflineSources {
	headers: Map<string, SessionHeader>;
	parents: Readonly<Record<string, string>>;
	directory: string;
}

function sessionHeader(value: JsonObject | undefined, file: string): SessionHeader {
	if (
		value?.type !== "session" ||
		typeof value.id !== "string" ||
		!value.id ||
		typeof value.cwd !== "string" ||
		!value.cwd ||
		value.version !== 3
	)
		throw new Error(`Expected version 3 session header: ${file}`);
	return value as unknown as SessionHeader;
}

/** Header-only index: no source's full history has to remain resident during global preflight. */
async function readSourceHeader(file: string): Promise<SessionHeader> {
	const stream = createReadStream(file);
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			if (line.trim()) return sessionHeader(object(JSON.parse(line)), file);
		}
		throw new Error(`Empty session file: ${file}`);
	} finally {
		lines.close();
		stream.destroy();
	}
}

async function readSidecar(file: string): Promise<JsonObject | undefined> {
	const stateFile = `${file}.acp.json`;
	try {
		const before = await lstat(stateFile, { bigint: true });
		if (!before.isFile() || before.isSymbolicLink()) throw new Error(`ACP state must be a regular file: ${stateFile}`);
		const parsed = object(JSON.parse(await readFile(stateFile, "utf8")));
		if (!parsed) throw new Error(`Invalid ACP state: ${stateFile}`);
		const after = await lstat(stateFile, { bigint: true });
		if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ino !== after.ino)
			throw new Error(`ACP state changed during read: ${stateFile}`);
		blocks(parsed);
		if (parsed.migration !== undefined)
			throw new Error(`ACP state already contains reserved migration metadata: ${file}`);
		return parsed;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return undefined;
	}
}

/** Legacy forks inherit the first nonempty ancestor sidecar, not a newly issued ref space.
 * Resolve only explicitly enumerated offline files. A missing ancestor is not proof of empty state. */
async function inheritedState(file: string, offline: OfflineSources): Promise<JsonObject | undefined> {
	const visited = new Set([file]);
	let current = file;
	while (true) {
		const reference = offline.headers.get(current)?.parentSession;
		if (reference === undefined) return undefined;
		if (typeof reference !== "string" || !reference) throw new Error(`Invalid offline parent reference: ${current}`);
		const mapped = Object.hasOwn(offline.parents, reference) ? offline.parents[reference] : undefined;
		if (mapped !== undefined && (typeof mapped !== "string" || !mapped))
			throw new Error(`Invalid offline parent mapping: ${reference}`);
		const parent = mapped === undefined ? resolve(dirname(current), reference) : resolve(offline.directory, mapped);
		if (!offline.headers.has(parent)) throw new Error(`Missing offline parent session: ${reference}`);
		if (visited.has(parent)) throw new Error(`Offline parent session cycle: ${reference}`);
		visited.add(parent);
		const state = await readSidecar(parent);
		if (state && blocks(state).length > 0) return state;
		if (offline.headers.get(parent)?.parentSession === undefined) {
			if (!state || !Array.isArray(state.blocks)) throw new Error(`Missing offline parent ACP state: ${parent}`);
			return undefined; // An explicit empty terminal sidecar proves this lineage is uncompressed.
		}
		current = parent;
	}
}

async function loadSnapshot(file: string, offline: OfflineSources): Promise<Snapshot> {
	const before = await lstat(file, { bigint: true });
	if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Source must be a regular file: ${file}`);
	const hash = createHash("sha256");
	const stream = createReadStream(file);
	stream.on("data", (chunk) => hash.update(chunk));
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	let header: SessionHeader | undefined;
	const entries: SessionEntry[] = [];
	const byId = new Map<string, SessionEntry>();
	let lineNumber = 0;
	try {
		for await (const line of lines) {
			lineNumber++;
			if (!line.trim()) continue;
			let value: JsonObject | undefined;
			try {
				value = object(JSON.parse(line));
			} catch {
				throw new Error(`Invalid JSONL at ${file}:${lineNumber}`);
			}
			if (!header) {
				header = sessionHeader(value, file);
				if (!same(header, offline.headers.get(file)))
					throw new Error(`Source header changed during preflight: ${file}`);
				continue;
			}
			if (
				!value ||
				typeof value.id !== "string" ||
				typeof value.type !== "string" ||
				!(value.parentId === null || typeof value.parentId === "string")
			)
				throw new Error(`Invalid session entry at ${file}:${lineNumber}`);
			if (byId.has(value.id)) throw new Error(`Duplicate entry ID at ${file}:${lineNumber}`);
			const entry = value as unknown as SessionEntry;
			byId.set(entry.id, entry);
			entries.push(entry);
		}
	} finally {
		lines.close();
		stream.destroy();
	}
	const after = await lstat(file, { bigint: true });
	if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs)
		throw new Error(`Source changed during read; copy it while idle and retry: ${file}`);
	if (!header) throw new Error(`Empty session file: ${file}`);
	// Legacy UI custom entries may precede their parent on disk. The SDK builds
	// its whole index before getBranch(); validate existence, not physical order.
	for (const entry of entries) {
		if (entry.parentId !== null && !byId.has(entry.parentId))
			throw new Error(`Missing parent at ${file} (entry ${entry.id})`);
	}
	// Validate the archival conversion too, including entries outside the active branch.
	// Otherwise a later malformed archive can throw only after an earlier session commits.
	for (const entry of entries) messageOf(entry);
	const branch: SessionEntry[] = [];
	const visited = new Set<string>();
	let leaf = entries.at(-1);
	while (leaf) {
		if (visited.has(leaf.id)) throw new Error(`Parent cycle at ${file} (entry ${leaf.id})`);
		visited.add(leaf.id);
		branch.push(leaf);
		leaf = leaf.parentId === null ? undefined : byId.get(leaf.parentId);
	}
	branch.reverse();
	let state: JsonObject = {};
	const embedded = branch.findLast((entry) => entry.type === "custom" && entry.customType === "acp-state");
	if (embedded?.type === "custom") state = object(embedded.data) ?? {};
	state = (await readSidecar(file)) ?? state;
	const ownBlocks = blocks(state); // validate even if no messages
	if (state.migration !== undefined) throw new Error(`ACP state already contains reserved migration metadata: ${file}`);
	if (ownBlocks.length === 0) state = (await inheritedState(file, offline)) ?? state;
	// SessionManager.getSessionName reads the whole physical file, even off the selected branch.
	const info = entries.findLast((entry) => entry.type === "session_info");
	return {
		file,
		header,
		entries,
		branch,
		state,
		sourceSha256: hash.digest("hex"),
		stateSha256: digest(canonical(state)),
		title: info?.type === "session_info" ? info.name?.trim() || null : null,
		context: projectContext(branch, state),
	};
}

async function listSources(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const item of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, item.name);
		if (item.isDirectory()) out.push(...(await listSources(path)));
		else if (item.name.endsWith(".jsonl")) {
			if (!item.isFile()) throw new Error(`Source must not be a symlink: ${path}`);
			out.push(path);
		}
	}
	return out.sort();
}

async function metadata(
	storage: Storage,
	sessionId: string,
): Promise<{ id: DocumentId; value: Metadata; conversationId: ConversationId } | undefined> {
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanConversations({}, 256, cursor, CTX);
		for (const conversation of page.items) {
			const record = await storage.findDocument(
				{ kind: META_KIND, scope: { kind: "conversation", conversationId: conversation.id } },
				"current",
				CTX,
			);
			if (!record) continue;
			const doc = await storage.document(record.id, "current", CTX);
			if (doc?.value.sessionId === sessionId)
				return { id: record.id, value: doc.value as Metadata, conversationId: conversation.id };
		}
		cursor = page.next;
	} while (cursor);
	return undefined;
}

function mappingFor(source: Snapshot, conversationId: number, headId: number): MigrationMapping {
	const allBlocks = blocks(source.state);
	return {
		sourceFile: source.file,
		sessionId: source.header.id,
		cwd: source.header.cwd,
		title: source.title,
		database: durableDatabaseName(source.header.cwd),
		conversationId,
		headId,
		entryCount: source.entries.length,
		activeMessages: source.context.length,
		blocks: allBlocks.length,
		activeBlocks: source.context.filter((item) => item.blockId !== undefined).length,
		sourceSha256: source.sourceSha256,
		stateSha256: source.stateSha256,
	};
}

function assertAppendOnly(source: Snapshot, prior: Metadata): void {
	if (!same(prior.header, source.header)) throw new Error(`Source header changed: ${source.file}`);
	for (let at = 0; at < prior.entryOrder.length; at++) {
		const entry = source.entries[at];
		if (!entry || entry.id !== prior.entryOrder[at] || digest(canonical(entry)) !== prior.entryHashes[entry.id])
			throw new Error(`Source is not an append-only continuation: ${source.file}`);
	}
}

async function migrateOne(
	source: Snapshot,
	storage: Storage,
): Promise<{ mapping: MigrationMapping; skipped: boolean }> {
	const prior = await metadata(storage, source.header.id);
	if (prior) {
		const tail = (await storage.scanEntries({ conversationId: prior.conversationId }, 1, undefined, CTX)).items[0];
		if (tail?.id !== prior.value.headId)
			throw new Error(`Target conversation has resumed; refusing to reset it: ${source.header.id}`);
		assertAppendOnly(source, prior.value);
		if (prior.value.sourceSha256 === source.sourceSha256 && prior.value.stateSha256 === source.stateSha256) {
			await verifyOne(source, storage);
			return { mapping: { ...prior.value.mapping, sourceFile: source.file }, skipped: true };
		}
	}
	const conversationId = prior?.conversationId ?? (await storage.mintId<ConversationId>());
	const writes: StorageWrite[] = prior ? [] : [{ type: "conversation", value: { id: conversationId } }];
	const entryIds = Object.assign(Object.create(null) as Record<string, number>, prior?.value.entryIds);
	const entryHashes = Object.assign(Object.create(null) as Record<string, string>, prior?.value.entryHashes);
	for (const entry of source.entries) {
		if (entryIds[entry.id] !== undefined) continue;
		const id = await storage.mintId<EntryId>();
		entryIds[entry.id] = id;
		entryHashes[entry.id] = digest(canonical(entry));
		const message = messageOf(entry);
		writes.push({
			type: "entry",
			value: {
				id,
				conversationId,
				kind:
					entry.type === "message"
						? `pi.${entry.message.role === "toolResult" ? "tool-result" : entry.message.role}`
						: `legacy.${entry.type}`,
				...(message ? { model: [message] } : {}),
				data: json(entry),
			},
		});
	}
	// Historical edits prove which raw IDs a block folds. They must not be parsed on a context read.
	const archiveEdits: ContextEdit[] = [];
	for (const block of blocks(source.state).filter((candidate) => candidate.active)) {
		const covered = [...new Set(rawIds(block, source.state, source.branch))]
			.filter((id) => entryIds[id] !== undefined)
			.sort((left, right) => entryIds[left]! - entryIds[right]!);
		for (let at = 0; at < covered.length; at++)
			archiveEdits.push(
				at === 0
					? { target: entryIds[covered[at]!] as EntryId, action: "replace", messages: [renderMigrationSummary(block)] }
					: { target: entryIds[covered[at]!] as EntryId, action: "omit" },
			);
	}
	if (archiveEdits.length)
		writes.push({
			type: "entry",
			value: {
				id: await storage.mintId<EntryId>(),
				conversationId,
				kind: "acp.migration.archive-edits",
				edits: archiveEdits,
			},
		});
	// Historical context({at}) and fork(at) must see the bounded window as well.
	// The trailing head alone is invisible when the requested tail precedes it.
	const windowId = await storage.mintId<EntryId>();
	writes.push({
		type: "entry",
		value: { id: windowId, conversationId, kind: "acp.migration.window", head: windowId },
	});
	const contextEntryIds = Object.create(null) as Record<string, number>;
	const contextOrder: number[] = [];
	const edits: ContextEdit[] = [];
	let first: EntryId | undefined;
	for (const item of source.context) {
		const id = await storage.mintId<EntryId>();
		first ??= id;
		contextEntryIds[item.key] = id;
		contextOrder.push(id);
		writes.push({
			type: "entry",
			value: {
				id,
				conversationId,
				kind: item.blockId ? "acp.migration.anchor" : messageKind(item.message),
				// Keep summaries self-contained before the final head's replacement edits exist.
				model: [item.message],
				data: json({
					sourceId: item.sourceId,
					rawEntryId: item.sourceId ? entryIds[item.sourceId] : undefined,
					blockId: item.blockId,
				}),
			},
		});
		if (item.blockId) edits.push({ target: id, action: "replace", messages: [item.message] });
	}
	const headId = await storage.mintId<EntryId>();
	const mapping = mappingFor(source, conversationId, headId);
	writes.push({
		type: "entry",
		value: {
			id: headId,
			conversationId,
			kind: "acp.migration.head",
			head: first ?? headId,
			edits,
			data: { format: FORMAT, sessionId: source.header.id },
		},
	});
	const acp = { ...source.state, migration: { format: FORMAT, entryIds, contextEntryIds, contextOrder, headId } };
	const meta = json({
		format: FORMAT,
		sessionId: source.header.id,
		sourceFile: source.file,
		header: source.header,
		title: source.title,
		cwd: source.header.cwd,
		sourceSha256: source.sourceSha256,
		stateSha256: source.stateSha256,
		entryIds,
		entryHashes,
		entryOrder: source.entries.map((entry) => entry.id),
		contextEntryIds,
		contextOrder,
		headId,
		mapping,
		branch: source.branch.map((entry) => entry.id),
	}) as JsonObject;
	for (const [kind, value] of [
		["acp.state", acp],
		[META_KIND, meta],
	] as const) {
		const existing = await storage.findDocument(
			{ kind, scope: { kind: "conversation", conversationId } },
			"current",
			CTX,
		);
		if (existing)
			writes.push({ type: "document.change", id: existing.id, content: { version: 1, kind: "base", value } });
		else
			writes.push({
				type: "document.create",
				record: {
					id: await storage.mintId<DocumentId>(),
					kind,
					scope: { kind: "conversation", conversationId },
					...(kind === "acp.state"
						? ({ history: "rewindable", fork: "asOf" } as const)
						: ({ history: "latest", fork: "current" } as const)),
				},
				content: { version: 1, kind: "base", value },
			});
	}
	await storage.commit(writes, CTX); // raw history + context + documents are one atomic publication
	return { mapping, skipped: false };
}

/** Pure reader for verification and downstream decompression: returns the original JSONL entry. */
export async function readMigratedSourceEntry(
	storage: Storage,
	conversationId: ConversationId,
	rawId: string,
): Promise<SessionEntry | undefined> {
	const record = await storage.findDocument(
		{ kind: "acp.state", scope: { kind: "conversation", conversationId } },
		"current",
		CTX,
	);
	const doc = record ? await storage.document(record.id, "current", CTX) : undefined;
	const ids = object(object(doc?.value.migration)?.entryIds);
	const id = ids?.[baseId(rawId)];
	if (typeof id !== "number") return undefined;
	return (await storage.entry(conversationId, id as EntryId, CTX))?.entry.data as unknown as SessionEntry | undefined;
}

async function verifyOne(source: Snapshot, storage: Storage): Promise<MigrationMapping> {
	const stored = await metadata(storage, source.header.id);
	if (!stored) throw new Error(`Verification failed: no mapping for ${source.header.id}`);
	const fail = (reason: string): never => {
		throw new Error(`Verification failed (${reason}): ${source.header.id}`);
	};
	if (stored.value.sourceSha256 !== source.sourceSha256 || stored.value.stateSha256 !== source.stateSha256)
		fail("source/state hash");
	if (Object.keys(stored.value.entryIds).length !== source.entries.length) fail("entry count");
	if (!same(stored.value.header, source.header) || stored.value.title !== source.title) fail("session header/title");
	if (
		!same(
			stored.value.branch,
			source.branch.map((entry) => entry.id),
		)
	)
		fail("active branch");
	if (
		!same(
			stored.value.entryOrder,
			source.entries.map((entry) => entry.id),
		)
	)
		fail("source entry order");
	if (
		!same(
			stored.value.contextOrder,
			source.context.map((item) => stored.value.contextEntryIds[item.key]),
		)
	)
		fail("context ID map");
	for (const entry of source.entries) {
		const id = stored.value.entryIds[entry.id];
		const row = id === undefined ? undefined : await storage.entry(stored.conversationId, id as EntryId, CTX);
		if (!same(row?.entry.data, entry)) fail("raw entry");
	}
	const record = await storage.findDocument(
		{ kind: "acp.state", scope: { kind: "conversation", conversationId: stored.conversationId } },
		"current",
		CTX,
	);
	const doc = record ? await storage.document(record.id, "current", CTX) : undefined;
	if (!doc) fail("ACP document");
	const { migration: _migration, ...original } = doc!.value;
	if (!same(original, source.state)) fail("ACP blocks/refs/metadata");
	if (
		!same(_migration, {
			format: FORMAT,
			entryIds: stored.value.entryIds,
			contextEntryIds: stored.value.contextEntryIds,
			contextOrder: stored.value.contextOrder,
			headId: stored.value.headId,
		})
	)
		fail("ACP migration ID map");
	const head = await storage.entry(stored.conversationId, stored.value.headId as EntryId, CTX);
	if (!head) fail("head entry");
	const expectedIds = stored.value.contextOrder;
	if (head?.entry.head !== (expectedIds[0] ?? head?.entry.id)) fail("head bound");
	// Verify the SQL-visible range and ALL edits, not just the manifest's expected rows:
	// an extra entry or an omit edit must not be able to hide behind a correct ID map.
	const range: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanEntries(
			{ conversationId: stored.conversationId, minEntryId: head!.entry.head, maxEntryId: head!.entry.id },
			256,
			cursor,
			CTX,
		);
		range.push(...page.items);
		cursor = page.next;
	} while (cursor);
	range.reverse();
	if (
		!same(
			range.map((entry) => Number(entry.id)),
			[...expectedIds, stored.value.headId],
		)
	)
		fail("active window IDs");
	// The final head's replacements can mask a damaged summary row. Forks before
	// that head depend on the rows themselves and the immediately preceding marker.
	const window = (
		await storage.scanEntries(
			{
				conversationId: stored.conversationId,
				maxEntryId: ((expectedIds[0] ?? stored.value.headId) - 1) as EntryId,
			},
			1,
			undefined,
			CTX,
		)
	).items[0];
	if (
		window?.kind !== "acp.migration.window" ||
		window.head !== window.id ||
		window.model?.length ||
		window.edits?.length
	)
		fail("historical window marker");
	for (let at = 0; at < source.context.length; at++) {
		if (!same(range[at]?.model, [source.context[at]!.message])) fail("historical context row");
	}
	const edits = new Map<EntryId, ContextEdit>();
	for (const entry of range) for (const edit of entry.edits ?? []) edits.set(edit.target, edit);
	const actual: ContextItem[] = [];
	for (const entry of [head!.entry, ...range.filter((row) => row.head === undefined)]) {
		const edit = edits.get(entry.id);
		const messages = edit?.action === "omit" ? [] : edit?.action === "replace" ? edit.messages : (entry.model ?? []);
		for (let at = 0; at < messages.length; at++) actual.push({ key: `${entry.id}:${at}`, message: messages[at]! });
	}
	if (
		!same(
			settleMessages(actual).map((item) => item.message),
			source.context.map((item) => item.message),
		)
	)
		fail("active context");
	const tail = (await storage.scanEntries({ conversationId: stored.conversationId }, 1, undefined, CTX)).items[0];
	if (tail?.id !== head?.entry.id) fail("target has newer entries");
	return mappingFor(source, stored.conversationId, stored.value.headId);
}

async function withReadOnlyCopy<T>(file: string, run: (storage: Storage) => Promise<T>): Promise<T> {
	const status = await lstat(file); // a missing target must not create an empty DB
	if (!status.isFile() || status.isSymbolicLink()) throw new Error(`Target must be a regular file: ${file}`);
	const temporary = await mkdtemp(join(tmpdir(), "pi-durable-verify-"));
	let reader: DatabaseSync | undefined;
	let storage: Storage | undefined;
	try {
		reader = new DatabaseSync(file, { readOnly: true });
		const copy = join(temporary, "snapshot.sqlite");
		await backup(reader, copy); // includes committed WAL pages, unlike copying the DB file
		reader.close();
		reader = undefined;
		storage = await openNodeSqliteStorage(copy);
		return await run(storage);
	} finally {
		reader?.close();
		if (storage) await storage.close(CTX);
		await rm(temporary, { recursive: true, force: true });
	}
}

function assertMapping(value: unknown): asserts value is MigrationMapping {
	const mapping = object(value);
	if (
		!mapping ||
		typeof mapping.sessionId !== "string" ||
		!mapping.sessionId ||
		typeof mapping.cwd !== "string" ||
		!mapping.cwd ||
		typeof mapping.sourceFile !== "string" ||
		typeof mapping.database !== "string" ||
		mapping.database !== durableDatabaseName(mapping.cwd) ||
		![mapping.conversationId, mapping.headId].every(
			(id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0,
		) ||
		![mapping.entryCount, mapping.activeMessages, mapping.blocks, mapping.activeBlocks].every(
			(count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0,
		) ||
		!(mapping.title === null || typeof mapping.title === "string") ||
		![mapping.sourceSha256, mapping.stateSha256].every(
			(hash) => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash),
		)
	)
		throw new Error("Invalid migration manifest mapping identity/format");
}

async function readManifest(targetDir: string): Promise<Map<string, MigrationMapping>> {
	const mappings = new Map<string, MigrationMapping>();
	let manifest: JsonObject | undefined;
	try {
		const file = join(targetDir, MANIFEST);
		const status = await lstat(file);
		if (!status.isFile() || status.isSymbolicLink()) throw new Error("Manifest must be a regular file");
		manifest = object(JSON.parse(await readFile(file, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return mappings;
	}
	if (manifest?.format !== FORMAT || !Array.isArray(manifest.sessions))
		throw new Error("Unsupported migration manifest");
	const conversations = new Set<string>();
	for (const value of manifest.sessions) {
		assertMapping(value);
		if (mappings.has(value.sessionId)) throw new Error("Duplicate manifest session UUID");
		const key = `${value.database}:${value.conversationId}`;
		if (conversations.has(key)) throw new Error("Conflicting manifest conversation identity");
		conversations.add(key);
		mappings.set(value.sessionId, value);
	}
	return mappings;
}

function sameIdentity(left: MigrationMapping, right: MigrationMapping): boolean {
	return (
		left.sessionId === right.sessionId &&
		resolve(left.cwd) === resolve(right.cwd) &&
		left.database === right.database &&
		left.conversationId === right.conversationId
	);
}
function sameMapping(left: MigrationMapping, right: MigrationMapping): boolean {
	// A source snapshot may be relocated without changing its immutable session header.
	const { sourceFile: _left, ...a } = left;
	const { sourceFile: _right, ...b } = right;
	return same(a, b);
}

/** Read ALL target workspace identities before opening any database for writing. Committed
 * database documents survive a crash before manifest rename; a conflicting manifest never wins. */
async function targetIndex(
	targetDir: string,
	manifest: Map<string, MigrationMapping>,
): Promise<{
	sessions: Map<string, Metadata>;
	tails: Map<string, EntryId | undefined>;
}> {
	const index = new Map<string, Metadata>();
	const tails = new Map<string, EntryId | undefined>();
	let names: string[];
	try {
		names = await readdir(targetDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		names = [];
	}
	for (const database of names.filter((name) => /^session-[0-9a-f]{12}\.sqlite$/.test(name)).sort()) {
		await withReadOnlyCopy(join(targetDir, database), async (storage) => {
			let cursor: Cursor | undefined;
			do {
				const page = await storage.scanConversations({}, 256, cursor, CTX);
				for (const conversation of page.items) {
					const record = await storage.findDocument(
						{ kind: META_KIND, scope: { kind: "conversation", conversationId: conversation.id } },
						"current",
						CTX,
					);
					if (!record) continue;
					const document = await storage.document(record.id, "current", CTX);
					const value = document?.value as Metadata | undefined;
					assertMapping(value?.mapping);
					const mapping = value!.mapping;
					const header = sessionHeader(object(value!.header), database);
					if (
						value!.format !== FORMAT ||
						mapping.database !== database ||
						mapping.conversationId !== conversation.id ||
						mapping.sessionId !== value!.sessionId ||
						mapping.headId !== value!.headId ||
						mapping.cwd !== value!.cwd ||
						mapping.sourceSha256 !== value!.sourceSha256 ||
						mapping.stateSha256 !== value!.stateSha256 ||
						!sameIdentity(mapping, { ...mapping, sessionId: header.id, cwd: header.cwd })
					)
						throw new Error(`Conflicting committed UUID/workspace/database identity: ${mapping.sessionId}`);
					if (index.has(mapping.sessionId)) throw new Error(`Duplicate target session UUID: ${mapping.sessionId}`);
					const previous = manifest.get(mapping.sessionId);
					if (previous) {
						if (!sameIdentity(previous, mapping))
							throw new Error(`Conflicting manifest mapping UUID/workspace/database identity: ${mapping.sessionId}`);
						if (previous.headId === mapping.headId) {
							if (!sameMapping(previous, mapping))
								throw new Error(`Conflicting manifest mapping: ${mapping.sessionId}`);
						} else {
							const oldHead = await storage.entry(conversation.id, previous.headId as EntryId, CTX);
							if (
								previous.headId > mapping.headId ||
								oldHead?.entry.kind !== "acp.migration.head" ||
								object(oldHead.entry.data)?.sessionId !== mapping.sessionId ||
								previous.entryCount > mapping.entryCount
							)
								throw new Error(`Conflicting manifest mapping head: ${mapping.sessionId}`);
						}
					}
					index.set(mapping.sessionId, value!);
					const tail = (await storage.scanEntries({ conversationId: conversation.id }, 1, undefined, CTX)).items[0];
					tails.set(mapping.sessionId, tail?.id);
				}
				cursor = page.next;
			} while (cursor);
		});
	}
	for (const id of manifest.keys()) {
		if (!index.has(id)) throw new Error(`Manifest mapping has no committed target database: ${id}`);
	}
	return { sessions: index, tails };
}

async function realFuturePath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
		return join(await realFuturePath(dirname(path)), basename(path));
	}
}

/** Deterministic file order, one offline writer, restart-safe database documents + atomic manifest. */
export async function migrateSessionsToDurable(options: MigrationOptions): Promise<MigrationReport> {
	if (options.dryRun && options.verify) throw new Error("Choose --dry-run or --verify, not both");
	const sourceDir = await realpath(resolve(options.sourceDir));
	const targetDir = await realFuturePath(resolve(options.targetDir));
	const targetRelative = relative(sourceDir, targetDir);
	if (targetRelative === "" || (!targetRelative.startsWith(`..${sep}`) && targetRelative !== ".."))
		throw new Error("Target directory must be outside the source directory");
	const mode = options.dryRun ? "dry-run" : options.verify ? "verify" : "migrate";
	const report: MigrationReport = { mode, sessions: [], migrated: 0, skipped: 0, mismatches: 0 };
	const files = await listSources(sourceDir);
	const offline: OfflineSources = { headers: new Map(), parents: options.parentSessionMap ?? {}, directory: sourceDir };
	const seen = new Set<string>();
	for (const file of files) {
		const header = await readSourceHeader(file);
		if (seen.has(header.id)) throw new Error(`Duplicate source session UUID: ${header.id}`);
		seen.add(header.id);
		offline.headers.set(file, header);
	}
	const stores = new Map<string, Storage>();
	const lock = join(targetDir, ".migration-lock");
	let locked = false;
	try {
		if (mode === "migrate") {
			await mkdir(targetDir, { recursive: true, mode: 0o700 });
			try {
				await mkdir(lock, { mode: 0o700 });
				locked = true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST")
					throw new Error(
						`Another migration owns ${lock}; if interrupted, confirm it is stopped before removing this lock`,
					);
				throw error;
			}
		}
		const manifest = await readManifest(targetDir);
		const { sessions: targets, tails } = await targetIndex(targetDir, manifest);
		for (const header of offline.headers.values()) {
			const prior = targets.get(header.id);
			if (!prior) continue;
			if (!same(prior.header, header))
				throw new Error(`Conflicting source UUID/workspace/header identity: ${header.id}`);
			if (tails.get(header.id) !== prior.headId)
				throw new Error(`Target conversation has resumed; refusing to reset it: ${header.id}`);
		}
		// Validate every source (including inherited ACP) before publishing the first conversation.
		// Keep only hashes between passes, rather than retaining every large chat's full history.
		const checked = new Map<string, { sourceSha256: string; stateSha256: string }>();
		for (const file of files) {
			const source = await loadSnapshot(file, offline);
			const prior = targets.get(source.header.id);
			if (prior) assertAppendOnly(source, prior);
			checked.set(file, { sourceSha256: source.sourceSha256, stateSha256: source.stateSha256 });
			if (mode === "dry-run") report.sessions.push(mappingFor(source, 0, 0));
		}
		if (mode === "dry-run") return report;
		for (const file of files) {
			const source = await loadSnapshot(file, offline);
			if (!same(checked.get(file), { sourceSha256: source.sourceSha256, stateSha256: source.stateSha256 }))
				throw new Error(`Source/state changed after preflight: ${file}`);
			const path = join(targetDir, durableDatabaseName(source.header.cwd));
			if (mode === "verify") {
				report.sessions.push(await withReadOnlyCopy(path, (storage) => verifyOne(source, storage)));
				continue;
			}
			let storage = stores.get(path);
			if (!storage) {
				try {
					const status = await lstat(path);
					if (!status.isFile() || status.isSymbolicLink()) throw new Error(`Target must be a regular file: ${path}`);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				storage = await openNodeSqliteStorage(path);
				stores.set(path, storage);
			}
			const result = await migrateOne(source, storage);
			report.sessions.push(result.mapping);
			if (result.skipped) report.skipped++;
			else report.migrated++;
		}
		if (mode === "migrate") {
			// Recover committed mappings even if their manifest rename was interrupted, including
			// sessions outside the current incremental selection. Conflicts were refused pre-write.
			const mappings = new Map<string, MigrationMapping>([...targets].map(([id, value]) => [id, value.mapping]));
			for (const entry of report.sessions) mappings.set(entry.sessionId, entry);
			const temp = join(targetDir, `${MANIFEST}.tmp`);
			await writeFile(
				temp,
				`${JSON.stringify({ format: FORMAT, sessions: [...mappings.values()].sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)) }, null, 2)}\n`,
				{ mode: 0o600 },
			);
			await rename(temp, join(targetDir, MANIFEST));
		}
		if (mode === "verify") {
			for (const mapping of report.sessions) {
				if (!same(manifest.get(mapping.sessionId), mapping))
					throw new Error(`Verification failed (manifest mapping): ${mapping.sessionId}`);
			}
		}
		return report;
	} finally {
		try {
			for (const storage of stores.values()) await storage.close(CTX);
		} finally {
			if (locked) await rm(lock, { recursive: true });
		}
	}
}
