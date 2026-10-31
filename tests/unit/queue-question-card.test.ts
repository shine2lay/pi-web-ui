import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { questionHostFixture, latch } from "../fixtures/question-commit-host.js";
import type { QuestionBinding } from "../../server/queue-question-port.js";

const fixtures: ReturnType<typeof questionHostFixture>[] = [];
const fixture = async () => {
	const f = questionHostFixture();
	fixtures.push(f);
	expect((await f.recall()).status).toBe("committed");
	return f;
};
afterEach(() => {
	for (const f of fixtures.splice(0).reverse()) f.close();
});
const cards = (manager: SessionManager) =>
	manager.getBranch().filter((e) => e.type === "custom_message" && e.customType === "queue-question-card");
const currentBinding = (f: ReturnType<typeof questionHostFixture>) => f.endpoint.binding(f.binding.id)!;
const send = (f: ReturnType<typeof questionHostFixture>, binding: QuestionBinding = currentBinding(f)) =>
	f.host.deliverQuestionCard!(f.binding.queueId, "synthetic-recall-tag", "Synthetic recall card", binding);

describe("native recall card acknowledgement", () => {
	it("persists one occurrence-tagged card, retries idempotently, and never starts any model turn", async () => {
		const f = await fixture();
		expect(await send(f)).toEqual({ status: "delivered" });
		expect(await send(f)).toEqual({ status: "already" });
		expect(cards(f.parent)).toHaveLength(1);
		expect(f.commands).toHaveLength(1); // Only the original recall commit; delivery adds no command or turn.
		expect(f.prompts).not.toHaveBeenCalled();
		const restored = SessionManager.open(f.binding.queue);
		Object.defineProperty(f.parentSession, "sessionManager", { value: restored, configurable: true });
		f.restart();
		expect(await send(f)).toEqual({ status: "already" });
		expect(cards(restored)).toHaveLength(1);
	});

	it("busy is pending, not a void sendUserMessage claim, and the same tag succeeds after idle", async () => {
		const f = await fixture();
		f.control.busy = true;
		expect(await send(f)).toMatchObject({ status: "pending" });
		expect(cards(f.parent)).toEqual([]);
		f.control.busy = false;
		expect(await send(f)).toEqual({ status: "delivered" });
		expect(f.prompts).not.toHaveBeenCalled();
	});

	it("an SDK failure after append is uncertain; retry acknowledges the saved tag without duplicating it", async () => {
		const f = await fixture();
		const refresh = Reflect.get(f.parentSession, "_refreshFinalizedContext") as ReturnType<typeof vi.fn>;
		refresh.mockImplementationOnce(() => {
			throw new Error("synthetic SDK event failure");
		});
		expect(await send(f)).toMatchObject({ status: "uncertain", reason: "synthetic SDK event failure" });
		expect(cards(f.parent)).toHaveLength(1);
		expect(await send(f)).toEqual({ status: "already" });
		expect(cards(f.parent)).toHaveLength(1);
	});

	it("never redirects a recall card into the worker or a former home", async () => {
		const f = await fixture();
		expect(
			(
				await f.host.deliverQuestionCard!(
					f.binding.workerId,
					"synthetic-recall-tag",
					"Synthetic recall card",
					currentBinding(f),
				)
			).status,
		).toBe("refused");
		f.roles[0].homeChat = f.binding.worker;
		expect((await send(f)).status).toBe("refused");
		expect(cards(f.parent)).toEqual([]);
		expect(cards(f.worker)).toEqual([]);
	});

	it("revalidates the current home after opening waits and again for the next lane item", async () => {
		const f = await fixture();
		const entered = latch(),
			release = latch();
		let first = true;
		f.control.beforePrepare = async () => {
			if (!first) return;
			first = false;
			entered.open();
			await release.promise;
		};
		const active = send(f);
		await entered.promise;
		const queued = send(f);
		f.roles[0].homeChat = f.binding.worker;
		release.open();
		expect((await active).status).toBe("refused");
		expect((await queued).status).toBe("refused");
		expect(cards(f.parent)).toEqual([]);
	});

	it("requires the optional native binding/guard and does not trust supplied card text", async () => {
		const f = await fixture();
		expect(
			(await f.host.deliverQuestionCard!(f.binding.queueId, "synthetic-recall-tag", "Synthetic recall card")).status,
		).toBe("refused");
		expect(
			(await f.host.deliverQuestionCard!(f.binding.queueId, "synthetic-recall-tag", "Forged text", currentBinding(f)))
				.status,
		).toBe("refused");
		delete f.endpoint.checkCard;
		expect((await send(f)).status).toBe("refused");
		expect(cards(f.parent)).toEqual([]);
	});

	it("refuses unknown sender wrappers rather than bypassing them", async () => {
		const f = await fixture();
		const original = f.parentSession.sendCustomMessage.bind(f.parentSession);
		f.parentSession.sendCustomMessage = async (message, options) => original(message, options);
		expect((await send(f)).status).toBe("refused");
		expect(cards(f.parent)).toEqual([]);
	});

	it.each(["revision", "answered", "pause", "source", "done"] as const)(
		"rechecks native %s before final delivery",
		async (change) => {
			const f = await fixture();
			const binding = currentBinding(f);
			if (change === "revision") f.control.revision++;
			if (change === "answered") f.worker.appendCustomEntry("queue", { op: "owner_admission" });
			if (change === "pause") f.parent.appendCustomEntry("queue", { op: "pause" });
			if (change === "source") f.control.sourceAllowed = false;
			if (change === "done") f.control.done = true;
			expect((await send(f, binding)).status).toBe("refused");
			expect(cards(f.parent)).toEqual([]);
		},
	);
});
