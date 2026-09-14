// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { FooterBar } from "../../web/src/components/FooterBar.js";
import { RightPanel } from "../../web/src/components/RightPanel.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { resetAppGlobals, setAppGlobals } from "../../web/src/app-globals.js";
import { resetPinnedStatusesCache, savePinnedStatuses } from "../../web/src/status-placement.js";
import type { ChatState } from "../../web/src/use-chat.js";

/**
 * 扩展状态条在**两个组件**之间的分流（底栏 ↔ 右栏底部）。
 *
 * 装的扩展一多（mcp / pi-control-chrome / multi-pass 模型链 / subagent-slash…），
 * 底栏原来把它们全拼成一行，真正要盯的配额余量被挤没。现在：钉住的留底栏、
 * 其余落右栏底部，点一下就换边。这条用例锁住「同一批状态在两处不重不漏」。
 *
 * 零 token、零端口：真 jsdom + 真 React 渲染，只断言 DOM 与点击回调。
 */

const STATUSES = [
	{ key: "mcp", text: "MCP: 1 server enabled" },
	{ key: "pi-control-chrome", text: "chrome ready" },
	{ key: "multi-pass", text: "chain:fable-chain | starts claude -> claude-fable-5-1" },
	{ key: "multi-pass-limits", text: "gpt-6-astra (account): 7d 61% left, reset 09-19 11:13Z" },
];

/** FooterBar 只读快照的这几块（stats / queue / cwd）+ ready + statuses。 */
const chatStub = {
	ready: true,
	statuses: STATUSES,
	pathCompletions: [],
	state: {
		cwd: "/tmp/project",
		isStreaming: false,
		queue: { steering: [], followUp: [] },
		stats: {
			cost: 0,
			totalMessages: 3,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			contextUsage: { tokens: null, percent: null, contextWindow: 200000, estimated: false },
		},
	},
} as unknown as ChatState;

/** 这个 jsdom 环境里没有可用的 localStorage（Node 26 自带的那个要 --localstorage-file），
 *  自己插一个，顺便让断言能直接看落盘的值。上游 v0.94 的 jsdom 把 window.localStorage
 *  做成只有 getter 的属性，直接赋值会抛错，所以走 vi.stubGlobal（同上游 footerbar-status.test.ts）。 */
const store = new Map<string, string>();
const fakeLocalStorage = {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
	removeItem: (k: string) => void store.delete(k),
	clear: () => store.clear(),
	key: (i: number) => [...store.keys()][i] ?? null,
	get length() {
		return store.size;
	},
} as Storage;

let root: Root | null = null;

function render(node: ReturnType<typeof createElement>): HTMLDivElement {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(createElement(LanguageProvider, null, node));
	});
	return container;
}

const footer = (): ReturnType<typeof createElement> => createElement(FooterBar, { chat: chatStub });
const rightPanel = (): ReturnType<typeof createElement> =>
	createElement(RightPanel, {
		files: null,
		fileChanged: null,
		widgets: [],
		statuses: STATUSES,
		panelSend: () => true,
		onAttach: () => {},
		onPreview: () => {},
		onNotice: () => {},
	} as unknown as Parameters<typeof RightPanel>[0]);

const barTexts = (c: HTMLElement): string[] =>
	Array.from(c.querySelectorAll<HTMLElement>(".ext-status")).map((e) => e.textContent ?? "");
const panelKeys = (c: HTMLElement): string[] =>
	Array.from(c.querySelectorAll<HTMLElement>(".widget-status .widget-title span")).map((e) => e.textContent ?? "");

beforeEach(() => {
	store.clear();
	vi.stubGlobal("localStorage", fakeLocalStorage);
	setAppGlobals({ cwd: "/tmp/project", ready: true, status: "open", engine: "pi" });
	resetPinnedStatusesCache();
});

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
	resetAppGlobals();
	store.clear();
	resetPinnedStatusesCache();
	vi.unstubAllGlobals();
});

describe("状态条分流：底栏 ↔ 右栏底部", () => {
	it("默认：底栏只剩配额那条，mcp/chrome/模型链都在右栏", () => {
		const bar = render(footer());
		expect(barTexts(bar)).toEqual(["gpt-6-astra (account): 7d 61% left, reset 09-19 11:13Z"]);
		act(() => root!.unmount());
		root = null;
		document.body.innerHTML = "";

		const panel = render(rightPanel());
		expect(panelKeys(panel)).toEqual(["mcp", "pi-control-chrome", "multi-pass"]);
		// 右栏底部区域真的出现了（原本 widgets 为空时整块不渲染）
		expect(panel.querySelector(".panel-widgets")).toBeTruthy();
	});

	it("一条都不钉：底栏不显示任何扩展状态，右栏收下全部 4 条", () => {
		savePinnedStatuses([]);
		const bar = render(footer());
		expect(barTexts(bar)).toEqual([]);
		act(() => root!.unmount());
		root = null;
		document.body.innerHTML = "";

		const panel = render(rightPanel());
		expect(panelKeys(panel)).toEqual(["mcp", "pi-control-chrome", "multi-pass", "multi-pass-limits"]);
	});

	it("点底栏那条 → 收进右栏（同一次会话内即时生效）", () => {
		const bar = render(footer());
		const chip = bar.querySelector<HTMLButtonElement>(".ext-status-pinned")!;
		expect(chip.title).toContain("multi-pass-limits");
		act(() => chip.click());
		expect(barTexts(bar)).toEqual([]);
	});

	it("点右栏卡片标题 → 钉回底栏", () => {
		savePinnedStatuses([]);
		const panel = render(rightPanel());
		const titles = Array.from(panel.querySelectorAll<HTMLButtonElement>(".widget-status .widget-title-btn"));
		const limits = titles.find((b) => b.textContent?.includes("multi-pass-limits"))!;
		act(() => limits.click());
		expect(panelKeys(panel)).toEqual(["mcp", "pi-control-chrome", "multi-pass"]);
		expect(JSON.parse(store.get("pi-web-ui:statusbar-pinned")!)).toEqual(["multi-pass-limits"]);
	});

	it("右栏卡片显示状态全文（底栏那条则单行省略，靠 title 看全）", () => {
		savePinnedStatuses([]);
		const panel = render(rightPanel());
		const body = panel.querySelector<HTMLElement>(".widget-status .widget-lines")!;
		expect(body.textContent).toBe("MCP: 1 server enabled");
	});
});
