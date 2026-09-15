// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * clientId 的唯一要求：**两个窗口永远不会共用一个**。
 *
 * 后端按 clientId 建 ClientSession，id 相同 = 两个窗口挂到同一个会话上互为镜像
 * （一边切对话另一边跟着变，甚至中断对方正在输出的 run，issue #10）。
 * localStorage 明显不行；sessionStorage 也不够——「复制标签页」/ Ctrl-点链接 /
 * 恢复上次会话都会把 sessionStorage 一起克隆，两个窗口又拿到同一个 id。
 *
 * 所以：每次页面加载现生一个，不落任何存储。刷新后不再自动回到上次那条对话，
 * 这是**刻意接受**的代价（对话仍在服务端跑着，左栏「最近对话」点回去即可）。
 */

const load = async () => {
	vi.resetModules();
	return (await import("../../web/src/use-chat")).getClientId;
};

let storageWrites: string[] = [];

/** 这个 jsdom 环境里可能没有 localStorage / sessionStorage（Node 26 自带的那个要
 *  --localstorage-file，见 status-placement-ui.test.ts），缺了就自己插一个，setItem 照样能被 spy。 */
function makeStorage(): Storage {
	const store = new Map<string, string>();
	return {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
		clear: () => store.clear(),
		key: (i: number) => [...store.keys()][i] ?? null,
		get length() {
			return store.size;
		},
	} as Storage;
}

beforeEach(() => {
	storageWrites = [];
	const w = window as unknown as { localStorage?: Storage; sessionStorage?: Storage };
	if (!w.localStorage) w.localStorage = makeStorage();
	if (!w.sessionStorage) w.sessionStorage = makeStorage();
	for (const store of [window.localStorage, window.sessionStorage]) {
		store.clear();
		vi.spyOn(store, "setItem").mockImplementation((k: string) => {
			storageWrites.push(k);
		});
	}
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("getClientId", () => {
	it("同一次页面加载内稳定（同一个窗口就是同一个客户端）", async () => {
		const getClientId = await load();
		expect(getClientId()).toBe(getClientId());
		expect(getClientId()).toMatch(/[0-9a-f-]{16,}/i);
	});

	it("另一次页面加载拿到不同的 id（复制标签页也撞不上）", async () => {
		const first = (await load())();
		const second = (await load())();
		expect(second).not.toBe(first);
	});

	it("不写 localStorage / sessionStorage —— 存储里没有可被克隆的身份", async () => {
		(await load())();
		expect(storageWrites.filter((k) => k.includes("client"))).toEqual([]);
	});

	it("存储被禁用（隐私模式）也照常工作", async () => {
		for (const store of [window.localStorage, window.sessionStorage]) {
			vi.spyOn(store, "getItem").mockImplementation(() => {
				throw new Error("SecurityError");
			});
		}
		const getClientId = await load();
		expect(() => getClientId()).not.toThrow();
		expect(getClientId()).toBeTruthy();
	});
});
