// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	SchedulerPanel,
	getSchedulerAdmissionSource,
	getSchedulerCurrentSources,
	subscribeSchedulerCurrentSources,
	type SchedulerAdmissionSource,
} from "../../web/src/components/SchedulerPanel";
import { setAppAdmit } from "../../web/src/app-admit";
import { setAppSend } from "../../web/src/app-globals";
import { LanguageProvider } from "../../web/src/i18n";
import { createSchedulerSourceCheckpoints } from "../../web/src/recovery-scheduler";
import {
	copySchedulerDraftRecord,
	encodeSchedulerDraftRecord,
	schedulerDraftKey,
	SchedulerDraftError,
	type SchedulerDraftStorage,
} from "../../web/src/scheduler-draft-store";
import type { ClientMessage } from "../../web/src/types";

const roots: Root[] = [];
const unsubscribers: (() => void)[] = [];
let serial = 0;
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function fixture() {
	const workspace = `/scheduler-source-panel-${++serial}`;
	const rows = new Map<string, unknown>();
	const pending: Promise<unknown>[] = [];
	let readGate: ReturnType<typeof deferred> | undefined;
	let readStarted: ReturnType<typeof deferred> | undefined;
	const storage: SchedulerDraftStorage = {
		async read(key) {
			if (readGate) {
				const gate = readGate;
				readGate = undefined;
				readStarted?.resolve();
				await gate.promise;
			}
			if (rows.has(key) && rows.get(key) === undefined) throw new SchedulerDraftError("invalid-record");
			return rows.get(key);
		},
		async scan() {
			return { status: "present", rows: [...rows].map(([key, value]) => ({ key, value })) };
		},
		async swap(key, expected, replacement) {
			const actual = rows.has(key) ? encodeSchedulerDraftRecord(rows.get(key)) : null;
			if (actual !== expected) throw new SchedulerDraftError("conflict");
			rows.set(key, copySchedulerDraftRecord(replacement));
		},
	};
	const owner = createSchedulerSourceCheckpoints({ storage, newRecordId: () => `record-${rows.size}` });
	const observed: SchedulerAdmissionSource[] = [];
	unsubscribers.push(
		subscribeSchedulerCurrentSources((source) => {
			if (source.workspace !== workspace) return;
			observed.push(source);
			pending.push(owner.persistCurrent(source));
		}),
	);
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	roots.push(root);
	act(() =>
		root.render(
			createElement(LanguageProvider, null, createElement(SchedulerPanel, { cwd: workspace, tasks: [], models: [] })),
		),
	);
	function node(selector: string): HTMLElement {
		const value = container.querySelector<HTMLElement>(selector);
		if (!value) throw new Error(`Missing synthetic UI: ${selector}`);
		return value;
	}
	return {
		workspace,
		rows,
		owner,
		observed,
		container,
		open() {
			act(() => node(".set-section-title .set-save-btn").click());
		},
		close() {
			act(() => node(".modal-close").click());
		},
		submit() {
			act(() => node(".scheduler-foot .primary").click());
		},
		field(name: string, value: string) {
			const target = node(`.modal [name="${name}"]`);
			act(() => {
				const proto =
					target.tagName === "TEXTAREA"
						? HTMLTextAreaElement.prototype
						: target.tagName === "SELECT"
							? HTMLSelectElement.prototype
							: HTMLInputElement.prototype;
				Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(target, value);
				target.dispatchEvent(new Event(target.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
			});
		},
		prompt() {
			return (node('.modal [name="prompt"]') as HTMLTextAreaElement).value;
		},
		async flush() {
			await act(async () => {
				await Promise.all(pending);
			});
		},
		holdRead() {
			readGate = deferred();
			readStarted = deferred();
			return { gate: readGate, started: readStarted };
		},
		current() {
			return getSchedulerCurrentSources()
				.filter((source) => source.workspace === workspace)
				.at(-1)!;
		},
		stored(source: SchedulerAdmissionSource) {
			return copySchedulerDraftRecord(rows.get(schedulerDraftKey(source)));
		},
	};
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	setAppSend(() => true);
	setAppAdmit(null);
	localStorage.clear();
});
afterEach(() => {
	for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
	act(() => {
		for (const root of roots.splice(0)) root.unmount();
	});
	setAppSend(null);
	setAppAdmit(null);
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("actual Scheduler current-source checkpoint handoff (synthetic storage only)", () => {
	it("an authored edit publishes the complete exact source, including inactive options; look-only reads send nothing", async () => {
		const f = fixture();
		f.open();
		expect(f.observed).toEqual([]); // Opening a backed/default form is not a new authored edit.
		f.field("name", " original name ");
		f.field("description", " raw description\t");
		f.field("preset", "custom");
		f.field("cron", " 7 8 * * 2 ");
		f.field("kind", "interval");
		f.field("intervalMinutes", "2.9");
		f.field("prompt", "  source é 🌈\n");
		const current = f.current();
		const before = f.observed.length;
		expect(current).toMatchObject({
			workspace: f.workspace,
			taskId: null,
			revision: before,
			form: {
				name: " original name ",
				description: " raw description\t",
				cron: " 7 8 * * 2 ",
				preset: "custom",
				kind: "interval",
				intervalMinutes: "2.9",
				prompt: "  source é 🌈\n",
			},
		});
		expect(Object.isFrozen(current)).toBe(true);
		expect(Object.isFrozen(current.form)).toBe(true);
		getSchedulerCurrentSources();
		expect(f.observed).toHaveLength(before);
		await f.flush();
		expect(f.stored(current).current).toEqual(current);
		expect(f.stored(current).submitted).toEqual([]);
	});
	it("real original-object lookup precedes cloning; deferred source A and newer B both survive", async () => {
		const f = fixture();
		f.open();
		f.field("name", "name");
		f.field("prompt", "  original A\n");
		await f.flush();
		let submitted: SchedulerAdmissionSource | undefined;
		let completion: Promise<boolean> | undefined;
		setAppAdmit((message: ClientMessage) => {
			submitted = getSchedulerAdmissionSource(message);
			expect(submitted).toBeDefined();
			const clone = structuredClone(message);
			expect(getSchedulerAdmissionSource(clone)).toBeUndefined();
			const captured = f.owner.captureOriginal(message, submitted, f.workspace);
			expect(captured).not.toBeNull();
			completion = captured!.beforeCheckpoint!();
			// This fixture has NO full-wire/server admission: deliberately never grant true.
			return completion.then(() => false);
		});
		const { gate, started } = f.holdRead();
		f.submit();
		await started.promise;
		f.field("prompt", "  newer editable B\n");
		const current = f.current();
		expect(f.prompt()).toBe(current.form.prompt);
		expect(submitted?.form.prompt).toBe("  original A\n");
		await act(async () => {
			gate.resolve();
			await completion;
		});
		await f.flush();
		const stored = f.stored(current);
		expect(stored.current).toEqual(current);
		expect(stored.submitted).toEqual([submitted]);
		expect(f.prompt()).toBe("  newer editable B\n");
	});
	it("reopening a form gets a real new lifetime; the old source remains independently recoverable", async () => {
		const f = fixture();
		f.open();
		f.field("prompt", " original A ");
		const a = f.current();
		f.close();
		f.open();
		f.field("prompt", " current B ");
		const b = f.current();
		expect(b.formId).not.toBe(a.formId);
		expect(b.revision).toBeGreaterThan(a.revision);
		await f.flush();
		expect(f.stored(a).current).toEqual(a);
		expect(f.stored(b).current).toEqual(b);
		f.close();
		expect(getSchedulerCurrentSources().filter((source) => source.workspace === f.workspace)).toEqual([a, b]);
	});
	it("a throwing observer cannot lose the edit or stop other complete-source observers", async () => {
		unsubscribers.push(
			subscribeSchedulerCurrentSources(() => {
				throw new Error("synthetic observer failure");
			}),
		);
		const f = fixture();
		f.open();
		f.field("prompt", "  unchanged full source\n");
		expect(f.prompt()).toBe("  unchanged full source\n");
		expect(f.current().form.prompt).toBe(f.prompt());
		await f.flush();
	});
});
