import { describe, expect, it, vi } from "vitest";
import { createSchedulerSourceCheckpoints } from "../../web/src/recovery-scheduler";
import {
	SCHEDULER_DRAFT_PURPOSE,
	SchedulerDraftError,
	copySchedulerDraftRecord,
	encodeSchedulerDraftRecord,
	schedulerDraftKey,
	type SchedulerDraftStorage,
} from "../../web/src/scheduler-draft-store";
import type { SchedulerAdmissionSource } from "../../web/src/components/SchedulerPanel";
import type { ClientMessage } from "../../web/src/types";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function source(revision = 0, prompt = "  original source\n", formId = "form-a"): SchedulerAdmissionSource {
	return {
		workspace: "/actual-workspace",
		taskId: null,
		formId,
		revision,
		form: {
			id: "",
			name: " original name ",
			description: " original description ",
			cwd: " /chosen-task-dir ",
			kind: "interval",
			cron: " 0 5 * * * ",
			preset: "custom",
			intervalMinutes: " 90 ",
			prompt,
			model: " fixture/model ",
			thinkingLevel: " high ",
			catchUp: true,
		},
	};
}
function wireFor(value = source()): Extract<ClientMessage, { type: "schedule_save" }> {
	const f = value.form;
	return {
		type: "schedule_save",
		task: {
			...(f.id ? { id: f.id } : {}),
			name: f.name,
			description: f.description,
			cwd: f.cwd,
			kind: f.kind,
			spec: f.kind === "cron" ? f.cron : String(Math.max(1, Math.floor(Number(f.intervalMinutes) || 0)) * 60000),
			prompt: f.prompt,
			model: f.model,
			thinkingLevel: f.thinkingLevel,
			catchUp: f.catchUp ? "once" : "skip",
		},
	};
}
function record(value = source(), retired = false) {
	return copySchedulerDraftRecord({
		purpose: SCHEDULER_DRAFT_PURPOSE,
		schemaVersion: 1,
		recordId: "original-record",
		version: 0,
		retired,
		current: value,
		submitted: [],
	});
}
function fixture() {
	const rows = new Map<string, unknown>();
	const writes: unknown[] = [];
	const problem = vi.fn();
	let hold: ReturnType<typeof deferred> | undefined;
	let started: ReturnType<typeof deferred> | undefined;
	let readFailure: unknown;
	let failReadback = false;
	let rejectSwap = false;
	let beforeSwap: (() => void) | undefined;
	const storage: SchedulerDraftStorage = {
		async read(key) {
			if (hold) {
				const gate = hold;
				hold = undefined;
				started?.resolve();
				await gate.promise;
			}
			if (readFailure) {
				const error = readFailure;
				readFailure = undefined;
				throw error;
			}
			if (rows.has(key) && rows.get(key) === undefined) throw new SchedulerDraftError("invalid-record");
			return rows.get(key);
		},
		async scan() {
			return { status: "present", rows: [...rows].map(([key, value]) => ({ key, value })) };
		},
		async swap(key, expected, replacement) {
			const hook = beforeSwap;
			beforeSwap = undefined;
			hook?.();
			if (rejectSwap) {
				rejectSwap = false;
				throw new SchedulerDraftError("transaction-failed", false);
			}
			const actual = rows.has(key) ? encodeSchedulerDraftRecord(rows.get(key)) : null;
			if (actual !== expected || schedulerDraftKey(replacement.current) !== key)
				throw new SchedulerDraftError("conflict");
			const committed = copySchedulerDraftRecord(replacement);
			rows.set(key, committed);
			writes.push(committed);
			if (failReadback) {
				failReadback = false;
				readFailure = new Error("synthetic readback failure");
			}
		},
	};
	let nextId = 0;
	const api = createSchedulerSourceCheckpoints({ storage, newRecordId: () => `record-${++nextId}`, problem });
	return {
		api,
		rows,
		writes,
		problem,
		storage,
		get(value = source()) {
			return copySchedulerDraftRecord(rows.get(schedulerDraftKey(value)));
		},
		holdRead() {
			hold = deferred();
			started = deferred();
			return { gate: hold, started };
		},
		failCommittedReadback() {
			failReadback = true;
		},
		abortSwap() {
			rejectSwap = true;
		},
		beforeSwap(fn: () => void) {
			beforeSwap = fn;
		},
	};
}

describe("typed Scheduler source checkpoint composition", () => {
	it("does no IO on construction; snapshots are stable until an owned event", () => {
		const f = fixture();
		const first = f.api.getSnapshot();
		expect(f.rows.size).toBe(0);
		expect(f.writes).toEqual([]);
		expect(first).toEqual({ pending: 0, failures: [] });
		expect(f.api.getSnapshot()).toBe(first);
	});
	it("captures all twelve original/inactive fields before any storage await", async () => {
		const f = fixture();
		const original = source();
		const expected = structuredClone(original);
		const { gate, started } = f.holdRead();
		const result = f.api.retainSubmitted(original);
		await started.promise;
		(original.form as { prompt: string }).prompt = "caller mutation";
		(original.form as { cron: string }).cron = "lost inactive cron";
		expect(f.api.getSnapshot().pending).toBe(1);
		expect(f.writes).toEqual([]);
		gate.resolve();
		expect(await result).toBe(true);
		expect(f.get().current).toEqual(expected);
		expect(f.get().submitted).toEqual([expected]);
		expect(f.writes).toHaveLength(1);
		expect(f.api.getSnapshot()).toEqual({ pending: 0, failures: [] });
	});
	it("initial submitted source is in the SAME transaction, even when committed readback fails", async () => {
		const f = fixture();
		const a = source();
		f.failCommittedReadback();
		expect(await f.api.retainSubmitted(a)).toBe(false);
		expect(f.get().submitted).toEqual([a]);
		expect(f.api.getSnapshot().failures[0]).toMatchObject({ source: a, submitted: true });
		const b = source(1, "  newer B\n");
		expect(await f.api.persistCurrent(b)).toBe(true);
		expect(f.get().current).toEqual(b);
		expect(f.get().submitted).toEqual([a]);
		expect(f.api.getSnapshot().failures).toEqual([]);
	});
	it("newer current B is not overwritten by an older submitted A", async () => {
		const f = fixture();
		const a = source();
		const b = source(2, " newer B ");
		expect(await f.api.persistCurrent(b)).toBe(true);
		expect(await f.api.retainSubmitted(a)).toBe(true);
		expect(f.get().current).toEqual(b);
		expect(f.get().submitted).toEqual([a]);
		expect(await f.api.persistCurrent(source(1, "intermediate current"))).toBe(true);
		expect(f.get().current).toEqual(b);
		expect(f.get().submitted).toEqual([a]);
	});
	it("a pre-commit abort still retains submitted A in the next successful current B transaction", async () => {
		const f = fixture();
		const a = source();
		f.abortSwap();
		expect(await f.api.retainSubmitted(a)).toBe(false);
		expect(f.rows.size).toBe(0);
		expect(f.api.getSnapshot().failures[0]?.source).toEqual(a);
		expect(await f.api.persistCurrent(source(1, " B "))).toBe(true);
		expect(f.get().submitted).toEqual([a]);
		expect(f.api.getSnapshot().failures).toEqual([]);
	});
	it("same-identity/revision different bytes refuse and retain BOTH originals, never overwrite", async () => {
		const f = fixture();
		const a = source();
		const b = source(0, "different same revision");
		f.abortSwap();
		expect(await f.api.retainSubmitted(a)).toBe(false);
		expect(await f.api.retainSubmitted(b)).toBe(false);
		expect(f.rows.size).toBe(0);
		expect(f.api.getSnapshot().failures.map((item) => item.source)).toEqual([a, b]);
	});
	it.each([undefined, null, false, { current: "corrupt" }])(
		"a present corrupt row is never treated as absent (%s)",
		async (bad) => {
			const f = fixture();
			const key = schedulerDraftKey(source());
			f.rows.set(key, bad);
			expect(await f.api.retainSubmitted(source())).toBe(false);
			expect(f.rows.has(key)).toBe(true);
			expect(f.rows.get(key)).toBe(bad);
			expect(f.writes).toEqual([]);
		},
	);
	it("CAS conflict preserves the other writer, then a later explicit update can retain the failed original", async () => {
		const f = fixture();
		const a = source();
		const b = source(1, " other writer B ");
		f.beforeSwap(() => {
			f.rows.set(schedulerDraftKey(b), record(b));
		});
		expect(await f.api.retainSubmitted(a)).toBe(false);
		expect(f.get().current).toEqual(b);
		expect(f.writes).toEqual([]);
		expect(await f.api.persistCurrent(source(2, " explicit newer current C "))).toBe(true);
		expect(f.get().recordId).toBe("original-record");
		expect(f.get().submitted).toEqual([a]);
	});
	it("retired sources cannot be revived; a genuine fresh form is independent", async () => {
		const f = fixture();
		const retired = record(source(), true);
		f.rows.set(schedulerDraftKey(source()), retired);
		expect(await f.api.retainSubmitted(source())).toBe(false);
		expect(f.rows.get(schedulerDraftKey(source()))).toBe(retired);
		const fresh = source(0, " new editor ", "fresh-form");
		expect(await f.api.retainSubmitted(fresh)).toBe(true);
		expect(f.get(fresh).submitted).toEqual([fresh]);
		expect(f.rows.size).toBe(2);
	});
	it("same-source writes serialize but unrelated genuine form identities remain parallel", async () => {
		const f = fixture();
		const { gate, started } = f.holdRead();
		const a = f.api.retainSubmitted(source());
		await started.promise;
		const b = f.api.persistCurrent(source(1, " newer current "));
		const independent = source(0, " other form ", "form-independent");
		expect(await f.api.persistCurrent(independent)).toBe(true);
		expect(f.get(independent).current).toEqual(independent);
		gate.resolve();
		expect(await a).toBe(true);
		expect(await b).toBe(true);
		expect(f.get().current.revision).toBe(1);
		expect(f.get().submitted[0].revision).toBe(0);
	});
	it("corrupt scan stays explicit and does not repair, create, retire or delete rows", async () => {
		const f = fixture();
		f.rows.set("unknown-key", undefined);
		const result = await f.api.inspect();
		expect(result.status).toBe("corrupt");
		expect(result.unknown).toEqual([{ key: "unknown-key", value: undefined }]);
		expect(f.rows.size).toBe(1);
		expect(f.writes).toEqual([]);
	});
	it("invalid or extra/config fields are not captured into this typed store", async () => {
		const f = fixture();
		expect(await f.api.retainSubmitted({ ...source(), config: "FAKE_EXCLUDED_ONLY" })).toBe(false);
		expect(f.rows.size).toBe(0);
		expect(f.api.getSnapshot().failures).toEqual([]);
		expect(f.problem).toHaveBeenCalledOnce();
	});
	it("source and full wire are captured together before an await; capture alone performs no IO", async () => {
		const f = fixture();
		const original = source();
		const expected = structuredClone(original);
		const message = wireFor(original);
		const captured = f.api.captureOriginal(message, original, original.workspace);
		expect(captured).not.toBeNull();
		expect(f.rows.size).toBe(0);
		expect(f.api.getSnapshot().pending).toBe(0);
		Object.assign(original.form, { prompt: "later caller mutation", cron: "changed inactive field" });
		message.task.prompt = "later wire mutation";
		expect(captured?.message).toEqual(wireFor(expected));
		expect(await captured?.beforeCheckpoint?.()).toBe(true);
		expect(f.get().submitted).toEqual([expected]);
	});
	it("missing genuine source, wrong workspace or wire/source mismatch refuses before checkpointing", () => {
		const f = fixture();
		const original = source();
		const message = wireFor(original);
		expect(f.api.captureOriginal(message, undefined, original.workspace)).toBeNull();
		expect(f.api.captureOriginal(message, original, "/different-workspace")).toBeNull();
		message.task.prompt = "not this source";
		expect(f.api.captureOriginal(message, original, original.workspace)).toBeNull();
		expect(f.rows.size).toBe(0);
		expect(f.writes).toEqual([]);
	});
	it("extra control/config fields and invalid executable interval are never admitted as a source packet", () => {
		const f = fixture();
		const original = source();
		const message = wireFor(original);
		Object.assign(message.task, { enabled: true });
		expect(f.api.captureOriginal(message, original, original.workspace)).toBeNull();
		const invalid = source();
		Object.assign(invalid.form, { intervalMinutes: "Infinity" });
		expect(f.api.captureOriginal(wireFor(invalid), invalid, invalid.workspace)).toBeNull();
		expect(f.rows.size).toBe(0);
	});
	it("throwing observers/reporters cannot abandon checkpoint ownership", async () => {
		const f = fixture();
		const api = createSchedulerSourceCheckpoints({
			storage: f.storage,
			newRecordId: () => "safe",
			problem: () => {
				throw new Error("report failed");
			},
		});
		const unsubscribe = api.subscribe(() => {
			throw new Error("view failed");
		});
		f.abortSwap();
		expect(await api.retainSubmitted(source())).toBe(false);
		expect(api.getSnapshot().failures[0].source).toEqual(source());
		expect(await api.persistCurrent(source(1, " newer "))).toBe(true);
		expect(f.get().submitted).toEqual([source()]);
		unsubscribe();
	});
});
