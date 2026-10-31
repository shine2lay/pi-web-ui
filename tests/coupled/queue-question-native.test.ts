/** Opt-in real queue tool -> host coordinator -> SDK command -> native endpoint -> disk replay. */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNBOUND_OWNER_ACCEPTANCE } from "../../server/queue-question-acceptance.js";
import { latch, nativeOwnerDialog, queueRecords } from "../fixtures/question-commit-host.js";
import { nativeQueueWorld, NATIVE_PLAN, NATIVE_TASK_ID } from "./native-queue-world.js";

type World = Awaited<ReturnType<typeof nativeQueueWorld>>;
const worlds: World[] = [];
const releases: Array<() => void> = [];
const dialogs: ReturnType<typeof nativeOwnerDialog>[] = [];
const world = async () => {
	const value = await nativeQueueWorld();
	worlds.push(value);
	return value;
};
const operations = (w: World, op: string) =>
	queueRecords(SessionManager.open(w.worker.file)).filter((row) => row.op === op);
const cards = (file: string) =>
	SessionManager.open(file)
		.getBranch()
		.flatMap((entry) => (entry.type === "custom_message" && entry.customType === "queue-question-card" ? [entry] : []));
const pauseNextDispatch = (w: World) => {
	const entered = latch(),
		release = latch();
	releases.push(release.open);
	w.control.beforeCommit = async () => {
		entered.open();
		await release.promise;
	};
	return { entered, release };
};
/** Observe the real coordinator's entry; every request goes unchanged to the original method. */
const watchCommit = (w: World, kind: "recall" | "owner") => {
	const entered = latch(),
		commit = w.integration.commits.commitQuestion;
	vi.spyOn(w.integration.commits, "commitQuestion").mockImplementation((...args) => {
		const result = commit(...args);
		if (args[2].kind === kind) entered.open();
		return result;
	});
	return entered;
};

beforeEach(() => {
	// Native queue recovery timers must not launch anything during a synthetic command turn.
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-01-05T12:00:00.000Z"));
});
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	for (const dialog of dialogs.splice(0).reverse()) dialog.close();
	try {
		for (const w of worlds.splice(0).reverse()) await w.close();
	} finally {
		vi.restoreAllMocks();
		vi.useRealTimers();
	}
});

describe("coupled production queue and native host", () => {
	it.each(["lead", "parent"] as const)(
		"an actual %s owner dialog prevents production recall before relay and across restart",
		async (place) => {
			const w = await world();
			const original = await w.escalate();
			expect(w.parent.file).not.toBe(w.lead.file);
			const dialog = nativeOwnerDialog(w[place].session, (source) => w.integration.observeUnboundOwnerAnswer(source));
			dialogs.push(dialog);
			const answer = [{ id: "generic-choice", selected: ["Keep the choice"] }];
			expect(dialog.answer(answer)).toBe(true);
			expect(await dialog.result).toEqual(answer);
			await expect(w.recall(original.tag)).rejects.toThrow(/already accepted an unbound dialog/i);
			expect(operations(w, "recall")).toHaveLength(0);
			expect(operations(w, "owner_admission")).toHaveLength(0);
			await w.restart();
			await expect(w.recall(original.tag)).rejects.toThrow(/already accepted an unbound dialog/i);
			expect(w.task(w.worker).ask?.escalation?.rid).toBe(original.binding.escalation);
			expect(w.diskState(w.worker).tasks.find((task) => task.id === NATIVE_TASK_ID)?.status).toBe("stuck");
			expect(operations(w, "recall")).toHaveLength(0);
			expect(w.sends.get(w.worker.file) ?? 0).toBe(0);
			expect(w.model).not.toHaveBeenCalled();
		},
	);

	it.each(["lead", "parent"] as const)(
		"a missing %s acceptance marker preserves the answer without granting recall after restart",
		async (place) => {
			const w = await world();
			const original = await w.escalate();
			vi.spyOn(console, "error").mockImplementation(() => {});
			const source = w[place];
			const dialog = nativeOwnerDialog(source.session, (identity) => w.integration.observeUnboundOwnerAnswer(identity));
			dialogs.push(dialog);
			const append = source.manager.appendCustomEntry;
			Object.defineProperty(source.manager, "appendCustomEntry", {
				configurable: true,
				value: () => {
					throw new Error("synthetic unavailable acceptance writer");
				},
			});
			const answer = [{ id: "generic-choice", selected: ["Keep the choice"] }];
			expect(dialog.answer(answer)).toBe(true);
			expect(await dialog.result).toEqual(answer);
			Object.defineProperty(source.manager, "appendCustomEntry", { value: append, configurable: true });
			await expect(w.recall(original.tag)).rejects.toThrow(/persistence was uncertain/i);
			await w.restart();
			await expect(w.recall(original.tag)).rejects.toThrow(/acceptance coverage/i);
			expect(operations(w, "recall")).toHaveLength(0);
			expect(operations(w, "owner_admission")).toHaveLength(0);
			expect(w.model).not.toHaveBeenCalled();
		},
	);

	it("a separate parent's dialog acceptance during the real dispatch await excludes recall before owner_record relay", async () => {
		const w = await world();
		const original = await w.escalate();
		const { entered, release } = pauseNextDispatch(w);
		const recall = w.recall(original.tag).then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error }),
		);
		await entered.promise;
		const dialog = nativeOwnerDialog(w.parent.session, (source) => w.integration.observeUnboundOwnerAnswer(source));
		dialogs.push(dialog);
		try {
			const answer = [{ id: "generic-choice", selected: ["Keep the choice"] }];
			expect(dialog.answer(answer)).toBe(true);
			expect(await dialog.result).toEqual(answer);
			const accepted = (file: string) =>
				SessionManager.open(file)
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === UNBOUND_OWNER_ACCEPTANCE);
			expect(accepted(w.parent.file)).toHaveLength(1);
			expect(accepted(w.lead.file)).toHaveLength(0);
		} finally {
			release.open();
		}
		const rejected = await recall;
		expect(rejected.ok).toBe(false);
		if (rejected.ok) throw new Error("Parent acceptance during the dispatch await must exclude native recall");
		expect(String(rejected.error)).toMatch(/already accepted an unbound dialog/i);
		expect(operations(w, "recall")).toHaveLength(0);
		expect(operations(w, "owner_admission")).toHaveLength(0);
		expect(operations(w, "resume")).toHaveLength(0);
		await w.restart();
		await expect(w.recall(original.tag)).rejects.toThrow(/already accepted an unbound dialog/i);
		expect(w.task(w.worker).ask?.escalation?.rid).toBe(original.binding.escalation);
		expect(w.sends.get(w.worker.file) ?? 0).toBe(0);
		expect(w.model).not.toHaveBeenCalled();
	});

	it("recall wins a queued owner race, restores the native question, and retries one pending card after runtime restart", async () => {
		const w = await world();
		const original = await w.escalate();
		const sentBefore = w.sends.get(w.lead.file) ?? 0;
		const ownerQueued = watchCommit(w, "owner");
		const { entered, release } = pauseNextDispatch(w);
		// The actual queue_reply tool is executing in this lead turn: a recall card cannot yet append.
		w.lead.busy = true;
		const recall = w.recall(original.tag);
		await entered.promise;
		const owner = w.integration.admitOwnerAnswer(original.binding, "Keep it", "Browser");
		await ownerQueued.promise; // Both calls have reached the real parent-queue lane before release.
		release.open();
		const [recalled, admitted] = await Promise.all([recall, owner]);
		await w.drain();
		expect(recalled).toMatchObject({ recalled: true, again: false, revision: 1 });
		expect(admitted.status).toBe("refused");
		expect(operations(w, "recall")).toHaveLength(1);
		expect(operations(w, "owner_admission")).toHaveLength(0);
		expect(operations(w, "resume")).toHaveLength(0);
		expect(w.task(w.worker)).toMatchObject({ status: "asking", ...original.original, ask: { revision: 1 } });
		expect(w.task(w.parent)).toMatchObject({ status: "asking", plan: NATIVE_PLAN });
		expect(w.freshTag()).not.toBe(original.tag);
		expect(recalled.ask).toBe(w.freshTag());
		expect(w.cardResults.some((result) => result.tag === w.freshTag() && result.status === "pending")).toBe(true);
		expect(cards(w.lead.file)).toHaveLength(0);
		expect(w.commands.some((command) => command.file === w.worker.file && command.action === "question-commit")).toBe(
			true,
		);
		expect(w.commands.some((command) => command.file === w.worker.file && command.action === "question-after")).toBe(
			true,
		);

		await w.restart(); // New SDK managers, extension contexts/endpoints, host coordinator and card lanes.
		await w.settleLead();
		const persisted = w.replay(w.worker).tasks.find((task) => task.id === NATIVE_TASK_ID);
		expect(persisted).toMatchObject({ status: "asking", ...original.original, ask: { revision: 1 } });
		expect(w.diskState(w.worker).tasks.find((task) => task.id === NATIVE_TASK_ID)).toEqual(persisted);
		expect(cards(w.lead.file)).toHaveLength(1);
		expect(cards(w.lead.file)[0].details).toEqual({ tag: w.freshTag() });
		expect(cards(w.lead.file)[0].display).toBe(true);
		expect(w.cardResults.some((result) => result.status === "delivered")).toBe(true);

		const duplicate = await w.recall(original.tag);
		await w.drain();
		await w.settleLead();
		expect(duplicate).toMatchObject({ recalled: true, again: true, rid: recalled.rid, ask: recalled.ask });
		expect(operations(w, "recall")).toHaveLength(1);
		expect(cards(w.lead.file)).toHaveLength(1);
		expect((await w.integration.admitOwnerAnswer(original.binding, "Keep it", "Browser")).status).toBe("refused");
		expect(w.sends.get(w.lead.file) ?? 0).toBe(sentBefore);
		expect(w.sends.get(w.worker.file) ?? 0).toBe(0);
		expect(w.errors).not.toHaveBeenCalled();
		expect(w.model).not.toHaveBeenCalled();
	});

	it("owner acceptance wins against an already-enqueued native recall and excludes recall after reopening without delivery", async () => {
		const w = await world();
		const original = await w.escalate();
		const recallQueued = watchCommit(w, "recall");
		const { entered, release } = pauseNextDispatch(w);
		const owner = w.integration.admitOwnerAnswer(original.binding, "Keep it", "Browser");
		await entered.promise;
		// Catch the tool's expected refusal now; do not leave a rejected promise unobserved during the race.
		const recall = w.recall(original.tag).then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error }),
		);
		await recallQueued.promise;
		release.open();
		const admitted = await owner,
			rejected = await recall;
		await w.drain();
		expect(admitted.status).toBe("committed");
		expect(rejected.ok).toBe(false);
		if (rejected.ok) throw new Error("The native recall tool must refuse the owner's admitted question");
		expect(String(rejected.error)).toMatch(/already accepted/i);
		expect(operations(w, "owner_admission")).toHaveLength(1);
		expect(operations(w, "recall")).toHaveLength(0);
		expect(operations(w, "resume")).toHaveLength(0);
		expect(cards(w.lead.file)).toHaveLength(0);
		expect(w.task(w.worker).ask?.ownerAdmission?.answer).toBe("Keep it");

		// No worker input or answer delivery was invoked: the persisted admission itself must survive.
		await w.restart();
		expect(w.replay(w.worker).tasks.find((task) => task.id === NATIVE_TASK_ID)?.ask?.ownerAdmission?.answer).toBe(
			"Keep it",
		);
		await expect(w.recall(original.tag)).rejects.toThrow(/already accepted/i);
		expect((await w.integration.admitOwnerAnswer(original.binding, "Keep it", "Browser")).status).toBe("already");
		expect(operations(w, "owner_admission")).toHaveLength(1);
		expect(operations(w, "recall")).toHaveLength(0);
		expect(operations(w, "resume")).toHaveLength(0);
		expect(w.task(w.worker)).toMatchObject({ status: "stuck", plan: NATIVE_PLAN });
		expect(w.commands.filter((command) => command.action === "question-after")).toHaveLength(0);
		expect(w.sends.get(w.worker.file) ?? 0).toBe(0);
		expect(w.errors).not.toHaveBeenCalled();
		expect(w.model).not.toHaveBeenCalled();
	});
});
