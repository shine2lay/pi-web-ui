// @vitest-environment jsdom
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BOARD_DRAFT_DATABASE,
	BOARD_DRAFT_OBJECT_STORE,
	BOARD_DRAFT_PURPOSE,
	BoardDraftError,
	boardDraftKey,
	copyBoardDraftRecord,
	copyBoardDraftSource,
	createBoardDraftIndexedDB,
	createBoardDraftStore,
	encodeBoardDraftRecord,
	encodeBoardDraftSource,
	inspectBoardDrafts,
	type BoardDraftForm,
	type BoardDraftRecord,
	type BoardDraftSource,
	type BoardDraftStorage,
} from "../../web/src/board-draft-store.js";
import { exportRawBoardDraftRow, mountBoardDraftReader } from "../../web/src/board-draft-reader.js";

function postSource(revision = 0, patch: Partial<BoardDraftSource> = {}): BoardDraftSource {
	return {
		editorId: "editor-post-A é 🌈",
		revision,
		form: {
			type: "board_post",
			kind: "order",
			toAll: true,
			picked: ["temper", "ops", "qa"],
			title: "  Title é 🌈\t ",
			text: "\nfirst line\nsecond é 🌈\t  ",
		},
		...patch,
	};
}

function closeSource(revision = 0, patch: Partial<BoardDraftSource> = {}): BoardDraftSource {
	return {
		editorId: "editor-close-A é 🌈",
		revision,
		form: {
			type: "board_close",
			id: "bp-fixture-A",
			note: "  pause lifted é 🌈\t\n ",
		},
		...patch,
	};
}

const clone = <T>(value: T): T => structuredClone(value);

const REPO = process.cwd();
const PINNED_OLD_COMMIT = "a875d2bc676a2ee90ade541b0d7fbfb4db364c74";
const PINNED_OLD_READER_BLOB = "c4c554243e509b97a79e8489efabbb4608e688ec";

type TypedArrayConstructor =
	| Int8ArrayConstructor
	| Uint8ArrayConstructor
	| Uint8ClampedArrayConstructor
	| Int16ArrayConstructor
	| Uint16ArrayConstructor
	| Int32ArrayConstructor
	| Uint32ArrayConstructor
	| Float32ArrayConstructor
	| Float64ArrayConstructor
	| BigInt64ArrayConstructor
	| BigUint64ArrayConstructor;

const TYPED_ARRAY_CTORS: Readonly<Record<string, TypedArrayConstructor>> = {
	"[object Int8Array]": Int8Array,
	"[object Uint8Array]": Uint8Array,
	"[object Uint8ClampedArray]": Uint8ClampedArray,
	"[object Int16Array]": Int16Array,
	"[object Uint16Array]": Uint16Array,
	"[object Int32Array]": Int32Array,
	"[object Uint32Array]": Uint32Array,
	"[object Float32Array]": Float32Array,
	"[object Float64Array]": Float64Array,
	"[object BigInt64Array]": BigInt64Array,
	"[object BigUint64Array]": BigUint64Array,
};

function isArrayBufferValue(value: unknown): value is ArrayBuffer {
	return value instanceof ArrayBuffer || Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}

function reconstructRawBoardGraph(exportedText: string): { key: string; value: unknown } {
	const parsed = JSON.parse(exportedText) as { format?: unknown; row?: unknown };
	if (parsed.format !== "board-purpose-store-raw-graph-v1") {
		throw new Error(`Unexpected raw export format: ${String(parsed.format)}`);
	}
	const byId = new Map<number, unknown>();

	function decode(node: unknown): unknown {
		if (node === null || typeof node === "string" || typeof node === "boolean" || typeof node === "number") {
			return node;
		}
		if (typeof node !== "object") {
			throw new Error("Invalid non-object node in raw graph");
		}
		const record = node as Record<string, unknown>;
		if ("reference" in record) {
			const refId = record.reference;
			if (typeof refId !== "number" || !byId.has(refId)) {
				throw new Error(`Unresolved graph reference: ${String(refId)}`);
			}
			return byId.get(refId);
		}
		if (!("id" in record)) {
			if (record.type === "undefined" && record.value === "undefined") return undefined;
			if (record.type === "bigint" && typeof record.value === "string") return BigInt(record.value);
			if (record.type === "number" && typeof record.value === "string") {
				if (record.value === "-0") return -0;
				if (record.value === "NaN") return NaN;
				if (record.value === "Infinity") return Infinity;
				if (record.value === "-Infinity") return -Infinity;
			}
			throw new Error(`Unsupported primitive wrapper tag: ${JSON.stringify(record)}`);
		}
		const id = record.id;
		const type = record.type;
		if (typeof id !== "number" || typeof type !== "string" || byId.has(id)) {
			throw new Error(`Invalid or duplicate object node id: ${String(id)}`);
		}
		if (type === "Date") {
			const ms = decode(record.milliseconds);
			if (typeof ms !== "number") throw new Error("Invalid Date milliseconds");
			const date = new Date(ms);
			byId.set(id, date);
			return date;
		}
		if (type === "RegExp") {
			if (typeof record.source !== "string" || typeof record.flags !== "string") {
				throw new Error("Invalid RegExp node");
			}
			const regex = new RegExp(record.source, record.flags);
			byId.set(id, regex);
			return regex;
		}
		if (type === "ArrayBuffer") {
			if (!Array.isArray(record.bytes)) throw new Error("Invalid ArrayBuffer bytes");
			const ab = new Uint8Array(record.bytes as number[]).buffer;
			byId.set(id, ab);
			return ab;
		}
		if (type === "[object DataView]" || type in TYPED_ARRAY_CTORS) {
			if (!("buffer" in record) || typeof record.byteOffset !== "number" || typeof record.byteLength !== "number") {
				throw new Error("Binary view node is missing backing buffer or byteOffset/byteLength metadata");
			}
			const backing = decode(record.buffer);
			if (!isArrayBufferValue(backing)) {
				throw new Error("Binary view buffer did not reconstruct to an ArrayBuffer");
			}
			if (type === "[object DataView]") {
				const view = new DataView(backing, record.byteOffset, record.byteLength);
				byId.set(id, view);
				return view;
			}
			const Ctor = TYPED_ARRAY_CTORS[type]!;
			if (record.byteLength % Ctor.BYTES_PER_ELEMENT !== 0) {
				throw new Error(`Invalid byteLength ${record.byteLength} for ${type}`);
			}
			const view = new Ctor(backing, record.byteOffset, record.byteLength / Ctor.BYTES_PER_ELEMENT);
			byId.set(id, view);
			return view;
		}
		if (type === "Blob" || type === "File") {
			if (!Array.isArray(record.bytes) || typeof record.mime !== "string") {
				throw new Error("Invalid Blob/File node");
			}
			const bytes = new Uint8Array(record.bytes as number[]);
			const value =
				type === "File" && typeof File !== "undefined"
					? new File([bytes], String(record.name ?? ""), {
							type: record.mime,
							lastModified: Number(record.lastModified ?? 0),
						})
					: new Blob([bytes], { type: record.mime });
			byId.set(id, value);
			return value;
		}
		if (type === "Map") {
			const map = new Map<unknown, unknown>();
			byId.set(id, map);
			for (const [k, v] of record.entries as [unknown, unknown][]) {
				map.set(decode(k), decode(v));
			}
			return map;
		}
		if (type === "Set") {
			const set = new Set<unknown>();
			byId.set(id, set);
			for (const item of record.entries as unknown[]) {
				set.add(decode(item));
			}
			return set;
		}
		if (type === "Array") {
			const arr: unknown[] = [];
			byId.set(id, arr);
			for (const [k, v] of record.entries as [string, unknown][]) {
				(arr as unknown as Record<string, unknown>)[k] = decode(v);
			}
			return arr;
		}
		const obj: Record<string, unknown> = {};
		byId.set(id, obj);
		for (const [k, v] of record.entries as [string, unknown][]) {
			obj[k] = decode(v);
		}
		return obj;
	}

	return decode(parsed.row) as { key: string; value: unknown };
}

function verifyEqualVisiblePairOracle(exportA: string, exportB: string): void {
	if (exportA === exportB) {
		throw new Error("Equal-visible views over unequal backing buffers collapsed into identical exports");
	}
	const rowA = reconstructRawBoardGraph(exportA).value as { view: Uint8Array };
	const rowB = reconstructRawBoardGraph(exportB).value as { view: Uint8Array };
	expect(rowA.view).toBeInstanceOf(Uint8Array);
	expect(rowB.view).toBeInstanceOf(Uint8Array);
	expect([...rowA.view]).toStrictEqual([7, 8]);
	expect([...rowB.view]).toStrictEqual([7, 8]);
	expect(rowA.view.byteOffset).toBe(1);
	expect(rowA.view.byteLength).toBe(2);
	expect(rowB.view.byteOffset).toBe(1);
	expect(rowB.view.byteLength).toBe(2);
	expect([...new Uint8Array(rowA.view.buffer)]).toStrictEqual([1, 7, 8, 4]);
	expect([...new Uint8Array(rowB.view.buffer)]).toStrictEqual([9, 7, 8, 6, 5]);
}

function verifySharedBinaryGraphOracle(exportedText: string): void {
	const value = reconstructRawBoardGraph(exportedText).value as {
		slicedUint8: Uint8Array;
		dataView: DataView;
		sharedUint16: Uint16Array;
		backing: ArrayBuffer;
		slicedAlias: Uint8Array;
		self: unknown;
	};
	expect(isArrayBufferValue(value.backing)).toBe(true);
	expect([...new Uint8Array(value.backing)]).toStrictEqual([10, 20, 30, 40, 50, 60, 70, 80]);
	expect(value.slicedUint8).toBeInstanceOf(Uint8Array);
	expect(value.slicedUint8.byteOffset).toBe(2);
	expect(value.slicedUint8.byteLength).toBe(3);
	expect([...value.slicedUint8]).toStrictEqual([30, 40, 50]);
	expect(value.dataView).toBeInstanceOf(DataView);
	expect(value.dataView.byteOffset).toBe(1);
	expect(value.dataView.byteLength).toBe(5);
	expect([
		...new Uint8Array(value.dataView.buffer, value.dataView.byteOffset, value.dataView.byteLength),
	]).toStrictEqual([20, 30, 40, 50, 60]);
	expect(value.sharedUint16).toBeInstanceOf(Uint16Array);
	expect(value.sharedUint16.byteOffset).toBe(2);
	expect(value.sharedUint16.byteLength).toBe(4);
	expect(value.sharedUint16.length).toBe(2);
	expect(value.slicedUint8.buffer).toBe(value.dataView.buffer);
	expect(value.slicedUint8.buffer).toBe(value.sharedUint16.buffer);
	expect(value.slicedUint8.buffer).toBe(value.backing);
	expect(value.slicedAlias).toBe(value.slicedUint8);
	expect(value.self).toBe(value);
}

let cachedPinnedOldExporter: ((row: { key: string; value: unknown }) => Promise<string>) | undefined;
async function loadPinnedOldRawExporter(): Promise<(row: { key: string; value: unknown }) => Promise<string>> {
	if (cachedPinnedOldExporter) return cachedPinnedOldExporter;
	const blobSha = execFileSync("git", ["rev-parse", `${PINNED_OLD_COMMIT}:web/src/board-draft-reader.ts`], {
		cwd: REPO,
		encoding: "utf8",
	}).trim();
	expect(blobSha).toBe(PINNED_OLD_READER_BLOB);
	const oldReaderSource = execFileSync("git", ["show", `${PINNED_OLD_COMMIT}:web/src/board-draft-reader.ts`], {
		cwd: REPO,
		encoding: "utf8",
	});
	const bundledJs = execFileSync(
		join(REPO, "node_modules/esbuild/bin/esbuild"),
		["--bundle", "--format=esm", "--loader=ts", "--sourcefile=board-draft-reader-a875d2bc.ts"],
		{
			cwd: join(REPO, "web/src"),
			input: oldReaderSource,
			encoding: "utf8",
		},
	);
	const dataUrl = `data:text/javascript;base64,${Buffer.from(bundledJs, "utf8").toString("base64")}`;
	const mod = (await import(/* @vite-ignore */ dataUrl)) as {
		exportRawBoardDraftRow: (row: { key: string; value: unknown }) => Promise<string>;
	};
	cachedPinnedOldExporter = mod.exportRawBoardDraftRow;
	return cachedPinnedOldExporter;
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((yes) => (resolve = yes));
	return { promise, resolve };
}

class MemoryStorage implements BoardDraftStorage {
	rows = new Map<string, unknown>();
	readFailure = false;
	readReplacement: unknown;
	beforeSwap?: () => Promise<void>;
	afterRequest?: () => Promise<void>;
	abort = false;
	postCommitFailure = false;
	requests = 0;
	completions = 0;
	private tail = Promise.resolve();

	async read(key: string) {
		if (this.readFailure) throw new Error("synthetic read failure");
		const value = this.readReplacement ?? this.rows.get(key);
		if (this.rows.has(key) && value === undefined) throw new BoardDraftError("invalid-record");
		return clone(value);
	}

	async scan() {
		if (this.readFailure) throw new Error("synthetic inspection failure");
		return { status: "present" as const, rows: [...this.rows].map(([key, value]) => ({ key, value: clone(value) })) };
	}

	async swap(key: string, expected: string | null, replacement: BoardDraftRecord) {
		await this.beforeSwap?.();
		const previous = this.tail;
		const gate = deferred();
		this.tail = previous.then(() => gate.promise);
		await previous;
		try {
			const prior = this.rows.get(key);
			if ((this.rows.has(key) ? encodeBoardDraftRecord(prior) : null) !== expected)
				throw new BoardDraftError("conflict");
			this.requests++;
			await this.afterRequest?.();
			if (this.abort) throw new BoardDraftError("transaction-failed");
			this.rows.set(key, clone(replacement));
			this.completions++;
			if (this.postCommitFailure) throw new Error("synthetic committed-then-failed boundary");
		} finally {
			gate.resolve();
		}
	}
}

function fixture() {
	const storage = new MemoryStorage();
	let nonce = 0;
	return { storage, store: createBoardDraftStore(storage, () => `synthetic-board-nonce-${++nonce}`) };
}

afterEach(() => {
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

describe("strict #593 Board source contract and immutable bytes", () => {
	it("exposes purpose-specific database, store and purpose identifiers", () => {
		expect(BOARD_DRAFT_DATABASE).toBe("pi-authored-board-drafts-v1");
		expect(BOARD_DRAFT_OBJECT_STORE).toBe("authored-board-drafts");
		expect(BOARD_DRAFT_PURPOSE).toBe("authored-board-draft");
	});

	it.each([
		[
			"post news toAll=true with inactive picked order",
			postSource(17, {
				form: { ...postSource().form, kind: "news", toAll: true, picked: ["qa", "temper", "ops"] } as BoardDraftForm,
			}),
		],
		[
			"post order toAll=false with unsorted picked order",
			postSource(23, {
				form: {
					...postSource().form,
					kind: "order",
					toAll: false,
					picked: ["temper", "architecture", "ops"],
				} as BoardDraftForm,
			}),
		],
		["close with raw whitespace and Unicode note", closeSource(9)],
		["close with empty note", closeSource(0, { form: { type: "board_close", id: "bp-empty-note", note: "" } })],
	])("preserves exact fields, order, whitespace and immutability for %s", (_label, input) => {
		const result = copyBoardDraftSource(input);
		expect(result).toStrictEqual(input);
		expect(result).not.toBe(input);
		expect(result.form).not.toBe(input.form);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.form)).toBe(true);
		if (result.form.type === "board_post") {
			expect(result.form.picked).not.toBe((input.form as Extract<BoardDraftForm, { type: "board_post" }>).picked);
			expect(Object.isFrozen(result.form.picked)).toBe(true);
		}
		expect(JSON.parse(encodeBoardDraftSource(result))).toStrictEqual(input);
	});

	it("preserves empty clears, inactive picked arrays, null prototypes and negative zero revision", () => {
		const rawPostForm = Object.assign(Object.create(null), {
			type: "board_post" as const,
			kind: "news" as const,
			toAll: true,
			picked: ["temper", "ops"],
			title: "",
			text: "",
		});
		const input = Object.assign(Object.create(null), postSource(-0, { form: rawPostForm }));
		const result = copyBoardDraftSource(input);
		expect(result.form).toStrictEqual({
			type: "board_post",
			kind: "news",
			toAll: true,
			picked: ["temper", "ops"],
			title: "",
			text: "",
		});
		expect(encodeBoardDraftSource(result)).toContain('"revision":-0');
		expect(JSON.parse(encodeBoardDraftSource(result))).toStrictEqual(result);
	});

	for (const key of ["editorId", "revision", "form"]) {
		it(`rejects missing source ${key}`, () => {
			const value = { ...postSource() } as Record<string, unknown>;
			delete value[key];
			expect(() => copyBoardDraftSource(value)).toThrow(BoardDraftError);
		});

		it(`rejects source accessor ${key} without invoking it`, () => {
			const getter = vi.fn(() => {
				throw new Error("must not run");
			});
			const value = Object.defineProperty({ ...postSource() }, key, { enumerable: true, get: getter });
			expect(() => copyBoardDraftSource(value)).toThrow(BoardDraftError);
			expect(getter).not.toHaveBeenCalled();
		});
	}

	for (const key of ["type", "kind", "toAll", "picked", "title", "text"]) {
		it(`rejects missing/invalid/accessor board_post form ${key}`, () => {
			const form = { ...(postSource().form as Extract<BoardDraftForm, { type: "board_post" }>) } as Record<
				string,
				unknown
			>;
			delete form[key];
			expect(() => copyBoardDraftSource(postSource(0, { form: form as unknown as BoardDraftForm }))).toThrow(
				BoardDraftError,
			);
			form[key] =
				key === "type"
					? "board_unknown"
					: key === "kind"
						? "directive"
						: key === "toAll"
							? "true"
							: key === "picked"
								? ["ops", 7]
								: 42;
			expect(() => copyBoardDraftSource(postSource(0, { form: form as unknown as BoardDraftForm }))).toThrow(
				BoardDraftError,
			);
			const getter = vi.fn(() => {
				throw new Error("must not run");
			});
			Object.defineProperty(form, key, { enumerable: true, get: getter });
			expect(() => copyBoardDraftSource(postSource(0, { form: form as unknown as BoardDraftForm }))).toThrow(
				BoardDraftError,
			);
			expect(getter).not.toHaveBeenCalled();
		});
	}

	for (const key of ["type", "id", "note"]) {
		it(`rejects missing/invalid/accessor board_close form ${key}`, () => {
			const form = { ...(closeSource().form as Extract<BoardDraftForm, { type: "board_close" }>) } as Record<
				string,
				unknown
			>;
			delete form[key];
			expect(() => copyBoardDraftSource(closeSource(0, { form: form as unknown as BoardDraftForm }))).toThrow(
				BoardDraftError,
			);
			form[key] = key === "type" ? "board_unknown" : key === "id" ? "" : 99;
			expect(() => copyBoardDraftSource(closeSource(0, { form: form as unknown as BoardDraftForm }))).toThrow(
				BoardDraftError,
			);
			const getter = vi.fn(() => {
				throw new Error("must not run");
			});
			Object.defineProperty(form, key, { enumerable: true, get: getter });
			expect(() => copyBoardDraftSource(closeSource(0, { form: form as unknown as BoardDraftForm }))).toThrow(
				BoardDraftError,
			);
			expect(getter).not.toHaveBeenCalled();
		});
	}

	it.each([
		{ editorId: "" },
		{ editorId: null },
		{ revision: -1 },
		{ revision: 1.5 },
		{ revision: NaN },
		{ revision: Infinity },
		{ revision: Number.MAX_SAFE_INTEGER + 1 },
		{ ownerWords: "not allowed" },
		{ reqId: "board-1" },
		{ form: { ...postSource().form, ownerWords: "authority field" } },
		{ form: { ...postSource().form, to: "all" } },
		{ form: { ...closeSource().form, ownerWords: "authority field" } },
		{ form: { ...closeSource().form, id: "" } },
	])("rejects invalid/authority/wire source %#", (patch) =>
		expect(() => copyBoardDraftSource({ ...postSource(), ...patch } as unknown)).toThrow(BoardDraftError),
	);

	it("rejects sparse picked arrays, array getters, symbols, hidden fields and inherited prototypes", () => {
		const sparse = new Array<string>(2);
		sparse[0] = "ops";
		const pickedGetter = vi.fn(() => "ops");
		const arrayWithGetter = Object.defineProperty(["ops"], "0", { enumerable: true, get: pickedGetter });
		const arrayWithExtra = Object.assign(["ops"], { extra: true });
		for (const candidate of [
			postSource(0, {
				form: { ...(postSource().form as Extract<BoardDraftForm, { type: "board_post" }>), picked: sparse },
			}),
			postSource(0, {
				form: { ...(postSource().form as Extract<BoardDraftForm, { type: "board_post" }>), picked: arrayWithGetter },
			}),
			postSource(0, {
				form: { ...(postSource().form as Extract<BoardDraftForm, { type: "board_post" }>), picked: arrayWithExtra },
			}),
			{ ...postSource(), [Symbol("foreign")]: 1 },
			Object.defineProperty({ ...postSource() }, "hidden", { value: true }),
			Object.assign(Object.create({ inherited: true }), postSource()),
			postSource(0, { form: Object.assign(Object.create({ inherited: true }), postSource().form) }),
		]) {
			expect(() => copyBoardDraftSource(candidate)).toThrow(BoardDraftError);
		}
		expect(pickedGetter).not.toHaveBeenCalled();
	});

	it("validates boardDraftKey identities and target descriptors without invoking getters", () => {
		expect(boardDraftKey({ editorId: "editor-1" })).toBe("editor-1");
		expect(boardDraftKey(postSource())).toBe(postSource().editorId);
		expect(boardDraftKey(closeSource())).toBe(closeSource().editorId);
		const getter = vi.fn();
		expect(() => boardDraftKey({ editorId: "" })).toThrow(BoardDraftError);
		expect(() =>
			boardDraftKey(Object.defineProperty({}, "editorId", { enumerable: true, get: getter }) as never),
		).toThrow(BoardDraftError);
		expect(() => boardDraftKey({ editorId: "editor-1", form: { type: "board_close", id: "" } })).toThrow(
			BoardDraftError,
		);
		expect(() =>
			boardDraftKey({
				editorId: "editor-1",
				form: Object.defineProperty({ type: "board_close" }, "id", { enumerable: true, get: getter }) as never,
			}),
		).toThrow(BoardDraftError);
		expect(getter).not.toHaveBeenCalled();
	});
});

describe("atomic creation, lifetime/target/revision fences and exact CAS", () => {
	it("atomically creates initial current plus initial submitted source(s) in one record commit", async () => {
		const { storage, store } = fixture();
		const a0 = closeSource(0, { form: { type: "board_close", id: "bp-atomic-1", note: "" } });
		const createdSame = await store.create(a0, a0);
		expect(createdSame.version).toBe(0);
		expect(createdSame.current).toStrictEqual(a0);
		expect(createdSame.submitted).toStrictEqual([a0]);
		expect(storage.requests).toBe(1);
		expect(storage.completions).toBe(1);

		const b0 = postSource(1, { editorId: "editor-atomic-post" });
		const bCurrent = postSource(3, {
			editorId: "editor-atomic-post",
			form: { ...(b0.form as Extract<BoardDraftForm, { type: "board_post" }>), title: "Edited B", text: "" },
		});
		const createdPair = await store.create(bCurrent, [b0]);
		expect(createdPair.version).toBe(0);
		expect(createdPair.current).toStrictEqual(bCurrent);
		expect(createdPair.submitted).toStrictEqual([b0]);
		expect(storage.requests).toBe(2);
		expect(storage.completions).toBe(2);
		expect(await store.load(b0)).toStrictEqual(createdPair);
	});

	it("rejects invalid or conflicting initial submitted sources during create without writing", async () => {
		const { storage, store } = fixture();
		const current = postSource(1);
		const getter = vi.fn();
		const sparse = new Array<BoardDraftSource>(1);
		const getterArray = Object.defineProperty([], "0", { enumerable: true, get: getter });
		for (const badSubmitted of [null, 42, sparse, getterArray, [{ ...current, extra: true }]]) {
			await expect(store.create(current, badSubmitted)).rejects.toMatchObject({
				code: "invalid-source",
				transactionCompleted: false,
			});
		}
		expect(getter).not.toHaveBeenCalled();

		for (const conflictingSubmitted of [
			postSource(2), // ahead of current
			postSource(1, {
				form: { ...(current.form as Extract<BoardDraftForm, { type: "board_post" }>), title: "different at same rev" },
			}),
			postSource(0, { editorId: "other-editor" }),
			closeSource(0, { editorId: current.editorId }),
			[postSource(0), postSource(0)], // duplicate revision in submitted array
		]) {
			await expect(store.create(current, conflictingSubmitted)).rejects.toMatchObject({
				code: "conflict",
				transactionCompleted: false,
			});
		}
		expect(storage.rows.size).toBe(0);
		expect(storage.requests).toBe(0);
	});

	it("keeps immutable submitted A beside current B and appends original once under fresh CAS", async () => {
		const { store } = fixture();
		const a = postSource(1);
		const created = await store.create(a);
		const b = postSource(2, {
			form: {
				type: "board_post",
				kind: "news",
				toAll: false,
				picked: ["ops", "temper"],
				title: "",
				text: "current B é 🌈",
			},
		});
		const current = await store.updateCurrent(created, b);
		await expect(store.retainSubmitted(created, a)).rejects.toMatchObject({ code: "conflict" });
		const retained = await store.retainSubmitted((await store.load(a))!, a);
		expect(retained.current).toStrictEqual(b);
		expect(retained.submitted).toStrictEqual([a]);
		expect(retained.version).toBe(current.version + 1);
		expect(await store.retainSubmitted(retained, a)).toStrictEqual(retained);
		await expect(
			store.retainSubmitted(
				retained,
				postSource(1, { form: { ...(a.form as Extract<BoardDraftForm, { type: "board_post" }>), text: "altered A" } }),
			),
		).rejects.toMatchObject({ code: "conflict" });
	});

	it("has genuine A/B/ABA revision fences for both post and close drafts", async () => {
		const { store } = fixture();
		for (const base of [postSource(1), closeSource(1)]) {
			const first = await store.create(base);
			const editedForm: BoardDraftForm =
				base.form.type === "board_post" ? { ...base.form, text: "B" } : { ...base.form, note: "B" };
			const b = await store.updateCurrent(first, { ...base, revision: 2, form: editedForm });
			const aba = await store.updateCurrent(b, { ...base, revision: 3 });
			expect(aba.current.form).toStrictEqual(base.form);
			await expect(store.updateCurrent(first, { ...base, revision: 99 })).rejects.toMatchObject({ code: "conflict" });
			await expect(store.retire(first)).rejects.toMatchObject({ code: "conflict" });
			expect(await store.load(base)).toStrictEqual(aba);
		}
	});

	it("fences concurrent/out-of-order writers without rollback", async () => {
		const { storage, store } = fixture();
		const record = await store.create(postSource());
		const gate = deferred();
		storage.beforeSwap = () => gate.promise;
		const late = store.updateCurrent(
			record,
			postSource(1, {
				form: { ...(postSource().form as Extract<BoardDraftForm, { type: "board_post" }>), text: "late A" },
			}),
		);
		storage.beforeSwap = undefined;
		const b = await store.updateCurrent(
			record,
			postSource(2, {
				form: { ...(postSource().form as Extract<BoardDraftForm, { type: "board_post" }>), text: "newer B" },
			}),
		);
		const refused = expect(late).rejects.toMatchObject({ code: "conflict" });
		gate.resolve();
		await refused;
		expect(await store.load(postSource())).toStrictEqual(b);
	});

	it("only one same-revision concurrent CAS can commit", async () => {
		const { store } = fixture();
		const record = await store.create(closeSource());
		const results = await Promise.allSettled([
			store.updateCurrent(record, closeSource(1, { form: { type: "board_close", id: "bp-fixture-A", note: "one" } })),
			store.updateCurrent(record, closeSource(1, { form: { type: "board_close", id: "bp-fixture-A", note: "two" } })),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
	});

	it("fences stale editorId, post-vs-close type switch, and close target id switch", async () => {
		const { store } = fixture();
		const postRecord = await store.create(postSource(0));
		const closeRecord = await store.create(closeSource(0));

		// Different editorId cannot update or attach submitted to postRecord
		await expect(
			store.updateCurrent(postRecord, postSource(999, { editorId: "foreign-editor" })),
		).rejects.toMatchObject({
			code: "conflict",
		});
		await expect(
			store.retainSubmitted(postRecord, postSource(0, { editorId: "foreign-editor" })),
		).rejects.toMatchObject({
			code: "conflict",
		});

		// Same editorId switching between board_post and board_close is rejected everywhere
		const postAsClose = closeSource(999, { editorId: postRecord.current.editorId });
		await expect(store.updateCurrent(postRecord, postAsClose)).rejects.toMatchObject({ code: "conflict" });
		await expect(store.retainSubmitted(postRecord, { ...postAsClose, revision: 0 })).rejects.toMatchObject({
			code: "conflict",
		});
		await expect(store.create(postAsClose)).rejects.toMatchObject({ code: "conflict" });
		await expect(store.load(postAsClose)).rejects.toMatchObject({ code: "conflict" });

		// Same editorId switching board_close target id (bp-fixture-A -> bp-fixture-B) is rejected everywhere
		const closeOtherTarget = closeSource(999, {
			editorId: closeRecord.current.editorId,
			form: { type: "board_close", id: "bp-fixture-B", note: "switched target" },
		});
		await expect(store.updateCurrent(closeRecord, closeOtherTarget)).rejects.toMatchObject({ code: "conflict" });
		await expect(store.retainSubmitted(closeRecord, { ...closeOtherTarget, revision: 0 })).rejects.toMatchObject({
			code: "conflict",
		});
		await expect(store.create(closeOtherTarget)).rejects.toMatchObject({ code: "conflict" });
		await expect(store.load(closeOtherTarget)).rejects.toMatchObject({ code: "conflict" });

		// Loading by editorId alone or with matching target succeeds
		expect(await store.load({ editorId: postRecord.current.editorId })).toStrictEqual(postRecord);
		expect(await store.load({ editorId: closeRecord.current.editorId })).toStrictEqual(closeRecord);
		expect(await store.load(postSource())).toStrictEqual(postRecord);
		expect(await store.load(closeSource())).toStrictEqual(closeRecord);
	});

	it("rejects lower revisions and same-revision different bytes, including immutable originals", async () => {
		const { store } = fixture();
		const record = await store.create(postSource(5));
		await expect(store.updateCurrent(record, postSource(4))).rejects.toMatchObject({ code: "conflict" });
		await expect(
			store.updateCurrent(
				record,
				postSource(5, {
					form: { ...(postSource().form as Extract<BoardDraftForm, { type: "board_post" }>), title: "different" },
				}),
			),
		).rejects.toMatchObject({ code: "conflict" });
		await expect(
			store.retainSubmitted(
				record,
				postSource(5, {
					form: { ...(postSource().form as Extract<BoardDraftForm, { type: "board_post" }>), title: "different" },
				}),
			),
		).rejects.toMatchObject({ code: "conflict" });
		expect(await store.updateCurrent(record, postSource(5))).toStrictEqual(record);
	});

	it("exact retirement retains every byte, fences subsequent edits and is not a delete", async () => {
		const { storage, store } = fixture();
		let record = await store.create(closeSource(0));
		record = await store.retainSubmitted(record, record.current);
		const newer = await store.updateCurrent(
			record,
			closeSource(1, { form: { type: "board_close", id: "bp-fixture-A", note: "B" } }),
		);
		await expect(store.retire(record)).rejects.toMatchObject({ code: "conflict" });
		const retired = await store.retire(newer);
		expect(retired).toStrictEqual({ ...newer, version: newer.version + 1, retired: true });
		expect(storage.rows.size).toBe(1);
		expect(await store.retire(retired)).toStrictEqual(retired);
		await expect(store.updateCurrent(retired, closeSource(100))).rejects.toMatchObject({ code: "retired" });
		await expect(store.retainSubmitted(retired, closeSource(0))).rejects.toMatchObject({ code: "retired" });
		await expect(store.create(closeSource(100))).rejects.toMatchObject({ code: "conflict" });
		expect((await store.inspect()).records).toStrictEqual([retired]);
	});

	it("record nonce/full bytes fence same-key external replacement ABA", async () => {
		const { storage, store } = fixture();
		const a = await store.create(postSource());
		const replacement = { ...clone(a), recordId: "genuine-other-incarnation" };
		storage.rows.set(boardDraftKey(a.current), replacement);
		await expect(store.updateCurrent(a, postSource(999))).rejects.toMatchObject({ code: "conflict" });
		await expect(store.retire(a)).rejects.toMatchObject({ code: "conflict" });
		expect(await store.load(a.current)).toStrictEqual(replacement);
	});
});

describe("key presence is distinct from a stored undefined or other corrupt value", () => {
	it("only a genuinely absent key returns absence and allows creation, then normal exact CAS", async () => {
		const { storage, store } = fixture();
		const a = postSource();
		const key = boardDraftKey(a);
		expect(storage.rows.has(key)).toBe(false);
		expect(await storage.read(key)).toBeUndefined();
		expect(await store.load(a)).toBeUndefined();
		const first = await store.create(a);
		expect(storage.rows.has(key)).toBe(true);
		expect(await storage.read(key)).toStrictEqual(first);
		await expect(store.create(a)).rejects.toMatchObject({ code: "conflict", transactionCompleted: false });
		const b = postSource(1, {
			form: { ...(a.form as Extract<BoardDraftForm, { type: "board_post" }>), text: "valid presence CAS" },
		});
		const next = await store.updateCurrent(first, b);
		expect(await store.load(a)).toStrictEqual(next);
		expect(next.current).toStrictEqual(b);
	});

	it.each([
		["undefined", undefined],
		["null", null],
		["false", false],
		["zero", 0],
		["empty string", ""],
		["foreign object", { purpose: "future", schemaVersion: 900 }],
	])("keeps present %s discoverable/exportable and refuses every overwrite path", async (_label, value) => {
		const { storage, store } = fixture();
		const a = postSource();
		const prior = await store.create(a);
		const key = boardDraftKey(a);
		storage.rows.set(key, value);
		const before = clone([...storage.rows]);
		const rawBefore = await exportRawBoardDraftRow({ key, value });
		for (const operation of [
			() => store.load(a),
			() => store.load({ editorId: a.editorId }),
			() => store.create(a),
			() => store.create(a, a),
			() => store.updateCurrent(prior, postSource(1)),
			() => store.retainSubmitted(prior, a),
			() => store.retire(prior),
		]) {
			await expect(operation()).rejects.toMatchObject({ code: "invalid-record", transactionCompleted: false });
			expect(storage.rows.has(key)).toBe(true);
			expect([...storage.rows]).toStrictEqual(before);
		}
		const inspected = await store.inspect();
		expect(inspected).toStrictEqual({ status: "corrupt", records: [], unknown: [{ key, value }] });
		expect(await exportRawBoardDraftRow(inspected.unknown[0])).toBe(rawBefore);
		const exported = JSON.parse(rawBefore);
		expect(exported.format).toBe("board-purpose-store-raw-graph-v1");
		expect(exported.row.entries).toContainEqual(["key", key]);
		if (value === undefined)
			expect(exported.row.entries).toContainEqual(["value", { type: "undefined", value: "undefined" }]);
		expect(storage.requests).toBe(1);
		expect(storage.completions).toBe(1);
	});
});

describe("observable transaction and readback failures", () => {
	it("request success cannot resolve a transaction that subsequently aborts", async () => {
		const { storage, store } = fixture();
		const prior = await store.create(postSource());
		const gate = deferred();
		const arrived = deferred();
		storage.afterRequest = () => {
			arrived.resolve();
			return gate.promise;
		};
		storage.abort = true;
		let settled = false;
		const pending = store.updateCurrent(prior, postSource(1));
		void pending.then(
			() => (settled = true),
			() => (settled = true),
		);
		await arrived.promise;
		expect(storage.requests).toBe(2);
		expect(storage.completions).toBe(1);
		expect(settled).toBe(false);
		const refused = expect(pending).rejects.toMatchObject({ code: "transaction-failed", transactionCompleted: false });
		gate.resolve();
		await refused;
		expect(await store.load(postSource())).toStrictEqual(prior);
	});

	it("committed-then-readback-failed stays recoverable and is NOT confirmed", async () => {
		const { storage, store } = fixture();
		const prior = await store.create(postSource());
		storage.readFailure = true;
		await expect(store.updateCurrent(prior, postSource(1))).rejects.toMatchObject({
			code: "readback-failed",
			transactionCompleted: true,
		});
		storage.readFailure = false;
		expect((await store.load(postSource()))!.current).toStrictEqual(postSource(1));
	});

	it("committed-then-boundary-failed is uncertain, not rolled back", async () => {
		const { storage, store } = fixture();
		const prior = await store.create(postSource());
		storage.postCommitFailure = true;
		await expect(store.updateCurrent(prior, postSource(1))).rejects.toMatchObject({
			code: "transaction-failed",
			transactionCompleted: "unknown",
		});
		expect((await store.load(postSource()))!.current).toStrictEqual(postSource(1));
	});

	it("full readback mismatch and corruption cannot masquerade as confirmation", async () => {
		const { storage, store } = fixture();
		const prior = await store.create(postSource());
		storage.readReplacement = { ...prior, recordId: "other-record" };
		await expect(store.updateCurrent(prior, postSource(1))).rejects.toMatchObject({
			code: "readback-mismatch",
			transactionCompleted: true,
		});
		storage.readReplacement = { corrupt: true };
		const committed = clone(storage.rows.get(boardDraftKey(postSource()))) as BoardDraftRecord;
		await expect(store.updateCurrent(committed, postSource(2))).rejects.toMatchObject({
			code: "readback-failed",
			transactionCompleted: true,
		});
	});

	it("explicit unavailable/missing/empty/corrupt discovery never pretends success", async () => {
		await expect(createBoardDraftStore(createBoardDraftIndexedDB(undefined)).inspect()).rejects.toMatchObject({
			code: "unavailable",
		});
		expect((await inspectBoardDrafts({ scan: async () => ({ status: "missing", rows: [] }) })).status).toBe("missing");
		const { storage, store } = fixture();
		expect(await store.load(postSource())).toBeUndefined();
		expect((await store.inspect()).status).toBe("empty");
		storage.rows.set(boardDraftKey(postSource()), { corrupt: true });
		await expect(store.load(postSource())).rejects.toMatchObject({ code: "invalid-record" });
		await expect(store.create(postSource())).rejects.toMatchObject({ code: "invalid-record" });
		expect((await store.inspect()).status).toBe("corrupt");
	});

	it("corrupt, foreign and wrong-key rows remain untouched and visible beside valid records", async () => {
		const { storage, store } = fixture();
		const valid = await store.create(postSource());
		storage.rows.set("foreign-key", valid);
		storage.rows.set("future", { purpose: "foreign-purpose", schemaVersion: 900, raw: "<img src=x onerror=alert(1)>" });
		const before = clone([...storage.rows]);
		const result = await store.inspect();
		expect(result.status).toBe("corrupt");
		expect(result.records).toStrictEqual([valid]);
		expect(result.unknown).toHaveLength(2);
		expect([...storage.rows]).toStrictEqual(before);
	});

	it("validates record envelope, array descriptors and conflicting originals strictly", async () => {
		const { store } = fixture();
		const valid = await store.create(postSource(1));
		const accessor = Object.defineProperty([], "0", { enumerable: true, get: vi.fn() });
		for (const patch of [
			{ purpose: "foreign" },
			{ schemaVersion: 2 },
			{ recordId: "" },
			{ version: -1 },
			{ retired: "yes" },
			{ extra: true },
			{ submitted: [postSource(2)] },
			{ submitted: [postSource(0), postSource(0)] },
			{ submitted: accessor },
			{
				submitted: [
					postSource(1, {
						form: { ...(postSource().form as Extract<BoardDraftForm, { type: "board_post" }>), title: "conflict" },
					}),
				],
			},
			{ submitted: [closeSource(0, { editorId: valid.current.editorId })] },
		])
			expect(() => copyBoardDraftRecord({ ...valid, ...patch })).toThrow(BoardDraftError);
	});
});

describe("independent look-only reading and #593 compatibility", () => {
	it("renders hostile unknown records as text and exports tagged raw values without writes", async () => {
		const { storage, store } = fixture();
		const valid = await store.create(postSource());
		storage.rows.set("raw", { raw: "<img src=x onerror=alert(1)>", missing: undefined, negativeZero: -0 });
		const before = clone([...storage.rows]);
		const root = document.createElement("main");
		document.body.append(root);
		await mountBoardDraftReader(root, { scan: () => storage.scan() }).inspect();
		expect(root.querySelector("[data-board-reader-status]")?.getAttribute("data-board-reader-status")).toBe("corrupt");
		expect(root.textContent).toContain("RAW UNKNOWN");
		expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
		expect(root.querySelector("img")).toBeNull();
		expect(root.textContent).toContain(encodeBoardDraftSource(valid.current));
		expect([...storage.rows]).toStrictEqual(before);
		expect(storage.requests).toBe(1);
	});

	it("raw export preserves cycles, special numbers, dates, maps, sets, binary values and refuses accessors", async () => {
		const raw: Record<string, unknown> = {
			nan: NaN,
			inf: Infinity,
			negativeZero: -0,
			bytes: new Uint8Array([0, 128, 255]),
			buf: new Uint8Array([1, 2]).buffer,
			date: new Date(1700000000000),
			re: /board-\d+/gi,
			map: new Map([["k", "v"]]),
			set: new Set(["s1"]),
			big: 42n,
		};
		raw.self = raw;
		const text = await exportRawBoardDraftRow({ key: "unknown", value: raw });
		const reconstructed = reconstructRawBoardGraph(text).value as Record<string, unknown>;
		expect(Object.is(reconstructed.nan, NaN)).toBe(true);
		expect(Object.is(reconstructed.inf, Infinity)).toBe(true);
		expect(Object.is(reconstructed.negativeZero, -0)).toBe(true);
		expect(reconstructed.bytes).toBeInstanceOf(Uint8Array);
		expect([...(reconstructed.bytes as Uint8Array)]).toStrictEqual([0, 128, 255]);
		expect(isArrayBufferValue(reconstructed.buf)).toBe(true);
		expect([...new Uint8Array(reconstructed.buf as ArrayBuffer)]).toStrictEqual([1, 2]);
		expect((reconstructed.date as Date).getTime()).toBe(1700000000000);
		expect((reconstructed.re as RegExp).source).toBe("board-\\d+");
		expect((reconstructed.re as RegExp).flags).toBe("gi");
		expect((reconstructed.map as Map<string, string>).get("k")).toBe("v");
		expect((reconstructed.set as Set<string>).has("s1")).toBe(true);
		expect(reconstructed.big).toBe(42n);
		expect(reconstructed.self).toBe(reconstructed);
		const withGetter = Object.defineProperty({}, "bad", {
			enumerable: true,
			get() {
				return 1;
			},
		});
		await expect(exportRawBoardDraftRow({ key: "bad", value: withGetter })).rejects.toThrow(/accessor/);
	});

	it("distinguishes equal-visible views over different backing buffers and preserves exact view node schema", async () => {
		const rowA = clone({
			key: "equal-visible",
			value: { view: new Uint8Array(new Uint8Array([1, 7, 8, 4]).buffer, 1, 2) },
		});
		const rowB = clone({
			key: "equal-visible",
			value: { view: new Uint8Array(new Uint8Array([9, 7, 8, 6, 5]).buffer, 1, 2) },
		});
		expect([...rowA.value.view]).toStrictEqual([7, 8]);
		expect([...rowB.value.view]).toStrictEqual([7, 8]);

		const exportA = await exportRawBoardDraftRow(rowA);
		const exportB = await exportRawBoardDraftRow(rowB);
		verifyEqualVisiblePairOracle(exportA, exportB);

		const parsedA = JSON.parse(exportA);
		const parsedB = JSON.parse(exportB);
		const viewNodeA = parsedA.row.entries.find(([k]: [string]) => k === "value")[1].entries[0][1];
		const viewNodeB = parsedB.row.entries.find(([k]: [string]) => k === "value")[1].entries[0][1];
		expect(viewNodeA).toStrictEqual({
			id: 2,
			type: "[object Uint8Array]",
			buffer: {
				id: 3,
				type: "ArrayBuffer",
				bytes: [1, 7, 8, 4],
			},
			byteOffset: 1,
			byteLength: 2,
		});
		expect(viewNodeB).toStrictEqual({
			id: 2,
			type: "[object Uint8Array]",
			buffer: {
				id: 3,
				type: "ArrayBuffer",
				bytes: [9, 7, 8, 6, 5],
			},
			byteOffset: 1,
			byteLength: 2,
		});
	});

	it("preserves sliced Uint8Array prefix/suffix, nonzero-offset DataView, shared backing ArrayBuffer across views/direct refs, view aliases and both traversal orders without mutating source rows", async () => {
		const shared = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]).buffer;
		const slicedUint8 = new Uint8Array(shared, 2, 3);
		const dataView = new DataView(shared, 1, 5);
		const sharedUint16 = new Uint16Array(shared, 2, 2);
		const viewFirstRaw: Record<string, unknown> = {
			slicedUint8,
			dataView,
			sharedUint16,
			backing: shared,
			slicedAlias: slicedUint8,
		};
		viewFirstRaw.self = viewFirstRaw;
		const backingFirstRaw: Record<string, unknown> = {
			backing: shared,
			slicedUint8,
			dataView,
			sharedUint16,
			slicedAlias: slicedUint8,
		};
		backingFirstRaw.self = backingFirstRaw;

		const clonedViewFirst = clone({ key: "shared-view-first", value: viewFirstRaw });
		const clonedBackingFirst = clone({ key: "shared-backing-first", value: backingFirstRaw });

		const exportViewFirst = await exportRawBoardDraftRow(clonedViewFirst);
		const exportBackingFirst = await exportRawBoardDraftRow(clonedBackingFirst);

		// Source values are untouched
		expect([...new Uint8Array(shared)]).toStrictEqual([10, 20, 30, 40, 50, 60, 70, 80]);
		expect(slicedUint8.byteOffset).toBe(2);
		expect(slicedUint8.byteLength).toBe(3);
		expect(dataView.byteOffset).toBe(1);
		expect(dataView.byteLength).toBe(5);

		// Both traversal orders reconstruct with identical shared-buffer and view-alias topology
		verifySharedBinaryGraphOracle(exportViewFirst);
		verifySharedBinaryGraphOracle(exportBackingFirst);

		// Verify explicit raw node shapes for view-first and backing-first orders
		const viewFirstEntries = new Map<string, unknown>(
			JSON.parse(exportViewFirst).row.entries.find(([k]: [string]) => k === "value")[1].entries,
		);
		expect(viewFirstEntries.get("slicedUint8")).toStrictEqual({
			id: 2,
			type: "[object Uint8Array]",
			buffer: {
				id: 3,
				type: "ArrayBuffer",
				bytes: [10, 20, 30, 40, 50, 60, 70, 80],
			},
			byteOffset: 2,
			byteLength: 3,
		});
		expect(viewFirstEntries.get("dataView")).toStrictEqual({
			id: 4,
			type: "[object DataView]",
			buffer: { reference: 3 },
			byteOffset: 1,
			byteLength: 5,
		});
		expect(viewFirstEntries.get("sharedUint16")).toStrictEqual({
			id: 5,
			type: "[object Uint16Array]",
			buffer: { reference: 3 },
			byteOffset: 2,
			byteLength: 4,
		});
		expect(viewFirstEntries.get("backing")).toStrictEqual({ reference: 3 });
		expect(viewFirstEntries.get("slicedAlias")).toStrictEqual({ reference: 2 });

		const backingFirstEntries = new Map<string, unknown>(
			JSON.parse(exportBackingFirst).row.entries.find(([k]: [string]) => k === "value")[1].entries,
		);
		expect(backingFirstEntries.get("backing")).toStrictEqual({
			id: 2,
			type: "ArrayBuffer",
			bytes: [10, 20, 30, 40, 50, 60, 70, 80],
		});
		expect(backingFirstEntries.get("slicedUint8")).toStrictEqual({
			id: 3,
			type: "[object Uint8Array]",
			buffer: { reference: 2 },
			byteOffset: 2,
			byteLength: 3,
		});
		expect(backingFirstEntries.get("dataView")).toStrictEqual({
			id: 4,
			type: "[object DataView]",
			buffer: { reference: 2 },
			byteOffset: 1,
			byteLength: 5,
		});
		expect(backingFirstEntries.get("sharedUint16")).toStrictEqual({
			id: 5,
			type: "[object Uint16Array]",
			buffer: { reference: 2 },
			byteOffset: 2,
			byteLength: 4,
		});
		expect(backingFirstEntries.get("slicedAlias")).toStrictEqual({ reference: 3 });
	});

	it("negative control: genuine unmodified a875d2bc exporter loads and exports valid JSON but fails equal-visible and shared-buffer preservation oracles", async () => {
		const oldExportRawBoardDraftRow = await loadPinnedOldRawExporter();
		const rowA = clone({
			key: "equal-visible",
			value: { view: new Uint8Array(new Uint8Array([1, 7, 8, 4]).buffer, 1, 2) },
		});
		const rowB = clone({
			key: "equal-visible",
			value: { view: new Uint8Array(new Uint8Array([9, 7, 8, 6, 5]).buffer, 1, 2) },
		});

		const oldExportA = await oldExportRawBoardDraftRow(rowA);
		const oldExportB = await oldExportRawBoardDraftRow(rowB);
		// Old exporter succeeded at loading and exporting valid raw-graph JSON
		expect(JSON.parse(oldExportA).format).toBe("board-purpose-store-raw-graph-v1");
		expect(JSON.parse(oldExportB).format).toBe("board-purpose-store-raw-graph-v1");
		// Yet it collapsed both different backing buffers into the exact same export string
		expect(oldExportA).toBe(oldExportB);
		expect(() => verifyEqualVisiblePairOracle(oldExportA, oldExportB)).toThrow(/collapsed into identical exports/);

		const shared = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]).buffer;
		const slicedUint8 = new Uint8Array(shared, 2, 3);
		const sharedRaw: Record<string, unknown> = {
			slicedUint8,
			dataView: new DataView(shared, 1, 5),
			sharedUint16: new Uint16Array(shared, 2, 2),
			backing: shared,
			slicedAlias: slicedUint8,
		};
		sharedRaw.self = sharedRaw;
		const oldSharedExport = await oldExportRawBoardDraftRow(clone({ key: "shared", value: sharedRaw }));
		expect(JSON.parse(oldSharedExport).format).toBe("board-purpose-store-raw-graph-v1");
		expect(() => verifySharedBinaryGraphOracle(oldSharedExport)).toThrow(
			/missing backing buffer or byteOffset\/byteLength metadata/,
		);
	});

	it("reader shows unavailable, missing, empty and ready distinctly", async () => {
		const root = document.createElement("main");
		await mountBoardDraftReader(root, {
			scan: async () => {
				throw new Error("synthetic access denied");
			},
		}).inspect();
		expect(root.querySelector("[data-board-reader-status]")?.getAttribute("data-board-reader-status")).toBe(
			"unavailable",
		);
		expect(root.textContent).toContain("NOT an empty or successful recovery");

		await mountBoardDraftReader(root, {
			scan: async () => ({ status: "missing", rows: [] }),
		}).inspect();
		expect(root.querySelector("[data-board-reader-status]")?.getAttribute("data-board-reader-status")).toBe("missing");

		await mountBoardDraftReader(root, {
			scan: async () => ({ status: "present", rows: [] }),
		}).inspect();
		expect(root.querySelector("[data-board-reader-status]")?.getAttribute("data-board-reader-status")).toBe("empty");
	});

	it("recovered exact post and close sources pass #593 LOOK-ONLY restore, never send/admit, and current B wins", async () => {
		vi.resetModules();
		const rolesState = await import("../../web/src/roles-state.js");
		const { setAppSend } = await import("../../web/src/app-globals.js");
		const { setAppAdmit } = await import("../../web/src/app-admit.js");
		rolesState.resetBoardDrafts();
		const send = vi.fn(() => false);
		const admit = vi.fn(async () => false);
		setAppSend(send);
		setAppAdmit(admit);

		const { store } = fixture();
		// Seed live current B in #593 page state, plus persisted submitted A + current B
		const liveInitial = rolesState.createBoardDraft({
			type: "board_post",
			kind: "order",
			toAll: true,
			picked: ["temper", "ops"],
			title: "  Initial A  ",
			text: "  Body A  ",
		});
		const liveCurrentB = rolesState.reviseBoardDraft(liveInitial, {
			type: "board_post",
			kind: "news",
			toAll: false,
			picked: ["ops"],
			title: "  Current B  ",
			text: "",
		});
		const record = await store.create(liveCurrentB, liveInitial);
		const fresh = copyBoardDraftRecord(JSON.parse(encodeBoardDraftRecord(record)));
		expect(rolesState.restoreBoardDraft(fresh.current)).toBe(true);
		expect(rolesState.restoreBoardDraft(fresh.submitted[0])).toBe(true);

		const closeInitial = closeSource(0);
		const closeCurrentB = closeSource(1, { form: { type: "board_close", id: "bp-fixture-A", note: "" } });
		const closeRecord = await store.create(closeCurrentB, [closeInitial]);
		const freshClose = copyBoardDraftRecord(JSON.parse(encodeBoardDraftRecord(closeRecord)));
		expect(rolesState.restoreBoardDraft(freshClose.current)).toBe(true);
		expect(rolesState.restoreBoardDraft(freshClose.submitted[0])).toBe(true);

		const recoveries = rolesState.getBoardDraftRecoveries();
		const postRecovery = recoveries.find((item) => item.current.editorId === liveInitial.editorId)!;
		expect(postRecovery.current).toStrictEqual(liveCurrentB);
		expect(postRecovery.restoredSources).toStrictEqual([liveCurrentB, liveInitial]);
		const closeRecovery = recoveries.find((item) => item.current.editorId === closeInitial.editorId)!;
		expect(closeRecovery.restoredSources).toStrictEqual([closeCurrentB, closeInitial]);
		expect(send).not.toHaveBeenCalled();
		expect(admit).not.toHaveBeenCalled();
		rolesState.resetBoardDrafts();
	});
});
