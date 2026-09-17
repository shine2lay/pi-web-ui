/**
 * 左栏「最近对话」的排列（flat-recent-chats 补丁）。
 *
 * 一条扁平列表，**没有项目分组**，按对话创建时间倒序（新的在上）。子代理仍然缩进
 * 挂在父对话下面 —— 那是父子关系，不是文件夹。
 *
 * 为什么不按「最后活动时间」排：那样一条对话收到消息就窜到顶上，点开一条跨文件夹
 * 的对话又会把整列重排，行在鼠标底下跳走（原来的 #140 / chat-cwd-pin 之争都在
 * 修这个症状的不同表现）。创建时间是**不变量**：收消息不动、点开不动、切项目不动、
 * 刷新页面还是同一个顺序。代价是「最近聊过的」不一定在最上面 —— 用搜索找它更快，
 * 而列表的价值在于位置可预测。
 *
 * 纯函数 + 单测：`tests/unit/conv-groups.test.ts`。
 */
import type { ConversationSummary } from "./types";

export interface ConvRow {
	conv: ConversationSummary;
	/** 缩进层级：0 = 根行，1+ = 子代理（跟着父行）。 */
	depth: number;
}

/**
 * 扁平化 + 定序：根行按创建时间倒序，子代理紧跟父行（同样按创建时间倒序）。
 *
 * 缺 `createdAt` 的行（老服务端）排在最后并保持原有相对顺序 —— 稳定排序保证
 * 它们不会互相跳位。
 */
export function orderConversations(list: ConversationSummary[]): ConvRow[] {
	const byId = new Map(list.map((c) => [c.id, c]));
	const kids = new Map<string, ConversationSummary[]>();
	const roots: ConversationSummary[] = [];
	for (const c of list) {
		if (c.parentId && byId.has(c.parentId)) {
			const arr = kids.get(c.parentId) ?? [];
			arr.push(c);
			kids.set(c.parentId, arr);
		} else roots.push(c);
	}

	// 创建时间倒序；缺省值排最后。Array.prototype.sort 在现代引擎里是稳定排序，
	// 所以同一时刻（或都缺省）的行保持输入顺序，不会每次渲染换一个样。
	const byCreated = (a: ConversationSummary, b: ConversationSummary): number => {
		const ax = a.createdAt;
		const bx = b.createdAt;
		if (ax === undefined && bx === undefined) return 0;
		if (ax === undefined) return 1;
		if (bx === undefined) return -1;
		return bx - ax;
	};

	const rows: ConvRow[] = [];
	const seen = new Set<string>();
	const append = (c: ConversationSummary, depth: number): void => {
		if (seen.has(c.id)) return;
		seen.add(c.id);
		rows.push({ conv: c, depth });
		for (const child of [...(kids.get(c.id) ?? [])].sort(byCreated)) append(child, depth + 1);
	};
	for (const root of [...roots].sort(byCreated)) append(root, 0);
	// 兜底：父行被过滤掉的孤儿行也要出现（否则对话会从列表里消失）。
	for (const orphan of list) append(orphan, 0);
	return rows;
}
