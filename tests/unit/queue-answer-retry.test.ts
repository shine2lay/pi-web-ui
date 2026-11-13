/**
 * frontend #286: the Queue tab's answer card offers "Try again" when an answer didn't go through. A retry
 * must never apply a second answer to the same question: while the first is still on its way (design
 * #305, 2026-11-12: the server's send hung), and after it lands late. The server's own questionId and
 * in-flight checks refuse it; this proves it on the real taskQueueAnswer route.
 */
import { describe, expect, it } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import type { ServerMessage } from "../../server/protocol.js";

type Outcome = { reqId?: string; applied: boolean; reason?: string; questionId?: string };
type Binding = { questionId: string; question: string; choices: string[]; detail?: string };

describe("Queue tab answer retry (frontend #286)", () => {
	it("a retry while the first answer hangs, or after it lands late, never applies a second answer", async () => {
		const q = {
			running: false,
			available: true,
			paused: false,
			lanes: 1,
			queueId: "q-retry-286",
			tasks: [
				{
					id: 286,
					text: "Blind bake-off",
					status: "stuck" as const,
					lane: true,
					chat: { file: "/tmp/task-286-retry.jsonl", title: "Task 286" },
					plan: { title: "Blind bake-off" } as never,
					question: "Which of the four first drafts?",
					choices: ["W", "X", "Y", "Z"],
					detail: "The whole picture",
					createdAt: 1,
				},
			],
		};
		const conv = {
			id: "conv-286",
			title: "Design lead",
			cwd: "/tmp",
			isSubagent: false,
			session: {
				sessionFile: "/tmp/main-design-286.jsonl",
				sessionManager: {
					getSessionFile: () => "/tmp/main-design-286.jsonl",
					getSessionId: () => "sess-design-286",
				},
			},
		};
		const sent: string[] = [];
		let finishFirst: (r: { ok: boolean }) => void = () => {};
		const csStatic = ClientSession as unknown as {
			sharedConvs: Map<string, unknown>;
			stuckAnswerSender?: (target: string, text: string) => Promise<{ ok: boolean; error?: string }>;
			taskQueueOfConv: (c: unknown) => typeof q;
		};
		const origTaskQueueOfConv = csStatic.taskQueueOfConv;
		const origSender = csStatic.stuckAnswerSender;
		csStatic.sharedConvs.set(conv.id, conv);
		csStatic.taskQueueOfConv = () => q;
		// The first send hangs, as the relay deadlock held it on 2026-11-12 (Ops #860); later ones would succeed.
		csStatic.stuckAnswerSender = (_target, text) => {
			sent.push(text);
			return sent.length === 1 ? new Promise((resolve) => (finishFirst = resolve)) : Promise.resolve({ ok: true });
		};
		try {
			const emitted: ServerMessage[] = [];
			const harness = { convs: new Map([[conv.id, conv]]), emit: (m: ServerMessage) => void emitted.push(m) };
			const proto = ClientSession.prototype as unknown as {
				queueAnswerBindings(this: typeof harness, c: unknown, queue: typeof q): Binding[] | undefined;
				taskQueueAnswer(
					this: typeof harness,
					conversationId: string,
					taskId: number,
					text: string,
					binding: Record<string, unknown>,
				): Promise<Outcome>;
			};
			const occ = proto.queueAnswerBindings.call(harness, conv, q)![0];
			expect(occ.questionId).toMatch(/^stuck-/);
			const answer = (reqId: string, text: string) =>
				proto.taskQueueAnswer.call(harness, conv.id, 286, text, {
					reqId,
					queueId: q.queueId,
					questionId: occ.questionId,
					question: occ.question,
					choices: occ.choices,
					detail: occ.detail,
				});

			// 1. The first tap reaches the server and its send hangs: no reply yet.
			let firstSettled = false;
			const first = answer("qa-first", "Z").then((r) => ((firstSettled = true), r));
			await new Promise((r) => setTimeout(r, 0));
			expect(firstSettled).toBe(false);
			expect(sent).toEqual(["Z"]);

			// 2. The card gave up waiting and the owner taps "Try again": refused, nothing sent.
			const retryWhileHung = await answer("qa-retry-1", "Z");
			expect(retryWhileHung).toMatchObject({ reqId: "qa-retry-1", applied: false });
			expect(retryWhileHung.reason).toMatch(/already on its way/);
			expect(sent).toEqual(["Z"]);
			expect(emitted.at(-1)).toMatchObject({ type: "task_queue_answer_result", reqId: "qa-retry-1", applied: false });

			// 3. The first answer lands late.
			finishFirst({ ok: true });
			expect(await first).toMatchObject({ reqId: "qa-first", applied: true });

			// 4. Another retry after the late success, even a different choice: refused, still one answer.
			const retryAfterLate = await answer("qa-retry-2", "W");
			expect(retryAfterLate.applied).toBe(false);
			expect(sent).toEqual(["Z"]);
		} finally {
			csStatic.sharedConvs.delete(conv.id);
			csStatic.taskQueueOfConv = origTaskQueueOfConv;
			csStatic.stuckAnswerSender = origSender;
		}
	});
});
