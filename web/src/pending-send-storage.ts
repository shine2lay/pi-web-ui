/** Complete, opt-in pending-send recovery. See docs/durable-pending-attachment-recovery.md.
 * No UI side effects: a caller must await save before sending or clearing its complete draft. */
import { MAX_PENDING_STORAGE_CHARS, PENDING_STORAGE_KEY, parsePending, type PendingSend } from "./pending-sends";
import type { PromptAttachment } from "./types";

export const PENDING_RECOVERY_DB = "pi-web-pending-recovery-v1";
const STORE = "sends";
const FORMAT = "pi-web-pending-recovery";
export type RecoveryKey = [ownerId: string, kind: "session" | "conversation", chatId: string, promptId: string];
type FailureCode =
	| "identity"
	| "unavailable"
	| "transaction"
	| "envelope"
	| "missing"
	| "corrupt"
	| "reference"
	| "conflict"
	| "released";
export class PendingSendStorageError extends Error {
	constructor(
		public readonly code: FailureCode,
		message: string,
		public readonly payloadCommitted = false,
		cause?: unknown,
	) {
		super(message, { cause });
		this.name = "PendingSendStorageError";
	}
}
export type RecoveryRecord = {
	key: RecoveryKey;
	ownerId: string;
	contentDigest: string;
} & (
	{ state: "pending"; payload: string; digest: string } | { state: "released"; reason: "acknowledged" | "discarded" }
);
/** Each write/release must be atomic and resolve only after commit, never after request success.
 * write must refuse released keys or a different contentDigest; release must check contentDigest. */
export interface PendingRecoveryBackend {
	read(ownerId: string): Promise<RecoveryRecord[]>;
	write(records: readonly RecoveryRecord[]): Promise<void>;
	release(record: RecoveryRecord & { state: "released" }): Promise<void>;
}
export interface PendingRecoveryOptions {
	/** Stable across reload, unique to this tab. Host must prevent sharing/cloning active owners. */
	ownerId: string;
	storage?: Pick<Storage, "getItem" | "setItem"> | null;
	indexedDB?: IDBFactory | null;
	backend?: PendingRecoveryBackend;
	/** Actually resolve external workspace/upload/page/conversation references in their session. */
	verifyReference?: (attachment: PromptAttachment, pending: PendingSend) => Promise<boolean>;
}
export interface PendingRecoveryIssue {
	code: FailureCode;
	message: string;
	key?: RecoveryKey;
}
export interface PendingRecoveryResult {
	pending: PendingSend[];
	/** Full records needing reference repair; never pass these to retry/send as if complete. */
	blocked: PendingSend[];
	issues: PendingRecoveryIssue[];
	complete: boolean;
}

function failure(error: unknown, code: FailureCode = "transaction"): PendingSendStorageError {
	return error instanceof PendingSendStorageError
		? error
		: new PendingSendStorageError(
				code,
				`Pending-send recovery ${code}; keep the complete draft and retry.`,
				false,
				error,
			);
}
function keyFor(ownerId: string, p: PendingSend): RecoveryKey {
	return [ownerId, p.sessionId ? "session" : "conversation", p.sessionId || p.conversationId, p.id];
}
function keyString(key: RecoveryKey): string {
	return JSON.stringify(key);
}
function validKey(key: unknown, ownerId: string): key is RecoveryKey {
	return (
		Array.isArray(key) &&
		key.length === 4 &&
		key[0] === ownerId &&
		(key[1] === "session" || key[1] === "conversation") &&
		typeof key[2] === "string" &&
		key[2].length > 0 &&
		typeof key[3] === "string" &&
		key[3].length > 0
	);
}
function validate(p: PendingSend): void {
	if (
		!p ||
		typeof p.id !== "string" ||
		!p.id ||
		typeof p.conversationId !== "string" ||
		(typeof p.sessionId !== "undefined" && (typeof p.sessionId !== "string" || !p.sessionId)) ||
		(!p.sessionId && !p.conversationId) ||
		typeof p.text !== "string" ||
		typeof p.queue !== "boolean" ||
		!Number.isFinite(p.createdAt) ||
		(p.status !== "sending" && p.status !== "failed") ||
		!Array.isArray(p.sameTextBefore) ||
		!p.sameTextBefore.every((x) => typeof x === "string") ||
		!Number.isFinite(p.queueBase)
	) {
		throw new PendingSendStorageError("corrupt", "Invalid pending-send identity or metadata; keep the source record.");
	}
	if (p.attachments !== undefined) {
		if (!Array.isArray(p.attachments)) throw new PendingSendStorageError("corrupt", "Invalid pending attachments.");
		for (const a of p.attachments) {
			if (
				!a ||
				typeof a.path !== "string" ||
				["imageData", "fileData", "imageUrl", "uploadPath", "name", "mimeType", "conversationId", "sessionPath"].some(
					(field) =>
						a[field as keyof PromptAttachment] !== undefined && typeof a[field as keyof PromptAttachment] !== "string",
				) ||
				(a.size !== undefined && (!Number.isFinite(a.size) || a.size < 0))
			) {
				throw new PendingSendStorageError("corrupt", "Invalid pending attachment; keep the source record.");
			}
		}
	}
}
async function digest(text: string): Promise<string> {
	const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(bytes), (x) => x.toString(16).padStart(2, "0")).join("");
}
function body(p: PendingSend): string {
	// Retry may change the baseline, status and renumbered conversation, never the original send.
	return JSON.stringify([p.id, p.sessionId || p.conversationId, p.text, p.attachments, p.queue, p.createdAt]);
}

/** Native adapter, also exported for isolated browser transaction/failure tests. */
export function indexedDBPendingRecovery(factory?: IDBFactory | null): PendingRecoveryBackend {
	async function open(): Promise<IDBDatabase> {
		try {
			const idb = factory === undefined ? globalThis.indexedDB : factory;
			if (!idb) throw new Error("IndexedDB unavailable");
			return await new Promise((resolve, reject) => {
				const request = idb.open(PENDING_RECOVERY_DB, 1);
				let refused = false;
				request.onupgradeneeded = () => {
					const store = request.result.createObjectStore(STORE, { keyPath: "key" });
					store.createIndex("ownerId", "ownerId");
				};
				request.onblocked = () => {
					refused = true;
					reject(new PendingSendStorageError("unavailable", "Recovery database is blocked; keep the complete draft."));
				};
				request.onerror = () => reject(failure(request.error, "unavailable"));
				request.onsuccess = () => {
					if (refused) request.result.close();
					else {
						request.result.onversionchange = () => request.result.close();
						resolve(request.result);
					}
				};
			});
		} catch (error) {
			throw failure(error, "unavailable");
		}
	}
	async function transaction<T>(
		mode: IDBTransactionMode,
		run: (store: IDBObjectStore, result: (value: T) => void, abort: (error: unknown) => void) => void,
	): Promise<T> {
		const db = await open();
		try {
			return await new Promise<T>((resolve, reject) => {
				const tx = db.transaction(STORE, mode, { durability: "strict" });
				let result: T;
				let error: unknown;
				tx.oncomplete = () => resolve(result);
				tx.onabort = () => reject(failure(error ?? tx.error));
				tx.onerror = () => {
					error ??= tx.error;
				};
				const abort = (cause: unknown) => {
					error = cause;
					tx.abort();
				};
				try {
					run(
						tx.objectStore(STORE),
						(value) => {
							result = value;
						},
						abort,
					);
				} catch (cause) {
					abort(cause);
				}
			});
		} catch (error) {
			throw failure(error);
		} finally {
			db.close();
		}
	}
	return {
		read: (ownerId) =>
			transaction("readonly", (store, result) => {
				const request = store.index("ownerId").getAll(ownerId);
				request.onsuccess = () => result(request.result as RecoveryRecord[]);
			}),
		write: (records) =>
			transaction<void>("readwrite", (store, result, abort) => {
				result(undefined);
				for (const record of records) {
					const request = store.get(record.key);
					request.onsuccess = () => {
						try {
							const old = request.result as RecoveryRecord | undefined;
							if (old?.state === "released")
								abort(new PendingSendStorageError("released", "This send was already acknowledged or discarded."));
							else if (old && old.contentDigest !== record.contentDigest)
								abort(
									new PendingSendStorageError(
										"conflict",
										"The same send identity has different content; keep both source drafts.",
									),
								);
							else store.put(record);
						} catch (error) {
							abort(error);
						}
					};
				}
			}),
		release: (record) =>
			transaction<void>("readwrite", (store, result, abort) => {
				result(undefined);
				const request = store.get(record.key);
				request.onsuccess = () => {
					try {
						const old = request.result as RecoveryRecord | undefined;
						if (old && old.contentDigest !== record.contentDigest)
							abort(new PendingSendStorageError("conflict", "Acknowledgement does not match the stored send content."));
						else store.put(record);
					} catch (error) {
						abort(error);
					}
				};
			}),
	};
}

export function createPendingSendStorage(options: PendingRecoveryOptions) {
	const { ownerId } = options;
	if (typeof ownerId !== "string" || !ownerId)
		throw new PendingSendStorageError("identity", "A stable tab recovery owner is required.");
	const backend = options.backend ?? indexedDBPendingRecovery(options.indexedDB);
	const storage = () => {
		const value = options.storage === undefined ? globalThis.sessionStorage : options.storage;
		if (!value) throw new Error("sessionStorage unavailable");
		return value;
	};
	let tail: Promise<unknown> = Promise.resolve();
	function serial<T>(run: () => Promise<T>): Promise<T> {
		const next = tail.then(run);
		tail = next.catch(() => undefined);
		return next;
	}
	async function verify(p: PendingSend): Promise<void> {
		for (const attachment of p.attachments ?? []) {
			if (attachment.imageData !== undefined || attachment.fileData !== undefined) continue;
			try {
				if (
					[attachment.path, attachment.uploadPath, attachment.imageUrl].some((x) => x?.startsWith("blob:")) ||
					!options.verifyReference ||
					!(await options.verifyReference(attachment, p))
				) {
					throw new PendingSendStorageError(
						"reference",
						"An attachment reference is unresolved; retain the complete source and repair it before retry.",
					);
				}
			} catch (error) {
				throw failure(error, "reference");
			}
		}
	}
	const api = {
		async save(list: readonly PendingSend[]): Promise<void> {
			// Snapshot before the first await; a later composer edit cannot change the committed send.
			const captured = JSON.stringify(list);
			const snapshot = JSON.parse(captured) as PendingSend[];
			return serial(async () => {
				for (const p of snapshot) validate(p);
				const supplied = new Set(snapshot.map((p) => keyString(keyFor(ownerId, p))));
				const prior = await api.readRecovery();
				const blocking = prior.issues.find(
					(i) =>
						i.code !== "envelope" &&
						!((i.code === "missing" || i.code === "corrupt") && i.key && supplied.has(keyString(i.key))),
				);
				if (blocking) throw new PendingSendStorageError(blocking.code, blocking.message);
				const merged = new Map(prior.pending.map((p) => [keyString(keyFor(ownerId, p)), p]));
				for (const p of snapshot) {
					const key = keyString(keyFor(ownerId, p));
					const old = merged.get(key);
					if (old && body(old) !== body(p))
						throw new PendingSendStorageError(
							"conflict",
							"The same send identity has different content; keep both source drafts.",
						);
					merged.set(key, p);
				}
				const complete = [...merged.values()];
				const full = JSON.stringify(complete);
				const records: RecoveryRecord[] = [];
				const seen = new Set<string>();
				if (supplied.size !== snapshot.length)
					throw new PendingSendStorageError("identity", "Duplicate pending-send identity.");
				for (const p of complete) {
					validate(p);
					await verify(p);
					const key = keyFor(ownerId, p);
					if (seen.has(keyString(key)))
						throw new PendingSendStorageError("identity", "Duplicate pending-send identity.");
					seen.add(keyString(key));
					const payload = JSON.stringify(p);
					records.push({
						key,
						ownerId,
						state: "pending",
						payload,
						digest: await digest(payload),
						contentDigest: await digest(body(p)),
					});
				}
				try {
					await backend.write(records);
				} catch (error) {
					throw failure(error);
				}
				try {
					if (prior.issues.some((i) => i.code === "envelope"))
						throw new Error("Previous recovery envelope could not be read; do not overwrite it");
					const envelope =
						full.length <= MAX_PENDING_STORAGE_CHARS
							? full
							: JSON.stringify({ format: FORMAT, version: 1, ownerId, keys: records.map((r) => r.key) });
					if (envelope.length > MAX_PENDING_STORAGE_CHARS)
						throw new Error("Recovery manifest exceeds the existing small-envelope boundary");
					storage().setItem(PENDING_STORAGE_KEY, envelope);
				} catch (error) {
					throw new PendingSendStorageError(
						"envelope",
						"Recovery payload committed, but tab envelope could not be saved; keep the complete draft and retry.",
						true,
						error,
					);
				}
			});
		},
		async readRecovery(): Promise<PendingRecoveryResult> {
			const result: PendingRecoveryResult = { pending: [], blocked: [], issues: [], complete: false };
			const issue = (error: unknown, key?: RecoveryKey) => {
				const e = failure(error, "corrupt");
				result.issues.push({ code: e.code, message: e.message, ...(key ? { key } : {}) });
			};
			let raw: unknown = null;
			try {
				const text = storage().getItem(PENDING_STORAGE_KEY);
				if (text) {
					try {
						raw = JSON.parse(text);
					} catch (error) {
						issue(failure(error, "corrupt"));
					}
				}
			} catch (error) {
				issue(failure(error, "envelope"));
			}
			const records = new Map<string, RecoveryRecord>();
			try {
				for (const record of await backend.read(ownerId)) {
					if (!validKey(record.key, ownerId) || record.ownerId !== ownerId) {
						issue(new PendingSendStorageError("identity", "Recovery owner/key mismatch."));
						continue;
					}
					records.set(keyString(record.key), record);
				}
			} catch (error) {
				issue(failure(error));
			}
			const candidates = new Map<string, PendingSend>();
			if (Array.isArray(raw)) {
				const legacy = parsePending(JSON.stringify(raw));
				if (legacy.length !== raw.filter((p) => p?.confirmedRev === undefined).length)
					issue(
						new PendingSendStorageError("corrupt", "Some legacy pending records could not be read; source retained."),
					);
				for (const p of legacy) {
					try {
						validate(p);
						candidates.set(keyString(keyFor(ownerId, p)), p);
					} catch (error) {
						issue(error);
					}
				}
			} else if (raw !== null) {
				const manifest = raw as { format?: string; version?: number; ownerId?: string; keys?: unknown[] };
				if (
					manifest.format !== FORMAT ||
					manifest.version !== 1 ||
					manifest.ownerId !== ownerId ||
					!Array.isArray(manifest.keys)
				) {
					issue(new PendingSendStorageError("identity", "Unreadable or foreign recovery envelope; source retained."));
				} else {
					for (const key of manifest.keys) {
						if (!validKey(key, ownerId))
							issue(new PendingSendStorageError("identity", "Invalid or foreign recovery reference."));
						else if (!records.has(keyString(key)))
							issue(
								new PendingSendStorageError(
									"missing",
									"A committed recovery payload is missing; source reference retained.",
								),
								key,
							);
					}
				}
			}
			for (const [key, record] of records) {
				// Never fall back to a stale, possibly stripped legacy copy of a corrupt native record.
				candidates.delete(key);
				if (record.state === "released") {
					if (
						!/^[a-f0-9]{64}$/.test(record.contentDigest) ||
						(record.reason !== "acknowledged" && record.reason !== "discarded")
					)
						issue(new Error("Invalid recovery release marker"), record.key);
					continue;
				}
				try {
					if (
						record.state !== "pending" ||
						typeof record.payload !== "string" ||
						(await digest(record.payload)) !== record.digest
					)
						throw new Error("Recovery payload integrity mismatch");
					const p = JSON.parse(record.payload) as PendingSend;
					validate(p);
					if (keyString(keyFor(ownerId, p)) !== key || (await digest(body(p))) !== record.contentDigest)
						throw new Error("Recovery payload identity/content mismatch");
					candidates.set(key, p);
				} catch (error) {
					issue(error, record.key);
				}
			}
			for (const p of candidates.values()) {
				const restored = p.status === "sending" ? { ...p, needsCheck: true } : p;
				try {
					await verify(restored);
					result.pending.push(restored);
				} catch (error) {
					result.blocked.push(restored);
					issue(error, keyFor(ownerId, p));
				}
			}
			result.pending.sort((a, b) => a.createdAt - b.createdAt);
			result.blocked.sort((a, b) => a.createdAt - b.createdAt);
			result.complete = result.issues.length === 0;
			return result;
		},
		async release(pending: PendingSend, reason: "acknowledged" | "discarded"): Promise<void> {
			const snapshot = JSON.parse(JSON.stringify(pending)) as PendingSend;
			return serial(async () => {
				validate(snapshot);
				if (reason !== "acknowledged" && reason !== "discarded")
					throw new PendingSendStorageError("identity", "An explicit acknowledgement or discard is required.");
				try {
					await backend.release({
						key: keyFor(ownerId, snapshot),
						ownerId,
						state: "released",
						reason,
						contentDigest: await digest(body(snapshot)),
					});
				} catch (error) {
					throw failure(error);
				}
			});
		},
	};
	return { save: api.save, restore: () => serial(() => api.readRecovery()), release: api.release };
}
