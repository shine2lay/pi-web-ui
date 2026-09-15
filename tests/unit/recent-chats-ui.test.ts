// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { LeftPanel } from "../../web/src/components/LeftPanel.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { resetAppGlobals, setAppGlobals } from "../../web/src/app-globals.js";
import type { ConversationSummary } from "../../server/protocol.js";

/**
 * 左栏「最近对话」的**前端**行为（recent-chats 补丁）。
 *
 *  - 状态灯：跑着 = 黄灯闪（`.conv-running`）、跑完没看 = 绿灯常亮（`.conv-waiting`）、
 *    看过/没事 = 不点灯。同一行永远只有一盏（两种状态互斥）。
 *  - 常驻行（`live: false`，运行时已释放）：点开走 `switch_session`（带转录路径），
 *    ✕ 走 `remove_recent_chat`（两段确认），**不会**发 `dismiss_conversation`。
 *  - 活着的行：点开仍走 `switch_conversation`，✕ 仍走原来的 `dismiss_conversation`。
 *
 * 零 token、零端口：真 jsdom + 真 React 渲染，只断言 DOM 与发出的消息。
 */

const CWD = "/work/project";

function row(id: string, extra: Partial<ConversationSummary> = {}): ConversationSummary {
	return {
		id,
		title: `chat ${id}`,
		cwd: CWD,
		messageCount: 3,
		isStreaming: false,
		isSubagent: false,
		sessionPath: `/sessions/${id}.jsonl`,
		live: true,
		waiting: false,
		...extra,
	};
}

let root: Root | null = null;
let sent: { type: string; [k: string]: unknown }[] = [];

function mount(conversations: ConversationSummary[], activeId = ""): HTMLDivElement {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(LeftPanel, {
					sessionFile: null,
					conversations,
					sessions: [],
					// 上游 #145：左栏还会渲染其他标签页/设备的只读运行行；本用例只看本客户端。
					elsewhere: [],
					projects: [],
					activeConversationId: activeId,
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

/** 该行的行容器（.lp-row）。 */
function rowEl(c: HTMLElement, title: string): HTMLElement {
	const item = Array.from(c.querySelectorAll<HTMLElement>(".session-item")).find((b) => b.textContent?.includes(title));
	expect(item, `row ${title}`).toBeTruthy();
	return item!.closest(".lp-row") as HTMLElement;
}

/** 面板挂载时会自己拉一次会话/项目列表（懒加载）—— 断言只看点击产生的消息。 */
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

describe("最近对话：状态灯", () => {
	it("跑着的行点黄灯（闪），不是绿灯", () => {
		const c = mount([row("a", { isStreaming: true })]);
		const dots = rowEl(c, "chat a").querySelectorAll(".conv-dot");
		expect(dots).toHaveLength(1);
		expect(dots[0].classList.contains("conv-running")).toBe(true);
		expect(dots[0].classList.contains("conv-waiting")).toBe(false);
	});

	it("跑完没看过的行点绿灯（常亮）", () => {
		const c = mount([row("a", { waiting: true })]);
		const dots = rowEl(c, "chat a").querySelectorAll(".conv-dot");
		expect(dots).toHaveLength(1);
		expect(dots[0].classList.contains("conv-waiting")).toBe(true);
	});

	it("既不跑也没在等 → 不点灯", () => {
		const c = mount([row("a")]);
		expect(rowEl(c, "chat a").querySelectorAll(".conv-dot")).toHaveLength(0);
	});

	it("常驻历史行也能点绿灯（运行时已释放，状态不丢）", () => {
		const c = mount([row("old", { live: false, waiting: true })]);
		expect(rowEl(c, "chat old").querySelectorAll(".conv-waiting")).toHaveLength(1);
	});
});

describe("最近对话：常驻行的点击与移出", () => {
	it("点常驻行 → switch_session（带转录路径），不是 switch_conversation", () => {
		const c = mount([row("old", { live: false })]);
		click(rowEl(c, "chat old").querySelector(".session-item")!);
		expect(actions()).toEqual([{ type: "switch_session", path: "/sessions/old.jsonl" }]);
	});

	it("点活着的行 → 仍走 switch_conversation", () => {
		const c = mount([row("a")]);
		click(rowEl(c, "chat a").querySelector(".session-item")!);
		expect(actions()).toEqual([{ type: "switch_conversation", id: "a" }]);
	});

	it("常驻行 ✕：两段确认后发 remove_recent_chat（不发 dismiss_conversation）", () => {
		const c = mount([row("old", { live: false })]);
		const del = rowEl(c, "chat old").querySelector(".lp-del:not(.lp-rename)")!;
		click(del); // 第一下只是上膛
		expect(actions()).toEqual([]);
		click(rowEl(c, "chat old").querySelector(".lp-del:not(.lp-rename)")!);
		expect(actions()).toEqual([{ type: "remove_recent_chat", path: "/sessions/old.jsonl" }]);
	});

	it("活着的空闲行 ✕：仍是原来的 dismiss_conversation", () => {
		const c = mount([row("a")]);
		click(rowEl(c, "chat a").querySelector(".lp-del:not(.lp-rename)")!);
		click(rowEl(c, "chat a").querySelector(".lp-del:not(.lp-rename)")!);
		expect(actions()).toEqual([{ type: "dismiss_conversation", id: "a" }]);
	});
});
