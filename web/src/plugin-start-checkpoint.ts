/// <reference lib="dom" />
/** Inert, opt-in boundary for the synchronous plugin boolean API. See the #584 contract. */
import type { PluginHostStartChatOptions } from "./plugin-host";

export const PLUGIN_START_PREFIX = "pi-web-plugin-start-v1:";
export const PLUGIN_START_LOCK_PREFIX = "pi-web-plugin-start-owner-v1:";
const FORMAT = "pi-web-plugin-start";
export type PluginStartOption<T> = { presence: "absent" | "undefined" } | { presence: "value"; value: T };
export interface PluginStartSource {
	ownerId: string;
	sessionId: string;
	conversationId: string;
	/** Null means attribution is unknown; never invent a plugin identity. */
	pluginId: string | null;
}
export interface PluginStartIntent {
	format: typeof FORMAT;
	version: 1;
	kind: "intent";
	intentId: string;
	promptId: string;
	createdAt: number;
	source: PluginStartSource & { generation: string };
	original: {
		prompt: string;
		newChat: PluginStartOption<boolean>;
		cwd: PluginStartOption<string>;
		model: PluginStartOption<string>;
	};
	effective: { prompt: string; newChat: boolean; cwd: string; model: string };
}
/** Exact stored bytes, not a prompt-text match or server persistence receipt. */
export interface PluginStartIdentity {
	key: string;
	serialized: string;
}
interface Marker {
	format: typeof FORMAT;
	version: 1;
	kind: "begin" | "retired";
	target: PluginStartIdentity;
	at: number;
	authority?: "discard" | "persisted";
}
export type PluginStartCode =
	| "unavailable"
	| "owner-conflict"
	| "source-mismatch"
	| "closed"
	| "invalid-input"
	| "invalid-identity"
	| "storage-failed"
	| "readback-failed"
	| "duplicate-id"
	| "catalogue-incomplete"
	| "reentrant"
	| "recovery-required"
	| "persistence-unverified"
	| "host-refused"
	| "continuation-failed";
export interface PluginStartFailure {
	ok: false;
	code: PluginStartCode;
	/** A failed checkpoint never authorizes discarding the caller's original. */
	sourceRetained: true;
	checkpointMayExist: boolean;
	dispatch: false;
}
export interface PluginStartAccepted {
	ok: true;
	intent: Readonly<PluginStartIntent>;
	identity: Readonly<PluginStartIdentity>;
	/** Only begin() may grant an effect permit. */
	dispatch: false;
}
export type PluginStartResult = PluginStartAccepted | PluginStartFailure;
export interface PluginStartPermit {
	/** Recheck after every await. This is not target/readiness or persistence proof. */
	valid(): boolean;
}
export type PluginStartBegin =
	{ ok: true; intent: Readonly<PluginStartIntent>; permit: PluginStartPermit } | PluginStartFailure;
export type PluginStartRetirement =
	| { kind: "discard"; identity: PluginStartIdentity }
	| { kind: "persisted"; identity: PluginStartIdentity; proof: unknown };
export interface PluginStartOpenOptions {
	ownerId: string;
	getSource(): PluginStartSource;
	/** Test seams only. Defaults are native browser primitives; no memory fallback. */
	storage?: Storage;
	locks?: Pick<LockManager, "request">;
	newId?: () => string;
	now?: () => number;
	verifyPersistence?: (intent: Readonly<PluginStartIntent>, proof: unknown) => Promise<boolean> | boolean;
}
export interface PluginStartOwner {
	readonly ownerId: string;
	readonly generation: string;
	checkpoint(options: PluginHostStartChatOptions, ids?: { intentId: string; promptId: string }): PluginStartResult;
	begin(identity: PluginStartIdentity): PluginStartBegin;
	retire(request: PluginStartRetirement): Promise<{ ok: true } | PluginStartFailure>;
	close(): void;
}
export interface PluginStartCatalogueEntry {
	key: string;
	raw: string | null;
	ownerId: string | null;
	kind: "intent" | "begin" | "retired" | "unknown" | "corrupt";
	intent?: PluginStartIntent;
	marker?: Marker;
	/** Recovery never grants execution, even for a checkpoint with no begin marker. */
	state?: "recovery-required" | "retired";
	possibleEffects?: boolean;
	issue?: string;
}
export interface PluginStartCatalogue {
	complete: boolean;
	entries: PluginStartCatalogueEntry[];
	issues: string[];
}
const failure = (code: PluginStartCode, checkpointMayExist = false): PluginStartFailure => ({
	ok: false,
	code,
	sourceRetained: true,
	checkpointMayExist,
	dispatch: false,
});
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const plain = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
function exact(v: Record<string, unknown>, keys: string[]): boolean {
	return Reflect.ownKeys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
}
function data(v: Record<string, unknown>, key: string): unknown {
	const d = Object.getOwnPropertyDescriptor(v, key);
	if (d && !("value" in d)) throw new Error("Accessor input is not a plain typed intent");
	return d?.value;
}
function freeze<T>(v: T): T {
	if (v && typeof v === "object") {
		for (const child of Object.values(v)) freeze(child);
		Object.freeze(v);
	}
	return v;
}
function capture(input: unknown): PluginStartIntent["original"] {
	if (!plain(input) || Reflect.ownKeys(input).some((k) => !["prompt", "newChat", "cwd", "model"].includes(String(k))))
		throw new Error("Not typed startChat input");
	const record = input;
	const prompt = data(record, "prompt");
	if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Empty prompt");
	function option<T extends boolean | string>(key: string, type: "boolean" | "string"): PluginStartOption<T> {
		if (!Object.hasOwn(record, key)) return { presence: "absent" };
		const value = data(record, key);
		if (value === undefined) return { presence: "undefined" };
		if (typeof value !== type) throw new Error("Invalid option type");
		return { presence: "value", value: value as T };
	}
	return {
		prompt,
		newChat: option("newChat", "boolean"),
		cwd: option("cwd", "string"),
		model: option("model", "string"),
	};
}
function effective(original: PluginStartIntent["original"]): PluginStartIntent["effective"] {
	return {
		prompt: original.prompt.trim(),
		newChat: original.newChat.presence === "value" ? original.newChat.value !== false : true,
		cwd: original.cwd.presence === "value" ? original.cwd.value.trim() : "",
		model: original.model.presence === "value" ? original.model.value.trim() : "",
	};
}
/** Reconstitute option presence/undefined without normalizing any caller bytes. */
export function pluginStartOriginalOptions(intent: Readonly<PluginStartIntent>): PluginHostStartChatOptions {
	return originalOptions(intent.original);
}
function originalOptions(original: PluginStartIntent["original"]): PluginHostStartChatOptions {
	const result: PluginHostStartChatOptions = { prompt: original.prompt };
	const { newChat, cwd, model } = original;
	if (newChat.presence !== "absent") result.newChat = newChat.presence === "value" ? newChat.value : undefined;
	if (cwd.presence !== "absent") result.cwd = cwd.presence === "value" ? cwd.value : undefined;
	if (model.presence !== "absent") result.model = model.presence === "value" ? model.value : undefined;
	return result;
}
function source(value: unknown): PluginStartSource {
	if (!plain(value)) throw new Error("Missing source binding");
	const s = {
		ownerId: data(value, "ownerId"),
		sessionId: data(value, "sessionId"),
		conversationId: data(value, "conversationId"),
		pluginId: data(value, "pluginId"),
	};
	if (!text(s.ownerId) || !text(s.sessionId) || !text(s.conversationId) || !(s.pluginId === null || text(s.pluginId)))
		throw new Error("Incomplete source binding");
	return s as PluginStartSource;
}
function keyFor(kind: "intent" | "begin" | "retired", owner: string, id: string): string {
	return PLUGIN_START_PREFIX + JSON.stringify([kind, owner, id]);
}
function keyParts(key: string): ["intent" | "begin" | "retired", string, string] | null {
	try {
		const v: unknown = JSON.parse(key.slice(PLUGIN_START_PREFIX.length));
		if (
			key.startsWith(PLUGIN_START_PREFIX) &&
			Array.isArray(v) &&
			v.length === 3 &&
			["intent", "begin", "retired"].includes(v[0]) &&
			text(v[1]) &&
			text(v[2])
		)
			return v as ["intent" | "begin" | "retired", string, string];
	} catch {
		/* Unrecognized namespace data remains visible. */
	}
	return null;
}
function parseIntent(raw: string, key: string): PluginStartIntent {
	const v: unknown = JSON.parse(raw);
	if (
		!plain(v) ||
		!exact(v, ["format", "version", "kind", "intentId", "promptId", "createdAt", "source", "original", "effective"]) ||
		v.format !== FORMAT ||
		v.version !== 1 ||
		v.kind !== "intent" ||
		!text(v.intentId) ||
		!text(v.promptId) ||
		typeof v.createdAt !== "number" ||
		!Number.isFinite(v.createdAt) ||
		!plain(v.source) ||
		!exact(v.source, ["ownerId", "sessionId", "conversationId", "pluginId", "generation"]) ||
		!text(v.source.generation)
	)
		throw new Error("Invalid intent schema");
	const s = source(v.source);
	if (key !== keyFor("intent", s.ownerId, v.intentId)) throw new Error("Key/source identity mismatch");
	if (
		!plain(v.original) ||
		!exact(v.original, ["prompt", "newChat", "cwd", "model"]) ||
		typeof v.original.prompt !== "string"
	)
		throw new Error("Invalid original schema");
	for (const [name, type] of [
		["newChat", "boolean"],
		["cwd", "string"],
		["model", "string"],
	]) {
		const o = v.original[name];
		if (
			!plain(o) ||
			!(o.presence === "absent" || o.presence === "undefined"
				? exact(o, ["presence"])
				: o.presence === "value" && exact(o, ["presence", "value"]) && typeof o.value === type)
		)
			throw new Error("Invalid original option");
	}
	const intent = v as unknown as PluginStartIntent;
	const rederived = capture(pluginStartOriginalOptions(intent));
	if (
		JSON.stringify(rederived) !== JSON.stringify(intent.original) ||
		JSON.stringify(effective(rederived)) !== JSON.stringify(intent.effective)
	)
		throw new Error("Original/effective mismatch");
	return freeze(intent);
}
function inspect(key: string, raw: string | null): PluginStartCatalogueEntry {
	const parts = keyParts(key);
	const item: PluginStartCatalogueEntry = { key, raw, ownerId: parts?.[1] ?? null, kind: "corrupt" };
	try {
		if (raw === null) throw new Error("Record disappeared or was unreadable");
		const v: unknown = JSON.parse(raw);
		if (!plain(v) || v.format !== FORMAT || v.version !== 1 || !parts) {
			item.kind = "unknown";
			throw new Error("Unknown format/version/key");
		}
		if (parts[0] === "intent") {
			item.intent = parseIntent(raw, key);
			item.kind = "intent";
		} else {
			const keys = ["format", "version", "kind", "target", "at", ...(parts[0] === "retired" ? ["authority"] : [])];
			if (
				!exact(v, keys) ||
				v.kind !== parts[0] ||
				!plain(v.target) ||
				!exact(v.target, ["key", "serialized"]) ||
				!text(v.target.key) ||
				typeof v.target.serialized !== "string" ||
				typeof v.at !== "number" ||
				!Number.isFinite(v.at) ||
				(parts[0] === "retired" && v.authority !== "persisted" && v.authority !== "discard")
			)
				throw new Error("Invalid lifecycle marker");
			const target = parseIntent(v.target.serialized, v.target.key);
			if (key !== keyFor(parts[0], target.source.ownerId, target.intentId)) throw new Error("Marker/source mismatch");
			item.marker = freeze(v as unknown as Marker);
			item.kind = parts[0];
		}
	} catch (error) {
		item.issue = error instanceof Error ? error.message : "Unreadable record";
	}
	return item;
}
function catalogue(entries: PluginStartCatalogueEntry[], issues: string[] = []): PluginStartCatalogue {
	const byKey = new Map(entries.map((e) => [e.key, e]));
	for (const item of entries) {
		if (item.marker && byKey.get(item.marker.target.key)?.raw !== item.marker.target.serialized)
			item.issue = "Orphan or mismatched lifecycle target";
		if (item.intent) {
			const { ownerId } = item.intent.source;
			const match = (kind: "begin" | "retired") => {
				const m = byKey.get(keyFor(kind, ownerId, item.intent!.intentId));
				return !m?.issue && m?.marker?.target.serialized === item.raw;
			};
			item.state = match("retired") ? "retired" : "recovery-required";
			item.possibleEffects = match("begin");
		}
	}
	return { complete: issues.length === 0 && entries.every((e) => !e.issue), entries, issues };
}
/** Read-only; raw corrupt/unknown entries are never hidden, rewritten or removed. */
export function catalogPluginStarts(storage?: Storage): PluginStartCatalogue {
	const entries: PluginStartCatalogueEntry[] = [];
	const issues: string[] = [];
	try {
		const store = storage ?? globalThis.localStorage;
		const keys = new Set<string>();
		const length = store.length;
		for (let i = 0; i < length; i++) {
			const key = store.key(i);
			if (key === null) issues.push("Storage keys changed during enumeration; retain originals");
			if (key?.startsWith(PLUGIN_START_PREFIX)) keys.add(key);
		}
		if (store.length !== length) issues.push("Storage changed during enumeration; retain originals");
		for (const key of [...keys].sort()) {
			try {
				entries.push(inspect(key, store.getItem(key)));
			} catch {
				entries.push({
					key,
					raw: null,
					ownerId: keyParts(key)?.[1] ?? null,
					kind: "corrupt",
					issue: "Storage read failed; original not removed",
				});
			}
		}
	} catch {
		issues.push("Storage enumeration unavailable/incomplete; originals not removed");
	}
	return catalogue(entries, issues);
}
export function exportPluginStarts(storage?: Storage): string {
	const c = catalogPluginStarts(storage);
	return JSON.stringify({
		format: "pi-web-plugin-start-export",
		version: 1,
		complete: c.complete,
		issues: c.issues,
		records: c.entries.map(({ key, raw }) => ({ key, raw })),
	});
}
/** Artifact inspection only, including partial exports; no restore or execution. */
export function readPluginStartExport(serialized: string): PluginStartCatalogue {
	try {
		const v: unknown = JSON.parse(serialized);
		if (
			!plain(v) ||
			!exact(v, ["format", "version", "complete", "issues", "records"]) ||
			v.format !== "pi-web-plugin-start-export" ||
			v.version !== 1 ||
			typeof v.complete !== "boolean" ||
			!Array.isArray(v.issues) ||
			!v.issues.every((s) => typeof s === "string") ||
			!Array.isArray(v.records)
		)
			throw new Error("Unknown export format");
		const seen = new Set<string>();
		const records = v.records.map((r: unknown) => {
			if (
				!plain(r) ||
				!exact(r, ["key", "raw"]) ||
				!text(r.key) ||
				!r.key.startsWith(PLUGIN_START_PREFIX) ||
				!(r.raw === null || typeof r.raw === "string") ||
				seen.has(r.key)
			)
				throw new Error("Invalid/duplicate export key");
			seen.add(r.key);
			return inspect(r.key, r.raw);
		});
		return catalogue(records, [...v.issues, ...(v.complete ? [] : ["Source export was incomplete"])]);
	} catch {
		return { complete: false, entries: [], issues: ["Unreadable/unknown export; retain original artifact bytes"] };
	}
}
/** Initialize BEFORE publishing a synchronous plugin API. No automatic ownership takeover. */
export async function openPluginStartCheckpoint(
	requestedOptions: PluginStartOpenOptions,
): Promise<{ ok: true; owner: PluginStartOwner } | PluginStartFailure> {
	const options = { ...requestedOptions };
	let active = false;
	let release = () => {};
	let store: Storage;
	let generation: string;
	const newId = options.newId ?? (() => crypto.randomUUID());
	const now = options.now ?? Date.now;
	const close = () => {
		active = false;
		release();
	};
	try {
		if (!text(options.ownerId)) return failure("invalid-input");
		const locks = options.locks ?? globalThis.navigator?.locks;
		if (!locks) return failure("unavailable");
		const granted = await new Promise<boolean>((resolve) => {
			const held = new Promise<void>((done) => {
				release = done;
			});
			void locks
				.request(PLUGIN_START_LOCK_PREFIX + options.ownerId, { mode: "exclusive", ifAvailable: true }, async (lock) => {
					if (!lock) {
						resolve(false);
						return;
					}
					active = true;
					resolve(true);
					await held;
				})
				.then(
					() => {
						active = false;
					},
					() => {
						active = false;
						resolve(false);
					},
				);
		});
		if (!granted || !active) return failure("owner-conflict");
		store = options.storage ?? globalThis.localStorage;
		generation = newId();
		if (!text(generation)) throw new Error("No generation identity");
		if (source(options.getSource()).ownerId !== options.ownerId) {
			close();
			return failure("source-mismatch");
		}
	} catch {
		close();
		return failure("unavailable");
	}
	let mutating = false;
	const fresh = new Map<string, PluginStartAccepted>();
	const begun = new Set<string>();
	function ready(): PluginStartFailure | null {
		if (!active) return failure("closed");
		try {
			bound();
		} catch {
			return failure("source-mismatch");
		}
		const c = catalogPluginStarts(store);
		if (c.issues.length || c.entries.some((e) => e.issue && (e.ownerId === options.ownerId || e.ownerId === null)))
			return failure("catalogue-incomplete");
		return null;
	}
	function bound(): PluginStartSource {
		const s = source(options.getSource());
		if (s.ownerId !== options.ownerId) throw new Error("Owner changed");
		return s;
	}
	function sameSource(s: PluginStartSource): boolean {
		try {
			return active && JSON.stringify(bound()) === JSON.stringify(source(s));
		} catch {
			return false;
		}
	}
	function writeAbsent(key: string, raw: string): PluginStartFailure | null {
		try {
			if (!active) return failure("closed");
			bound();
			if (store.getItem(key) !== null) return failure("duplicate-id", true);
			store.setItem(key, raw);
			if (store.getItem(key) !== raw) return failure("readback-failed", true);
			return null;
		} catch {
			return failure("storage-failed", true);
		}
	}
	function matched(identity: PluginStartIdentity): PluginStartIntent | null {
		try {
			if (
				!plain(identity) ||
				!exact(identity, ["key", "serialized"]) ||
				!text(identity.key) ||
				typeof identity.serialized !== "string"
			)
				return null;
			const intent = parseIntent(identity.serialized, identity.key);
			return intent.source.ownerId === options.ownerId && store.getItem(identity.key) === identity.serialized
				? intent
				: null;
		} catch {
			return null;
		}
	}
	const owner: PluginStartOwner = {
		ownerId: options.ownerId,
		generation,
		checkpoint(input, ids) {
			if (mutating) return failure("reentrant");
			mutating = true;
			let written = false;
			try {
				const refusal = ready();
				if (refusal) return refusal;
				let original: PluginStartIntent["original"];
				try {
					original = capture(input);
				} catch {
					return failure("invalid-input");
				}
				let s: PluginStartSource;
				try {
					s = bound();
				} catch {
					return failure("source-mismatch");
				}
				const intentId = ids ? ids.intentId : newId();
				const promptId = ids ? ids.promptId : newId();
				if (!text(intentId) || !text(promptId)) return failure("invalid-input");
				const c = catalogPluginStarts(store);
				if (c.entries.some((e) => e.intent?.source.ownerId === options.ownerId && e.intent.promptId === promptId))
					return failure("duplicate-id", true);
				const intent = freeze<PluginStartIntent>({
					format: FORMAT,
					version: 1,
					kind: "intent",
					intentId,
					promptId,
					createdAt: now(),
					source: { ...s, generation },
					original,
					effective: effective(original),
				});
				const identity = freeze({
					key: keyFor("intent", options.ownerId, intentId),
					serialized: JSON.stringify(intent),
				});
				parseIntent(identity.serialized, identity.key);
				if (!sameSource(s)) return failure("source-mismatch");
				const failed = writeAbsent(identity.key, identity.serialized);
				written = true;
				if (failed) return failed;
				if (!sameSource(s)) return failure(active ? "source-mismatch" : "closed", true);
				const accepted: PluginStartAccepted = freeze({ ok: true, intent, identity, dispatch: false });
				fresh.set(identity.key, accepted);
				return accepted;
			} catch {
				return failure("storage-failed", written);
			} finally {
				mutating = false;
			}
		},
		begin(requestIdentity) {
			if (mutating) return failure("reentrant", true);
			mutating = true;
			try {
				const identity = { key: requestIdentity?.key, serialized: requestIdentity?.serialized };
				const refusal = ready();
				if (refusal) return refusal;
				const intent = matched(identity);
				if (!intent) return failure("invalid-identity", true);
				const accepted = fresh.get(identity.key);
				if (
					!accepted ||
					accepted.identity.serialized !== identity.serialized ||
					intent.source.generation !== generation ||
					begun.has(identity.key)
				)
					return failure("recovery-required", true);
				if (!sameSource(intent.source)) return failure("source-mismatch", true);
				// One attempt even when native write outcome is ambiguous. Never auto-retry effects.
				begun.add(identity.key);
				const marker: Marker = { format: FORMAT, version: 1, kind: "begin", target: { ...identity }, at: now() };
				const key = keyFor("begin", options.ownerId, intent.intentId);
				const raw = JSON.stringify(marker);
				if (inspect(key, raw).issue) return failure("invalid-input", true);
				const failed = writeAbsent(key, raw);
				if (failed) return failed;
				if (!sameSource(intent.source) || !matched(identity)) return failure("source-mismatch", true);
				const permit: PluginStartPermit = Object.freeze({
					valid: () => {
						try {
							return (
								active &&
								bound().ownerId === options.ownerId &&
								!!matched(identity) &&
								store.getItem(key) === raw &&
								store.getItem(keyFor("retired", options.ownerId, intent.intentId)) === null
							);
						} catch {
							return false;
						}
					},
				});
				return { ok: true, intent: accepted.intent, permit };
			} catch {
				return failure("storage-failed", true);
			} finally {
				mutating = false;
			}
		},
		async retire(request) {
			// Copy caller identity before an arbitrary verifier await.
			const identity = { key: request.identity?.key, serialized: request.identity?.serialized };
			const kind = request.kind;
			const proof = kind === "persisted" ? request.proof : undefined;
			const refusal = ready();
			if (refusal) return refusal;
			const intent = matched(identity);
			if (!intent || (kind !== "discard" && kind !== "persisted")) return failure("invalid-identity", true);
			if (kind === "persisted") {
				try {
					if (!options.verifyPersistence || (await options.verifyPersistence(intent, proof)) !== true)
						return failure("persistence-unverified", true);
				} catch {
					return failure("persistence-unverified", true);
				}
			}
			if (mutating) return failure("reentrant", true);
			mutating = true;
			try {
				const changed = ready();
				if (changed) return changed;
				if (!matched(identity)) return failure("invalid-identity", true);
				const marker: Marker = {
					format: FORMAT,
					version: 1,
					kind: "retired",
					target: identity,
					at: now(),
					authority: kind,
				};
				const key = keyFor("retired", options.ownerId, intent.intentId);
				const raw = JSON.stringify(marker);
				if (inspect(key, raw).issue) return failure("invalid-input", true);
				const failed = writeAbsent(key, raw);
				if (failed) return failed;
				if (!active || !matched(identity)) return failure("closed", true);
				try {
					bound();
				} catch {
					return failure("source-mismatch", true);
				}
				fresh.delete(identity.key);
				return { ok: true };
			} catch {
				return failure("storage-failed", true);
			} finally {
				mutating = false;
			}
		},
		close,
	};
	const initial = ready();
	if (initial) {
		close();
		return initial;
	}
	return { ok: true, owner: Object.freeze(owner) };
}
/** Optional inert adapter: actual boolean now; guarded async continuation later. */
export function createPluginStartAdapter(
	owner: PluginStartOwner,
	host: {
		validate(options: PluginHostStartChatOptions): boolean;
		continueIntent(intent: Readonly<PluginStartIntent>, permit: PluginStartPermit): Promise<void> | void;
	},
): {
	startChat(options: PluginHostStartChatOptions): boolean;
	lastResult(): PluginStartResult | null;
	issues(): readonly PluginStartFailure[];
} {
	let last: PluginStartResult | null = null;
	const issues: PluginStartFailure[] = [];
	return {
		startChat(options) {
			let captured: PluginHostStartChatOptions;
			try {
				captured = Object.freeze(originalOptions(capture(options)));
			} catch {
				last = failure("invalid-input");
				return false;
			}
			try {
				if (host.validate(captured) !== true) {
					last = failure("host-refused");
					return false;
				}
			} catch {
				last = failure("host-refused");
				return false;
			}
			const result = owner.checkpoint(captured);
			last = result;
			if (!result.ok) return false;
			queueMicrotask(() => {
				const started = owner.begin(result.identity);
				if (!started.ok) {
					issues.push(started);
					return;
				}
				void Promise.resolve()
					.then(() => {
						if (!started.permit.valid()) {
							issues.push(failure("closed", true));
							return;
						}
						return host.continueIntent(started.intent, started.permit);
					})
					.catch(() => {
						issues.push(failure("continuation-failed", true));
					});
			});
			return true;
		},
		lastResult: () => last,
		issues: () => issues.slice(),
	};
}
/** Pass a pinned, browser-bundled ESM source; no app imports are used by this viewer. */
export function createPluginStartReaderHtml(browserEsmBundle: string): string {
	const literal = JSON.stringify(browserEsmBundle).replace(/</g, "\\u003c");
	return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Plugin startChat recovery (read only)</title>
<h1>Plugin startChat recovery — read only</h1><p>Unresolved work requires explicit user recovery. Never replay possible effects automatically. Originals are not removed.</p>
<button id="plugin-start-refresh">Refresh</button> <button id="plugin-start-export">Export raw originals</button>
<pre id="plugin-start-catalogue"></pre><pre id="plugin-start-artifact"></pre>
<script type="module">
const moduleUrl = URL.createObjectURL(new Blob([${literal}], {type:'text/javascript'}));
try {
 const recovery = await import(moduleUrl);
 const show = () => { window.pluginStartCatalogue = recovery.catalogPluginStarts(); document.getElementById('plugin-start-catalogue').textContent = JSON.stringify(window.pluginStartCatalogue, null, 2); };
 document.getElementById('plugin-start-refresh').onclick = show;
 document.getElementById('plugin-start-export').onclick = () => {
  const artifact = recovery.exportPluginStarts(); document.getElementById('plugin-start-artifact').textContent = artifact;
  const url = URL.createObjectURL(new Blob([artifact], {type:'application/json'}));
  const a = document.createElement('a'); a.href = url; a.download = 'plugin-start-recovery.json'; a.click(); URL.revokeObjectURL(url);
 };
 show(); window.pluginStartReaderReady = true;
} catch { document.getElementById('plugin-start-catalogue').textContent = 'Reader failed. Keep original storage and reader artifact; check same-origin auth/CSP.'; }
finally { URL.revokeObjectURL(moduleUrl); }
</script></html>`;
}
