/**
 * Owner-question COO desk regressions through the real AskHub observer, router and durable store.
 * A card's receipt belongs to its durable hold key, not a process or a reopened chat's ask id.
 * Delivery waits BEFORE composing, as a busy COO chat does. Temporary files and fake time only:
 * no chats, model calls, live settings or manually mirrored router bookkeeping.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AskEvent, AskHub, stuckAsk } from "../../server/asks.js";
import { cardHandleOf } from "../../server/owner-question-card.js";
import {
	CARD_BATCH_MS,
	type CardDelivery,
	CooOwnerQuestionDesk,
	type CooDeskPort,
} from "../../server/owner-question-coo.js";
import {
	HOLD_SAFETY_NET_MS,
	holdKeyOfStuck,
	OWNER_QUESTION_HOLDS_FILE,
	type OwnerQuestionHold,
	OwnerQuestionHolds,
} from "../../server/owner-question-holds.js";
import { OwnerQuestionRouter } from "../../server/owner-question-router.js";
import { collectRoleInput, newTurnRecord, ownerTurnOf, topCause } from "../../server/role-replies.js";
import { carriedTurnOf, planCarryOn, readRunningChatsFile, RunningChats } from "../../server/running-chats.js";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 1, 9, 0);
let dir: string;
const cleanup: Array<() => void> = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "owner-question-coo-restart-"));
	vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
	for (const stop of cleanup.splice(0)) stop();
	vi.useRealTimers();
	rmSync(dir, { recursive: true, force: true });
});

interface DeliveryState {
	on: boolean;
	beforeCompose?: Promise<void>;
	sent: Array<{ sendId: string; text: string }>;
}

/** Unlike the isolated desk fixture, all admission and event bookkeeping here is the real router's. */
function realDesk(holdsFile = join(dir, OWNER_QUESTION_HOLDS_FILE), onDelivery?: (sendId: string) => void) {
	const state: DeliveryState = { on: true, sent: [] };
	const hub = new AskHub(() => Date.now());
	const router = new OwnerQuestionRouter({
		enabled: () => state.on,
		hub,
		holds: () => new OwnerQuestionHolds(holdsFile, { now: () => Date.now() }),
		now: () => Date.now(),
		log: () => {},
	});
	const deliver = vi.fn(
		async (compose: () => string | undefined, sendId: string, _current: () => boolean): Promise<CardDelivery> => {
			if (state.beforeCompose) await state.beforeCompose;
			const text = compose();
			if (text !== undefined) {
				state.sent.push({ sendId, text });
				onDelivery?.(sendId);
			}
			return { ok: true };
		},
	);
	const port: CooDeskPort = {
		routingOn: () => router.enabled,
		hear: (fn) => hub.observe(fn),
		heldAsks: () => hub.heldList(),
		holdKeyOf: (id) => router.holdKeyOf(id),
		holds: () => router.holds(),
		heldUntil: (id) => router.heldUntil(id),
		release: (id, by, note, recommendation) => router.release(id, by, note, recommendation),
		returnToAsker: (id, note) => router.returnToAsker(id, note),
		askerOf: (ask) => ({
			role: { id: "design", title: "Design" },
			chat: "task",
			...(ask.task ? { task: ask.task } : {}),
		}),
		deliver,
		now: () => Date.now(),
		log: () => {},
		tz: "UTC",
	};
	const desk = new CooOwnerQuestionDesk(port);
	desk.start();
	const events: AskEvent[] = [];
	const stopEvents = hub.observe((ev) => events.push(structuredClone(ev)));
	const stop = () => {
		desk.stop();
		router.dispose();
		stopEvents();
	};
	cleanup.push(stop);

	const ask = (id: string, taskId = 12) => {
		const stuck = { key: `design-task-${taskId}`, sig: `port-question-${taskId}` };
		const key = holdKeyOfStuck(stuck.key, stuck.sig);
		const a = stuckAsk(
			id,
			{ taskId, taskTitle: "Choose a port", question: "Which port?", choices: ["8080", "9090"] },
			{ conversationId: `chat-${id}`, conversationTitle: `Task ${taskId}` },
			Date.now(),
		);
		const route = router.routeAsk({ id: a.id, kind: a.kind }, {}, stuck);
		expect(
			hub.add(
				a,
				(answers, from) => {
					hub.settle(a.id, { how: "answered", summary: answers[0]?.selected[0] ?? "", from, answers });
					return { ok: true };
				},
				route,
			),
		).toBe(true);
		return { id, key, handle: cardHandleOf(key), route };
	};
	return { hub, router, desk, state, deliver, events, holdsFile, ask, stop };
}

/** Read the file without opening another store (which would itself count as a restart). */
function storedHold(file: string, key: string): OwnerQuestionHold | undefined {
	const saved = JSON.parse(readFileSync(file, "utf8")) as { holds: OwnerQuestionHold[] };
	return saved.holds.find((hold) => hold.key === key);
}

function deliveryGate() {
	let open!: () => void;
	const wait = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { wait, open };
}

describe("COO delivery receipts through the real router and store", () => {
	it.each([
		{ when: "after the ask reopens", reopenBeforeSettlement: true },
		{ when: "before any ask reopens", reopenBeforeSettlement: false },
	])(
		"a real carried-on turn settles its saved receipt $when, without supplying the old id",
		async ({ reopenBeforeSettlement }) => {
			const runningFile = join(dir, "running-chats.json");
			const ref = { sessionFile: join(dir, "coo.jsonl"), title: "COO", cwd: dir };
			const runningBefore = new RunningChats(runningFile, () => Date.now());
			runningBefore.start(ref);
			const originalTurn = newTurnRecord();
			const before = realDesk(undefined, (sendId) => {
				// The shared accepted-input path used by noteTurnCause, not a replay of card text.
				collectRoleInput(originalTurn, { cause: "other", sendId, requester: { kind: "unknown" } });
				runningBefore.setRequester(ref.sessionFile, originalTurn);
			});
			const original = before.ask("stuck-before-carry-on");
			await vi.advanceTimersByTimeAsync(CARD_BATCH_MS);
			expect(before.state.sent.length).toBe(1);
			expect(originalTurn.ids.length).toBe(1);
			before.hub.settle(original.id, { how: "gone", reason: "the task chat closed at restart" });
			runningBefore.freeze("SIGTERM");
			before.stop();

			vi.setSystemTime(T0 + 5 * MIN);
			const plan = planCarryOn(readRunningChatsFile(runningFile), null, Date.now());
			expect(plan.carry.length).toBe(1);
			const saved = plan.carry[0]!.chat;
			expect(saved.ownerQuestionSendIds).toEqual(originalTurn.ids);
			const runningAfter = new RunningChats(runningFile, () => Date.now());
			runningAfter.seed(plan.carry.map((item) => ({ ...item.chat, awaiting: true })));
			runningAfter.start(ref);
			const restoredTurn = newTurnRecord();
			collectRoleInput(restoredTurn, { cause: "other", carried: carriedTurnOf(saved) });
			runningAfter.setRequester(ref.sessionFile, restoredTurn);
			expect(restoredTurn.ids.length).toBe(1);
			expect(restoredTurn.ids).toEqual(originalTurn.ids);
			expect(topCause(restoredTurn.causes)).toBe("other");
			expect(ownerTurnOf(restoredTurn)).toBeNull();
			expect(restoredTurn.ownerLastWroteAt).toBeUndefined();
			expect(readRunningChatsFile(runningFile)?.chats[0]?.ownerQuestionSendIds).toEqual(restoredTurn.ids);

			const after = realDesk(before.holdsFile);
			const reopened = reopenBeforeSettlement ? after.ask("stuck-after-carry-on") : undefined;
			expect(after.hub.list()).toEqual([]);
			expect(Date.now() - T0).toBeLessThan(HOLD_SAFETY_NET_MS);
			// Only the restored turn's real metadata reaches the desk: no old send id is passed in by the test.
			expect(after.desk.turnSettled(restoredTurn.ids)).toEqual(reopened ? [reopened.id] : []);
			expect(storedHold(after.holdsFile, original.key)).toMatchObject({
				state: "released",
				releasedBy: "safety-net",
				finishedAt: Date.now(),
				deliveredToCoo: { turnEndedAt: Date.now() },
			});
			const visible = reopened ?? after.ask("stuck-after-carry-on");
			expect(visible.key).toBe(original.key);
			expect(after.hub.heldList()).toEqual([]);
			expect(after.hub.list().map((a) => a.id)).toEqual([visible.id]);
			expect(after.desk.turnSettled(restoredTurn.ids)).toEqual([]);
			runningAfter.finish(ref.sessionFile);
			expect(readRunningChatsFile(runningFile)?.chats).toEqual([]);
			await vi.advanceTimersByTimeAsync(CARD_BATCH_MS);
			expect(after.state.sent.length).toBe(0);
		},
	);

	it("settles the reopened ask under the same durable key, without delivering its card twice", async () => {
		const w = realDesk();
		const original = w.ask("stuck-original");
		expect(original.route).toEqual({ to: "coo", reason: "queued-work", heldAt: T0 });
		expect(w.hub.listening).toBe(false); // All bookkeeping, including the desk, uses observe.
		await vi.advanceTimersByTimeAsync(CARD_BATCH_MS);
		expect(w.state.sent.length).toBe(1);
		const { sendId } = w.state.sent[0]!;
		expect(sendId).toMatch(/^oqc-/);
		expect(storedHold(w.holdsFile, original.key)?.deliveredToCoo).toEqual({ at: Date.now(), sendId });

		w.hub.settle(original.id, { how: "gone", reason: "the task chat closed" });
		expect(w.router.holdKeyOf(original.id)).toBeUndefined();
		expect(w.hub.get(original.id)).toBeUndefined();
		expect(w.router.holds()?.get(original.key)?.state).toBe("held");
		const reopened = w.ask("stuck-reopened");
		expect(reopened.key).toBe(original.key);
		expect(w.router.holdKeyOf(reopened.id)).toBe(original.key);
		expect(reopened.route).toEqual(original.route);
		await vi.advanceTimersByTimeAsync(CARD_BATCH_MS);
		expect(w.state.sent.length).toBe(1);

		const endedAt = Date.now();
		expect(endedAt - T0).toBeLessThan(HOLD_SAFETY_NET_MS);
		expect(w.desk.turnSettled([sendId])).toEqual([reopened.id]);
		expect(w.hub.heldList()).toEqual([]);
		expect(w.hub.list().map((a) => a.id)).toEqual([reopened.id]);
		expect(storedHold(w.holdsFile, reopened.key)).toMatchObject({
			state: "released",
			releasedBy: "safety-net",
			finishedAt: endedAt,
			deliveredToCoo: { sendId, turnEndedAt: endedAt },
		});
		expect(w.desk.turnSettled([sendId])).toEqual([]);
		expect(w.events.filter((ev) => ev.type === "released").map((ev) => ev.ask.id)).toEqual([reopened.id]);
	});

	it("after desk/router/store restart, settles the original card but keeps COO's explicit hold until expiry", async () => {
		const before = realDesk();
		const noAction = before.ask("stuck-no-action", 12);
		const held = before.ask("stuck-coo-held", 13);
		await vi.advanceTimersByTimeAsync(CARD_BATCH_MS);
		expect(before.state.sent.length).toBe(1);
		const { sendId } = before.state.sent[0]!;
		const until = T0 + 60 * MIN;
		const why = "Waiting for Design to check the port.";
		expect(before.desk.hold(held.handle, until, why)).toEqual({ ok: true, until });
		before.stop();

		vi.setSystemTime(T0 + 5 * MIN);
		const after = realDesk(before.holdsFile);
		const noActionAgain = after.ask("stuck-no-action-reopened", 12);
		const heldAgain = after.ask("stuck-coo-held-reopened", 13);
		expect(after.router.holds()).not.toBe(before.router.holds());
		expect(noActionAgain.key).toBe(noAction.key);
		expect(heldAgain.key).toBe(held.key);
		expect(after.router.holds()?.get(noAction.key)?.deliveredToCoo?.sendId).toBe(sendId);
		expect(after.router.heldUntil(heldAgain.id)).toBe(until);
		expect(after.desk.list().find((q) => q.handle === held.handle)).toMatchObject({
			holdUntil: until,
			holdWhy: why,
		});
		await vi.advanceTimersByTimeAsync(CARD_BATCH_MS);
		expect(after.state.sent.length).toBe(0);
		expect(after.desk.turnSettled(["ri-unrelated"])).toEqual([]);
		expect(after.hub.list()).toEqual([]);

		const endedAt = Date.now();
		expect(endedAt - T0).toBeLessThan(HOLD_SAFETY_NET_MS);
		expect(after.desk.turnSettled([sendId])).toEqual([noActionAgain.id]);
		expect(after.hub.list().map((a) => a.id)).toEqual([noActionAgain.id]);
		expect(after.hub.heldList().map((a) => a.id)).toEqual([heldAgain.id]);
		expect(storedHold(after.holdsFile, noAction.key)).toMatchObject({
			state: "released",
			releasedBy: "safety-net",
			finishedAt: endedAt,
			deliveredToCoo: { sendId, turnEndedAt: endedAt },
		});
		expect(storedHold(after.holdsFile, held.key)).toMatchObject({
			state: "held",
			holdUntil: until,
			holdWhy: why,
			deliveredToCoo: { sendId, turnEndedAt: endedAt },
		});
		expect(after.desk.turnSettled([sendId])).toEqual([]);
		vi.setSystemTime(until - 1);
		expect(after.router.sweep()).toEqual([]);
		expect(after.hub.heldList().map((a) => a.id)).toEqual([heldAgain.id]);
		vi.setSystemTime(until);
		expect(after.router.sweep()).toEqual([heldAgain.id]);
		expect(after.hub.heldList()).toEqual([]);
		expect(storedHold(after.holdsFile, held.key)).toMatchObject({
			state: "released",
			releasedBy: "safety-net",
			finishedAt: until,
		});
		expect(after.events.filter((ev) => ev.type === "released").map((ev) => ev.ask.id)).toEqual([
			noActionAgain.id,
			heldAgain.id,
		]);
		expect(before.state.sent.length + after.state.sent.length).toBe(1);
	});

	it.each([
		{ when: "in the original process", restartBeforeSettlement: false },
		{ when: "after restart before any ask reopens the store", restartBeforeSettlement: true },
	])(
		"persists a closed ask's release $when, so readmission shows it immediately",
		async ({ restartBeforeSettlement }) => {
			const before = realDesk();
			const original = before.ask("stuck-closed");
			await vi.advanceTimersByTimeAsync(CARD_BATCH_MS);
			expect(before.state.sent.length).toBe(1);
			const { sendId } = before.state.sent[0]!;
			before.hub.settle(original.id, { how: "gone", reason: "the task chat closed" });
			let receiving = before;
			if (restartBeforeSettlement) {
				before.stop();
				receiving = realDesk(before.holdsFile);
			}
			vi.setSystemTime(T0 + 5 * MIN);
			expect(receiving.hub.heldList()).toEqual([]);
			expect(receiving.desk.turnSettled([sendId])).toEqual([]); // No live ask id to return.
			expect(storedHold(receiving.holdsFile, original.key)).toMatchObject({
				state: "released",
				releasedBy: "safety-net",
				finishedAt: Date.now(),
				deliveredToCoo: { sendId, turnEndedAt: Date.now() },
			});
			receiving.stop();

			const after = realDesk(before.holdsFile);
			const reopened = after.ask("stuck-back-after-settlement");
			expect(reopened.key).toBe(original.key);
			expect(reopened.route).toMatchObject({ to: "coo", heldAt: T0, releasedBy: "safety-net" });
			expect(after.hub.heldList()).toEqual([]);
			expect(after.hub.list().map((a) => a.id)).toEqual([reopened.id]);
			expect(after.events.map((ev) => ev.type)).toEqual(["appeared"]);
			await vi.advanceTimersByTimeAsync(CARD_BATCH_MS);
			expect(after.state.sent.length).toBe(0);
		},
	);
});

describe("COO cards composed only when delivery can proceed", () => {
	it.each(["answered", "removed", "routing off", "new held ask"] as const)(
		"a composed card becomes stale before preflight when %s",
		async (change) => {
			const w = realDesk();
			const held = w.ask("stuck-before-preflight");
			const observations: Array<{
				composed: boolean;
				before: boolean[];
				after: boolean[];
				beforeReadOnly: boolean;
				afterReadOnly: boolean;
			}> = [];
			w.deliver.mockImplementation(async (compose, _sendId, current): Promise<CardDelivery> => {
				const composed = compose() !== undefined; // Only check presence, never inspect the card body.
				const beforeFile = readFileSync(w.holdsFile, "utf8");
				const before = [current(), current()];
				const beforeReadOnly = readFileSync(w.holdsFile, "utf8") === beforeFile;
				if (change === "answered") {
					await w.hub.answer(held.id, [{ id: "answer", selected: ["8080"] }], "browser");
				} else if (change === "removed") {
					w.hub.settle(held.id, { how: "gone", reason: "closed before SDK preflight" });
				} else if (change === "routing off") {
					w.state.on = false;
				} else {
					w.ask("stuck-arrived-before-preflight", 13);
				}
				const afterFile = readFileSync(w.holdsFile, "utf8");
				const after = [current(), current()];
				const afterReadOnly = readFileSync(w.holdsFile, "utf8") === afterFile;
				observations.push({ composed, before, after, beforeReadOnly, afterReadOnly });
				return { ok: false, error: "card changed before SDK preflight" };
			});
			await vi.advanceTimersByTimeAsync(CARD_BATCH_MS);
			// Assert outside delivery: flush catches callback failures and must not hide a failing test.
			expect(observations).toEqual([
				{
					composed: true,
					before: [true, true],
					after: [false, false],
					beforeReadOnly: true,
					afterReadOnly: true,
				},
			]);
			expect(w.deliver).toHaveBeenCalledTimes(1);
			expect(w.state.sent.length).toBe(0);
			expect(storedHold(w.holdsFile, held.key)?.deliveredToCoo).toBeUndefined();
		},
	);

	it("omits asks answered or gone behind the delivery gate and batches newly held asks", async () => {
		const w = realDesk();
		const gate = deliveryGate();
		w.state.beforeCompose = gate.wait;
		const answered = w.ask("stuck-answered", 12);
		const gone = w.ask("stuck-gone", 13);
		const waiting = w.ask("stuck-waiting", 14);
		await vi.advanceTimersByTimeAsync(CARD_BATCH_MS);
		expect(w.deliver).toHaveBeenCalledTimes(1);
		expect(w.state.sent.length).toBe(0);
		expect(w.router.holds()?.get(waiting.key)?.deliveredToCoo).toBeUndefined();
		expect(await w.hub.answer(answered.id, [{ id: "answer", selected: ["8080"] }], "browser")).toEqual({ ok: true });
		w.hub.settle(gone.id, { how: "gone", reason: "the task chat closed before delivery" });
		const newlyHeld = w.ask("stuck-newly-held", 15);
		gate.open();
		await vi.advanceTimersByTimeAsync(0);

		expect(w.state.sent.length).toBe(1);
		const card = w.state.sent[0]!;
		// Compare membership without putting the card's model-input text into a failed assertion's output.
		expect(card.text.startsWith("[Owner question] 2 questions,")).toBe(true);
		for (const present of [waiting, newlyHeld]) {
			expect(card.text.includes(present.handle)).toBe(true);
			expect(storedHold(w.holdsFile, present.key)?.deliveredToCoo?.sendId).toBe(card.sendId);
		}
		for (const absent of [answered, gone]) {
			expect(card.text.includes(absent.handle)).toBe(false);
			expect(storedHold(w.holdsFile, absent.key)?.deliveredToCoo).toBeUndefined();
		}
		expect(storedHold(w.holdsFile, answered.key)?.state).toBe("gone");
		expect(storedHold(w.holdsFile, gone.key)?.state).toBe("held");
		await vi.advanceTimersByTimeAsync(3 * CARD_BATCH_MS);
		expect(w.state.sent.length).toBe(1);
		expect(w.desk.turnSettled([card.sendId])).toEqual([waiting.id, newlyHeld.id]);
		expect(w.events.filter((ev) => ev.type === "released").map((ev) => ev.ask.id)).toEqual([waiting.id, newlyHeld.id]);
	});

	it("switching off behind the delivery gate prevents both the card and its receipt", async () => {
		const w = realDesk();
		const gate = deliveryGate();
		w.state.beforeCompose = gate.wait;
		const held = w.ask("stuck-switched-off");
		await vi.advanceTimersByTimeAsync(CARD_BATCH_MS);
		expect(w.deliver).toHaveBeenCalledTimes(1);
		w.state.on = false;
		gate.open();
		await vi.advanceTimersByTimeAsync(0);
		expect(w.state.sent.length).toBe(0);
		expect(storedHold(w.holdsFile, held.key)?.deliveredToCoo).toBeUndefined();
		expect(w.router.sweep()).toEqual([held.id]);
		expect(w.hub.list().map((a) => a.id)).toEqual([held.id]);
		await vi.advanceTimersByTimeAsync(3 * CARD_BATCH_MS);
		expect(w.state.sent.length).toBe(0);
		expect(w.deliver).toHaveBeenCalledTimes(1);
	});

	it("with routing off, shows the ask normally without opening the store or attempting delivery", async () => {
		const w = realDesk();
		w.state.on = false;
		const direct = w.ask("stuck-routing-off");
		expect(direct.route).toBeUndefined();
		expect(w.hub.list().map((a) => a.id)).toEqual([direct.id]);
		expect(w.hub.heldList()).toEqual([]);
		await vi.advanceTimersByTimeAsync(CARD_BATCH_MS);
		await w.desk.flush();
		expect(w.deliver).not.toHaveBeenCalled();
		expect(w.state.sent.length).toBe(0);
		expect(w.router.holds()).toBeUndefined();
		expect(existsSync(w.holdsFile)).toBe(false);
	});
});
