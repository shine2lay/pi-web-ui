/**
 * 品牌二合一的偏好迁移（host:brand-logo / host:brand-name → host:brand）。
 *
 * 从 ui-slots.ts 原样拆出（Ops #1090：给顶栏的提问铃铛腾地方，不让那个文件变大 —— Rule 23 的
 * 500 行上限 / wt check 的 legacy ratchet）。行为与写在原文件里完全一致。
 */
import type { UiAlign, UiLayoutPrefs } from "./types";

/** 品牌旧 id（已合并为 `host:brand`，此处仅做偏好迁移用）。 */
export const BRAND_ITEM_ID = "host:brand";
export const BRAND_OLD_IDS: readonly string[] = ["host:brand-logo", "host:brand-name"];

/**
 * 品牌二合一迁移（host:brand-logo/host:brand-name → host:brand）。
 * 服务端持久层（normalizeUiLayout）已做同口径迁移，这里再兜一层 —— 内存里的旧偏好
 * 与单测直调 buildUiSlots 时同样生效。规则：列表去重映射；align/groups 跟 logo 的值、
 * labels 跟名称的值；显式写在新 id 上的值永远赢。纯函数：不改入参。
 */
export function migrateBrandLayout<T extends UiLayoutPrefs>(src: T): T {
	const hasOld =
		(src.hidden ?? []).some((id) => BRAND_OLD_IDS.includes(id)) ||
		(src.shown ?? []).some((id) => BRAND_OLD_IDS.includes(id)) ||
		(src.order ?? []).some((id) => BRAND_OLD_IDS.includes(id)) ||
		BRAND_OLD_IDS.some((id) => src.align?.[id] !== undefined) ||
		BRAND_OLD_IDS.some((id) => src.groups?.[id] !== undefined) ||
		BRAND_OLD_IDS.some((id) => src.labels?.[id] !== undefined);
	if (!hasOld) return src;
	const mapList = (list: string[] | undefined): string[] | undefined => {
		if (!list) return undefined;
		const out: string[] = [];
		for (const id of list) {
			const mapped = BRAND_OLD_IDS.includes(id) ? BRAND_ITEM_ID : id;
			if (!out.includes(mapped)) out.push(mapped);
		}
		return out;
	};
	const foldDict = (
		dict: Record<string, string> | undefined,
		logoFirst: boolean,
	): Record<string, string> | undefined => {
		if (!dict) return undefined;
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(dict)) {
			if (BRAND_OLD_IDS.includes(k)) continue;
			out[k] = v;
		}
		if (out[BRAND_ITEM_ID] === undefined) {
			const picked = logoFirst
				? (dict[BRAND_OLD_IDS[0]!] ?? dict[BRAND_OLD_IDS[1]!])
				: (dict[BRAND_OLD_IDS[1]!] ?? dict[BRAND_OLD_IDS[0]!]);
			if (picked !== undefined) out[BRAND_ITEM_ID] = picked;
		}
		return out;
	};
	const foldAlign = (dict: Record<string, UiAlign> | undefined): Record<string, UiAlign> | undefined => {
		if (!dict) return undefined;
		const out: Record<string, UiAlign> = {};
		for (const [k, v] of Object.entries(dict)) {
			if (BRAND_OLD_IDS.includes(k)) continue;
			out[k] = v;
		}
		if (out[BRAND_ITEM_ID] === undefined) {
			const picked = dict[BRAND_OLD_IDS[0]!] ?? dict[BRAND_OLD_IDS[1]!];
			if (picked !== undefined) out[BRAND_ITEM_ID] = picked;
		}
		return out;
	};
	return {
		...src,
		...(src.hidden ? { hidden: mapList(src.hidden) } : {}),
		...(src.shown ? { shown: mapList(src.shown) } : {}),
		...(src.order ? { order: mapList(src.order) } : {}),
		...(src.groups ? { groups: foldDict(src.groups, true) } : {}),
		...(src.labels ? { labels: foldDict(src.labels, false) } : {}),
		...(src.align ? { align: foldAlign(src.align) } : {}),
	};
}
