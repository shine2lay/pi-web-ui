/**
 * 左栏「运行的对话」的分组（跨项目）：当前项目排最前、不显示组标题（项目名），
 * 其余项目按路径稳定排序并挂上组标题。
 *
 * 抽成纯函数是为了那个「切项目时项目名闪一下」的坑（#140 的回归），有单测：
 * `tests/unit/conv-groups.test.ts`。
 */
import type { ConversationSummary } from "./types";

export interface ConvGroup {
	cwd: string;
	isCurrent: boolean;
	convs: ConversationSummary[];
}

/**
 * Group the (now cross-project) running-conversation list by workspace,
 * current project first, others in stable path order. Lets the left panel
 * disambiguate same-titled chats across projects and shows where each
 * background run lives.
 *
 * 「当前项目」只看**工作区**（`currentCwd`），不看当前打开的是哪条对话。
 *
 * 旧实现把**含当前对话的那组**提到最前并去掉组标题（#140：当时切对话必定伴随
 * 切工作区，而 `cwd` 快照比 `conversations` 晚到一帧，不这么做会闪一下项目名）。
 * chat-cwd-pin 之后前提变了：切到别的文件夹的对话**不再**搬工作区，于是「当前
 * 对话在别的文件夹」从一帧的中间态变成了**稳定状态** —— 再按 activeId 置顶，
 * 就成了每点一条跨文件夹的对话就把整列重新排序（行在鼠标下面跳走）。
 *
 * 现在：分组顺序只随**显式的工作区切换**而变，切对话一律不动位置；当前对话在
 * 哪个文件夹，由那组的文件夹标题告诉你。`currentCwd` 在列表里没有对应分组时
 * （空白新对话 / 刚切完工作区还没有对话）才回落到当前对话所在组，保住 #140
 * 那一帧不闪项目名的性质。
 */
export function groupConversations(
	list: ConversationSummary[],
	currentCwd: string,
	activeConversationId: string,
): ConvGroup[] {
	const byId = new Map(list.map((c) => [c.id, c]));
	/** 分组归属：子对话（即使自己 cwd 不同）跟着父对话的项目走。 */
	const groupCwdOf = (c: ConversationSummary): string => (c.parentId ? (byId.get(c.parentId)?.cwd ?? c.cwd) : c.cwd);
	const activeConv = list.find((c) => c.id === activeConversationId);

	const byCwd = new Map<string, ConversationSummary[]>();
	for (const c of list) {
		const groupCwd = groupCwdOf(c);
		const arr = byCwd.get(groupCwd) ?? [];
		arr.push(c);
		byCwd.set(groupCwd, arr);
	}
	// 工作区自己就有一组 → 它是当前项目；否则才回落到当前对话所在组（见上）。
	const effectiveCwd = byCwd.has(currentCwd) || !activeConv ? currentCwd : groupCwdOf(activeConv);

	const groups: ConvGroup[] = [...byCwd.entries()].map(([cwd, convs]) => ({
		cwd,
		isCurrent: cwd === effectiveCwd,
		convs,
	}));
	groups.sort((a, b) => (a.isCurrent ? -1 : b.isCurrent ? 1 : a.cwd < b.cwd ? -1 : a.cwd > b.cwd ? 1 : 0));
	return groups;
}
