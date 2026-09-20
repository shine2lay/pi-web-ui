// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { LeftPanel } from "../../web/src/components/LeftPanel.js";
import { SwitchOverlay } from "../../web/src/components/SwitchOverlay.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { resetAppGlobals, setAppGlobals } from "../../web/src/app-globals.js";
import type { ConversationSummary, SessionSummary, SwitchTarget } from "../../server/protocol.js";

/**
 * 切换对话的加载 / 失败态（switch-loading 补丁）—— 前端行为。
 *
 *  - 左栏：有进行中的切换时，高亮**立刻**落到目标行（不等快照），目标行图标换成转圈、
 *    副标题变「打开中…」；原来的当前行不再高亮。再点目标行不会重复发请求。
 *  - 遮罩：打开中显示目标标题；失败显示原因 + 重试 / 留下；「隐藏」只藏遮罩。
 *
 * 零 token、零端口：真 jsdom + 真 React 渲染。
 */

const CWD = "/work/project";
const P = (id: string) => `/sessions/${id}.jsonl`;

function conv(id: string, extra: Partial<ConversationSummary> = {}): ConversationSummary {
	return {
		id,
		title: `chat ${id}`,
		cwd: CWD,
		messageCount: 3,
		isStreaming: false,
		isSubagent: false,
		sessionPath: P(id),
		live: true,
		createdAt: 1000,
		...extra,
	};
}
function session(id: string): SessionSummary {
	return { path: P(id), name: `hist ${id}`, firstMessage: "", messageCount: 5, modified: 1000 };
}

let root: Root | null = null;
let sent: { type: string; [k: string]: unknown }[] = [];

function mountPanel(opts: {
	conversations?: ConversationSummary[];
	sessions?: SessionSummary[];
	activeId?: string;
	sessionFile?: string | null;
	pendingSwitch?: SwitchTarget | null;
}): HTMLDivElement {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(LeftPanel, {
					sessionFile: opts.sessionFile ?? null,
					conversations: opts.conversations ?? [],
					sessions: opts.sessions ?? [],
					elsewhere: [],
					projects: [],
					activeConversationId: opts.activeId ?? "",
					pendingSwitch: opts.pendingSwitch ?? null,
					panelSend: (msg: { type: string }) => {
						sent.push(msg as { type: string });
						return true;
					},
					active: true,
					collapsible: false,
					onToggleCollapse: () => {},
				} as unknown as Parameters<typeof LeftPanel>[0]),
			),
		);
	});
	return container;
}

function item(c: HTMLElement, title: string): HTMLElement {
	const el = Array.from(c.querySelectorAll<HTMLElement>(".session-item")).find((b) => b.textContent?.includes(title));
	expect(el, `row ${title}`).toBeTruthy();
	return el!;
}
function actions(): { type: string; [k: string]: unknown }[] {
	return sent.filter((m) => m.type !== "list_sessions" && m.type !== "list_projects");
}
function click(el: Element): void {
	act(() => {
		el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
}

beforeEach(() => {
	sent = [];
	setAppGlobals({ cwd: CWD, ready: true, status: "open" });
});
afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
	resetAppGlobals();
});

describe("左栏：切换进行中", () => {
	it("高亮立刻落到目标行，原当前行不再高亮；目标行转圈 + 「打开中…」", () => {
		const c = mountPanel({
			conversations: [conv("a"), conv("b")],
			activeId: "a",
			pendingSwitch: { kind: "conversation", id: "b" },
		});
		const a = item(c, "chat a");
		const b = item(c, "chat b");
		expect(b.classList.contains("active")).toBe(true);
		expect(b.classList.contains("opening")).toBe(true);
		expect(b.querySelector(".switch-spinner")).toBeTruthy();
		expect(b.querySelector(".session-sub")?.textContent).toMatch(/打开中|Opening/);
		expect(a.classList.contains("active")).toBe(false);
		expect(a.querySelector(".switch-spinner")).toBeNull();
	});

	it("没有进行中的切换时一切照旧：当前行高亮、无转圈", () => {
		const c = mountPanel({ conversations: [conv("a"), conv("b")], activeId: "a" });
		expect(item(c, "chat a").classList.contains("active")).toBe(true);
		expect(c.querySelector(".switch-spinner")).toBeNull();
		expect(c.querySelector(".opening")).toBeNull();
	});

	it("session 目标按转录路径认：历史行与常驻活行都能标上", () => {
		const c = mountPanel({
			conversations: [conv("a", { live: false })],
			sessions: [session("h")],
			activeId: "",
			sessionFile: P("x"),
			pendingSwitch: { kind: "session", path: P("h") },
		});
		expect(item(c, "hist h").classList.contains("opening")).toBe(true);
		expect(item(c, "chat a").classList.contains("opening")).toBe(false);
		// 换成常驻活行的路径 → 那一行标上。
		act(() => root!.unmount());
		root = null;
		document.body.innerHTML = "";
		const c2 = mountPanel({
			conversations: [conv("a", { live: false })],
			sessions: [session("h")],
			pendingSwitch: { kind: "session", path: P("a") },
		});
		expect(item(c2, "chat a").classList.contains("opening")).toBe(true);
		expect(item(c2, "hist h").classList.contains("opening")).toBe(false);
	});

	it("再点正在打开的那一行不会重复发请求（它已经是 active）", () => {
		const c = mountPanel({
			conversations: [conv("a"), conv("b")],
			activeId: "a",
			pendingSwitch: { kind: "conversation", id: "b" },
		});
		click(item(c, "chat b"));
		expect(actions()).toEqual([]);
		// 点别的行照常发。
		click(item(c, "chat a"));
		expect(actions()).toEqual([{ type: "switch_conversation", id: "a" }]);
	});
});

function mountOverlay(props: Parameters<typeof SwitchOverlay>[0]): HTMLDivElement {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(createElement(LanguageProvider, null, createElement(SwitchOverlay, props)));
	});
	return container;
}

describe("遮罩：打开中 / 失败", () => {
	it("打开中：显示目标标题，带转圈；「隐藏」回调", () => {
		let hidden = 0;
		const c = mountOverlay({
			pending: { target: { kind: "session", path: P("h") }, startedAt: Date.now(), hidden: false },
			error: null,
			title: "temper",
			onHide: () => hidden++,
			onRetry: () => {},
			onDismissError: () => {},
		});
		const overlay = c.querySelector<HTMLElement>(".switch-overlay");
		expect(overlay?.dataset.switchState).toBe("loading");
		expect(overlay?.textContent).toContain("temper");
		expect(overlay?.querySelector(".switch-spinner")).toBeTruthy();
		click(c.querySelector(".switch-hide")!);
		expect(hidden).toBe(1);
	});

	it("打开中但已隐藏：不渲染遮罩", () => {
		const c = mountOverlay({
			pending: { target: { kind: "session", path: P("h") }, startedAt: Date.now(), hidden: true },
			error: null,
			title: "temper",
			onHide: () => {},
			onRetry: () => {},
			onDismissError: () => {},
		});
		expect(c.querySelector(".switch-overlay")).toBeNull();
	});

	it("失败：标题 + 原因；重试 / 留下各自回调", () => {
		let retried = 0;
		let dismissed = 0;
		const c = mountOverlay({
			pending: null,
			error: { target: { kind: "session", path: P("h") }, error: "切换会话失败：EISDIR", errorEn: "Failed: EISDIR" },
			title: "temper",
			onHide: () => {},
			onRetry: () => retried++,
			onDismissError: () => dismissed++,
		});
		const overlay = c.querySelector<HTMLElement>(".switch-overlay");
		expect(overlay?.dataset.switchState).toBe("error");
		expect(overlay?.textContent).toContain("temper");
		expect(overlay?.querySelector(".switch-reason")?.textContent).toMatch(/EISDIR/);
		const buttons = Array.from(overlay!.querySelectorAll("button"));
		click(buttons.find((b) => b.classList.contains("primary"))!);
		expect(retried).toBe(1);
		click(buttons.find((b) => !b.classList.contains("primary"))!);
		expect(dismissed).toBe(1);
	});

	it("既没在打开也没失败：什么都不渲染", () => {
		const c = mountOverlay({
			pending: null,
			error: null,
			title: "",
			onHide: () => {},
			onRetry: () => {},
			onDismissError: () => {},
		});
		expect(c.querySelector(".switch-overlay")).toBeNull();
	});
});
