// @vitest-environment jsdom
// roles-answer: the mounted dialog and transport. Synthetic forms, no chat or model activity.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAppGlobals, setAppSend } from "../../web/src/app-globals.js";
import { RoleAnswerDialog } from "../../web/src/components/RoleAnswerDialog.js";
import { RoleSpend } from "../../web/src/components/RoleSpend.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import {
	answerRoleAsk,
	disconnectRoleAnswers,
	openRoleAsk,
	receiveRoleAnswer,
} from "../../web/src/roles-answer-state.js";
import { projectSpend, type NeedsYouItem } from "../../web/src/roles-useful-model.js";
import type { ClientMessage, UiRoleAskView } from "../../web/src/types.js";

const item: NeedsYouItem = {
	key: "0",
	roleId: "fixture",
	roleLabel: "Fixture role",
	text: "Question",
	since: 100,
	link: { file: "/private/fixture.jsonl" },
	answer: { key: "fixture:question:q1", id: "q1" },
};
const view: UiRoleAskView = {
	id: "q1",
	revision: "a".repeat(64),
	kind: "question",
	title: "Full question",
	body: "Complete cost and limits <img src=x onerror=alert(1)>",
	fields: [
		{
			id: "pick",
			text: "Which one?",
			detail: "Full explanation",
			options: [
				{ value: "alpha", label: "Alpha", description: "Costs $2", preview: "<b>plain preview</b>" },
				{ value: "beta", label: "Beta" },
			],
			multi: false,
			allowText: true,
		},
	],
};
let root: Root | null;
let host: HTMLDivElement;
let sent: ClientMessage[];
const onClose = vi.fn();
const onOpen = vi.fn();
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	resetAppGlobals();
	sent = [];
	onClose.mockClear();
	onOpen.mockClear();
	setAppSend((message) => {
		sent.push(message);
		return true;
	});
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => {
		root?.unmount();
		disconnectRoleAnswers();
	});
	root = null;
	host.remove();
	setAppSend(null);
	resetAppGlobals();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
function mount(connected = true) {
	act(() =>
		root!.render(
			createElement(LanguageProvider, null, createElement(RoleAnswerDialog, { item, connected, onClose, onOpen })),
		),
	);
}
const answers = () => sent.filter((s) => s.type === "roles_ask_answer");
const sendButton = () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Send answer")!;
async function ready() {
	mount();
	const req = sent.find((s) => s.type === "roles_ask_open");
	if (!req || req.type !== "roles_ask_open") throw new Error("no open request");
	await act(async () => receiveRoleAnswer({ type: "roles_ask", reqId: req.reqId, ok: true, ask: view }));
}

describe("the mounted answer form", () => {
	it("shows all text safely, has no default answer, and never puts the chat path in the DOM", async () => {
		await ready();
		for (const text of [view.body!, "Full explanation", "Costs $2", "<b>plain preview</b>"])
			expect(host.textContent).toContain(text);
		expect(host.querySelector("img,b")).toBeNull();
		expect(host.innerHTML).not.toContain("/private/");
		expect(host.querySelector("input:checked")).toBeNull();
		expect(sendButton().disabled).toBe(true);
		expect(answers()).toHaveLength(0);
	});
	it("sends one explicit selection once, and reports success only after acknowledgement", async () => {
		await ready();
		act(() => (host.querySelector("input") as HTMLInputElement).click());
		expect(sendButton().disabled).toBe(false);
		act(() => {
			sendButton().click();
			sendButton().click();
		});
		expect(answers()).toHaveLength(1);
		expect(host.textContent).toContain("Sending your answer");
		const req = answers()[0];
		if (req.type !== "roles_ask_answer") throw new Error("no answer request");
		expect(req.answers).toEqual([{ id: "pick", selected: ["alpha"] }]);
		await act(async () => receiveRoleAnswer({ type: "roles_ask_result", reqId: req.reqId, ok: true }));
		expect(host.textContent).toContain("Answer sent.");
	});
	it("Escape closes without sending or cancelling the underlying question", async () => {
		await ready();
		act(() => host.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })));
		expect(onClose).toHaveBeenCalledWith(true);
		expect(answers()).toHaveLength(0);
		expect(sent).toHaveLength(1);
	});
	it("disconnect while sending says uncertain and reconnect never retries", async () => {
		await ready();
		act(() => (host.querySelector("input") as HTMLInputElement).click());
		act(() => sendButton().click());
		mount(false);
		expect(host.textContent).toContain("Your answer may have arrived");
		mount(true);
		expect(answers()).toHaveLength(1);
		expect(sendButton().disabled).toBe(true);
	});
	it("an error does not reveal server text or enable a blind retry", async () => {
		await ready();
		act(() => (host.querySelector("input") as HTMLInputElement).click());
		act(() => sendButton().click());
		const req = answers()[0];
		if (req.type !== "roles_ask_answer") throw new Error("no answer request");
		await act(async () =>
			receiveRoleAnswer({
				type: "roles_ask_result",
				reqId: req.reqId,
				ok: false,
				error: "secret /private/oops.jsonl <img>",
			}),
		);
		expect(host.textContent).toContain("could not be checked");
		expect(host.textContent).not.toContain("oops");
		expect(sendButton().disabled).toBe(true);
	});
});

describe("request correlation and no replay", () => {
	it("ignores a reply for another request or another operation", async () => {
		const p = openRoleAsk("key");
		const req = sent[0];
		if (req.type !== "roles_ask_open") throw new Error("no request");
		let finished = false;
		void p.then(() => {
			finished = true;
		});
		receiveRoleAnswer({ type: "roles_ask", reqId: "other", ok: true, ask: view });
		receiveRoleAnswer({ type: "roles_ask_result", reqId: req.reqId, ok: true });
		await Promise.resolve();
		expect(finished).toBe(false);
		receiveRoleAnswer({ type: "roles_ask", reqId: req.reqId, ok: true, ask: view });
		expect((await p).ask).toEqual(view);
	});
	it("lost and timed-out writes are uncertain, not retried", async () => {
		vi.useFakeTimers();
		const first = answerRoleAsk("key", "id", view.revision, [], 50);
		disconnectRoleAnswers();
		expect((await first).error).toBe("uncertain");
		const second = answerRoleAsk("key", "id", view.revision, [], 50);
		await vi.advanceTimersByTimeAsync(51);
		expect((await second).error).toBe("uncertain");
		expect(answers()).toHaveLength(2);
	});
});

describe("own-work spending", () => {
	it("shows the role's reported numbers and qualifies them, not an invented zero", () => {
		const spend = projectSpend({
			state: "over",
			line: "Over its weekly budget",
			spent: "$2,010.00",
			budget: "$2,000.00",
			byInitiative: [{ id: "fixture", amount: "$2,010.00" }],
		});
		act(() => root!.render(createElement(LanguageProvider, null, createElement(RoleSpend, { spend, details: true }))));
		expect(host.textContent).toContain("$2,010.00 / $2,000.00");
		expect(host.textContent).toContain("not an independent meter");
		act(() => root!.render(createElement(LanguageProvider, null, createElement(RoleSpend, { spend: null }))));
		expect(host.textContent).toContain("No readable spend");
		expect(host.textContent).not.toContain("$0");
	});
	it("rejects incomplete numbers, unsafe strings and oversized lines", () => {
		for (const row of [
			{ state: "ok", line: "Fine" },
			{ state: "none", line: "/private/a.jsonl" },
			{ state: "none", line: "x".repeat(421) },
		])
			expect(projectSpend(row)).toBeNull();
	});
});
