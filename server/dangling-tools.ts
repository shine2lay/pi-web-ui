/**
 * 悬空 toolCall 检测与修复（issue #280、issue #332）。
 *
 * 背景：流式中模型卡死 → 工具看门狗 abort 无效 → forceResetConversation
 * dispose 在飞运行时并从磁盘重建。内存里未落盘的工具结果静默蒸发，
 * 会话文件尾留下一个「有调用、无结果」的悬空 toolCall；重建后继续
 * prompt 会把非法转录链喂给 provider——请求有发起迹象但零落盘、零报错，
 * 用户在往黑洞里打字。
 *
 * 缺陷与收紧（issue #332）：
 * 不能将全文件所有找不到 toolResult 的调用一律视为悬空并追加合成结果：
 * 1. 上线检查：若 assistant 的 stopReason 是 "error" 或 "aborted"，
 *    pi 在发送给 provider 前会丢弃该 assistant（transformMessages）。
 *    该调用属于永不上线的幽灵调用，补合成结果反而会构造出没有前置 tool_calls
 *    的孤儿 role: "tool"，导致 provider 400（DeepSeek/OpenAI Responses 等）；
 * 2. 分支检查：会话文件由树状结构追加存储，老分支被遗弃的 toolCall 不在当前分支上；
 *    若在文件尾（当前活跃分支末尾）追加老分支调用的合成结果，也会制造孤儿 toolResult。
 *    因此落盘修复必须沿当前活跃分支（lastId 开始回溯）定位尾部生效 assistant。
 *
 * 本模块：
 * - findDanglingToolCalls：纯函数，消息/条目数组里找「有调用、无后继结果」的 toolCall；
 * - tailAssistantToolCallIds：沿当前分支回溯，定位尾部会上线的 assistant 的 toolCallId 集合；
 * - healDanglingToolCallFile：落盘版，仅针对当前分支尾部生效的悬空调用追加合成 toolResult；
 * - findTailDanglingToolCalls：内存版，发送前守卫用，同样只看尾部 assistant（本 fork 补丁 dangling-tail-only）；
 * - 合成结果文案：DANGLING_TOOL_RESULT_TEXT（中英各一，toolResult content 只带一条文本）。
 *
 * dangling-tail-only（本 fork，2026-09-26）：合成结果只能补给「尾部 assistant」的调用，而且中间不能隔着
 * 任何会变成 user 回合的东西。更早的无结果调用（重启打断后用户接着发了新消息、问卷没答就换了话题……）
 * pi-ai 发请求时自己会在下一条 user 前补「No result provided」，本来就合法；把它们的合成结果追加到会话尾，
 * 就是一条前面没有对应 tool_use 的孤儿 tool_result，Anthropic 每次都 400（`unexpected tool_use_id found in
 * tool_result blocks`），对话从此再也发不出去。
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export const DANGLING_TOOL_RESULT_TEXT =
	"(System: the previous run was force-stopped (tool timeout or stuck model stream), so this tool call returned no result. A synthetic result was filled in automatically to keep the conversation record intact. Re-run the tool if needed, or carry on with the conversation.)";
export const DANGLING_TOOL_RESULT_TEXT_EN =
	"(System: the previous run was force-terminated (tool timeout / hung model stream) and this tool call never returned. A synthetic result was inserted automatically to keep the transcript valid. Re-run the tool or continue as needed.)";

export interface DanglingToolCall {
	toolCallId: string;
	toolName: string;
}

interface ContentBlock {
	type?: unknown;
	id?: unknown;
	name?: unknown;
	toolCallId?: unknown;
	toolName?: unknown;
}

function toolCallsOfMessage(msg: unknown): DanglingToolCall[] {
	if (typeof msg !== "object" || msg === null) return [];
	const m = msg as { role?: unknown; content?: unknown; stopReason?: unknown };
	if (m.role !== "assistant" || !Array.isArray(m.content)) return [];
	if (m.stopReason === "error" || m.stopReason === "aborted") return [];
	const out: DanglingToolCall[] = [];
	for (const b of m.content as ContentBlock[]) {
		if (typeof b !== "object" || b === null || b.type !== "toolCall") continue;
		const id = typeof b.id === "string" ? b.id : "";
		if (!id) continue;
		const name = typeof b.name === "string" && b.name ? b.name : "unknown";
		out.push({ toolCallId: id, toolName: name });
	}
	return out;
}

function toolResultIdsOfMessage(msg: unknown): Set<string> {
	const ids = new Set<string>();
	if (typeof msg !== "object" || msg === null) return ids;
	const m = msg as { role?: unknown; toolCallId?: unknown; content?: unknown };
	if (m.role === "toolResult" && typeof m.toolCallId === "string") ids.add(m.toolCallId);
	// 兼容：个别版本把结果放在 content 块里。
	if (Array.isArray(m.content)) {
		for (const b of m.content as ContentBlock[]) {
			if (typeof b !== "object" || b === null) continue;
			if ((b.type === "toolResult" || b.type === "tool_result") && typeof b.toolCallId === "string") {
				ids.add(b.toolCallId);
			}
		}
	}
	return ids;
}

/** convertToLlm 之后会成为一条 user 回合的消息角色：合成结果补在它们后面就是孤儿，找尾部时遇到即停。 */
const USER_TURN_ROLES = new Set(["user", "custom", "bashExecution", "branchSummary", "compactionSummary"]);
/** 落盘条目里没有 message 包装、但同样会以 user 回合进上下文的条目类型。 */
const USER_TURN_ENTRY_TYPES = new Set(["custom_message", "branch_summary"]);

function isUserTurn(msgOrEntry: unknown): boolean {
	if (typeof msgOrEntry !== "object" || msgOrEntry === null) return false;
	const { role, type } = msgOrEntry as { role?: unknown; type?: unknown };
	return (
		(typeof role === "string" && USER_TURN_ROLES.has(role)) ||
		(typeof type === "string" && USER_TURN_ENTRY_TYPES.has(type))
	);
}

function messagesOfEntries(entries: unknown[]): unknown[] {
	return entries.map((e) => {
		if (typeof e === "object" && e !== null && "message" in e) {
			const msg = (e as { message?: unknown }).message;
			if (typeof msg === "object" && msg !== null && "role" in msg) return msg;
		}
		return e;
	});
}

/**
 * 找悬空 toolCall：出现过调用、但之后没有任何 toolResult 与之配对的。
 * 输入既可以是 Message[]（内存 agent.state.messages），也可以是
 * SessionManager entry[]（带 { message } 包装的落盘条目）——统一按顺序扫。
 */
export function findDanglingToolCalls(messagesOrEntries: unknown[]): DanglingToolCall[] {
	const messages = messagesOfEntries(messagesOrEntries);
	const calls: { call: DanglingToolCall; index: number }[] = [];
	const results = new Map<string, number[]>();
	messages.forEach((msg, index) => {
		for (const c of toolCallsOfMessage(msg)) calls.push({ call: c, index });
		for (const id of toolResultIdsOfMessage(msg)) {
			let arr = results.get(id);
			if (!arr) {
				arr = [];
				results.set(id, arr);
			}
			arr.push(index);
		}
	});
	const out: DanglingToolCall[] = [];
	const seen = new Set<string>();
	for (const { call, index } of calls) {
		const later = (results.get(call.toolCallId) ?? []).some((ri) => ri > index);
		if (!later && !seen.has(call.toolCallId)) {
			seen.add(call.toolCallId);
			out.push(call);
		}
	}
	return out;
}

/**
 * 沿当前分支从 lastId 往前回溯，定位当前分支尾部生效 assistant 的 toolCallId 集合（issue #332）。
 *
 * 两个守卫条件：
 * 1. 分支检查：严格沿 parentId 链回溯，老分支（不在当前分支路径上）的条目绝不纳入，
 *    避免在当前分支尾部追加针对老分支调用的合成结果而制造孤儿 toolResult；
 * 2. 上线检查：若遇到的 assistant 是 stopReason: "error" | "aborted"，
 *    说明该 assistant 已被中断/报错，pi 在发送给模型前会直接跳过丢弃它（transformMessages），
 *    其 toolCall 属于绝不上线的幽灵调用，必须跳过且绝不能为其补结果。
 *
 * 此外，若在回溯中遇到了 user 消息，说明当前尾部已经退出该回合（例如最新是 user 消息），
 * 绝不能跨过 user 消息去为更早的 assistant 补 toolResult，应立即停止。
 */
export function tailAssistantToolCallIds(entries: unknown[], lastId: string | null): Set<string> {
	if (!lastId) return new Set();
	const byId = new Map<string, unknown>();
	for (const e of entries) {
		if (typeof e === "object" && e !== null && typeof (e as { id?: unknown }).id === "string") {
			byId.set((e as { id: string }).id, e);
		}
	}
	const seen = new Set<string>();
	let cursor: string | null = lastId;
	while (cursor && !seen.has(cursor)) {
		seen.add(cursor);
		const entry = byId.get(cursor);
		if (!entry || typeof entry !== "object") break;
		// dangling-tail-only：custom_message / branch_summary 条目进上下文就是一条 user 回合，同样不能越过。
		if (isUserTurn(entry)) break;
		const msg =
			"message" in entry && typeof (entry as { message?: unknown }).message === "object"
				? (entry as { message: unknown }).message
				: null;
		if (msg && typeof msg === "object" && "role" in msg) {
			const m = msg as { role?: unknown; stopReason?: unknown };
			if (isUserTurn(m)) {
				// 跨入更早的用户回合（含 custom / bashExecution / 摘要这类进上下文即 user 的消息），
				// 尾部无正在等待结果的 assistant
				break;
			}
			if (m.role === "assistant") {
				if (m.stopReason !== "error" && m.stopReason !== "aborted") {
					return new Set(toolCallsOfMessage(m).map((c) => c.toolCallId));
				}
				// 尾部最新 assistant 处于 aborted/error 状态，幽灵调用不上线；且不可越过它去修更早回合
				break;
			}
		}
		cursor =
			typeof (entry as { parentId?: unknown }).parentId === "string" ? (entry as { parentId: string }).parentId : null;
	}
	return new Set();
}

/**
 * 内存版尾部守卫（本 fork 补丁 dangling-tail-only）：发送前只修「转录尾部那条 assistant」还没拿到结果的调用。
 *
 * 输入同 findDanglingToolCalls（agent.state.messages，或带 { message } 包装的落盘条目）。从尾往前：
 * toolResult 记下已答的 id；遇到 assistant 就返回它还没答的调用（error / aborted 的返回空，同
 * tailAssistantToolCallIds：pi 发送前会丢掉它，也不能越过它去修更早的回合）；先遇到会变成 user 回合的消息
 * 就返回空（那之前的无结果调用 pi-ai 自己会补）；其它（system 快照、扩展的 custom 条目等）跳过。
 */
export function findTailDanglingToolCalls(messagesOrEntries: unknown[]): DanglingToolCall[] {
	const messages = messagesOfEntries(messagesOrEntries);
	const answered = new Set<string>();
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (typeof msg !== "object" || msg === null) continue;
		if ((msg as { role?: unknown }).role === "assistant") {
			const out: DanglingToolCall[] = [];
			for (const c of toolCallsOfMessage(msg)) {
				if (answered.has(c.toolCallId) || out.some((o) => o.toolCallId === c.toolCallId)) continue;
				out.push(c);
			}
			return out;
		}
		if (isUserTurn(msg)) return [];
		for (const id of toolResultIdsOfMessage(msg)) answered.add(id);
	}
	return [];
}

/**
 * 落盘修复：向会话文件尾追加合成 toolResult（仅针对当前分支尾部生效的悬空调用），
 * parentId 链式接在当前尾行之后。append-only——历史字节不动，无需备份。
 * 返回追加条数（0 = 健康，无需处理；-1 = 文件不可读/不可写）。
 */
export function healDanglingToolCallFile(filePath: string): number {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch {
		return -1;
	}
	const lines = raw.split("\n");
	const entries: unknown[] = [];
	let lastId: string | null = null;
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			entries.push(parsed);
			if (typeof parsed === "object" && parsed !== null && typeof (parsed as { id?: unknown }).id === "string") {
				lastId = (parsed as { id: string }).id;
			}
		} catch {
			// 脏行：SDK 加载时同样跳过，这里忽略。
		}
	}
	if (entries.length === 0 || !lastId) return 0;
	const tailIds = tailAssistantToolCallIds(entries, lastId);
	if (tailIds.size === 0) return 0;
	const dangling = findDanglingToolCalls(entries).filter((d) => tailIds.has(d.toolCallId));
	if (dangling.length === 0) return 0;
	try {
		let parentId = lastId;
		for (const d of dangling) {
			const id = `synthetic-tool-result-${randomUUID().slice(0, 8)}`;
			const entry = {
				type: "message",
				id,
				parentId,
				timestamp: new Date().toISOString(),
				message: {
					role: "toolResult",
					toolCallId: d.toolCallId,
					toolName: d.toolName,
					content: [{ type: "text", text: `${DANGLING_TOOL_RESULT_TEXT}\n${DANGLING_TOOL_RESULT_TEXT_EN}` }],
					isError: true,
					timestamp: Date.now(),
				},
			};
			const line = JSON.stringify(entry);
			if (!existsSync(filePath)) return -1;
			appendFileSync(filePath, `${line}\n`, "utf8");
			parentId = id;
		}
		return dangling.length;
	} catch {
		return -1;
	}
}
