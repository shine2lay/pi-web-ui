/**
 * 提问索引（chat-window-pagination）。
 *
 * 分页之后快照只装最新的一截消息，但提问导轨要列出**整段**对话的提问——不然
 * 滚上去的入口就没了，编号也会跟着窗口漂移。索引只带 id / 全局下标 / 一小段
 * 预览文本：实测 220 条提问 15KB，相对 35MB 的完整快照可以忽略。
 */

import type { UiContentBlock, UiMessage, UiQuestionRef } from "./protocol.js";

/** 预览文本上限：导轨一行显示不下更多，多发就是浪费带宽。 */
const PREVIEW_CHARS = 160;

/** 技能调用块的开头（SDK 把 `/skill:name args` 展开成 `<skill …>` + 整份
 *  SKILL.md）。导轨显示用户自己写的 args，不是 SKILL.md 正文。
 *
 *  ⚠️ 与 web/src/skill-block.ts 的 SKILL_BLOCK_RE 同源，改一处要改两处
 *  （protocol.ts 按约定是纯类型文件，不能放运行时代码给两端共享；
 *  protocol-version.ts 也是这么双份维护的）。
 *  tests/unit/question-index.test.ts 用同一份样本钉住两边行为一致。 */
const SKILL_BLOCK_RE = /^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/;

/** 一条 user 消息 → 导轨显示的文本（技能调用取 args / 技能名）。 */
export function questionPreview(m: UiMessage): string {
	const blocks: UiContentBlock[] = Array.isArray(m.content) ? m.content : [];
	const joined = blocks
		.map((b) => (b.type === "text" ? b.text : ""))
		.filter(Boolean)
		.join(" ");
	const skill = joined.match(SKILL_BLOCK_RE);
	const text = skill ? skill[2]?.trim() || `skill:${skill[1]}` : joined.trim();
	return text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) : text;
}

/** 整段对话的提问索引。index 是该消息在**完整**消息列表里的下标——前端点一条
 *  还没加载的提问时，靠它算出要向前取多少条。 */
export function buildQuestionIndex(messages: UiMessage[]): UiQuestionRef[] {
	const out: UiQuestionRef[] = [];
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (m.role !== "user") continue;
		const text = questionPreview(m);
		// 空提问（纯附件/纯技能展开且没 args）不进导轨——和前端原有行为一致。
		if (!text) continue;
		out.push({ id: m.id, index: i, text });
	}
	return out;
}
