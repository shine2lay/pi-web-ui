/**
 * 顶栏的「页面 tab」三件套：Roles、Initiatives、Memory（openviking-dashboard）。
 *
 * 从 ui-slots.ts 的 BUILTIN_UI_ITEMS 里拆出来，这样再加一个页面不必把那个文件撑得更大
 * （Rule 23 的 500 行上限 / wt check 的 legacy ratchet）。顺序权重保持原值，合并与偏好
 * 的行为与写在原数组里完全一致。
 */
// 只借类型（type-only，编译后擦除），所以与 ui-slots.ts 之间没有运行时循环引用。
import type { BuiltinUiItem } from "./ui-slots";

/** 三个页面视图的顶栏条目（order 22.5 / 22.6 / 22.7，紧跟 Git 之后）。 */
export const PAGE_TAB_UI_ITEMS: BuiltinUiItem[] = [
	// roles-overview: the Roles page, the fourth view (what every role is doing and what waits on you).
	// It folds into "⋯" only after Terminal and Git (LATE_TOPBAR_ITEM_IDS, topbar-fit.ts).
	{
		id: "host:roles",
		slot: "topbar.primary",
		labelKey: "rolesTab",
		icon: "users",
		kind: "view",
		view: "roles",
		order: 22.5,
		group: "views",
		align: "start",
	},
	// initiatives-page: the Initiatives tab, next to Roles (each initiative's decisions and who made them).
	{
		id: "host:initiatives",
		slot: "topbar.primary",
		labelKey: "initiativesTab",
		icon: "list",
		kind: "view",
		view: "initiatives",
		order: 22.6,
		group: "views",
		align: "start",
	},
	// openviking-dashboard: the Memory tab, next to Initiatives (what OpenViking is injecting and
	// committing right now, and what Shared and Per-Role memory hold).
	{
		id: "host:openviking",
		slot: "topbar.primary",
		labelKey: "openVikingTab",
		icon: "database",
		kind: "view",
		view: "openviking",
		order: 22.7,
		group: "views",
		align: "start",
	},
];
