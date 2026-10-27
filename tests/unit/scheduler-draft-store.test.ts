// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	copySchedulerDraftRecord,
	copySchedulerDraftSource,
	createSchedulerDraftIndexedDB,
	createSchedulerDraftStore,
	encodeSchedulerDraftRecord,
	encodeSchedulerDraftSource,
	inspectSchedulerDrafts,
	schedulerDraftKey,
	SchedulerDraftError,
	type SchedulerDraftRecord,
	type SchedulerDraftStorage,
} from "../../web/src/scheduler-draft-store.js";
import { exportRawSchedulerDraftRow, mountSchedulerDraftReader } from "../../web/src/scheduler-draft-reader.js";
import type { SchedulerAdmissionSource, SchedulerTaskDraft } from "../../web/src/components/SchedulerPanel.js";

function source(revision = 0, patch: Partial<SchedulerAdmissionSource> = {}): SchedulerAdmissionSource {
	return {
		workspace: "/synthetic/owning workspace é 🌈",
		taskId: null,
		formId: "form-A",
		revision,
		form: {
			id: "",
			name: "  é 🌈\t ",
			description: "\nraw description  ",
			cwd: " /synthetic/NOT-owning-workspace/ ",
			kind: "interval",
			cron: "  7 8 * * 2 \t",
			preset: "custom",
			intervalMinutes: " 00.25e+2 ",
			prompt: "first\nsecond é 🌈\t  ",
			model: "fixture/model",
			thinkingLevel: "raw-thinking",
			catchUp: false,
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
class MemoryStorage implements SchedulerDraftStorage {
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
		if (this.rows.has(key) && value === undefined) throw new SchedulerDraftError("invalid-record");
		return clone(value);
	}
	async scan() {
		if (this.readFailure) throw new Error("synthetic inspection failure");
		return { status: "present" as const, rows: [...this.rows].map(([key, value]) => ({ key, value: clone(value) })) };
	}
	async swap(key: string, expected: string | null, replacement: SchedulerDraftRecord) {
		await this.beforeSwap?.();
		const previous = this.tail;
		const gate = deferred();
		this.tail = previous.then(() => gate.promise);
		await previous;
		try {
			const prior = this.rows.get(key);
			if ((this.rows.has(key) ? encodeSchedulerDraftRecord(prior) : null) !== expected)
				throw new SchedulerDraftError("conflict");
			this.requests++;
			await this.afterRequest?.();
			if (this.abort) throw new SchedulerDraftError("transaction-failed");
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
	return { storage, store: createSchedulerDraftStore(storage, () => `synthetic-nonce-${++nonce}`) };
}
afterEach(() => {
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

describe("strict #590 source contract and immutable bytes", () => {
	it.each([null, "task-a"])("preserves all twelve fields for task %s", (taskId) => {
		const input = source(23, { taskId, form: { ...source().form, id: taskId ?? "" } });
		const result = copySchedulerDraftSource(input);
		expect(result).toStrictEqual(input);
		expect(result).not.toBe(input);
		expect(result.form).not.toBe(input.form);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.form)).toBe(true);
		expect(JSON.parse(encodeSchedulerDraftSource(result))).toStrictEqual(input);
	});
	it("preserves empty clears, inactive values, null prototypes and negative zero", () => {
		const form = { ...source().form, kind: "cron" as const, catchUp: true };
		for (const key of Object.keys(form).filter((key) => !["kind", "preset", "catchUp"].includes(key)))
			(form as unknown as Record<string, unknown>)[key] = "";
		const input = Object.assign(Object.create(null), source(-0, { form: Object.assign(Object.create(null), form) }));
		const result = copySchedulerDraftSource(input);
		expect(result.form).toStrictEqual(form);
		expect(JSON.parse(encodeSchedulerDraftSource(result))).toStrictEqual(result);
	});
	it.each(["custom", "0 9 * * *", "0 * * * *", "*/30 * * * *", "0 9 * * 1-5", "0 9 * * 1"])(
		"accepts #590 preset %s without changing inactive cron",
		(preset) =>
			expect(copySchedulerDraftSource(source(0, { form: { ...source().form, preset } })).form.preset).toBe(preset),
	);
	for (const key of ["workspace", "taskId", "formId", "revision", "form"]) {
		it(`rejects missing source ${key}`, () => {
			const value = { ...source() } as Record<string, unknown>;
			delete value[key];
			expect(() => copySchedulerDraftSource(value)).toThrow(SchedulerDraftError);
		});
		it(`rejects source accessor ${key} without invoking it`, () => {
			const getter = vi.fn(() => {
				throw new Error("must not run");
			});
			const value = Object.defineProperty({ ...source() }, key, { enumerable: true, get: getter });
			expect(() => copySchedulerDraftSource(value)).toThrow(SchedulerDraftError);
			expect(getter).not.toHaveBeenCalled();
		});
	}
	for (const key of Object.keys(source().form)) {
		it(`rejects missing/invalid/accessor form ${key}`, () => {
			const form = { ...source().form } as Record<string, unknown>;
			delete form[key];
			expect(() => copySchedulerDraftSource(source(0, { form: form as unknown as SchedulerTaskDraft }))).toThrow();
			form[key] = key === "kind" ? "unknown-kind" : key === "catchUp" ? "false" : 7;
			expect(() => copySchedulerDraftSource(source(0, { form: form as unknown as SchedulerTaskDraft }))).toThrow();
			const getter = vi.fn();
			Object.defineProperty(form, key, { enumerable: true, get: getter });
			expect(() => copySchedulerDraftSource(source(0, { form: form as unknown as SchedulerTaskDraft }))).toThrow();
			expect(getter).not.toHaveBeenCalled();
		});
	}
	it.each([
		{ workspace: "" },
		{ workspace: null },
		{ taskId: "" },
		{ taskId: "wrong" },
		{ formId: "" },
		{ revision: -1 },
		{ revision: 1.5 },
		{ revision: NaN },
		{ revision: Infinity },
		{ revision: Number.MAX_SAFE_INTEGER + 1 },
		{ unknown: "foreign" },
		{ form: { ...source().form, extra: true } },
		{ form: { ...source().form, preset: "unrecognized" } },
		{ form: { ...source().form, id: "mismatched" } },
	])("rejects invalid/extra source %#", (patch) =>
		expect(() => copySchedulerDraftSource({ ...source(), ...patch })).toThrow(),
	);
	it("rejects symbols, hidden fields and nonplain sources/forms", () => {
		for (const value of [
			{ ...source(), [Symbol("foreign")]: 1 },
			Object.defineProperty({ ...source() }, "hidden", { value: true }),
			Object.assign(Object.create({ inherited: true }), source()),
			source(0, { form: Object.assign(Object.create({ inherited: true }), source().form) }),
		])
			expect(() => copySchedulerDraftSource(value)).toThrow();
	});
});

describe("exact lifetime/revision/record CAS", () => {
	it("keeps immutable submitted A beside current B and appends original once under fresh CAS", async () => {
		const { store } = fixture();
		const a = source(1);
		const created = await store.create(a);
		const b = source(2, { form: { ...a.form, name: "", prompt: "B", catchUp: true } });
		const current = await store.updateCurrent(created, b);
		await expect(store.retainSubmitted(created, a)).rejects.toMatchObject({ code: "conflict" });
		const retained = await store.retainSubmitted((await store.load(a))!, a);
		expect(retained.current).toStrictEqual(b);
		expect(retained.submitted).toStrictEqual([a]);
		expect(retained.version).toBe(current.version + 1);
		expect(await store.retainSubmitted(retained, a)).toStrictEqual(retained);
		await expect(
			store.retainSubmitted(retained, source(1, { form: { ...a.form, prompt: "altered A" } })),
		).rejects.toMatchObject({ code: "conflict" });
	});
	it("has genuine A/B/ABA revision fences and no timestamp authority", async () => {
		const { store } = fixture();
		const a = source(1);
		const first = await store.create(a);
		const b = await store.updateCurrent(first, source(2, { form: { ...a.form, prompt: "B" } }));
		const aba = await store.updateCurrent(b, source(3));
		expect(aba.current.form).toStrictEqual(a.form);
		await expect(store.updateCurrent(first, source(99))).rejects.toMatchObject({ code: "conflict" });
		await expect(store.retire(first)).rejects.toMatchObject({ code: "conflict" });
		expect(await store.load(a)).toStrictEqual(aba);
	});
	it("fences concurrent/out-of-order writers without rollback", async () => {
		const { storage, store } = fixture();
		const record = await store.create(source());
		const gate = deferred();
		storage.beforeSwap = () => gate.promise;
		const late = store.updateCurrent(record, source(1, { form: { ...source().form, prompt: "late A" } }));
		storage.beforeSwap = undefined;
		const b = await store.updateCurrent(record, source(2, { form: { ...source().form, prompt: "newer B" } }));
		const refused = expect(late).rejects.toMatchObject({ code: "conflict" });
		gate.resolve();
		await refused;
		expect(await store.load(source())).toStrictEqual(b);
	});
	it("only one same-revision concurrent CAS can commit", async () => {
		const { store } = fixture();
		const record = await store.create(source());
		const results = await Promise.allSettled([
			store.updateCurrent(record, source(1, { form: { ...source().form, prompt: "one" } })),
			store.updateCurrent(record, source(1, { form: { ...source().form, prompt: "two" } })),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
	});
	it.each([
		{ workspace: "/synthetic/foreign" },
		{ formId: "another form" },
		{ taskId: "other-task", form: { ...source().form, id: "other-task" } },
	])("larger claimed revision never crosses lifetime %#", async (patch) => {
		const { store } = fixture();
		const record = await store.create(source());
		await expect(store.updateCurrent(record, source(9999, patch))).rejects.toMatchObject({ code: "conflict" });
		await expect(store.retainSubmitted(record, source(0, patch))).rejects.toMatchObject({ code: "conflict" });
		expect(await store.load(source())).toStrictEqual(record);
		const other = await store.create(source(9999, patch));
		expect(await store.load(other.current)).toStrictEqual(other);
		expect(await store.load(source())).toStrictEqual(record);
	});
	it("rejects lower revisions and same-revision different bytes, including immutable originals", async () => {
		const { store } = fixture();
		const record = await store.create(source(5));
		await expect(store.updateCurrent(record, source(4))).rejects.toMatchObject({ code: "conflict" });
		await expect(
			store.updateCurrent(record, source(5, { form: { ...source().form, name: "different" } })),
		).rejects.toMatchObject({ code: "conflict" });
		await expect(
			store.retainSubmitted(record, source(5, { form: { ...source().form, name: "different" } })),
		).rejects.toMatchObject({ code: "conflict" });
		expect(await store.updateCurrent(record, source(5))).toStrictEqual(record);
	});
	it("exact retirement retains every byte, fences subsequent edits and is not a delete", async () => {
		const { storage, store } = fixture();
		let record = await store.create(source());
		record = await store.retainSubmitted(record, record.current);
		const newer = await store.updateCurrent(record, source(1, { form: { ...source().form, prompt: "B" } }));
		await expect(store.retire(record)).rejects.toMatchObject({ code: "conflict" });
		const retired = await store.retire(newer);
		expect(retired).toStrictEqual({ ...newer, version: newer.version + 1, retired: true });
		expect(storage.rows.size).toBe(1);
		expect(await store.retire(retired)).toStrictEqual(retired);
		await expect(store.updateCurrent(retired, source(100))).rejects.toMatchObject({ code: "retired" });
		await expect(store.create(source(100))).rejects.toMatchObject({ code: "conflict" });
		expect((await store.inspect()).records).toStrictEqual([retired]);
	});
	it("record nonce/full bytes fence same-key external replacement ABA", async () => {
		const { storage, store } = fixture();
		const a = await store.create(source());
		const replacement = { ...clone(a), recordId: "genuine-other-incarnation" };
		storage.rows.set(schedulerDraftKey(a.current), replacement);
		await expect(store.updateCurrent(a, source(999))).rejects.toMatchObject({ code: "conflict" });
		await expect(store.retire(a)).rejects.toMatchObject({ code: "conflict" });
		expect(await store.load(a.current)).toStrictEqual(replacement);
	});
});

describe("key presence is distinct from a stored undefined or other corrupt value", () => {
	it("only a genuinely absent key returns absence and allows creation, then normal exact CAS", async () => {
		const { storage, store } = fixture();
		const a = source();
		const key = schedulerDraftKey(a);
		expect(storage.rows.has(key)).toBe(false);
		expect(await storage.read(key)).toBeUndefined();
		expect(await store.load(a)).toBeUndefined();
		const first = await store.create(a);
		expect(storage.rows.has(key)).toBe(true);
		expect(await storage.read(key)).toStrictEqual(first);
		await expect(store.create(a)).rejects.toMatchObject({ code: "conflict", transactionCompleted: false });
		const b = source(1, { form: { ...a.form, prompt: "valid presence CAS" } });
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
		const a = source();
		const prior = await store.create(a);
		const key = schedulerDraftKey(a);
		storage.rows.set(key, value);
		const before = clone([...storage.rows]);
		const rawBefore = await exportRawSchedulerDraftRow({ key, value });
		for (const operation of [
			() => store.load(a),
			() => store.create(a),
			() => store.updateCurrent(prior, source(1)),
			() => store.retainSubmitted(prior, a),
			() => store.retire(prior),
		]) {
			await expect(operation()).rejects.toMatchObject({ code: "invalid-record", transactionCompleted: false });
			expect(storage.rows.has(key)).toBe(true);
			expect([...storage.rows]).toStrictEqual(before);
		}
		const inspected = await store.inspect();
		expect(inspected).toStrictEqual({ status: "corrupt", records: [], unknown: [{ key, value }] });
		expect(await exportRawSchedulerDraftRow(inspected.unknown[0])).toBe(rawBefore);
		const exported = JSON.parse(rawBefore);
		expect(exported.format).toBe("scheduler-purpose-store-raw-graph-v1");
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
		const prior = await store.create(source());
		const gate = deferred();
		const arrived = deferred();
		storage.afterRequest = () => {
			arrived.resolve();
			return gate.promise;
		};
		storage.abort = true;
		let settled = false;
		const pending = store.updateCurrent(prior, source(1));
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
		expect(await store.load(source())).toStrictEqual(prior);
	});
	it("committed-then-readback-failed stays recoverable and is NOT confirmed", async () => {
		const { storage, store } = fixture();
		const prior = await store.create(source());
		storage.readFailure = true;
		await expect(store.updateCurrent(prior, source(1))).rejects.toMatchObject({
			code: "readback-failed",
			transactionCompleted: true,
		});
		storage.readFailure = false;
		expect((await store.load(source()))!.current).toStrictEqual(source(1));
	});
	it("committed-then-boundary-failed is uncertain, not rolled back", async () => {
		const { storage, store } = fixture();
		const prior = await store.create(source());
		storage.postCommitFailure = true;
		await expect(store.updateCurrent(prior, source(1))).rejects.toMatchObject({
			code: "transaction-failed",
			transactionCompleted: "unknown",
		});
		expect((await store.load(source()))!.current).toStrictEqual(source(1));
	});
	it("full readback mismatch and corruption cannot masquerade as confirmation", async () => {
		const { storage, store } = fixture();
		const prior = await store.create(source());
		storage.readReplacement = { ...prior, recordId: "other-record" };
		await expect(store.updateCurrent(prior, source(1))).rejects.toMatchObject({
			code: "readback-mismatch",
			transactionCompleted: true,
		});
		storage.readReplacement = { corrupt: true };
		const committed = clone(storage.rows.get(schedulerDraftKey(source()))) as SchedulerDraftRecord;
		await expect(store.updateCurrent(committed, source(2))).rejects.toMatchObject({
			code: "readback-failed",
			transactionCompleted: true,
		});
	});
	it("explicit unavailable/missing/empty/corrupt discovery never pretends success", async () => {
		await expect(createSchedulerDraftStore(createSchedulerDraftIndexedDB(undefined)).inspect()).rejects.toMatchObject({
			code: "unavailable",
		});
		expect((await inspectSchedulerDrafts({ scan: async () => ({ status: "missing", rows: [] }) })).status).toBe(
			"missing",
		);
		const { storage, store } = fixture();
		expect(await store.load(source())).toBeUndefined();
		expect((await store.inspect()).status).toBe("empty");
		storage.rows.set(schedulerDraftKey(source()), { corrupt: true });
		await expect(store.load(source())).rejects.toMatchObject({ code: "invalid-record" });
		await expect(store.create(source())).rejects.toMatchObject({ code: "invalid-record" });
		expect((await store.inspect()).status).toBe("corrupt");
	});
	it("corrupt, foreign and conflicting rows remain untouched and visible beside valid records", async () => {
		const { storage, store } = fixture();
		const valid = await store.create(source());
		const wrongOwnerKey = "foreign-key";
		storage.rows.set(wrongOwnerKey, valid);
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
		const valid = await store.create(source(1));
		const accessor = Object.defineProperty([], "0", { enumerable: true, get: vi.fn() });
		for (const patch of [
			{ purpose: "foreign" },
			{ schemaVersion: 2 },
			{ recordId: "" },
			{ version: -1 },
			{ retired: "yes" },
			{ extra: true },
			{ submitted: [source(2)] },
			{ submitted: [source(0), source(0)] },
			{ submitted: accessor },
			{ submitted: [source(1, { form: { ...source().form, name: "conflict" } })] },
		])
			expect(() => copySchedulerDraftRecord({ ...valid, ...patch })).toThrow(SchedulerDraftError);
	});
});

describe("independent look-only reading and #590 compatibility", () => {
	it("renders hostile unknown records as text and exports tagged raw values without writes", async () => {
		const { storage, store } = fixture();
		const valid = await store.create(source());
		storage.rows.set("raw", { raw: "<img src=x onerror=alert(1)>", missing: undefined, negativeZero: -0 });
		const before = clone([...storage.rows]);
		const root = document.createElement("main");
		document.body.append(root);
		await mountSchedulerDraftReader(root, { scan: () => storage.scan() }).inspect();
		expect(root.querySelector("[data-scheduler-reader-status]")?.getAttribute("data-scheduler-reader-status")).toBe(
			"corrupt",
		);
		expect(root.textContent).toContain("RAW UNKNOWN");
		expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
		expect(root.querySelector("img")).toBeNull();
		expect(root.textContent).toContain(encodeSchedulerDraftSource(valid.current));
		expect([...storage.rows]).toStrictEqual(before);
		expect(storage.requests).toBe(1);
	});
	it("raw export preserves cycles, special numbers, sliced binary views, shared backing ArrayBuffers and view offsets visibly", async () => {
		const shared = new Uint8Array([10, 20, 30, 40, 50, 60]).buffer;
		const viewA = new Uint8Array(shared, 1, 2);
		const viewB = new DataView(shared, 2, 3);
		const raw: Record<string, unknown> = {
			nan: NaN,
			negativeZero: -0,
			bytes: new Uint8Array([0, 128, 255]),
			viewA,
			viewB,
			backing: shared,
			big: 42n,
		};
		raw.self = raw;
		const text = await exportRawSchedulerDraftRow({ key: "unknown", value: raw });
		expect(text).toContain('"reference"');
		expect(text).toContain('"NaN"');
		expect(text).toContain('"-0"');
		expect(text).toContain('"bigint"');
		expect(text).toContain("255");
		expect(text).toContain('"byteOffset": 1');
		expect(text).toContain('"byteLength": 2');
		expect(text).toContain('"byteOffset": 2');
		expect(text).toContain('"byteLength": 3');

		const equalVisA = await exportRawSchedulerDraftRow({
			key: "slice",
			value: { v: new Uint8Array(new Uint8Array([1, 7, 8, 4]).buffer, 1, 2) },
		});
		const equalVisB = await exportRawSchedulerDraftRow({
			key: "slice",
			value: { v: new Uint8Array(new Uint8Array([9, 7, 8, 6, 5]).buffer, 1, 2) },
		});
		expect(equalVisA).not.toBe(equalVisB);
	});
	it("reader shows unavailable distinctly from missing and empty", async () => {
		const root = document.createElement("main");
		await mountSchedulerDraftReader(root, {
			scan: async () => {
				throw new Error("synthetic access denied");
			},
		}).inspect();
		expect(root.textContent).toContain("NOT an empty or successful recovery");
	});
	it("recovered exact sources pass #590 LOOK-ONLY restore, never send/admit, and current B wins", async () => {
		vi.resetModules();
		const panel = await import("../../web/src/components/SchedulerPanel.js");
		const { setAppSend } = await import("../../web/src/app-globals.js");
		const { setAppAdmit } = await import("../../web/src/app-admit.js");
		const send = vi.fn(() => false);
		const admit = vi.fn(async () => false);
		setAppSend(send);
		setAppAdmit(admit);
		const { store } = fixture();
		const a = source(1);
		let record = await store.create(a);
		record = await store.retainSubmitted(record, a);
		const b = source(2, { form: { ...a.form, prompt: "B", description: "" } });
		record = await store.updateCurrent(record, b);
		const fresh = copySchedulerDraftRecord(JSON.parse(encodeSchedulerDraftRecord(record)));
		expect(panel.restoreSchedulerDraft(fresh.current)).toBe(true);
		expect(panel.restoreSchedulerDraft(fresh.submitted[0])).toBe(true);
		expect(panel.getSchedulerDraftRecoveries()[0].current).toStrictEqual(b.form);
		expect(panel.getSchedulerDraftRecoveries()[0].restoredSources).toStrictEqual([b, a]);
		expect(send).not.toHaveBeenCalled();
		expect(admit).not.toHaveBeenCalled();
	});
});
