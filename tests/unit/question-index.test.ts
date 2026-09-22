/**
 * chat-window-pagination —— 提问索引（server/question-index.ts）。
 *
 * 分页后快照只带最新一截消息，导轨靠这份索引列出**整段**对话的提问。所以索引
 * 必须：编号/下标是全局的（不是窗口内的）、文本跟前端原来推出来的一致（技能
 * 调用显示 args 而不是 SKILL.md 正文）、空提问不进导轨。
 */

import { describe, expect, it } from "vitest";
import { buildQuestionIndex, questionPreview } from "../../server/question-index.js";
import { parseSkillBlock } from "../../web/src/skill-block.js";
import type { UiMessage } from "../../server/protocol.js";

function user(id: string, text: string): UiMessage {
	return { id, role: "user", content: [{ type: "text", text }] } as UiMessage;
}
function assistant(id: string, text: string): UiMessage {
	return { id, role: "assistant", content: [{ type: "text", text }] } as UiMessage;
}

/** `/skill:foo args` 被 SDK 展开成的样子（见 web/src/skill-block.ts 的注释）。 */
function skillBlock(name: string, body: string, args?: string): string {
	return `<skill name="${name}" location="/skills/${name}/SKILL.md">\n${body}\n</skill>` + (args ? `\n\n${args}` : "");
}

describe("buildQuestionIndex", () => {
	it("下标是消息在完整列表里的位置，不是提问的序号", () => {
		const msgs = [user("u1", "first"), assistant("a1", "…"), assistant("a2", "…"), user("u2", "second")];
		expect(buildQuestionIndex(msgs)).toEqual([
			{ id: "u1", index: 0, text: "first" },
			{ id: "u2", index: 3, text: "second" },
		]);
	});

	it("只收 user 消息", () => {
		const msgs = [
			assistant("a1", "x"),
			user("u1", "q"),
			{ id: "t1", role: "toolResult", content: [] } as unknown as UiMessage,
		];
		expect(buildQuestionIndex(msgs).map((q) => q.id)).toEqual(["u1"]);
	});

	it("技能调用显示用户自己的 args，不是 SKILL.md 正文", () => {
		const text = skillBlock("fork-rebase", "# Fork rebase\n很长的正文…".repeat(20), "帮我同步 pi-web-ui");
		expect(questionPreview(user("u1", text))).toBe("帮我同步 pi-web-ui");
	});

	it("技能调用没带 args 时退回技能名", () => {
		const text = skillBlock("council-mode", "正文".repeat(50));
		expect(questionPreview(user("u1", text))).toBe("skill:council-mode");
	});

	it("跟前端 parseSkillBlock 对同一份样本得出同样的文本（两处正则不许漂）", () => {
		const withArgs = skillBlock("fork-rebase", "正文".repeat(30), "同步一下");
		const noArgs = skillBlock("relay", "正文".repeat(30));
		for (const raw of [withArgs, noArgs]) {
			const sb = parseSkillBlock(raw);
			expect(sb).not.toBeNull();
			const frontend = sb!.userMessage ?? `skill:${sb!.name}`;
			expect(questionPreview(user("u1", raw))).toBe(frontend);
		}
	});

	it("空提问（纯附件/无文本）不进导轨", () => {
		const msgs = [
			{ id: "u1", role: "user", content: [] } as unknown as UiMessage,
			user("u2", "   "),
			user("u3", "real"),
		];
		expect(buildQuestionIndex(msgs).map((q) => q.id)).toEqual(["u3"]);
	});

	it("预览文本有上限——导轨一行显示不下更多，多发就是浪费带宽", () => {
		const long = "字".repeat(500);
		const preview = questionPreview(user("u1", long));
		expect(preview.length).toBe(160);
		expect(preview).toBe("字".repeat(160));
	});

	it("多个文本块拼起来", () => {
		const m = {
			id: "u1",
			role: "user",
			content: [
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
			],
		} as UiMessage;
		expect(questionPreview(m)).toBe("a b");
	});

	it("一段 8600 条消息的对话，索引也只有几十 KB（分页的前提）", () => {
		const msgs: UiMessage[] = [];
		for (let i = 0; i < 8600; i++)
			msgs.push(i % 40 === 0 ? user(`u${i}`, `问题 ${i}`) : assistant(`a${i}`, "x".repeat(500)));
		const idx = buildQuestionIndex(msgs);
		expect(idx).toHaveLength(215);
		expect(JSON.stringify(idx).length).toBeLessThan(30_000);
	});
});
