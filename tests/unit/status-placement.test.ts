import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_PINNED_STATUSES,
	MAX_PINNED_STATUSES,
	STATUS_PLACEMENT_KEY,
	loadPinnedStatuses,
	normalizePinnedStatuses,
	resetPinnedStatusesCache,
	savePinnedStatuses,
	splitStatuses,
	togglePinnedStatus,
	type UiStatusEntry,
} from "../../web/src/status-placement.js";

/**
 * 扩展状态条的摆放（底栏 ↔ 右栏底部）的纯逻辑。
 *
 * 底栏原本把所有 `ctx.ui.setStatus` 一股脑拼成一行，装几个扩展就被挤爆
 * （mcp / pi-control-chrome / multi-pass 模型链 / subagent-slash…），真正要盯的
 * 配额余量反而看不见。现在按 key 记「钉住」列表：钉住的进底栏，其余进右栏底部。
 *
 * 零 token、零端口：只测纯函数与 localStorage 存取。
 */

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

beforeEach(() => {
	store.clear();
	(globalThis as unknown as { localStorage: Storage }).localStorage = fakeLocalStorage;
	resetPinnedStatusesCache();
});

afterEach(() => {
	store.clear();
	resetPinnedStatusesCache();
});

/** 显式给 text —— 不能用默认参数，否则传 undefined（扩展撤销状态）会被默认值吞掉。 */
const s = (key: string, text: string | undefined): UiStatusEntry => ({ key, text });

describe("normalizePinnedStatuses", () => {
	it("非数组回退默认值（首次使用 = 只钉配额那条）", () => {
		expect(normalizePinnedStatuses(undefined)).toEqual([...DEFAULT_PINNED_STATUSES]);
		expect(normalizePinnedStatuses("multi-pass-limits")).toEqual([...DEFAULT_PINNED_STATUSES]);
		expect(normalizePinnedStatuses(null)).toEqual([...DEFAULT_PINNED_STATUSES]);
	});

	it("空数组是合法的「一条都不钉」，不会被当成坏数据顶回默认值", () => {
		expect(normalizePinnedStatuses([])).toEqual([]);
	});

	it("丢掉非字符串/空串、去重、去空白，并截断到上限", () => {
		expect(normalizePinnedStatuses(["a", 2, "", "  ", " b ", "a", null])).toEqual(["a", "b"]);
		const many = Array.from({ length: MAX_PINNED_STATUSES + 5 }, (_, i) => `k${i}`);
		expect(normalizePinnedStatuses(many)).toHaveLength(MAX_PINNED_STATUSES);
	});
});

describe("splitStatuses", () => {
	const statuses = [
		s("mcp", "MCP: 1 server enabled"),
		s("pi-control-chrome", "ready"),
		s("multi-pass-limits", "7d 61% left"),
		s("multi-pass", "chain:fable-chain"),
	];

	it("钉住的进底栏，其余进右栏", () => {
		const { bar, panel } = splitStatuses(statuses, ["multi-pass-limits"]);
		expect(bar.map((x) => x.key)).toEqual(["multi-pass-limits"]);
		expect(panel.map((x) => x.key)).toEqual(["mcp", "pi-control-chrome", "multi-pass"]);
	});

	it("底栏顺序跟随钉住列表，右栏保持服务端推送顺序", () => {
		const { bar, panel } = splitStatuses(statuses, ["multi-pass", "mcp"]);
		expect(bar.map((x) => x.key)).toEqual(["multi-pass", "mcp"]);
		expect(panel.map((x) => x.key)).toEqual(["pi-control-chrome", "multi-pass-limits"]);
	});

	it("扩展撤销的状态（text 空/空白）两边都不显示", () => {
		const withEmpty = [s("mcp", undefined), s("pi-control-chrome", "   "), s("multi-pass-limits", "7d 61% left")];
		const { bar, panel } = splitStatuses(withEmpty, ["mcp", "multi-pass-limits"]);
		expect(bar.map((x) => x.key)).toEqual(["multi-pass-limits"]);
		expect(panel).toEqual([]);
	});

	it("钉了一个当前不存在的 key 不会报错，也不会占位", () => {
		const { bar, panel } = splitStatuses([s("mcp", "MCP: 1 server enabled")], ["not-installed-yet", "mcp"]);
		expect(bar.map((x) => x.key)).toEqual(["mcp"]);
		expect(panel).toEqual([]);
	});

	it("一条都不钉 = 全部进右栏（底栏彻底清爽）", () => {
		const { bar, panel } = splitStatuses(statuses, []);
		expect(bar).toEqual([]);
		expect(panel).toHaveLength(4);
	});
});

describe("持久化与切换", () => {
	it("没存过 → 默认钉住配额那条（开箱即用）", () => {
		expect(loadPinnedStatuses()).toEqual([...DEFAULT_PINNED_STATUSES]);
	});

	it("存过空列表 → 尊重用户的「一条都不钉」，不再回落默认值", () => {
		savePinnedStatuses([]);
		resetPinnedStatusesCache();
		expect(loadPinnedStatuses()).toEqual([]);
	});

	it("坏 JSON 回退默认值，不抛错", () => {
		store.set(STATUS_PLACEMENT_KEY, "{not json");
		expect(loadPinnedStatuses()).toEqual([...DEFAULT_PINNED_STATUSES]);
	});

	it("toggle 来回切换并落盘", () => {
		savePinnedStatuses([]);
		expect(togglePinnedStatus("mcp")).toEqual(["mcp"]);
		expect(JSON.parse(store.get(STATUS_PLACEMENT_KEY)!)).toEqual(["mcp"]);
		expect(togglePinnedStatus("multi-pass-limits")).toEqual(["mcp", "multi-pass-limits"]);
		expect(togglePinnedStatus("mcp")).toEqual(["multi-pass-limits"]);
		resetPinnedStatusesCache();
		expect(loadPinnedStatuses()).toEqual(["multi-pass-limits"]);
	});

	it("空 key 是 no-op", () => {
		savePinnedStatuses(["mcp"]);
		expect(togglePinnedStatus("   ")).toEqual(["mcp"]);
	});

	it("localStorage 写不进去（隐私模式）时本次会话仍然生效", () => {
		savePinnedStatuses([]);
		(globalThis as unknown as { localStorage: Storage }).localStorage = {
			...fakeLocalStorage,
			setItem: () => {
				throw new Error("QuotaExceededError");
			},
		} as Storage;
		expect(() => togglePinnedStatus("mcp")).not.toThrow();
		expect(togglePinnedStatus("pi-control-chrome")).toEqual(["mcp", "pi-control-chrome"]);
	});
});

/**
 * 底栏钉住的状态**不许被剪掉**（静态 CSS 体检，零浏览器）。
 *
 * 原实现给 `.ext-status-pinned` 加了 `max-width: 42ch` + 省略号单行：配额文本一旦
 * 变长（`reset-countdown` 把「reset 09-19 11:13Z」扩成「resets in 4d 15h (…)」），
 * 被藏掉的恰恰是末尾的重置时间 —— 而那正是钉住它的理由。现在改成装不下就折行：
 * 底栏整体 `flex-wrap: wrap`，该项 `white-space: normal` + `overflow-wrap: anywhere`。
 */
describe("底栏状态的换行（不剪字）", () => {
	const css = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "src", "styles.css"),
		"utf8",
	);
	const block = (selector: string): string => {
		const start = css.indexOf(`${selector} {`);
		expect(start, `${selector} 规则应存在`).toBeGreaterThan(-1);
		return css.slice(start, css.indexOf("}", start));
	};

	it("钉住的状态项：折行显示，不再用省略号截断", () => {
		const rule = block(".ext-status-pinned");
		expect(rule).toMatch(/white-space:\s*normal/);
		expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
		expect(rule).not.toMatch(/text-overflow:\s*ellipsis/);
		expect(rule).not.toMatch(/white-space:\s*nowrap/);
		expect(rule).not.toMatch(/max-width:\s*\d+ch/);
	});

	it("底栏本身允许换行（装不下就多一行，而不是剪掉后面几项）", () => {
		expect(block(".statusbar")).toMatch(/flex-wrap:\s*wrap/);
	});
});
