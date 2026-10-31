import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { questionHostFixture, queueRecords, latch } from "../fixtures/question-commit-host.js";
import { ownerQuestionChange } from "../../server/queue-question-owner.js";
import type { QuestionCommitEndpoint } from "../../server/queue-question-port.js";

const fixtures: ReturnType<typeof questionHostFixture>[] = [];
const fixture = () => {
	const f = questionHostFixture();
	fixtures.push(f);
	return f;
};
afterEach(() => {
	for (const f of fixtures.splice(0).reverse()) f.close();
});

// Commands pass through installQueueHost -> coordinator -> AgentService.queueRunCommand -> native
// AgentSession.prompt -> registered command handler -> endpoint -> synchronous finish/fsync.
describe("native serialized question commits", () => {
	it("recall wins before owner admission, without starting a worker turn", async () => {
		const f = fixture();
		const entered = latch(),
			release = latch();
		f.control.beforeDispatch = async () => {
			entered.open();
			await release.promise;
		};
		const recall = f.recall();
		await entered.promise;
		const owner = f.host.commitQuestion!(
			f.binding.workerId,
			f.binding,
			ownerQuestionChange(f.binding, "Yes", "browser"),
		);
		release.open();
		expect((await recall).status).toBe("committed");
		expect((await owner).status).toBe("refused");
		expect(queueRecords(f.worker).map((r) => r.op)).toEqual(["recall"]);
		expect(f.commands).toHaveLength(2);
		expect(f.commands.every((c) => /^question-commit [a-f0-9]{64}$/.test(c))).toBe(true);
		expect(f.prompts).not.toHaveBeenCalled();
	});

	it("an accepted owner answer wins, including restart before any delivery", async () => {
		const f = fixture();
		const entered = latch(),
			release = latch();
		f.control.beforeDispatch = async () => {
			entered.open();
			await release.promise;
		};
		const owner = f.integration.admitOwnerAnswer(f.binding, "Yes", "telegram");
		await entered.promise;
		const recall = f.recall();
		release.open();
		expect((await owner).status).toBe("committed");
		expect((await recall).status).toBe("refused");
		f.restart();
		expect((await f.recall()).status).toBe("refused");
		expect((await f.integration.admitOwnerAnswer(f.binding, "Yes", "telegram")).status).toBe("already");
		expect(queueRecords(f.worker).map((r) => r.op)).toEqual(["owner_admission"]);
	});

	it("leaves duplicate revision admission to the native author and preserves the first receipt", async () => {
		const f = fixture();
		const first = await f.recall();
		expect(first.status).toBe("committed");
		expect(f.endpoint.binding(f.binding.id)?.revision).toBe(1);
		const duplicate = await f.host.commitQuestion!(f.binding.queueId, f.binding, {
			kind: "recall",
			rid: "r000000000099",
			tag: "synthetic-tag",
			reason: "Retry",
		});
		expect(duplicate).toEqual({ status: "already", rid: "r000000000002", revision: 1 });
		expect(queueRecords(f.worker)).toHaveLength(1);
		f.control.done = true;
		expect((await f.recall()).status).toBe("refused");
	});

	it("rechecks the parent's synchronous hold immediately before append", async () => {
		const f = fixture();
		f.control.beforeConsume = () => f.parent.appendCustomEntry("queue", { v: 1, op: "pause", ts: 1500 });
		expect(await f.recall()).toMatchObject({ status: "refused", reason: "parent held" });
		expect(queueRecords(f.worker)).toEqual([]);
	});

	it("authenticates registered source identity and the current home at final consumption", async () => {
		const f = fixture();
		f.control.beforeConsume = () => {
			f.roles[0].homeChat = f.binding.worker;
		};
		expect((await f.recall()).status).toBe("refused");
		expect(queueRecords(f.worker)).toEqual([]);
		f.control.beforeConsume = undefined;
		f.roles[0].homeChat = f.binding.queue;
		f.parent.appendCustomEntry("identity", { v: 1, id: "design", via: "fixture" });
		expect((await f.recall()).status).toBe("refused");
	});

	it("refuses missing or multiply registered sources, never authenticating a request field", async () => {
		const f = fixture();
		const existing = [...f.registry.get(f.binding.queueId)!][0];
		f.registry.get(f.binding.queueId)!.add({ ...existing });
		expect((await f.recall()).status).toBe("refused");
		f.registry.delete(f.binding.queueId);
		expect((await f.recall()).status).toBe("refused");
		expect(f.commands).toEqual([]);
		expect(queueRecords(f.worker)).toEqual([]);
	});

	it("scopes each token to one worker and consumes it once", async () => {
		const f = fixture();
		f.control.wrongWorker = true;
		expect((await f.recall()).status).toBe("refused");
		expect(f.host.consumeQuestionCommit!(f.control.lastToken, f.binding.workerId)).toBeUndefined();
		f.control.wrongWorker = false;
		expect((await f.recall()).status).toBe("committed");
		expect(f.host.consumeQuestionCommit!(f.control.lastToken, f.binding.workerId)).toBeUndefined();
	});

	it("a command that consumes but yields without finish poisons the occurrence", async () => {
		const f = fixture();
		f.control.skipFinish = true;
		expect(await f.recall()).toMatchObject({ status: "uncertain", reason: expect.stringContaining("yielded") });
		f.control.skipFinish = false;
		expect((await f.recall()).status).toBe("uncertain");
		expect(f.commands).toHaveLength(1);
	});

	it("releases the lane at finish rather than waiting for aftermath", async () => {
		const f = fixture();
		const release = latch();
		f.control.afterFinish = () => release.promise;
		expect((await f.recall()).status).toBe("committed");
		expect((await f.recall()).status).toBe("already");
		expect(f.commands).toHaveLength(2);
		release.open();
	});

	it("dispatches recall aftermath outside the lane and retries it for an already receipt", async () => {
		const f = fixture();
		const entered = latch(),
			repeated = latch(),
			release = latch();
		let count = 0;
		f.control.beforeAfter = async () => {
			if (++count === 1) entered.open();
			else repeated.open();
			await release.promise;
		};
		expect((await f.recall()).status).toBe("committed");
		await entered.promise;
		// The first native aftermath command is still pending, but a duplicate can use the writer lane.
		expect((await f.recall()).status).toBe("already");
		await repeated.promise;
		expect(f.afterCommands).toEqual(["question-after r000000000002", "question-after r000000000002"]);
		expect(queueRecords(f.worker)).toHaveLength(1);
		expect(f.prompts).not.toHaveBeenCalled();
		release.open();
	});

	it("poisons uncertain append outcomes even if memory has already advanced its revision", async () => {
		const f = fixture();
		f.control.appendFailure = true;
		expect((await f.recall()).status).toBe("uncertain");
		f.control.appendFailure = false;
		const current = f.endpoint.binding(f.binding.id)!;
		expect(
			(
				await f.host.commitQuestion!(f.binding.queueId, current, {
					kind: "recall",
					rid: "r000000000003",
					tag: "synthetic-new-tag",
					reason: "Retry",
				})
			).status,
		).toBe("uncertain");
		expect(f.commands).toHaveLength(1);
		expect(f.afterCommands).toEqual([]);
	});

	it("refuses asynchronous/durable-style writer wrappers before authoring any record", async () => {
		const f = fixture();
		const nativeAppend = f.worker.appendCustomEntry;
		Object.defineProperty(f.worker, "appendCustomEntry", {
			value: (...args: Parameters<SessionManager["appendCustomEntry"]>) =>
				Promise.resolve(nativeAppend.apply(f.worker, args)),
		});
		expect(await f.recall()).toMatchObject({
			status: "refused",
			reason: expect.stringContaining("synchronous native"),
		});
		expect(queueRecords(f.worker)).toEqual([]);
	});

	it("rejects a success with no canonical append instead of treating void return as durable ACK", async () => {
		const f = fixture();
		const original: QuestionCommitEndpoint["commit"] = f.endpoint.commit;
		f.endpoint.commit = () => ({ status: "committed", rid: "r000000000002", revision: 1 });
		expect(await f.recall()).toMatchObject({ status: "uncertain", reason: expect.stringContaining("canonical") });
		f.endpoint.commit = original;
		expect((await f.recall()).status).toBe("uncertain");
		expect(queueRecords(f.worker)).toEqual([]);
	});

	// Ops #674 Rule 24 restore: the same lane, actor, fence and durable-receipt path as recall.
	it("restore commits one native op, retries its aftermath outside the lane and never prompts the worker", async () => {
		const f = fixture();
		const second = latch();
		let count = 0;
		f.control.beforeAfter = async () => {
			if (++count === 2) second.open();
		};
		expect(await f.restore()).toEqual({ status: "committed", rid: "r000000000003", revision: 1 });
		expect(await f.restore()).toEqual({ status: "already", rid: "r000000000003", revision: 1 });
		expect(queueRecords(f.worker).map((r) => r.op)).toEqual(["restore"]);
		// Aftermath runs outside the writer lane: wait for its second dispatch, not a time.
		await second.promise;
		expect(f.afterCommands).toEqual(["question-after r000000000003", "question-after r000000000003"]);
		expect(f.prompts).not.toHaveBeenCalled();
	});

	it("an accepted owner answer wins over a later restore, and a restore over a later owner answer", async () => {
		const first = fixture();
		expect((await first.integration.admitOwnerAnswer(first.binding, "Keep waiting", "telegram")).status).toBe(
			"committed",
		);
		expect((await first.restore()).status).toBe("refused");
		expect(queueRecords(first.worker).map((r) => r.op)).toEqual(["owner_admission"]);
		const second = fixture();
		expect((await second.restore()).status).toBe("committed");
		expect((await second.integration.admitOwnerAnswer(second.binding, "Keep waiting", "telegram")).status).toBe(
			"refused",
		);
		expect(queueRecords(second.worker).map((r) => r.op)).toEqual(["restore"]);
	});

	it("refuses a malformed restore before dispatch and a restore receipt for another generation as uncertain", async () => {
		const f = fixture();
		const bad = await f.host.commitQuestion!(f.lead.getSessionId(), f.binding, {
			kind: "restore",
			rid: "r000000000004",
			tag: "synthetic-tag",
			reason: "Synthetic",
			refs: { question: "q", source: "", block: "b", poke: "p", dispatch: "d" },
		});
		expect(bad.status).toBe("refused");
		expect(f.commands).toEqual([]);
		f.control.restoreWrongGeneration = true;
		expect((await f.restore()).status).toBe("uncertain");
		expect(f.afterCommands).toEqual([]);
	});

	it("restore keeps the parent hold and current-home checks at final consumption", async () => {
		const f = fixture();
		f.control.beforeConsume = () => f.parent.appendCustomEntry("queue", { v: 1, op: "pause", ts: 1500 });
		expect(await f.restore()).toMatchObject({ status: "refused", reason: "parent held" });
		const g = fixture();
		g.control.beforeConsume = () => {
			g.roles[0].homeChat = g.binding.worker;
		};
		expect((await g.restore()).status).toBe("refused");
		expect(queueRecords(f.worker)).toEqual([]);
		expect(queueRecords(g.worker)).toEqual([]);
	});

	it("writes only to the established native JSONL; replay sees the acknowledged recall", async () => {
		const f = fixture();
		expect((await f.recall()).status).toBe("committed");
		const replayed = SessionManager.open(f.binding.worker);
		expect(queueRecords(replayed)).toMatchObject([
			{ op: "recall", revision: 0, retraction: { rid: "r000000000002", escalation: f.binding.escalation } },
		]);
	});
});
