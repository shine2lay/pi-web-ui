// @vitest-environment jsdom
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
		expect(text).toContain('"board-purpose-store-raw-graph-v1"');
		expect(text).toContain('"reference"');
		expect(text).toContain('"NaN"');
		expect(text).toContain('"Infinity"');
		expect(text).toContain('"-0"');
		expect(text).toContain('"bigint"');
		expect(text).toContain('"Date"');
		expect(text).toContain('"RegExp"');
		expect(text).toContain('"Map"');
		expect(text).toContain('"Set"');
		expect(text).toContain("255");
		const withGetter = Object.defineProperty({}, "bad", {
			enumerable: true,
			get() {
				return 1;
			},
		});
		await expect(exportRawBoardDraftRow({ key: "bad", value: withGetter })).rejects.toThrow(/accessor/);
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
