// @vitest-environment jsdom
/**
 * initiatives-page-exact, H-INITIATIVES-ESCAPE-1 (docs/initiatives-page-exact.md): Escape closes the Initiatives
 * page's own dialogs first. The app hands Escape to the newest handler on its stack (web/src/shortcut-stack.ts);
 * the chat pane's question dialog is on it even while the pane is hidden behind the tab. Without the page's own
 * handler, Escape kept the Change lead dialog open and cancelled that chat's waiting question (live look, Oct 18).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import type { InitiativesExactViewProps } from "../../web/src/components/InitiativesExactView.js";
import type { InitiativesExactTarget } from "../../web/src/initiatives-exact-model.js";

const view = vi.hoisted(() => ({ props: undefined as InitiativesExactViewProps | undefined }));

// The frame itself is #224's (tested in initiatives-exact.test.ts); here only its callbacks matter.
vi.mock("../../web/src/components/InitiativesExactView.js", () => ({
	InitiativesExactView: (props: InitiativesExactViewProps) => {
		view.props = props;
		return null;
	},
}));
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

import { DshQuestionDialog } from "../../web/src/components/DshQuestionDialog.js";
import { InitiativesPage } from "../../web/src/components/InitiativesPage.js";
import { setAppSend } from "../../web/src/app-globals.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { loadMarkdownExtras } from "../../web/src/components/Markdown.js";
import { buildInitiativesPage } from "../../web/src/initiatives-page/model.js";
import { resetEscapeStack } from "../../web/src/shortcut-stack.js";
import { pageArgs } from "./initiatives-page-fixture.js";

// jsdom has no showModal or close: open and close by the attribute, close firing "close" as a browser does.
const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
const had = { showModal: proto.showModal, close: proto.close };
beforeAll(async () => {
	await loadMarkdownExtras();
	Object.defineProperty(proto, "showModal", {
		configurable: true,
		writable: true,
		value(this: HTMLDialogElement) {
			this.setAttribute("open", "");
		},
	});
	Object.defineProperty(proto, "close", {
		configurable: true,
		writable: true,
		value(this: HTMLDialogElement) {
			if (!this.hasAttribute("open")) return;
			this.removeAttribute("open");
			this.dispatchEvent(new Event("close"));
		},
	});
});
afterAll(() => {
	Object.defineProperty(proto, "showModal", { configurable: true, writable: true, value: had.showModal });
	Object.defineProperty(proto, "close", { configurable: true, writable: true, value: had.close });
});

const roots: Root[] = [];
afterEach(() => {
	act(() => {
		for (const r of roots.splice(0)) r.unmount();
	});
	document.body.innerHTML = "";
	view.props = undefined;
	resetEscapeStack();
});

function mount(node: Parameters<Root["render"]>[0], hidden = false): HTMLElement {
	const container = document.createElement("div");
	if (hidden) container.style.display = "none";
	document.body.appendChild(container);
	const root = createRoot(container);
	roots.push(root);
	act(() => root.render(createElement(LanguageProvider, null, node)));
	return container;
}

/** A chat's waiting question in the hidden chat pane (mounted first, as it is in the app), then the page. */
function setUp(): { sent: { type?: string; cancelled?: boolean }[] } {
	const sent: { type?: string; cancelled?: boolean }[] = [];
	setAppSend((msg) => {
		sent.push(msg as { type?: string; cancelled?: boolean });
		return true;
	});
	mount(
		createElement(DshQuestionDialog, {
			question: {
				id: "q-wait",
				questions: [{ id: "c1", question: "Which one?", options: [{ label: "A" }, { label: "B" }] }],
			},
		}),
		true,
	);
	mount(createElement(InitiativesPage, { active: true, onOpen: () => {} }));
	expect(view.props).toBeDefined();
	return { sent };
}

/** Escape as the browser sends it: at the focused control inside the open dialog, else at the body. */
function pressEscape(): void {
	const at = document.querySelector("dialog[open] button") ?? document.body;
	act(() => {
		at.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
	});
}

const answers = (sent: { type?: string }[]) => sent.filter((m) => m.type === "question_answer");

describe("initiatives-page: Escape closes the page's own dialogs first", () => {
	it("closes the Change lead dialog and leaves the hidden question waiting", () => {
		const { sent } = setUp();
		act(() => view.props!.onChangeLead!("alpha"));
		expect(document.querySelector("dialog[open] h2")?.textContent).toBe("Change lead: Alpha launch");

		pressEscape();

		expect(document.querySelector("dialog")).toBeNull();
		expect(answers(sent)).toEqual([]);
	});

	it("closes a decision's source dialog and leaves the hidden question waiting", () => {
		const { sent } = setUp();
		const ref = Object.keys(buildInitiativesPage(pageArgs()).sources)[0];
		expect(ref).toBeDefined();
		act(() => view.props!.onOpen({ ref } as InitiativesExactTarget));
		expect(document.querySelector("dialog[open]")).not.toBeNull();

		pressEscape();

		expect(document.querySelector("dialog")).toBeNull();
		expect(answers(sent)).toEqual([]);
	});

	it("with no page dialog open, Escape still reaches the question dialog", () => {
		const { sent } = setUp();

		pressEscape();

		expect(answers(sent)).toEqual([expect.objectContaining({ type: "question_answer", cancelled: true })]);
	});
});
