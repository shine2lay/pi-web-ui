/** Native owner UI boundaries. No model turns or live sessions; dispatcher fixture is shared. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import type { ServerMessage, UiTaskQueue, UiTaskQueueAnswerBinding } from "../../server/protocol.js";
import { askHub } from "../../server/asks.js";
import { nativeOwnerQuestionBinding } from "../../server/queue-question-native.js";
import { questionHostFixture, queueRecords } from "../fixtures/question-commit-host.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanups.splice(0).reverse()) close();
});

function ownerFixture() {
	const f = questionHostFixture();
	cleanups.push(f.close);
	const queue: UiTaskQueue = {
		queueId: f.binding.queueId,
		available: true,
		running: true,
		tasks: [
			{
				id: 7,
				status: "stuck",
				addedAt: 1,
				lane: true,
				chat: { file: f.binding.worker },
				question: "Synthetic same question",
				choices: ["Yes", "No"],
				detail: "Synthetic context",
				plan: { title: "Synthetic task", goal: "", doneWhen: "", decided: "", steps: "", verify: "", mustNot: "" },
			},
		],
	};
	const conv = {
		id: "question-commit-owner-fixture",
		title: "Synthetic lead",
		cwd: f.root,
		isSubagent: false,
		session: f.parentSession,
	};
	const statics = ClientSession as unknown as {
		sharedConvs: Map<string, unknown>;
		taskQueueOfConv(conv: unknown): UiTaskQueue;
		stuckAsks: Map<string, { askId: string; sig: string; target: string }>;
		stuckAnswers: Map<string, unknown>;
		stuckSeq: number;
		stuckReconcileTimer: ReturnType<typeof setTimeout> | null;
	};
	const saved = {
		read: statics.taskQueueOfConv,
		send: ClientSession.stuckAnswerSender,
		admit: ClientSession.admitQuestionAnswer,
		sequence: statics.stuckSeq,
	};
	statics.sharedConvs.set(conv.id, conv);
	statics.taskQueueOfConv = () => queue;
	ClientSession.admitQuestionAnswer = f.integration.admitOwnerAnswer;
	const delivered = vi.fn(async () => ({ ok: true }));
	ClientSession.stuckAnswerSender = delivered;
	const client: ClientSession = Object.create(ClientSession.prototype);
	Object.defineProperties(client, {
		convs: { value: new Map([[conv.id, conv]]) },
		activeId: { value: conv.id },
		emit: { value: vi.fn<(message: ServerMessage) => void>() },
	});
	const getBindings = Reflect.get(ClientSession.prototype, "queueAnswerBindings") as (
		this: ClientSession,
		conv: unknown,
		queue: UiTaskQueue,
	) => UiTaskQueueAnswerBinding[] | undefined;
	cleanups.push(() => {
		if (statics.stuckReconcileTimer) clearTimeout(statics.stuckReconcileTimer);
		statics.stuckReconcileTimer = null;
		statics.sharedConvs.delete(conv.id);
		for (const [key, ask] of statics.stuckAsks) {
			if (!key.startsWith(f.root)) continue;
			askHub.settle(ask.askId, { how: "gone", reason: "fixture cleanup" });
			statics.stuckAnswers.delete(ask.askId);
			statics.stuckAsks.delete(key);
		}
		statics.taskQueueOfConv = saved.read;
		ClientSession.stuckAnswerSender = saved.send;
		ClientSession.admitQuestionAnswer = saved.admit;
		statics.stuckSeq = saved.sequence;
	});
	return {
		...f,
		queue,
		conv,
		client,
		delivered,
		statics,
		card: () => getBindings.call(client, conv, queue)![0],
		answer: (card: UiTaskQueueAnswerBinding, text = "Yes") => client.taskQueueAnswer(conv.id, 7, text, card),
	};
}

describe("actual native owner acceptance", () => {
	it("prefers the endpoint's active owner binding over its general binding", () => {
		const f = ownerFixture();
		const active = { ...f.binding, revision: 2, escalation: "r000000000009" };
		const general = vi.spyOn(f.endpoint, "binding");
		f.endpoint.ownerBinding = vi.fn(() => active);
		expect(nativeOwnerQuestionBinding(f.workerSession, 7)).toEqual(active);
		expect(f.endpoint.ownerBinding).toHaveBeenCalledWith(7);
		expect(general).not.toHaveBeenCalled();
	});

	it("does not fall back after ownerBinding returns undefined and keeps ordinary owner delivery", async () => {
		const f = ownerFixture();
		const general = vi.spyOn(f.endpoint, "binding");
		f.endpoint.ownerBinding = vi.fn(() => undefined);
		expect(nativeOwnerQuestionBinding(f.workerSession, 7)).toBeUndefined();
		Object.defineProperty(f.client, "conv", { value: { ...f.conv, session: f.workerSession } });
		f.queue.from = { file: f.binding.queue };
		f.queue.tasks[0].lane = false;
		const deliver = vi.fn(async () => {});
		Object.defineProperty(f.client, "promptInLine", { value: deliver });
		await f.client.prompt("Yes", undefined, false, undefined, { ownerChannel: "browser", cause: "browser" });
		expect(f.endpoint.ownerBinding).toHaveBeenCalledWith(7);
		expect(general).not.toHaveBeenCalled();
		expect(deliver).toHaveBeenCalledOnce();
		expect(queueRecords(f.worker)).toEqual([]);
	});

	it("falls back to the general binding only for a legacy endpoint without ownerBinding", () => {
		const f = ownerFixture();
		const general = vi.spyOn(f.endpoint, "binding");
		expect(f.endpoint.ownerBinding).toBeUndefined();
		expect(nativeOwnerQuestionBinding(f.workerSession, 7)).toEqual(f.binding);
		expect(general).toHaveBeenCalledWith(7);
	});

	it("persists owner_admission before Queue-tab delivery and retains it on failed delivery/restart", async () => {
		const f = ownerFixture();
		ClientSession.stuckAnswerSender = vi.fn(async () => {
			expect(queueRecords(f.worker)).toMatchObject([{ op: "owner_admission", admission: { answer: "Yes" } }]);
			return { ok: false, error: "synthetic delivery failed" };
		});
		const answer = await f.answer(f.card());
		expect(answer.applied).toBe(false);
		expect(answer.reason).toBe("synthetic delivery failed");
		f.restart();
		expect((await f.recall()).status).toBe("refused");
	});

	it("same text re-escalated rejects the old Queue-tab card even after the AskHub counter restarts", async () => {
		const f = ownerFixture();
		const old = f.card();
		f.control.revision++;
		f.control.escalation = "r000000000003";
		askHub.settle(old.questionId, { how: "gone", reason: "synthetic restart" });
		f.statics.stuckAsks.delete(`${f.binding.worker}#7`);
		f.statics.stuckSeq = 0;
		const fresh = f.card();
		expect(fresh.questionId).not.toBe(old.questionId);
		expect((await f.answer(old)).applied).toBe(false);
		expect(f.delivered).not.toHaveBeenCalled();
		expect((await f.answer(fresh)).applied).toBe(true);
		expect(queueRecords(f.worker)).toMatchObject([{ op: "owner_admission", revision: 1 }]);
	});

	it("the AskHub/Telegram acceptance path uses the same durable writer before delivery", async () => {
		const f = ownerFixture();
		const card = f.card();
		expect(
			await askHub.answer(card.questionId, [{ id: "answer", selected: [], text: "Yes" }], "telegram"),
		).toMatchObject({ ok: true });
		expect(queueRecords(f.worker)).toMatchObject([
			{ op: "owner_admission", admission: { answer: "Yes", from: "telegram" } },
		]);
		expect((await f.recall()).status).toBe("refused");
	});

	it("keeps legacy unbound answers on their existing path", async () => {
		const f = ownerFixture();
		f.registry.clear();
		expect((await f.answer(f.card())).applied).toBe(true);
		expect(f.delivered).toHaveBeenCalledOnce();
		expect(queueRecords(f.worker)).toEqual([]);
	});

	it("unsupported async adapters preserve legacy answers while explicitly refusing recall", async () => {
		const f = ownerFixture();
		const nativeAppend = f.parent.appendCustomEntry;
		Object.defineProperty(f.parent, "appendCustomEntry", {
			value: (...args: Parameters<typeof nativeAppend>) => Promise.resolve(nativeAppend.apply(f.parent, args)),
		});
		expect((await f.answer(f.card())).applied).toBe(true);
		expect(f.delivered).toHaveBeenCalledOnce();
		expect(queueRecords(f.worker)).toEqual([]);
		expect(await f.recall()).toMatchObject({
			status: "refused",
			reason: expect.stringContaining("synchronous native"),
		});
	});

	it("admission failure prevents delivery instead of consuming an owner answer in memory", async () => {
		const f = ownerFixture();
		f.control.beforeConsume = () => f.parent.appendCustomEntry("queue", { v: 1, op: "pause", ts: 1500 });
		expect((await f.answer(f.card())).applied).toBe(false);
		expect(f.delivered).not.toHaveBeenCalled();
		expect(queueRecords(f.worker)).toEqual([]);
	});

	it("captures direct native owner input before prompt delivery can defer or fail", async () => {
		const f = ownerFixture();
		const workerConv = { ...f.conv, session: f.workerSession };
		Object.defineProperty(f.client, "conv", { value: workerConv });
		f.queue.from = { file: f.binding.queue };
		f.queue.tasks[0].lane = false;
		const deliver = vi.fn(async () => {
			expect(queueRecords(f.worker)).toMatchObject([{ op: "owner_admission" }]);
			throw new Error("synthetic deferred delivery failure");
		});
		Object.defineProperty(f.client, "promptInLine", { value: deliver });
		await expect(
			f.client.prompt("Yes", undefined, false, undefined, { ownerChannel: "browser", cause: "browser" }),
		).rejects.toThrow("synthetic deferred delivery failure");
		expect(deliver).toHaveBeenCalledOnce();
		f.restart();
		expect((await f.recall()).status).toBe("refused");
	});
});
