/// <reference lib="dom" />
/**
 * 扩展状态条（`ctx.ui.setStatus`）的**摆放位置**：底栏 or 右栏底部。
 *
 * 底栏原本把所有扩展状态一股脑拼在一行（`statuses.map(s => s.text).join(" · ")`）：
 * 装的扩展一多（`mcp`「1 server enabled」、`pi-control-chrome`「ready」、
 * `multi-pass` 的模型链、`subagent-slash`…）底栏就被挤爆，真正想盯的那条
 * （配额余量）反而被推到看不见。
 *
 * 规则很简单：**钉住的进底栏，其余进右栏底部**（与 widgets 同一块区域）。
 * 每条状态自带稳定的 `key`（扩展注册时给的），所以这里只存 key 列表，
 * 不关心具体是哪个扩展 —— 以后装新扩展照样适用。
 *
 * 右栏收起时未钉住的状态就是不显示（用户选的语义：要看就把右栏拉开），
 * 所以**钉住的那几条是「无论如何都要能看见」的东西**。
 *
 * 与 title-settings.ts / chat-width-settings.ts 同构：纯浏览器端偏好，
 * 不进 server 快照；纯函数部分有单测（tests/unit/status-placement.test.ts）。
 */

import { useSyncExternalStore } from "react";

export const STATUS_PLACEMENT_KEY = "pi-web-ui:statusbar-pinned";

/** 一条扩展状态（协议里的 `statuses` 元素，text 为空表示该状态已撤销）。 */
export interface UiStatusEntry {
	key: string;
	text: string | undefined;
}

/**
 * 首次使用时钉在底栏的 key。
 *
 * 只种一条：配额/余量（multi-pass 的 `multi-pass-limits`）—— 这是唯一一条
 * 「不看会踩坑」的状态（模型跑到限额才发现就晚了）。其余状态默认进右栏，
 * 用户点一下图钉就能改，改完存 localStorage，不再受这个默认值影响。
 */
export const DEFAULT_PINNED_STATUSES: readonly string[] = ["multi-pass-limits"];

/** 上限：底栏就那么宽，钉太多等于没整理。 */
export const MAX_PINNED_STATUSES = 8;

/** 规整存储值：非数组/非字符串项/空串一律丢弃，去重并截断到上限。 */
export function normalizePinnedStatuses(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [...DEFAULT_PINNED_STATUSES];
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const key = item.trim();
		if (!key || out.includes(key)) continue;
		out.push(key);
		if (out.length >= MAX_PINNED_STATUSES) break;
	}
	return out;
}

/**
 * 按钉住列表把状态分成「底栏」与「右栏」两组。
 *
 * - 文本为空的状态（扩展撤销了它）两边都不显示；
 * - 底栏顺序跟随**钉住列表**（用户钉的先后），右栏保持服务端推送的原顺序。
 */
export function splitStatuses(
	statuses: readonly UiStatusEntry[],
	pinned: readonly string[],
): { bar: UiStatusEntry[]; panel: UiStatusEntry[] } {
	const live = statuses.filter((s) => typeof s.text === "string" && s.text.trim().length > 0);
	const byKey = new Map(live.map((s) => [s.key, s]));
	const bar: UiStatusEntry[] = [];
	for (const key of pinned) {
		const hit = byKey.get(key);
		if (hit) bar.push(hit);
	}
	const pinnedSet = new Set(pinned);
	return { bar, panel: live.filter((s) => !pinnedSet.has(s.key)) };
}

/** 读取持久化的钉住列表（localStorage 不可用 / 数据损坏时回退默认值）。 */
export function loadPinnedStatuses(): string[] {
	try {
		const raw = localStorage.getItem(STATUS_PLACEMENT_KEY);
		if (raw === null) return [...DEFAULT_PINNED_STATUSES];
		return normalizePinnedStatuses(JSON.parse(raw));
	} catch {
		return [...DEFAULT_PINNED_STATUSES];
	}
}

/** 保存并广播变更（localStorage 不可写时仍然更新内存值，本次会话照样生效）。 */
export function savePinnedStatuses(keys: readonly string[]): void {
	const norm = normalizePinnedStatuses(keys);
	try {
		localStorage.setItem(STATUS_PLACEMENT_KEY, JSON.stringify(norm));
	} catch {
		/* 隐私模式 / 配额满：只丢持久化，不丢本次会话的选择 */
	}
	cached = norm;
	for (const l of listeners) l();
}

/** 钉住/取消钉住一条状态（底栏 ↔ 右栏底部）。返回新的钉住列表。 */
export function togglePinnedStatus(key: string): string[] {
	const trimmed = key.trim();
	if (!trimmed) return getPinned();
	const cur = getPinned();
	const next = cur.includes(trimmed) ? cur.filter((k) => k !== trimmed) : [...cur, trimmed];
	savePinnedStatuses(next);
	return getPinned();
}

// ---- 订阅：单例 listener 集合（与 title-settings.ts 同款）。------------------

let cached: string[] | null = null;
const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void): () => void {
	listeners.add(onStoreChange);
	return () => {
		listeners.delete(onStoreChange);
	};
}

/** 当前钉住列表（引用稳定：useSyncExternalStore 要求同值同引用）。 */
function getPinned(): string[] {
	if (!cached) cached = loadPinnedStatuses();
	return cached;
}

/** 测试用：丢掉内存缓存，下次读重新走 localStorage。 */
export function resetPinnedStatusesCache(): void {
	cached = null;
	for (const l of listeners) l();
}

/** 订阅钉住列表（图钉点完即时生效，两处组件同步换位）。 */
export function usePinnedStatuses(): string[] {
	return useSyncExternalStore(subscribe, getPinned);
}
