/** RTPI/1 candidate-2 pure core (Ops #136, unit C0 of the Roles rebuild).
 * Contract: SPEC v2 (sha256 225b4703...) in /home/shinelay/company-lab/shared/roles-core-contract-2026-10-13/, accepted as
 * documents by Architecture rm-3b46a7c8, Data rm-d852a5ed and Security rm-b79f71e9 (with the C01 residual).
 * INERT: no production importer, no instance, no default path, no timer, no I/O and no registration on import.
 * The only capability constructor makes rtpi-fixture capabilities for synthetic proof. There is no native capability
 * (T05, the native issuer registry, is missing), so every rtpi-native root comes out "unavailable".
 * C01 residual: a same-UID host, plugin or shell can forge or delete local records, so a verdict informs display only.
 * Nothing here dispatches, stops, holds, approves, confirms or grants anything.
 * C0 scope: canonical bytes, closed schema, the fact table, caps, coverage, idempotence and recovery. Publications
 * (R06 accounting) and aggregates (C10, off) are structure-checked and then "unavailable"; #144 owns them.
 * Stricter than the oracle (CHECKS/check.py, bound by the experts): every ref comparison (witness, envelope, lineage,
 * current subjects) is a whole-ref canonical comparison, not id-only (Architecture condition D), and an event may not
 * be later than the native server clock when one is supplied (#110 V01).
 */
import { createHash } from "node:crypto";
import { RTPI_SCHEMA, type RtpiSchemaNode } from "./rtpi-schema.js";

export const RTPI_CONTRACT = Object.freeze({
	wire: "rtpi/1",
	candidate: "candidate-2",
	schemaId: "urn:rtpi:1:candidate-2",
	specSha256: "225b47033e29c8f32a0be9f3c930672a830c333707f7e97411c33360366aa142",
	schemasFileSha256: "6965504a236497716cb2985730806f08598baf38532a680921b95300283a919c",
	oracleSha256: "d3553f1eaac2a59e000385655e304e79f96ae82a5e2364fb536d9c951746909b",
	acceptances: Object.freeze(["architecture rm-3b46a7c8", "data rm-d852a5ed", "security rm-b79f71e9"]),
});

export type RtpiRootSchema =
	| "rtpi/event/1"
	| "rtpi/design/1"
	| "rtpi/publication/1"
	| "rtpi/lineage/1"
	| "rtpi/checkpoint/1"
	| "rtpi/gate-contract/1"
	| "rtpi/aggregate/1";

const ROOT_BYTES: Readonly<Record<RtpiRootSchema, number>> = Object.freeze({
	"rtpi/event/1": 8192,
	"rtpi/lineage/1": 8192,
	"rtpi/gate-contract/1": 8192,
	"rtpi/checkpoint/1": 8192,
	"rtpi/aggregate/1": 8192,
	"rtpi/design/1": 65536,
	"rtpi/publication/1": 65536,
});

/** SPEC §2 caps and work limits, and the C05 (#110) limits for the Roles family. */
export const RTPI_LIMITS = Object.freeze({
	rootBytes: ROOT_BYTES,
	maxRootBytes: 65536,
	refsPerRoot: 64,
	refsPerEventOuter: 128,
	depth: 12,
	nodes: 4096,
	resolvedBytes: 4194304,
	schemaIndirections: 64,
	segmentBytes: 1048576,
	activeReadBytes: 10485760,
	segments: 10,
	pendingShown: 200,
	activityPerScope: 20,
	terminalRetentionMs: 2592000000,
	challengeMs: 60000,
	fullRefreshMs: 3000,
	heartbeatMs: 30000,
});

export type RtpiJson = null | boolean | number | string | RtpiJson[] | { [key: string]: RtpiJson };
type Obj = { [key: string]: RtpiJson };

export type RtpiNamespace = "rtpi-native" | "rtpi-fixture";
export interface RtpiRef {
	readonly namespace: RtpiNamespace;
	readonly kind: string;
	readonly id: string;
	readonly revision: string;
}
export interface RtpiWitness {
	readonly session: RtpiRef;
	readonly epoch: RtpiRef;
	readonly turn: RtpiRef;
	readonly run: RtpiRef;
	readonly attempt: RtpiRef;
}

export type RtpiFact =
	| "queue-snapshot"
	| "message-admitted"
	| "message-delivered"
	| "message-included"
	| "message-settled"
	| "message-replied"
	| "owner-saved"
	| "owner-rendered"
	| "owner-opened"
	| "owner-acknowledged"
	| "artifact-confirmed"
	| "policy-approved"
	| "origin-classified"
	| "gate-observed"
	| "resource-incorporated"
	| "config-saved"
	| "profile-selected"
	| "registry-linked"
	| "design-linked"
	| "report-linked"
	| "handoff-accepted"
	| "publication-linked"
	| "capture-gap";
export type RtpiSidecar = "registry" | "design" | "report" | "handoff" | "publication";

export class RtpiReject extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super(reason);
		this.name = "RtpiReject";
		this.reason = reason;
	}
}

function need(ok: unknown, why: string): asserts ok {
	if (!ok) throw new RtpiReject(why);
}

function hasOwn(o: object, k: string): boolean {
	return Object.prototype.hasOwnProperty.call(o, k);
}

function isObject(v: unknown): v is Obj {
	if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
	const proto: unknown = Object.getPrototypeOf(v);
	return proto === null || proto === Object.prototype;
}

function isSafeInt(v: unknown): v is number {
	return typeof v === "number" && Number.isSafeInteger(v);
}

function wellFormed(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff) {
			const d = s.charCodeAt(i + 1);
			if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
			i++;
		} else if (c >= 0xdc00 && c <= 0xdfff) return false;
	}
	return true;
}

/** Python len(): code points, not UTF-16 units. */
function codePointLength(s: string): number {
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff) {
			const d = s.charCodeAt(i + 1);
			if (d >= 0xdc00 && d <= 0xdfff) i++;
		}
		n++;
	}
	return n;
}

/** Key order by Unicode code point (Python sort_keys), not by UTF-16 unit. */
function codeUnitRank(c: number): number {
	if (c >= 0xd800 && c <= 0xdfff) return c + 0x2000;
	if (c >= 0xe000) return c - 0x800;
	return c;
}
function compareCodePoints(a: string, b: string): number {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		const x = a.charCodeAt(i);
		const y = b.charCodeAt(i);
		if (x !== y) return codeUnitRank(x) - codeUnitRank(y);
	}
	return a.length - b.length;
}

// ---------------------------------------------------------------- strict JSON parse

const PARSE_DEPTH = 64;
const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);
const ESCAPES: Readonly<Record<string, string>> = Object.freeze({
	'"': '"',
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
});
const HEX4 = /^[0-9A-Fa-f]{4}$/;

class StrictJson {
	private i = 0;
	constructor(private readonly s: string) {}

	parse(): RtpiJson {
		this.ws();
		const v = this.value(1);
		this.ws();
		need(this.i === this.s.length, "invalid-json");
		return v;
	}

	private ws(): void {
		while (this.i < this.s.length && WHITESPACE.has(this.s.charCodeAt(this.i))) this.i++;
	}

	private value(depth: number): RtpiJson {
		need(depth <= PARSE_DEPTH, "depth-work-bound");
		const c = this.s[this.i];
		if (c === "{") return this.object(depth);
		if (c === "[") return this.array(depth);
		if (c === '"') return this.string();
		if (c === "t") return this.literal("true", true);
		if (c === "f") return this.literal("false", false);
		if (c === "n") return this.literal("null", null);
		if (c === "N" || c === "I" || (c === "-" && this.s[this.i + 1] === "I"))
			throw new RtpiReject("nonfinite-json-number");
		if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return this.number();
		throw new RtpiReject("invalid-json");
	}

	private literal<T extends RtpiJson>(word: string, v: T): T {
		need(this.s.startsWith(word, this.i), "invalid-json");
		this.i += word.length;
		return v;
	}

	private number(): number {
		const re = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;
		re.lastIndex = this.i;
		const m = re.exec(this.s);
		need(m !== null, "invalid-json");
		need(m[1] === undefined && m[2] === undefined, "float-json-number");
		const n = Number(m[0]);
		need(Number.isSafeInteger(n), "unsafe-json-integer");
		this.i += m[0].length;
		return n === 0 ? 0 : n;
	}

	private string(): string {
		this.i++;
		let out = "";
		let start = this.i;
		for (;;) {
			need(this.i < this.s.length, "invalid-json");
			const c = this.s.charCodeAt(this.i);
			if (c === 0x22) {
				out += this.s.slice(start, this.i);
				this.i++;
				break;
			}
			if (c === 0x5c) {
				out += this.s.slice(start, this.i);
				const e = this.s[this.i + 1];
				if (e === "u") {
					const hex = this.s.slice(this.i + 2, this.i + 6);
					need(HEX4.test(hex), "invalid-json");
					out += String.fromCharCode(parseInt(hex, 16));
					this.i += 6;
				} else {
					need(e !== undefined && hasOwn(ESCAPES, e), "invalid-json");
					out += ESCAPES[e];
					this.i += 2;
				}
				start = this.i;
				continue;
			}
			need(c >= 0x20, "invalid-json");
			this.i++;
		}
		need(wellFormed(out), "invalid-canonical-number-or-unicode");
		return out;
	}

	private object(depth: number): Obj {
		this.i++;
		const out = Object.create(null) as Obj;
		this.ws();
		if (this.s[this.i] === "}") {
			this.i++;
			return out;
		}
		for (;;) {
			this.ws();
			need(this.s[this.i] === '"', "invalid-json");
			const k = this.string();
			need(!hasOwn(out, k), "duplicate-json-key");
			this.ws();
			need(this.s[this.i] === ":", "invalid-json");
			this.i++;
			this.ws();
			out[k] = this.value(depth + 1);
			this.ws();
			const c = this.s[this.i];
			this.i++;
			if (c === "}") return out;
			need(c === ",", "invalid-json");
		}
	}

	private array(depth: number): RtpiJson[] {
		this.i++;
		const out: RtpiJson[] = [];
		this.ws();
		if (this.s[this.i] === "]") {
			this.i++;
			return out;
		}
		for (;;) {
			this.ws();
			out.push(this.value(depth + 1));
			this.ws();
			const c = this.s[this.i];
			this.i++;
			if (c === "]") return out;
			need(c === ",", "invalid-json");
		}
	}
}

function decodeUtf8(input: Uint8Array): string {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
	} catch {
		throw new RtpiReject("invalid-utf8");
	}
}

function parseBounded(input: string | Uint8Array, maxBytes: number): RtpiJson {
	let text: string;
	if (typeof input === "string") {
		need(wellFormed(input), "invalid-utf8");
		need(Buffer.byteLength(input, "utf8") <= maxBytes, "canonical-root-byte-bound");
		text = input;
	} else {
		need(input.byteLength <= maxBytes, "canonical-root-byte-bound");
		text = decodeUtf8(input);
	}
	need(!text.startsWith("\ufeff"), "byte-order-mark");
	return new StrictJson(text).parse();
}

/** Strict RTPI/1 JSON parse: duplicate keys, NaN/Infinity, floats, unsafe integers, lone surrogates, invalid UTF-8,
 * a BOM and inputs over the largest root cap are refused. Whitespace is allowed; the canonical form is measured. */
export function rtpiParse(input: string | Uint8Array): RtpiJson {
	return parseBounded(input, RTPI_LIMITS.maxRootBytes);
}

// ---------------------------------------------------------------- canonical bytes

class CanonicalWriter {
	private parts: string[] = [];
	private units = 0;
	constructor(private readonly maxUnits: number) {}

	text(): string {
		return this.parts.join("");
	}

	private push(s: string): void {
		this.units += s.length;
		// Every UTF-16 unit is at least one UTF-8 byte, so past the unit budget the bytes are over it too.
		need(this.units <= this.maxUnits, "canonical-root-byte-bound");
		this.parts.push(s);
	}

	write(v: unknown, depth: number): void {
		need(depth <= PARSE_DEPTH, "depth-work-bound");
		if (v === null) return this.push("null");
		if (v === true) return this.push("true");
		if (v === false) return this.push("false");
		if (typeof v === "number") {
			need(Number.isSafeInteger(v), "invalid-canonical-number-or-unicode");
			return this.push(String(v));
		}
		if (typeof v === "string") {
			need(wellFormed(v), "invalid-canonical-number-or-unicode");
			return this.push(JSON.stringify(v));
		}
		if (Array.isArray(v)) {
			this.push("[");
			for (let i = 0; i < v.length; i++) {
				if (i > 0) this.push(",");
				this.write(v[i], depth + 1);
			}
			return this.push("]");
		}
		if (isObject(v)) {
			const keys = Object.keys(v).sort(compareCodePoints);
			this.push("{");
			keys.forEach((k, i) => {
				need(wellFormed(k), "invalid-canonical-number-or-unicode");
				if (i > 0) this.push(",");
				this.push(JSON.stringify(k));
				this.push(":");
				this.write(v[k], depth + 1);
			});
			return this.push("}");
		}
		throw new RtpiReject("invalid-canonical-number-or-unicode");
	}
}

function canonicalBounded(v: unknown, maxUnits: number): string {
	const w = new CanonicalWriter(maxUnits);
	w.write(v, 1);
	return w.text();
}

/** Canonical RTPI/1 JSON text: sorted keys (code point order), no whitespace, minimal JSON escapes, safe integers. */
export function rtpiCanonical(v: unknown): string {
	return canonicalBounded(v, Number.MAX_SAFE_INTEGER);
}

export function rtpiByteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

export function rtpiSha256(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

/** Strict parse whose input must already be canonical RTPI/1 bytes (journal frames). */
export function rtpiParseCanonical(input: string | Uint8Array, maxBytes: number = RTPI_LIMITS.maxRootBytes): RtpiJson {
	const text = typeof input === "string" ? input : decodeUtf8(input);
	const v = parseBounded(text, maxBytes);
	need(rtpiCanonical(v) === text, "not-canonical-bytes");
	return v;
}

function refEqual(a: unknown, b: unknown): boolean {
	if (!isObject(a) || !isObject(b)) return false;
	return rtpiCanonical(a) === rtpiCanonical(b);
}

function deepFreeze<T>(v: T): T {
	if (v !== null && typeof v === "object") {
		for (const x of Object.values(v)) deepFreeze(x);
		Object.freeze(v);
	}
	return v;
}

// ---------------------------------------------------------------- R07 checkpoint integrity

const CHECKPOINT_DOMAIN = "rtpi/checkpoint-integrity/1";

/** Security R07: SHA-256 of UTF8("rtpi/checkpoint-integrity/1") || 0x00 || canonical(P), P = the checkpoint with ONLY
 * its top-level hash removed. Integrity only: never authentication, qualification or coverage. */
export function rtpiCheckpointDigest(checkpoint: Readonly<Record<string, unknown>>): string {
	const p: Record<string, unknown> = {};
	for (const k of Object.keys(checkpoint)) if (k !== "hash") p[k] = checkpoint[k];
	return createHash("sha256")
		.update(Buffer.from(CHECKPOINT_DOMAIN, "utf8"))
		.update(Buffer.from([0]))
		.update(Buffer.from(rtpiCanonical(p), "utf8"))
		.digest("hex");
}

// ---------------------------------------------------------------- closed schema

const DEFS = RTPI_SCHEMA.$defs;
const ROOT_UNION: RtpiSchemaNode = { anyOf: RTPI_SCHEMA.anyOf };
const PATTERNS = new Map<string, RegExp>();

function pattern(p: string): RegExp {
	let re = PATTERNS.get(p);
	if (re === undefined) {
		re = new RegExp(p);
		PATTERNS.set(p, re);
	}
	return re;
}

/** R07 full-string token check: the match must start at 0 and cover the whole string (no "$ before a final LF"). */
function fullMatch(re: RegExp, s: string): boolean {
	const m = re.exec(s);
	return m !== null && m.index === 0 && m[0].length === s.length;
}

function sameScalar(a: unknown, b: unknown): boolean {
	return typeof a === typeof b && a === b;
}

function schemaValidate(v: unknown, s: RtpiSchemaNode, chain: readonly string[]): void {
	if (s.$ref !== undefined) {
		need(s.$ref.startsWith("#/$defs/"), "nonlocal-schema-reference");
		const name = s.$ref.slice("#/$defs/".length);
		need(!chain.includes(name) && chain.length < RTPI_LIMITS.schemaIndirections, "schema-resolution-work-bound");
		const def = DEFS[name];
		need(def !== undefined, "nonlocal-schema-reference");
		schemaValidate(v, def, [...chain, name]);
		return;
	}
	if (s.anyOf !== undefined) {
		for (const sub of s.anyOf) {
			try {
				schemaValidate(v, sub, chain);
				return;
			} catch (e) {
				if (!(e instanceof RtpiReject)) throw e;
			}
		}
		throw new RtpiReject("closed-schema-union");
	}
	if (s.const !== undefined) need(sameScalar(v, s.const), "schema-const");
	if (s.enum !== undefined)
		need(
			s.enum.some((x) => sameScalar(v, x)),
			"schema-enum",
		);
	switch (s.type) {
		case "object": {
			need(isObject(v), "schema-object");
			const props = s.properties ?? {};
			for (const k of s.required ?? []) need(hasOwn(v, k), "schema-required-field");
			for (const k of Object.keys(v)) need(hasOwn(props, k), "schema-unknown-field");
			for (const k of Object.keys(v)) {
				const sub = props[k];
				need(sub !== undefined, "schema-unknown-field");
				schemaValidate(v[k], sub, chain);
			}
			return;
		}
		case "array": {
			need(Array.isArray(v), "schema-array");
			need(s.maxItems !== undefined && (s.minItems ?? 0) <= v.length && v.length <= s.maxItems, "schema-array-bound");
			if (s.uniqueItems) need(new Set(v.map((x) => rtpiCanonical(x))).size === v.length, "schema-array-duplicate");
			const items = s.items;
			need(items !== undefined, "unsupported-schema-type");
			for (const x of v) schemaValidate(x, items, chain);
			return;
		}
		case "string": {
			need(typeof v === "string", "schema-string");
			const n = codePointLength(v);
			need((s.minLength ?? 0) <= n && n <= (s.maxLength ?? 100000), "schema-string-bound");
			if (s.pattern !== undefined) need(fullMatch(pattern(s.pattern), v), "schema-string-pattern");
			return;
		}
		case "integer":
			need(isSafeInt(v), "schema-safe-integer");
			need(
				(s.minimum ?? -Number.MAX_SAFE_INTEGER) <= v && v <= (s.maximum ?? Number.MAX_SAFE_INTEGER),
				"schema-integer-bound",
			);
			return;
		case "boolean":
			need(typeof v === "boolean", "schema-boolean");
			return;
		case "null":
			need(v === null, "schema-null");
			return;
		default:
			need(s.type === undefined, "unsupported-schema-type");
	}
}

const AUDIT_KEYWORDS = new Set([
	"$ref",
	"type",
	"const",
	"enum",
	"anyOf",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"minItems",
	"maxItems",
	"uniqueItems",
	"minLength",
	"maxLength",
	"pattern",
	"minimum",
	"maximum",
]);

/** The oracle's audit_schema: closed objects, bounded arrays and strings, local acyclic references, 7 roots. */
export function rtpiAuditSchema(schema: {
	readonly $schema: string;
	readonly $id: string;
	readonly anyOf: readonly RtpiSchemaNode[];
	readonly $defs: Readonly<Record<string, RtpiSchemaNode>>;
}): number {
	need(
		schema.$schema === "https://json-schema.org/draft/2020-12/schema" && schema.$id === RTPI_CONTRACT.schemaId,
		"schema-dialect-or-namespace",
	);
	need(schema.anyOf.length === 7, "missing-root-contract");
	const walk = (s: RtpiSchemaNode, stack: readonly string[]): void => {
		need(
			Object.keys(s).every((k) => AUDIT_KEYWORDS.has(k)),
			"unsupported-schema-keyword",
		);
		if (s.$ref !== undefined) {
			need(s.$ref.startsWith("#/$defs/"), "nonlocal-schema-reference");
			const n = s.$ref.slice("#/$defs/".length);
			const def = schema.$defs[n];
			need(def !== undefined && !stack.includes(n) && stack.length < 64, "cyclic-schema-reference");
			walk(def, [...stack, n]);
		}
		if (s.type === "object") {
			need(s.additionalProperties === false, "open-object-schema");
			const props = s.properties ?? {};
			const required = s.required ?? [];
			need(
				required.length === Object.keys(props).length && required.every((k) => hasOwn(props, k)),
				"optional-or-unclosed-field",
			);
			for (const sub of Object.values(props)) walk(sub, stack);
		}
		if (s.type === "array") {
			need(isSafeInt(s.maxItems) && s.maxItems <= 64, "unbounded-array");
			need(s.items !== undefined, "unbounded-array");
			walk(s.items, stack);
		}
		if (s.type === "string") {
			const bounded =
				s.maxLength !== undefined || (s.pattern !== undefined && !s.pattern.includes("+") && !s.pattern.includes("*"));
			need(bounded, "unbounded-string");
		}
		for (const sub of s.anyOf ?? []) walk(sub, stack);
	};
	for (const [n, s] of Object.entries(schema.$defs)) walk(s, [n]);
	return Object.keys(schema.$defs).length;
}

// ---------------------------------------------------------------- closed fact table (Architecture R05)

const WITNESS = ["session", "epoch", "turn", "run", "attempt"] as const;
const OWNER_CONTEXT = [
	"owner",
	"client",
	"window",
	"session",
	"action",
	"artifact",
	"projection",
	"coverage",
	"policy",
	"challenge",
] as const;
const CONTEXT_KINDS: Readonly<Record<string, string>> = Object.freeze({
	queue: "queue",
	session: "session",
	epoch: "epoch",
	turn: "turn",
	run: "run",
	attempt: "attempt",
	recipient: "role",
	action: "operation",
	artifact: "artifact",
	owner: "owner",
	client: "client",
	window: "window",
	projection: "projection",
	coverage: "coverage",
	policy: "policy",
	challenge: "challenge",
});

interface FactRule {
	readonly context: readonly string[];
	readonly refs: Readonly<Record<string, readonly string[]>>;
}
const NONE: Readonly<Record<string, readonly string[]>> = Object.freeze({});
const RECEIPT: Readonly<Record<string, readonly string[]>> = Object.freeze({ receipt: ["receipt"] });
const RESOURCE: Readonly<Record<string, readonly string[]>> = Object.freeze({ revision: ["resource"] });
const FACT_RULES: Readonly<Record<RtpiFact, FactRule>> = Object.freeze({
	"queue-snapshot": { context: ["queue"], refs: NONE },
	"message-admitted": { context: ["session", "recipient"], refs: NONE },
	"message-delivered": { context: ["session", "recipient"], refs: NONE },
	"message-included": { context: [...WITNESS, "recipient"], refs: NONE },
	"message-settled": { context: [...WITNESS, "recipient"], refs: NONE },
	"message-replied": { context: ["session", "recipient"], refs: NONE },
	"owner-saved": { context: ["owner", "session"], refs: RECEIPT },
	"owner-rendered": { context: OWNER_CONTEXT, refs: RECEIPT },
	"owner-opened": { context: OWNER_CONTEXT, refs: RECEIPT },
	"owner-acknowledged": { context: OWNER_CONTEXT, refs: RECEIPT },
	"artifact-confirmed": { context: OWNER_CONTEXT, refs: RECEIPT },
	"policy-approved": { context: OWNER_CONTEXT, refs: RECEIPT },
	"origin-classified": { context: [], refs: { request: ["request"], actor: ["owner", "role"] } },
	"gate-observed": { context: ["artifact", "run", "attempt"], refs: { contract: ["contract"] } },
	"resource-incorporated": { context: ["recipient", "session"], refs: RESOURCE },
	"config-saved": { context: ["recipient"], refs: RESOURCE },
	"profile-selected": { context: ["recipient"], refs: RESOURCE },
	"registry-linked": { context: [], refs: { object: ["initiative"] } },
	"design-linked": { context: [], refs: { object: ["design"] } },
	"report-linked": { context: [], refs: { object: ["report"] } },
	"handoff-accepted": { context: [], refs: { object: ["handoff"] } },
	"publication-linked": { context: [], refs: { object: ["publication"] } },
	"capture-gap": { context: [], refs: NONE },
});
/** Generic evidence refs never carry authority (no issuer, owner, client, challenge, policy or role kinds). */
const EVIDENCE_KINDS: ReadonlySet<string> = new Set([
	"receipt",
	"operation",
	"attempt",
	"turn",
	"run",
	"artifact",
	"design",
	"report",
	"handoff",
	"publication",
	"resource",
	"checkpoint",
	"dedup",
	"coverage",
	"projection",
	"request",
	"origin",
	"component",
]);
const SIDECARS: Readonly<Partial<Record<RtpiFact, RtpiSidecar>>> = Object.freeze({
	"registry-linked": "registry",
	"design-linked": "design",
	"report-linked": "report",
	"handoff-accepted": "handoff",
	"publication-linked": "publication",
});
const CHECKPOINT_KINDS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
	dedup: new Set(["dedup"]),
	accepted: new Set(["receipt"]),
	held: new Set(["operation"]),
	acknowledged: new Set(["receipt"]),
	needed: EVIDENCE_KINDS,
});
const LIVE_LISTS = ["dedup", "accepted", "held", "acknowledged", "needed"] as const;
export type RtpiLiveList = (typeof LIVE_LISTS)[number];
export type RtpiLiveSet = Readonly<Record<RtpiLiveList, readonly RtpiRef[]>>;

/** The first live list of `previous` that `next` drops a reference from (whole-ref comparison), or null. */
export function rtpiLiveReferenceLost(previous: RtpiLiveSet, next: RtpiLiveSet): RtpiLiveList | null {
	for (const name of LIVE_LISTS) {
		const kept = new Set(next[name].map((r) => rtpiCanonical(r)));
		if (!previous[name].every((r) => kept.has(rtpiCanonical(r)))) return name;
	}
	return null;
}

function obj(v: RtpiJson | undefined): Obj {
	return v as Obj;
}
function list(v: RtpiJson | undefined): RtpiJson[] {
	return v as RtpiJson[];
}

function requireKind(o: Obj, key: string, kind: string, nullable = false): void {
	const x = o[key];
	if (x === null && nullable) return;
	need(isObject(x) && x.kind === kind, "reference-kind-" + key);
}

function factRules(x: Obj, c: Obj): void {
	const fact = x.fact as RtpiFact;
	const rule = FACT_RULES[fact];
	const known = (hasOwn(x, "status") ? x.status : "known") === "known";
	if (known) for (const key of rule.context) need(c[key] !== null, "fact-context-missing-" + key);
	for (const [key, kinds] of Object.entries(rule.refs)) {
		const r = x[key];
		if (r === null) need(!known || key === "request" || key === "actor", "fact-reference-missing-" + key);
		else need(isObject(r) && kinds.includes(r.kind as string), "reference-kind-" + key);
	}
	for (const r of hasOwn(x, "forwardChain") ? list(x.forwardChain) : [])
		need(obj(r).kind === "request", "reference-kind-forwardChain");
	need(
		list(x.refs).every((r) => EVIDENCE_KINDS.has(obj(r).kind as string)),
		"evidence-reference-kind",
	);
}

// ---------------------------------------------------------------- structural verdict

interface Metrics {
	readonly refs: RtpiRef[];
	readonly nodes: number;
	readonly depth: number;
}

function metrics(v: unknown): Metrics {
	const refs: RtpiRef[] = [];
	let nodes = 0;
	let depth = 0;
	const walk = (x: unknown, d: number): void => {
		nodes++;
		depth = Math.max(depth, d);
		need(nodes <= RTPI_LIMITS.nodes, "node-work-bound");
		need(d <= RTPI_LIMITS.depth, "depth-work-bound");
		if (isObject(x)) {
			const keys = Object.keys(x);
			if (keys.length === 4 && ["namespace", "kind", "id", "revision"].every((k) => hasOwn(x, k)))
				refs.push(x as unknown as RtpiRef);
			for (const k of keys) walk(x[k], d + 1);
		} else if (Array.isArray(x)) for (const y of x) walk(y, d + 1);
	};
	walk(v, 1);
	return { refs, nodes, depth };
}

interface Structure {
	readonly schema: RtpiRootSchema;
	readonly namespace: RtpiNamespace;
	readonly root: Obj;
	readonly text: string;
	readonly bytes: number;
	readonly refs: number;
	readonly nodes: number;
	readonly depth: number;
}

function gateGraph(required: RtpiJson[]): void {
	const gates = new Map<string, Obj>();
	for (const g of required) gates.set(obj(g).stage as string, obj(g));
	need(gates.size === required.length && gates.size > 0, "duplicate-or-empty-required-set");
	const visit = (n: string, active: readonly string[]): void => {
		need(!active.includes(n), "gate-dependency-cycle");
		for (const dep of list(gates.get(n)?.dependsOn)) {
			need(gates.has(dep as string), "gate-dependency-missing");
			visit(dep as string, [...active, n]);
		}
	};
	for (const [n, g] of gates) {
		visit(n, []);
		if (n === "checked") need(g.independent === true, "required-check-independence");
	}
}

function structure(value: unknown): Structure {
	need(isObject(value) && typeof value.schema === "string" && hasOwn(ROOT_BYTES, value.schema), "unknown-root-schema");
	const schema = value.schema as RtpiRootSchema;
	const text = canonicalBounded(value, RTPI_LIMITS.maxRootBytes);
	const bytes = rtpiByteLength(text);
	need(bytes <= ROOT_BYTES[schema], "canonical-root-byte-bound");
	const m = metrics(value);
	need(m.refs.length <= RTPI_LIMITS.refsPerRoot, "total-nested-reference-bound");
	schemaValidate(value, ROOT_UNION, []);
	// Publication (R06 accounting) and aggregate (C10) identities are not in C0: their stages stay unavailable here,
	// structurally too, so no C0 path (validate, journal, recovery) accepts one. #144 adds them.
	if (schema === "rtpi/publication/1") throw new RtpiReject("publication-stage-not-in-c0");
	if (schema === "rtpi/aggregate/1") throw new RtpiReject("aggregates-off-c10");
	const v = value;
	if (schema === "rtpi/checkpoint/1") need(v.hash === rtpiCheckpointDigest(v), "checkpoint-integrity-mismatch");
	// SPEC §2: every reference in a root carries one namespace; mixed roots are rejected, never upgraded.
	const namespace = m.refs[0]?.namespace;
	need(namespace !== undefined && m.refs.every((r) => r.namespace === namespace), "mixed-reference-namespace");
	requireKind(v, "source", "source");
	requireKind(v, "issuer", "issuer");
	requireKind(v, "subject", "subject");
	if (hasOwn(v, "lineage")) requireKind(v, "lineage", "lineage");
	switch (schema) {
		case "rtpi/event/1": {
			const x = obj(v.body);
			const c = obj(v.context);
			for (const [key, kind] of Object.entries(CONTEXT_KINDS)) requireKind(c, key, kind, true);
			factRules(x, c);
			const fact = x.fact as RtpiFact;
			if (fact === "queue-snapshot") {
				requireKind(c, "queue", "queue");
				const counts = Object.values(obj(x.counts));
				if (x.status === "known") {
					need(
						x.capacity !== null &&
							x.occupied !== null &&
							(x.occupied as number) <= (x.capacity as number) &&
							x.fullIndex === true,
						"queue-capacity-or-index-incomplete",
					);
					need(
						counts.every((y) => y !== null),
						"known-count-source-incomplete",
					);
				} else
					need(
						x.capacity === null && x.occupied === null && x.fullIndex === false && counts.every((y) => y === null),
						"unknown-queue-fabricated-zero",
					);
			} else if (fact.startsWith("message-")) {
				if (x.status === "unknown") need(x.success === null, "unknown-message-success");
				else if (x.success === true) need(x.errorCode === "none", "error-abort-not-success");
			} else if (fact.startsWith("owner-") || fact === "artifact-confirmed" || fact === "policy-approved") {
				if (x.status === "known" && fact !== "owner-saved") {
					// Read-only observers receive no challenges and cannot issue render/open/ack/confirm stamps.
					need(x.clientRole === "owner", "observer-or-stale-client");
					need(
						isSafeInt(x.issuedAt) && isSafeInt(x.expiresAt) && x.expiresAt - x.issuedAt === RTPI_LIMITS.challengeMs,
						"pending-challenge-expired-or-unbound",
					);
				}
			} else if (fact === "origin-classified") {
				if (x.classification === "unknown")
					need(x.request === null && x.actor === null, "unknown-origin-fabricated-actor");
				else if (x.classification !== "own") need(x.request !== null && x.actor !== null, "origin-request-missing");
			} else if (fact === "resource-incorporated" && x.status === "known")
				need(x.success === true, "prepared-not-incorporated");
			break;
		}
		case "rtpi/design/1": {
			requireKind(v, "grant", "policy");
			requireKind(v, "parent", "design", true);
			const sections = list(v.sections).map(obj);
			for (const s of sections)
				need(
					list(s.refs).every((r) => EVIDENCE_KINDS.has(obj(r).kind as string)),
					"evidence-reference-kind",
				);
			need(new Set(sections.map((s) => s.id)).size === sections.length, "duplicate-design-section");
			break;
		}
		case "rtpi/lineage/1":
			requireKind(v, "parent", "lineage", true);
			need(
				v.recovery === null || ["checkpoint", "operation"].includes(obj(v.recovery).kind as string),
				"reference-kind-recovery",
			);
			need(v.parent === null || v.recovery !== null, "restore-recovery-binding-missing");
			break;
		case "rtpi/checkpoint/1":
			requireKind(v, "policy", "policy");
			for (const name of LIVE_LISTS) {
				const kinds = CHECKPOINT_KINDS[name];
				need(
					kinds !== undefined && list(v[name]).every((r) => kinds.has(obj(r).kind as string)),
					"reference-kind-" + name,
				);
			}
			break;
		case "rtpi/gate-contract/1":
			requireKind(v, "acceptedBy", "issuer");
			gateGraph(list(v.required));
			break;
		default:
			break;
	}
	return { schema, namespace, root: v, text, bytes, refs: m.refs.length, nodes: m.nodes, depth: m.depth };
}

// ---------------------------------------------------------------- capabilities (C01: display-only, logical)

/** T01 exact final-input seam, T02 atomic outbox, T03 owner principal, T04 confined reader, T05 issuer registry. */
export interface RtpiSeams {
	readonly inputHook: boolean;
	readonly atomicOutbox: boolean;
	readonly ownerPrincipal: boolean;
	readonly confinedReader: boolean;
	readonly issuerRegistry: boolean;
}
/** The native seams as they stand at C0 (D-MISSING): none exists, so the stages that need one stay unavailable. */
export const RTPI_NATIVE_SEAMS_C0: RtpiSeams = Object.freeze({
	inputHook: false,
	atomicOutbox: false,
	ownerPrincipal: false,
	confinedReader: false,
	issuerRegistry: false,
});

export interface RtpiCapabilitySpec {
	readonly source: RtpiRef;
	readonly issuer: RtpiRef;
	readonly subject: RtpiRef;
	readonly roots: readonly RtpiRootSchema[];
	readonly facts: readonly RtpiFact[];
	readonly policyAccepted: boolean;
	readonly acceptedSidecars: readonly RtpiSidecar[];
	readonly seams: RtpiSeams;
}
export interface RtpiCapability extends RtpiCapabilitySpec {
	readonly namespace: RtpiNamespace;
	toJSON(): never;
}

const CAPABILITIES = new WeakSet<object>();

/** A display-only logical capability for SYNTHETIC proof (namespace rtpi-fixture). In-process and nonserializable: a
 * copy, a parsed JSON value or a hand-built object is not a capability. Its seams are synthetic declarations that
 * count only for fixture roots; they never stand for a native seam. There is no native constructor in C0 (T05). */
export function createRtpiFixtureCapability(spec: RtpiCapabilitySpec): RtpiCapability {
	const refs: [RtpiRef, string][] = [
		[spec.source, "source"],
		[spec.issuer, "issuer"],
		[spec.subject, "subject"],
	];
	for (const [r, kind] of refs) {
		schemaValidate(r, { $ref: "#/$defs/ref" }, []);
		need(r.namespace === "rtpi-fixture" && r.kind === kind, "capability-reference-" + kind);
	}
	need(
		spec.roots.every((r) => hasOwn(ROOT_BYTES, r)),
		"capability-root-scope",
	);
	need(
		spec.facts.every((f) => hasOwn(FACT_RULES, f)),
		"capability-fact-scope",
	);
	const cap: RtpiCapability = Object.freeze({
		namespace: "rtpi-fixture" as const,
		source: deepFreeze({ ...spec.source }),
		issuer: deepFreeze({ ...spec.issuer }),
		subject: deepFreeze({ ...spec.subject }),
		roots: Object.freeze([...spec.roots]),
		facts: Object.freeze([...spec.facts]),
		policyAccepted: spec.policyAccepted === true,
		acceptedSidecars: Object.freeze([...spec.acceptedSidecars]),
		seams: Object.freeze({ ...spec.seams }),
		toJSON(): never {
			throw new RtpiReject("capability-not-serializable");
		},
	});
	CAPABILITIES.add(cap);
	return cap;
}

export function isRtpiCapability(v: unknown): v is RtpiCapability {
	return typeof v === "object" && v !== null && CAPABILITIES.has(v);
}

// ---------------------------------------------------------------- qualification and verdicts

/** The current native state a record is qualified against, rehydrated by the authorized adapter from the canonical
 * operation (never from caller, model or client flags). Absent fields mean "not known": they never qualify. */
export interface RtpiQualification {
	readonly lineage?: RtpiRef | null;
	readonly incarnation?: string | null;
	readonly currentRevision?: number | null;
	readonly currentSequence?: number | null;
	readonly sourceCommitted?: boolean;
	readonly serverNow?: number | null;
	readonly ownerPrincipalAdmitted?: boolean;
	readonly clientCurrent?: boolean;
	readonly currentArtifact?: RtpiRef | null;
	readonly currentProjection?: RtpiRef | null;
	readonly currentCoverage?: RtpiRef | null;
	readonly includedWitness?: RtpiWitness | null;
	readonly settledWitness?: RtpiWitness | null;
	readonly settledSuccess?: boolean | null;
	readonly originIssuerQualified?: boolean;
	readonly requestQualified?: boolean;
	readonly gateContractAccepted?: boolean;
	readonly rolesGateIssuer?: RtpiRef | null;
	/** I1's accepted native per-kind required-contract issuer; Initiatives C7 only, absent for Roles. */
	readonly initiativesPerKindIssuer?: RtpiRef | null;
	readonly independentVerifier?: boolean;
	readonly resourceIncorporated?: boolean;
	readonly designBindingValid?: boolean;
	readonly checkpointReconciled?: boolean;
	/** Live references of the previous checkpoint; a new checkpoint must keep every one (C0 ships no pruner). */
	readonly previousLive?: RtpiLiveSet | null;
	readonly resolvedBytes?: number;
	readonly resolverRecursive?: boolean;
}

export type RtpiStatus = "accepted" | "rejected" | "unknown" | "unavailable";

export interface RtpiAccepted {
	readonly status: "accepted";
	/** true from rtpiValidate (capability + native state); false from rtpiStructural (structure only, e.g. recovery). */
	readonly qualified: boolean;
	readonly schema: RtpiRootSchema;
	readonly namespace: RtpiNamespace;
	readonly root: Readonly<Obj>;
	readonly canonical: string;
	readonly digest: string;
	readonly dedupKey: string;
	readonly bytes: number;
	readonly refs: number;
	readonly nodes: number;
	readonly depth: number;
}
export interface RtpiNotAccepted {
	readonly status: "rejected" | "unknown" | "unavailable";
	readonly reason: string;
}
export type RtpiVerdict = RtpiAccepted | RtpiNotAccepted;

/** Missing source, auth, seam evidence or native state: shown as unknown, never as zero, never upgraded. */
const UNKNOWN_REASONS: ReadonlySet<string> = new Set([
	"canonical-source-not-committed",
	"input-hook-unsupported",
	"owner-principal-not-admitted",
	"origin-issuer-unqualified",
	"request-not-authenticated-source",
	"gate-independent-verifier-missing",
	"checkpoint-not-reconciled",
	"lineage-state-unknown",
	"server-clock-unknown",
	"witness-unknown",
	"current-subject-unknown",
]);
/** Stage disabled: no native registry/seam, unaccepted policy/contract/sidecar, unknown version, out of C0 scope. */
const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
	"unknown-root-schema",
	"native-issuer-registry-missing",
	"capability-missing",
	"capture-policy-unaccepted",
	"sidecar-contract-missing",
	"required-contract-unaccepted",
	"initiatives-per-kind-issuer-unqualified",
	"confined-reader-missing",
	"publication-stage-not-in-c0",
	"aggregates-off-c10",
]);

/** The status a refusal reason maps to (rejected for every contract violation). */
export function rtpiReasonStatus(reason: string): "rejected" | "unknown" | "unavailable" {
	if (UNKNOWN_REASONS.has(reason)) return "unknown";
	if (UNAVAILABLE_REASONS.has(reason)) return "unavailable";
	return "rejected";
}

function refusal(e: unknown): RtpiNotAccepted {
	if (!(e instanceof RtpiReject)) throw e;
	return Object.freeze({ status: rtpiReasonStatus(e.reason), reason: e.reason });
}

function witnessMatches(c: Obj, w: RtpiWitness | null | undefined): boolean {
	if (w === null || w === undefined) return false;
	return WITNESS.every((k) => c[k] !== null && refEqual(c[k], w[k]));
}

function sameRef(a: RtpiJson | undefined, b: RtpiRef | null | undefined, unknownReason: string, why: string): void {
	need(b !== null && b !== undefined, unknownReason);
	need(refEqual(a, b), why);
}

function qualify(s: Structure, cap: RtpiCapability, q: RtpiQualification): void {
	const v = s.root;
	need(cap.namespace === s.namespace, "capability-namespace-mismatch");
	need(cap.roots.includes(s.schema), "capability-root-scope");
	need(
		q.resolverRecursive !== true && (q.resolvedBytes ?? 0) <= RTPI_LIMITS.resolvedBytes,
		"reference-resolution-work-bound",
	);
	need(refEqual(v.issuer, cap.issuer) && refEqual(v.source, cap.source), "native-source-issuer-unqualified");
	need(refEqual(v.subject, cap.subject), "native-subject-unqualified");
	need(cap.policyAccepted, "capture-policy-unaccepted");
	const gap = s.schema === "rtpi/event/1" && obj(v.body).fact === "capture-gap";
	// T02: without an atomic source commit + outbox, a capture gap is the honest default.
	need(gap || (cap.seams.atomicOutbox && q.sourceCommitted === true), "canonical-source-not-committed");
	if (hasOwn(v, "lineage")) sameRef(v.lineage, q.lineage, "lineage-state-unknown", "lineage-unqualified");
	if (hasOwn(v, "expectedRevision")) {
		need(isSafeInt(q.currentRevision) && typeof q.incarnation === "string", "lineage-state-unknown");
		need(
			v.expectedRevision === q.currentRevision && v.revision === q.currentRevision + 1,
			"stale-or-nonatomic-revision",
		);
		need(v.incarnation === q.incarnation, "incarnation-mismatch");
	}
	switch (s.schema) {
		case "rtpi/event/1":
			qualifyEvent(v, cap, q);
			break;
		case "rtpi/lineage/1":
			need(typeof q.incarnation === "string", "lineage-state-unknown");
			need(v.incarnation === q.incarnation, "lineage-incarnation");
			break;
		case "rtpi/checkpoint/1": {
			need(
				v.durable === true &&
					q.checkpointReconciled === true &&
					(v.sourceWatermark as number) >= (v.sequence as number),
				"checkpoint-not-reconciled",
			);
			const prev = q.previousLive;
			if (prev !== null && prev !== undefined) {
				const lost = rtpiLiveReferenceLost(prev, v as unknown as RtpiLiveSet);
				need(lost === null, "checkpoint-live-reference-lost-" + lost);
			}
			break;
		}
		case "rtpi/gate-contract/1":
			need(q.gateContractAccepted === true, "required-contract-unaccepted");
			need(cap.seams.issuerRegistry, "native-issuer-registry-missing");
			if (v.domain === "initiatives") {
				// Architecture R05: Initiatives C7 use needs I1's accepted per-kind issuer; Roles never waits for I1.
				need(
					q.initiativesPerKindIssuer !== null &&
						q.initiativesPerKindIssuer !== undefined &&
						refEqual(v.acceptedBy, q.initiativesPerKindIssuer),
					"initiatives-per-kind-issuer-unqualified",
				);
			} else sameRef(v.acceptedBy, q.rolesGateIssuer, "required-contract-unaccepted", "required-contract-issuer");
			break;
		default:
			break;
	}
}

function qualifyEvent(v: Obj, cap: RtpiCapability, q: RtpiQualification): void {
	const x = obj(v.body);
	const c = obj(v.context);
	const fact = x.fact as RtpiFact;
	need(isSafeInt(q.currentSequence), "lineage-state-unknown");
	need(v.sequence === q.currentSequence + 1, "source-sequence-reused-or-gap");
	need(cap.facts.includes(fact), "native-family-scope-mismatch");
	if (q.serverNow !== null && q.serverNow !== undefined)
		need((v.occurredAt as number) <= q.serverNow, "future-timestamp");
	const known = (hasOwn(x, "status") ? x.status : "known") === "known";
	const sidecar = SIDECARS[fact];
	if (sidecar !== undefined && known) need(cap.acceptedSidecars.includes(sidecar), "sidecar-contract-missing");
	if (fact.startsWith("message-")) {
		if (known && (fact === "message-included" || fact === "message-settled")) {
			// Architecture R05: the explicit session/epoch/turn/run/attempt witness, compared as whole refs.
			need(cap.seams.inputHook, "input-hook-unsupported");
			need(q.includedWitness !== null && q.includedWitness !== undefined, "witness-unknown");
			need(witnessMatches(c, q.includedWitness), "input-witness-mismatch");
		}
		if (known && fact === "message-settled") {
			need(q.settledWitness !== null && q.settledWitness !== undefined, "witness-unknown");
			need(
				witnessMatches(c, q.settledWitness) && x.success === q.settledSuccess,
				"settlement-attempt-outcome-mismatch",
			);
		}
	} else if (fact.startsWith("owner-") || fact === "artifact-confirmed" || fact === "policy-approved") {
		if (known) {
			need(cap.seams.ownerPrincipal && q.ownerPrincipalAdmitted === true, "owner-principal-not-admitted");
			if (fact !== "owner-saved") {
				need(q.clientCurrent === true, "observer-or-stale-client");
				sameRef(c.artifact, q.currentArtifact, "current-subject-unknown", "owner-current-subject-mismatch");
				sameRef(c.projection, q.currentProjection, "current-subject-unknown", "owner-current-subject-mismatch");
				sameRef(c.coverage, q.currentCoverage, "current-subject-unknown", "owner-current-subject-mismatch");
				need(isSafeInt(q.serverNow), "server-clock-unknown");
				need(x.serverNow === q.serverNow, "supplied-or-backdated-server-clock");
				need(
					(x.issuedAt as number) <= q.serverNow && q.serverNow < (x.expiresAt as number),
					"pending-challenge-expired-or-unbound",
				);
			}
		}
	} else if (fact === "origin-classified") {
		if (x.classification !== "unknown") {
			need(cap.seams.issuerRegistry && q.originIssuerQualified === true, "origin-issuer-unqualified");
			if (x.classification !== "own") need(q.requestQualified === true, "request-not-authenticated-source");
		}
	} else if (fact === "gate-observed") {
		need(q.gateContractAccepted === true, "required-contract-unaccepted");
		sameRef(c.artifact, q.currentArtifact, "current-subject-unknown", "gate-artifact-mismatch");
		if (x.stage === "checked" && x.result === "pass")
			need(q.independentVerifier === true, "gate-independent-verifier-missing");
	} else if (fact === "resource-incorporated" && known) {
		need(q.resourceIncorporated === true, "prepared-not-incorporated");
	} else if (fact === "design-linked" && known) {
		need(cap.seams.confinedReader, "confined-reader-missing");
		need(q.designBindingValid === true, "design-hash-byteLength-scope-binding");
	}
}

const ACCEPTED = new WeakSet<object>();
const DEDUP_DOMAIN = "rtpi/dedup-key/1";

/** SPEC §3: a canonical operation is mirrored at most once per qualified key: schema, source, issuer, subject,
 * lineage, incarnation, revision, objectId and (events) fact. The event id, sequence and time are NOT in the key, so a
 * rebuilt record with the same key and other bytes is a conflict, never a second effect. */
function dedupKey(v: Obj): string {
	const k: Obj = { schema: v.schema, source: v.source, issuer: v.issuer, subject: v.subject };
	for (const f of ["lineage", "incarnation", "revision", "objectId"]) if (hasOwn(v, f)) k[f] = v[f];
	if (v.schema === "rtpi/event/1") k.fact = obj(v.body).fact;
	return rtpiSha256(DEDUP_DOMAIN + "\u0000" + rtpiCanonical(k));
}

function acceptedVerdict(s: Structure, qualified: boolean): RtpiAccepted {
	const root = deepFreeze(new StrictJson(s.text).parse()) as Readonly<Obj>;
	const out: RtpiAccepted = Object.freeze({
		status: "accepted" as const,
		qualified,
		schema: s.schema,
		namespace: s.namespace,
		root,
		canonical: s.text,
		digest: rtpiSha256(s.text),
		dedupKey: dedupKey(root as Obj),
		bytes: s.bytes,
		refs: s.refs,
		nodes: s.nodes,
		depth: s.depth,
	});
	ACCEPTED.add(out);
	return out;
}

/** Structure only (no capability, no native state): canonical bytes, caps, work bounds, closed schema, one namespace,
 * the fact table and kinds, gate DAG and checkpoint integrity. Used by recovery; never a qualification. */
export function rtpiStructural(value: unknown): RtpiVerdict {
	try {
		return acceptedVerdict(structure(value), false);
	} catch (e) {
		return refusal(e);
	}
}

/** Full verdict. Without a registered capability every root is unavailable (no native issuer registry in C0). */
export function rtpiValidate(
	value: unknown,
	capability: RtpiCapability | null,
	qualification: RtpiQualification = {},
): RtpiVerdict {
	let s: Structure;
	try {
		s = structure(value);
	} catch (e) {
		return refusal(e);
	}
	if (!isRtpiCapability(capability))
		return refusal(
			new RtpiReject(s.namespace === "rtpi-native" ? "native-issuer-registry-missing" : "capability-missing"),
		);
	try {
		qualify(s, capability, qualification);
	} catch (e) {
		return refusal(e);
	}
	return acceptedVerdict(s, true);
}

/** Strict parse + full verdict for wire bytes. */
export function rtpiValidateBytes(
	input: string | Uint8Array,
	capability: RtpiCapability | null,
	qualification: RtpiQualification = {},
): RtpiVerdict {
	let value: RtpiJson;
	try {
		value = rtpiParse(input);
	} catch (e) {
		return refusal(e);
	}
	return rtpiValidate(value, capability, qualification);
}

/** True only for a verdict object made by this module (a copied or hand-built verdict is not accepted). */
export function isRtpiAccepted(v: unknown): v is RtpiAccepted {
	return typeof v === "object" && v !== null && ACCEPTED.has(v);
}

// ---------------------------------------------------------------- idempotence (V04/S02)

export interface RtpiDedupEntry {
	readonly key: string;
	readonly digest: string;
	readonly sequence: number;
}
export type RtpiDedupDecision =
	| { readonly decision: "new" }
	| { readonly decision: "duplicate"; readonly prior: RtpiDedupEntry }
	| { readonly decision: "conflict"; readonly prior: RtpiDedupEntry };

/** Same key + same canonical bytes -> the durable prior result; same key + other bytes -> conflict (quarantine). */
export function rtpiDedupDecision(
	prior: RtpiDedupEntry | undefined,
	next: { readonly key: string; readonly digest: string },
): RtpiDedupDecision {
	if (prior === undefined || prior.key !== next.key) return { decision: "new" };
	return prior.digest === next.digest ? { decision: "duplicate", prior } : { decision: "conflict", prior };
}

// ---------------------------------------------------------------- processed (C02)

export type RtpiProcessedState = "processed" | "not-processed" | "unknown";

function eventOf(v: RtpiAccepted | null, fact: RtpiFact): Obj | null {
	if (!isRtpiAccepted(v) || v.schema !== "rtpi/event/1") return null;
	const x = obj(v.root.body);
	if (x.fact !== fact) return null;
	// The record passed the closed schema, so its body has exactly its fact's fields: a body with a status field must
	// be known; a body without one (gate-observed, origin-classified, capture-gap) is known by being recorded.
	return !("status" in x) || x.status === "known" ? (v.root as Obj) : null;
}

/** Processed = trusted exact inclusion AND successful settlement of the SAME witness (whole refs). An unsupported
 * input seam, a missing record or a different attempt stays unknown; a same-attempt error or abort is not processed. */
export function rtpiProcessed(
	included: RtpiAccepted | null,
	settled: RtpiAccepted | null,
	capability: RtpiCapability | null,
): { readonly state: RtpiProcessedState; readonly reason: string } {
	if (!isRtpiCapability(capability) || !capability.seams.inputHook)
		return { state: "unknown", reason: "input-hook-unsupported" };
	const inc = eventOf(included, "message-included");
	if (inc === null) return { state: "unknown", reason: "inclusion-unknown" };
	const set = eventOf(settled, "message-settled");
	if (set === null) return { state: "unknown", reason: "settlement-unknown" };
	const a = obj(inc.context);
	const b = obj(set.context);
	const same =
		refEqual(inc.lineage, set.lineage) &&
		refEqual(inc.subject, set.subject) &&
		refEqual(a.recipient, b.recipient) &&
		WITNESS.every((k) => refEqual(a[k], b[k]));
	if (!same) return { state: "unknown", reason: "settled-different-attempt" };
	const body = obj(set.body);
	if (body.success === true && body.errorCode === "none") return { state: "processed", reason: "same-attempt-success" };
	return { state: "not-processed", reason: "same-attempt-error-or-abort" };
}

// ---------------------------------------------------------------- coverage (V13, S08)

export interface RtpiCounts {
	readonly ready: number | null;
	readonly working: number | null;
	readonly asking: number | null;
	readonly stuck: number | null;
	readonly waiting: number | null;
	readonly blocked: number | null;
	readonly done: number | null;
}
export interface RtpiHeartbeat {
	readonly receiptExpired: boolean;
	readonly socketLost: boolean;
	readonly stale: boolean;
	readonly capped: boolean;
	readonly partialIndex: boolean;
}
export interface RtpiSnapshotInput {
	readonly snapshot: RtpiAccepted | null;
	readonly watermarksComplete: boolean;
	readonly heartbeat: RtpiHeartbeat | null;
	readonly lastKnown: RtpiCounts | null;
}
export type RtpiCoverageState = "fresh" | "nothing-waiting" | "loading" | "last-known" | "unknown";
export interface RtpiCoverage {
	readonly state: RtpiCoverageState;
	readonly counts: RtpiCounts | null;
	readonly reason: string;
}

/** Stale or partial data keeps its labelled last-known value or is unknown; it is never a zero. */
export function rtpiSnapshotCoverage(input: RtpiSnapshotInput): RtpiCoverage {
	const fallback = (reason: string): RtpiCoverage =>
		input.lastKnown !== null
			? { state: "last-known", counts: input.lastKnown, reason }
			: { state: "unknown", counts: null, reason };
	if (input.snapshot === null)
		return input.lastKnown !== null
			? { state: "last-known", counts: input.lastKnown, reason: "no-snapshot" }
			: { state: "loading", counts: null, reason: "no-snapshot" };
	const ev = eventOf(input.snapshot, "queue-snapshot");
	if (ev === null) {
		const raw = isRtpiAccepted(input.snapshot) ? obj(input.snapshot.root.body) : null;
		return fallback(raw !== null && raw.fact === "queue-snapshot" ? "snapshot-unknown" : "not-a-validated-snapshot");
	}
	const hb = input.heartbeat;
	if (hb === null) return fallback("heartbeat-missing");
	if (hb.receiptExpired) return fallback("receipt-expired");
	if (hb.socketLost) return fallback("socket-lost");
	if (hb.stale) return fallback("stale");
	if (hb.capped) return fallback("capped");
	if (hb.partialIndex) return fallback("partial-index");
	const body = obj(ev.body);
	if (!input.watermarksComplete || body.fullIndex !== true) return fallback("watermarks-incomplete");
	const c = obj(body.counts);
	const counts: RtpiCounts = Object.freeze({
		ready: c.ready as number,
		working: c.working as number,
		asking: c.asking as number,
		stuck: c.stuck as number,
		waiting: c.waiting as number,
		blocked: c.blocked as number,
		done: c.done as number,
	});
	const empty = body.occupied === 0 && Object.values(counts).every((n) => n === 0);
	return { state: empty ? "nothing-waiting" : "fresh", counts, reason: "complete-snapshot" };
}

/** Each domain on its own: one inaccessible domain is unknown while the others stay usable. */
export function rtpiDomainCoverage(
	domains: Readonly<Record<string, RtpiSnapshotInput | null>>,
): Readonly<Record<string, RtpiCoverage>> {
	const out: Record<string, RtpiCoverage> = {};
	for (const [name, input] of Object.entries(domains))
		out[name] =
			input === null ? { state: "unknown", counts: null, reason: "domain-inaccessible" } : rtpiSnapshotCoverage(input);
	return Object.freeze(out);
}

export interface RtpiArtifactKey {
	readonly gitHead: string;
	readonly assetsSha256: string;
	readonly version: string;
	readonly manifestRevision: number;
	readonly targetEnvironment: string;
	readonly environmentEpoch: string;
}
export type RtpiGateStageState = "pass" | "fail" | "missing" | "unknown";
export interface RtpiGateCoverage {
	readonly state: "complete" | "failed" | "incomplete" | "unknown";
	readonly stages: Readonly<Record<string, RtpiGateStageState>>;
	readonly reason: string;
}
export interface RtpiGateCoverageInput {
	readonly contract: RtpiAccepted | null;
	readonly observations: readonly RtpiAccepted[];
	readonly ownerConfirmations: readonly RtpiAccepted[];
	/** Receipt -> ArtifactKey join. Undefined in RTPI/1 candidate-2 (Architecture condition B): pass null until an
	 * accepted revision defines it; then the coverage stays unknown. */
	readonly artifactKeyOf: ((artifact: RtpiRef) => RtpiArtifactKey | null) | null;
	readonly task: { readonly taskId: number; readonly planRevision: number } | null;
	readonly indexComplete: boolean;
}

/** S08: every required, applicable stage must pass for the exact ArtifactKey (and task/plan); not-applicable never
 * passes; an empty, stale or partial index is never live; a fail fails. */
export function rtpiGateCoverage(input: RtpiGateCoverageInput): RtpiGateCoverage {
	const none: Readonly<Record<string, RtpiGateStageState>> = Object.freeze({});
	if (!isRtpiAccepted(input.contract) || input.contract.schema !== "rtpi/gate-contract/1")
		return { state: "unknown", stages: none, reason: "required-contract-missing" };
	const contract = input.contract.root as Obj;
	const join = input.artifactKeyOf;
	if (join === null) return { state: "unknown", stages: none, reason: "receipt-artifact-join-undefined" };
	if (!input.indexComplete) return { state: "unknown", stages: none, reason: "gate-index-incomplete" };
	const key = rtpiCanonical(contract.artifact);
	const eligible = (e: Obj): boolean => {
		const c = obj(e.context);
		const k = isObject(c.artifact) ? join(c.artifact as unknown as RtpiRef) : null;
		if (k === null || rtpiCanonical(k) !== key) return false;
		if (input.task === null) return false;
		return c.taskId === input.task.taskId && c.planRevision === input.task.planRevision;
	};
	const stages: Record<string, RtpiGateStageState> = {};
	for (const g of list(contract.required).map(obj)) {
		const stage = g.stage as string;
		let state: RtpiGateStageState = "missing";
		const records =
			stage === "owner-confirmed"
				? input.ownerConfirmations.map((r) => eventOf(r, "artifact-confirmed")).filter((e): e is Obj => e !== null)
				: input.observations.map((r) => eventOf(r, "gate-observed")).filter((e): e is Obj => e !== null);
		for (const e of records) {
			const x = obj(e.body);
			if (stage !== "owner-confirmed") {
				if (x.stage !== stage) continue;
				const ref = obj(x.contract);
				if (ref.id !== contract.objectId || ref.revision !== String(contract.revision)) continue;
			}
			if (!eligible(e)) continue;
			const result = stage === "owner-confirmed" ? "pass" : (x.result as string);
			if (result === "fail") state = "fail";
			else if (result === "unknown" && state !== "fail") state = "unknown";
			else if (result === "pass" && state === "missing") state = "pass";
			// "not-applicable" never passes.
		}
		stages[stage] = state;
	}
	const states = Object.values(stages);
	const state = states.includes("fail")
		? "failed"
		: states.includes("unknown")
			? "unknown"
			: states.length > 0 && states.every((x) => x === "pass")
				? "complete"
				: "incomplete";
	return { state, stages: Object.freeze(stages), reason: state === "complete" ? "all-required-pass" : "not-live" };
}

// ---------------------------------------------------------------- windows and retention (S07)

/** At most 200 pending entries shown; the full native total and its completeness are carried separately. */
export function rtpiPendingWindow<T>(
	entries: readonly T[],
	total: number | null,
): { readonly shown: readonly T[]; readonly total: number | null; readonly complete: boolean } {
	return Object.freeze({
		shown: Object.freeze(entries.slice(0, RTPI_LIMITS.pendingShown)),
		total,
		complete: total !== null && total === entries.length,
	});
}

/** At most 20 activity entries per domain or role (caller order, newest first). */
export function rtpiActivityWindow<T>(entries: readonly T[]): readonly T[] {
	return Object.freeze(entries.slice(0, RTPI_LIMITS.activityPerScope));
}

/** 30-day terminal metadata (C05). Expired is not completed, and nothing is deleted here (C0 ships no pruner). */
export function rtpiRetention(terminalAt: number | null, now: number): "retained" | "expired" | "unknown" {
	if (!isSafeInt(terminalAt) || !isSafeInt(now)) return "unknown";
	return now - terminalAt >= RTPI_LIMITS.terminalRetentionMs ? "expired" : "retained";
}

// ---------------------------------------------------------------- recovery (S05)

export const RTPI_FRAME = "rtpi/frame/1";
const FRAME_KEYS = ["digest", "frame", "record", "sequence"];
const FRAME_MAX_BYTES = RTPI_LIMITS.maxRootBytes + 512;

/** One framed journal line: canonical {digest, frame, record, sequence} + LF. */
export function rtpiEncodeFrame(sequence: number, record: RtpiAccepted): string {
	need(isSafeInt(sequence) && sequence >= 1, "frame-sequence");
	need(isRtpiAccepted(record), "frame-record-not-validated");
	return rtpiCanonical({ digest: record.digest, frame: RTPI_FRAME, record: record.root, sequence }) + "\n";
}

export interface RtpiRecoveredFrame {
	readonly sequence: number;
	readonly record: RtpiAccepted;
	readonly bytes: number;
}
export type RtpiSegmentRecovery =
	| {
			readonly state: "clean";
			readonly frames: readonly RtpiRecoveredFrame[];
			readonly lastSequence: number;
			readonly bytes: number;
	  }
	| {
			readonly state: "quarantine";
			readonly reason: string;
			readonly frames: readonly RtpiRecoveredFrame[];
			readonly lastSequence: number;
	  };

/** Pure recovery of one segment's text. A torn tail, a non-canonical or corrupt frame, a digest mismatch, a duplicate
 * or skipped sequence, or a record that fails structure -> quarantine. Nothing is repaired, truncated or resent. */
export function rtpiRecoverSegment(text: string, previousSequence: number): RtpiSegmentRecovery {
	const frames: RtpiRecoveredFrame[] = [];
	let last = previousSequence;
	const quarantine = (reason: string): RtpiSegmentRecovery => ({
		state: "quarantine",
		reason,
		frames: Object.freeze(frames),
		lastSequence: last,
	});
	if (text.length === 0) return { state: "clean", frames: Object.freeze(frames), lastSequence: last, bytes: 0 };
	const lines = text.split("\n");
	const tail = lines.pop();
	for (const line of lines) {
		let frame: RtpiJson;
		try {
			frame = rtpiParseCanonical(line, FRAME_MAX_BYTES);
		} catch (e) {
			return quarantine(e instanceof RtpiReject ? "frame-" + e.reason : "frame-unreadable");
		}
		if (!isObject(frame) || Object.keys(frame).length !== 4 || !FRAME_KEYS.every((k) => hasOwn(frame as Obj, k)))
			return quarantine("frame-shape");
		if (frame.frame !== RTPI_FRAME) return quarantine("frame-version");
		if (!isSafeInt(frame.sequence)) return quarantine("frame-sequence");
		if (frame.sequence <= last) return quarantine("frame-sequence-duplicate");
		if (frame.sequence !== last + 1) return quarantine("frame-sequence-gap");
		const record = rtpiStructural(frame.record);
		if (record.status !== "accepted") return quarantine("frame-record-" + record.reason);
		if (frame.digest !== record.digest) return quarantine("frame-digest-mismatch");
		last = frame.sequence;
		frames.push(Object.freeze({ sequence: last, record, bytes: rtpiByteLength(line) + 1 }));
	}
	if (tail !== "") return quarantine("torn-tail");
	return { state: "clean", frames: Object.freeze(frames), lastSequence: last, bytes: rtpiByteLength(text) };
}

/** Pruning precondition only (C0 ships no pruner): a verified, durable, reconciled, gap-free checkpoint over a clean
 * journal. A hash or sequence alone never proves coverage. */
export function rtpiPrunable(input: {
	readonly checkpoint: RtpiAccepted | null;
	readonly reconciled: boolean;
	readonly journal: "clean" | "quarantine" | "unavailable";
}): { readonly prunable: boolean; readonly reason: string } {
	if (!isRtpiAccepted(input.checkpoint) || input.checkpoint.schema !== "rtpi/checkpoint/1")
		return { prunable: false, reason: "checkpoint-missing-or-unverifiable" };
	if (input.journal !== "clean") return { prunable: false, reason: "journal-not-clean" };
	const c = input.checkpoint.root as Obj;
	if (c.gapFree !== true) return { prunable: false, reason: "checkpoint-gap-not-prunable" };
	if (c.durable !== true || !input.reconciled) return { prunable: false, reason: "checkpoint-not-reconciled" };
	return { prunable: true, reason: "reconciled-gap-free-checkpoint" };
}
