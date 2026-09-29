// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { LeftPanel } from "../../web/src/components/LeftPanel.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { resetAppGlobals, setAppGlobals } from "../../web/src/app-globals.js";

let root: Root | null = null;

/** 内存 localStorage：某些 jsdom/CI 环境的存储不可写，桩掉以保证语言确定为中文。 */
function stubZhStorage() {
	const store = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
		clear: () => store.clear(),
	} as unknown as Storage);
	localStorage.setItem("pi-web-ui:lang", "zh");
}

function mountLeftPanel(overrides: Record<string, unknown> = {}) {
	stubZhStorage();
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	const sent: unknown[] = [];
	const panelSend = (msg: unknown) => {
		sent.push(msg);
		return true;
	};
	const props = {
		active: true,
		sessionFile: null,
		conversations: [],
		elsewhere: [],
		sessions: [
			{
				path: "session-1.jsonl",
				name: "Test Session",
				firstMessage: "Hello",
				modified: Date.now(),
				messageCount: 1,
			},
		],
		activeConversationId: "",
		panelSend,
		...overrides,
	};
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				createElement(LeftPanel as any, props),
			),
		);
	});
	return { container, sent };
}

afterEach(() => {
	vi.unstubAllGlobals();
	resetAppGlobals();
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("LeftPanel 标题栏操作", () => {
	it("no-project-controls: no Recent projects section, no folder+ button, no project picker", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel();

		expect(container.querySelector(".panel-projects")).toBeNull();
		expect(container.querySelector(".lp-project-action")).toBeNull();
		expect(container.querySelector(".project-picker, .project-picker-backdrop")).toBeNull();
		expect(container.textContent).not.toContain("Recent projects");
		// The panel starts with the chat list: the first section is the history list here (no running chats).
		expect(container.querySelector(".lp-section")?.classList.contains("panel-sessions")).toBe(true);
	});

	it("“历史对话”标题栏渲染新对话加号按钮，点击后发送 new_chat 且不影响折叠状态", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container, sent } = mountLeftPanel();

		const newChatBtn = container.querySelector<HTMLButtonElement>(".lp-new-chat-action");
		expect(newChatBtn).toBeTruthy();
		expect(newChatBtn?.title).toBeTruthy();
		expect(newChatBtn?.getAttribute("aria-label")).toBeTruthy();

		const sessionsSection = container.querySelector(".panel-sessions");
		const wasCollapsed = sessionsSection?.classList.contains("collapsed");

		// 点击加号
		sent.length = 0;
		act(() => newChatBtn!.click());
		expect(sent).toEqual([{ type: "new_chat" }]);
		expect(sessionsSection?.classList.contains("collapsed")).toBe(wasCollapsed);
	});

	it("标题行容器与折叠按钮不产生嵌套 button（无 button button）", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel();

		// 保证没有嵌套按钮
		const nestedButtons = container.querySelectorAll("button button");
		expect(nestedButtons.length).toBe(0);
	});
});

describe("LeftPanel 会话行内嵌区", () => {
	const sectionEntry = (id: string, label: string, icon: string) => ({
		id,
		source: "host",
		slot: "leftpanel.sessions",
		label,
		kind: "action",
		icon,
		order: 10,
		align: "start",
		hidden: false,
		userOverrides: [],
		arrangedBy: [],
	});

	it("分区别名条目不进会话行（行内无 activity/clock 原文）；插件行动作正常渲染", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({
			uiLeftSessions: [
				sectionEntry("host:lp-running", "运行的对话", "activity"),
				sectionEntry("host:lp-history", "历史对话", "clock"),
				{
					id: "plug:x:go",
					source: "plugin:x",
					slot: "leftpanel.sessions",
					label: "Go",
					kind: "action",
					order: 100,
					align: "start",
					hidden: false,
					userOverrides: [],
					arrangedBy: [],
				},
			],
		});
		const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>(".lp-slot-btn"));
		// 只有插件那一条；分区别名两条被过滤（以前会按原文画出 activity/clock）
		expect(buttons).toHaveLength(1);
		expect(buttons[0]?.getAttribute("aria-label")).toBe("Go");
		expect(buttons.every((b) => !/activity|clock/.test(b.textContent ?? ""))).toBe(true);
	});

	it("内嵌区为空时不留 .lp-slot-sessions 占位（会话行 DOM 与旧版一致）", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({
			uiLeftSessions: [
				sectionEntry("host:lp-running", "运行的对话", "activity"),
				sectionEntry("host:lp-history", "历史对话", "clock"),
			],
		});
		expect(container.querySelector(".lp-slot-sessions")).toBeNull();
		expect(container.querySelector(".lp-slot-btn")).toBeNull();
	});
});
