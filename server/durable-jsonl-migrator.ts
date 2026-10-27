/**
 * Wave 3.3 (#603): Lossless `.jsonl` -> `@earendil-works/pi-durable` SQLite migrator
 * with pre-migration backup snapshot/manifest, entry-count & SHA-256 content
 * verification, and restore-tested rollback (`verifyMigration` + `rollbackToJsonl`).
 */

import { createHash, randomUUID } from "node:crypto";
import {
	copyFileSync,
	createReadStream,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import {
	allocatePiDurableIdAndSeq,
	initializeDurableDatabaseSchema,
	isDurableSessionRef,
	resolveDurableDbPath,
	toDurableSessionKey,
} from "./durable-env-bootstrap.js";

export interface PreMigrationEntryHash {
	seq: number;
	entryId: string;
	parentId: string | null;
	type: string;
	customType: string | null;
	sha256: string;
}

export interface PreMigrationFileEntry {
	filePath: string;
	relativePath: string;
	backupPath?: string;
	sidecarPath?: string;
	sidecarBackupPath?: string;
	sidecarSha256?: string;
	sizeBytes: number;
	sha256: string;
	sessionId: string;
	cwd: string;
	parentSession: string | null;
	entryCount: number;
	entryHashes: PreMigrationEntryHash[];
	acpBlockCount: number;
	branchCount: number;
	leafEntryIds: string[];
	attachmentCount: number;
}

export interface PreMigrationIdentitySnapshot {
	roleId: string;
	identityPath: string;
	backupPath?: string;
	sha256: string;
	rawContent: string;
	originalHomeChat?: string;
}

export interface PreMigrationManifest {
	version: 1;
	createdAt: string;
	sessionsDir: string;
	dbPath: string;
	backupDir?: string;
	manifestPath?: string;
	files: PreMigrationFileEntry[];
	identities: PreMigrationIdentitySnapshot[];
}

export interface DurableJsonlMigrationOptions {
	/** Directory containing `.jsonl` session files (recursively scanned). */
	sessionsDir?: string;
	/** Explicit list of `.jsonl` session files to migrate. */
	sessionFiles?: string[];
	/** Target `.pi-web-ui` data directory. */
	dataDir?: string;
	/** Target `.pi/agent` directory (for role `identities/*\/identity.json` snapshot & cutover). */
	agentDir?: string;
	/** Explicit SQLite `durable-sessions.db` path. */
	dbPath?: string;
	/** Directory for pre-migration backup copies and `manifest.json`. */
	backupDir?: string;
	/** Update role `identity.json` `homeChat`s that point to migrated `.jsonl` files (default true). */
	updateRoleIdentities?: boolean;
	/** Automatically run `rollbackToJsonl` if post-migration verification fails (default true). */
	autoRollbackOnFailure?: boolean;
}

export interface MigratedSessionSummary {
	sessionId: string;
	durableKey: string;
	sourceFile: string;
	sourceSha256: string;
	cwd: string;
	parentSession: string | null;
	entryCount: number;
	acpBlockCount: number;
	branchCount: number;
	leafEntryIds: string[];
	activeLeafEntryId: string | null;
	customEntryCounts: Record<string, number>;
	attachmentCount: number;
	entriesAggregateSha256: string;
}

export interface MigrationVerificationResult {
	ok: boolean;
	sessionsVerified: number;
	entriesVerified: number;
	acpBlocksVerified: number;
	branchesVerified: number;
	originalsUntouched: boolean;
	mismatches: string[];
}

export interface RollbackResult {
	ok: boolean;
	restoredFiles: number;
	restoredIdentities: number;
	removedDb: boolean;
	verifiedSha256: boolean;
	errors: string[];
}

export interface DurableJsonlMigrationResult {
	ok: boolean;
	dbPath: string;
	manifest: PreMigrationManifest;
	migratedSessions: MigratedSessionSummary[];
	verification: MigrationVerificationResult;
	rolledBack: boolean;
}

interface ParsedEntryRecord {
	seq: number;
	entryId: string;
	parentId: string | null;
	entryType: string;
	customType: string | null;
	role: string | null;
	timestamp: string;
	payloadJson: string;
	sha256: string;
	rawObj: Record<string, unknown>;
	isAcpBlock: boolean;
	attachmentCount: number;
	branchName: string;
}

interface ParsedSessionFile {
	filePath: string;
	sizeBytes: number;
	fileSha256: string;
	sessionId: string;
	cwd: string;
	createdAtIso: string;
	parentSession: string | null;
	sessionName: string | null;
	modelProvider: string | null;
	modelId: string | null;
	thinkingLevel: string | null;
	entries: ParsedEntryRecord[];
	acpBlocks: unknown[];
	acpBlockCount: number;
	branches: Array<{ branchName: string; headEntryId: string | null }>;
	leafEntryIds: string[];
	activeLeafEntryId: string | null;
	customEntryCounts: Record<string, number>;
	attachmentCount: number;
	entriesAggregateSha256: string;
}

function sha256Hex(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function sha256FileSync(filePath: string): string {
	return sha256Hex(readFileSync(filePath));
}

function writeFileAtomicSync(filePath: string, content: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmpPath, content, "utf8");
	renameSync(tmpPath, filePath);
}

function collectJsonlSessionFiles(dirPath: string): string[] {
	if (!existsSync(dirPath)) return [];
	const out: string[] = [];
	const visit = (current: string) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const fullPath = join(current, entry.name);
			if (entry.isDirectory()) {
				visit(fullPath);
			} else if (
				entry.isFile() &&
				entry.name.endsWith(".jsonl") &&
				entry.name !== "events.jsonl" &&
				!entry.name.startsWith("conn-events")
			) {
				out.push(resolve(fullPath));
			}
		}
	};
	visit(dirPath);
	return out.sort();
}

function detectAcpBlockInEntry(obj: Record<string, unknown>): boolean {
	const type = typeof obj.type === "string" ? obj.type : "";
	if (type === "compaction" || type === "acp_block") {
		return true;
	}
	if (type === "custom") {
		const ct = typeof obj.customType === "string" ? obj.customType : "";
		if (
			ct === "acp" ||
			ct === "acp_block" ||
			ct === "acp-block" ||
			ct === "acp-state" ||
			ct.startsWith("acp") ||
			ct.startsWith("billion-context")
		) {
			return true;
		}
	}
	if (type === "message" && obj.message && typeof obj.message === "object") {
		const msg = obj.message as Record<string, unknown>;
		if (msg.role === "toolResult" && msg.toolName === "compress") {
			return true;
		}
		if (Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (part && typeof part === "object") {
					const p = part as Record<string, unknown>;
					if (p.type === "toolCall" && p.name === "compress") {
						return true;
					}
				}
			}
		}
	}
	return false;
}

function countEntryAttachments(obj: Record<string, unknown>): number {
	let count = 0;
	if (Array.isArray(obj.attachments)) {
		count += obj.attachments.length;
	}
	if (obj.message && typeof obj.message === "object") {
		const msg = obj.message as Record<string, unknown>;
		if (Array.isArray(msg.attachments)) {
			count += msg.attachments.length;
		}
		if (Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (part && typeof part === "object") {
					const p = part as Record<string, unknown>;
					if (
						p.type === "image" ||
						p.type === "file" ||
						p.type === "attachment" ||
						p.type === "document" ||
						(typeof p.data === "string" && p.data.length > 1024)
					) {
						count += 1;
					}
				}
			}
		}
	}
	return count;
}

/**
 * Stream-parse a `.jsonl` session file line by line without mutating the source file.
 */
export async function streamParseJsonlSession(filePath: string): Promise<ParsedSessionFile> {
	const resolvedPath = resolve(filePath);
	const st = statSync(resolvedPath);
	const fileSha256 = sha256FileSync(resolvedPath);

	let sessionId = basename(resolvedPath, ".jsonl");
	let cwd = dirname(resolvedPath);
	let createdAtIso = new Date(st.mtimeMs).toISOString();
	let parentSession: string | null = null;
	let sessionName: string | null = null;
	let modelProvider: string | null = null;
	let modelId: string | null = null;
	let thinkingLevel: string | null = null;

	const entries: ParsedEntryRecord[] = [];
	const acpBlocks: unknown[] = [];
	const customEntryCounts: Record<string, number> = {};
	let attachmentCount = 0;

	const rl = createInterface({
		input: createReadStream(resolvedPath, { encoding: "utf8" }),
		crlfDelay: Infinity,
	});

	let lineNumber = 0;
	for await (const rawLine of rl) {
		lineNumber += 1;
		const trimmed = rawLine.trim();
		if (!trimmed) continue;

		let obj: Record<string, unknown>;
		try {
			obj = JSON.parse(trimmed) as Record<string, unknown>;
		} catch (err) {
			throw new Error(
				`Invalid JSON on line ${lineNumber} of ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		const type = typeof obj.type === "string" ? obj.type : "custom";
		if (type === "session" && entries.length === 0 && lineNumber === 1) {
			if (typeof obj.id === "string" && obj.id.trim()) {
				sessionId = obj.id.trim();
			}
			if (typeof obj.cwd === "string" && obj.cwd.trim()) {
				cwd = obj.cwd;
			}
			if (typeof obj.timestamp === "string" && obj.timestamp.trim()) {
				createdAtIso = obj.timestamp;
			}
			if (typeof obj.parentSession === "string" && obj.parentSession.trim()) {
				parentSession = obj.parentSession;
			}
			continue;
		}

		const seq = entries.length + 1;
		const entryId =
			typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : `migrated-${sessionId.slice(0, 8)}-${seq}`;
		const parentId =
			typeof obj.parentId === "string" && obj.parentId.trim()
				? obj.parentId.trim()
				: obj.parentId === null
					? null
					: entries.length > 0
						? entries[entries.length - 1].entryId
						: null;
		const timestamp =
			typeof obj.timestamp === "string" && obj.timestamp.trim() ? obj.timestamp : createdAtIso;

		let customType: string | null = null;
		if (type === "custom" && typeof obj.customType === "string" && obj.customType.trim()) {
			customType = obj.customType.trim();
		} else if (
			type === "model_change" ||
			type === "thinking_level_change" ||
			type === "compaction" ||
			type === "acp_block"
		) {
			customType = type;
		}

		if (customType) {
			customEntryCounts[customType] = (customEntryCounts[customType] ?? 0) + 1;
		}

		if (type === "session_info" && typeof obj.name === "string" && obj.name.trim()) {
			sessionName = obj.name.trim();
		} else if (type === "model_change") {
			if (typeof obj.provider === "string") modelProvider = obj.provider;
			if (typeof obj.modelId === "string") modelId = obj.modelId;
		} else if (type === "thinking_level_change") {
			if (typeof obj.thinkingLevel === "string") thinkingLevel = obj.thinkingLevel;
		}

		let role: string | null = null;
		if (type === "message" && obj.message && typeof obj.message === "object") {
			const msg = obj.message as Record<string, unknown>;
			if (typeof msg.role === "string") {
				role = msg.role;
			}
		}

		const isAcpBlock = detectAcpBlockInEntry(obj);
		if (isAcpBlock) {
			acpBlocks.push({
				entryId,
				seq,
				type,
				customType,
				payload: obj,
			});
		}

		const entryAttachments = countEntryAttachments(obj);
		attachmentCount += entryAttachments;

		const payloadJson = JSON.stringify(obj);
		const entrySha = sha256Hex(payloadJson);

		entries.push({
			seq,
			entryId,
			parentId,
			entryType: type,
			customType,
			role,
			timestamp,
			payloadJson,
			sha256: entrySha,
			rawObj: obj,
			isAcpBlock,
			attachmentCount: entryAttachments,
			branchName: "main",
		});
	}

	// Check optional adjacent .jsonl.acp.json sidecar file
	const sidecarPath = `${resolvedPath}.acp.json`;
	if (existsSync(sidecarPath)) {
		try {
			const sidecarObj = JSON.parse(readFileSync(sidecarPath, "utf8")) as Record<string, unknown>;
			if (Array.isArray(sidecarObj.blocks)) {
				for (const block of sidecarObj.blocks) {
					acpBlocks.push({ source: "sidecar", block });
				}
			} else {
				acpBlocks.push({ source: "sidecar", payload: sidecarObj });
			}
		} catch {
			// Ignore malformed sidecar if not valid JSON
		}
	}

	// Reconstruct multi-branch tree from (entryId, parentId)
	const entryById = new Map<string, ParsedEntryRecord>();
	const parentsWithChildren = new Set<string>();
	for (const entry of entries) {
		entryById.set(entry.entryId, entry);
		if (entry.parentId !== null) {
			parentsWithChildren.add(entry.parentId);
		}
	}

	const leafEntries = entries.filter((e) => !parentsWithChildren.has(e.entryId));
	const leafEntryIds = leafEntries.map((e) => e.entryId);
	const activeLeafEntryId = leafEntryIds.length > 0 ? leafEntryIds[leafEntryIds.length - 1] : null;

	const branches: Array<{ branchName: string; headEntryId: string | null }> = [];
	if (leafEntries.length === 0) {
		branches.push({ branchName: "main", headEntryId: null });
	} else {
		// Mark entries on the active leaf lineage as 'main', and side-branch leaves as 'branch-1', 'branch-2', ...
		const mainLineage = new Set<string>();
		let cursor = activeLeafEntryId;
		const visited = new Set<string>();
		while (cursor && !visited.has(cursor)) {
			visited.add(cursor);
			mainLineage.add(cursor);
			cursor = entryById.get(cursor)?.parentId ?? null;
		}

		branches.push({ branchName: "main", headEntryId: activeLeafEntryId });

		let sideBranchIdx = 0;
		for (let i = 0; i < leafEntries.length - 1; i++) {
			sideBranchIdx += 1;
			const branchName = `branch-${sideBranchIdx}`;
			const leafId = leafEntries[i].entryId;
			branches.push({ branchName, headEntryId: leafId });

			let sideCursor: string | null = leafId;
			const sideVisited = new Set<string>();
			while (sideCursor && !sideVisited.has(sideCursor) && !mainLineage.has(sideCursor)) {
				sideVisited.add(sideCursor);
				const rec = entryById.get(sideCursor);
				if (rec) {
					rec.branchName = branchName;
				}
				sideCursor = rec?.parentId ?? null;
			}
		}
	}

	const aggregateHasher = createHash("sha256");
	for (const entry of entries) {
		aggregateHasher.update(`${entry.seq}:${entry.entryId}:${entry.sha256}\n`, "utf8");
	}
	const entriesAggregateSha256 = aggregateHasher.digest("hex");

	return {
		filePath: resolvedPath,
		sizeBytes: st.size,
		fileSha256,
		sessionId,
		cwd,
		createdAtIso,
		parentSession,
		sessionName,
		modelProvider,
		modelId,
		thinkingLevel,
		entries,
		acpBlocks,
		acpBlockCount: acpBlocks.length,
		branches,
		leafEntryIds,
		activeLeafEntryId,
		customEntryCounts,
		attachmentCount,
		entriesAggregateSha256,
	};
}

/**
 * Take a verified pre-migration snapshot/manifest of `.jsonl` session files and
 * role `identity.json` files, preserving all originals untouched on disk.
 */
export async function createPreMigrationSnapshot(
	options: DurableJsonlMigrationOptions,
): Promise<PreMigrationManifest> {
	const sessionsDir = resolve(
		options.sessionsDir ??
			(options.sessionFiles && options.sessionFiles.length > 0
				? dirname(options.sessionFiles[0])
				: join(options.agentDir ?? process.cwd(), "sessions")),
	);
	const dataDir = resolve(options.dataDir ?? dirname(sessionsDir));
	const dbPath = resolveDurableDbPath(dataDir, options.dbPath);
	const backupDir = options.backupDir
		? resolve(options.backupDir)
		: join(dirname(dbPath), "pre-durable-migration-backup");

	const sessionFiles = options.sessionFiles
		? options.sessionFiles.map((f) => resolve(f)).sort()
		: collectJsonlSessionFiles(sessionsDir);

	mkdirSync(backupDir, { recursive: true });
	const filesBackupRoot = join(backupDir, "sessions");
	mkdirSync(filesBackupRoot, { recursive: true });

	const files: PreMigrationFileEntry[] = [];
	for (const filePath of sessionFiles) {
		const parsed = await streamParseJsonlSession(filePath);
		const rel = relative(sessionsDir, filePath).startsWith("..")
			? basename(filePath)
			: relative(sessionsDir, filePath);
		const backupPath = join(filesBackupRoot, rel);
		mkdirSync(dirname(backupPath), { recursive: true });
		copyFileSync(filePath, backupPath);

		const sidecarPath = `${filePath}.acp.json`;
		let sidecarBackupPath: string | undefined;
		let sidecarSha256: string | undefined;
		if (existsSync(sidecarPath)) {
			sidecarBackupPath = `${backupPath}.acp.json`;
			copyFileSync(sidecarPath, sidecarBackupPath);
			sidecarSha256 = sha256FileSync(sidecarPath);
		}

		files.push({
			filePath,
			relativePath: rel,
			backupPath,
			...(sidecarPath && sidecarBackupPath ? { sidecarPath, sidecarBackupPath, sidecarSha256 } : {}),
			sizeBytes: parsed.sizeBytes,
			sha256: parsed.fileSha256,
			sessionId: parsed.sessionId,
			cwd: parsed.cwd,
			parentSession: parsed.parentSession,
			entryCount: parsed.entries.length,
			entryHashes: parsed.entries.map((e) => ({
				seq: e.seq,
				entryId: e.entryId,
				parentId: e.parentId,
				type: e.entryType,
				customType: e.customType,
				sha256: e.sha256,
			})),
			acpBlockCount: parsed.acpBlockCount,
			branchCount: parsed.branches.length,
			leafEntryIds: parsed.leafEntryIds,
			attachmentCount: parsed.attachmentCount,
		});
	}

	const identities: PreMigrationIdentitySnapshot[] = [];
	if (options.agentDir) {
		const identitiesRoot = join(resolve(options.agentDir), "memory", "identities");
		if (existsSync(identitiesRoot)) {
			const identitiesBackupRoot = join(backupDir, "identities");
			mkdirSync(identitiesBackupRoot, { recursive: true });
			for (const roleName of readdirSync(identitiesRoot).sort()) {
				const roleDir = join(identitiesRoot, roleName);
				const identityPath = join(roleDir, "identity.json");
				if (!existsSync(identityPath)) continue;
				const rawContent = readFileSync(identityPath, "utf8");
				const sha = sha256Hex(rawContent);
				const parsedId = JSON.parse(rawContent) as Record<string, unknown>;
				const roleId = typeof parsedId.id === "string" && parsedId.id.trim() ? parsedId.id.trim() : roleName;
				const backupPath = join(identitiesBackupRoot, roleName, "identity.json");
				mkdirSync(dirname(backupPath), { recursive: true });
				copyFileSync(identityPath, backupPath);

				identities.push({
					roleId,
					identityPath,
					backupPath,
					sha256: sha,
					rawContent,
					...(typeof parsedId.homeChat === "string" ? { originalHomeChat: parsedId.homeChat } : {}),
				});
			}
		}
	}

	const manifestPath = join(backupDir, "manifest.json");
	const manifest: PreMigrationManifest = {
		version: 1,
		createdAt: new Date().toISOString(),
		sessionsDir,
		dbPath,
		backupDir,
		manifestPath,
		files,
		identities,
	};

	writeFileAtomicSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	return manifest;
}

/**
 * Import a parsed `.jsonl` session into `durable-sessions.db` inside an atomic SQLite transaction.
 */
function importParsedSessionIntoDb(db: DatabaseSync, parsed: ParsedSessionFile): MigratedSessionSummary {
	const durableKey = toDurableSessionKey(parsed.sessionId);
	const createdMs = Number.isFinite(Date.parse(parsed.createdAtIso))
		? Date.parse(parsed.createdAtIso)
		: Date.now();
	const lastEntryIso =
		parsed.entries.length > 0 ? parsed.entries[parsed.entries.length - 1].timestamp : parsed.createdAtIso;
	const updatedMs = Number.isFinite(Date.parse(lastEntryIso)) ? Date.parse(lastEntryIso) : createdMs;

	db.exec("BEGIN IMMEDIATE");
	try {
		// Remove any prior migrated rows for this sessionId so re-runs are idempotent
		db.prepare("DELETE FROM durable_entries WHERE session_id = ?").run(parsed.sessionId);
		db.prepare("DELETE FROM durable_branches WHERE session_id = ?").run(parsed.sessionId);
		db.prepare("DELETE FROM durable_checkpoints WHERE session_id = ?").run(parsed.sessionId);
		db.prepare("DELETE FROM session_entries WHERE session_id = ?").run(parsed.sessionId);
		db.prepare("DELETE FROM session_leaf_checkpoints WHERE session_id = ?").run(parsed.sessionId);
		db.prepare("DELETE FROM session_compaction_state WHERE session_id = ?").run(parsed.sessionId);

		// 1. Insert durable_sessions & session_metadata
		db.prepare(
			`INSERT OR REPLACE INTO durable_sessions (
				session_id, file_path, cwd, name, model_provider, model_id, thinking_level,
				parent_session, active_branch, leaf_entry_id, entry_count, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'main', ?, ?, ?, ?)`,
		).run(
			parsed.sessionId,
			parsed.filePath,
			parsed.cwd,
			parsed.sessionName,
			parsed.modelProvider,
			parsed.modelId,
			parsed.thinkingLevel,
			parsed.parentSession,
			parsed.activeLeafEntryId,
			parsed.entries.length,
			createdMs,
			updatedMs,
		);

		db.prepare(
			`INSERT OR REPLACE INTO session_metadata (
				session_id, version, created_at, cwd, parent_session
			) VALUES (?, 3, ?, ?, ?)`,
		).run(parsed.sessionId, parsed.createdAtIso, parsed.cwd, parsed.parentSession);

		// 2. Insert branches & leaf checkpoints
		const insertBranchStmt = db.prepare(
			`INSERT OR REPLACE INTO durable_branches (
				session_id, branch_name, head_entry_id, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?)`,
		);
		for (const branch of parsed.branches) {
			insertBranchStmt.run(parsed.sessionId, branch.branchName, branch.headEntryId, createdMs, updatedMs);
		}

		// 3. Allocate @earendil-works/pi-durable conversation + entry IDs
		const { firstId, commitSeq } = allocatePiDurableIdAndSeq(db, 1 + parsed.entries.length);
		const convNumericId = firstId;
		db.prepare("INSERT OR IGNORE INTO record_ids (id, record_type) VALUES (?, 'conversation')").run(convNumericId);
		db.prepare(
			"INSERT INTO conversations (id, owner_conversation_id, owner_task_id, record) VALUES (?, NULL, NULL, ?)",
		).run(convNumericId, JSON.stringify({ id: convNumericId }));

		// 4. Insert all entries across durable_entries, session_entries, and pi-durable entries
		const insertDurableEntryStmt = db.prepare(
			`INSERT INTO durable_entries (
				session_id, seq, entry_id, parent_id, branch_name, entry_type,
				custom_type, role, timestamp, payload_json, content_hash
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const insertSessionEntryStmt = db.prepare(
			`INSERT INTO session_entries (
				session_id, entry_id, parent_id, entry_type, timestamp, data_json
			) VALUES (?, ?, ?, ?, ?, ?)`,
		);
		const insertRecordIdStmt = db.prepare(
			"INSERT OR IGNORE INTO record_ids (id, record_type) VALUES (?, 'entry')",
		);
		const insertPiDurableEntryStmt = db.prepare(
			"INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, ?, ?, ?, ?)",
		);

		const entryRowIdByEntryId = new Map<string, number>();

		for (let i = 0; i < parsed.entries.length; i++) {
			const entry = parsed.entries[i];
			insertDurableEntryStmt.run(
				parsed.sessionId,
				entry.seq,
				entry.entryId,
				entry.parentId,
				entry.branchName,
				entry.entryType,
				entry.customType,
				entry.role,
				entry.timestamp,
				entry.payloadJson,
				entry.sha256,
			);

			const runRes = insertSessionEntryStmt.run(
				parsed.sessionId,
				entry.entryId,
				entry.parentId,
				entry.entryType,
				entry.timestamp,
				entry.payloadJson,
			);
			entryRowIdByEntryId.set(entry.entryId, Number(runRes.lastInsertRowid));

			const entryNumericId = firstId + 1 + i;
			insertRecordIdStmt.run(entryNumericId);
			const headMarker = entry.isAcpBlock ? entryNumericId : null;
			insertPiDurableEntryStmt.run(
				entryNumericId,
				convNumericId,
				headMarker,
				commitSeq,
				JSON.stringify({
					id: entryNumericId,
					conversationId: convNumericId,
					kind: `pi-web-ui.${entry.entryType}`,
					...(headMarker !== null ? { head: headMarker } : {}),
					data: {
						sessionId: parsed.sessionId,
						entryId: entry.entryId,
						parentId: entry.parentId,
						branchName: entry.branchName,
						customType: entry.customType,
						sha256: entry.sha256,
						raw: entry.rawObj,
					},
				}),
			);
		}

		// 5. Record leaf checkpoints for multi-branch recovery
		const insertLeafCheckpointStmt = db.prepare(
			`INSERT OR REPLACE INTO session_leaf_checkpoints (
				session_id, leaf_id, summary_text, entry_rowid, created_at
			) VALUES (?, ?, ?, ?, ?)`,
		);
		for (const branch of parsed.branches) {
			if (!branch.headEntryId) continue;
			const rowId = entryRowIdByEntryId.get(branch.headEntryId) ?? parsed.entries.length;
			insertLeafCheckpointStmt.run(
				parsed.sessionId,
				branch.headEntryId,
				`Branch ${branch.branchName} leaf ${branch.headEntryId}`,
				rowId,
				lastEntryIso,
			);
		}

		// 6. Record ACP compression blocks in session_compaction_state and durable_checkpoints
		if (parsed.acpBlocks.length > 0) {
			const compactionStateJson = JSON.stringify({
				sessionId: parsed.sessionId,
				blockCount: parsed.acpBlocks.length,
				blocks: parsed.acpBlocks,
			});
			db.prepare(
				`INSERT OR REPLACE INTO session_compaction_state (
					session_id, state_json, updated_at
				) VALUES (?, ?, ?)`,
			).run(parsed.sessionId, compactionStateJson, lastEntryIso);

			db.prepare(
				`INSERT OR REPLACE INTO durable_checkpoints (
					session_id, checkpoint_id, leaf_entry_id, state_json, created_at
				) VALUES (?, ?, ?, ?, ?)`,
			).run(
				parsed.sessionId,
				`acp-${parsed.sessionId}`,
				parsed.activeLeafEntryId,
				compactionStateJson,
				updatedMs,
			);
		}

		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}

	return {
		sessionId: parsed.sessionId,
		durableKey,
		sourceFile: parsed.filePath,
		sourceSha256: parsed.fileSha256,
		cwd: parsed.cwd,
		parentSession: parsed.parentSession,
		entryCount: parsed.entries.length,
		acpBlockCount: parsed.acpBlockCount,
		branchCount: parsed.branches.length,
		leafEntryIds: parsed.leafEntryIds,
		activeLeafEntryId: parsed.activeLeafEntryId,
		customEntryCounts: parsed.customEntryCounts,
		attachmentCount: parsed.attachmentCount,
		entriesAggregateSha256: parsed.entriesAggregateSha256,
	};
}

function loadManifest(manifestOrPath: PreMigrationManifest | string): PreMigrationManifest {
	if (typeof manifestOrPath === "string") {
		return JSON.parse(readFileSync(manifestOrPath, "utf8")) as PreMigrationManifest;
	}
	return manifestOrPath;
}

/**
 * Verify that `durable-sessions.db` contains every session, entry, ACP compression block,
 * custom entry, and multi-branch leaf from the pre-migration manifest with exact entry
 * counts and SHA-256 hashes, and that all original `.jsonl` files remain untouched on disk.
 */
export async function verifyMigration(options: {
	dbPath: string;
	manifest: PreMigrationManifest | string;
}): Promise<MigrationVerificationResult> {
	const manifest = loadManifest(options.manifest);
	const dbPath = resolve(options.dbPath);
	const mismatches: string[] = [];
	let sessionsVerified = 0;
	let entriesVerified = 0;
	let acpBlocksVerified = 0;
	let branchesVerified = 0;
	let originalsUntouched = true;

	if (!existsSync(dbPath)) {
		return {
			ok: false,
			sessionsVerified: 0,
			entriesVerified: 0,
			acpBlocksVerified: 0,
			branchesVerified: 0,
			originalsUntouched: false,
			mismatches: [`Database file does not exist: ${dbPath}`],
		};
	}

	// 1. Verify original .jsonl files on disk are completely untouched
	for (const fileEntry of manifest.files) {
		if (!existsSync(fileEntry.filePath)) {
			originalsUntouched = false;
			mismatches.push(`Original JSONL file missing: ${fileEntry.filePath}`);
			continue;
		}
		const st = statSync(fileEntry.filePath);
		if (st.size !== fileEntry.sizeBytes) {
			originalsUntouched = false;
			mismatches.push(
				`Original JSONL file size changed for ${fileEntry.filePath}: expected ${fileEntry.sizeBytes}, got ${st.size}`,
			);
		}
		const currentSha = sha256FileSync(fileEntry.filePath);
		if (currentSha !== fileEntry.sha256) {
			originalsUntouched = false;
			mismatches.push(
				`Original JSONL file SHA-256 changed for ${fileEntry.filePath}: expected ${fileEntry.sha256}, got ${currentSha}`,
			);
		}
	}

	const db = new DatabaseSync(dbPath);
	try {
		for (const fileEntry of manifest.files) {
			const sessionRow = db
				.prepare("SELECT session_id, cwd, entry_count, leaf_entry_id FROM durable_sessions WHERE session_id = ?")
				.get(fileEntry.sessionId) as
				| { session_id: string; cwd: string; entry_count: number; leaf_entry_id: string | null }
				| undefined;

			if (!sessionRow) {
				mismatches.push(`Missing durable_sessions row for session ${fileEntry.sessionId}`);
				continue;
			}
			if (sessionRow.entry_count !== fileEntry.entryCount) {
				mismatches.push(
					`Session ${fileEntry.sessionId} entry_count mismatch: expected ${fileEntry.entryCount}, got ${sessionRow.entry_count}`,
				);
			}

			const metaRow = db
				.prepare("SELECT session_id, cwd FROM session_metadata WHERE session_id = ?")
				.get(fileEntry.sessionId) as { session_id: string; cwd: string } | undefined;
			if (!metaRow) {
				mismatches.push(`Missing session_metadata row for session ${fileEntry.sessionId}`);
			}

			const durableEntries = db
				.prepare(
					`SELECT seq, entry_id, parent_id, entry_type, custom_type, payload_json, content_hash
					 FROM durable_entries WHERE session_id = ? ORDER BY seq ASC`,
				)
				.all(fileEntry.sessionId) as Array<{
				seq: number;
				entry_id: string;
				parent_id: string | null;
				entry_type: string;
				custom_type: string | null;
				payload_json: string;
				content_hash: string;
			}>;

			const sessionEntries = db
				.prepare(
					`SELECT entry_id, parent_id, entry_type, data_json
					 FROM session_entries WHERE session_id = ? ORDER BY rowid ASC`,
				)
				.all(fileEntry.sessionId) as Array<{
				entry_id: string;
				parent_id: string | null;
				entry_type: string;
				data_json: string;
			}>;

			if (durableEntries.length !== fileEntry.entryCount) {
				mismatches.push(
					`Session ${fileEntry.sessionId} durable_entries row count mismatch: expected ${fileEntry.entryCount}, got ${durableEntries.length}`,
				);
				continue;
			}
			if (sessionEntries.length !== fileEntry.entryCount) {
				mismatches.push(
					`Session ${fileEntry.sessionId} session_entries row count mismatch: expected ${fileEntry.entryCount}, got ${sessionEntries.length}`,
				);
				continue;
			}

			for (let i = 0; i < fileEntry.entryHashes.length; i++) {
				const expected = fileEntry.entryHashes[i];
				const actual = durableEntries[i];
				const actualSessionEntry = sessionEntries[i];

				if (actual.entry_id !== expected.entryId) {
					mismatches.push(
						`Session ${fileEntry.sessionId} seq ${expected.seq} entry_id mismatch: expected ${expected.entryId}, got ${actual.entry_id}`,
					);
				}
				if (actual.parent_id !== expected.parentId) {
					mismatches.push(
						`Session ${fileEntry.sessionId} seq ${expected.seq} parent_id mismatch: expected ${String(expected.parentId)}, got ${String(actual.parent_id)}`,
					);
				}
				const recomputedHash = sha256Hex(actual.payload_json);
				if (actual.content_hash !== expected.sha256 || recomputedHash !== expected.sha256) {
					mismatches.push(
						`Session ${fileEntry.sessionId} entry ${expected.entryId} SHA-256 mismatch: expected ${expected.sha256}, got ${actual.content_hash} (recomputed ${recomputedHash})`,
					);
				}
				if (actualSessionEntry.data_json !== actual.payload_json) {
					mismatches.push(
						`Session ${fileEntry.sessionId} entry ${expected.entryId} session_entries.data_json differs from durable_entries.payload_json`,
					);
				}
				entriesVerified += 1;
			}

			// Verify branches
			const branchRows = db
				.prepare("SELECT branch_name, head_entry_id FROM durable_branches WHERE session_id = ?")
				.all(fileEntry.sessionId) as Array<{ branch_name: string; head_entry_id: string | null }>;
			if (branchRows.length !== fileEntry.branchCount) {
				mismatches.push(
					`Session ${fileEntry.sessionId} branch count mismatch: expected ${fileEntry.branchCount}, got ${branchRows.length}`,
				);
			} else {
				const headSet = new Set(branchRows.map((b) => b.head_entry_id).filter(Boolean));
				for (const leafId of fileEntry.leafEntryIds) {
					if (!headSet.has(leafId)) {
						mismatches.push(`Session ${fileEntry.sessionId} missing branch head for leaf ${leafId}`);
					}
				}
				branchesVerified += branchRows.length;
			}

			// Verify ACP compression blocks
			if (fileEntry.acpBlockCount > 0) {
				const compactionRow = db
					.prepare("SELECT state_json FROM session_compaction_state WHERE session_id = ?")
					.get(fileEntry.sessionId) as { state_json: string } | undefined;
				if (!compactionRow) {
					mismatches.push(
						`Session ${fileEntry.sessionId} expected ${fileEntry.acpBlockCount} ACP block(s) in session_compaction_state, found none`,
					);
				} else {
					const parsedState = JSON.parse(compactionRow.state_json) as {
						blockCount?: number;
						blocks?: unknown[];
					};
					if (parsedState.blockCount !== fileEntry.acpBlockCount) {
						mismatches.push(
							`Session ${fileEntry.sessionId} ACP block count mismatch: expected ${fileEntry.acpBlockCount}, got ${String(parsedState.blockCount)}`,
						);
					} else {
						acpBlocksVerified += fileEntry.acpBlockCount;
					}
				}
			}

			sessionsVerified += 1;
		}
	} finally {
		db.close();
	}

	return {
		ok: mismatches.length === 0 && originalsUntouched,
		sessionsVerified,
		entriesVerified,
		acpBlocksVerified,
		branchesVerified,
		originalsUntouched,
		mismatches,
	};
}

/**
 * Restore exact pre-cutover `.jsonl` session files and role `identity.json` files
 * from the pre-migration backup manifest, and remove the cutover `durable-sessions.db`.
 */
export async function rollbackToJsonl(options: {
	dbPath?: string;
	manifest: PreMigrationManifest | string;
	removeDb?: boolean;
}): Promise<RollbackResult> {
	const manifest = loadManifest(options.manifest);
	const targetDbPath = resolve(options.dbPath ?? manifest.dbPath);
	const removeDb = options.removeDb ?? true;
	const errors: string[] = [];
	let restoredFiles = 0;
	let restoredIdentities = 0;
	let verifiedSha256 = true;

	for (const fileEntry of manifest.files) {
		try {
			const needsRestore =
				!existsSync(fileEntry.filePath) || sha256FileSync(fileEntry.filePath) !== fileEntry.sha256;
			if (needsRestore) {
				if (!fileEntry.backupPath || !existsSync(fileEntry.backupPath)) {
					errors.push(`Backup missing for ${fileEntry.filePath}`);
					verifiedSha256 = false;
					continue;
				}
				mkdirSync(dirname(fileEntry.filePath), { recursive: true });
				copyFileSync(fileEntry.backupPath, fileEntry.filePath);
				restoredFiles += 1;
			}
			const afterSha = sha256FileSync(fileEntry.filePath);
			if (afterSha !== fileEntry.sha256) {
				verifiedSha256 = false;
				errors.push(
					`Restored file SHA-256 mismatch for ${fileEntry.filePath}: expected ${fileEntry.sha256}, got ${afterSha}`,
				);
			}
			if (fileEntry.sidecarPath && fileEntry.sidecarBackupPath && existsSync(fileEntry.sidecarBackupPath)) {
				const sidecarNeedsRestore =
					!existsSync(fileEntry.sidecarPath) ||
					sha256FileSync(fileEntry.sidecarPath) !== fileEntry.sidecarSha256;
				if (sidecarNeedsRestore) {
					copyFileSync(fileEntry.sidecarBackupPath, fileEntry.sidecarPath);
				}
			}
		} catch (err) {
			verifiedSha256 = false;
			errors.push(
				`Failed to restore ${fileEntry.filePath}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	for (const idSnap of manifest.identities) {
		try {
			writeFileAtomicSync(idSnap.identityPath, idSnap.rawContent);
			const afterSha = sha256FileSync(idSnap.identityPath);
			if (afterSha !== idSnap.sha256) {
				verifiedSha256 = false;
				errors.push(
					`Restored identity.json SHA-256 mismatch for ${idSnap.identityPath}: expected ${idSnap.sha256}, got ${afterSha}`,
				);
			} else {
				restoredIdentities += 1;
			}
		} catch (err) {
			verifiedSha256 = false;
			errors.push(
				`Failed to restore identity ${idSnap.identityPath}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	let removedDb = false;
	if (removeDb) {
		for (const suffix of ["", "-wal", "-shm"]) {
			const candidate = `${targetDbPath}${suffix}`;
			if (existsSync(candidate)) {
				rmSync(candidate, { force: true });
				if (suffix === "") removedDb = true;
			}
		}
	}

	return {
		ok: errors.length === 0 && verifiedSha256,
		restoredFiles,
		restoredIdentities,
		removedDb,
		verifiedSha256,
		errors,
	};
}

/**
 * End-to-end lossless `.jsonl` -> `durable-sessions.db` migration:
 *   1. Creates verified pre-migration snapshot/manifest (`createPreMigrationSnapshot`).
 *   2. Stream-imports `.jsonl` messages, ACP compression blocks, custom entries
 *      (`queue`, `identity`, `tldr`, `todo`, `model_change`, `thinking_level_change`),
 *      multi-branch trees, and attachments into `durable-sessions.db`.
 *   3. Optionally updates role `identity.json` `homeChat` bindings to `durable:<sessionId>`.
 *   4. Verifies exact entry counts and SHA-256 hashes (`verifyMigration`), automatically
 *      rolling back (`rollbackToJsonl`) if any check fails.
 */
export async function migrateJsonlToDurable(
	options: DurableJsonlMigrationOptions,
): Promise<DurableJsonlMigrationResult> {
	const manifest = await createPreMigrationSnapshot(options);
	const dbPath = manifest.dbPath;
	const autoRollback = options.autoRollbackOnFailure ?? true;
	const shouldUpdateIdentities = options.updateRoleIdentities ?? Boolean(options.agentDir);

	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new DatabaseSync(dbPath);
	const migratedSessions: MigratedSessionSummary[] = [];
	const sessionKeyByFilePath = new Map<string, string>();

	try {
		initializeDurableDatabaseSchema(db);

		for (const fileEntry of manifest.files) {
			const parsed = await streamParseJsonlSession(fileEntry.filePath);
			const summary = importParsedSessionIntoDb(db, parsed);
			migratedSessions.push(summary);
			sessionKeyByFilePath.set(resolve(fileEntry.filePath), summary.durableKey);
		}

		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	} catch (err) {
		db.close();
		if (autoRollback) {
			await rollbackToJsonl({ dbPath, manifest, removeDb: true });
		}
		throw err;
	}
	db.close();

	if (shouldUpdateIdentities && manifest.identities.length > 0) {
		for (const idSnap of manifest.identities) {
			if (!idSnap.originalHomeChat || isDurableSessionRef(idSnap.originalHomeChat)) continue;
			const resolvedHome = resolve(idSnap.originalHomeChat);
			const newDurableKey = sessionKeyByFilePath.get(resolvedHome);
			if (!newDurableKey) continue;

			const rawObj = JSON.parse(idSnap.rawContent) as Record<string, unknown>;
			const pastHomeChats = Array.isArray(rawObj.pastHomeChats)
				? rawObj.pastHomeChats.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
				: [];
			if (!pastHomeChats.includes(idSnap.originalHomeChat)) {
				pastHomeChats.push(idSnap.originalHomeChat);
			}
			const updatedObj: Record<string, unknown> = {
				...rawObj,
				homeChat: newDurableKey,
				pastHomeChats,
			};
			writeFileAtomicSync(idSnap.identityPath, `${JSON.stringify(updatedObj, null, 2)}\n`);
		}
	}

	const verification = await verifyMigration({ dbPath, manifest });
	let rolledBack = false;
	if (!verification.ok && autoRollback) {
		await rollbackToJsonl({ dbPath, manifest, removeDb: true });
		rolledBack = true;
	}

	return {
		ok: verification.ok,
		dbPath,
		manifest,
		migratedSessions,
		verification,
		rolledBack,
	};
}

export { randomUUID };
