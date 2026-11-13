// @vitest-environment jsdom
/**
 * frontend #286: the Queue tab's answer card never fails silently. An answer that didn't go through
 * shows why, in plain words, with "Try again"; the typed words stay. A card that can't take an answer
 * says so and points to the chat, instead of showing dead buttons.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StuckAnswer } from "../../web/src/components/TaskQueueAnswer.js";
import type {
	TaskQueueAnswerBinding,
	TaskQueueAnswerOutcome,
	TaskQueueAnswerRequest,
} from "../../web/src/components/TaskQueueLines.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { UiTaskQueueTask } from "../../server/protocol.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const task = {
	id: 305,
	status: "stuck",
	lane: true,
	plan: { title: "Blind bake-off" },
	question: "Which of the four first drafts?",
	choices: ["W", "X", "Y", "Z"],
	detail: "The whole picture",
	createdAt: 1,
} as unknown as UiTaskQueueTask;
const binding: TaskQueueAnswerBinding = {
	conversationId: "c-design",
	queueId: "q-design",
	taskId: 305,
	questionId: "stuck-305",
	question: "Which of the four first drafts?",
	choices: ["W", "X", "Y", "Z"],
	detail: "The whole picture",
};

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

const render = (props: Partial<Parameters<typeof StuckAnswer>[0]>) =>
	act(() =>
		root.render(
			createElement(
				LanguageProvider,
				null,
				createElement(StuckAnswer, { task, conversationId: "c-design", queueId: "q-design", ...props }),
			),
		),
	);
const $ = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T>(sel);
const choice = (label: string) =>
	[...container.querySelectorAll<HTMLButtonElement>(".task-queue-choice")].find((b) => b.textContent === label)!;
const card = () => $(".task-queue-answer")!;
const settle = () => act(async () => {});

function typeInto(value: string) {
	const input = $<HTMLInputElement>(".task-queue-answer-input")!;
	act(() => {
		const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
		set.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("Queue tab answer card (frontend #286)", () => {
	it("no reply: shows why and a Try again that sends the same choice again on tap (never by itself)", async () => {
		const results: TaskQueueAnswerOutcome[] = [{ applied: false, why: "no-reply" }, true];
		const onAnswerResult = vi.fn((_: TaskQueueAnswerRequest) => Promise.resolve(results.shift()!));
		render({ binding, onAnswerResult });
		act(() => choice("Z").click());
		await settle();
		expect(card().dataset.answerState).toBe("error");
		expect(card().dataset.answerError).toBe("no-reply");
		expect($('[role="alert"]')!.textContent).toContain("No reply from the server");
		// Not stuck on "Sending…": the choices are usable again.
		expect(choice("Z").disabled).toBe(false);
		expect(onAnswerResult).toHaveBeenCalledTimes(1);
		const retry = $<HTMLButtonElement>(".task-queue-answer-retry")!;
		expect(retry.disabled).toBe(false);
		act(() => retry.click());
		await settle();
		expect(onAnswerResult).toHaveBeenCalledTimes(2);
		expect(onAnswerResult.mock.calls[1][0].text).toBe("Z");
		expect(card().dataset.answerState).toBe("applied");
		expect($('[role="alert"]')).toBeNull();
	});

	it("refused: names the server's reason; the typed words stay and Try again resends them", async () => {
		const results: TaskQueueAnswerOutcome[] = [
			{ applied: false, why: "refused", reason: "an answer is already on its way" },
			true,
		];
		const onAnswerResult = vi.fn((_: TaskQueueAnswerRequest) => Promise.resolve(results.shift()!));
		render({ binding, onAnswerResult });
		typeInto("Z, but tighten the header");
		act(() => $<HTMLButtonElement>(".task-queue-answer-send")!.click());
		await settle();
		expect($('[role="alert"]')!.textContent).toBe(
			"Your answer didn't go through: an answer is already on its way.Try again",
		);
		expect($<HTMLInputElement>(".task-queue-answer-input")!.value).toBe("Z, but tighten the header");
		act(() => $<HTMLButtonElement>(".task-queue-answer-retry")!.click());
		await settle();
		expect(onAnswerResult.mock.calls.map((c) => c[0].text)).toEqual([
			"Z, but tighten the header",
			"Z, but tighten the header",
		]);
		expect($<HTMLInputElement>(".task-queue-answer-input")!.value).toBe("");
	});

	it("a bare false or a thrown error still shows an error with Try again", async () => {
		render({ binding, onAnswerResult: () => Promise.resolve(false) });
		act(() => choice("W").click());
		await settle();
		expect($('[role="alert"]')!.textContent).toContain("Your answer didn't go through.");
		render({ binding, onAnswerResult: () => Promise.reject(new Error("boom")), queueId: "q-2" });
		act(() => choice("W").click());
		await settle();
		expect(card().dataset.answerState).toBe("error");
	});

	it("binding missing or mismatched: says it can't take an answer here and points to the chat", () => {
		render({ binding: undefined, onAnswerResult: () => Promise.resolve(true) });
		expect(card().dataset.answerUnavailable).toBe("true");
		expect(card().textContent).toContain("can't take an answer right now. Answer in the task's own chat.");
		expect(choice("Z").disabled).toBe(true);
		expect(choice("Z").title).toContain("Answer in the task's own chat");
	});
});
