// @vitest-environment jsdom
// NB-7, the dialog side (Ops #1087, Shine m104353: "lets make it so questions can be kept for later"; the server side
// is in tests/unit/nonblocking-ask-question.test.ts). Later, ✕ and Esc keep the question for later (question_later,
// nothing cancelled); only the footer's explicit "Cancel question" cancels it. A question kept for later shows, in its
// own chat, a one-line bar that reopens it with one click and leaves the chat free.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { ChatOwnerQuestion, DshQuestionDialog } from "../../web/src/components/DshQuestionDialog.js";
import { setAppSend } from "../../web/src/app-globals.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { loadMarkdownExtras } from "../../web/src/components/Markdown.js";
import { resetEscapeStack } from "../../web/src/shortcut-stack.js";
import { questionAfterSend } from "../../web/src/pending-question.js";

beforeAll(() => loadMarkdownExtras());

const PORT = {
	id: "q-1",
	conversationId: "conv-coo",
	questions: [{ id: "port", header: "Port", question: "Which port?", options: [{ label: "8080" }, { label: "9090" }] }],
};
const DNS = {
	id: "q-2",
	conversationId: "conv-coo",
	questions: [{ id: "dns", question: "Create the address?", options: [{ label: "Yes" }, { label: "No" }] }],
};
const LATER = (id: string) => ({ type: "question_later" as const, id, later: true });

let root: Root | null = null;
let sent: unknown[] = [];

function render(el: ReturnType<typeof createElement>) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	sent = [];
	setAppSend((msg) => {
		sent.push(msg);
		return true;
	});
	act(() => root!.render(createElement(LanguageProvider, null, el)));
	return container;
}
function click(el: Element | null | undefined) {
	if (!el) throw new Error("no such element");
	act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}
const buttonNamed = (c: HTMLElement, name: string) =>
	[...c.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);

afterEach(() => {
	setAppSend(null);
	if (root) act(() => root!.unmount());
	root = null;
	resetEscapeStack();
	document.body.innerHTML = "";
});

describe("NB-7: Later, ✕ and Esc keep it for later; Cancel question cancels", () => {
	it("Later keeps it for later and cancels nothing", () => {
		const c = render(createElement(DshQuestionDialog, { question: PORT }));
		click(buttonNamed(c, "Later"));
		expect(sent).toEqual([LATER("q-1")]);
	});

	it("✕ keeps it for later", () => {
		const c = render(createElement(DshQuestionDialog, { question: PORT }));
		click(c.querySelector(".dialog-head .dialog-dismiss"));
		expect(sent).toEqual([LATER("q-1")]);
	});

	it("Esc keeps it for later", () => {
		render(createElement(DshQuestionDialog, { question: PORT }));
		act(() => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		expect(sent).toEqual([LATER("q-1")]);
	});

	it("only the explicit Cancel question button cancels it", () => {
		const c = render(createElement(DshQuestionDialog, { question: PORT }));
		const cancel = buttonNamed(c, "Cancel question");
		expect(cancel).toBeDefined();
		expect(cancel).not.toBe(buttonNamed(c, "Later"));
		click(cancel);
		expect(sent).toEqual([{ type: "question_answer", id: "q-1", answers: [], cancelled: true }]);
	});

	it("keeping it for later hides the open pop-up in this window at once", () => {
		const shown = { ...PORT, source: "live" as const };
		expect(questionAfterSend(shown, LATER("q-1"))).toBeNull();
		expect(questionAfterSend(shown, LATER("q-other"))).toBe(shown);
		expect(questionAfterSend(shown, { type: "question_later", id: "q-1", later: false })).toBe(shown);
	});
});

describe("NB-7: the saved-for-later bar in its own chat", () => {
	const bar = (c: HTMLElement) => c.querySelector(".question-later-bar");
	const open = (c: HTMLElement) => c.querySelector(".dialog-inline");

	it("one line with the question's title and Answer, no dialog; Answer opens it right there", () => {
		const c = render(createElement(ChatOwnerQuestion, { question: null, savedQuestions: [PORT], waitingOn: null }));
		expect(bar(c)?.textContent).toContain("Question saved for later");
		expect(bar(c)?.textContent).toContain("Port");
		expect(open(c)).toBeNull();
		click(buttonNamed(c, "Answer"));
		expect(open(c)).not.toBeNull();
		expect(bar(c)).toBeNull();
		expect(sent).toEqual([]); // opening it here tells no other window
	});

	it("Later puts it back in the bar; answering it closes it", () => {
		const c = render(createElement(ChatOwnerQuestion, { question: null, savedQuestions: [PORT], waitingOn: null }));
		click(buttonNamed(c, "Answer"));
		click(buttonNamed(c, "Later"));
		expect(open(c)).toBeNull();
		expect(bar(c)).not.toBeNull();
		click(buttonNamed(c, "Answer"));
		click([...c.querySelectorAll(".question-option")].find((b) => b.textContent?.includes("8080"))); // one pick: sent
		expect(sent.at(-1)).toMatchObject({ type: "question_answer", id: "q-1", answers: [{ id: "port" }] });
		expect(open(c)).toBeNull();
		expect(bar(c)).toBeNull(); // answered here: no longer offered while the snapshot catches up
	});

	it("several: shows how many and steps to the next one", () => {
		const c = render(
			createElement(ChatOwnerQuestion, { question: null, savedQuestions: [PORT, DNS], waitingOn: null }),
		);
		expect(bar(c)?.textContent).toContain("1/2");
		expect(bar(c)?.textContent).toContain("Port");
		click(c.querySelector(".question-later-next"));
		expect(bar(c)?.textContent).toContain("2/2");
		expect(bar(c)?.textContent).toContain("Create the address?");
		click(buttonNamed(c, "Answer"));
		expect(c.querySelector(".question-head")?.textContent).toContain("Create the address?");
	});

	it("a question popping up takes the place of the bar", () => {
		const c = render(createElement(ChatOwnerQuestion, { question: DNS, savedQuestions: [PORT], waitingOn: null }));
		expect(bar(c)).toBeNull();
		expect(c.querySelector(".question-head")?.textContent).toContain("Create the address?");
	});
});
