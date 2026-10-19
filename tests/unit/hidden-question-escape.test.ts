// @vitest-environment jsdom
/**
 * escape-hidden-question, H-ESCAPE-HIDDEN-QUESTION-1 (docs/escape-hidden-question.md): Escape answers a chat's
 * waiting ask only while that chat is on screen. The app hands Escape to the newest handler on its stack
 * (web/src/shortcut-stack.ts). The chat pane stays mounted, hidden, behind Roles, Initiatives, Schedules and the other
 * tabs, and its asks (the model's question, another chat's question answered here, an extension's select, confirm or
 * input) took Escape there too: Escape on a covering tab cancelled a question the owner never saw (#225's live look,
 * Oct 18). App now tells each ask whether the chat view is showing; off screen an ask passes Escape on but keeps its
 * place on the stack, so in the chat view Escape goes where it went before.
 *
 * The panes below are App's (web/src/App.tsx), cut down to the chat pane and the tabs that cover it; the last test
 * holds App to the same wiring.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement, Fragment } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";

// The Initiatives page as #225's Escape test mounts it (tests/unit/initiatives-page-escape.test.ts): its frame is
// #224's and its feeds come from the fixture. No page dialog is opened here.
vi.mock("../../web/src/components/InitiativesExactView.js", () => ({ InitiativesExactView: () => null }));
vi.mock("../../web/src/work-page-state.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../../web/src/work-page-state.js")>();
	const { PAGE } = await import("./initiatives-page-fixture.js");
	const feed = { page: PAGE, status: "ready" as const };
	return { ...real, useWorkPage: () => feed, reloadWorkPage: () => {} };
});
vi.mock("../../web/src/initiatives-state.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../../web/src/initiatives-state.js")>();
	const { DECISIONS } = await import("./initiatives-page-fixture.js");
	const state = { page: DECISIONS, status: "ready" as const };
	return { ...real, useInitiatives: () => state, reloadInitiatives: () => {}, selectInitiative: () => {} };
});
vi.mock("../../web/src/identity-state.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../../web/src/identity-state.js")>();
	const list = { identities: [] };
	return { ...real, useIdentityList: () => list };
});

import { Dialog } from "../../web/src/components/Dialog.js";
import { DshQuestionDialog } from "../../web/src/components/DshQuestionDialog.js";
import { InitiativesPage } from "../../web/src/components/InitiativesPage.js";
import { Modal } from "../../web/src/components/Modal.js";
import { setAppSend } from "../../web/src/app-globals.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { loadMarkdownExtras } from "../../web/src/components/Markdown.js";
import { resetEscapeStack } from "../../web/src/shortcut-stack.js";

type View = "chat" | "roles" | "initiatives" | "plugin:scheduler" | "terminal";
type Ask = "the model's question" | "another chat's question" | "an extension's ask";

const QUESTION = {
	id: "q-wait",
	questions: [{ id: "c1", question: "Which one?", options: [{ label: "A" }, { label: "B" }] }],
};
const OTHER_CHAT = "/home/owner/.pi/agent/sessions/other.jsonl";
const EXTENSION_ASK = { id: 7, kind: "confirm" as const, title: "Approve the plan?", args: ["Run it?"] };
/** What Escape sends for each ask in the chat view, as it always has. */
const CANCEL: Record<Ask, object> = {
	"the model's question": { type: "question_answer", id: "q-wait", answers: [], cancelled: true },
	"another chat's question": { type: "question_answer", id: "q-wait", answers: [], cancelled: true, owner: OTHER_CHAT },
	"an extension's ask": { type: "dialog_response", id: 7, value: null },
};
const ASKS = Object.keys(CANCEL) as Ask[];
/** Tabs that cover the chat: Roles, Initiatives (no page dialog open), Schedules (the scheduler plugin), Terminal. */
const COVERING: View[] = ["roles", "initiatives", "plugin:scheduler", "terminal"];

let root: Root | null = null;
let sent: object[] = [];
let closed: string[] = [];

/** App's panes, cut down: the chat pane with one waiting ask, the panes that cover it, and a modal over them all. */
function Panes({ view, ask, modal }: { view: View; ask: Ask; modal: boolean }) {
	const chatOn = view === "chat";
	return createElement(
		Fragment,
		null,
		createElement(
			"div",
			{ className: `view-pane ${chatOn ? "" : "hidden"}` },
			ask === "an extension's ask" && createElement(Dialog, { dialog: EXTENSION_ASK, escapeEnabled: chatOn }),
			ask === "the model's question" && createElement(DshQuestionDialog, { question: QUESTION, escapeEnabled: chatOn }),
			ask === "another chat's question" &&
				createElement(DshQuestionDialog, { question: QUESTION, owner: OTHER_CHAT, escapeEnabled: chatOn }),
		),
		createElement("div", { className: `view-pane roles-pane ${view === "roles" ? "" : "hidden"}` }),
		createElement(
			"div",
			{ className: `view-pane initiatives-pane ${view === "initiatives" ? "" : "hidden"}` },
			createElement(InitiativesPage, { active: view === "initiatives", onOpen: () => {} }),
		),
		createElement(Modal, { open: modal, onClose: () => closed.push("modal"), title: "Settings", children: "Roles" }),
	);
}

beforeAll(async () => {
	await loadMarkdownExtras();
});
afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	sent = [];
	closed = [];
	setAppSend(null);
	resetEscapeStack();
});

/** Shows the panes as App does for this view; the first call mounts them, later calls only change the view. */
function show(view: View, ask: Ask, modal = false): void {
	if (!root) {
		setAppSend((message) => {
			sent.push(message as object);
			return true;
		});
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	}
	const mounted = root;
	act(() => mounted.render(createElement(LanguageProvider, null, createElement(Panes, { view, ask, modal }))));
}

/** Escape as the browser sends it with nothing focused in a dialog: at the body. True when something took it. */
function pressEscape(): boolean {
	const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
	act(() => {
		document.body.dispatchEvent(event);
	});
	return event.defaultPrevented;
}

describe("escape-hidden-question: Escape answers a chat's ask only while the chat is on screen", () => {
	describe.each(ASKS)("%s", (ask) => {
		it.each(COVERING)("on %s, which covers the chat, Escape leaves it waiting and goes on to the page", (view) => {
			show(view, ask);
			expect(pressEscape()).toBe(false);
			expect(sent).toEqual([]);
		});

		it("in the chat view, Escape cancels it as before", () => {
			show("chat", ask);
			expect(pressEscape()).toBe(true);
			expect(sent).toEqual([CANCEL[ask]]);
		});

		it("back in the chat view after another tab, Escape cancels it again", () => {
			show("chat", ask);
			show("roles", ask);
			expect(pressEscape()).toBe(false);
			show("chat", ask);
			expect(pressEscape()).toBe(true);
			expect(sent).toEqual([CANCEL[ask]]);
		});

		it("a modal opened on another tab still takes Escape first when the chat comes back behind it", () => {
			show("roles", ask);
			show("roles", ask, true);
			show("chat", ask, true);
			expect(pressEscape()).toBe(true);
			expect(closed).toEqual(["modal"]);
			expect(sent).toEqual([]);
			show("chat", ask);
			expect(pressEscape()).toBe(true);
			expect(sent).toEqual([CANCEL[ask]]);
		});
	});

	it("App tells every chat ask it mounts whether the chat view is showing, by the test that hides the chat pane", () => {
		const app = readFileSync(resolve(process.cwd(), "web/src/App.tsx"), "utf8");
		expect(app).toContain('<div className={`view-pane ${view === "chat" ? "" : "hidden"}`}>');
		const mounts = [...app.matchAll(/<(Dialog|DshQuestionDialog)\b/g)].map((found) => {
			const at = found.index ?? -1;
			return app.slice(at, app.indexOf("/>", at));
		});
		expect(mounts.map((mount) => mount.split(/\s/)[0])).toEqual([
			"<Dialog",
			"<DshQuestionDialog",
			"<DshQuestionDialog",
		]);
		for (const mount of mounts) expect(mount).toContain('escapeEnabled={view === "chat"}');
	});
});
