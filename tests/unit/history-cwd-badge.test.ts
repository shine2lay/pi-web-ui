// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { LeftPanel } from "../../web/src/components/LeftPanel.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { resetAppGlobals, setAppGlobals } from "../../web/src/app-globals.js";
import type { SessionSummary } from "../../server/protocol.js";

/**
 * 左栏 History 的**文件夹徽章**（配合服务端 historyScope="all"）。
 *
 * History 现在跨文件夹列出全部对话，所以一条记录光看标题分不出它属于哪个项目。
 * 规则只有一条：**只有** `cwd` 与当前工作目录不同的行才加徽章（同目录的加了是
 * 噪音），徽章显示文件夹名、`title` 是完整路径。服务端没发 `cwd`（旧服务端 /
 * 未打补丁）时整条渲染不出徽章 —— 前端改动对老服务端无害。
 *
 * 零 token、零端口：真 jsdom + 真 React 渲染，只断言 DOM。
 */

const CURRENT = "/Users/me/work/current-project";

function session(path: string, cwd?: string): SessionSummary {
	return {
		path,
		firstMessage: `chat ${path}`,
		messageCount: 3,
		modified: Date.now(),
		source: "web",
		...(cwd === undefined ? {} : { cwd }),
	};
}

let root: Root | null = null;

function mount(sessions: SessionSummary[]): HTMLDivElement {
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
					conversations: [],
					sessions,
					// 上游 #145：左栏还会渲染其他标签页/设备的只读运行行；本用例只看本客户端。
					elsewhere: [],
					projects: [],
					activeConversationId: "",
					panelSend: () => true,
					active: true,
					collapsible: false,
					onToggleCollapse: () => {},
				} as unknown as Parameters<typeof LeftPanel>[0]),
			),
		);
	});
	return container;
}

beforeEach(() => {
	setAppGlobals({ cwd: CURRENT, ready: true, status: "open" });
});

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
	resetAppGlobals();
});

const badges = (c: HTMLElement): HTMLElement[] => Array.from(c.querySelectorAll<HTMLElement>(".session-cwd"));

describe("History 的文件夹徽章", () => {
	it("别的文件夹的对话：显示文件夹名，悬停给完整路径", () => {
		const container = mount([session("/s/other.jsonl", "/Users/me/work/pi-multi-pass")]);
		const [badge] = badges(container);
		expect(badge).toBeTruthy();
		expect(badge.textContent).toBe("pi-multi-pass");
		expect(badge.title).toBe("/Users/me/work/pi-multi-pass");
		// 复用 .session-src 的外观，另加 .session-cwd 关掉大写化（文件夹名要原样）。
		expect(badge.classList.contains("session-src")).toBe(true);
	});

	it("当前文件夹的对话不加徽章（同目录加了是噪音）", () => {
		const container = mount([session("/s/here.jsonl", CURRENT)]);
		expect(badges(container)).toHaveLength(0);
	});

	it("服务端没发 cwd（旧服务端）时整条不加徽章", () => {
		const container = mount([session("/s/legacy.jsonl")]);
		expect(badges(container)).toHaveLength(0);
	});

	it("混合列表：只给不属于当前工作目录的行加徽章", () => {
		const container = mount([
			session("/s/a.jsonl", CURRENT),
			session("/s/b.jsonl", "/Users/me/work/alpha"),
			session("/s/c.jsonl", "/Users/me/work/beta"),
			session("/s/d.jsonl"),
		]);
		expect(badges(container).map((b) => b.textContent)).toEqual(["alpha", "beta"]);
		expect(container.querySelectorAll(".session-item")).toHaveLength(4);
	});

	it("切换当前工作目录后，徽章跟着换边", () => {
		const container = mount([session("/s/a.jsonl", CURRENT), session("/s/b.jsonl", "/Users/me/work/alpha")]);
		expect(badges(container).map((b) => b.textContent)).toEqual(["alpha"]);
		act(() => setAppGlobals({ cwd: "/Users/me/work/alpha" }));
		expect(badges(container).map((b) => b.textContent)).toEqual(["current-project"]);
	});
});
