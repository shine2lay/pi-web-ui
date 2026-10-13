/** Inert component E. No default path, instance, bootstrap, registration or live I/O on import.
 * The supplied exclusive lease MUST cover ALL legacy writers, not just instances of this class.
 * A checksummed prepare is never acceptance. The commit bundle binds state + exact legacy words;
 * acknowledgment waits for canonical publication/flush. Unknown prepares are quarantined, not refunded.
 */
import { createHash, randomBytes } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type {
	GuardAtomicMutation,
	GuardCommitResult,
	GuardLookupResult,
	GuardOperationIdentity,
	GuardReadResult,
	GuardReservation,
	GuardResult,
	GuardStorePort,
	GuardStoreState,
} from "./role-message-guard-contract.js";
import type { RoleMessageRecord } from "./role-messages.js";

// #122 H-ROLE-LADDER-PERF-1: guardDigest hashes exactly JSON.stringify of the old sorted copy (keys without
// undefined, localeCompare order, array-index keys first in number order as a plain object puts them); a unit test
// holds it to that reference. It copies only objects whose keys are out of that order (the store writes its files
// in that order, so what it reads back needs no copy) and lets the native JSON.stringify write the text.
const keyOrders = new Map<string, readonly string[]>();
const sortedShapes = new Map<string, boolean>();
function isIndexKey(k: string): boolean {
	if (k.length === 0 || k.length > 10) return false;
	for (let i = 0; i < k.length; i++) {
		const c = k.charCodeAt(i);
		if (c < 48 || c > 57) return false;
	}
	return (k === "0" || k.charCodeAt(0) !== 48) && Number(k) < 4294967295;
}
function orderedKeys(keys: string[]): readonly string[] {
	const shape = keys.join("\u0000");
	let order = keyOrders.get(shape);
	if (!order) {
		const index = keys.filter(isIndexKey).sort((a, b) => Number(a) - Number(b));
		const named = keys.filter((k) => !isIndexKey(k)).sort((a, b) => a.localeCompare(b));
		order = [...index, ...named];
		if (keyOrders.size < 4096) keyOrders.set(shape, order);
	}
	return order;
}
/** Keys as Object.keys lists them (index keys already first) are in sorted order: a stable sort keeps them. */
function keysSorted(keys: string[]): boolean {
	const shape = keys.join("\u0000");
	let sorted = sortedShapes.get(shape);
	if (sorted === undefined) {
		sorted = true;
		let previous: string | null = null;
		for (const k of keys) {
			if (isIndexKey(k)) continue;
			if (previous !== null && previous.localeCompare(k) > 0) {
				sorted = false;
				break;
			}
			previous = k;
		}
		if (sortedShapes.size < 4096) sortedShapes.set(shape, sorted);
	}
	return sorted;
}
/** The value itself when it already is its sorted copy; otherwise a sorted copy (shared unchanged children). */
function sortedCopy(v: unknown): unknown {
	if (v === null || typeof v !== "object") return v;
	if (Array.isArray(v)) {
		let out: unknown[] | null = null;
		for (let i = 0; i < v.length; i++) {
			const x: unknown = v[i];
			const c = sortedCopy(x);
			if (out === null && c !== x) out = v.slice(0, i);
			if (out !== null) out.push(c);
		}
		return out ?? v;
	}
	const o = v as Record<string, unknown>;
	const keys = Object.keys(o);
	const proto: unknown = Object.getPrototypeOf(o);
	// Anything but a plain object (a Date, say) became a plain copy of its own keys in the old sort.
	let changed = (proto !== Object.prototype && proto !== null) || !keysSorted(keys);
	const copies = new Map<string, unknown>();
	for (const k of keys) {
		const x = o[k];
		const c = sortedCopy(x);
		if (c !== x) changed = true;
		copies.set(k, c);
	}
	if (!changed) return o;
	return Object.fromEntries(
		orderedKeys(keys.filter((k) => o[k] !== undefined)).map((k) => [k, copies.get(k)] as const),
	);
}
/** The canonical text guardDigest hashes; the store also writes its files in this order. */
function sortedJson(value: unknown): string {
	return JSON.stringify(sortedCopy(value));
}
function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}
/** Sorted JSON is an integrity/fingerprint mechanism, NOT authentication or hostile-user protection. */
export function guardDigest(value: unknown): string {
	return sha256(sortedJson(value)); // undefined throws, as before
}
/** #122 H-ROLE-LADDER-PERF-2: sortedJson of a plain object built from each field's own sortedJson text (a missing
 * text leaves the key out, as JSON.stringify does), so a big field is written once for several texts. */
function composeSorted(parts: Readonly<Record<string, string | undefined>>): string {
	const keys = orderedKeys(Object.keys(parts).filter((k) => parts[k] !== undefined));
	return `{${keys.map((k) => `${JSON.stringify(k)}:${parts[k]}`).join(",")}}`;
}
export function guardTransactionId(identity: GuardOperationIdentity): string {
	return `guard-tx-${guardDigest(identity)}`;
}
function sameIdentity(a: GuardOperationIdentity, b: GuardOperationIdentity): boolean {
	return guardDigest(a) === guardDigest(b);
}
export function guardOperationKey(identity: GuardOperationIdentity): string {
	// Operation ids are host-assigned across the store. Role/session changes cannot reopen one.
	return guardDigest({ version: identity.version, operationId: identity.operationId });
}
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function integer(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function safeJson(value: unknown): boolean {
	if (typeof value === "number") return integer(value);
	if (Array.isArray(value)) return value.every(safeJson);
	if (record(value)) return Object.values(value).every(safeJson);
	return value === null || typeof value === "string" || typeof value === "boolean";
}
/** Structural decoding only; every restored authority/evidence is reverified by the host before use. */
export function guardStateIsValid(value: unknown): value is GuardStoreState {
	if (
		!record(value) ||
		!safeJson(value) ||
		value.version !== "role-message-guard/v1" ||
		typeof value.revision !== "string" ||
		!integer(value.lastTrustedTime)
	)
		return false;
	if (!["enabled", "rollback_depth_6", "unavailable"].includes(String(value.mode))) return false;
	for (const key of ["requests", "grants", "incidents", "usage", "transactions", "outbox", "audits", "tombstones"]) {
		if (!Array.isArray(value[key]) || !(value[key] as unknown[]).every(record)) return false;
	}
	if (
		!record(value.overflow) ||
		!integer(value.overflow.count) ||
		!["none", "capacity_exhausted", "unknown"].includes(String(value.overflow.state))
	)
		return false;
	const s = value as unknown as GuardStoreState;
	try {
		return (
			s.requests.every(
				(r) => !!r.binding.requestId && !!r.binding.generation && integer(r.createdAt) && integer(r.expiresAt),
			) &&
			s.grants.every(
				(g) =>
					!!g.id &&
					integer(g.issuedAt) &&
					integer(g.expiresAt) &&
					integer(g.acceptedUses) &&
					g.maximumUses >= 1 &&
					g.maximumUses <= 5 &&
					g.acceptedUses <= g.maximumUses &&
					Array.isArray(g.useTransactionIds),
			) &&
			s.incidents.every(
				(i) => !!i.identity.nativeEpisodeId && integer(i.identity.openedAt) && integer(i.identity.expiresAt),
			) &&
			s.usage.every(
				(u) =>
					!!u.transactionId &&
					integer(u.committedAt) &&
					!!u.origin &&
					!!u.destination &&
					u.usage.ordinaryOrigin === 1 &&
					Object.values(u.usage).every((n) => n === 0 || n === 1),
			) &&
			s.transactions.every(
				(t) =>
					!!t.transactionId &&
					!!t.identity.operationId &&
					!!t.identity.fingerprint &&
					["prepared", "committed", "unknown"].includes(t.state) &&
					(t.state === "committed" ? !!t.result.state : integer(t.reservation.preparedAt)),
			) &&
			s.outbox.every(
				(o) =>
					!!o.receipt.transactionId &&
					!!o.receipt.messageId &&
					!!o.receipt.dispatchKey &&
					!!o.receipt.wakeKey &&
					legacyMessageIsValid(o.message),
			) &&
			s.audits.every((a) => !!a.id && !!a.transactionId && integer(a.at)) &&
			s.tombstones.every(
				(t) => !!t.identityDigest && (t.invalidThrough === "source_horizon_unknown" || integer(t.invalidThrough)),
			)
		);
	} catch {
		return false;
	}
}
function legacyMessageIsValid(value: unknown): value is RoleMessageRecord {
	return (
		record(value) &&
		typeof value.id === "string" &&
		integer(value.at) &&
		record(value.from) &&
		typeof value.from.role === "string" &&
		record(value.to) &&
		typeof value.to.role === "string" &&
		typeof value.text === "string" &&
		integer(value.chain) &&
		value.chain >= 1 &&
		["question", "request", "reply", "fyi", "report"].includes(String(value.kind))
	);
}
export interface GuardLegacyFile {
	readonly v: 1;
	readonly paused: boolean;
	readonly resumedAt?: number;
	readonly messages: readonly RoleMessageRecord[];
}
function legacyIsValid(value: unknown): value is GuardLegacyFile {
	return (
		record(value) &&
		value.v === 1 &&
		typeof value.paused === "boolean" &&
		(value.resumedAt === undefined || integer(value.resumedAt)) &&
		Array.isArray(value.messages) &&
		value.messages.every(legacyMessageIsValid)
	);
}
export type GuardFileBoundary =
	`${"prepare" | "commit" | "legacy" | "bootstrap"}:${"write" | "flush" | "rename" | "directory_flush"}`;
export interface GuardFileStoreOptions {
	readonly journalPath: string;
	readonly legacyPath: string;
	readonly maximumBytes: number;
	/** Real host lease required. No local mutex can stand in for the legacy writer boundary. */
	readonly withExclusive: <T>(work: () => Promise<T>) => Promise<T>;
	/** Failure-injection only; production should pass null. Never performs a host effect. */
	readonly boundary: ((boundary: GuardFileBoundary) => void | Promise<void>) | null;
}
interface Bundle {
	format: "role-message-guard-journal/v1";
	stage: "prepared" | "committed";
	state: GuardStoreState;
	legacy: GuardLegacyFile;
	beforeLegacyDigest: string;
	identity: GuardOperationIdentity | null;
	reservation: GuardReservation | null;
	result: Exclude<GuardResult, { readonly state: "unknown" }> | null;
	checksum: string;
}
function checksum(bundle: Omit<Bundle, "checksum">): Bundle {
	return { ...bundle, checksum: guardDigest(bundle) };
}
/** knownBodyDigest: only for a text this store just composed from sortedJson parts, whose body digest is the hash
 * of its own body text (sortedJson gives the same text again after a JSON round trip). Every other text is
 * re-digested in full. */
function decode(raw: string, knownBodyDigest?: string): Bundle {
	const value: unknown = JSON.parse(raw);
	if (!record(value)) throw new Error("invalid guard journal");
	const { checksum: actual, ...body } = value;
	if (
		actual !== (knownBodyDigest ?? guardDigest(body)) ||
		body.format !== "role-message-guard-journal/v1" ||
		!["prepared", "committed"].includes(String(body.stage)) ||
		!guardStateIsValid(body.state) ||
		!legacyIsValid(body.legacy) ||
		typeof body.beforeLegacyDigest !== "string" ||
		!safeJson(body)
	)
		throw new Error("corrupt guard journal or unsupported schema");
	const bundle = value as unknown as Bundle;
	if (
		bundle.identity !== null &&
		(!bundle.identity.operationId || !bundle.identity.fingerprint || !bundle.result || !bundle.reservation)
	)
		throw new Error("incomplete guard transaction");
	for (const entry of bundle.state.outbox) {
		const canonical = bundle.legacy.messages.find((m) => m.id === entry.message.id);
		if (
			!canonical ||
			guardDigest(canonical) !== guardDigest(entry.message) ||
			entry.receipt.legacyMessageDigest !== guardDigest(entry.message)
		)
			throw new Error("unbound canonical accepted message");
	}
	return bundle;
}
/** Read-only views: the store hands a decoded bundle out again only while its file text is unchanged. */
function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
}
function errorText(error: unknown): string {
	return error instanceof Error ? error.message : "unknown persistence error";
}
function reservation(mutation: GuardAtomicMutation): GuardReservation {
	const r = mutation.result;
	if (r.state === "accepted") {
		const entry = mutation.next.outbox.find((o) => o.receipt.outboxId === r.receipt.outboxId);
		return {
			preparedAt: r.receipt.committedAt,
			origin: r.receipt.identity.actor.role,
			destination: entry?.message.to.role ?? null,
			grantId: mutation.next.grants.find((g) => g.useTransactionIds.includes(r.receipt.transactionId))?.id ?? null,
			incidentIdentityDigest: mutation.next.incidents.find(
				(i) => i.initialTransactionId === r.receipt.transactionId || i.resultTransactionId === r.receipt.transactionId,
			)
				? guardDigest(
						mutation.next.incidents.find(
							(i) =>
								i.initialTransactionId === r.receipt.transactionId || i.resultTransactionId === r.receipt.transactionId,
						)!.identity,
					)
				: null,
			requestGenerationKey: r.receipt.class === "control" ? r.receipt.dispatchKey : null,
			usage: r.receipt.usage,
			initialIncidentSlot: r.receipt.usage.newIncidentOrigin === 1,
			terminalIncidentSlot: mutation.next.incidents.some((i) => i.resultTransactionId === r.receipt.transactionId),
		};
	}
	return {
		preparedAt: mutation.next.lastTrustedTime,
		origin: r.state === "recorded" ? r.request.binding.requester.role : "",
		destination: null,
		grantId: null,
		incidentIdentityDigest: null,
		requestGenerationKey: r.state === "recorded" ? guardDigest(r.request.binding) : null,
		usage: null,
		initialIncidentSlot: false,
		terminalIncidentSlot: false,
	};
}

export class GuardFileStore implements GuardStorePort {
	private fenced: string | null = null;
	private recovered = false;
	// #122 H-ROLE-LADDER-PERF-1: decode and digest are pure functions of the file text. The files are still read on
	// every call; only a byte-identical text reuses the result it already gave.
	private lastJournal: { raw: string; bundle: Bundle } | null = null;
	private lastCanonical: { raw: string; digest: string } | null = null;
	private readonly legacyDigests = new WeakMap<GuardLegacyFile, string>();
	private legacyDigest(legacy: GuardLegacyFile): string {
		let digest = this.legacyDigests.get(legacy);
		if (digest === undefined) {
			digest = guardDigest(legacy);
			if (Object.isFrozen(legacy)) this.legacyDigests.set(legacy, digest);
		}
		return digest;
	}
	constructor(private readonly options: GuardFileStoreOptions) {
		if (
			!isAbsolute(options.journalPath) ||
			!isAbsolute(options.legacyPath) ||
			resolve(options.journalPath) === resolve(options.legacyPath) ||
			!integer(options.maximumBytes) ||
			options.maximumBytes < 1 ||
			typeof options.withExclusive !== "function"
		)
			throw new Error("explicit absolute paths, byte capacity and exclusive lease required");
	}
	private async raw(path: string): Promise<string | null> {
		try {
			const file = await open(path, "r");
			try {
				if ((await file.stat()).size > this.options.maximumBytes) throw new Error("guard file capacity exceeded");
				return await file.readFile("utf8");
			} finally {
				await file.close();
			}
		} catch (e) {
			if (record(e) && e.code === "ENOENT") return null;
			throw e;
		}
	}
	private async durable(
		path: string,
		value: unknown,
		phase: "prepare" | "commit" | "legacy" | "bootstrap",
		data: string = JSON.stringify(value),
	): Promise<string> {
		if (Buffer.byteLength(data, "utf8") > this.options.maximumBytes) throw new Error("guard file capacity exceeded");
		const temporary = `${path}.guard-${randomBytes(12).toString("hex")}.tmp`;
		try {
			const file = await open(temporary, "wx", 0o600);
			try {
				await this.options.boundary?.(`${phase}:write`);
				await file.writeFile(data, "utf8");
				await this.options.boundary?.(`${phase}:flush`);
				await file.sync();
			} finally {
				await file.close();
			}
			await this.options.boundary?.(`${phase}:rename`);
			await rename(temporary, path);
			await this.options.boundary?.(`${phase}:directory_flush`);
			const directory = await open(dirname(path), "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
			return data;
		} finally {
			// Own temporary file only. Never remove a journal, accepted record or lock on error.
			await unlink(temporary).catch(() => {});
		}
	}
	private async load(): Promise<Bundle> {
		const raw = await this.raw(this.options.journalPath);
		if (raw === null) throw new Error("guard journal missing; explicit bootstrap/recovery required");
		if (this.lastJournal?.raw === raw) return this.lastJournal.bundle;
		this.lastJournal = null;
		const bundle = deepFreeze(decode(raw));
		this.lastJournal = { raw, bundle };
		return bundle;
	}
	private async canonicalDigest(): Promise<string> {
		const raw = await this.raw(this.options.legacyPath);
		if (raw === null) return "absent";
		if (this.lastCanonical?.raw === raw) return this.lastCanonical.digest;
		this.lastCanonical = null;
		const legacy: unknown = JSON.parse(raw);
		if (!legacyIsValid(legacy)) throw new Error("invalid canonical legacy file");
		const digest = guardDigest(legacy);
		this.lastCanonical = { raw, digest };
		return digest;
	}
	private async ready(bundle: Bundle): Promise<boolean> {
		return bundle.stage === "committed" && (await this.canonicalDigest()) === this.legacyDigest(bundle.legacy);
	}
	/** Explicit create-only bootstrap. Does not accept a stale snapshot or open the user's store. */
	async initialize(state: GuardStoreState, legacy: GuardLegacyFile): Promise<GuardReadResult> {
		return this.options.withExclusive(async () => {
			try {
				if ((await this.raw(this.options.journalPath)) !== null)
					return { state: "unavailable", reason: "journal already exists; bootstrap is never reset" };
				if (!guardStateIsValid(state) || !legacyIsValid(legacy))
					return { state: "unavailable", reason: "invalid explicit bootstrap" };
				const before = await this.canonicalDigest();
				if (before !== "absent" && before !== guardDigest(legacy))
					return { state: "unknown", reason: "bootstrap legacy projection mismatch" };
				// Initial usage must include every canonical non-report within the retained rolling window.
				for (const message of legacy.messages) {
					if (message.kind === "report") continue;
					if (message.at > state.lastTrustedTime) throw new Error("bootstrap future legacy timestamp");
					if (
						state.lastTrustedTime - message.at < 3600000 &&
						!state.usage.some(
							(u) =>
								u.transactionId === message.id &&
								u.committedAt === message.at &&
								u.origin === message.from.role &&
								u.destination === message.to.role,
						) &&
						!state.outbox.some(
							(o) =>
								o.message.id === message.id && state.usage.some((u) => u.transactionId === o.receipt.transactionId),
						)
					)
						throw new Error("bootstrap omitted ordinary legacy charge");
				}
				const bundle = checksum({
					format: "role-message-guard-journal/v1",
					stage: "committed",
					state,
					legacy,
					beforeLegacyDigest: before,
					identity: null,
					reservation: null,
					result: null,
				});
				const text = sortedJson(bundle);
				decode(text);
				await this.durable(this.options.journalPath, bundle, "bootstrap", text);
				await this.durable(this.options.legacyPath, legacy, "legacy", sortedJson(legacy));
				this.recovered = true;
				this.fenced = null;
				return { state: "ready", value: structuredClone(state) };
			} catch (e) {
				this.fenced = errorText(e);
				return { state: "unknown", reason: this.fenced };
			}
		});
	}
	async read(): Promise<GuardReadResult> {
		return this.options.withExclusive(async () => {
			try {
				if (!this.recovered || this.fenced)
					return { state: "unknown", reason: this.fenced ?? "explicit startup recovery required" };
				const bundle = await this.load();
				if (!(await this.ready(bundle)))
					return { state: "unknown", reason: "prepared transaction or incomplete/divergent canonical publication" };
				return { state: "ready", value: structuredClone(bundle.state) };
			} catch (e) {
				return { state: "unknown", reason: errorText(e) };
			}
		});
	}
	async recover(): Promise<GuardReadResult> {
		return this.options.withExclusive(async () => {
			try {
				const bundle = await this.load();
				if (bundle.stage === "prepared")
					return { state: "unknown", reason: "prepared reservation held; no speculative commit/refund/retry" };
				const canonical = await this.canonicalDigest();
				if (canonical !== this.legacyDigest(bundle.legacy) && canonical !== bundle.beforeLegacyDigest)
					return { state: "unknown", reason: "legacy writer divergence; refusing stale snapshot overwrite" };
				// Reflush the exact commit before repair/ack: a visible rename alone is not a durable receipt.
				await this.durable(this.options.journalPath, bundle, "commit", sortedJson(bundle));
				await this.durable(this.options.legacyPath, bundle.legacy, "legacy", sortedJson(bundle.legacy));
				this.fenced = null;
				this.recovered = true;
				return { state: "ready", value: structuredClone(bundle.state) };
			} catch (e) {
				this.fenced = errorText(e);
				return { state: "unknown", reason: this.fenced };
			}
		});
	}
	private lookupIn(bundle: Bundle, identity: GuardOperationIdentity): GuardLookupResult {
		if (bundle.identity && bundle.identity.operationId === identity.operationId && bundle.stage === "prepared") {
			return {
				state: "found",
				result: {
					state: "unknown",
					identity,
					transactionId: guardTransactionId(bundle.identity),
					reservation: "held",
					retry: "query_same_identity_only",
					reason: sameIdentity(bundle.identity, identity)
						? "prepared reservation held"
						: "prepared identity conflict; reservation held",
				},
			};
		}
		const prior = bundle.state.transactions.find((t) => t.identity.operationId === identity.operationId);
		if (prior) {
			if (!sameIdentity(prior.identity, identity))
				return {
					state: "found",
					result: { state: "blocked", reason: "identity_conflict", request: null, requiredTier: null, accepted: false },
				};
			if (prior.state === "committed") return { state: "found", result: structuredClone(prior.result) };
			return {
				state: "found",
				result: {
					state: "unknown",
					identity,
					transactionId: prior.transactionId,
					reservation: "held",
					retry: "query_same_identity_only",
					reason: "unsettled reservation held",
				},
			};
		}
		if (bundle.state.tombstones.some((t) => t.kind === "operation" && t.identityDigest === guardOperationKey(identity)))
			return { state: "unknown", reason: "pruned operation is not authoritatively absent" };
		if (bundle.stage === "prepared") return { state: "unknown", reason: "store quarantined by prepared reservation" };
		return { state: "absent", authoritative: true };
	}
	async lookup(identity: GuardOperationIdentity): Promise<GuardLookupResult> {
		return this.options.withExclusive(async () => {
			try {
				if (!this.recovered || this.fenced)
					return { state: "unknown", reason: this.fenced ?? "explicit startup recovery required" };
				const bundle = await this.load();
				if (bundle.stage === "committed" && !(await this.ready(bundle)))
					return { state: "unknown", reason: "canonical publication not proved" };
				return this.lookupIn(bundle, identity);
			} catch (e) {
				return { state: "unknown", reason: errorText(e) };
			}
		});
	}
	async transact(
		identity: GuardOperationIdentity,
		update: (current: GuardStoreState) => Promise<GuardAtomicMutation>,
	): Promise<GuardCommitResult> {
		return this.options.withExclusive(async () => {
			let beganPrepare = false;
			try {
				if (!this.recovered || this.fenced)
					return {
						state: "unknown",
						transactionId: null,
						reservation: "held",
						reason: this.fenced ?? "explicit startup recovery required",
					};
				const current = await this.load();
				if (!(await this.ready(current)))
					return {
						state: "unknown",
						transactionId: current.identity ? guardTransactionId(current.identity) : null,
						reservation: "held",
						reason: "store not fully committed/published",
					};
				const prior = this.lookupIn(current, identity);
				if (prior.state === "found") {
					if (prior.result.state === "unknown")
						return {
							state: "unknown",
							transactionId: prior.result.transactionId,
							reservation: "held",
							reason: prior.result.reason,
						};
					return {
						state: "committed",
						transactionId: guardTransactionId(identity),
						revision: current.state.revision,
						result: prior.result,
					};
				}
				if (prior.state !== "absent")
					return {
						state: "unknown",
						transactionId: null,
						reservation: "held",
						reason: "operation replay provenance unavailable",
					};
				if (current.state.transactions.some((t) => t.state !== "committed"))
					return {
						state: "unknown",
						transactionId: null,
						reservation: "held",
						reason: "unsettled reservations quarantine writer",
					};
				const mutation = await update(structuredClone(current.state));
				if (!guardStateIsValid(mutation.next) || mutation.next.lastTrustedTime < current.state.lastTrustedTime)
					throw new Error("invalid mutation or time watermark regression");
				if (current.state.mode === "rollback_depth_6" && mutation.next.mode !== "rollback_depth_6")
					throw new Error("rollback mode cannot be resurrected");
				for (const grant of current.state.grants) {
					const nextGrant = mutation.next.grants.find((g) => g.id === grant.id);
					if (
						nextGrant &&
						(nextGrant.acceptedUses < grant.acceptedUses ||
							(grant.state === "revoked" && nextGrant.state !== "revoked"))
					)
						throw new Error("grant use/refusal cannot be reset");
				}
				// Request history is immutable at the single writer (Ops rm-1bb3c77b item 3): creation fields never change,
				// a recorded first answer (and its grant) is never reset or rewritten, and a request only leaves with its
				// replay tombstone. Only state, a still-null first decision and its grantId may move.
				for (const request of current.state.requests) {
					const requestId = request.binding.requestId;
					const generation = request.binding.generation;
					const kept = mutation.next.requests.find(
						(r) => r.binding.requestId === requestId && r.binding.generation === generation,
					);
					const replayKey = guardDigest({ requestId, generation });
					if (!kept) {
						if (!mutation.next.tombstones.some((t) => t.kind === "request" && t.identityDigest === replayKey))
							throw new Error("request history cannot leave without its tombstone");
						continue;
					}
					const { state: _s, firstDecision: _f, grantId: _g, ...created } = request;
					const { state: _ks, firstDecision: _kf, grantId: _kg, ...keptCreated } = kept;
					if (
						guardDigest(created) !== guardDigest(keptCreated) ||
						(request.firstDecision !== null &&
							(guardDigest(kept.firstDecision) !== guardDigest(request.firstDecision) ||
								kept.grantId !== request.grantId))
					)
						throw new Error("request history cannot be rewritten");
				}
				const nextUsage = new Set(mutation.next.usage.map((u) => guardDigest(u)));
				for (const usage of current.state.usage)
					if (mutation.next.lastTrustedTime - usage.committedAt < 3600000 && !nextUsage.has(guardDigest(usage)))
						throw new Error("recent accepted charge cannot be removed");
				// #122 (Ops rm-fc4b9788): only a tombstone whose verified end has passed may leave.
				const nextTombstones = new Set(mutation.next.tombstones.map((t) => guardDigest(t)));
				for (const tombstone of current.state.tombstones)
					if (
						!(
							typeof tombstone.invalidThrough === "number" && tombstone.invalidThrough <= mutation.next.lastTrustedTime
						) &&
						!nextTombstones.has(guardDigest(tombstone))
					)
						throw new Error("replay tombstone cannot be reset");
				const messages = current.legacy.messages.map((m) => {
					const entry = mutation.next.outbox.find((o) => o.message.id === m.id);
					if (!entry || guardDigest(entry.message) === guardDigest(m)) return m;
					// Sole-writer progress publication. No changed words, cause, sender, routing or Owner metadata.
					const { state: _oldState, deliveredAt: _oldAt, sends: _oldSends, ...before } = m;
					const { state: _newState, deliveredAt: _newAt, sends: _newSends, ...after } = entry.message;
					if (
						guardDigest(before) !== guardDigest(after) ||
						m.state !== "waiting" ||
						entry.message.state !== "delivered" ||
						!entry.lastEvidence ||
						!integer(entry.message.deliveredAt) ||
						entry.message.sends !== m.sends + 1
					)
						throw new Error("unauthorised canonical progress mutation");
					return entry.message;
				});
				for (const message of mutation.legacyAccepted) {
					if (!legacyMessageIsValid(message) || !["question", "request", "reply", "fyi"].includes(message.kind))
						throw new Error("invalid canonical accepted record");
					const previous = messages.find((m) => m.id === message.id);
					if (previous && guardDigest(previous) !== guardDigest(message))
						throw new Error("canonical message identity conflict");
					if (!previous) messages.push(structuredClone(message));
				}
				if (mutation.result.state === "accepted") {
					// Keep results and legacy record inseparable, including metadata.
					const result = mutation.result;
					if (
						!messages.some(
							(m) => m.id === result.receipt.messageId && guardDigest(m) === result.receipt.legacyMessageDigest,
						) ||
						!mutation.next.usage.some((u) => u.transactionId === result.receipt.transactionId)
					)
						throw new Error("acceptance missing canonical words or charge");
				}
				const body: Omit<Bundle, "checksum"> = {
					format: "role-message-guard-journal/v1",
					stage: "prepared",
					state: mutation.next,
					legacy: { ...current.legacy, messages },
					beforeLegacyDigest: this.legacyDigest(current.legacy),
					identity,
					reservation: reservation(mutation),
					result: mutation.result,
				};
				// PERF-2: each field written once; the prepared and committed texts (and their checksums) are built from
				// the same parts and equal sortedJson of their bundles (a store test holds the written files to that).
				const parts: Record<string, string | undefined> = {};
				for (const [key, value] of Object.entries(body))
					parts[key] = value === undefined ? undefined : sortedJson(value);
				const preparedChecksum = sha256(composeSorted(parts));
				const prepared = composeSorted({ ...parts, checksum: JSON.stringify(preparedChecksum) });
				if (Buffer.byteLength(prepared, "utf8") > this.options.maximumBytes)
					return { state: "not_committed", reason: "retention_capacity" };
				// The full structural check on what will be written (parsed once; its digest is known by construction).
				const checked = decode(prepared, preparedChecksum);
				beganPrepare = true;
				await this.durable(this.options.journalPath, null, "prepare", prepared);
				const commitParts = { ...parts, stage: JSON.stringify("committed") };
				const commitChecksum = sha256(composeSorted(commitParts));
				const committed = await this.durable(
					this.options.journalPath,
					null,
					"commit",
					composeSorted({ ...commitParts, checksum: JSON.stringify(commitChecksum) }),
				);
				// Files in sorted order: the same accepted words always give the same bytes, whoever wrote them last.
				const legacyText = parts.legacy!;
				const published = await this.durable(this.options.legacyPath, null, "legacy", legacyText);
				// PERF-1/2: the next read of these exact texts reuses what was just checked: the commit is the checked
				// prepare with only its stage and fresh checksum changed. Any other text is decoded in full as before.
				const kept = deepFreeze({ ...checked, stage: "committed", checksum: commitChecksum } as Bundle);
				const legacyDigest = sha256(legacyText);
				this.legacyDigests.set(kept.legacy, legacyDigest);
				this.lastJournal = { raw: committed, bundle: kept };
				this.lastCanonical = { raw: published, digest: legacyDigest };
				return {
					state: "committed",
					transactionId: guardTransactionId(identity),
					revision: mutation.next.revision,
					result: structuredClone(mutation.result),
				};
			} catch (e) {
				const reason = errorText(e);
				if (!beganPrepare) return { state: "not_committed", reason };
				this.fenced = reason;
				return { state: "unknown", transactionId: guardTransactionId(identity), reservation: "held", reason };
			}
		});
	}
}
