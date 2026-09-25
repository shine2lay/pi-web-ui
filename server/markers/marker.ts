/**
 * marker.ts — 通用内联标记核心抽象（内置版）。
 * 复刻自 pi-marker-tools，保持相同解析语义，便于 AI 无缝迁移。
 */

export const MARKER_OPEN = "[[";
export const MARKER_CLOSE = "]]";

import type { ServerLang } from "../i18n.js";

export interface ParsedToken {
	tool: string;
	op: string;
	args: string[];
	kwargs: Record<string, string>;
	raw: string;
}

export interface ApplyResult {
	applied: boolean;
	feedback?: string;
	error?: string;
}

export interface MarkerOverlay {
	tool: string;
	lines: string[];
	hasError?: boolean;
}

export interface MarkerContext {
	/** 当前对话 id（用于 rename 等需要定位对话的标记）。 */
	conversationId: string;
	/** 通知 UI（非打断）。 */
	notify(text: string, level?: "info" | "warning" | "error", textEn?: string): void;
	/** 重命名当前对话（rename 标记专用）。 */
	renameConversation?(title: string): void;
}

export interface MarkerTool<State = unknown> {
	name: string;
	guidance: string[];
	/** 语言感知的 guidance（issue #91）：en 用英译、zh 用中文。未提供时回退到静态 guidance。 */
	getGuidance?: (lang: ServerLang) => string[];
	apply(token: ParsedToken, ctx: MarkerContext, state: State, lang?: ServerLang): Promise<ApplyResult> | ApplyResult;
	overlay?(state: State, ctx: MarkerContext): MarkerOverlay | undefined;
	init?(): State;
}

// ---------------------------------------------------------------------------
// 解析器
// ---------------------------------------------------------------------------

const TOKEN_RE = /\[\[\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*([A-Za-z][A-Za-z0-9_-]*)\s*:(.*?)\s*\]\]/g;

function splitArgs(body: string): { args: string[]; kwargs: Record<string, string> } {
	const args: string[] = [];
	const kwargs: Record<string, string> = {};
	for (const piece of body.split(",")) {
		const trimmed = piece.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf("=");
		if (eq > 0 && /^[A-Za-z][A-Za-z0-9_-]*$/.test(trimmed.slice(0, eq))) {
			kwargs[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
		} else {
			args.push(trimmed);
		}
	}
	return { args, kwargs };
}

/** 围栏行：最多 3 个空格缩进，再 3 个以上 ` 或 ~。 */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * markers-skip-code：代码里的标记只是文字，不执行。AI 引用、贴出标记语法时（比如贴系统提示词）
 * 一般放在代码块或行内代码里，以前照样执行（改标题、建空任务）。
 *
 * 返回代码区间 [start, end)：
 *  - 围栏代码块（``` 或 ~~~）：到同种字符、不短于开头的闭合行为止，没闭合就到结尾（同 CommonMark）。
 *  - 行内代码：N 个反引号开头，到下一段恰好 N 个反引号为止；不跨空行（空行就分段了）。
 *    配不上的反引号是普通字符。
 */
export function codeRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	const addInline = (from: number, to: number) => {
		const runs: Array<{ start: number; len: number }> = [];
		const re = /`+/g;
		const seg = text.slice(from, to);
		let r: RegExpExecArray | null;
		while ((r = re.exec(seg)) !== null) runs.push({ start: from + r.index, len: r[0].length });
		for (let k = 0; k < runs.length; k++) {
			const open = runs[k];
			for (let n = k + 1; n < runs.length; n++) {
				if (/\n[ \t]*\n/.test(text.slice(open.start + open.len, runs[n].start))) break;
				if (runs[n].len !== open.len) continue;
				ranges.push([open.start, runs[n].start + runs[n].len]);
				k = n;
				break;
			}
		}
	};
	let fence: string | null = null;
	let blockStart = 0; // 当前围栏块（在块里时）或正文段（不在时）的起点
	let lineStart = 0;
	while (lineStart <= text.length) {
		const nl = text.indexOf("\n", lineStart);
		const lineEnd = nl === -1 ? text.length : nl + 1;
		const line = text.slice(lineStart, nl === -1 ? text.length : nl);
		const f = FENCE_RE.exec(line)?.[1];
		if (fence === null) {
			if (f) {
				addInline(blockStart, lineStart);
				fence = f;
				blockStart = lineStart;
			}
		} else if (f && f[0] === fence[0] && f.length >= fence.length && line.trim() === f) {
			ranges.push([blockStart, lineEnd]);
			fence = null;
			blockStart = lineEnd;
		}
		if (nl === -1) break;
		lineStart = lineEnd;
	}
	if (fence !== null) ranges.push([blockStart, text.length]);
	else addInline(blockStart, text.length);
	return ranges;
}

const inRanges = (ranges: Array<[number, number]>, i: number) => ranges.some(([s, e]) => i >= s && i < e);

export function parseMarkers(text: string): ParsedToken[] {
	const tokens: ParsedToken[] = [];
	const code = text.includes("`") || text.includes("~~~") ? codeRanges(text) : [];
	TOKEN_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = TOKEN_RE.exec(text)) !== null) {
		if (inRanges(code, m.index)) continue;
		const [, tool, op, body] = m;
		if (body.includes("[[")) continue;
		const { args, kwargs } = splitArgs(body);
		tokens.push({ tool, op, args, kwargs, raw: m[0] });
	}
	return tokens;
}

export function stripMarkers(text: string): string {
	const code = codeRanges(text);
	return text.replace(TOKEN_RE, (full: string, ...rest: unknown[]) =>
		inRanges(code, rest[rest.length - 2] as number) ? full : "",
	);
}

export function replaceToken(text: string, raw: string, replacement: string): string {
	return text.split(raw).join(replacement);
}

export function serializeToken(token: ParsedToken): string {
	const parts = [token.tool, token.op, ...token.args];
	const kwargs = Object.entries(token.kwargs)
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([k, v]) => `${k}=${v}`);
	return `${MARKER_OPEN}${[...parts, ...kwargs].join(":")}${MARKER_CLOSE}`;
}
