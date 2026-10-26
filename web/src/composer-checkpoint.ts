import type { ComposerPayload } from "./composer-bridge";
import type { DraftAttachment } from "./composer-draft";

/** No browser globals, implicit storage, host hooks, reference reads or SDK runtime. */
export const COMPOSER_CHECKPOINT_PREFIX = "pi-web-ui:composer-checkpoint:";
const RECORD_PREFIX = `${COMPOSER_CHECKPOINT_PREFIX}record:v1:`;
const RETIREMENT_PREFIX = `${COMPOSER_CHECKPOINT_PREFIX}retirement:v1:`;

export interface ComposerCheckpointBinding {
	ownerId: string;
	composerId: string;
	conversationId: string;
	sessionId: string;
	/** Genuine host revision before the injection, not a timestamp/global target. */
	revision: number;
}

export interface ComposerCheckpointDraft {
	text: string;
	attachments: DraftAttachment[];
}

export interface ComposerCheckpoint {
	kind: "pi-web-ui/composer-checkpoint";
	version: 1;
	purpose: "composer-injection";
	recordId: string;
	createdAt: number;
	binding: ComposerCheckpointBinding;
	nextRevision: number;
	/** Keep all three: a lossy host merge must not erase the original inputs. */
	source: ComposerCheckpointDraft;
	incoming: ComposerPayload;
	effective: ComposerCheckpointDraft;
}

type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type FrozenComposerCheckpoint = DeepReadonly<ComposerCheckpoint>;
export type FrozenComposerBinding = DeepReadonly<ComposerCheckpointBinding>;

/** Deliberately no removeItem/clear. Native localStorage structurally implements this. */
export interface ComposerCheckpointStorage {
	readonly length: number;
	key(index: number): string | null;
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export type ComposerCheckpointFailureCode =
	| "disabled"
	| "invalid-record"
	| "unavailable"
	| "not-owner"
	| "collision"
	| "retired"
	| "write-failed"
	| "readback-failed"
	| "missing"
	| "wrong-binding"
	| "stale-retirement";

export type ComposerCheckpointResult =
	| { ok: true; payloadCommitted: true; record: FrozenComposerCheckpoint }
	| {
			ok: false;
			code: ComposerCheckpointFailureCode;
			/** true = complete value observed; unknown includes partial/uncertain writes. Neither permits a sink. */
			payloadCommitted: boolean | "unknown";
			detail: string;
	  };

type DecodeResult =
	{ ok: true; record: FrozenComposerCheckpoint } | { ok: false; code: "invalid-record"; detail: string };

export interface ComposerCheckpointRetirement {
	kind: "pi-web-ui/composer-checkpoint-retirement";
	version: 1;
	purpose: "composer-injection";
	recordKey: string;
	/** Exact full original JSON, retained in addition to the immutable original. */
	original: string;
}

export interface ComposerCheckpointInspectionEntry {
	key: string;
	raw: string | null;
	status: "active" | "retired" | "retirement" | "unknown" | "corrupt";
	record?: FrozenComposerCheckpoint;
	retirement?: Readonly<ComposerCheckpointRetirement>;
	detail?: string;
}

export interface ComposerCheckpointInspection {
	ok: boolean;
	entries: readonly ComposerCheckpointInspectionEntry[];
	errors: readonly string[];
}

class InvalidRecord extends Error {}
function invalid(where: string): never {
	throw new InvalidRecord(where);
}

/** Read data descriptors only: never invoke accessors or toJSON, never discard unknown fields. */
function fields(
	value: unknown,
	required: readonly string[],
	optional: readonly string[],
	where: string,
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${where}: expected plain object`);
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) invalid(`${where}: expected plain object`);
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const allowed = new Set([...required, ...optional]);
	for (const key of Reflect.ownKeys(descriptors)) {
		if (typeof key !== "string" || !allowed.has(key)) invalid(`${where}: unknown field ${String(key)}`);
		const descriptor = descriptors[key];
		if (!("value" in descriptor) || !descriptor.enumerable) invalid(`${where}.${key}: not enumerable data`);
	}
	const out: Record<string, unknown> = {};
	for (const key of [...required, ...optional]) {
		const descriptor = descriptors[key];
		if (!descriptor) {
			if (required.includes(key)) invalid(`${where}.${key}: missing`);
			continue;
		}
		out[key] = descriptor.value;
	}
	return out;
}

function text(value: unknown, where: string, nonempty = false): string {
	if (typeof value !== "string" || (nonempty && value.length === 0))
		invalid(`${where}: expected ${nonempty ? "nonempty " : ""}string`);
	return value;
}

function integer(value: unknown, where: string, minimum = 0): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || Object.is(value, -0)) {
		invalid(`${where}: expected safe integer >= ${minimum}`);
	}
	return value;
}

function list<T>(value: unknown, parse: (item: unknown, where: string) => T, where: string): T[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
		invalid(`${where}: expected plain array`);
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (Reflect.ownKeys(descriptors).length !== value.length + 1) invalid(`${where}: sparse/extended array`);
	const out: T[] = [];
	for (let i = 0; i < value.length; i++) {
		const descriptor = descriptors[String(i)];
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
			invalid(`${where}[${i}]: not enumerable data`);
		out.push(parse(descriptor.value, `${where}[${i}]`));
	}
	return out;
}

function binding(value: unknown): ComposerCheckpointBinding {
	const f = fields(value, ["ownerId", "composerId", "conversationId", "sessionId", "revision"], [], "binding");
	return {
		ownerId: text(f.ownerId, "binding.ownerId", true),
		composerId: text(f.composerId, "binding.composerId", true),
		conversationId: text(f.conversationId, "binding.conversationId", true),
		sessionId: text(f.sessionId, "binding.sessionId", true),
		revision: integer(f.revision, "binding.revision"),
	};
}

/** Raw complete base64 only; no fetch/decoding/image probing or discretionary size limit. */
function inlineData(value: unknown, where: string, allowEmpty: boolean): string {
	const data = text(value, where, !allowEmpty);
	if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
		invalid(`${where}: incomplete/non-base64 inline data`);
	// Reject nonzero unused bits, so a complete byte sequence has one representation.
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	if (data.endsWith("==") && (alphabet.indexOf(data[data.length - 3]) & 15) !== 0)
		invalid(`${where}: noncanonical base64`);
	if (!data.endsWith("==") && data.endsWith("=") && (alphabet.indexOf(data[data.length - 2]) & 3) !== 0)
		invalid(`${where}: noncanonical base64`);
	return data;
}

function attachment(value: unknown, where: string): DraftAttachment {
	const f = fields(
		value,
		["path", "name"],
		["mode", "conversationId", "sessionPath", "isDir", "lines", "imageData", "mimeType", "fileData", "size", "key"],
		where,
	);
	const out: DraftAttachment = { path: text(f.path, `${where}.path`), name: text(f.name, `${where}.name`) };
	if ("mode" in f) {
		if (!["inline", "reference", "lines", "page", "conversation"].includes(text(f.mode, `${where}.mode`)))
			invalid(`${where}.mode: unsupported`);
		out.mode = f.mode as DraftAttachment["mode"];
	}
	for (const key of ["conversationId", "sessionPath", "mimeType", "key"] as const) {
		if (key in f) out[key] = text(f[key], `${where}.${key}`);
	}
	if ("isDir" in f) {
		if (typeof f.isDir !== "boolean") invalid(`${where}.isDir: expected boolean`);
		out.isDir = f.isDir;
	}
	if ("lines" in f) {
		const range = fields(f.lines, ["start", "end"], [], `${where}.lines`);
		const start = integer(range.start, `${where}.lines.start`, 1);
		const end = integer(range.end, `${where}.lines.end`, start);
		out.lines = { start, end };
	}
	if ("imageData" in f) out.imageData = inlineData(f.imageData, `${where}.imageData`, false);
	if ("fileData" in f) out.fileData = inlineData(f.fileData, `${where}.fileData`, true);
	if ("size" in f) out.size = integer(f.size, `${where}.size`);
	if (out.mode === "conversation" && !out.conversationId && !out.sessionPath)
		invalid(`${where}: unresolved conversation reference`);
	if (out.mode === "lines" && !out.lines) invalid(`${where}: missing line range`);
	if (!out.path && out.mode !== "conversation" && out.imageData === undefined && out.fileData === undefined)
		invalid(`${where}: unresolved transient attachment`);
	if (out.mode === "page" && !out.path) invalid(`${where}: missing opaque page reference`);
	return out;
}

function draft(value: unknown, where: string): ComposerCheckpointDraft {
	const f = fields(value, ["text", "attachments"], [], where);
	return { text: text(f.text, `${where}.text`), attachments: list(f.attachments, attachment, `${where}.attachments`) };
}

function freeze<T>(value: T): DeepReadonly<T> {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value as DeepReadonly<T>;
}

/** Defensive complete snapshot; success never aliases caller input. */
export function snapshotComposerCheckpoint(value: unknown): DecodeResult {
	try {
		const f = fields(
			value,
			[
				"kind",
				"version",
				"purpose",
				"recordId",
				"createdAt",
				"binding",
				"nextRevision",
				"source",
				"incoming",
				"effective",
			],
			[],
			"record",
		);
		if (f.kind !== "pi-web-ui/composer-checkpoint" || f.version !== 1 || f.purpose !== "composer-injection")
			invalid("record: unsupported kind/version/purpose");
		const owner = binding(f.binding);
		const nextRevision = integer(f.nextRevision, "nextRevision");
		if (!Number.isSafeInteger(owner.revision + 1) || nextRevision !== owner.revision + 1)
			invalid("nextRevision: must equal original revision + 1");
		const incomingFields = fields(f.incoming, [], ["text", "attachments"], "incoming");
		const incoming: ComposerPayload = {};
		if ("text" in incomingFields) incoming.text = text(incomingFields.text, "incoming.text");
		if ("attachments" in incomingFields)
			incoming.attachments = list(incomingFields.attachments, attachment, "incoming.attachments");
		const record: ComposerCheckpoint = {
			kind: "pi-web-ui/composer-checkpoint",
			version: 1,
			purpose: "composer-injection",
			recordId: text(f.recordId, "recordId", true),
			createdAt: integer(f.createdAt, "createdAt"),
			binding: owner,
			nextRevision,
			source: draft(f.source, "source"),
			incoming,
			effective: draft(f.effective, "effective"),
		};
		return { ok: true, record: freeze(record) };
	} catch (error) {
		return { ok: false, code: "invalid-record", detail: error instanceof Error ? error.message : "Invalid checkpoint" };
	}
}

/** Canonical byte comparison also catches duplicate keys, lossy JSON numbers and extra JSON whitespace. */
export function decodeComposerCheckpoint(raw: string): DecodeResult {
	try {
		const decoded = snapshotComposerCheckpoint(JSON.parse(raw));
		if (!decoded.ok) return decoded;
		if (JSON.stringify(decoded.record) !== raw)
			return { ok: false, code: "invalid-record", detail: "Noncanonical or lossy checkpoint JSON" };
		return decoded;
	} catch {
		return { ok: false, code: "invalid-record", detail: "Malformed checkpoint JSON" };
	}
}

function identity(recordId: string, owner: FrozenComposerBinding): string {
	return JSON.stringify([owner.ownerId, owner.composerId, owner.conversationId, owner.sessionId, recordId]);
}

export function composerCheckpointKey(record: FrozenComposerCheckpoint): string {
	return RECORD_PREFIX + identity(record.recordId, record.binding);
}

function retirementKey(record: FrozenComposerCheckpoint): string {
	return RETIREMENT_PREFIX + identity(record.recordId, record.binding);
}

function decodeRetirement(raw: string, key?: string): Readonly<ComposerCheckpointRetirement> | null {
	try {
		const f = fields(JSON.parse(raw), ["kind", "version", "purpose", "recordKey", "original"], [], "retirement");
		if (f.kind !== "pi-web-ui/composer-checkpoint-retirement" || f.version !== 1 || f.purpose !== "composer-injection")
			return null;
		const original = text(f.original, "retirement.original");
		const decoded = decodeComposerCheckpoint(original);
		if (
			!decoded.ok ||
			composerCheckpointKey(decoded.record) !== f.recordKey ||
			(key !== undefined && retirementKey(decoded.record) !== key)
		)
			return null;
		const marker: ComposerCheckpointRetirement = {
			kind: "pi-web-ui/composer-checkpoint-retirement",
			version: 1,
			purpose: "composer-injection",
			recordKey: f.recordKey as string,
			original,
		};
		return JSON.stringify(marker) === raw ? Object.freeze(marker) : null;
	} catch {
		return null;
	}
}

/** Read-only, including raw unknown/corrupt/retired originals. No migration/pruning. */
export function inspectComposerCheckpoints(storage: ComposerCheckpointStorage): ComposerCheckpointInspection {
	const entries: ComposerCheckpointInspectionEntry[] = [];
	const errors: string[] = [];
	try {
		const keys = new Set<string>();
		const length = storage.length;
		for (let i = 0; i < length; i++) {
			const key = storage.key(i);
			if (key?.startsWith(COMPOSER_CHECKPOINT_PREFIX)) keys.add(key);
		}
		for (const key of keys) {
			try {
				const raw = storage.getItem(key);
				const entry: ComposerCheckpointInspectionEntry = { key, raw, status: "unknown" };
				if (raw === null) {
					entry.status = "corrupt";
					entry.detail = "Record disappeared during inspection";
				} else if (key.startsWith(RECORD_PREFIX)) {
					const decoded = decodeComposerCheckpoint(raw);
					if (decoded.ok && composerCheckpointKey(decoded.record) === key) {
						entry.record = decoded.record;
						entry.status = "active";
						try {
							const markerRaw = storage.getItem(retirementKey(decoded.record));
							if (markerRaw !== null) {
								const marker = decodeRetirement(markerRaw, retirementKey(decoded.record));
								if (marker?.original === raw) entry.status = "retired";
								else entry.detail = "Unmatched/corrupt retirement marker; original remains visible";
							}
						} catch {
							entry.status = "unknown";
							entry.detail = "Retirement state unavailable; original retained for inspection";
							errors.push(`Cannot read retirement for ${key}`);
						}
					} else {
						let unsupported = false;
						try {
							const parsed = JSON.parse(raw);
							unsupported =
								parsed?.version !== 1 ||
								parsed?.kind !== "pi-web-ui/composer-checkpoint" ||
								parsed?.purpose !== "composer-injection";
						} catch {
							/* corrupt raw is still exported */
						}
						entry.status = unsupported ? "unknown" : "corrupt";
						entry.detail = decoded.ok ? "Storage key does not match original binding" : decoded.detail;
					}
				} else if (key.startsWith(RETIREMENT_PREFIX)) {
					const marker = decodeRetirement(raw, key);
					entry.status = marker ? "retirement" : "corrupt";
					if (marker) entry.retirement = marker;
				}
				entries.push(Object.freeze(entry));
			} catch {
				errors.push(`Cannot read ${key}`);
			}
		}
	} catch {
		errors.push("Checkpoint storage unavailable or enumeration failed");
	}
	return Object.freeze({ ok: errors.length === 0, entries: Object.freeze(entries), errors: Object.freeze(errors) });
}

function refused(
	code: ComposerCheckpointFailureCode,
	payloadCommitted: boolean | "unknown",
	detail: string,
): ComposerCheckpointResult {
	return { ok: false, code, payloadCommitted, detail };
}

export interface ComposerCheckpointOptions {
	storage: ComposerCheckpointStorage | null | undefined;
	/** Must prove exclusive ORIGINAL ownership/revision. Literal true only; no Promise/thenable. */
	owns: (binding: FrozenComposerBinding) => boolean;
	/** Only true opts into writes. Inspection/reads remain available when disabled. */
	enabled?: boolean;
}

export function createComposerCheckpointStore(options: ComposerCheckpointOptions) {
	const { storage, owns } = options;
	const enabled = options.enabled === true;
	const stillOwns = (record: FrozenComposerCheckpoint): boolean => {
		try {
			return owns(record.binding) === true;
		} catch {
			return false;
		}
	};
	const observedCommit = (record: FrozenComposerCheckpoint, raw: string): boolean | "unknown" => {
		try {
			const observed = storage?.getItem(composerCheckpointKey(record));
			return observed === null ? false : observed === raw ? true : "unknown";
		} catch {
			return "unknown";
		}
	};

	return Object.freeze({
		checkpoint(input: unknown): ComposerCheckpointResult {
			if (!enabled) return refused("disabled", false, "Checkpoint writes are disabled");
			const snapshot = snapshotComposerCheckpoint(input);
			if (!snapshot.ok) return refused("invalid-record", false, snapshot.detail);
			const { record } = snapshot;
			if (!storage) return refused("unavailable", false, "No explicit storage adapter");
			if (!stillOwns(record)) return refused("not-owner", false, "Original exclusive binding/revision is not owned");
			const key = composerCheckpointKey(record);
			const raw = JSON.stringify(record);
			let existing: string | null;
			try {
				existing = storage.getItem(key);
				if (existing !== null && existing !== raw)
					return refused("collision", false, "Immutable key already contains a different original");
				if (storage.getItem(retirementKey(record)) !== null)
					return refused("retired", existing === raw, "Retirement marker exists; never reactivate implicitly");
			} catch {
				return refused("unavailable", "unknown", "Cannot inspect original/checkpoint retirement before write");
			}
			try {
				if (existing === null) {
					const returned: unknown = storage.setItem(key, raw);
					if (returned !== undefined)
						return refused(
							"write-failed",
							observedCommit(record, raw),
							"Storage setItem must be synchronous and return undefined",
						);
				}
			} catch {
				return refused(
					"write-failed",
					observedCommit(record, raw),
					"Storage write threw; no sink or clear is permitted",
				);
			}
			try {
				const readback = storage.getItem(key);
				if (readback !== raw)
					return refused(
						"readback-failed",
						readback === null ? false : "unknown",
						"Full checkpoint bytes were not read back",
					);
				const decoded = decodeComposerCheckpoint(readback);
				if (!decoded.ok) return refused("readback-failed", "unknown", decoded.detail);
				if (storage.getItem(retirementKey(record)) !== null)
					return refused("retired", true, "Retired during checkpoint; original retained");
				if (!stillOwns(decoded.record))
					return refused("not-owner", true, "Original owner/revision changed after full readback");
				// Also catch an ownership callback that re-entered storage. Cross-context atomicity is the host's obligation.
				if (storage.getItem(key) !== raw || storage.getItem(retirementKey(record)) !== null)
					return refused("readback-failed", "unknown", "Checkpoint changed after ownership recheck");
				return { ok: true, payloadCommitted: true, record: decoded.record };
			} catch {
				return refused("readback-failed", "unknown", "Readback/reconstruction failed; original is not deleted");
			}
		},

		read(recordId: string, expectedBinding: ComposerCheckpointBinding) {
			try {
				const expected = binding(expectedBinding);
				text(recordId, "recordId", true);
				if (!storage) return { ok: false as const, code: "unavailable" as const };
				const key = RECORD_PREFIX + identity(recordId, expected);
				const raw = storage.getItem(key);
				if (raw === null) return { ok: false as const, code: "missing" as const };
				const decoded = decodeComposerCheckpoint(raw);
				if (!decoded.ok) return { ...decoded, raw };
				if (
					composerCheckpointKey(decoded.record) !== key ||
					JSON.stringify(decoded.record.binding) !== JSON.stringify(expected)
				)
					return { ok: false as const, code: "wrong-binding" as const, raw };
				try {
					const markerRaw = storage.getItem(retirementKey(decoded.record));
					return {
						ok: true as const,
						record: decoded.record,
						raw,
						retired: markerRaw !== null && decodeRetirement(markerRaw, retirementKey(decoded.record))?.original === raw,
					};
				} catch {
					return { ok: false as const, code: "unavailable" as const, raw, record: decoded.record };
				}
			} catch {
				return { ok: false as const, code: "unavailable" as const };
			}
		},

		inspect(): ComposerCheckpointInspection {
			return storage
				? inspectComposerCheckpoints(storage)
				: { ok: false, entries: [], errors: ["No explicit storage adapter"] };
		},

		/** Explicit deliberate discard/proven equivalence ONLY. Never infer this authority from ok:true/close/transport ack. */
		retire(expectedFullRecord: unknown): ComposerCheckpointResult {
			if (!enabled) return refused("disabled", false, "Checkpoint writes are disabled");
			const snapshot = snapshotComposerCheckpoint(expectedFullRecord);
			if (!snapshot.ok) return refused("invalid-record", false, snapshot.detail);
			const { record } = snapshot;
			if (!storage) return refused("unavailable", false, "No explicit storage adapter");
			const raw = JSON.stringify(record);
			if (!stillOwns(record))
				return refused("not-owner", false, "Exact original ownership/revision is required for retirement");
			const key = composerCheckpointKey(record);
			const markerKey = retirementKey(record);
			const marker: ComposerCheckpointRetirement = {
				kind: "pi-web-ui/composer-checkpoint-retirement",
				version: 1,
				purpose: "composer-injection",
				recordKey: key,
				original: raw,
			};
			const markerRaw = JSON.stringify(marker);
			try {
				if (storage.getItem(key) !== raw)
					return refused("stale-retirement", false, "Expected complete original/revision no longer matches");
				const existing = storage.getItem(markerKey);
				if (existing !== null && existing !== markerRaw)
					return refused("stale-retirement", false, "Different retirement original already exists");
				if (!stillOwns(record) || storage.getItem(key) !== raw)
					return refused("stale-retirement", false, "Original changed before append-only retirement");
				if (existing === null) {
					const returned: unknown = storage.setItem(markerKey, markerRaw);
					if (returned !== undefined)
						return refused("write-failed", "unknown", "Retirement setItem must be synchronous; original retained");
				}
				if (storage.getItem(markerKey) !== markerRaw || !decodeRetirement(markerRaw, markerKey))
					return refused("readback-failed", "unknown", "Retirement marker readback failed; original retained");
				if (!stillOwns(record) || storage.getItem(key) !== raw || storage.getItem(markerKey) !== markerRaw)
					return refused("stale-retirement", "unknown", "Original changed after retirement append; nothing removed");
				return { ok: true, payloadCommitted: true, record };
			} catch {
				return refused("write-failed", "unknown", "Retirement append/readback failed; original is never removed");
			}
		},
	});
}
