/**
 * builtins/rename.ts — 重命名当前对话标记。
 *
 * 需求：加个重命名当前对话 marker。
 *
 * 语法（唯一写法）：
 *   [[conv:rename:<新标题>]]        重命名当前对话
 *
 * 持久化：通过宿主回调直接改对话标题（内存 + 磁盘 transcript session_info），
 *         不需要额外状态。
 */

import type { ApplyResult, MarkerTool, ParsedToken, MarkerContext } from "../marker.js";
import { type ServerLang } from "../../i18n.js";

export const RENAME_NAMESPACE = "conv";

function extractTitle(token: ParsedToken): string {
	// args[0] 是主标题；kwargs 兼容 text/name/title
	const fromArgs = token.args.join(" ").trim();
	const fromKw = (token.kwargs["text"] ?? token.kwargs["name"] ?? token.kwargs["title"] ?? "").trim();
	if (fromArgs && fromKw) return `${fromArgs} ${fromKw}`.trim();
	return fromArgs || fromKw;
}

const RENAME_GUIDANCE_EN: string[] = [
	"- Rename the current conversation: [[conv:rename:<new title>]] (do it early, once you understand what the user needs)",
];

/** 语言感知的 conv guidance（issue #91）：en 用英译、zh 用中文，默认英文。 */
export function getRenameGuidance(_lang: ServerLang = "en"): string[] {
	return RENAME_GUIDANCE_EN;
}
export const renameMarker: MarkerTool<never> = {
	name: "conv",
	guidance: RENAME_GUIDANCE_EN,
	getGuidance: getRenameGuidance,

	async apply(token: ParsedToken, ctx: MarkerContext, _state: never, _lang: ServerLang = "en"): Promise<ApplyResult> {
		if (token.op !== "rename") {
			return {
				applied: false,
				error: `conv unknown operation: ${token.op} (only conv:rename is supported)`,
			};
		}
		const title = extractTitle(token);
		if (!title)
			return {
				applied: false,
				error: "conv:rename requires a title argument [[conv:rename:<new title>]]",
			};
		if (title.length > 80)
			return {
				applied: false,
				error: "Title too long (max 80 characters)",
			};
		if (!ctx.renameConversation)
			return {
				applied: false,
				error: "Renaming is not supported in this environment",
			};
		try {
			ctx.renameConversation(title);
			ctx.notify(`Renamed to: ${title}`, "info", `Renamed to: ${title}`);
			return {
				applied: true,
				feedback: `renamed to "${title}"`,
			};
		} catch (e) {
			const errMsg = (e as Error).message ?? String(e);
			return {
				applied: false,
				error: `Rename failed: ${errMsg}`,
			};
		}
	},
	overlay: undefined,
	init: () => undefined as never,
};
