// Ops #414, H-CANONICAL-1: the collector's canonical() reuses each object shape's sorted key order and, inside one
// persist and its apply, each row's text. Same output bytes is the whole point, so this file keeps a frozen copy of
// the canonical() it replaced (server/usage-accounting-collector.ts at 0888d552) and compares the new one with it,
// byte for byte, on fixed inputs: W0-shaped rows and what persist builds from them, nesting, null and undefined,
// unicode, number edge cases, key orders, separator-like keys, empty objects, and the shape cache past its bounds.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	collectorCanonicalForTests as canonical,
	collectorCanonicalShapesForTests as shapes,
} from "../../server/usage-accounting-collector.js";

/** Frozen copy of canonical() before #414 (0888d552), byte for byte. Never edit it: it is the reference. */
function frozenCanonical(raw: unknown): string {
	if (Array.isArray(raw)) return `[${raw.map(frozenCanonical).join(",")}]`;
	if (raw !== null && typeof raw === "object")
		return `{${Object.keys(raw)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${frozenCanonical((raw as Record<string, unknown>)[k])}`)
			.join(",")}}`;
	return JSON.stringify(raw) ?? "null";
}

/** Lists every object inside value in a memo, as persist lists its rows. */
function listAll(value: unknown, memo: Map<object, string | null>): void {
	if (value === null || typeof value !== "object" || memo.has(value)) return;
	memo.set(value, null);
	for (const v of Object.values(value)) listAll(v, memo);
}

/** The new canonical() gives the frozen bytes: without a memo, with an empty one, and with every object listed (run
 * twice, so the second run reads the kept texts). Each listed object keeps exactly its own frozen text. */
function expectSame(value: unknown): void {
	const want = frozenCanonical(value);
	expect(canonical(value)).toBe(want);
	const empty = new Map<object, string | null>();
	expect(canonical(value, empty)).toBe(want);
	expect(empty.size).toBe(0);
	const memo = new Map<object, string | null>();
	listAll(value, memo);
	expect(canonical(value, memo)).toBe(want);
	expect(canonical(value, memo)).toBe(want);
	for (const [listed, text] of memo) expect(text).toBe(frozenCanonical(listed));
}

// W0's shapes (tests/unit/usage-accounting-collector.test.ts, W0 WORKER MEASUREMENT): facts only, parsed from text.
const amount = (i: number) => (i % 3 === 0 ? "0.10" : i % 3 === 1 ? "0.000000000001" : "0.03");
const fact = (i: number, source: number) => {
	const identity = { producer: "pi", incarnation: "fixture-native-incarnation", attempt: `fixture-attempt-${i}` };
	return {
		v: "usage-fact/1",
		id: createHash("sha256").update(`fixture-attempt-${i}`).digest("hex"),
		revision: 0,
		supersedes: null,
		identity,
		identityStatus: "verified",
		occurredAt: "2026-10-20T10:00:00.000Z",
		provider: "fixture-provider",
		model: "fixture-model",
		kind: "assistant",
		tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
		prices: [
			{ basis: "list-estimate", currency: "USD", amount: amount(i), status: "known", rateVersion: "fixture-rates/1" },
		],
		source: {
			stream: `fixture-native-${source}`,
			event: `fixture-event-${i}`,
			observedAt: "2026-10-21T00:00:00.000Z",
			coverage: "complete",
		},
		links: { task: null, session: null, run: null },
	};
};
const rowKinds = ["facts", "allocations", "aliases", "roots", "policies", "memberships", "snapshots"] as const;
type Rows = Record<(typeof rowKinds)[number], Record<string, unknown>[]>;
interface Batch extends Record<string, unknown> {
	stream: string;
	incarnation: string;
	toCursor: { ordinal: number };
	rows: Rows;
}
const batchText = (b: number, size: number) =>
	JSON.stringify({
		v: "usage-source-batch/1",
		stream: `fixture-native-${b % 65}`,
		incarnation: "fixture-native-incarnation",
		adapterRef: "fixture-only:benchmark-adapter",
		fromCursor: b ? { ordinal: b, token: `fixture-only:opaque-${b}` } : null,
		toCursor: { ordinal: b + 1, token: `fixture-only:opaque-${b + 1}` },
		from: "2026-10-19T07:00:00.000Z",
		through: "2026-10-21T00:00:00.000Z",
		observedAt: "2026-10-21T00:00:00.000Z",
		status: "complete",
		reason: "none",
		rows: {
			facts: Array.from({ length: size }, (_, i) => fact(b * size + i, b % 65)),
			allocations: [],
			aliases: [],
			roots: [],
			policies: [],
			memberships: [],
			snapshots: [],
		},
	});
const streams = Array.from({ length: 65 }, (_, i) => `fixture-native-${i}`);

// Fixed pseudo-random inputs: the same every run.
function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}
const oddKeys = ["", " ", ",", ":", '"', "\\", "{", "}", "[", "]", "\n", "\u0000", "a,b", "a:b", "a\u0000b", '"a"'];
const unicodeKeys = ["é", "e\u0301", "日本語", "🙂", "\ud800", "\udfff", "\u2028", "\ufeff", "\uffff", "Z", "z"];
const numberKeys = ["0", "1", "2", "10", "01", "-1", "1.5", "4294967295", "4294967294", "9007199254740993"];
const plainKeys = ["a", "b", "c", "id", "v", "kind", "row", "rowKind", "key", "value", "facts", "prices"];
const keyPool = [...oddKeys, ...unicodeKeys, ...numberKeys, ...plainKeys];
const numbers = [
	0,
	-0,
	1,
	-1,
	0.1 + 0.2,
	1e21,
	-1e21,
	1e-7,
	-1e-7,
	123456789012345680000,
	Number.MAX_SAFE_INTEGER,
	Number.MAX_SAFE_INTEGER + 2,
	-Number.MAX_SAFE_INTEGER,
	2 ** 53,
	2 ** 64,
	Number.MAX_VALUE,
	-Number.MAX_VALUE,
	Number.MIN_VALUE,
	Number.EPSILON,
	5e-324,
	NaN,
	Infinity,
	-Infinity,
];
const strings = [
	"",
	" ",
	'"',
	"\\",
	"\n\r\t",
	"a\"b'c",
	"\u0000\u001f\u007f",
	"é",
	"e\u0301",
	"🙂",
	"\ud800",
	"\udfff\ud800",
	"\u2028\u2029",
	"1e21",
];
function randomValue(next: () => number, depth: number): unknown {
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
	const r = next();
	if (depth <= 0 || r < 0.35) {
		const leaf = next();
		if (leaf < 0.35) return pick(numbers);
		if (leaf < 0.7) return pick(strings);
		if (leaf < 0.8) return null;
		if (leaf < 0.87) return undefined;
		return leaf < 0.94;
	}
	if (r < 0.6) return Array.from({ length: Math.floor(next() * 5) }, () => randomValue(next, depth - 1));
	const value: Record<string, unknown> = {};
	for (let n = Math.floor(next() * 7); n > 0; n--) value[pick(keyPool)] = randomValue(next, depth - 1);
	return value;
}

describe("collector canonical(): same bytes as before #414", () => {
	it("W0-shaped rows, batches, journal frames and index entries", () => {
		for (const b of [0, 1, 64]) {
			const batch = JSON.parse(batchText(b, 128)) as Batch;
			const frame = {
				v: "usage-journal/1",
				sequence: b + 1,
				at: "2026-10-21T00:00:00.000Z",
				kind: "batch",
				batch,
				code: null,
			};
			expectSame(batch);
			expectSame(frame);
			expectSame(batch.rows);
			expectSame(streams);
			expectSame([batch.stream, batch.incarnation, batch.toCursor.ordinal]);
			expectSame({ ...frame, code: "store-capacity" });
			for (const row of batch.rows.facts) {
				expectSame(row);
				expectSame({ key: "r:component:facts:hash", value: { kind: "row", rowKind: "facts", row } });
				expectSame({ key: `n:${row.id as string}`, value: { kind: "node", identity: row.id, component: "c" } });
			}
			expectSame({ key: "b:key", value: { kind: "receipt", batch: frozenCanonical(batch), code: null, sequence: 1 } });
		}
	});

	it("persist and apply's memo: every text it gives, in persist's order, is the frozen one", () => {
		const batch = JSON.parse(batchText(3, 128)) as Batch;
		const frame = {
			v: "usage-journal/1",
			sequence: 4,
			at: "2026-10-21T00:00:00.000Z",
			kind: "batch",
			batch,
			code: null,
		};
		// Each fact its own component, as in W0's ingest.
		const plans = batch.rows.facts.map((row, i) => ({
			id: `component-${i}`,
			rows: { facts: [row], allocations: [], aliases: [], roots: [], policies: [], memberships: [], snapshots: [] },
		}));
		const memo = new Map<object, string | null>();
		for (const kind of rowKinds) for (const row of batch.rows[kind]) memo.set(row, null);
		for (const p of plans) for (const row of p.rows.facts) memo.set(row, null);
		const listed = memo.size;
		expect(canonical(frame, memo)).toBe(frozenCanonical(frame));
		expect(canonical(batch, memo)).toBe(frozenCanonical(batch));
		for (const p of plans) {
			for (const row of p.rows.facts) {
				const text = canonical(row, memo);
				expect(text).toBe(frozenCanonical(row));
				const entry = {
					key: `r:${p.id}:facts:${createHash("sha256").update(text).digest("hex")}`,
					value: { kind: "row", rowKind: "facts", row },
				};
				expect(canonical(entry, memo)).toBe(frozenCanonical(entry));
			}
			expect(canonical(p.rows, memo)).toBe(frozenCanonical(p.rows));
		}
		for (const p of plans) for (const row of p.rows.facts) expect(canonical(row, memo)).toBe(frozenCanonical(row));
		expect(canonical(batch, memo)).toBe(frozenCanonical(batch));
		// Only the listed rows are kept, each with its frozen text.
		expect(memo.size).toBe(listed);
		for (const [row, text] of memo) expect(text).toBe(frozenCanonical(row));
	});

	it("a kept text is given back as it is, and objects not listed are never kept", () => {
		const row = { b: 2, a: [1, { c: 3 }] };
		const memo = new Map<object, string | null>([[row, "kept"]]);
		expect(canonical(row, memo)).toBe("kept");
		expect(canonical({ x: row }, memo)).toBe('{"x":kept}');
		const other = { a: 1 };
		expect(canonical([other, row], memo)).toBe('[{"a":1},kept]');
		expect(memo.has(other)).toBe(false);
		expect(memo.size).toBe(1);
	});

	it("nested objects and arrays", () => {
		expectSame({ a: [{ b: [[], {}, [1, [2, [3, [4, [5]]]]]] }], c: { d: { e: { f: { g: null } } } } });
		expectSame([[[[[]]]], [{}], [{ a: [{ b: [{ c: [] }] }] }]]);
		expectSame({ z: { y: { x: [{ w: 1, v: [2, { u: 3 }] }] } }, a: [[{ b: 1 }, { b: 2, a: 1 }]] });
		const shared = { s: [1, 2], t: { u: "v" } };
		expectSame({ one: shared, two: [shared, { shared }], three: shared });
		expectSame([1, , 3]); // A hole: both print "[1,,3]".
	});

	it("null and undefined values, and other values JSON has no text for, as before", () => {
		for (const v of [null, undefined, true, false, () => 1, Symbol("s")]) expectSame(v);
		expectSame({ a: undefined, b: null, c: [undefined, null], d: { e: undefined } });
		expectSame([undefined, [undefined], { x: undefined }, null]);
		expectSame({ f: () => 1, g: Symbol("s"), toJSON: () => "ignored" });
		expectSame(new Date(0));
		expectSame([new String("ab"), new Number(1), new Boolean(false)]);
		expectSame(Object.assign(Object.create(null) as object, { b: 1, a: 2 }));
		expectSame(Object.create(null));
	});

	it("unicode keys and values", () => {
		const value: Record<string, unknown> = {};
		for (const [i, k] of unicodeKeys.entries()) value[k] = strings[i % strings.length];
		expectSame(value);
		expectSame(strings);
		expectSame({ 日本語: { "🙂": ["é", "e\u0301"], "\ud800": "\udfff" }, "\u2028": "\u2029" });
	});

	it("number edge cases, as today's code treats them", () => {
		for (const n of numbers) expectSame(n);
		expectSame(numbers);
		const value: Record<string, unknown> = {};
		for (const [i, n] of numbers.entries()) value[`n${i}`] = n;
		expectSame(value);
		expectSame({ negativeZero: -0, list: [-0, 0, -0] });
		expect(canonical(-0)).toBe("0");
		expect(canonical([NaN, Infinity, -Infinity])).toBe("[null,null,null]");
		expect(canonical(1e21)).toBe("1e+21");
		// A BigInt has no JSON text: both throw the same error, at the top or deep inside.
		for (const v of [1n, { a: [1, { b: 2n }] }]) {
			expect(() => frozenCanonical(v)).toThrow(TypeError);
			expect(() => canonical(v)).toThrow(TypeError);
			expect(() => canonical(v, new Map())).toThrow(TypeError);
		}
	});

	it("the same keys in different insertion orders", () => {
		const next = lcg(414);
		const keys = ["kind", "row", "rowKind", "a", "10", "2", "01", "é", ""];
		const texts = new Set<string>();
		for (let round = 0; round < 200; round++) {
			const order = [...keys];
			for (let i = order.length - 1; i > 0; i--) {
				const j = Math.floor(next() * (i + 1));
				[order[i], order[j]] = [order[j], order[i]];
			}
			const value: Record<string, unknown> = {};
			for (const k of order) value[k] = `value of ${k}`;
			expectSame(value);
			texts.add(canonical(value));
		}
		expect(texts.size).toBe(1);
		expectSame([
			{ b: 1, a: 2 },
			{ a: 2, b: 1 },
			{ b: 1, a: 2 },
		]);
	});

	it("keys with likely separator characters never share a shape", () => {
		// Pairs whose key lists would look alike if joined into one text; each order, so either fills the cache first.
		const pairs: [Record<string, unknown>, Record<string, unknown>][] = [
			[{ "a,b": 1 }, { a: 1, b: 2 }],
			[{ "a\u0000b": 1 }, { a: 1, b: 2 }],
			[{ "a:b": 1 }, { a: 1, b: 2 }],
			[
				{ a: 1, "b,c": 2 },
				{ "a,b": 1, c: 2 },
			],
			[{ "": 1 }, {}],
			[{ "": 1, a: 2 }, { a: 1 }],
			[{ '"a"': 1 }, { a: 1 }],
			[
				{ "a\\": 1, b: 2 },
				{ a: 1, "\\b": 2 },
			],
		];
		for (const [x, y] of pairs) {
			expectSame(x);
			expectSame(y);
			expectSame(y);
			expectSame(x);
		}
		const value: Record<string, unknown> = {};
		for (const k of oddKeys) value[k] = k;
		expectSame(value);
		// Prefixes of a key list: the longer one first, then its prefixes, then the longer one again.
		for (const v of [{ a: 1, b: 2, c: 3 }, { a: 1, b: 2 }, { a: 1 }, { a: 1, b: 2, c: 3, d: 4 }, { a: 1, b: 2, c: 3 }])
			expectSame(v);
	});

	it("empty objects", () => {
		for (const v of [{}, [], { a: {} }, [{}], [[]], { a: [] }, { a: { b: {} } }, [{}, [], {}]]) expectSame(v);
		expect(canonical({})).toBe("{}");
		expect(canonical([])).toBe("[]");
	});

	it("fixed pseudo-random values", () => {
		const next = lcg(20261022);
		for (let i = 0; i < 2000; i++) expectSame(randomValue(next, 4));
	});

	it("the shape cache keeps to its bound and stays right after it is emptied", () => {
		const bound = shapes();
		expect(bound).toMatchObject({ max: 1024, maxKeys: 64 });
		const many = Array.from({ length: 3000 }, (_, i) => ({ [`k${i}`]: i, [`j${i % 7}`]: [i], shared: { i } }));
		for (const v of many) {
			expectSame(v);
			expect(shapes().count).toBeLessThanOrEqual(1024);
		}
		for (const v of many.slice(0, 50)) expectSame(v);
		// More keys than maxKeys: sorted every time, never cached.
		for (const size of [65, 200]) {
			const before = shapes().count;
			const wide: Record<string, unknown> = {};
			for (let i = size - 1; i >= 0; i--) wide[`w${i}`] = i % 2 ? { i } : [i];
			expectSame(wide);
			expect(shapes().count).toBe(before);
		}
		const sixtyFour: Record<string, number> = {};
		for (let i = 63; i >= 0; i--) sixtyFour[`s${i}`] = i;
		expectSame(sixtyFour);
	});
});
