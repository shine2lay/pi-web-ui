// @vitest-environment jsdom
// #592 / H-QUEUE-ANSWER-RESULT-1. Written against real components before their repair.
// The native-browser companion also mounts the pinned, genuinely old components as a loss control.
import { act, createElement, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	TaskQueuePanel,
	type TaskQueueAnswerBinding,
	type TaskQueueAnswerRequest,
	type TaskQueueAnswerResult,
} from "../../web/src/components/TaskQueuePanel.js";
import { RightPanel } from "../../web/src/components/RightPanel.js";
import { resetAppGlobals } from "../../web/src/app-globals.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { UiTaskQueue, UiTaskQueueTask } from "../../server/protocol.js";

type Props = ComponentProps<typeof TaskQueuePanel>;
type MutableBinding = { -readonly [K in keyof TaskQueueAnswerBinding]: TaskQueueAnswerBinding[K] };
const roots: Root[] = [];
const WORDS = "  Synthetic answer: keep  both spaces.  ";
const QUESTION = "Which synthetic fixture option?";
const CHOICES = ["  Synthetic first option  ", "Synthetic second option"];
const DETAIL = "## Synthetic context\n\nKeep **all** the evidence.";
const CONVERSATION = "synthetic-conversation-a";

function task(extra: Partial<UiTaskQueueTask> = {}): UiTaskQueueTask {
	return {
		id: 7,
		status: "stuck",
		addedAt: 1,
		question: QUESTION,
		choices: [...CHOICES],
		detail: DETAIL,
		plan: { title: "Synthetic task", goal: "", doneWhen: "", decided: "", steps: "", verify: "", mustNot: "" },
		...extra,
	};
}

function queue(extra: Partial<UiTaskQueue> = {}): UiTaskQueue {
	return { queueId: "synthetic-queue-a", available: true, running: false, tasks: [task()], ...extra };
}

function binding(extra: Partial<TaskQueueAnswerBinding> = {}): MutableBinding {
	return {
		conversationId: CONVERSATION,
		queueId: "synthetic-queue-a",
		taskId: 7,
		questionId: "synthetic-host-occurrence-a",
		question: QUESTION,
		choices: [...CHOICES],
		detail: DETAIL,
		...extra,
	};
}

function props(extra: Partial<Props> = {}): Props {
	return { queue: queue(), conversationId: CONVERSATION, answerBindings: [binding()], ...extra };
}

function deferred() {
	let resolve!: (value: unknown) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<unknown>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	const callback = vi.fn((_request: TaskQueueAnswerRequest) => promise as Promise<boolean>);
	return { callback, resolve, reject };
}

function mount(node: ReactNode) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	const render = (child: ReactNode) => act(() => root.render(createElement(LanguageProvider, null, child)));
	render(node);
	return { host, render };
}

function panel(extra: Partial<Props> = {}) {
	const initial = props(extra);
	const mounted = mount(createElement(TaskQueuePanel, initial));
	return {
		...mounted,
		rerender: (overrides: Partial<Props> = {}) =>
			mounted.render(createElement(TaskQueuePanel, { ...initial, ...overrides })),
	};
}

function input(host: HTMLElement): HTMLInputElement {
	const el = host.querySelector<HTMLInputElement>(".task-queue-answer-input");
	expect(el).not.toBeNull();
	return el!;
}

function type(host: HTMLElement, value: string) {
	const el = input(host);
	act(() => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
		el.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function submit(host: HTMLElement, times = 1) {
	act(() => {
		for (let i = 0; i < times; i++) {
			host
				.querySelector(".task-queue-answer-form")!
				.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		}
	});
}

function choice(host: HTMLElement, times = 1) {
	act(() => {
		for (let i = 0; i < times; i++) host.querySelector<HTMLButtonElement>(".task-queue-choice")!.click();
	});
}

function state(host: HTMLElement) {
	return host.querySelector<HTMLElement>(".task-queue-answer")?.dataset.answerState;
}

function enabled(host: HTMLElement) {
	return !host.querySelector<HTMLButtonElement>(".task-queue-answer-send")!.disabled;
}

async function settle(action: () => void) {
	await act(async () => action());
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	localStorage.clear();
	resetAppGlobals();
});

afterEach(() => {
	act(() => roots.splice(0).forEach((root) => root.unmount()));
	document.body.replaceChildren();
	resetAppGlobals();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("actual TaskQueuePanel: answer result, not dispatch", () => {
	it("keeps exact nonempty whitespace pending; only an applied result clears the unchanged revision", async () => {
		const d = deferred();
		const original = binding();
		const p = panel({ answerBindings: [original], onAnswerResult: d.callback });
		type(p.host, WORDS);
		submit(p.host, 3);
		choice(p.host, 2);
		expect(d.callback.mock.calls).toEqual([[{ binding: original, text: WORDS }]]);
		const request = d.callback.mock.calls[0][0];
		expect(Object.isFrozen(request)).toBe(true);
		expect(Object.isFrozen(request.binding)).toBe(true);
		expect(Object.isFrozen(request.binding.choices)).toBe(true);
		expect(request.binding).not.toBe(original);
		expect(input(p.host).value).toBe(WORDS);
		expect(input(p.host).disabled).toBe(false);
		expect(state(p.host)).toBe("pending");
		expect(p.host.textContent).toContain("Sending");
		expect(enabled(p.host)).toBe(false);
		// A generic refresh, transport acceptance, or the old five-second timer is not an answer result.
		p.rerender({ queue: queue({ running: true }), answerBindings: [binding()] });
		act(() => vi.advanceTimersByTime(60_000));
		expect(input(p.host).value).toBe(WORDS);
		expect(state(p.host)).toBe("pending");
		expect(d.callback).toHaveBeenCalledTimes(1);
		await settle(() => d.resolve(true));
		expect(input(p.host).value).toBe("");
		expect(state(p.host)).toBe("applied");
		expect(p.host.textContent).toContain("Done");
		type(p.host, "A later unsent draft");
		act(() => vi.advanceTimersByTime(60_000));
		submit(p.host);
		expect(input(p.host).value).toBe("A later unsent draft");
		expect(state(p.host)).toBe("applied");
		expect(d.callback).toHaveBeenCalledTimes(1);
	});

	it.each([false, undefined, null, "true", 1, { applied: true }])(
		"retains exact words for nontrue result %j, with no automatic retry",
		async (result) => {
			const d = deferred();
			const p = panel({ onAnswerResult: d.callback });
			type(p.host, WORDS);
			submit(p.host);
			await settle(() => d.resolve(result));
			expect(input(p.host).value).toBe(WORDS);
			expect(input(p.host).disabled).toBe(false);
			expect(state(p.host)).toBe("unconfirmed");
			expect(enabled(p.host)).toBe(true);
			p.rerender({ queue: queue() });
			act(() => vi.advanceTimersByTime(60_000));
			expect(input(p.host).value).toBe(WORDS);
			expect(d.callback.mock.calls).toEqual([[{ binding: binding(), text: WORDS }]]);
		},
	);

	it("retains a rejection and allows only a new explicit action to retry", async () => {
		const d = deferred();
		const p = panel({ onAnswerResult: d.callback });
		type(p.host, WORDS);
		submit(p.host);
		await settle(() => d.reject(new Error("synthetic result unavailable")));
		expect(input(p.host).value).toBe(WORDS);
		expect(state(p.host)).toBe("unconfirmed");
		expect(d.callback).toHaveBeenCalledTimes(1);
		submit(p.host, 2);
		await settle(() => {});
		expect(d.callback.mock.calls).toEqual([
			[{ binding: binding(), text: WORDS }],
			[{ binding: binding(), text: WORDS }],
		]);
		expect(input(p.host).value).toBe(WORDS);
	});

	it.each(["throw", "void", "transport-true"])(
		"cannot convert a synchronous %s callback into success",
		async (kind) => {
			const callback = vi.fn(() => {
				if (kind === "throw") throw new Error("synthetic failure");
				return kind === "transport-true" ? true : undefined;
			});
			const p = panel({ onAnswerResult: callback as unknown as TaskQueueAnswerResult });
			type(p.host, WORDS);
			submit(p.host);
			await settle(() => {});
			expect(input(p.host).value).toBe(WORDS);
			expect(state(p.host)).toBe("unconfirmed");
			expect(callback.mock.calls).toEqual([[{ binding: binding(), text: WORDS }]]);
		},
	);

	it.each(["newer", "ABA"])("an applied old answer cannot erase %s edits", async (edit) => {
		const d = deferred();
		const p = panel({ onAnswerResult: d.callback });
		type(p.host, WORDS);
		submit(p.host);
		type(p.host, "A newer synthetic draft");
		if (edit === "ABA") type(p.host, WORDS);
		await settle(() => d.resolve(true));
		expect(input(p.host).value).toBe(edit === "ABA" ? WORDS : "A newer synthetic draft");
		expect(state(p.host)).toBe("applied");
		expect(d.callback.mock.calls).toEqual([[{ binding: binding(), text: WORDS }]]);
	});

	it.each([true, false])("a choice result %j never clears a typed draft, even identical text", async (result) => {
		const d = deferred();
		const p = panel({ onAnswerResult: d.callback });
		type(p.host, CHOICES[0]);
		choice(p.host, 3);
		expect(d.callback.mock.calls).toEqual([[{ binding: binding(), text: CHOICES[0] }]]);
		expect(input(p.host).value).toBe(CHOICES[0]);
		expect(state(p.host)).toBe("pending");
		await settle(() => d.resolve(result));
		expect(input(p.host).value).toBe(CHOICES[0]);
		expect(state(p.host)).toBe(result ? "applied" : "unconfirmed");
	});

	it("does not send whitespace-only input or choices", () => {
		const d = deferred();
		const p = panel({
			queue: queue({ tasks: [task({ choices: ["   "] })] }),
			answerBindings: [binding({ choices: ["   "] })],
			onAnswerResult: d.callback,
		});
		type(p.host, "   ");
		submit(p.host);
		choice(p.host);
		expect(input(p.host).value).toBe("   ");
		expect(state(p.host)).toBe("idle");
		expect(d.callback).not.toHaveBeenCalled();
	});

	it.each([
		["absent", []],
		["empty occurrence", [binding({ questionId: "" })]],
		["missing occurrence", [binding({ questionId: undefined as unknown as string })]],
		["other conversation", [binding({ conversationId: "synthetic-other" })]],
		["other queue", [binding({ queueId: "synthetic-other" })]],
		["other task", [binding({ taskId: 8 })]],
		["other question", [binding({ question: "Other synthetic question" })]],
		["other choices", [binding({ choices: [...CHOICES].reverse() })]],
		["other detail", [binding({ detail: "Other synthetic context" })]],
		["ambiguous", [binding(), binding()]],
	] as const)("%s host binding cannot dispatch, including via legacy fallback", (_name, bindings) => {
		const legacy = vi.fn();
		const d = deferred();
		const p = panel({ onAnswer: legacy, answerBindings: bindings, onAnswerResult: d.callback });
		type(p.host, WORDS);
		submit(p.host);
		choice(p.host);
		expect(input(p.host).value).toBe(WORDS);
		expect(input(p.host).disabled).toBe(false);
		expect(state(p.host)).toBe("idle");
		expect(enabled(p.host)).toBe(false);
		expect(d.callback).not.toHaveBeenCalled();
		expect(legacy).not.toHaveBeenCalled();
	});

	it.each(["conversation", "queue"])("missing %s target cannot dispatch", (missing) => {
		const d = deferred();
		const p = panel({
			conversationId: missing === "conversation" ? undefined : CONVERSATION,
			queue: queue({ queueId: missing === "queue" ? undefined : "synthetic-queue-a" }),
			onAnswerResult: d.callback,
		});
		type(p.host, WORDS);
		submit(p.host);
		expect(input(p.host).value).toBe(WORDS);
		expect(enabled(p.host)).toBe(false);
		expect(d.callback).not.toHaveBeenCalled();
	});

	it("missing result support cannot use a legacy void callback", () => {
		const legacy = vi.fn();
		const p = panel({ onAnswer: legacy });
		type(p.host, WORDS);
		submit(p.host);
		choice(p.host);
		expect(input(p.host).value).toBe(WORDS);
		expect(enabled(p.host)).toBe(false);
		expect(legacy).not.toHaveBeenCalled();
	});

	it.each(["conversation", "queue", "task", "occurrence", "question", "choices", "detail"])(
		"a late result cannot clean a changed %s lifetime",
		async (change) => {
			const old = deferred();
			const next = deferred();
			const p = panel({ onAnswerResult: old.callback });
			type(p.host, WORDS);
			submit(p.host);
			const q = queue();
			const b = binding();
			let conversationId = CONVERSATION;
			if (change === "conversation") conversationId = b.conversationId = "synthetic-conversation-b";
			if (change === "queue") q.queueId = b.queueId = "synthetic-queue-b";
			if (change === "task") q.tasks[0].id = b.taskId = 8;
			if (change === "occurrence") b.questionId = "synthetic-host-occurrence-b"; // same text/choices/time
			if (change === "question") q.tasks[0].question = b.question = "A different synthetic question";
			if (change === "choices") q.tasks[0].choices = [...(b.choices = [...CHOICES].reverse())];
			if (change === "detail") q.tasks[0].detail = b.detail = "New synthetic context";
			p.rerender({ queue: q, conversationId, answerBindings: [b], onAnswerResult: next.callback });
			type(p.host, "Current synthetic editor");
			submit(p.host);
			expect(next.callback.mock.calls).toEqual([[{ binding: b, text: "Current synthetic editor" }]]);
			await settle(() => old.resolve(true));
			expect(input(p.host).value).toBe("Current synthetic editor");
			expect(state(p.host)).toBe("pending");
			await settle(() => next.resolve(false));
			expect(input(p.host).value).toBe("Current synthetic editor");
			expect(state(p.host)).toBe("unconfirmed");
			expect(old.callback.mock.calls).toEqual([[{ binding: binding(), text: WORDS }]]);
		},
	);

	it("A→B→A question binding does not revive an old cleanup token", async () => {
		const d = deferred();
		const p = panel({ onAnswerResult: d.callback });
		type(p.host, WORDS);
		submit(p.host);
		p.rerender({ answerBindings: [binding({ questionId: "synthetic-host-occurrence-b" })] });
		p.rerender();
		type(p.host, WORDS);
		await settle(() => d.resolve(true));
		expect(input(p.host).value).toBe(WORDS);
		expect(state(p.host)).toBe("idle");
	});

	it.each(["close", "task-pause", "queue-pause", "unavailable", "question-closed"])(
		"%s then reopen/unmount rejects an old result",
		async (kind) => {
			const d = deferred();
			const p = panel({ onAnswerResult: d.callback });
			type(p.host, WORDS);
			submit(p.host);
			if (kind === "close") p.render(null);
			else if (kind === "task-pause")
				p.rerender({ queue: queue({ tasks: [task({ hold: { at: 2, why: "Synthetic owner pause" } })] }) });
			else if (kind === "queue-pause") p.rerender({ queue: queue({ hold: { at: 2, why: "Synthetic owner pause" } }) });
			else if (kind === "unavailable") p.rerender({ queue: queue({ available: false }) });
			else p.rerender({ queue: queue({ tasks: [task({ status: "working" })] }) });
			expect(p.host.querySelector(".task-queue-answer-input")).toBeNull();
			p.rerender();
			type(p.host, "Reopened synthetic draft");
			await settle(() => d.resolve(true));
			expect(input(p.host).value).toBe("Reopened synthetic draft");
			expect(state(p.host)).toBe("idle");
			expect(d.callback).toHaveBeenCalledTimes(1);
		},
	);

	it("copies binding before dispatch; later mutation cannot retarget the submitted answer", async () => {
		const d = deferred();
		const b = binding({ choices: [...CHOICES] });
		const p = panel({ answerBindings: [b], onAnswerResult: d.callback });
		type(p.host, WORDS);
		submit(p.host);
		b.conversationId = "synthetic-mutated";
		(b.choices as string[])[0] = "Synthetic mutated choice";
		expect(d.callback.mock.calls).toEqual([[{ binding: binding(), text: WORDS }]]);
		await settle(() => d.resolve(false));
		expect(input(p.host).value).toBe(WORDS);
	});
});

function rightProps(extra: Partial<ComponentProps<typeof RightPanel>> = {}): ComponentProps<typeof RightPanel> {
	return {
		files: null,
		filesReady: false,
		fileChanged: null,
		widgets: [],
		statuses: [],
		panelSend: vi.fn(() => true),
		onAttach: vi.fn(),
		onPreview: vi.fn(),
		onNotice: vi.fn(),
		tldrConversationId: CONVERSATION,
		taskQueue: queue(),
		taskQueueAnswerBindings: [binding()],
		...extra,
	};
}

describe("actual RightPanel plumbing", () => {
	it("passes genuine immutable result requests without panelSend; transport true cannot clear anything", async () => {
		localStorage.setItem("pi-web-ui:rightpanel:tab", "queue");
		const d = deferred();
		const settings = rightProps({ onTaskQueueAnswerResult: d.callback });
		const p = mount(createElement(RightPanel, settings));
		type(p.host, WORDS);
		submit(p.host);
		expect(d.callback.mock.calls).toEqual([[{ binding: binding(), text: WORDS }]]);
		expect(settings.panelSend).not.toHaveBeenCalled();
		expect(state(p.host)).toBe("pending");
		expect(input(p.host).value).toBe(WORDS);
		p.render(createElement(RightPanel, { ...settings, taskQueue: queue({ running: true }) }));
		expect(state(p.host)).toBe("pending");
		await settle(() => d.resolve(false));
		expect(input(p.host).value).toBe(WORDS);
		expect(state(p.host)).toBe("unconfirmed");
		expect(settings.panelSend).not.toHaveBeenCalled();
	});

	it("without host result support never sends a legacy task_queue_answer", () => {
		localStorage.setItem("pi-web-ui:rightpanel:tab", "queue");
		const settings = rightProps();
		const p = mount(createElement(RightPanel, settings));
		type(p.host, WORDS);
		submit(p.host);
		choice(p.host);
		expect(input(p.host).value).toBe(WORDS);
		expect(settings.panelSend).not.toHaveBeenCalled();
	});

	it("switching tabs cannot let an old result clean the reopened editor", async () => {
		localStorage.setItem("pi-web-ui:rightpanel:tab", "queue");
		const d = deferred();
		const p = mount(createElement(RightPanel, rightProps({ onTaskQueueAnswerResult: d.callback })));
		type(p.host, WORDS);
		submit(p.host);
		const tabs = [...p.host.querySelectorAll<HTMLButtonElement>("[role=tab]")];
		act(() => tabs[0].click());
		expect(p.host.querySelector(".task-queue-answer-input")).toBeNull();
		act(() => tabs.find((el) => el.textContent === "Queue")!.click());
		type(p.host, "New tab lifetime draft");
		await settle(() => d.resolve(true));
		expect(input(p.host).value).toBe("New tab lifetime draft");
		expect(state(p.host)).toBe("idle");
	});

	it("preserves synchronous queue controls and removal confirmation", () => {
		localStorage.setItem("pi-web-ui:rightpanel:tab", "queue");
		const settings = rightProps({ taskQueue: queue({ tasks: [task(), task({ id: 8, status: "ready" })] }) });
		const p = mount(createElement(RightPanel, settings));
		expect(p.host.textContent).toContain("Keep all the evidence.");
		expect(p.host.querySelector(".task-queue-question-detail[open]")).not.toBeNull();
		act(() => p.host.querySelector<HTMLButtonElement>(".task-queue-remove")!.click());
		expect(settings.panelSend).not.toHaveBeenCalled();
		act(() => p.host.querySelector<HTMLButtonElement>(".task-queue-remove-no")!.click());
		expect(settings.panelSend).not.toHaveBeenCalled();
		act(() => p.host.querySelector<HTMLButtonElement>(".task-queue-remove")!.click());
		act(() => p.host.querySelector<HTMLButtonElement>(".task-queue-remove-yes")!.click());
		expect(settings.panelSend).toHaveBeenCalledWith({
			type: "task_queue_command",
			action: "remove",
			id: 8,
			conversationId: CONVERSATION,
		});
		expect(input(p.host).disabled).toBe(false);
	});
});
