// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	FilePreview,
	type FilePreviewBinding,
	type FilePreviewContent,
	type FilePreviewRequest,
} from "../../web/src/components/FilePreview.js";
import { setAppSend } from "../../web/src/app-globals.js";

// Only peripheral rendering/identity dependencies are stubbed, never FilePreview.
vi.mock("../../web/src/use-chat", () => ({ getClientId: () => "synthetic-client" }));
vi.mock("../../web/src/i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../web/src/components/Markdown", () => ({ Markdown: ({ text }: { text: string }) => text }));

type Props = Parameters<typeof FilePreview>[0];
type Request = FilePreviewRequest;
const ORIGINAL = "  original α\nlast line\n";
const A = "  submitted A 😀\nwhole body\n";
const B = "  later B\nnot submitted\n";
const binding: FilePreviewBinding = {
	resourceId: "resolved-resource-1",
	workspaceId: "workspace-1",
	sessionId: "session-1",
	openId: "open-1",
};
const roots: Root[] = [];

function body(text = ORIGINAL): FilePreviewContent {
	return {
		path: "notes.txt",
		name: "notes.txt",
		kind: "text",
		text,
		binary: false,
		truncated: false,
		lines: text.split("\n").length - (text.endsWith("\n") ? 1 : 0),
		size: Buffer.byteLength(text),
	};
}
function reply(request: Request, text = request.type === "write_file" ? request.text : ORIGINAL): FilePreviewContent {
	const { reqId, purpose, lifetime, revision } = request;
	return {
		...body(text),
		path: request.path,
		reqId,
		purpose,
		lifetime,
		revision,
		// This is an explicit synthetic authorized-server resolution, not component inference.
		binding: request.binding
			? { ...request.binding, resourceId: request.binding.resourceId ?? "resolved-resource-1" }
			: undefined,
		writeSucceeded: request.type === "write_file",
		complete: true,
	};
}
function mount(overrides: Partial<Props> = {}, transport: (request: Request) => boolean = () => true) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	const requests: Request[] = [];
	setAppSend((msg) => {
		const request = msg as Request;
		requests.push(structuredClone(request));
		return transport(request);
	});
	const props: Props = {
		file: { path: "notes.txt", name: "notes.txt" },
		content: null,
		binding: { ...binding },
		onAddLines: vi.fn(),
		onAttach: vi.fn(),
		onClose: vi.fn(),
		...overrides,
	};
	const render = (next: Partial<Props> = {}) => {
		Object.assign(props, next);
		act(() => root.render(createElement(FilePreview, { ...props })));
	};
	const click = (selector: string) => {
		const element = container.querySelector<HTMLElement>(selector);
		expect(element, selector).not.toBeNull();
		act(() => element!.click());
	};
	const editor = () => container.querySelector<HTMLTextAreaElement>(".fp-editor");
	const change = (value: string) => {
		const element = editor();
		expect(element).not.toBeNull();
		act(() => {
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(element, value);
			element!.dispatchEvent(new Event("input", { bubbles: true }));
		});
	};
	const save = () => {
		act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true })));
		return requests.filter((r) => r.type === "write_file").at(-1)!;
	};
	const load = (text = ORIGINAL) => render({ content: reply(requests.at(-1)!, text) });
	const edit = (value = A) => {
		click(".fp-attach.edit");
		change(value);
	};
	const assertDraft = (text = B) => {
		expect(editor()?.value).toBe(text);
		expect(container.querySelector(".fp-path")?.textContent).toBe(props.file.path);
	};
	// Read the full baseline back through real cancel + edit events, not a private ref.
	const assertBaseline = (text: string) => {
		click(".fp-actions .btn:not(.primary)");
		expect(editor()).toBeNull();
		click(".fp-attach.edit");
		expect(editor()?.value).toBe(text);
	};
	render();
	return { container, props, requests, render, click, change, save, load, edit, editor, assertDraft, assertBaseline };
}

beforeEach(() => {
	(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
	vi.useFakeTimers();
	vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
	act(() => roots.splice(0).forEach((root) => root.unmount()));
	setAppSend(null);
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("FilePreview real-component read fences", () => {
	it("accepts only its current initial read; a write result is not an initial read", () => {
		const c = mount();
		const request = c.requests[0];
		expect(request).toMatchObject({ type: "read_file", path: "notes.txt", purpose: "read", binding, revision: 0 });
		for (const content of [
			body("uncorrelated"),
			{ ...reply(request), purpose: "write" as const },
			{ ...reply(request), reqId: "old-read" },
		]) {
			c.render({ content });
			expect(c.container.querySelector(".fp-attach.edit")).toBeNull();
		}
		c.load();
		c.edit();
		c.render({ content: reply(request, "late initial read") });
		c.assertDraft(A);
		c.assertBaseline(ORIGINAL);
	});

	it("a missing context stays legacy preview-only and cannot dispatch a write", () => {
		const c = mount({ binding: undefined });
		c.render({ content: body() });
		expect(c.container.querySelector(".fp-code-text")?.textContent).toBe("  original α");
		expect(c.container.querySelector<HTMLButtonElement>(".fp-attach.edit")?.disabled).toBe(true);
		c.click(".fp-attach.edit");
		c.save();
		c.render({ content: body("late legacy content") });
		expect(c.editor()).toBeNull();
		expect(c.requests.filter((r) => r.type === "write_file")).toHaveLength(0);
		expect(c.container.querySelector(".fp-code-text")?.textContent).toBe("  original α");
	});

	it.each([true, false])("bootstraps only real server resource identity; genuine session present=%s", (hasSession) => {
		const initial = {
			workspaceId: binding.workspaceId,
			openId: binding.openId,
			...(hasSession ? { sessionId: binding.sessionId } : {}),
		};
		const c = mount({ binding: initial });
		expect(c.requests[0].binding?.resourceId).toBeUndefined();
		c.load();
		c.edit();
		const write = c.save();
		expect(write.binding).toEqual({ ...initial, resourceId: "resolved-resource-1" });
		expect(write.binding?.sessionId).toBe(hasSession ? binding.sessionId : undefined);
		c.render({ content: reply(write) });
		expect(c.editor()).toBeNull();
	});

	it.each(["resource", "complete"])("a read without %s is preview-only, never editing authority", (missing) => {
		const c = mount({ binding: { workspaceId: binding.workspaceId, openId: binding.openId } });
		const original = reply(c.requests[0]);
		const content =
			missing === "resource"
				? { ...original, binding: { ...original.binding!, resourceId: undefined } }
				: { ...original, complete: false };
		c.render({ content });
		expect(c.container.querySelector<HTMLButtonElement>(".fp-attach.edit")?.disabled).toBe(true);
		c.click(".fp-attach.edit");
		c.save();
		expect(c.requests.filter((r) => r.type === "write_file")).toHaveLength(0);
	});
});

const invalidReplies: [string, (content: FilePreviewContent, read: Request) => FilePreviewContent][] = [
	["missing correlation", (c) => body(c.text)],
	["wrong request", (c) => ({ ...c, reqId: "other-write" })],
	["late initial read", (c, read) => reply(read, c.text)],
	["wrong purpose", (c) => ({ ...c, purpose: "read" })],
	["missing binding", (c) => ({ ...c, binding: undefined })],
	...["resourceId", "workspaceId", "sessionId", "openId"].map(
		(field): [string, (c: FilePreviewContent) => FilePreviewContent] => [
			`wrong ${field}`,
			(c) => ({ ...c, binding: { ...binding, [field]: "other" } }),
		],
	),
	["wrong lifetime", (c) => ({ ...c, lifetime: "old-editor" })],
	["wrong revision", (c) => ({ ...c, revision: c.revision! + 1 })],
	["different path", (c) => ({ ...c, path: "other.txt" })],
	["write error", (c) => ({ ...c, writeSucceeded: false })],
	["missing success", (c) => ({ ...c, writeSucceeded: undefined })],
	["incomplete", (c) => ({ ...c, complete: false })],
	["missing complete flag", (c) => ({ ...c, complete: undefined })],
	["truncated", (c) => ({ ...c, truncated: true })],
	["binary", (c) => ({ ...c, binary: true })],
	["nontext", (c) => ({ ...c, kind: "none" })],
	["partial or different body", (c) => ({ ...c, text: c.text.slice(1) })],
];

describe("FilePreview real-component write fences", () => {
	it.each(invalidReplies)("%s preserves complete current and baseline text, pending then unknown", (_name, corrupt) => {
		const c = mount();
		c.load();
		c.edit();
		const write = c.save();
		expect(write.path).toBe("notes.txt");
		expect(write.type === "write_file" && write.text).toBe(A);
		c.change(B);
		c.render({ content: corrupt(reply(write), c.requests[0]) });
		c.assertDraft();
		expect(c.container.querySelector<HTMLButtonElement>(".fp-actions .primary")?.disabled).toBe(true);
		act(() => vi.advanceTimersByTime(5000));
		c.assertDraft();
		expect(c.container.querySelector('[role="alert"]')?.textContent).toBe("saveResultUnknown");
		expect(c.requests.filter((r) => r.type === "write_file")).toHaveLength(1);
		expect(write.type === "write_file" && write.text).toBe(A);
		c.assertBaseline(ORIGINAL);
	});

	it.each(["false", "throw"])("transport %s preserves both submitted and later originals", (mode) => {
		const c = mount({}, (request) => {
			if (request.type === "read_file") return true;
			if (mode === "throw") throw new Error("synthetic transport error");
			return false;
		});
		c.load();
		c.edit();
		const write = c.save();
		c.assertDraft(A);
		c.change(B);
		c.assertDraft();
		expect(write).toMatchObject({ path: "notes.txt", text: A });
		expect(c.container.querySelector('[role="alert"]')?.textContent).toBe("saveResultUnknown");
		c.assertBaseline(ORIGINAL);
	});

	it.each(["false", "throw"])("transport %s retains the submitted original for a qualified late result", (mode) => {
		const c = mount({}, (request) => {
			if (request.type === "read_file") return true;
			if (mode === "throw") throw new Error("synthetic transport error");
			return false;
		});
		c.load();
		c.edit();
		const write = c.save();
		c.change(B);
		c.render({ content: reply(write) });
		c.assertDraft();
		expect(c.container.querySelector('[role="alert"]')).toBeNull();
		c.assertBaseline(A);
	});

	it("a current exact full save closes only its own unchanged revision", () => {
		const c = mount();
		c.load();
		c.edit();
		const write = c.save();
		expect(write.purpose).toBe("write");
		expect(write.reqId).not.toBe(c.requests[0].reqId);
		expect(write.lifetime).not.toBe(c.requests[0].lifetime);
		c.render({ content: reply(write) });
		expect(c.editor()).toBeNull();
		c.click(".fp-attach.edit");
		c.assertDraft(A);
		c.change(B);
		c.render({ content: reply(write) });
		c.assertDraft();
		c.assertBaseline(A);
	});

	it.each([B, A])("a later edit (including text ABA) survives a matching write, text=%s", (last) => {
		const c = mount();
		c.load();
		c.edit();
		const write = c.save();
		c.change(B);
		if (last === A) c.change(A);
		c.render({ content: reply(write) });
		c.assertDraft(last);
		expect(c.container.querySelector('[role="alert"]')).toBeNull();
		c.assertBaseline(A);
	});

	it("ignores repeated Ctrl+S while a dispatch is pending", () => {
		const c = mount();
		c.load();
		c.edit();
		c.save();
		c.save();
		c.change(B);
		c.save();
		expect(c.requests.filter((r) => r.type === "write_file")).toHaveLength(1);
		c.assertDraft();
	});

	it.each([A, B])("timeout keeps originals; a qualified late reply only closes unchanged revision: %s", (last) => {
		const c = mount();
		c.load();
		c.edit();
		const write = c.save();
		act(() => vi.advanceTimersByTime(5000));
		c.assertDraft(A);
		expect(c.container.querySelector('[role="alert"]')).not.toBeNull();
		expect(c.requests).toHaveLength(2);
		if (last === B) c.change(B);
		c.render({ content: reply(write) });
		if (last === A) {
			expect(c.editor()).toBeNull();
			c.click(".fp-attach.edit");
			c.assertDraft(A);
		} else {
			c.assertDraft();
			c.assertBaseline(A);
		}
	});

	it.each(["older-first", "newer-first"])(
		"orders manually submitted writes without baseline regression: %s",
		(order) => {
			const c = mount();
			c.load();
			c.edit();
			const first = c.save();
			act(() => vi.advanceTimersByTime(5000));
			c.change(B);
			const second = c.save();
			expect(first.type === "write_file" && first.text).toBe(A);
			expect(second.type === "write_file" && second.text).toBe(B);
			expect(first.reqId).not.toBe(second.reqId);
			if (order === "older-first") {
				c.render({ content: reply(first) });
				c.assertDraft();
				expect(c.container.querySelector<HTMLButtonElement>(".fp-actions .primary")?.disabled).toBe(true);
				c.render({ content: reply(second) });
			} else {
				c.render({ content: reply(second) });
				c.render({ content: reply(first) });
			}
			expect(c.editor()).toBeNull();
			c.click(".fp-attach.edit");
			c.assertDraft();
		},
	);
});

describe("FilePreview lifecycle and existing safety", () => {
	it.each(["path", "resourceId", "workspaceId", "sessionId", "openId", "unmount"])(
		"old replies cannot affect a newer editor after %s ABA",
		(field) => {
			const c = mount();
			c.load();
			c.edit();
			const oldRead = c.requests[0];
			const write = c.save();
			if (field === "unmount") {
				act(() => roots[0].render(null));
				c.render({ content: null });
			} else if (field === "path") {
				c.render({ file: { path: "other.txt", name: "other.txt" }, content: null });
				c.render({ file: { path: "notes.txt", name: "notes.txt" } });
			} else {
				c.render({ binding: { ...binding, [field]: "other" }, content: null });
				c.render({ binding: { ...binding } });
			}
			const read = c.requests.at(-1)!;
			expect(read.lifetime).not.toBe(oldRead.lifetime);
			c.render({ content: reply(oldRead) });
			expect(c.container.querySelector(".fp-attach.edit")).toBeNull();
			c.render({ content: reply(write) });
			expect(c.container.querySelector(".fp-attach.edit")).toBeNull();
			c.render({ content: reply(read, "new baseline\n") });
			c.edit(B);
			c.render({ content: reply(write) });
			c.assertDraft();
			c.assertBaseline("new baseline\n");
		},
	);

	it("cancel/re-enter makes a new editor lifetime, even with identical text", () => {
		const c = mount();
		c.load();
		c.edit();
		const first = c.save();
		c.click(".fp-actions .btn:not(.primary)");
		c.edit();
		const second = c.save();
		expect(second.lifetime).not.toBe(first.lifetime);
		c.render({ content: reply(first) });
		c.assertDraft(A);
		c.render({ content: reply(second) });
		expect(c.editor()).toBeNull();
	});

	it("preserves close/cancel confirmation and never dispatches when discard is refused", () => {
		const c = mount();
		c.load();
		c.edit();
		vi.mocked(window.confirm).mockReturnValue(false);
		c.click(".fp-close");
		c.click(".fp-actions .btn:not(.primary)");
		c.assertDraft(A);
		expect(c.props.onClose).not.toHaveBeenCalled();
		expect(c.requests.filter((r) => r.type === "write_file")).toHaveLength(0);
		vi.mocked(window.confirm).mockReturnValue(true);
		c.click(".fp-close");
		expect(c.props.onClose).toHaveBeenCalledOnce();
	});

	it.each(["binary", "truncated", "office"])("keeps the %s edit restriction", (mode) => {
		const c = mount(mode === "office" ? { file: { path: "file.docx", name: "file.docx" } } : {});
		const content = reply(c.requests[0]);
		if (mode === "binary") content.binary = true;
		if (mode === "truncated") content.truncated = true;
		c.render({ content });
		const button = c.container.querySelector<HTMLButtonElement>(".fp-attach.edit");
		expect(!button || button.disabled).toBe(true);
		expect(c.editor()).toBeNull();
	});

	it("keeps HTML scripts opt-in and resets the sandbox gate on a new open", () => {
		const c = mount({ file: { path: "file.html", name: "file.html" } });
		c.load("<h1>synthetic</h1>");
		expect(c.container.querySelector("iframe")?.getAttribute("sandbox")).toBe("");
		c.click(".fp-html-js");
		expect(c.container.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
		expect(c.container.querySelector("iframe")?.getAttribute("src")).toContain("allowJs=1");
		c.render({ binding: { ...binding, openId: "open-2" }, content: null });
		c.load("<h1>synthetic</h1>");
		expect(c.container.querySelector("iframe")?.getAttribute("sandbox")).toBe("");
		expect(c.container.querySelector("iframe")?.getAttribute("src")).not.toContain("allowJs=1");
	});
});
