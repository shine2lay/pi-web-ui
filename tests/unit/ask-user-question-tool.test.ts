import { describe, expect, it } from "vitest";
import { makeAskUserQuestionTool } from "../../server/agent-service.js";
import type { UiQuestion } from "../../server/protocol.js";

/**
 * 标准 pi 引擎的 ask_user_question customTool 单测（零 token / 零会话）。
 * 只验证工具本体的行为：schema 参数存在、execute 把卡片交给 clientSession.postQuestion 并立即返回
 * (nonblocking-ask, Ops #1087: no answers in the result; they arrive later as a new message)、无问题 → 报错。
 * 浏览器渲染部分由 dsh-question-dialog.test.ts（前端）覆盖，服务端透传由协议类型保证。
 */

/** 构造一个最小 clientSession mock，记录收到的卡片。 */
function mockSession(post: (q: UiQuestion[]) => void = () => {}) {
	const invoked = { questions: [] as UiQuestion[], toolCallId: "" };
	return {
		invoked,
		postQuestion: (questions: UiQuestion[], toolCallId: string) => {
			invoked.questions = questions;
			invoked.toolCallId = toolCallId;
			post(questions);
		},
		// ask-question-owners (Ops #1079): a chat with no requester records (the default owner's).
		questionOwners: () => ({ listed: new Set<string>() }),
	};
}

const QUESTIONS: UiQuestion[] = [
	{
		id: "q1",
		question: "Which one?",
		options: [{ label: "A", description: "Opt A", preview: "**A preview**" }, { label: "B" }],
		multiSelect: false,
	},
];

describe("makeAskUserQuestionTool", () => {
	it("工具定义里带 schema 参数（questions 必填）", () => {
		const tool = makeAskUserQuestionTool(mockSession());
		expect(tool.name).toBe("ask_user_question");
		// TypeBox schema 的 JSON 序列化应包含 questions 字段。
		const parsed = JSON.parse(JSON.stringify(tool.parameters));
		expect(parsed.properties.questions).toBeDefined();
		expect(parsed.required).toContain("questions");
	});

	it("execute posts the card under its tool call id and returns at once, without answers", async () => {
		const session = mockSession();
		const tool = makeAskUserQuestionTool(session);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const ctx = {} as any;
		const result = (await tool.execute("t1", { questions: QUESTIONS }, undefined, undefined, ctx)) as {
			content: { type: string; text: string }[];
			details: Record<string, unknown>;
		};

		expect(session.invoked.questions).toHaveLength(1);
		expect(session.invoked.questions[0].id).toBe("q1");
		expect(session.invoked.toolCallId).toBe("t1");
		expect(result.content[0].text).toContain("non-blocking");
		expect(result.details).not.toHaveProperty("answers");
	});

	it("questionnaires turned off: the call fails and nothing is posted", async () => {
		const session = mockSession(() => {
			throw new Error("Questionnaires are turned off; turn them back on in Settings");
		});
		const tool = makeAskUserQuestionTool(session);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const ctx = {} as any;
		await expect(tool.execute("t2", { questions: QUESTIONS }, undefined, undefined, ctx)).rejects.toThrow("turned off");
	});

	it("无问题 → 报错", async () => {
		const session = mockSession();
		const tool = makeAskUserQuestionTool(session);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const ctx = {} as any;
		await expect(tool.execute("t3", { questions: [] }, undefined, undefined, ctx)).rejects.toThrow(
			"requires at least one question",
		);
	});

	it("提问超过 3 个问题 → 报错阻断（防提问发散与问卷轰炸）", async () => {
		const session = mockSession();
		const tool = makeAskUserQuestionTool(session);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const ctx = {} as any;
		const fourQuestions: UiQuestion[] = [
			{ id: "q1", question: "Q1" },
			{ id: "q2", question: "Q2" },
			{ id: "q3", question: "Q3" },
			{ id: "q4", question: "Q4" },
		];
		await expect(tool.execute("t4", { questions: fourQuestions }, undefined, undefined, ctx)).rejects.toThrow(
			"at most 3 questions",
		);
	});

	it("包含收敛型澄清提问 promptGuidelines 与推荐置顶约束", () => {
		const tool = makeAskUserQuestionTool(mockSession());
		const guidelines = (tool.promptGuidelines as string[]).join("\n");
		expect(guidelines).toContain("1 to 3 focused questions");
		expect(guidelines).toContain("does not wait");
		expect(guidelines).toContain("recommended option first");
		expect(guidelines).toContain("impact/tradeoff");
	});
});
