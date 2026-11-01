// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { Message } from "../../web/src/components/Message.js";
import { parseOwnerQuestionBody } from "../../web/src/components/OwnerQuestionBody.js";
import { isRoleMessageOpen, setRoleMessageOpen } from "../../web/src/components/RoleMessageRow.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { collectFoldedHits } from "../../web/src/search-folded.js";
import type { UiMessage } from "../../web/src/types.js";

// H-OWNER-COO-CARD, folding subcase: package blockquotes never fold. The owner-question variant
// must keep the existing outer row and show each package as an independent, initially closed disclosure.
const fields = [
	"Who asks: Design (design) · its home chat",
	"Kind: a question (ask_user_question)",
	"Why it came to you: the owner is away",
	"Brief:",
	"In short: Design needs a port for the preview.",
	"Question: Which port should the preview use?",
	"  1. 8080 (the usual port)",
	"  2. 8090 (a free port)",
	"Or a typed answer.",
	"It goes to the owner at 09:30 UTC unless you act.",
	"Actions (owner_question tool):",
	'- release to him: owner_question release id "oq-1234abcd" note "Ready"',
	'- hold while you gather context: owner_question hold id "oq-1234abcd"',
	'- return to the chat that asked: owner_question return id "oq-1234abcd"',
].join("\n");
const packageOne = "Package:\n> ## Context\n> First **full context**.\n>\n> - Keep both choices.\n> > A nested quote.";
const packageTwo = "Package:\n> Second full context with `package-only-needle`.";
const guidance =
	"Held for you before the owner sees them. Gather the context; never answer for him.\n" +
	"If this turn ends with one still held and no release, hold or return, it goes to him at once.";
const singleBody = `${fields}\n${packageOne}\n\n${guidance}`;
const single = `[Owner question] from Design's home chat [oq-1234abcd]\n\n${singleBody}`;
const batchBody =
	`— oq-1234abcd (1 of 2)\n${fields}\n${packageOne}\n\n` +
	`— oq-5678efab (2 of 2)\nWho asks: Ops (ops) · a task chat · task #12\n` +
	`Question: Keep the preview running?\n${packageTwo}\n\n${guidance}`;
const batch =
	"[Owner question] 2 questions, from Design's home chat; Ops's task #12 “Preview” " +
	`[oq-1234abcd, oq-5678efab]\n\n${batchBody}`;

const messageOf = (text: string, extra: Partial<UiMessage> = {}): UiMessage => ({
	id: "u-owner-question-ui",
	role: "user",
	content: [{ type: "text", text }],
	timestamp: Date.UTC(2026, 10, 1, 9),
	...extra,
});

type DisplayOptions = Pick<Parameters<typeof Message>[0], "searchActive" | "onCollapse">;
let root: Root | null = null;
let mountedId: string | null = null;

function mount(message: UiMessage, options: DisplayOptions = {}) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	mountedId = message.id;
	const render = (next: DisplayOptions = options) => {
		act(() => {
			root!.render(
				createElement(
					LanguageProvider,
					null,
					createElement(Message, {
						message,
						toolResults: new Map(),
						liveOutputs: new Map(),
						toolStatuses: new Map(),
						streaming: false,
						isLast: false,
						...next,
					}),
				),
			);
		});
	};
	render();
	return { container, render };
}

function click(container: ParentNode, selector: string) {
	const target = container.querySelector<HTMLElement>(selector);
	expect(target).not.toBeNull();
	act(() => target!.click());
}

const packages = (container: ParentNode) => Array.from(container.querySelectorAll<HTMLDetailsElement>("details"));

function outsidePackages(container: HTMLElement): string {
	const copy = container.cloneNode(true) as HTMLElement;
	copy.querySelectorAll("details").forEach((element) => element.remove());
	return copy.textContent ?? "";
}

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	if (mountedId) setRoleMessageOpen(mountedId, false);
	mountedId = null;
	document.body.innerHTML = "";
});

describe("parseOwnerQuestionBody", () => {
	it("unquotes only the contiguous package, preserving blank lines, nested quotes and surrounding text", () => {
		expect(parseOwnerQuestionBody(singleBody)).toEqual([
			{ kind: "text", text: fields },
			{ kind: "package", text: "## Context\nFirst **full context**.\n\n- Keep both choices.\n> A nested quote." },
			{ kind: "text", text: `\n${guidance}` },
		]);
	});

	it("splits batch packages independently and leaves the next question and guidance outside", () => {
		const parts = parseOwnerQuestionBody(batchBody);
		expect(parts.map((part) => part.kind)).toEqual(["text", "package", "text", "package", "text"]);
		expect(parts[2].text).toContain("— oq-5678efab (2 of 2)");
		expect(parts[2].text).toContain("Question: Keep the preview running?");
		expect(parts[3].text).toBe("Second full context with `package-only-needle`.");
		expect(parts[4].text).toBe(`\n${guidance}`);
	});

	it("stops at a nonquoted line even without a blank separator, and accepts a package at the end", () => {
		expect(parseOwnerQuestionBody("Package:\n> Full context\nQuestion: Still outside")).toEqual([
			{ kind: "package", text: "Full context" },
			{ kind: "text", text: "Question: Still outside" },
		]);
		expect(parseOwnerQuestionBody("Question: Pick one\nPackage:\n> The end")).toEqual([
			{ kind: "text", text: "Question: Pick one" },
			{ kind: "package", text: "The end" },
		]);
	});

	it("leaves plain text, unrelated quotes and a Package label without an immediate quote alone", () => {
		for (const text of ["Question: Pick one", "> An ordinary quote", "Package:", "Package:\n\n> Not contiguous"]) {
			expect(parseOwnerQuestionBody(text)).toEqual([{ kind: "text", text }]);
		}
	});
});

describe("OwnerQuestionBody in the existing role-message card", () => {
	it("starts as the existing folded row with a plain owner-question label, not an rm- message", () => {
		const { container } = mount(messageOf(single));
		const row = container.querySelector(".rolemsg-row");
		expect(row?.getAttribute("data-role-message")).toBe("oq-1234abcd");
		expect(row?.querySelector(".rolemsg-row-kind")?.textContent).toBe("Owner question");
		expect(row?.querySelector(".rolemsg-row-from")?.textContent).toContain("Design's home chat");
		expect(container.querySelector(".rolemsg-card")).toBeNull();
		expect(container.querySelector(".rolemsg-row-btn")?.getAttribute("aria-expanded")).toBe("false");
		click(container, ".rolemsg-row-btn");
		expect(container.querySelector(".rolemsg-title")?.textContent).toBe("Owner question");
		expect(container.querySelector(".rolemsg-card")?.getAttribute("data-role-message")).toBe("oq-1234abcd");
		expect(container.querySelector(".rolemsg-head")?.textContent).not.toContain("rm-");
		expect(packages(container).map((part) => part.open)).toEqual([false]);
		click(container, ".rolemsg-fold");
		expect(container.querySelector(".rolemsg-row")).not.toBeNull();
	});

	it("keeps every question field, choice, action and guidance visible outside the closed package", () => {
		const { container } = mount(messageOf(single));
		click(container, ".rolemsg-row-btn");
		const visible = outsidePackages(container);
		for (const field of [
			"Who asks: Design (design)",
			"Kind: a question (ask_user_question)",
			"Why it came to you: the owner is away",
			"In short: Design needs a port for the preview.",
			"Question: Which port should the preview use?",
			"8080 (the usual port)",
			"8090 (a free port)",
			"Or a typed answer.",
			"It goes to the owner at 09:30 UTC unless you act.",
			"Actions (owner_question tool):",
			"release to him:",
			"hold while you gather context:",
			"return to the chat that asked:",
			"never answer for him",
			"it goes to him at once",
		]) {
			expect(visible).toContain(field);
		}
		expect(visible).not.toContain("full context");
		const detail = packages(container)[0];
		expect(detail.querySelector("summary")?.textContent).toBe("Package");
		expect(detail.open).toBe(false);
		click(detail, "summary");
		expect(detail.open).toBe(true);
		expect(detail.querySelector("h2")?.textContent).toBe("Context");
		expect(detail.querySelector("strong")?.textContent).toBe("full context");
		expect(detail.querySelector("li")?.textContent).toBe("Keep both choices.");
		expect(detail.querySelector("blockquote")?.textContent).toContain("A nested quote.");
	});

	it("opens and closes each batch package independently without swallowing the next question", () => {
		const { container } = mount(messageOf(batch));
		click(container, ".rolemsg-row-btn");
		const [first, second] = packages(container);
		expect(packages(container).map((part) => part.open)).toEqual([false, false]);
		click(first, "summary");
		expect(packages(container).map((part) => part.open)).toEqual([true, false]);
		click(second, "summary");
		expect(packages(container).map((part) => part.open)).toEqual([true, true]);
		click(first, "summary");
		expect(packages(container).map((part) => part.open)).toEqual([false, true]);
		expect(outsidePackages(container)).toContain("Question: Keep the preview running?");
		expect(outsidePackages(container)).toContain("never answer for him");
		expect(first.textContent).not.toContain("Second full context");
		expect(second.textContent).not.toContain("First full context");
	});

	it("reveals a package-only search hit and restores the outer fold when search closes", () => {
		const message = messageOf(batch);
		expect(collectFoldedHits([message], new Set([message.id]), "package-only-needle", new Map()).get(message.id)).toBe(
			1,
		);
		const { container, render } = mount(message);
		expect(isRoleMessageOpen(message.id)).toBe(false);
		render({ searchActive: true });
		expect(container.querySelector(".rolemsg-row")).toBeNull();
		expect(packages(container).map((part) => part.open)).toEqual([true, true]);
		const match = container.querySelector("details code");
		expect(match?.textContent).toBe("package-only-needle");
		expect(match?.closest("details")?.open).toBe(true);
		expect(isRoleMessageOpen(message.id)).toBe(false);
		render({ searchActive: false });
		expect(container.querySelector(".rolemsg-row")).not.toBeNull();
		click(container, ".rolemsg-row-btn");
		expect(packages(container).map((part) => part.open)).toEqual([false, false]);
	});

	it("restores each reader-chosen package fold after search rather than saving its forced opens", () => {
		const { container, render } = mount(messageOf(batch));
		click(container, ".rolemsg-row-btn");
		click(packages(container)[0], "summary");
		render({ searchActive: true });
		expect(packages(container).map((part) => part.open)).toEqual([true, true]);
		click(packages(container)[1], "summary");
		expect(packages(container)[1].open).toBe(true);
		render({ searchActive: false });
		expect(packages(container).map((part) => part.open)).toEqual([true, false]);
	});

	it("keeps packages closed when the card expands from the old-message view rather than search", () => {
		const { container } = mount(messageOf(batch), { onCollapse: () => {} });
		expect(container.querySelector(".rolemsg-card")).not.toBeNull();
		expect(container.querySelector(".rolemsg-row")).toBeNull();
		expect(packages(container).map((part) => part.open)).toEqual([false, false]);
	});

	it("keeps HTML as text in both surrounding fields and packages; only React creates disclosures", () => {
		const text =
			"[Owner question] from the chat “<b>Scratch</b>” [oq-1234abcd]\n\n" +
			'Question: <strong data-owner-html="field">Choose one</strong>\n' +
			"Package:\n> <details open><summary>Injected</summary>Not a disclosure</details>\n" +
			"> <script>window.ownerQuestionInjected = true</script>\n> <img src=x onerror=alert(1)>\n\n" +
			guidance;
		const { container } = mount(messageOf(text));
		click(container, ".rolemsg-row-btn");
		click(packages(container)[0], "summary");
		expect(packages(container)).toHaveLength(1);
		expect(container.querySelector("[data-owner-html], script, img, b")).toBeNull();
		expect(container.textContent).toContain('<strong data-owner-html="field">Choose one</strong>');
		expect(container.textContent).toContain("<details open>");
		expect(container.querySelector(".rolemsg-head")?.textContent).toContain("<b>Scratch</b>");
	});

	it("does not invent a package when a question has no long context", () => {
		const { container } = mount(messageOf(single.replace(`\n${packageOne}`, "")));
		click(container, ".rolemsg-row-btn");
		expect(packages(container)).toHaveLength(0);
		expect(container.textContent).toContain("Which port should the preview use?");
		expect(container.textContent).toContain("never answer for him");
	});

	it.each([
		{
			name: "ordinary role message",
			message: messageOf(
				"[Role message rm-0123abcd from design (Design), sent from its home chat · fyi]\n\nPackage:\n> Keep this ordinary quote.",
			),
			folds: true,
		},
		{
			name: "Board order",
			message: messageOf(
				"[Board order bp-0123abcd from owner · 2026-11-01 09:00 UTC]\n\n**Continue**\n\nPackage:\n> Keep this ordinary quote.",
			),
			folds: true,
		},
		{
			name: "Board note",
			message: messageOf("[Board] 1 new post\n\nPackage:\n> Keep this ordinary quote.", {
				role: "custom",
				customType: "board",
			}),
			folds: true,
		},
		{
			name: "ordinary user message",
			message: messageOf("Package:\n> Keep this ordinary quote."),
			folds: false,
		},
	])("does not change $name rendering", ({ message, folds }) => {
		const { container } = mount(message);
		if (folds) click(container, ".rolemsg-row-btn");
		expect(packages(container)).toHaveLength(0);
		expect(container.querySelector(".rolemsg-owner-question")).toBeNull();
		expect(container.querySelector("blockquote")?.textContent).toContain("Keep this ordinary quote.");
	});
});
