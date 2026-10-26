/** Opt-in browser preservation boundary; never sends, clears a composer or replays work.
 * See docs/durable-pending-recovery-coordinator.md. Internal carriers are NOT prompts. */
import {
	createPendingSendStorage,
	indexedDBPendingRecovery,
	PENDING_RECOVERY_DB,
	PendingSendStorageError,
	type PendingRecoveryBackend,
	type PendingRecoveryOptions,
	type RecoveryKey,
	type RecoveryRecord,
} from "./pending-send-storage";
import { PENDING_STORAGE_KEY, type PendingSend } from "./pending-sends";
import type { PromptAttachment } from "./types";

export const PENDING_OWNER_KEY = "pi-web-pending-owner-v1";
export const PENDING_OWNER_ENVELOPE_PREFIX = "pi-web-pending-owner-envelope-v1:";
export const PENDING_OWNER_LOCK_PREFIX = "pi-web-pending-owner-lock-v1:";
const CARRIER = "pi-web-pending-work-v1";
/** Private producer metadata, never a discriminator inside arbitrary prompt text. */
const PROVENANCE = "__piWebPendingRecovery";
const PROVENANCE_FORMAT = "pi-web-pending-work";
type StoredPending = PendingSend & { [PROVENANCE]?: unknown };
const EXPORT_FORMAT = "pi-web-pending-recovery-export";
const LEGACY_IMPORTED_PREFIX = "pi-web-pending-legacy-imported-v1:";
export type RecoveryWork =
	| { kind: "prompt"; pending: PendingSend }
	| {
			kind: "command";
			id: string;
			conversationId: string;
			sessionId: string;
			createdAt: number;
			/** Exact original outbound string. Never wrap this in a prompt. */
			payload: string;
			attachments?: PromptAttachment[];
	  };
export interface PreparedIdentity {
	ownerId: string;
	kind: RecoveryWork["kind"];
	id: string;
	sessionId: string;
	contentDigest: string;
}
export interface PreparedRecoveryWork extends PreparedIdentity {
	/** Deeply frozen captured input, not the storage carrier. */
	work: RecoveryWork;
}
export interface RecoveryEntry {
	prepared: PreparedRecoveryWork;
	lifecycle: "unresolved" | "prepared" | "returned";
	/** This entry's payload/references verified; does not imply owner is ready or authorize replay. */
	complete: boolean;
	issues: RecoveryProblem[];
}
export interface RecoveryProblem {
	code: string;
	message: string;
	key?: RecoveryKey;
	payloadCommitted?: boolean;
}
export type RecoveryState = "closed" | "ready" | "incomplete" | "unavailable" | "conflict";
export interface RecoverySnapshot {
	state: RecoveryState;
	ownerId?: string;
	entries: RecoveryEntry[];
	issues: RecoveryProblem[];
}
export type PrepareRecoveryResult =
	| { ok: true; payloadCommitted: true; dispatch: "first-send" | "status-required"; prepared: PreparedRecoveryWork }
	| { ok: false; payloadCommitted: boolean; error: RecoveryProblem; work: RecoveryWork | null };
export interface RecoveryLease {
	release(): void;
}
/** Test port. Production must provide exclusive, lifetime ownership, NOT timeout leases. */
export interface RecoveryOwnership {
	acquire(ownerId: string): Promise<RecoveryLease | null>;
	active(): Promise<string[]>;
}
export interface RecoveryCoordinatorOptions {
	tabStorage?: Pick<Storage, "getItem" | "setItem"> | null;
	envelopes?: Storage | null;
	indexedDB?: IDBFactory | null;
	backend?: PendingRecoveryBackend;
	/** Test port paired with backend; production enumerates the existing #578 IDB store. */
	listOwners?: () => Promise<string[]>;
	ownership?: RecoveryOwnership;
	newOwnerId?: () => string;
	verifyReference?: PendingRecoveryOptions["verifyReference"];
	/** Must verify genuine server persistence, not volatile prompt_ack/text/revision. No default. */
	verifyPersisted?: (proof: unknown, prepared: PreparedRecoveryWork) => Promise<boolean>;
}
class CoordinatorError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly payloadCommitted = false,
	) {
		super(message);
	}
}
function problem(error: unknown): RecoveryProblem {
	if (error instanceof PendingSendStorageError || error instanceof CoordinatorError)
		return { code: error.code, message: error.message, ...(error.payloadCommitted ? { payloadCommitted: true } : {}) };
	return { code: "unavailable", message: "Recovery unavailable; keep the full draft and source records." };
}
function committed(error: unknown): boolean {
	return (error instanceof PendingSendStorageError || error instanceof CoordinatorError) && error.payloadCommitted;
}
function fail(code: string, message: string): never {
	throw new CoordinatorError(code, message);
}
function freeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
/** JSON is the outbound contract. Refuse silent loss (functions, binary objects, nonfinite values). */
function capture<T>(value: T): T {
	const seen = new Set<object>();
	function check(v: unknown): void {
		if (v === null || typeof v === "string" || typeof v === "boolean") return;
		if (typeof v === "number" && Number.isFinite(v)) return;
		if (!v || typeof v !== "object" || seen.has(v)) fail("invalid", "Recovery needs complete, acyclic JSON data.");
		if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype)
			fail("invalid", "Recovery needs plain JSON data; retain the original source.");
		seen.add(v);
		for (const child of Object.values(v)) {
			// Optional undefined object fields are absent on the original JSON wire too.
			if (child === undefined && !Array.isArray(v)) continue;
			check(child);
		}
		seen.delete(v);
	}
	check(value);
	return freeze(JSON.parse(JSON.stringify(value)) as T);
}
function frozenReferenceVerifier(verify: PendingRecoveryOptions["verifyReference"]) {
	return verify && ((a: PromptAttachment, p: PendingSend) => verify(capture(a), capture(p)));
}
async function sha(text: string): Promise<string> {
	const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
function target(work: RecoveryWork) {
	if (!work || (work.kind !== "prompt" && work.kind !== "command")) fail("invalid", "Unknown recovery work kind.");
	const p = work.kind === "prompt" ? work.pending : work;
	if (
		!p ||
		typeof p.id !== "string" ||
		!p.id ||
		typeof p.sessionId !== "string" ||
		!p.sessionId ||
		typeof p.conversationId !== "string" ||
		!Number.isFinite(p.createdAt) ||
		(work.kind === "command" && typeof work.payload !== "string")
	)
		fail("identity", "Original ID, stable session and complete work are required.");
	if (
		work.kind === "prompt" &&
		(typeof work.pending.text !== "string" ||
			typeof work.pending.queue !== "boolean" ||
			(work.pending.status !== "sending" && work.pending.status !== "failed") ||
			!Array.isArray(work.pending.sameTextBefore) ||
			!work.pending.sameTextBefore.every((x) => typeof x === "string") ||
			!Number.isFinite(work.pending.queueBase))
	)
		fail("invalid", "Incomplete original pending prompt.");
	return { id: p.id, sessionId: p.sessionId, conversationId: p.conversationId, createdAt: p.createdAt };
}
function identityKey(value: Pick<PreparedIdentity, "kind" | "sessionId" | "id">): string {
	return JSON.stringify([value.kind, value.sessionId, value.id]);
}
function literal(pending: PendingSend): StoredPending {
	return { ...pending, [PROVENANCE]: { format: PROVENANCE_FORMAT, version: 2, kind: "literal" } };
}
function carrier(work: RecoveryWork): StoredPending {
	const p = target(work);
	return {
		...p,
		id: `${work.kind}:${p.id}`,
		text: JSON.stringify({ format: CARRIER, work }),
		attachments: (work.kind === "prompt" ? work.pending.attachments : work.attachments) ?? [],
		queue: work.kind === "prompt" ? work.pending.queue : false,
		status: "failed", // Prevent #578 from changing the captured original through needsCheck.
		sameTextBefore: [],
		queueBase: 0,
		[PROVENANCE]: { format: PROVENANCE_FORMAT, version: 2, kind: "carrier" },
	};
}
function storedIdentity(p: PendingSend): string {
	return JSON.stringify([p.sessionId ? "session" : "conversation", p.sessionId || p.conversationId, p.id]);
}
/** #578's internal full-envelope mode preserves complete JSON. Retain both raw sources for
 * provenance comparison; never infer new carriers from user text/IDs or bypass native precedence. */
function createWorkStorage(options: {
	ownerId: string;
	backend: PendingRecoveryBackend;
	storage: Pick<Storage, "getItem" | "setItem">;
	verifyReference?: PendingRecoveryOptions["verifyReference"];
	/** Only the actual, unowned session legacy ingress is known to contain literal prompts. */
	legacySource?: string | null;
}) {
	let envelope: string | null = null;
	let records: RecoveryRecord[] = [];
	const store = createPendingSendStorage({
		...options,
		fullEnvelope: true,
		storage: {
			getItem(key) {
				envelope = options.storage.getItem(key);
				return envelope;
			},
			setItem: (key, value) => options.storage.setItem(key, value),
		},
		backend: {
			async read(owner) {
				records = await options.backend.read(owner);
				return records;
			},
			write: (values) => options.backend.write(values),
			release: (value) => options.backend.release(value),
		},
	});
	const api = {
		release: store.release,
		async restore() {
			envelope = null;
			records = [];
			const result = await store.restore();
			const native = new Set<string>();
			const legacy = new Map<string, StoredPending>();
			// Decode only #578's validated full result, never a raw source-map substitute.
			// Source keys only identify provenance comparisons; rejected/foreign native rows
			// cannot replace a readable envelope candidate. #578 owns integrity/precedence.
			for (const r of records) {
				if (
					r.state === "pending" &&
					r.ownerId === options.ownerId &&
					Array.isArray(r.key) &&
					r.key.length === 4 &&
					r.key[0] === options.ownerId
				)
					native.add(JSON.stringify(r.key.slice(1)));
			}
			try {
				const raw: unknown = JSON.parse(envelope ?? "null");
				if (Array.isArray(raw)) for (const p of raw) if (p && typeof p === "object") legacy.set(storedIdentity(p), p);
			} catch {
				/* Already reported by #578. */
			}
			return {
				...result,
				decode(p: PendingSend): { work: RecoveryWork; stored: PendingSend } {
					const key = storedIdentity(p);
					const full = native.has(key);
					const old = legacy.get(key);
					const raw: StoredPending = p;
					if (
						full &&
						old &&
						Object.hasOwn(old, PROVENANCE) &&
						JSON.stringify(raw[PROVENANCE]) !== JSON.stringify(old[PROVENANCE])
					)
						fail("corrupt", "Recovery provenance differs between native and envelope sources; retain both.");
					if (Object.hasOwn(raw, PROVENANCE)) {
						const tag = raw[PROVENANCE] as { format?: unknown; version?: unknown; kind?: unknown } | null;
						if (
							!tag ||
							typeof tag !== "object" ||
							tag.format !== PROVENANCE_FORMAT ||
							tag.version !== 2 ||
							(tag.kind !== "literal" && tag.kind !== "carrier") ||
							Object.keys(tag).length !== 3
						)
							fail("corrupt", "Unknown internal recovery provenance; retain the raw source for repair.");
						if (tag.kind === "literal") {
							const { [PROVENANCE]: _tag, ...pending } = raw;
							return { work: capture({ kind: "prompt", pending }), stored: raw };
						}
						try {
							const value = JSON.parse(raw.text) as { format?: string; work?: RecoveryWork };
							if (value?.format !== CARRIER) throw new Error("Unknown carrier format");
							const work = capture(value.work!);
							const expected = carrier(work);
							if (
								Object.keys(raw).length !== Object.keys(expected).length ||
								Object.keys(expected).some(
									(k) =>
										JSON.stringify(raw[k as keyof StoredPending]) !==
										JSON.stringify(expected[k as keyof StoredPending]),
								)
							)
								throw new Error("Carrier mismatch");
							return { work, stored: raw };
						} catch {
							fail("corrupt", "Recovery carrier/identity/attachment mismatch; retain the raw source.");
						}
					}
					const importedLiteral = !full && envelope === options.legacySource;
					// Old #579 wrote no producer tag. Its exact storage skeleton is ambiguous, not
					// evidence authorizing decode OR demotion. Actual legacy ingress remains opaque.
					if (
						!importedLiteral &&
						/^(prompt|command):/.test(p.id) &&
						p.status === "failed" &&
						p.sameTextBefore.length === 0 &&
						p.queueBase === 0
					)
						fail(
							"compatibility",
							"Untagged old recovery carrier is ambiguous; export raw sources and explicitly classify a copy before repair.",
						);
					return { work: capture({ kind: "prompt", pending: raw }), stored: importedLiteral ? literal(raw) : raw };
				},
			};
		},
	};
	return {
		...api,
		async save(list: readonly PendingSend[]) {
			const snapshot = capture(list);
			const prior = await api.restore();
			// Revalidate provenance before every write and resupply original complete records.
			// #578's full-envelope mode retains these unchanged while merging new work.
			const full = new Map(prior.pending.map((p) => [storedIdentity(p), prior.decode(p).stored]));
			for (const p of snapshot) {
				const key = storedIdentity(p);
				const old = full.get(key);
				if (old && JSON.stringify(old) !== JSON.stringify(p))
					fail("conflict", "Stored recovery identity has different content/provenance; retain both sources.");
				full.set(key, p);
			}
			await store.save([...full.values()]);
		},
	};
}
function storageValue<T>(supplied: T | null | undefined, getDefault: () => T): T {
	const value = supplied === undefined ? getDefault() : supplied;
	if (!value) fail("unavailable", "Browser recovery storage is disabled; keep the complete draft.");
	return value;
}
export function browserRecoveryOwnership(manager?: LockManager): RecoveryOwnership {
	const locks = () =>
		manager ?? globalThis.navigator?.locks ?? fail("unavailable", "Web Locks unavailable; recovery is read-only.");
	return {
		async acquire(ownerId) {
			return new Promise<RecoveryLease | null>((resolve, reject) => {
				void locks()
					.request(`${PENDING_OWNER_LOCK_PREFIX}${ownerId}`, { ifAvailable: true }, async (lock) => {
						if (!lock) {
							resolve(null);
							return;
						}
						await new Promise<void>((release) => resolve({ release }));
					})
					.catch(reject);
			});
		},
		async active() {
			const snapshot = await locks().query();
			return (snapshot.held ?? []).flatMap((lock) =>
				lock.name?.startsWith(PENDING_OWNER_LOCK_PREFIX) ? [lock.name.slice(PENDING_OWNER_LOCK_PREFIX.length)] : [],
			);
		},
	};
}
/** Read-only enumeration of #578's existing store, not a second database/engine. */
async function nativeOwners(factory?: IDBFactory | null): Promise<string[]> {
	const idb = storageValue(factory, () => globalThis.indexedDB);
	// Open through #578 first, so schema creation/version semantics have one owner.
	await indexedDBPendingRecovery(idb).read("__catalog_schema_probe__");
	return new Promise((resolve, reject) => {
		const request = idb.open(PENDING_RECOVERY_DB, 1);
		request.onerror = () => reject(request.error);
		let refused = false;
		request.onblocked = () => {
			refused = true;
			reject(new Error("Recovery catalog blocked"));
		};
		request.onsuccess = () => {
			const db = request.result;
			if (refused) {
				db.close();
				return;
			}
			db.onversionchange = () => db.close();
			const tx = db.transaction("sends", "readonly");
			const read = tx.objectStore("sends").getAllKeys();
			let owners: string[] = [];
			read.onsuccess = () => {
				try {
					owners = [
						...new Set(
							read.result.map((key) => {
								if (!Array.isArray(key) || typeof key[0] !== "string" || !key[0])
									fail("corrupt", "Recovery catalog contains an unreadable owner key.");
								return key[0];
							}),
						),
					];
				} catch (error) {
					reject(error);
					tx.abort();
				}
			};
			tx.oncomplete = () => {
				db.close();
				resolve(owners);
			};
			tx.onabort = () => {
				db.close();
				reject(tx.error);
			};
		};
	});
}
export async function catalogPendingRecovery(options: RecoveryCoordinatorOptions = {}) {
	try {
		const storage = storageValue(options.envelopes, () => globalThis.localStorage);
		const ids = new Set(await (options.listOwners?.() ?? nativeOwners(options.indexedDB)));
		for (let i = 0; i < storage.length; i++) {
			const name = storage.key(i);
			if (name?.startsWith(PENDING_OWNER_ENVELOPE_PREFIX)) ids.add(name.slice(PENDING_OWNER_ENVELOPE_PREFIX.length));
		}
		const active = await (options.ownership ?? browserRecoveryOwnership()).active();
		return {
			complete: true,
			owners: [...ids].sort().map((ownerId) => ({ ownerId, active: active.includes(ownerId) })),
			issues: [] as RecoveryProblem[],
		};
	} catch (error) {
		return { complete: false, owners: [], issues: [problem(error)] };
	}
}
interface RecoveryArtifactBody {
	format: typeof EXPORT_FORMAT;
	version: 1;
	ownerId: string;
	records: RecoveryRecord[];
	envelope: string | null;
	/** Distinct unrecognized legacy source retained raw; it makes automatic import incomplete. */
	legacyEnvelope?: string | null;
}
export interface PendingRecoveryArtifact extends RecoveryArtifactBody {
	checksum: string;
}
/** Independent integrity/identity reader; no current app UI, owner mutation or outbound traffic. */
export async function readPendingRecoveryArtifact(
	text: string,
	verifyReference?: PendingRecoveryOptions["verifyReference"],
) {
	const value = JSON.parse(text) as PendingRecoveryArtifact;
	if (
		!value ||
		value.format !== EXPORT_FORMAT ||
		value.version !== 1 ||
		typeof value.ownerId !== "string" ||
		!value.ownerId ||
		!Array.isArray(value.records) ||
		(value.envelope !== null && typeof value.envelope !== "string") ||
		(value.legacyEnvelope !== undefined && value.legacyEnvelope !== null && typeof value.legacyEnvelope !== "string")
	)
		fail("corrupt", "Invalid recovery artifact header.");
	const body: RecoveryArtifactBody = {
		format: value.format,
		version: 1,
		ownerId: value.ownerId,
		records: value.records,
		envelope: value.envelope,
		...(value.legacyEnvelope !== undefined ? { legacyEnvelope: value.legacyEnvelope } : {}),
	};
	if ((await sha(JSON.stringify(body))) !== value.checksum) fail("corrupt", "Recovery artifact checksum mismatch.");
	const keys = new Set<string>();
	for (const r of value.records) {
		const key = JSON.stringify(r.key);
		if (r.ownerId !== value.ownerId || r.key?.[0] !== value.ownerId || keys.has(key))
			fail("identity", "Foreign or duplicated recovery artifact owner/key.");
		keys.add(key);
	}
	const backend: PendingRecoveryBackend = {
		read: async () => value.records,
		write: async () => fail("invalid", "Read only"),
		release: async () => fail("invalid", "Read only"),
	};
	const result = await createWorkStorage({
		ownerId: value.ownerId,
		backend,
		verifyReference: frozenReferenceVerifier(verifyReference),
		storage: { getItem: () => value.envelope, setItem: () => fail("invalid", "Read only") },
	}).restore();
	const work: RecoveryWork[] = [];
	const issues: RecoveryProblem[] = [...result.issues];
	if (value.legacyEnvelope !== undefined && value.legacyEnvelope !== null)
		issues.push({
			code: "conflict",
			message:
				"Distinct unrecognized legacy source retained in legacyEnvelope; preserve both for repair, not automatic import.",
		});
	const identities = new Set<string>();
	for (const p of [...result.pending, ...result.blocked]) {
		try {
			const { work: w } = result.decode(p);
			const identity = identityKey({ kind: w.kind, ...target(w) });
			if (identities.has(identity)) fail("conflict", "Artifact contains duplicate original work identities.");
			identities.add(identity);
			work.push(w);
		} catch (error) {
			issues.push(problem(error));
		}
	}
	return { artifact: capture(value), work, complete: result.complete && issues.length === 0, issues };
}

export function createPendingRecoveryCoordinator(options: RecoveryCoordinatorOptions = {}) {
	const ownership = options.ownership ?? browserRecoveryOwnership();
	const backend = options.backend ?? indexedDBPendingRecovery(options.indexedDB);
	let state: RecoveryState = "closed";
	let ownerId: string | undefined;
	let lease: RecoveryLease | null = null;
	let issues: RecoveryProblem[] = [];
	let entries = new Map<string, RecoveryEntry & { stored: PendingSend }>();
	let store: ReturnType<typeof createWorkStorage> | undefined;
	let tail: Promise<unknown> = Promise.resolve();
	let closing = false;
	let starting: Promise<RecoverySnapshot> | undefined;
	function serial<T>(run: () => Promise<T>): Promise<T> {
		const next = tail.then(run);
		tail = next.catch(() => undefined);
		return next;
	}
	function snapshot(): RecoverySnapshot {
		return capture({
			state,
			...(ownerId ? { ownerId } : {}),
			entries: [...entries.values()].map(({ prepared, lifecycle, complete, issues }) => ({
				prepared,
				lifecycle,
				complete,
				issues,
			})),
			issues,
		});
	}
	function requireLease() {
		if (!lease || !ownerId || closing) fail("ownership", "No exclusive recovery owner; do not send, clear or mutate.");
		return ownerId;
	}
	function envelopeStorage() {
		return storageValue(options.envelopes, () => globalThis.localStorage);
	}
	async function prepared(work: RecoveryWork): Promise<PreparedRecoveryWork> {
		const p = target(work);
		return freeze({
			ownerId: ownerId!,
			kind: work.kind,
			id: p.id,
			sessionId: p.sessionId,
			contentDigest: await sha(JSON.stringify(work)),
			work,
		});
	}
	async function restoreInternal() {
		requireLease();
		if (!store) fail("incomplete", "Setup sources are ambiguous or unavailable; export them before bounded repair.");
		const result = await store.restore();
		issues = [...result.issues];
		const next = new Map<string, RecoveryEntry & { stored: PendingSend }>();
		for (const p of [...result.pending, ...result.blocked]) {
			try {
				const { work, stored } = result.decode(p);
				const item = await prepared(work);
				const key = identityKey(item);
				if (next.has(key)) fail("conflict", "Duplicate original work identity; retain all raw sources.");
				const entryIssues = result.issues.filter(
					(i) =>
						i.key &&
						JSON.stringify(i.key) ===
							JSON.stringify([
								ownerId,
								p.sessionId ? "session" : "conversation",
								p.sessionId || p.conversationId,
								p.id,
							]),
				);
				next.set(key, {
					prepared: item,
					lifecycle: "unresolved",
					stored,
					complete: !result.blocked.includes(p) && entryIssues.length === 0,
					issues: entryIssues,
				});
			} catch (error) {
				issues.push(problem(error));
			}
		}
		entries = next;
		state = result.complete && issues.length === 0 ? "ready" : "incomplete";
		return snapshot();
	}
	function match(identity: PreparedIdentity) {
		requireLease();
		if (!store || state === "conflict" || state === "unavailable")
			fail("incomplete", "Setup failed; only source inspection/export is available.");
		const entry = entries.get(identityKey(identity));
		if (!entry || identity.ownerId !== ownerId || identity.contentDigest !== entry.prepared.contentDigest)
			fail("identity", "Recovery action does not match the original owner/session/ID/content.");
		return entry;
	}
	const api = {
		start(request: { recoverOwnerId?: string } = {}): Promise<RecoverySnapshot> {
			const recoveryOwner = request.recoverOwnerId;
			if (starting) return starting;
			starting = serial(async () => {
				try {
					if (lease || closing) fail("ownership", "Recovery coordinator already started or closing.");
					const tab = storageValue(options.tabStorage, () => globalThis.sessionStorage);
					const prior = tab.getItem(PENDING_OWNER_KEY);
					if (recoveryOwner !== undefined && (!recoveryOwner || (prior && prior !== recoveryOwner)))
						fail("conflict", "Use an empty recovery tab; do not strand another tab owner.");
					ownerId = recoveryOwner ?? prior ?? options.newOwnerId?.() ?? `pr-${globalThis.crypto.randomUUID()}`;
					if (typeof ownerId !== "string" || !ownerId) fail("identity", "Invalid recovery owner.");
					lease = await ownership.acquire(ownerId);
					if (!lease)
						fail(
							"conflict",
							"This recovery owner is active in another tab. Keep both sources; use the original or explicitly recover after it closes.",
						);
					const envelopes = envelopeStorage();
					const name = `${PENDING_OWNER_ENVELOPE_PREFIX}${ownerId}`;
					const legacy = tab.getItem(PENDING_STORAGE_KEY);
					const current = envelopes.getItem(name);
					if (recoveryOwner && !prior && legacy)
						fail("conflict", "Recovery tab has an unowned legacy draft; preserve it before orphan recovery.");
					const legacyRecognized =
						legacy !== null && envelopes.getItem(`${LEGACY_IMPORTED_PREFIX}${ownerId}`) === (await sha(legacy));
					if (current !== null && legacy !== null && current !== legacy && !legacyRecognized)
						fail("conflict", "Persistent and legacy recovery envelopes differ; export both before repair.");
					// Validate all source/owner ambiguity before changing a token or envelope.
					// Persist before payload commit so reload reuses it; clones need the same exclusive lock.
					if (prior !== ownerId) tab.setItem(PENDING_OWNER_KEY, ownerId);
					if (current === null && legacy !== null) envelopes.setItem(name, legacy);
					store = createWorkStorage({
						ownerId,
						backend,
						legacySource: legacyRecognized ? null : legacy,
						verifyReference: frozenReferenceVerifier(options.verifyReference),
						storage: {
							getItem: () => envelopes.getItem(name),
							setItem: (_key, value) => envelopes.setItem(name, value),
						},
					});
					await restoreInternal();
					if (state === "ready" && legacy !== null && !legacyRecognized) {
						// Only an unimported legacy source needs a startup commit. Ordinary restore is read-only.
						await store.save([...entries.values()].map((entry) => entry.stored));
						envelopes.setItem(`${LEGACY_IMPORTED_PREFIX}${ownerId}`, await sha(legacy));
						await restoreInternal();
					}
				} catch (error) {
					issues = [problem(error)];
					state = issues[0].code === "conflict" ? "conflict" : "unavailable";
					// If acquired, retain the lease for consistent raw export only. Failed setup cannot mutate.
					// A collision never acquired it. close()/document destruction releases it; never delete sources.
				}
				return snapshot();
			});
			return starting;
		},
		restore: () =>
			serial(async () => {
				try {
					return await restoreInternal();
				} catch (error) {
					issues = [problem(error)];
					state = "unavailable";
					return snapshot();
				}
			}),
		prepare(work: RecoveryWork): Promise<PrepareRecoveryResult> {
			let captured: RecoveryWork;
			try {
				captured = capture(work);
				target(captured);
			} catch (error) {
				return Promise.resolve({ ok: false, payloadCommitted: false, error: problem(error), work: null });
			}
			return serial(async (): Promise<PrepareRecoveryResult> => {
				try {
					requireLease();
					if (state !== "ready") fail("incomplete", "Restore all recovery sources before preparing new work.");
					const item = await prepared(captured);
					const existing = entries.get(identityKey(item));
					if (existing && existing.prepared.contentDigest !== item.contentDigest)
						fail("conflict", "Same original identity has different work; keep both source drafts.");
					const stored = existing?.stored ?? carrier(captured);
					await store!.save([stored]);
					entries.set(identityKey(item), { prepared: item, stored, lifecycle: "prepared", complete: true, issues: [] });
					return {
						ok: true,
						payloadCommitted: true,
						dispatch: existing ? "status-required" : "first-send",
						prepared: item,
					};
				} catch (error) {
					if (committed(error)) {
						state = "incomplete";
						issues = [problem(error)];
					}
					return { ok: false, payloadCommitted: committed(error), error: problem(error), work: captured };
				}
			});
		},
		observe(
			event:
				| { kind: "persisted"; identity: PreparedIdentity; proof: unknown }
				| { kind: "volatile" | "unknown" | "negative" | "text-match" },
		): Promise<{ released: boolean; error?: RecoveryProblem }> {
			if (event.kind !== "persisted") return Promise.resolve({ released: false });
			let input: typeof event;
			try {
				input = capture(event);
			} catch (error) {
				return Promise.resolve({ released: false, error: problem(error) });
			}
			return serial(async () => {
				try {
					const entry = match(input.identity);
					if (!options.verifyPersisted || !(await options.verifyPersisted(input.proof, entry.prepared)))
						return { released: false };
					await store!.release(entry.stored, "acknowledged");
					entries.delete(identityKey(input.identity));
					return { released: true };
				} catch (error) {
					return { released: false, error: problem(error) };
				}
			});
		},
		returnToComposer(identity: PreparedIdentity): Promise<RecoveryWork> {
			const captured = capture(identity);
			return serial(async () => {
				const entry = match(captured);
				entry.lifecycle = "returned";
				return entry.prepared.work;
			});
		},
		discard(request: {
			intent: "discard";
			identity: PreparedIdentity;
		}): Promise<{ released: boolean; error?: RecoveryProblem }> {
			let input: typeof request;
			try {
				input = capture(request);
			} catch (error) {
				return Promise.resolve({ released: false, error: problem(error) });
			}
			return serial(async () => {
				try {
					if (input.intent !== "discard") fail("identity", "Only explicit discard can remove unacknowledged work.");
					const entry = match(input.identity);
					await store!.release(entry.stored, "discarded");
					entries.delete(identityKey(input.identity));
					return { released: true };
				} catch (error) {
					return { released: false, error: problem(error) };
				}
			});
		},
		exportArtifact: () =>
			serial(async (): Promise<string> => {
				const owner = requireLease();
				const envelopes = envelopeStorage();
				const envelope = envelopes.getItem(`${PENDING_OWNER_ENVELOPE_PREFIX}${owner}`);
				const legacy = storageValue(options.tabStorage, () => globalThis.sessionStorage).getItem(PENDING_STORAGE_KEY);
				const legacyRecognized =
					legacy === null ||
					legacy === envelope ||
					envelopes.getItem(`${LEGACY_IMPORTED_PREFIX}${owner}`) === (await sha(legacy));
				const body: RecoveryArtifactBody = {
					format: EXPORT_FORMAT,
					version: 1,
					ownerId: owner,
					records: await backend.read(owner),
					envelope,
					legacyEnvelope: legacyRecognized ? null : legacy,
				};
				return JSON.stringify({ ...body, checksum: await sha(JSON.stringify(body)) });
			}),
		importArtifact(text: string): Promise<RecoverySnapshot> {
			return serial(async () => {
				requireLease();
				if (state !== "ready") fail("incomplete", "Restore/repair the existing recovery set before import.");
				const read = await readPendingRecoveryArtifact(text, options.verifyReference);
				if (!read.complete)
					fail("incomplete", "Artifact contains unresolved/corrupt sources; retain it without overwriting local data.");
				if (read.artifact.ownerId !== ownerId)
					fail("identity", "Artifact belongs to another owner; explicitly recover that owner in an empty tab.");
				const pending = await createWorkStorage({
					ownerId: ownerId!,
					backend: { read: async () => [...read.artifact.records], write: async () => {}, release: async () => {} },
					verifyReference: frozenReferenceVerifier(options.verifyReference),
					storage: { getItem: () => read.artifact.envelope, setItem: () => {} },
				}).restore();
				// Release markers in an artifact are history, never authority to delete local pending work.
				for (const record of read.artifact.records) {
					if (
						record.state === "released" &&
						[...entries.values()].some(
							(e) =>
								JSON.stringify([ownerId, "session", e.prepared.sessionId, e.stored.id]) === JSON.stringify(record.key),
						)
					)
						fail("conflict", "Artifact release marker cannot delete local unresolved work.");
				}
				for (const work of read.work) {
					const item = await prepared(work);
					const existing = entries.get(identityKey(item));
					if (existing && existing.prepared.contentDigest !== item.contentDigest)
						fail("conflict", "Artifact work conflicts with local original identity.");
				}
				try {
					await store!.save(pending.pending.map((p) => pending.decode(p).stored));
				} catch (error) {
					if (committed(error)) {
						state = "incomplete";
						issues = [problem(error)];
					}
					throw error;
				}
				return restoreInternal();
			});
		},
		close(): Promise<void> {
			closing = true;
			return serial(async () => {
				lease?.release();
				lease = null;
				state = "closed";
			});
		},
		snapshot,
	};
	return api;
}

/** Build once from an esbuild ESM bundle of THIS module; retain resulting HTML through rollback.
 * Blob imports are self-contained: the reader never imports the currently installed app bundle. */
export function createPendingRecoveryReaderHtml(bundledModule: string): string {
	if (!bundledModule) fail("invalid", "A self-contained coordinator ESM bundle is required.");
	const source = JSON.stringify(bundledModule).replace(/</g, "\\u003c");
	return `<!doctype html><meta charset="utf-8"><title>Pending work recovery v1</title>
<h1>Pending work recovery v1</h1><p>No send/replay. Use on the original origin. Export before rollback; keep artifacts private.</p>
<button id="catalog">Find retained owners</button><div id="owners"></div>
<input id="artifact" type="file" accept="application/json"><button id="inspect">Read artifact</button>
<button id="restore">Restore inspected artifact</button><button id="export">Export selected owner</button><pre id="output"></pre>
<script type="module">
const moduleUrl = URL.createObjectURL(new Blob([${source}], {type:'text/javascript'}));
const recovery = await import(moduleUrl); URL.revokeObjectURL(moduleUrl);
const output = document.getElementById('output'); let coordinator, inspected;
const show = value => { output.textContent = JSON.stringify(value, null, 2); };
const run = action => async () => { try { await action(); } catch (e) { show({error: e.message, code: e.code, payloadCommitted: e.payloadCommitted}); } };
async function select(ownerId) {
 if (coordinator) await coordinator.close();
 coordinator = recovery.createPendingRecoveryCoordinator();
 const snapshot = await coordinator.start({recoverOwnerId: ownerId}); show(snapshot); return snapshot;
}
document.getElementById('catalog').onclick = run(async () => {
 const catalog = await recovery.catalogPendingRecovery(); show(catalog);
 const owners = document.getElementById('owners'); owners.replaceChildren();
 for (const item of catalog.owners) { const button = document.createElement('button');
 button.textContent = item.ownerId + (item.active ? ' (active; cannot reclaim)' : ' — explicitly recover');
 button.onclick = run(() => select(item.ownerId)); owners.append(button); }
});
document.getElementById('inspect').onclick = run(async () => {
 const file = document.getElementById('artifact').files[0]; if (!file) throw Error('Choose an artifact first');
 inspected = await file.text(); show(await recovery.readPendingRecoveryArtifact(inspected));
});
document.getElementById('restore').onclick = run(async () => {
 if (!inspected) throw Error('Read an artifact first');
 const read = await recovery.readPendingRecoveryArtifact(inspected); if (!read.complete) throw Error('Incomplete artifact; keep source and repair references');
 const selected = await select(read.artifact.ownerId); if (selected.state !== 'ready') throw Error('Owner unavailable; no restore performed');
 show(await coordinator.importArtifact(inspected));
});
document.getElementById('export').onclick = run(async () => {
 if (!coordinator) throw Error('Explicitly select an owner first');
 const text = await coordinator.exportArtifact();
 const link = document.createElement('a'); const url = URL.createObjectURL(new Blob([text], {type:'application/json'}));
 link.href = url; link.download = 'pending-recovery-v1.json'; link.click(); URL.revokeObjectURL(url);
 show(await recovery.readPendingRecoveryArtifact(text));
});
</script>`;
}
