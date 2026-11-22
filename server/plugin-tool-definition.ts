import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { OWNER_TELEGRAM_TOOL } from "./owner-telegram.js";
import type { PluginAgentTool, PluginToolCallerContext } from "./plugins.js";
import { proofCheckChatId, proofCheckOutgoing, type ProofCheckGate } from "./proof-check-messages.js";

/**
 * 插件结构化工具 → SDK ToolDefinition。
 * execute 返回值宽容处理：{content,details} 原样收编；字符串/对象包成文本块。
 * Ops #1073: telegram_send from a QA chat goes out only as proof-check allows (proof-check-messages.ts).
 */
export function pluginToolToDefinition(
	tool: PluginAgentTool,
	callerContext?: () => PluginToolCallerContext,
	proofCheck?: () => ProofCheckGate | undefined,
): ToolDefinition {
	const normalize = (
		result: unknown,
	): {
		content: Array<{ type: "text"; text: string }>;
		details?: unknown;
	} => {
		if (result && typeof result === "object" && Array.isArray((result as { content?: unknown }).content)) {
			return result as {
				content: Array<{ type: "text"; text: string }>;
				details?: unknown;
			};
		}
		const text = typeof result === "string" ? result : JSON.stringify(result ?? null, null, 2);
		return { content: [{ type: "text", text }] };
	};
	return {
		name: tool.name,
		label: tool.label ?? tool.name,
		description: tool.description,
		promptSnippet: tool.promptSnippet,
		promptGuidelines: tool.promptGuidelines,
		parameters: (tool.parameters ?? {
			type: "object",
			properties: {},
		}) as ToolDefinition["parameters"],
		execute: async (
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: ((partial: unknown) => void) | undefined,
		) => {
			const context = callerContext?.();
			if (tool.name === OWNER_TELEGRAM_TOOL && typeof params?.text === "string" && params.text.trim()) {
				const judged = await proofCheckOutgoing(proofCheck?.(), context?.role, {
					text: params.text,
					surface: "telegram_send",
					chat: proofCheckChatId(context?.sessionFile, context?.conversationId),
				});
				if (!judged.ok) throw new Error(judged.error);
				params = { ...params, text: judged.text };
			}
			const raw = await tool.execute(
				toolCallId,
				params as Record<string, unknown>,
				signal,
				onUpdate ? (partial) => onUpdate(normalize(partial) as never) : undefined,
				context,
			);
			return normalize(raw) as never;
		},
	} as unknown as ToolDefinition;
}
