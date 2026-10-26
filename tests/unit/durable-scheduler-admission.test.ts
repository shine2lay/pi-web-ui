// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	SchedulerPanel,
	getSchedulerAdmissionSource,
	getSchedulerDraftRecoveries,
	restoreSchedulerDraft,
	type SchedulerTaskDraft,
} from "../../web/src/components/SchedulerPanel.js";
import { appAdmit, setAppAdmit, type AppAdmit } from "../../web/src/app-admit.js";
import { setAppSend } from "../../web/src/app-globals.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { ClientMessage, SchedulerTaskView } from "../../web/src/types.js";

type Props = ComponentProps<typeof SchedulerPanel>;
const roots: Root[] = [];
let serial = 0;
const sends = vi.fn((_msg: ClientMessage) => false);
const models = [
	{ provider: "fixture", id: "a", label: "Fixture A" },
	{ provider: "fixture", id: "b", label: "Fixture B" },
];
function task(id = "task-a", patch: Partial<SchedulerTaskView> = {}): SchedulerTaskView {
	return {
		id,
		name: "Existing",
		description: "Disk description",
		cwd: "/synthetic/task-cwd",
		kind: "cron",
		spec: "0 9 * * *",
		prompt: "Disk prompt",
		model: "fixture/a",
		thinkingLevel: "high",
		catchUp: "once",
		enabled: false,
		conversationId: "",
		sessionFile: "",
		oneShot: false,
		createdAt: 1,
		updatedAt: 2,
		nextFire: null,
		lastRun: null,
		history: [
			{ at: 1, ok: true, durationMs: 100 },
			{ at: 2, ok: false, durationMs: 200 },
		],
		running: false,
		...patch,
	};
}
function original(id = ""): SchedulerTaskDraft {
	return {
		id,
		name: "  Task é 🌈  ",
		description: "  description\t ",
		cwd: " /synthetic/authored path/ ",
		kind: "cron",
		cron: " 7 8 * * 2 ",
		preset: "custom",
		intervalMinutes: "60",
		prompt: "  keep é 🌈\nsecond line\t  ",
		model: "fixture/b",
		thinkingLevel: "medium",
		catchUp: false,
	};
}
function expectedTask(form: SchedulerTaskDraft) {
	return {
		...(form.id ? { id: form.id } : {}),
		name: form.name,
		description: form.description,
		cwd: form.cwd,
		kind: form.kind,
		spec: form.kind === "cron" ? form.cron : String(Math.max(1, Math.floor(Number(form.intervalMinutes) || 0)) * 60000),
		prompt: form.prompt,
		model: form.model,
		thinkingLevel: form.thinkingLevel,
		catchUp: form.catchUp ? "once" : "skip",
	};
}
function deferred() {
	let resolve!: (value: unknown) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<unknown>((ok, bad) => {
		resolve = ok;
		reject = bad;
	});
	return { promise, resolve, reject };
}
function node<T extends HTMLElement>(container: Element, selector: string): T {
	const el = container.querySelector<T>(selector);
	if (!el) throw new Error(`Missing fixture element: ${selector}`);
	return el;
}
const click = (el: HTMLElement) => act(() => el.click());
function field(container: Element, name: string, value: string | boolean) {
	const el = node<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(container, `.modal [name="${name}"]`);
	act(() => {
		if (typeof value === "boolean") {
			if ((el as HTMLInputElement).checked !== value) el.click();
		} else {
			const proto =
				el.tagName === "SELECT"
					? HTMLSelectElement.prototype
					: el.tagName === "TEXTAREA"
						? HTMLTextAreaElement.prototype
						: HTMLInputElement.prototype;
			Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
			el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
		}
	});
}
function fill(container: Element, form: SchedulerTaskDraft) {
	for (const name of ["name", "description", "cwd", "prompt", "model", "thinkingLevel", "catchUp", "kind"] as const)
		field(container, name, form[name]);
	if (form.kind === "cron") {
		field(container, "preset", form.preset);
		if (form.preset === "custom") field(container, "cron", form.cron);
	} else field(container, "intervalMinutes", form.intervalMinutes);
}
function mount(patch: Partial<Props> = {}) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	roots.push(root);
	let props: Props = { cwd: `/synthetic/workspace-${++serial}`, tasks: [task(), task("task-b")], models, ...patch };
	const render = (next: Partial<Props> = {}) => {
		props = { ...props, ...next };
		act(() => root.render(createElement(LanguageProvider, null, createElement(SchedulerPanel, props))));
	};
	render();
	return {
		container,
		render,
		workspace: props.cwd,
		open(id = "") {
			click(
				node(container, id ? `[data-scheduler-task="${id}"] button[title="Edit"]` : ".set-section-title .set-save-btn"),
			);
		},
		submit() {
			click(node(container, ".scheduler-foot .primary"));
		},
		close() {
			click(node(container, ".modal-close"));
		},
		current(id = "", workspace = props.cwd) {
			return getSchedulerDraftRecoveries().find((r) => r.workspace === workspace && r.current.id === id)!;
		},
		unmount() {
			act(() => root.unmount());
			roots.splice(roots.indexOf(root), 1);
		},
	};
}
function kept(container: Element, form: SchedulerTaskDraft) {
	for (const name of ["name", "description", "cwd", "prompt", "model", "thinkingLevel", "kind"] as const)
		expect(node<HTMLInputElement>(container, `.modal [name="${name}"]`).value, name).toBe(form[name]);
	expect(node<HTMLInputElement>(container, '.modal [name="catchUp"]').checked).toBe(form.catchUp);
	if (form.kind === "cron") {
		expect(node<HTMLInputElement>(container, '.modal [name="preset"]').value).toBe(form.preset);
		if (form.preset === "custom")
			expect(node<HTMLInputElement>(container, '.modal [name="cron"]').value).toBe(form.cron);
	} else expect(node<HTMLInputElement>(container, '.modal [name="intervalMinutes"]').value).toBe(form.intervalMinutes);
}
async function finish(d: ReturnType<typeof deferred>, outcome: unknown, rejection = false) {
	await act(async () => {
		if (rejection) d.reject(outcome);
		else d.resolve(outcome);
		await d.promise.catch(() => {});
	});
}
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	sends.mockClear();
	setAppSend(sends);
	setAppAdmit(null);
	localStorage.clear();
});
afterEach(() => {
	act(() => {
		for (const root of roots.splice(0)) root.unmount();
	});
	setAppSend(null);
	setAppAdmit(null);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("look-only recovered original restoration", () => {
	function source(workspace: string, form = original()) {
		return { workspace, taskId: form.id || null, formId: crypto.randomUUID(), revision: 7, form };
	}
	function restore(value: unknown) {
		let result = false;
		act(() => {
			result = restoreSchedulerDraft(value);
		});
		return result;
	}
	for (const id of ["", "task-archived"]) {
		for (const kind of ["cron", "interval"] as const) {
			it(`restores complete ${id || "new"} ${kind} for explicit editable review only`, () => {
				const h = mount();
				const form = { ...original(id), kind, intervalMinutes: "2.9", model: "", thinkingLevel: "", catchUp: true };
				const value = source(h.workspace, form);
				expect(restore(value)).toBe(true);
				expect(h.container.querySelector(".modal")).toBeNull();
				expect(h.current(id).current).toEqual(form);
				expect(h.current(id).restoredSources).toEqual([value]);
				const saved = h.current(id).restoredSources[0];
				expect(Object.isFrozen(saved)).toBe(true);
				expect(Object.isFrozen(saved.form)).toBe(true);
				value.form.prompt = "mutation after restore";
				expect(saved.form.prompt).toBe(original(id).prompt);
				click(node(h.container, `[data-scheduler-review="${id}"] .btn`));
				kept(h.container, { ...form, prompt: original(id).prompt });
				expect(h.container.textContent).toContain("No task was created, enabled or run");
				expect(h.current(id).attempts).toEqual([]);
				expect(sends.mock.calls.map(([m]) => m.type)).toEqual(["schedule_list"]);
			});
		}
	}
	it("never overwrites newer same-record edits, another current form or the same source identity", () => {
		const h = mount();
		h.open();
		const newer = { ...original(), prompt: "newer current B" };
		fill(h.container, newer);
		const value = source(h.workspace);
		expect(restore(value)).toBe(true);
		kept(h.container, newer);
		expect(h.current().current).toEqual(newer);
		expect(h.current().restoredSources[0].form).toEqual(original());
		expect(restore(structuredClone(value))).toBe(true);
		expect(h.current().restoredSources).toHaveLength(1);
		expect(restore({ ...value, form: { ...value.form, prompt: "corrupt same identity" } })).toBe(false);
		expect(h.current().restoredSources).toHaveLength(1);
		expect(restore(source(h.workspace, original("task-archived")))).toBe(true);
		kept(h.container, newer);
		expect(h.current("task-archived").current).toEqual(original("task-archived"));
		expect(sends.mock.calls.map(([m]) => m.type)).toEqual(["schedule_list"]);
	});
	it("restore cannot clear pending ownership, dispatch twice or lend an old form close authority", async () => {
		const d = deferred();
		let captured: ClientMessage | undefined;
		setAppAdmit(((msg: ClientMessage) => {
			captured = msg;
			return d.promise;
		}) as AppAdmit);
		const h = mount();
		h.open("task-a");
		const form = original("task-a");
		fill(h.container, form);
		h.submit();
		const value = getSchedulerAdmissionSource(captured!)!;
		field(h.container, "prompt", "newer B");
		expect(restore(value)).toBe(true);
		expect(restore({ ...value, form: { ...value.form, prompt: "corrupt original" } })).toBe(false);
		expect(node<HTMLButtonElement>(h.container, ".scheduler-foot .primary").disabled).toBe(true);
		h.close();
		h.open("task-a");
		await finish(d, true);
		kept(h.container, { ...form, prompt: "newer B" });
		expect(h.current("task-a").attempts).toHaveLength(1);
		expect(sends.mock.calls.map(([m]) => m.type)).toEqual(["schedule_list"]);
	});
	it("retains original workspace/task without retargeting the open workspace or session", () => {
		const h = mount();
		h.open();
		fill(h.container, original());
		const other = source("/synthetic/recovered-other-workspace", original("task-archived"));
		expect(restore(other)).toBe(true);
		kept(h.container, original());
		expect(h.container.querySelector('[data-scheduler-review="task-archived"]')).toBeNull();
		h.render({ cwd: other.workspace });
		expect(h.container.querySelector(".modal")).toBeNull();
		click(node(h.container, '[data-scheduler-review="task-archived"] .btn'));
		kept(h.container, other.form);
		expect(sends.mock.calls.map(([m]) => m.type)).toEqual(["schedule_list"]);
	});
	for (const invalid of [
		(value: ReturnType<typeof source>) => ({ ...value, workspace: "" }),
		(value: ReturnType<typeof source>) => ({ ...value, taskId: "" }),
		(value: ReturnType<typeof source>) => ({ ...value, taskId: "wrong-task" }),
		(value: ReturnType<typeof source>) => ({ ...value, formId: "" }),
		(value: ReturnType<typeof source>) => ({ ...value, revision: -1 }),
		(value: ReturnType<typeof source>) => ({ ...value, revision: 0.5 }),
		(value: ReturnType<typeof source>) => ({ ...value, revision: Number.MAX_SAFE_INTEGER + 1 }),
		(value: ReturnType<typeof source>) => ({ ...value, conversationId: "invented" }),
		(value: ReturnType<typeof source>) => ({ ...value, form: { ...value.form, catchUp: "once" } }),
		(value: ReturnType<typeof source>) => ({ ...value, form: { ...value.form, kind: "command" } }),
		(value: ReturnType<typeof source>) => ({ ...value, form: { ...value.form, preset: "unknown" } }),
		(value: ReturnType<typeof source>) => ({ ...value, form: { ...value.form, prompt: null } }),
		(value: ReturnType<typeof source>) => ({ ...value, form: { ...value.form, enabled: true } }),
		(value: ReturnType<typeof source>) => ({ ...value, form: { ...value.form, model: undefined } }),
		(value: ReturnType<typeof source>) => Object.assign(Object.create({ inherited: true }), value),
		(value: ReturnType<typeof source>) =>
			Object.defineProperty(value, "form", {
				enumerable: true,
				get() {
					throw new Error("must not read accessor");
				},
			}),
	]) {
		it("refuses malformed/extra/prototype/accessor source without mutation or dispatch", () => {
			const before = getSchedulerDraftRecoveries();
			const value = source(`/synthetic/invalid-${++serial}`);
			expect(restore(invalid(value))).toBe(false);
			expect(getSchedulerDraftRecoveries()).toEqual(before);
			expect(sends).not.toHaveBeenCalled();
		});
	}
	for (const key of Object.keys(original())) {
		it(`requires original form field ${key}, including inactive and empty fields`, () => {
			const value = source(`/synthetic/missing-${++serial}`);
			const missing: Record<string, unknown> = { ...value.form };
			delete missing[key];
			expect(restore({ ...value, form: missing })).toBe(false);
			expect(sends).not.toHaveBeenCalled();
		});
	}
});

describe("real SchedulerPanel complete authored task admission", () => {
	for (const id of ["", "task-a"]) {
		it.each([false, undefined, 1, "true", { ok: true }])(
			`retains complete ${id || "new"} task on nontrue %j`,
			async (outcome) => {
				const d = deferred();
				const admit = vi.fn((_msg: ClientMessage) => d.promise);
				setAppAdmit(admit as AppAdmit);
				const h = mount();
				const form = original(id);
				h.open(id);
				fill(h.container, form);
				h.submit();
				kept(h.container, form);
				expect(h.container.querySelector('[data-scheduler-admission="pending"]')).not.toBeNull();
				const msg = admit.mock.calls[0]?.[0] as unknown as ClientMessage;
				expect(msg).toEqual({ type: "schedule_save", task: expectedTask(form) });
				const source = getSchedulerAdmissionSource(msg)!;
				expect(source.form).toEqual(form);
				expect(source.workspace).toBe(h.workspace);
				expect(source.taskId).toBe(id || null);
				expect(Object.isFrozen(msg)).toBe(true);
				expect(Object.isFrozen(source.form)).toBe(true);
				expect(Object.isFrozen((msg as Extract<ClientMessage, { type: "schedule_save" }>).task)).toBe(true);
				await finish(d, outcome);
				kept(h.container, form);
				expect(h.current(id).current).toEqual(form);
				expect(h.current(id).attempts[0].source).toEqual(source);
				expect(h.current(id).attempts[0].message).toEqual(msg);
				expect(node(h.container, '[data-scheduler-admission="unconfirmed"]').textContent).toContain("not confirmed");
				expect(sends.mock.calls.map(([m]) => m.type)).toEqual(["schedule_list"]);
			},
		);
		it.each([
			new Error("synthetic rejection"),
			Object.assign(new Error("after checkpoint"), { payloadCommitted: true }),
		])(`retains originals/current ${id || "new"} on rejection %s`, async (error) => {
			const d = deferred();
			setAppAdmit((() => d.promise) as AppAdmit);
			const h = mount();
			const form = original(id);
			h.open(id);
			fill(h.container, form);
			h.submit();
			field(h.container, "prompt", "B while pending\n ");
			await finish(d, error, true);
			kept(h.container, { ...form, prompt: "B while pending\n " });
			expect(h.current(id).attempts[0].source.form).toEqual(form);
			expect(node(h.container, '[data-scheduler-admission="unconfirmed"]').textContent).toContain(
				"before saving again",
			);
		});
		it(`closes only unchanged ${id || "new"} on exact true, retaining complete local recovery`, async () => {
			const d = deferred();
			setAppAdmit((() => d.promise) as AppAdmit);
			const h = mount();
			const form = original(id);
			h.open(id);
			fill(h.container, form);
			h.submit();
			kept(h.container, form);
			await finish(d, true);
			expect(h.container.querySelector(".modal")).toBeNull();
			expect(h.current(id).current).toEqual(form);
			expect(h.current(id).attempts[0].phase).toBe("admitted");
			expect(h.container.textContent).toContain("server save, enablement and execution are not confirmed");
			h.open(id);
			kept(h.container, form);
			expect(h.current(id).attempts).toHaveLength(1);
		});
	}
	it("unbound and throwing handlers never fall back to synchronous send", async () => {
		const h = mount();
		const form = original();
		h.open();
		fill(h.container, form);
		await act(async () => h.submit());
		kept(h.container, form);
		setAppAdmit(() => {
			throw new Error("synthetic sync throw");
		});
		await act(async () => h.submit());
		kept(h.container, form);
		expect(h.current().attempts.map((a) => a.phase)).toEqual(["unconfirmed", "unconfirmed"]);
		expect(sends.mock.calls.map(([m]) => m.type)).toEqual(["schedule_list"]);
		expect(getSchedulerAdmissionSource({ type: "schedule_list" })).toBeUndefined();
	});
	it.each(["0 9 * * *", "0 * * * *", "*/30 * * * *", "0 9 * * 1-5", "0 9 * * 1"])(
		"captures preset %s explicitly",
		async (spec) => {
			const admit = vi.fn(async (_msg: ClientMessage) => false);
			setAppAdmit(admit);
			const h = mount();
			const form = {
				...original(),
				preset: spec,
				cron: spec,
				description: "",
				model: "",
				thinkingLevel: "",
				catchUp: true,
			};
			h.open();
			fill(h.container, form);
			await act(async () => h.submit());
			expect(admit).toHaveBeenCalledExactlyOnceWith({ type: "schedule_save", task: expectedTask(form) });
			kept(h.container, form);
			expect(h.current().attempts[0].source.form).toEqual(form);
		},
	);
	it.each(["1", "2.9", "0", "", "73"])(
		"retains original interval %j separately from explicit milliseconds",
		async (minutes) => {
			const admit = vi.fn(async (_msg: ClientMessage) => false);
			setAppAdmit(admit);
			const h = mount();
			const form = {
				...original("task-a"),
				kind: "interval" as const,
				intervalMinutes: minutes,
				cron: "0 9 * * *",
				preset: "0 9 * * *",
				description: "",
				model: "",
				thinkingLevel: "",
				catchUp: true,
			};
			h.open("task-a");
			fill(h.container, form);
			await act(async () => h.submit());
			expect(admit).toHaveBeenCalledExactlyOnceWith({ type: "schedule_save", task: expectedTask(form) });
			kept(h.container, form);
			expect(h.current("task-a").attempts[0].source.form).toEqual(form);
		},
	);
	it("initializes custom cron and interval task forms using existing explicit view conversion", () => {
		const h = mount({
			tasks: [
				task("custom", { spec: " 3 4 * * 5 " }),
				task("interval", { kind: "interval", spec: "90001", catchUp: "skip" }),
			],
		});
		h.open("custom");
		expect(node<HTMLInputElement>(h.container, '[name="cron"]').value).toBe(" 3 4 * * 5 ");
		h.close();
		h.open("interval");
		expect(node<HTMLInputElement>(h.container, '[name="intervalMinutes"]').value).toBe("2");
		expect(node<HTMLInputElement>(h.container, '[name="catchUp"]').checked).toBe(false);
	});
});

describe("revision, form lifetime, task and workspace fences", () => {
	it.each([
		"name",
		"description",
		"cwd",
		"prompt",
		"model",
		"thinkingLevel",
		"catchUp",
		"kind",
		"preset",
		"cron",
		"intervalMinutes",
	] as const)("keeps B and ABA for %s on late true", async (name) => {
		for (const aba of [false, true]) {
			const d = deferred();
			const admit = vi.fn((_msg: ClientMessage) => d.promise);
			setAppAdmit(admit as AppAdmit);
			const h = mount();
			let form = original();
			if (name === "intervalMinutes") form = { ...form, kind: "interval", cron: "0 9 * * *", preset: "0 9 * * *" };
			h.open();
			fill(h.container, form);
			h.submit();
			const changed =
				name === "catchUp"
					? true
					: name === "kind"
						? "interval"
						: name === "model"
							? "fixture/a"
							: name === "thinkingLevel"
								? "high"
								: name === "preset"
									? "0 * * * *"
									: name === "intervalMinutes"
										? "25"
										: `${form[name]}B`;
			field(h.container, name, changed);
			if (aba) {
				field(h.container, name, form[name]);
				if (name === "preset") field(h.container, "cron", form.cron);
			}
			await finish(d, true);
			expect(h.container.querySelector(".modal")).not.toBeNull();
			expect(h.current().attempts[0].source.form).toEqual(form);
			expect(admit.mock.calls[0][0]).toEqual({ type: "schedule_save", task: expectedTask(form) });
			const current = aba
				? form
				: { ...form, [name]: changed, ...(name === "preset" ? { cron: changed as string } : {}) };
			expect(h.current().current).toEqual(current);
			kept(h.container, current);
		}
	});
	it.each([true, false, "reject"])(
		"old completion %s cannot close reopened same-task form or lose either snapshot",
		async (outcome) => {
			const d = deferred();
			const admit = vi.fn(() => d.promise);
			setAppAdmit(admit as AppAdmit);
			const h = mount();
			const form = original("task-a");
			h.open("task-a");
			fill(h.container, form);
			h.submit();
			const before = h.current("task-a").attempts[0].source.formId;
			h.close();
			h.open("task-a");
			kept(h.container, form);
			h.submit();
			expect(admit).toHaveBeenCalledTimes(1);
			await finish(d, outcome === "reject" ? new Error("late rejection") : outcome, outcome === "reject");
			kept(h.container, form);
			expect(node(h.container, ".modal-backdrop").dataset.schedulerForm).not.toBe(before);
			expect(h.current("task-a").attempts[0].source.form).toEqual(form);
		},
	);
	it.each([
		["", "task-a"],
		["task-a", ""],
		["task-a", "task-b"],
	])("completion for %s cannot clear form %s", async (first, next) => {
		const d = deferred();
		const admit = vi.fn(() => d.promise);
		setAppAdmit(admit as AppAdmit);
		const h = mount();
		const form = original(first);
		h.open(first);
		fill(h.container, form);
		h.submit();
		h.close();
		h.open(next);
		const other = { ...original(next), prompt: "Other form B" };
		fill(h.container, other);
		await finish(d, true);
		kept(h.container, other);
		expect(h.current(first).attempts[0].source.form).toEqual(form);
	});
	it("workspace A-B-A fences late completion and restores drafts without mutation messages", async () => {
		const d = deferred();
		const admit = vi.fn(() => d.promise);
		setAppAdmit(admit as AppAdmit);
		const h = mount();
		const form = original();
		h.open();
		fill(h.container, form);
		h.submit();
		const a = h.workspace;
		h.render({ cwd: `${a}-B` });
		expect(h.container.querySelector(".modal")).toBeNull();
		h.open();
		const b = { ...original(), prompt: "B workspace" };
		fill(h.container, b);
		h.render({ cwd: a });
		h.open();
		await finish(d, true);
		kept(h.container, form);
		expect(h.current("", `${a}-B`).current).toEqual(b);
		expect(admit).toHaveBeenCalledTimes(1);
		expect(sends.mock.calls.map(([m]) => m.type)).toEqual(["schedule_list"]);
	});
	it("navigation unmount/remount keeps current and submitted originals; old true cannot close restored form", async () => {
		const d = deferred();
		const admit = vi.fn(() => d.promise);
		setAppAdmit(admit as AppAdmit);
		const h = mount();
		const form = original("task-a");
		h.open("task-a");
		fill(h.container, form);
		h.submit();
		field(h.container, "prompt", "newer before navigation");
		h.unmount();
		const other = mount({ cwd: h.workspace });
		other.open("task-a");
		await finish(d, true);
		kept(other.container, { ...form, prompt: "newer before navigation" });
		expect(other.current("task-a").attempts[0].source.form).toEqual(form);
		expect(admit).toHaveBeenCalledTimes(1);
		expect(sends.mock.calls.map(([m]) => m.type)).toEqual(["schedule_list", "schedule_list"]);
	});
	it("synchronous duplicate click and reopen while pending dispatch only once", async () => {
		const d = deferred();
		const admit = vi.fn(() => d.promise);
		setAppAdmit(admit as AppAdmit);
		const h = mount();
		h.open();
		fill(h.container, original());
		const btn = node<HTMLButtonElement>(h.container, ".scheduler-foot .primary");
		act(() => {
			btn.click();
			btn.click();
		});
		h.close();
		h.open();
		h.submit();
		expect(admit).toHaveBeenCalledTimes(1);
		expect(node<HTMLButtonElement>(h.container, ".scheduler-foot .primary").disabled).toBe(true);
		await finish(d, false);
		expect(node<HTMLButtonElement>(h.container, ".scheduler-foot .primary").disabled).toBe(false);
	});
	it("task-list refresh, model-list changes and use-current-cwd cannot alter captured task", async () => {
		const d = deferred();
		setAppAdmit((() => d.promise) as AppAdmit);
		const h = mount();
		const form = original("task-a");
		h.open("task-a");
		fill(h.container, form);
		h.submit();
		const before = h.current("task-a").attempts[0];
		h.render({ tasks: [task("task-a", { name: "External disk change", prompt: "not this draft" })], models: [] });
		click(node(h.container, ".scheduler-cwd-row .btn"));
		await finish(d, true);
		kept(h.container, { ...form, cwd: h.workspace });
		expect(h.current("task-a").current).toEqual({ ...form, cwd: h.workspace });
		expect(h.current("task-a").attempts[0]).toEqual({ ...before, phase: "admitted" });
		expect(h.current("task-a").attempts[0].source.form).toEqual(form);
		expect(h.container.querySelector(".modal")).not.toBeNull();
	});
	it("retained copies cannot be mutated through the public recovery snapshot", async () => {
		const h = mount();
		h.open();
		fill(h.container, original());
		await act(async () => h.submit());
		const recovery = h.current();
		expect(Object.isFrozen(recovery.current)).toBe(true);
		expect(Object.isFrozen(recovery.attempts)).toBe(true);
		expect(() => {
			(recovery.current as { prompt: string }).prompt = "overwrite";
		}).toThrow();
		expect(h.current().current.prompt).toBe(original().prompt);
	});
});

describe("unchanged authorized read and control paths", () => {
	it("list/history/toggle/run/delete never call generic admission; delete still requires confirmation", async () => {
		const admit = vi.fn(async () => true);
		setAppAdmit(admit);
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		const h = mount();
		const row = node(h.container, '[data-scheduler-task="task-a"]');
		click(node(row, ".scheduler-link"));
		expect(row.querySelector(".scheduler-history")).not.toBeNull();
		click(node(row, ".set-switch"));
		click(node(row, 'button[title="Run now"]'));
		click(node(row, 'button[title="Delete"]'));
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(sends.mock.calls.map(([m]) => m.type)).toEqual(["schedule_list", "schedule_toggle", "schedule_run"]);
		confirm.mockReturnValue(true);
		click(node(row, 'button[title="Delete"]'));
		expect(sends.mock.calls.at(-1)?.[0]).toEqual({ type: "schedule_delete", id: "task-a" });
		expect(admit).not.toHaveBeenCalled();
		// The pre-change UI has no run/toggle confirm; this repair must not invent one.
		expect(confirm).toHaveBeenCalledTimes(2);
		const running = mount({ tasks: [task("running", { running: true })] });
		expect(node<HTMLButtonElement>(running.container, 'button[title="Run now"]').disabled).toBe(true);
	});
	it("blank required fields keep existing guard and neither adapter is invoked", () => {
		const admit = vi.fn(async () => true);
		setAppAdmit(admit);
		const h = mount();
		h.open();
		h.submit();
		expect(admit).not.toHaveBeenCalled();
		expect(sends.mock.calls.map(([m]) => m.type)).toEqual(["schedule_list"]);
	});
	it("the shared registry is real and still normalizes nonboolean admission", async () => {
		setAppAdmit((async () => ({ ok: true })) as unknown as AppAdmit);
		expect(await appAdmit({ type: "schedule_list" })).toBe(false);
	});
});
