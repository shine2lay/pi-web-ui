/** Inert component E. No default path, instance, bootstrap, registration or live I/O on import.
 * The supplied exclusive lease MUST cover ALL legacy writers, not just instances of this class.
 * A checksummed prepare is never acceptance. The commit bundle binds state + exact legacy words;
 * acknowledgment waits for canonical publication/flush. Unknown prepares are quarantined, not refunded.
 */
import { createHash, type Hash, randomBytes } from "node:crypto";
import { type FileHandle, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { types } from "node:util";
import type { GuardOperationIdentity, GuardOutboxEntry, GuardReservation } from "./role-message-guard-contract.js";
import type {
	GuardAtomicMutationAny,
	GuardCommitResultAny,
	GuardLookupResultAny,
	GuardReadResultAny,
	GuardResultAny,
	GuardStorePortAny,
	GuardStoreStateAny,
} from "./role-message-guard-contract-v2.js";
import type { RoleMessageRecord } from "./role-messages.js";
import {
	guardBindingBoundsValid,
	guardPolicyFor,
	guardQuantityValid,
	guardRequestRevisionValid,
} from "./role-message-limits.js";

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
function sha256(text: string | Buffer): string {
	return createHash("sha256").update(text).digest("hex"); // a string is hashed as its UTF-8 bytes
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
// Ops #233 H-GUARD-STORE-PERF-1 (2): facts about the items this store made itself. Each was parsed back from its own
// sortedJson text (so it is already in canonical form: plain objects, sorted keys, no undefined, no -0) and deep-frozen,
// and can't change, so what was checked about it is kept with it and the next transaction may take it over as it is.
// Nothing parsed from disk is ever here: whatever the store reads that it didn't just write is decoded and verified in
// full, as before.
interface Made {
	/** The array it was made for ("outbox.message" for an outbox entry's words); a check is kept for that role only. */
	readonly role: string;
	/** H-GUARD-STORE-PERF-1 (3): the UTF-8 bytes of its sortedJson text, what the store writes for it (not kept for an
	 * outbox entry's words, which are written as part of their entry). */
	readonly bytes?: Buffer;
	safe?: boolean;
	valid?: boolean;
	digest?: string;
}
const made = new WeakMap<object, Made>();
function facts(value: unknown, role?: string): Made | undefined {
	const f = value !== null && typeof value === "object" ? made.get(value) : undefined;
	return role === undefined || f?.role === role ? f : undefined;
}
function remember(item: object, role: string, bytes: Buffer): void {
	made.set(item, { role, bytes });
	const words = role === "outbox" ? (item as { message?: unknown }).message : undefined;
	if (record(words)) made.set(words, { role: "outbox.message" });
}
/** guardDigest; a store-made item's digest is kept with it. */
function digestOf(value: unknown): string {
	const f = facts(value);
	if (!f) return guardDigest(value);
	return (f.digest ??= f.bytes ? sha256(f.bytes) : guardDigest(value)); // a text's hash is its UTF-8 bytes' hash
}
function safeJson(value: unknown): boolean {
	if (typeof value === "number") return integer(value);
	if (Array.isArray(value)) return value.every(safeItem);
	if (record(value)) return Object.values(value).every(safeJson);
	return value === null || typeof value === "string" || typeof value === "boolean";
}
/** safeJson of an array item; a store-made item's answer is kept with it. */
function safeItem(value: unknown): boolean {
	const f = facts(value);
	return f ? (f.safe ??= safeJson(value)) : safeJson(value);
}
type StateArray = "requests" | "grants" | "incidents" | "usage" | "transactions" | "outbox" | "audits" | "tombstones";
const stateArrays: readonly StateArray[] = [
	"requests",
	"grants",
	"incidents",
	"usage",
	"transactions",
	"outbox",
	"audits",
	"tombstones",
];
/** Each state array's item check, in the order guardStateIsValid has always run them. */
const itemChecks: { readonly [K in StateArray]: (item: GuardStoreStateAny[K][number]) => boolean } = {
	requests: (r) =>
		guardRequestRevisionValid(r) &&
		!!r.binding.requestId &&
		!!r.binding.generation &&
		integer(r.createdAt) &&
		integer(r.expiresAt),
	grants: (g) =>
		!!g.id &&
		integer(g.issuedAt) &&
		integer(g.expiresAt) &&
		integer(g.acceptedUses) &&
		guardBindingBoundsValid(g.binding) &&
		guardQuantityValid(g.maximumUses, g.binding.version) &&
		g.maximumUses === g.binding.quantity &&
		g.acceptedUses <= g.maximumUses &&
		Array.isArray(g.useTransactionIds),
	incidents: (i) => !!i.identity.nativeEpisodeId && integer(i.identity.openedAt) && integer(i.identity.expiresAt),
	usage: (u) =>
		!!u.transactionId &&
		integer(u.committedAt) &&
		!!u.origin &&
		!!u.destination &&
		u.usage.ordinaryOrigin === 1 &&
		Object.values(u.usage).every((n) => n === 0 || n === 1),
	transactions: (t) =>
		!!t.transactionId &&
		!!t.identity.operationId &&
		!!t.identity.fingerprint &&
		["prepared", "committed", "unknown"].includes(t.state) &&
		(t.state === "committed"
			? resultRevisionCompatible(t.result, "role-message-guard/v2")
			: integer(t.reservation.preparedAt)),
	outbox: (o) =>
		!!o.receipt.transactionId &&
		!!o.receipt.messageId &&
		!!o.receipt.dispatchKey &&
		!!o.receipt.wakeKey &&
		legacyMessageIsValid(o.message),
	audits: (a) => !!a.id && !!a.transactionId && integer(a.at),
	tombstones: (t) => !!t.identityDigest && (t.invalidThrough === "source_horizon_unknown" || integer(t.invalidThrough)),
};
/** One array's item checks; a store-made item's answer is kept with it. A check that throws fails, as the try around
 * all of them in guardStateIsValid makes it. */
function itemsValid(state: GuardStoreStateAny, key: StateArray): boolean {
	const check = itemChecks[key] as (item: unknown) => boolean;
	return (state[key] as readonly unknown[]).every((item) => {
		const f = facts(item, key);
		if (!f) return check(item);
		if (f.valid === undefined) {
			try {
				f.valid = check(item);
			} catch {
				f.valid = false;
			}
		}
		return f.valid;
	});
}
/** The journal/operation ABI stays V1, but it must never hide a V2 request in a V1 policy envelope. */
function resultRevisionCompatible(result: unknown, version: GuardStoreStateAny["version"]): boolean {
	if (!record(result)) return false;
	if (result.state === "accepted") return true; // policy-neutral original receipt ABI
	if (result.state !== "recorded" && result.state !== "blocked") return false;
	if (result.request === null) return result.state === "blocked";
	return (
		guardRequestRevisionValid(result.request) &&
		(version === "role-message-guard/v2" || result.request.binding.version === version)
	);
}

/** Distribute the complete ready envelope; never erase the nested S1/S2 correlation. */
function readyState(value: GuardStoreStateAny): Extract<GuardReadResultAny, { readonly state: "ready" }> {
	if (value.version === "role-message-guard/v1") return { state: "ready", value };
	return { state: "ready", value };
}

/** Structural decoding only; every restored authority/evidence is reverified by the host before use. */
export function guardStateIsValid(value: unknown): value is GuardStoreStateAny {
	if (
		!record(value) ||
		!safeJson(value) ||
		!guardPolicyFor(value.version) ||
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
	const s = value as unknown as GuardStoreStateAny;
	try {
		return (
			stateArrays.every((key) => itemsValid(s, key)) &&
			(s.version === "role-message-guard/v2" ||
				([...s.requests, ...s.grants].every((r) => r.binding.version === "role-message-guard/v1") &&
					s.transactions.every((t) => t.state !== "committed" || resultRevisionCompatible(t.result, s.version))))
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
		value.messages.every(messageValid)
	);
}
/** legacyMessageIsValid of a canonical message; a store-made message's answer is kept with it. */
function messageValid(value: unknown): boolean {
	const f = facts(value, "messages");
	return f ? (f.valid ??= legacyMessageIsValid(value)) : legacyMessageIsValid(value);
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
	state: GuardStoreStateAny;
	legacy: GuardLegacyFile;
	beforeLegacyDigest: string;
	identity: GuardOperationIdentity | null;
	reservation: GuardReservation | null;
	result: Exclude<GuardResultAny, { readonly state: "unknown" }> | null;
	checksum: string;
}
function checksum(bundle: Omit<Bundle, "checksum">): Bundle {
	return { ...bundle, checksum: guardDigest(bundle) };
}
/** knownBodyDigest: only for a text this store just composed from sortedJson parts, whose body digest is the hash
 * of its own body text (sortedJson gives the same text again after a JSON round trip). Every other text is
 * re-digested in full. */
function decode(raw: string, knownBodyDigest?: string): Bundle {
	return verify(JSON.parse(raw), knownBodyDigest);
}
/** decode's checks on a parsed value, or (Ops #233 H-GUARD-STORE-PERF-1 (2)) on assemble()'s value for a text this
 * store just composed, which equals the text's parse. Same checks, order and messages as decode always had. */
function verify(value: unknown, knownBodyDigest?: string): Bundle {
	if (!record(value)) throw new Error("invalid guard journal");
	const { checksum: actual, ...body } = value;
	if (
		actual !== (knownBodyDigest ?? guardDigest(body)) ||
		body.format !== "role-message-guard-journal/v1" ||
		!["prepared", "committed"].includes(String(body.stage)) ||
		!guardStateIsValid(body.state) ||
		(body.result !== null && !resultRevisionCompatible(body.result, body.state.version)) ||
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
	// The first message with each id, as find() gave it: a parsed or assembled list has no holes, and legacyIsValid
	// above holds every message to a record with a string id.
	const canonicalById = new Map<string, RoleMessageRecord>();
	const canonicals = bundle.legacy.messages;
	for (let i = 0; i < canonicals.length; i++)
		if (!canonicalById.has(canonicals[i].id)) canonicalById.set(canonicals[i].id, canonicals[i]);
	for (const entry of bundle.state.outbox) {
		const canonical = canonicalById.get(entry.message.id);
		if (
			!canonical ||
			digestOf(canonical) !== digestOf(entry.message) ||
			entry.receipt.legacyMessageDigest !== digestOf(entry.message)
		)
			throw new Error("unbound canonical accepted message");
	}
	return bundle;
}
/** Ops #253 (Architecture A3): the journal holds a prepared transaction (a send stopped between its prepare and its
 * commit). The one test for it, so the fresh start's refusal, recover() and the lookups can't come to disagree. */
function holdsPrepared(bundle: Bundle): boolean {
	return bundle.stage === "prepared";
}
/** Ops #248 (Architecture S1): why the operator's fresh start (docs/role-message-fresh-start.md) must not start over
 * from this journal text, or null for a committed journal that decodes. One holding a prepared send names its
 * operation; text that doesn't decode gives decode's reason. Reads and writes nothing. */
export function guardJournalRefusal(raw: string): string | null {
	let bundle: Bundle;
	try {
		bundle = decode(raw);
	} catch (e) {
		return `the journal can't be parsed (${errorText(e)})`;
	}
	return holdsPrepared(bundle)
		? `the journal holds a prepared send (operation ${bundle.identity?.operationId ?? "unknown"})`
		: null;
}
/** Read-only views: the store hands a decoded bundle out again only while its file text is unchanged. */
function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
}
/** Ops #233 H-GUARD-STORE-PERF-1 (2): true when value is plain JSON data that reads back the same every time, so
 * sortedJson of it gives again the very text it gave a moment ago: no proxy, accessor, symbol key, hole, extra array
 * key, function or other non-JSON value, and only plain prototypes. Anything else is left to the old full parse. */
function plainData(value: unknown, depth = 0): boolean {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
		return true;
	if (typeof value !== "object" || depth > 256 || types.isProxy(value)) return false;
	const proto: unknown = Object.getPrototypeOf(value);
	const array = Array.isArray(value);
	if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return false;
	const keys = Reflect.ownKeys(value);
	if (array && keys.length !== (value as unknown[]).length + 1) return false;
	for (const key of keys) {
		if (typeof key !== "string") return false;
		if (array && key === "length") continue;
		const d = Object.getOwnPropertyDescriptor(value, key)!;
		if (!("value" in d) || !d.enumerable) return false;
		if (d.value === undefined) continue; // JSON leaves it out of an object and writes null in an array, as parse reads
		if (!plainData(d.value, depth + 1)) return false;
	}
	return true;
}
const OPEN_OBJECT = Buffer.from("{");
const CLOSE_OBJECT = Buffer.from("}");
const OPEN_ARRAY = Buffer.from("[");
const CLOSE_ARRAY = Buffer.from("]");
const COMMA = Buffer.from(",");
const NULL_TEXT = Buffer.from("null");
/** The text of a key and its colon, after a comma unless it is the first key. */
function keyBytes(key: string, first: boolean): Buffer {
	return Buffer.from(`${first ? "" : ","}${JSON.stringify(key)}:`, "utf8");
}
/** An array of the parse of each item's text in sortedJson(items): a store-made item of the same array (role) as it
 * is, at most once per bundle (a parse never shares an object), any other plain item as the parse of its own text.
 * Appends the UTF-8 bytes of sortedJson(items) to chunks (H-GUARD-STORE-PERF-1 (3)): sortedJson of an array is its
 * items' own texts in brackets, comma-separated, with null for undefined. null when an item or the array isn't plain
 * data. */
function assembleItems(items: unknown, role: string, used: Set<object>, chunks: Buffer[]): unknown[] | null {
	if (!Array.isArray(items) || types.isProxy(items) || Object.getPrototypeOf(items) !== Array.prototype) return null;
	const out: unknown[] = [];
	chunks.push(OPEN_ARRAY);
	for (let i = 0; i < items.length; i++) {
		const d = Object.getOwnPropertyDescriptor(items, i);
		if (!d || !("value" in d)) return null; // a hole or an accessor
		const item: unknown = d.value;
		if (i > 0) chunks.push(COMMA);
		const f = facts(item, role);
		if (f?.bytes && !used.has(item as object)) {
			used.add(item as object);
			out.push(item);
			chunks.push(f.bytes);
			continue;
		}
		if (item === undefined) {
			out.push(null); // JSON writes it as null
			chunks.push(NULL_TEXT);
			continue;
		}
		if (!plainData(item)) return null;
		const text = sortedJson(item);
		const bytes = Buffer.from(text, "utf8");
		const fresh: unknown = deepFreeze(JSON.parse(text));
		if (fresh !== null && typeof fresh === "object") remember(fresh, role, bytes);
		out.push(fresh);
		chunks.push(bytes);
	}
	chunks.push(CLOSE_ARRAY);
	return out;
}
const stateRoles: ReadonlyMap<string, string> = new Map(stateArrays.map((key) => [key, key]));
const legacyRoles: ReadonlyMap<string, string> = new Map([["messages", "messages"]]);
/** The parse of sortedJson(value) for the state or legacy object: keys in the text's order, its arrays item by item.
 * Appends the UTF-8 bytes of sortedJson(value) to chunks: its fields' own texts after their keys, in braces. */
function assembleRecord(
	value: unknown,
	roles: ReadonlyMap<string, string>,
	used: Set<object>,
	chunks: Buffer[],
): Record<string, unknown> | null {
	if (!record(value) || types.isProxy(value)) return null;
	const proto: unknown = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return null;
	const keys = Reflect.ownKeys(value);
	for (const key of keys) {
		if (typeof key !== "string") return null;
		const d = Object.getOwnPropertyDescriptor(value, key)!;
		if (!("value" in d) || !d.enumerable) return null;
	}
	const entries: [string, unknown][] = [];
	const order = orderedKeys((keys as string[]).filter((k) => value[k] !== undefined));
	chunks.push(OPEN_OBJECT);
	for (let i = 0; i < order.length; i++) {
		const key = order[i];
		chunks.push(keyBytes(key, i === 0));
		const role = roles.get(key);
		if (role !== undefined && Array.isArray(value[key])) {
			const items = assembleItems(value[key], role, used, chunks);
			if (!items) return null;
			entries.push([key, items]);
		} else {
			if (!plainData(value[key])) return null;
			const text = sortedJson(value[key]);
			entries.push([key, JSON.parse(text)]);
			chunks.push(Buffer.from(text, "utf8"));
		}
	}
	chunks.push(CLOSE_OBJECT);
	return Object.fromEntries(entries); // own keys, __proto__ included, as a parse makes them
}
/** What a transaction writes: the prepared and committed journal bytes, the legacy file's bytes, their checksums and
 * digest, and the value the prepared text parses to. */
interface Written {
	readonly prepared: Buffer;
	readonly committed: Buffer;
	readonly legacy: Buffer;
	readonly preparedChecksum: string;
	readonly commitChecksum: string;
	readonly legacyDigest: string;
	readonly value: () => unknown;
}
/** The old way (#122 PERF-2): each field's sortedJson text, joined; the prepared text is parsed for its check. */
function composeText(body: Omit<Bundle, "checksum">): Written {
	const parts: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(body)) parts[key] = value === undefined ? undefined : sortedJson(value);
	const preparedChecksum = sha256(composeSorted(parts));
	const preparedText = composeSorted({ ...parts, checksum: JSON.stringify(preparedChecksum) });
	const commitParts = { ...parts, stage: JSON.stringify("committed") };
	const commitChecksum = sha256(composeSorted(commitParts));
	// Each text is turned into its UTF-8 bytes once (writing a string did the same).
	const legacy = Buffer.from(parts.legacy!, "utf8");
	return {
		prepared: Buffer.from(preparedText, "utf8"),
		committed: Buffer.from(composeSorted({ ...commitParts, checksum: JSON.stringify(commitChecksum) }), "utf8"),
		legacy,
		preparedChecksum,
		commitChecksum,
		legacyDigest: sha256(legacy), // the hash of a text is the hash of its UTF-8 bytes
		value: () => JSON.parse(preparedText),
	};
}
/** Ops #233 H-GUARD-STORE-PERF-1 (2, 3): what composeText gives, built item by item: each store-made item's kept
 * bytes instead of writing, encoding and parsing the whole state again. The same bytes: composeSorted joins each
 * field's sortedJson text, and sortedJson of a plain object or array joins its fields' or items' own texts the same
 * way (assembleRecord, assembleItems). The value is what a parse of the prepared text gives. null when anything isn't
 * plain data, before anything that could have a side effect is serialized: the caller then uses composeText. */
function compose(body: Omit<Bundle, "checksum">): Written | null {
	try {
		if (Object.hasOwn(Object.prototype, "toJSON") || Object.hasOwn(Array.prototype, "toJSON")) return null;
		const fields = body as unknown as Record<string, unknown>;
		const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
		if (!["stage", "state", "legacy"].every((k) => keys.includes(k))) return null;
		for (const key of keys) if (key !== "state" && key !== "legacy" && !plainData(fields[key])) return null;
		const used = new Set<object>();
		const values = new Map<string, unknown>();
		const bytes = new Map<string, Buffer>();
		for (const key of keys) {
			if (key === "state" || key === "legacy") {
				const chunks: Buffer[] = [];
				const made = assembleRecord(fields[key], key === "state" ? stateRoles : legacyRoles, used, chunks);
				if (!made) return null;
				values.set(key, made);
				bytes.set(key, Buffer.concat(chunks));
			} else {
				const text = sortedJson(fields[key]);
				values.set(key, JSON.parse(text));
				bytes.set(key, Buffer.from(text, "utf8"));
			}
		}
		// The two checksums share one pass over the body up to its stage, then go on with each stage's text.
		const committedStage = Buffer.from(JSON.stringify("committed"), "utf8");
		const order = orderedKeys(keys);
		const preparedHash = createHash("sha256").update(OPEN_OBJECT);
		let commitHash: Hash | null = null;
		for (let i = 0; i < order.length; i++) {
			const head = keyBytes(order[i], i === 0);
			preparedHash.update(head);
			commitHash?.update(head);
			if (order[i] === "stage") {
				commitHash = preparedHash.copy().update(committedStage);
				preparedHash.update(bytes.get("stage")!);
			} else {
				preparedHash.update(bytes.get(order[i])!);
				commitHash?.update(bytes.get(order[i])!);
			}
		}
		const preparedChecksum = preparedHash.update(CLOSE_OBJECT).digest("hex");
		const commitChecksum = commitHash!.update(CLOSE_OBJECT).digest("hex");
		const fileOrder = orderedKeys([...keys, "checksum"]);
		const file = (checksum: string, stage: Buffer): Buffer => {
			const chunks: Buffer[] = [OPEN_OBJECT];
			for (let i = 0; i < fileOrder.length; i++) {
				const key = fileOrder[i];
				chunks.push(keyBytes(key, i === 0));
				if (key === "checksum") chunks.push(Buffer.from(JSON.stringify(checksum), "utf8"));
				else chunks.push(key === "stage" ? stage : bytes.get(key)!);
			}
			chunks.push(CLOSE_OBJECT);
			return Buffer.concat(chunks);
		};
		const legacy = bytes.get("legacy")!;
		const value = Object.fromEntries(
			fileOrder.map((key) => [key, key === "checksum" ? preparedChecksum : values.get(key)] as const),
		);
		return {
			prepared: file(preparedChecksum, bytes.get("stage")!),
			committed: file(commitChecksum, committedStage),
			legacy,
			preparedChecksum,
			commitChecksum,
			legacyDigest: sha256(legacy),
			value: () => value,
		};
	} catch {
		return null;
	}
}
function errorText(error: unknown): string {
	return error instanceof Error ? error.message : "unknown persistence error";
}
function reservation(mutation: GuardAtomicMutationAny): GuardReservation {
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

export class GuardFileStore implements GuardStorePortAny {
	private fenced: string | null = null;
	private recovered = false;
	// #122 H-ROLE-LADDER-PERF-1: decode and digest are pure functions of the file text. The files are still read on
	// every call; only a byte-identical text reuses the result it already gave. Ops #233 H-GUARD-STORE-PERF-1 (2): the
	// files are compared as bytes (the same bytes are the same text), so a hit decodes no text at all.
	private lastJournal: { bytes: Buffer; bundle: Bundle } | null = null;
	private lastCanonical: { bytes: Buffer; digest: string } | null = null;
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
	private raw(path: string): Promise<string | null> {
		return this.contents(path, (file) => file.readFile("utf8"));
	}
	/** The file's bytes, read as raw() reads its text. */
	private bytes(path: string): Promise<Buffer | null> {
		return this.contents(path, (file) => file.readFile());
	}
	private async contents<T>(path: string, read: (file: FileHandle) => Promise<T>): Promise<T | null> {
		try {
			const file = await open(path, "r");
			try {
				if ((await file.stat()).size > this.options.maximumBytes) throw new Error("guard file capacity exceeded");
				return await read(file);
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
		data: string | Buffer = JSON.stringify(value),
	): Promise<string | Buffer> {
		// A string is written as its UTF-8 bytes; a Buffer (the UTF-8 bytes of a text) as it is: the same bytes.
		const size = typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.length;
		if (size > this.options.maximumBytes) throw new Error("guard file capacity exceeded");
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
		const bytes = await this.bytes(this.options.journalPath);
		if (bytes !== null && this.lastJournal?.bytes.equals(bytes)) return this.lastJournal.bundle;
		// Anything else is read as text and decoded in full, exactly as before.
		const raw = await this.raw(this.options.journalPath);
		if (raw === null) throw new Error("guard journal missing; explicit bootstrap/recovery required");
		this.lastJournal = null;
		const bundle = deepFreeze(decode(raw));
		this.lastJournal = { bytes: Buffer.from(raw, "utf8"), bundle };
		return bundle;
	}
	private async canonicalDigest(): Promise<string> {
		const bytes = await this.bytes(this.options.legacyPath);
		if (bytes === null) return "absent";
		if (this.lastCanonical?.bytes.equals(bytes)) return this.lastCanonical.digest;
		const raw = await this.raw(this.options.legacyPath);
		if (raw === null) return "absent";
		this.lastCanonical = null;
		const legacy: unknown = JSON.parse(raw);
		if (!legacyIsValid(legacy)) throw new Error("invalid canonical legacy file");
		const digest = guardDigest(legacy);
		this.lastCanonical = { bytes: Buffer.from(raw, "utf8"), digest };
		return digest;
	}
	private async ready(bundle: Bundle): Promise<boolean> {
		return bundle.stage === "committed" && (await this.canonicalDigest()) === this.legacyDigest(bundle.legacy);
	}
	/** Explicit create-only bootstrap. Does not accept a stale snapshot or open the user's store. */
	async initialize(state: GuardStoreStateAny, legacy: GuardLegacyFile): Promise<GuardReadResultAny> {
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
				return readyState(structuredClone(state));
			} catch (e) {
				this.fenced = errorText(e);
				return { state: "unknown", reason: this.fenced };
			}
		});
	}
	async read(): Promise<GuardReadResultAny> {
		return this.options.withExclusive(async () => {
			try {
				if (!this.recovered || this.fenced)
					return { state: "unknown", reason: this.fenced ?? "explicit startup recovery required" };
				const bundle = await this.load();
				if (!(await this.ready(bundle)))
					return { state: "unknown", reason: "prepared transaction or incomplete/divergent canonical publication" };
				// Ops #233 H-GUARD-STORE-PERF-1 (1): the bundle is deep-frozen, so a read hands out a fresh top level over
				// the frozen items instead of a whole copy; changing what a read returned still changes nothing stored.
				return readyState({ ...bundle.state });
			} catch (e) {
				return { state: "unknown", reason: errorText(e) };
			}
		});
	}
	async recover(): Promise<GuardReadResultAny> {
		return this.options.withExclusive(async () => {
			try {
				const bundle = await this.load();
				if (holdsPrepared(bundle))
					return { state: "unknown", reason: "prepared reservation held; no speculative commit/refund/retry" };
				const canonical = await this.canonicalDigest();
				if (canonical !== this.legacyDigest(bundle.legacy) && canonical !== bundle.beforeLegacyDigest)
					return { state: "unknown", reason: "legacy writer divergence; refusing stale snapshot overwrite" };
				// Reflush the exact commit before repair/ack: a visible rename alone is not a durable receipt.
				await this.durable(this.options.journalPath, bundle, "commit", sortedJson(bundle));
				await this.durable(this.options.legacyPath, bundle.legacy, "legacy", sortedJson(bundle.legacy));
				this.fenced = null;
				this.recovered = true;
				return readyState(structuredClone(bundle.state));
			} catch (e) {
				this.fenced = errorText(e);
				return { state: "unknown", reason: this.fenced };
			}
		});
	}
	private lookupIn(bundle: Bundle, identity: GuardOperationIdentity): GuardLookupResultAny {
		if (bundle.identity && bundle.identity.operationId === identity.operationId && holdsPrepared(bundle)) {
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
		let pruned: string | undefined; // H-GUARD-STORE-PERF-1 (2): worked out once, at the first operation tombstone
		if (
			bundle.state.tombstones.some(
				(t) => t.kind === "operation" && t.identityDigest === (pruned ??= guardOperationKey(identity)),
			)
		)
			return { state: "unknown", reason: "pruned operation is not authoritatively absent" };
		if (holdsPrepared(bundle)) return { state: "unknown", reason: "store quarantined by prepared reservation" };
		return { state: "absent", authoritative: true };
	}
	async lookup(identity: GuardOperationIdentity): Promise<GuardLookupResultAny> {
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
		update: (current: GuardStoreStateAny) => Promise<GuardAtomicMutationAny>,
	): Promise<GuardCommitResultAny> {
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
				// H-GUARD-STORE-PERF-1 (1): the update gets a fresh top level over the deep-frozen items (it copies what it
				// changes; see mutable() in the core), not a whole copy of the state.
				const mutation = await update({ ...current.state });
				if (
					!guardStateIsValid(mutation.next) ||
					!resultRevisionCompatible(mutation.result, mutation.next.version) ||
					mutation.next.lastTrustedTime < current.state.lastTrustedTime
				)
					throw new Error("invalid mutation or time watermark regression");
				if (current.state.version === "role-message-guard/v2" && mutation.next.version !== current.state.version)
					throw new Error("guard store policy revision cannot be downgraded");
				if (current.state.mode === "rollback_depth_6" && mutation.next.mode !== "rollback_depth_6")
					throw new Error("rollback mode cannot be resurrected");
				for (const grant of current.state.grants) {
					const nextGrant = mutation.next.grants.find((g) => g.id === grant.id);
					if (nextGrant) {
						const { acceptedUses: _u, state: _s, useTransactionIds: _t, ...issued } = grant;
						const { acceptedUses: _nu, state: _ns, useTransactionIds: _nt, ...nextIssued } = nextGrant;
						if (guardDigest(issued) !== guardDigest(nextIssued))
							throw new Error("issued grant authority, quantity, scope and expiry cannot change");
						if (
							nextGrant.acceptedUses < grant.acceptedUses ||
							(grant.state === "revoked" && nextGrant.state !== "revoked") ||
							!grant.useTransactionIds.every((id) => nextGrant.useTransactionIds.includes(id))
						)
							throw new Error("grant use/refusal cannot be reset");
					}
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
				// H-GUARD-STORE-PERF-1 (2): digestOf is guardDigest, kept with each item this store made.
				const nextUsage = new Set(mutation.next.usage.map((u) => digestOf(u)));
				for (const usage of current.state.usage)
					if (mutation.next.lastTrustedTime - usage.committedAt < 3600000 && !nextUsage.has(digestOf(usage)))
						throw new Error("recent accepted charge cannot be removed");
				// #122 (Ops rm-fc4b9788): only a tombstone whose verified end has passed may leave.
				const nextTombstones = new Set(mutation.next.tombstones.map((t) => digestOf(t)));
				for (const tombstone of current.state.tombstones)
					if (
						!(
							typeof tombstone.invalidThrough === "number" && tombstone.invalidThrough <= mutation.next.lastTrustedTime
						) &&
						!nextTombstones.has(digestOf(tombstone))
					)
						throw new Error("replay tombstone cannot be reset");
				// The first entry for each message id, as find() gives it. guardStateIsValid above holds every entry to a
				// record whose message has a string id; only a hole isn't one, and then find() runs as before.
				const outbox = mutation.next.outbox;
				let entryById: Map<string, GuardOutboxEntry> | null = new Map();
				for (let i = 0; i < outbox.length; i++) {
					const o = outbox[i];
					if (!record(o)) {
						entryById = null;
						break;
					}
					if (!entryById.has(o.message.id)) entryById.set(o.message.id, o);
				}
				const messages = current.legacy.messages.map((m) => {
					const entry = entryById ? entryById.get(m.id) : outbox.find((o) => o.message.id === m.id);
					if (!entry || digestOf(entry.message) === digestOf(m)) return m;
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
					if (previous && digestOf(previous) !== digestOf(message))
						throw new Error("canonical message identity conflict");
					if (!previous) messages.push(structuredClone(message));
				}
				if (mutation.result.state === "accepted") {
					// #426 H-HANDOFF-WINDOW-1: a new acceptance still needs its charge. A later hand-off may instead
					// use the ORIGINAL committed acceptance, whose transaction and words outlive the rolling hour.
					// Never trust a receipt added by this mutation, never recharge it, and never change its binding.
					const result = mutation.result;
					const continuingAcceptance = (): boolean => {
						const previous = current.state.transactions.find((t) => t.transactionId === result.receipt.transactionId);
						if (previous?.state !== "committed" || previous.result.state !== "accepted") return false;
						const priorReceipt = previous.result.receipt;
						return (
							mutation.next.lastTrustedTime - priorReceipt.committedAt >= 3600000 &&
							sameIdentity(previous.identity, priorReceipt.identity) &&
							digestOf({ ...result.receipt, legacyMessageDigest: priorReceipt.legacyMessageDigest }) ===
								digestOf(priorReceipt) &&
							current.state.outbox.some((o) => digestOf(o.receipt) === digestOf(priorReceipt))
						);
					};
					if (
						!messages.some(
							(m) => m.id === result.receipt.messageId && digestOf(m) === result.receipt.legacyMessageDigest,
						) ||
						(!mutation.next.usage.some((u) => u.transactionId === result.receipt.transactionId) &&
							!continuingAcceptance())
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
				// H-GUARD-STORE-PERF-1 (3): built item by item from each kept item's bytes; anything that isn't plain data
				// is written the old way, field by field (the golden test holds both to the old store's bytes).
				const written = compose(body) ?? composeText(body);
				if (written.prepared.length > this.options.maximumBytes)
					return { state: "not_committed", reason: "retention_capacity" };
				// The full structural check on what will be written (its digest is known by construction), on the value its
				// parse gives (H-GUARD-STORE-PERF-1 (2): assembled by compose, or else parsed from the text as before).
				const checked = verify(written.value(), written.preparedChecksum);
				beganPrepare = true;
				await this.durable(this.options.journalPath, null, "prepare", written.prepared);
				await this.durable(this.options.journalPath, null, "commit", written.committed);
				// Files in sorted order: the same accepted words always give the same bytes, whoever wrote them last.
				await this.durable(this.options.legacyPath, null, "legacy", written.legacy);
				// PERF-1/2: the next read of these exact bytes reuses what was just checked: the commit is the checked
				// prepare with only its stage and fresh checksum changed. Any other text is decoded in full as before.
				const kept = deepFreeze({ ...checked, stage: "committed", checksum: written.commitChecksum } as Bundle);
				this.legacyDigests.set(kept.legacy, written.legacyDigest);
				this.lastJournal = { bytes: written.committed, bundle: kept };
				this.lastCanonical = { bytes: written.legacy, digest: written.legacyDigest };
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
