/** Actual generic dialog resolution -> native metadata -> final coordinator/SDK dispatch fence. */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuestionAnswer } from "../../server/protocol.js";
import { UNBOUND_OWNER_ACCEPTANCE } from "../../server/queue-question-acceptance.js";
import { NativeQuestionWrite } from "../../server/queue-question-durability.js";
import { latch, nativeOwnerDialog, questionHostFixture, queueRecords } from "../fixtures/question-commit-host.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const close of cleanups.splice(0).reverse()) close();
	vi.restoreAllMocks();
});
const metadata = (manager: SessionManager) =>
	manager
		.getEntries()
		.flatMap((entry) => (entry.type === "custom" && entry.customType === UNBOUND_OWNER_ACCEPTANCE ? [entry.data] : []));
const answers: QuestionAnswer[] = [{ id: "generic-choice", selected: ["Keep the choice"] }];

function dialogFixture(separateHome = false) {
	const f = questionHostFixture({ separateHome });
	cleanups.push(f.close);
	const dialog = nativeOwnerDialog(f.parentSession, (source) => f.integration.observeUnboundOwnerAnswer(source));
	cleanups.push(dialog.close);
	return { f, ...dialog, answer: (cancelled = false) => dialog.answer(answers, cancelled) };
}

describe("unbound owner acceptance preserves the answer and fences recall", () => {
	it.each([false, true])(
		"saves metadata before resolution and excludes recall after reopening (separate parent: %s)",
		async (separateHome) => {
			const { f, answer, resolved } = dialogFixture(separateHome);
			if (separateHome) expect(f.binding.queue).not.toBe(f.roles[0].homeChat);
			resolved.mockImplementation((value) => {
				expect(value).toEqual(answers);
				expect(metadata(SessionManager.open(f.binding.queue))).toEqual([
					{ v: 1, rid: expect.any(String), at: 2000, sessionId: f.binding.queueId },
				]);
			});
			expect(answer()).toBe(true);
			expect(resolved).toHaveBeenCalledOnce();
			expect(await f.recall()).toMatchObject({
				status: "refused",
				reason: expect.stringContaining("already accepted an unbound dialog"),
			});
			f.restart();
			expect(await f.recall()).toMatchObject({
				status: "refused",
				reason: expect.stringContaining("already accepted an unbound dialog"),
			});
			expect(queueRecords(f.worker)).toEqual([]);
			expect(f.prompts).not.toHaveBeenCalled();
		},
	);

	it("checks a separate parent's accepted-but-unrelayed dialog after the dispatch await and after restart", async () => {
		const { f, answer, resolved } = dialogFixture(true);
		const entered = latch(),
			release = latch();
		f.control.beforeDispatch = async () => {
			entered.open();
			await release.promise;
		};
		const recall = f.recall();
		await entered.promise;
		try {
			expect(answer()).toBe(true);
			expect(resolved).toHaveBeenCalledWith(answers);
			expect(metadata(f.parent)).toHaveLength(1);
			expect(metadata(f.lead)).toEqual([]);
		} finally {
			release.open();
		}
		expect(await recall).toMatchObject({
			status: "refused",
			reason: expect.stringContaining("already accepted an unbound dialog"),
		});
		expect(queueRecords(f.worker)).toEqual([]); // No relay or owner admission was needed to exclude recall.
		f.restart();
		expect(await f.recall()).toMatchObject({
			status: "refused",
			reason: expect.stringContaining("already accepted an unbound dialog"),
		});
		expect(f.prompts).not.toHaveBeenCalled();
	});

	it("checks acceptance at final consumption after the queued command wait", async () => {
		const { f, answer, resolved } = dialogFixture();
		f.control.beforeConsume = () => {
			expect(answer()).toBe(true);
		};
		expect((await f.recall()).status).toBe("refused");
		expect(f.commands).toHaveLength(1);
		expect(resolved).toHaveBeenCalledWith(answers);
		expect(queueRecords(f.worker)).toEqual([]);
	});

	it.each([false, true])(
		"preserves the generic answer when its marker cannot be written (separate parent: %s)",
		async (separateHome) => {
			const { f, answer, resolved } = dialogFixture(separateHome);
			const logged = vi.spyOn(console, "error").mockImplementation(() => {});
			const append = f.parent.appendCustomEntry;
			Object.defineProperty(f.parent, "appendCustomEntry", {
				configurable: true,
				value: () => {
					throw new Error("synthetic unavailable writer");
				},
			});
			expect(answer()).toBe(true);
			expect(resolved).toHaveBeenCalledWith(answers);
			expect(logged).toHaveBeenCalled();
			Object.defineProperty(f.parent, "appendCustomEntry", { value: append, configurable: true });
			expect(metadata(SessionManager.open(f.binding.queue))).toEqual([]);
			expect(await f.recall()).toMatchObject({
				status: "refused",
				reason: expect.stringContaining("persistence was uncertain"),
			});
			f.restart(); // The failed marker has no bytes to replay: absence must not restore permission.
			expect(await f.recall()).toMatchObject({
				status: "refused",
				reason: expect.stringContaining("acceptance coverage"),
			});
			expect(queueRecords(f.worker)).toEqual([]);
		},
	);

	it("a failed durability acknowledgement retains the answer and uncertainty", async () => {
		const { f, answer, resolved } = dialogFixture();
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(NativeQuestionWrite.prototype, "acknowledgeMetadata").mockImplementation(() => {
			throw new Error("synthetic fsync acknowledgement failed");
		});
		expect(answer()).toBe(true);
		expect(resolved).toHaveBeenCalledWith(answers);
		expect(await f.recall()).toMatchObject({
			status: "refused",
			reason: expect.stringContaining("fsync acknowledgement failed"),
		});
		f.restart();
		expect((await f.recall()).status).toBe("refused");
		expect(queueRecords(f.worker)).toEqual([]);
	});

	it("does not give an unregistered separate parent marker authority or lose its accepted answer", async () => {
		const { f, answer, resolved } = dialogFixture(true);
		vi.spyOn(console, "error").mockImplementation(() => {});
		const endpoint = f.registry.get(f.binding.queueId)!;
		f.registry.delete(f.binding.queueId);
		expect(answer()).toBe(true);
		expect(resolved).toHaveBeenCalledWith(answers);
		expect(metadata(f.parent)).toEqual([]);
		f.registry.set(f.binding.queueId, endpoint);
		expect(await f.recall()).toMatchObject({
			status: "refused",
			reason: expect.stringContaining("persistence was uncertain"),
		});
		expect(queueRecords(f.worker)).toEqual([]);
	});

	it("does not turn cancellation or a worker dialog into root acceptance", async () => {
		const { f, answer, resolved, pending, id } = dialogFixture();
		expect(answer(true)).toBe(true);
		expect(resolved).toHaveBeenCalledWith(null);
		f.worker.appendCustomEntry("queue", {
			v: 1,
			op: "assigned",
			id: f.binding.id,
			from: { file: f.binding.queue, title: "Synthetic parent" },
		});
		pending.set(id, {
			resolve: resolved,
			questions: [],
			nativeSource: { sessionId: f.binding.workerId, file: f.binding.worker },
		});
		expect(answer()).toBe(true);
		expect(metadata(f.parent)).toEqual([]);
		expect(metadata(f.worker)).toEqual([]);
		expect((await f.recall()).status).toBe("committed");
	});

	it.each([false, true])(
		"keeps acceptance from abandoned branches after restart (separate parent: %s)",
		async (separateHome) => {
			const { f, answer } = dialogFixture(separateHome);
			const leaf = f.parent.getLeafId()!;
			expect(answer()).toBe(true);
			f.parent.branch(leaf);
			f.parent.appendCustomEntry("synthetic-branch", { fixture: true });
			expect(
				f.parent.getBranch().some((entry) => entry.type === "custom" && entry.customType === UNBOUND_OWNER_ACCEPTANCE),
			).toBe(false);
			expect(metadata(f.parent)).toHaveLength(1);
			expect(await f.recall()).toMatchObject({
				status: "refused",
				reason: expect.stringContaining("already accepted an unbound dialog"),
			});
			f.restart();
			expect(await f.recall()).toMatchObject({
				status: "refused",
				reason: expect.stringContaining("already accepted an unbound dialog"),
			});
			expect(queueRecords(f.worker)).toEqual([]);
		},
	);

	it("a saved acceptance before the question does not affect that later question", async () => {
		const { f, answer } = dialogFixture();
		f.control.now = f.binding.at - 1;
		expect(answer()).toBe(true);
		f.control.now = 2000;
		expect((await f.recall()).status).toBe("committed");
	});

	it.each([false, true])(
		"refuses unknown pre-coverage history instead of trusting absent legacy records (separate parent: %s)",
		async (separateHome) => {
			const { f } = dialogFixture(separateHome);
			f.restart();
			expect(metadata(f.parent)).toEqual([]);
			expect(await f.recall()).toMatchObject({
				status: "refused",
				reason: expect.stringContaining("legacy or unrecorded owner acceptance"),
			});
			expect(queueRecords(f.worker)).toEqual([]);
		},
	);

	it("preserves generic resolution with missing source identity but does not infer recall permission", async () => {
		const { f, pending, answer, resolved, id } = dialogFixture();
		vi.spyOn(console, "error").mockImplementation(() => {});
		delete pending.get(id)!.nativeSource;
		expect(answer()).toBe(true);
		expect(resolved).toHaveBeenCalledWith(answers);
		expect((await f.recall()).status).toBe("refused");
	});

	it("still lets the native author validate an already receipt without writing another recall", async () => {
		const { f, answer } = dialogFixture();
		expect((await f.recall()).status).toBe("committed");
		expect(answer()).toBe(true);
		f.restart();
		expect((await f.recall()).status).toBe("already");
		expect(queueRecords(f.worker).filter((row) => row.op === "recall")).toHaveLength(1);
		f.control.done = true;
		expect((await f.recall()).status).toBe("refused");
	});
});
