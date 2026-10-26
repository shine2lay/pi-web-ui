// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Message, type EditAdmission } from "../../web/src/components/Message.js";
import { MessageList } from "../../web/src/components/MessageList.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { getContextMenu, resetContextMenu } from "../../web/src/context-menu-state.js";
import type { PromptAttachment, UiMessage, UiState } from "../../web/src/types.js";

type Props = ComponentProps<typeof Message>;
const roots: Root[] = [];
const authored = "  keep é 🌈\nsecond line\t  ";
const question = (id = "u-a", text = "original question"): UiMessage => ({
	id,
	role: "user",
	content: [{ type: "text", text }],
});
const attachments = (): PromptAttachment[] => [
	{ path: "", imageData: "AP8BAgM=", mimeType: "image/png", name: "像.png", size: 5 },
	{
		path: "",
		imageUrl: "/api/chat-image?conversationId=c-a&sessionId=s-a&id=image-a",
		mimeType: "image/png",
		name: "lazy.png",
		size: 19,
	},
	{ path: "", uploadPath: "uploads/original.bin", name: "zero.bin", size: 0, mimeType: "application/octet-stream" },
	{ path: "", fileData: "AAEC/w==", name: "raw.bin", mimeType: "application/octet-stream", size: 4 },
	{ path: "src/one.ts", mode: "reference", name: "reference" },
	{ path: "src/two.ts", mode: "lines", lines: { start: 2, end: 9 }, name: "lines" },
	{ path: "https://example.invalid", mode: "page", name: "Granted page" },
	{
		path: "",
		mode: "conversation",
		conversationId: "c-quoted",
		sessionPath: "/synthetic/quoted.jsonl",
		name: "Quoted",
	},
	{ path: "legacy.txt", mode: "inline" },
];
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((ok, bad) => {
		resolve = ok;
		reject = bad;
	});
	return { promise, resolve, reject };
}
function node<T extends Element>(container: Element, selector: string): T {
	const found = container.querySelector<T>(selector);
	if (!found) throw new Error(`Missing test element ${selector}`);
	return found;
}
const click = (el: HTMLElement) => act(() => el.click());
function input(container: Element, value: string) {
	const el = node<HTMLTextAreaElement>(container, "textarea.msg-editor-input");
	act(() => {
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
		el.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
function key(container: Element, value = "Enter") {
	act(() =>
		node(container, "textarea").dispatchEvent(
			new KeyboardEvent("keydown", { key: value, ctrlKey: true, bubbles: true }),
		),
	);
}
function mount(overrides: Partial<Props> = {}) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	roots.push(root);
	let props: Props = {
		message: question(),
		toolResults: new Map(),
		liveOutputs: new Map(),
		toolStatuses: new Map(),
		streaming: false,
		isLast: true,
		editContextKey: "parent-c-a/s-a/generation-1",
		onEditAdmit: async () => true,
		questionAttachments: attachments(),
		...overrides,
	};
	const render = (patch: Partial<Props> = {}) => {
		props = { ...props, ...patch };
		act(() => root.render(createElement(LanguageProvider, null, createElement(Message, props))));
	};
	render();
	return {
		container,
		render,
		open: () => click(node(container, 'button[title^="Edit this question"]')),
		submit: () => click(node(container, ".msg-editor-actions .primary")),
		cancel: () => click(node(container, ".msg-editor-actions .chip:not(.primary)")),
		unmount: () => {
			act(() => root.unmount());
			roots.splice(roots.indexOf(root), 1);
		},
	};
}
function direct(container: Element) {
	act(() => node(container, ".msg").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
	const menu = getContextMenu();
	const entry = menu?.entries.find((item) => item.id === "host:msg-ctx-reask");
	if (!menu || !entry) throw new Error("Direct reask menu missing");
	return () =>
		act(() => {
			menu.onHostAction?.(entry, menu.target);
		});
}
function kept(container: Element, text = authored, count = attachments().length) {
	expect(node<HTMLTextAreaElement>(container, "textarea").value).toBe(text);
	expect(container.querySelectorAll(".msg-editor-img")).toHaveLength(count);
}
async function settle(d: ReturnType<typeof deferred<boolean>>, value: boolean | Error) {
	await act(async () => {
		if (value instanceof Error) d.reject(value);
		else d.resolve(value);
		await d.promise.catch(() => {});
	});
}
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	localStorage.clear();
});
afterEach(() => {
	act(() => {
		for (const root of roots.splice(0)) root.unmount();
	});
	resetContextMenu();
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("actual Message edit admission", () => {
	it.each([true, false, new Error("synthetic attachment-resolution failure")])(
		"keeps exact draft and every attachment until resolved %s",
		async (outcome) => {
			const d = deferred<boolean>();
			const admit = vi.fn(() => d.promise);
			const h = mount({ onEditAdmit: admit });
			h.open();
			input(h.container, authored);
			h.submit();
			kept(h.container);
			expect(h.container.querySelector('[data-edit-admission="pending"]')).not.toBeNull();
			expect(admit).toHaveBeenCalledExactlyOnceWith("u-a", authored, attachments());
			await settle(d, outcome);
			if (outcome === true) expect(h.container.querySelector("textarea")).toBeNull();
			else {
				kept(h.container);
				expect(node(h.container, "[data-edit-admission]").textContent).toContain("not confirmed");
				expect(node(h.container, "[data-edit-admission] pre").textContent).toBe(authored);
				expect(h.container.querySelectorAll("[data-edit-admission] li")).toHaveLength(attachments().length);
			}
		},
	);
	it.each([undefined, 1, "true", { ok: true }])(
		"does not reinterpret nontrue result %s as admission",
		async (result) => {
			const badCallback = vi.fn(async () => result);
			const legacy = vi.fn();
			const h = mount({ onEditAdmit: badCallback as unknown as EditAdmission, onEdit: legacy });
			h.open();
			input(h.container, authored);
			await act(async () => {
				h.submit();
			});
			kept(h.container);
			expect(legacy).not.toHaveBeenCalled();
		},
	);
	it.each(["absent", "void", "no binding", "blank binding"])(
		"keeps the editor and never invokes legacy fallback for %s",
		async (mode) => {
			const legacy = vi.fn();
			const admit = vi.fn(async () => true);
			const h = mount({
				onEdit: legacy,
				onEditAdmit: mode === "absent" || mode === "void" ? undefined : admit,
				editContextKey: mode === "no binding" ? undefined : mode === "blank binding" ? " " : "parent-g1",
			});
			h.open();
			input(h.container, authored);
			h.submit();
			kept(h.container);
			expect(legacy).not.toHaveBeenCalled();
			expect(admit).not.toHaveBeenCalled();
			expect(node(h.container, "[data-edit-admission]").textContent).toContain("nothing was submitted");
		},
	);
	it("locks synchronous throws without falling back, closing or losing references", async () => {
		const legacy = vi.fn();
		const admit = vi.fn(() => {
			throw new Error("synthetic synchronous failure");
		});
		const h = mount({ onEdit: legacy, onEditAdmit: admit });
		h.open();
		input(h.container, authored);
		await act(async () => {
			key(h.container);
			key(h.container);
			h.submit();
		});
		kept(h.container);
		expect(admit).toHaveBeenCalledTimes(1);
		expect(legacy).not.toHaveBeenCalled();
		expect(node(h.container, "[data-edit-admission] pre").textContent).toBe(authored);
	});
	it("synchronously locks repeated Ctrl/Meta+Enter, click and stale direct actions", async () => {
		const d = deferred<boolean>();
		const admit = vi.fn(() => d.promise);
		const h = mount({ onEditAdmit: admit });
		const oldDirect = direct(h.container);
		h.open();
		input(h.container, authored);
		act(() => {
			key(h.container);
			key(h.container);
			h.submit();
			oldDirect();
		});
		expect(admit).toHaveBeenCalledTimes(1);
		kept(h.container);
		await settle(d, false);
		kept(h.container);
	});
	it.each([false, true, new Error("late resolution")])(
		"preserves newer text and attachments after old outcome %s",
		async (outcome) => {
			const d = deferred<boolean>();
			const admit = vi.fn(() => d.promise);
			const h = mount({ onEditAdmit: admit });
			h.open();
			input(h.container, authored);
			h.submit();
			input(h.container, "  newer exact text\n ");
			click(node(h.container, ".msg-editor-img-remove"));
			await settle(d, outcome);
			kept(h.container, "  newer exact text\n ", attachments().length - 1);
			expect(node(h.container, "[data-edit-admission] pre").textContent).toBe(authored);
			expect(admit.mock.calls[0]).toEqual(["u-a", authored, attachments()]);
		},
	);
	it("revision fencing catches text A-to-B-to-A rather than comparing values", async () => {
		const d = deferred<boolean>();
		const h = mount({ onEditAdmit: () => d.promise });
		h.open();
		input(h.container, authored);
		h.submit();
		input(h.container, "B");
		input(h.container, authored);
		await settle(d, true);
		kept(h.container);
	});
	it("snapshots nested metadata before await and isolates callback and prop mutation", async () => {
		const original = attachments();
		const before = structuredClone(original);
		const d = deferred<boolean>();
		const admit = vi.fn((_id: string, _text: string, atts?: PromptAttachment[]) => {
			atts![0].imageData = "mutated";
			atts![5].lines!.start = 999;
			atts!.pop();
			return d.promise;
		});
		const h = mount({ questionAttachments: original, onEditAdmit: admit });
		h.open();
		input(h.container, authored);
		h.submit();
		original[5].lines!.end = 1000;
		original.pop();
		await settle(d, false);
		kept(h.container);
		let resubmitted: PromptAttachment[] | undefined;
		h.render({
			onEditAdmit: async (_id, _text, atts) => {
				resubmitted = atts;
				return false;
			},
		});
		await act(async () => {
			h.submit();
		});
		expect(resubmitted).toEqual(before);
		expect(h.container.querySelectorAll("[data-edit-admission] li")).toHaveLength(before.length);
	});
	it("same-message cancel/reopen does not let an old completion close the new editor", async () => {
		const d = deferred<boolean>();
		const admit = vi.fn(() => d.promise);
		const h = mount({ onEditAdmit: admit });
		h.open();
		input(h.container, authored);
		h.submit();
		h.cancel();
		h.open();
		input(h.container, "reopened");
		key(h.container);
		expect(admit).toHaveBeenCalledTimes(1);
		await settle(d, true);
		kept(h.container, "reopened");
	});
	it.each(["message", "context", "context ABA"])(
		"retains an old draft and fences old completion on %s change",
		async (change) => {
			const d = deferred<boolean>();
			const admit = vi.fn(() => d.promise);
			const h = mount({ onEditAdmit: admit });
			h.open();
			input(h.container, authored);
			h.submit();
			if (change === "message") h.render({ message: question("u-b", "other target") });
			else h.render({ editContextKey: "parent-c-b/s-b/g2" });
			if (change === "context ABA") h.render({ editContextKey: "parent-c-a/s-a/generation-1" });
			kept(h.container);
			key(h.container);
			expect(admit).toHaveBeenCalledTimes(1);
			h.cancel();
			h.open();
			input(h.container, "new target draft");
			await settle(d, true);
			kept(h.container, "new target draft");
		},
	);
	it("unmount invalidates cleanup, not the already submitted original", async () => {
		const d = deferred<boolean>();
		const admit = vi.fn(() => d.promise);
		const old = mount({ onEditAdmit: admit });
		old.open();
		input(old.container, authored);
		old.submit();
		old.unmount();
		const next = mount();
		next.open();
		input(next.container, "new mount");
		await settle(d, true);
		kept(next.container, "new mount");
		expect(admit).toHaveBeenCalledExactlyOnceWith("u-a", authored, attachments());
	});
	it("waits for newly dropped file bytes, and an in-flight read fences admission cleanup", async () => {
		const readers: { onload?: () => void; onerror?: () => void; result: string; error: Error | null }[] = [];
		vi.stubGlobal(
			"FileReader",
			class {
				onload?: () => void;
				onerror?: () => void;
				result = "data:application/octet-stream;base64,AP8=";
				error = null;
				readAsDataURL() {
					readers.push(this);
				}
			},
		);
		const d = deferred<boolean>();
		const admit = vi.fn(() => d.promise);
		const h = mount({ onEditAdmit: admit });
		h.open();
		input(h.container, authored);
		h.submit();
		const drop = new Event("drop", { bubbles: true });
		Object.defineProperty(drop, "dataTransfer", {
			value: { files: [new File(["bytes"], "new.bin", { type: "application/octet-stream" })] },
		});
		act(() => node(h.container, ".msg-editor").dispatchEvent(drop));
		await settle(d, true);
		kept(h.container);
		key(h.container);
		expect(admit).toHaveBeenCalledTimes(1);
		await act(async () => {
			readers[0].onload?.();
		});
		kept(h.container, authored, attachments().length + 1);
	});
	it("empty-only whitespace is not submitted, but nonempty authored whitespace is exact", () => {
		const admit = vi.fn(async () => true);
		const h = mount({ onEditAdmit: admit });
		h.open();
		input(h.container, " \n\t ");
		key(h.container);
		expect(admit).not.toHaveBeenCalled();
	});
});

describe("actual direct reask uses the same boundary", () => {
	it.each([true, false, new Error("lazy image unavailable")])(
		"captures exact original and all refs while resolving %s",
		async (outcome) => {
			const d = deferred<boolean>();
			const admit = vi.fn(() => d.promise);
			const h = mount({ message: question("u-a", authored), onEditAdmit: admit });
			const reask = direct(h.container);
			act(() => {
				reask();
				reask();
			});
			expect(admit).toHaveBeenCalledExactlyOnceWith("u-a", authored, attachments());
			expect(node(h.container, "[data-edit-admission] pre").textContent).toBe(authored);
			h.open();
			input(h.container, "opened during direct reask");
			await settle(d, outcome);
			kept(h.container, "opened during direct reask");
		},
	);
	it("missing callback does not use the legacy direct reask path", () => {
		const legacy = vi.fn();
		const h = mount({ onEdit: legacy, onEditAdmit: undefined });
		direct(h.container)();
		expect(legacy).not.toHaveBeenCalled();
		expect(node(h.container, "[data-edit-admission]").textContent).toContain("nothing was submitted");
	});
});

describe("actual MessageList parent callback propagation", () => {
	function list(overrides: Partial<ComponentProps<typeof MessageList>> = {}) {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		roots.push(root);
		let props: ComponentProps<typeof MessageList> = {
			state: {
				clientId: "synthetic",
				cwd: "/synthetic",
				conversationId: "c-a",
				sessionId: "s-a",
				rev: 1,
				messages: [question()],
				streamingMessage: null,
				isStreaming: false,
				model: null,
				thinkingLevel: "off",
				availableThinkingLevels: [],
				queue: { steering: [], followUp: [] },
				tools: [],
				version: 1,
				piConfigured: false,
				piAgentInstalled: false,
				stats: {
					totalMessages: 0,
					tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					cost: 0,
					contextUsage: { tokens: 0, contextWindow: 0, percent: 0 },
				},
			} satisfies UiState,
			liveOutputs: new Map(),
			toolStatuses: new Map(),
			editContextKey: "parent-generation-1",
			...overrides,
		};
		const render = (patch: Partial<typeof props> = {}) => {
			props = { ...props, ...patch };
			act(() => root.render(createElement(LanguageProvider, null, createElement(MessageList, props))));
		};
		render();
		return { container, render, state: props.state };
	}
	it.each(["window", "digest"])("awaits explicit admission in %s without calling the void callback", async (where) => {
		const d = deferred<boolean>();
		const admit = vi.fn<EditAdmission>(() => d.promise);
		const legacy = vi.fn();
		const h = list({ onEditAdmit: admit, onEdit: legacy });
		const imageCard: UiMessage = {
			id: "img",
			role: "custom",
			customType: "file",
			details: { name: "lazy.png" },
			content: [{ type: "image", url: "/api/chat-image?synthetic=1", mimeType: "image/png" }],
		};
		const head = [question(), imageCard];
		if (where === "digest")
			h.render({
				state: {
					...h.state,
					messages: [],
					messagesStart: 2,
					exchanges: [
						{
							index: 0,
							end: 2,
							head,
							answers: [],
							after: [],
							folded: false,
							turns: 0,
							thinking: 0,
							toolCalls: 0,
							status: "done",
						},
					],
				},
			});
		else h.render({ state: { ...h.state, messages: head } });
		click(node(h.container, 'button[title^="Edit this question"]'));
		input(h.container, authored);
		key(h.container);
		expect(admit).toHaveBeenCalledTimes(1);
		expect(legacy).not.toHaveBeenCalled();
		expect(node<HTMLTextAreaElement>(h.container, "textarea").value).toBe(authored);
		expect(admit.mock.calls[0][2]).toEqual([
			{ path: "", imageUrl: "/api/chat-image?synthetic=1", mimeType: "image/png", name: "lazy.png" },
		]);
		await settle(d, false);
		expect(h.container.querySelector("textarea")).not.toBeNull();
	});
	it("keeps streaming rows read-only rather than admitting edits", () => {
		const admit = vi.fn(async () => true);
		const legacy = vi.fn();
		const h = list({ onEditAdmit: admit, onEdit: legacy });
		h.render({ state: { ...h.state, messages: [], streamingMessage: question() } });
		expect(h.container.querySelector('button[title^="Edit this question"]')).toBeNull();
		expect(h.container.querySelector("textarea")).toBeNull();
		expect(admit).not.toHaveBeenCalled();
		expect(legacy).not.toHaveBeenCalled();
	});
	it("real session changes, including A-B-A, fence a pending editor even with the same parent key", async () => {
		const d = deferred<boolean>();
		const admit = vi.fn(() => d.promise);
		const h = list({ onEditAdmit: admit });
		click(node(h.container, 'button[title^="Edit this question"]'));
		input(h.container, authored);
		key(h.container);
		h.render({ state: { ...h.state, sessionId: "s-b" } });
		h.render({ state: h.state });
		await settle(d, true);
		expect(node<HTMLTextAreaElement>(h.container, "textarea").value).toBe(authored);
	});
	it("cannot fabricate a generation from state IDs when the parent binding is absent", () => {
		const admit = vi.fn(async () => true);
		const h = list({ onEditAdmit: admit, editContextKey: undefined });
		click(node(h.container, 'button[title^="Edit this question"]'));
		input(h.container, authored);
		key(h.container);
		expect(admit).not.toHaveBeenCalled();
		expect(node<HTMLTextAreaElement>(h.container, "textarea").value).toBe(authored);
	});
});
