/**
 * Ops #676, opt-in local proof: COO's home chat relays the owner's dialog answer to a task in RollCall's queue.
 * Real pi-queue tool -> OwnerRelayCoordinator -> SDK command in RollCall's home -> COO's endpoint -> task's chat.
 * Synthetic chats and records only; no model turn, server or real record.
 */
import { basename, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DecisionRecords, questionRecordFromTranscript, recordId } from "../../server/decision-records.js";
import { latch, queueRecords } from "../fixtures/question-commit-host.js";
import { nativeQueueWorld, NATIVE_PLAN, NATIVE_TASK_ID } from "./native-queue-world.js";

type World = Awaited<ReturnType<typeof nativeQueueWorld>>;
type Chat = World["parent"];
const worlds: World[] = [];
const world = async () => {
	const value = await nativeQueueWorld({ role: "rollcall", homeAt: "parent", others: ["coo"] });
	worlds.push(value);
	return value;
};
const STOP = "You stopped this task's run. Reply here to carry on.";
const id = NATIVE_TASK_ID;
let calls = 0;

/**
 * The owner answers an ask_user_question dialog in `chat`: its tool call and result in that chat's own session, and
 * pi-web-ui's record of it (the live answer shape, through the record writer pi-web-ui itself uses).
 */
function ownerDialog(chat: Chat, question: string, picked: string, opts: { cancelled?: boolean; title?: string } = {}) {
	vi.setSystemTime(Date.now() + 1);
	const call = `toolu_synthetic_${++calls}`;
	const args = { title: opts.title ?? "Your stopped run", questions: [{ id: "q1", question, options: [{ label: picked }, { label: "Not now" }] }] };
	const details = { answers: [{ id: "q1", selected: [picked] }] };
	chat.manager.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: call, name: "ask_user_question", arguments: args }],
		api: "anthropic-messages",
		provider: "synthetic",
		model: "none",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: Date.now(),
	});
	const at = Date.now();
	chat.manager.appendMessage({
		role: "toolResult",
		toolCallId: call,
		toolName: "ask_user_question",
		content: [{ type: "text", text: picked }],
		details,
		isError: opts.cancelled === true,
		timestamp: at,
	});
	const record = questionRecordFromTranscript(args, details, call, at, {
		role: "coo",
		chat: "COO lead",
		file: basename(chat.file),
	});
	expect(record).toBeDefined();
	const records = new DecisionRecords(join(process.env.PI_WEB_DATA_DIR!, "decisions"));
	expect(records.append({ ...record!, title: args.title, answeredIn: "browser" })).toBe(true);
	return recordId("answer", `ask:${call}`);
}

const ops = (chat: Chat, op: string) => queueRecords(SessionManager.open(chat.file)).filter((row) => row.op === op);
const relay = (w: World, record: string, extra: Record<string, unknown> = {}) =>
	w.home("coo").tool("queue_reply", { id, target_role: "rollcall", owner_record: record, ...extra });
const workerSends = (w: World) => w.sends.get(w.worker.file) ?? 0;
/** The owner answers the stop himself, typing in the task's chat (pi's input event; no model turn here). */
const ownerTypes = async (w: World, text: string) => {
	await w.worker.emit("input", { text, source: "interactive" });
	await w.drain();
};

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-01-05T12:00:00.000Z"));
});
afterEach(async () => {
	try {
		for (const w of worlds.splice(0).reverse()) await w.close();
	} finally {
		vi.restoreAllMocks();
		vi.useRealTimers();
	}
});

describe("Ops #676: an owner's answer relayed from one department's home chat to another's task", () => {
	it("delivers his words once to the named task's stop question, names the source, and survives a restart", async () => {
		const w = await world();
		await w.stopRun();
		expect(w.task(w.parent)).toMatchObject({ status: "stuck", question: STOP });
		const before = workerSends(w);
		const record = ownerDialog(w.home("coo"), `You stopped RollCall #${id}'s run. Should it carry on?`, "Carry on, same plan");

		const done = await relay(w, record, { answer: "From COO's review." });
		expect(done).toMatchObject({ role: "rollcall", id, record, status: "relayed" });
		expect(w.task(w.parent).status).toBe("working");
		expect(w.task(w.worker).status).toBe("working");
		expect(workerSends(w)).toBe(before + 1);
		expect(w.model).not.toHaveBeenCalled();
		// RollCall's queue keeps where it came from; the worker's resume names the record; COO's chat holds no task.
		const relays = ops(w.parent, "relay");
		expect(relays).toHaveLength(1);
		expect(relays[0]).toMatchObject({ id, record, note: "From COO's review.", from: { role: "coo", session: w.home("coo").sid, file: w.home("coo").file } });
		expect(ops(w.worker, "resume").at(-1)).toMatchObject({ id, relayed: record });
		expect(w.replay(w.home("coo")).tasks).toEqual([]);
		expect(w.commands.filter((c) => c.action === "owner-relay")).toHaveLength(1);
		expect(w.task(w.worker).plan).toEqual(NATIVE_PLAN);

		// Same arguments again, before and after a restart: nothing more reaches the task.
		expect(await relay(w, record)).toMatchObject({ status: "already" });
		await w.restart();
		expect(await relay(w, record)).toMatchObject({ status: "already" });
		expect(ops(w.worker, "resume").filter((r) => r.relayed === record)).toHaveLength(1);
		expect(ops(w.parent, "relay")).toHaveLength(1);
		expect(w.errors).not.toHaveBeenCalled();
	});

	it("refuses a wrong source, target or record, and an unconsumed or forged ticket, changing nothing", async () => {
		const w = await world();
		await w.stopRun();
		const good = ownerDialog(w.home("coo"), `You stopped RollCall #${id}'s run. Should it carry on?`, "Carry on");
		const refusals: Array<[Promise<unknown>, RegExp]> = [
			// Not a home chat of its department (RollCall's separate lead chat is no home here).
			[w.lead.tool("queue_reply", { id, target_role: "coo", owner_record: good }), /registered home chat/],
			// The target's own home: plain queue_reply is its route.
			[w.parent.tool("queue_reply", { id, target_role: "rollcall", owner_record: good }), /same department/],
			// No such department home; a non-canonical role id; mixed modes.
			[relay(w, good, { target_role: "frontend" }), /no single home chat for role frontend/],
			[relay(w, good, { target_role: "RollCall" }), /give the role id/],
			[relay(w, good, { action: "recall" }), /only relays the owner's recorded answer/],
			// Records that don't bind this dialog to RollCall #1 now.
			[relay(w, ownerDialog(w.home("coo"), `You stopped Frontend #${id}'s run. Should it carry on?`, "Carry on")), /Not relayed/],
			[relay(w, ownerDialog(w.home("coo"), `You stopped RollCall #${id}0's run. Should it carry on?`, "Carry on")), /Not relayed/],
			[relay(w, ownerDialog(w.home("coo"), `You stopped RollCall or Frontend #${id}'s run?`, "Carry on")), /Not relayed/],
			[relay(w, ownerDialog(w.home("coo"), `You stopped RollCall #${id}'s run. Should it carry on?`, "Carry on", { cancelled: true })), /no answered question dialog/],
			[relay(w, "dr-000000000000"), /Not relayed/],
		];
		for (const [call, why] of refusals) await expect(call).rejects.toThrow(why);
		// The dialog answered in RollCall's own home, relayed by COO: the source is wrong.
		const theirs = ownerDialog(w.parent, `You stopped RollCall #${id}'s run. Should it carry on?`, "Carry on");
		await expect(relay(w, theirs)).rejects.toThrow(/another chat/);
		// A made-up ticket straight to RollCall's home does nothing.
		await w.parent.session.prompt("/queue owner-relay forged-ticket");
		await w.drain();
		expect(w.task(w.parent)).toMatchObject({ status: "stuck", question: STOP });
		expect(w.task(w.worker).status).toBe("stuck");
		expect(ops(w.parent, "relay")).toEqual([]);
		expect(ops(w.worker, "resume")).toEqual([]);
		// The good record still works afterwards: refusals spent nothing.
		expect(await relay(w, good)).toMatchObject({ status: "relayed" });
	});

	it("an answer to an older stop doesn't fit a newer one", async () => {
		const w = await world();
		await w.stopRun();
		const old = ownerDialog(w.home("coo"), `You stopped RollCall #${id}'s run. Should it carry on?`, "Carry on");
		await ownerTypes(w, "Carry on");
		expect(w.task(w.worker).status).toBe("working");
		// He answered first: the relay finds no open question and sends nothing.
		await expect(relay(w, old)).rejects.toThrow(/Not relayed/);
		expect(workerSends(w)).toBe(0);
		await w.stopRun();
		expect(w.task(w.parent).status).toBe("stuck");
		await expect(relay(w, old)).rejects.toThrow(/older than task #1's question/);
		expect(w.task(w.worker).status).toBe("stuck");
	});

	it("a target the owner paused keeps the answer and delivers it, checked again, once he lifts the pause", async () => {
		const w = await world();
		await w.stopRun();
		await w.parent.tool("queue_control", { action: "pause", id, why: "Owner in RollCall's home chat: pause #1 for now" });
		await w.drain();
		const record = ownerDialog(w.home("coo"), `You stopped RollCall #${id}'s run. Should it carry on?`, "Carry on");
		expect(await relay(w, record)).toMatchObject({ status: "kept" });
		expect(await relay(w, record)).toMatchObject({ status: "kept" });
		expect(w.task(w.worker).status).toBe("stuck");
		expect(ops(w.worker, "resume")).toEqual([]);
		await w.parent.tool("queue_control", { action: "resume", id, why: "Owner: carry on" });
		await w.drain();
		expect(w.task(w.worker).status).toBe("working");
		expect(ops(w.worker, "resume").filter((r) => r.relayed === record)).toHaveLength(1);
		expect(await relay(w, record)).toMatchObject({ status: "already" });
	});

	it("races: two relays at once, or the owner's own answer in RollCall's home at the same time, deliver once", async () => {
		const w = await world();
		await w.stopRun();
		const record = ownerDialog(w.home("coo"), `You stopped RollCall #${id}'s run. Should it carry on?`, "Carry on");
		const both = await Promise.allSettled([relay(w, record), relay(w, record)]);
		expect(both.filter((r) => r.status === "fulfilled" && (r.value as { status: string }).status === "relayed")).toHaveLength(1);
		expect(ops(w.worker, "resume")).toHaveLength(1);

		const v = await world();
		await v.stopRun();
		const second = ownerDialog(v.home("coo"), `You stopped RollCall #${id}'s run. Should it carry on?`, "Carry on");
		const raced = await Promise.allSettled([relay(v, second), ownerTypes(v, "Carry on, I'm back")]);
		await v.drain();
		expect(raced[1].status).toBe("fulfilled");
		// Whichever came first wins; the other changes nothing, and the relay never claims what didn't happen.
		expect(ops(v.worker, "resume")).toHaveLength(1);
		expect(v.task(v.worker).status).toBe("working");
		const relayed = ops(v.worker, "resume")[0].relayed === second;
		if (relayed) expect(raced[0]).toMatchObject({ status: "fulfilled", value: { status: "relayed" } });
		else expect(raced[0].status === "rejected" || (raced[0].value as { status: string }).status !== "relayed").toBe(true);
		expect(workerSends(v)).toBe(relayed ? 1 : 0);
		// The owner answers after a relay landed: his words are his own, and nothing is relayed again.
		await v.stopRun();
		await ownerTypes(v, "Carry on");
		const late = await relay(v, second).then(
			(value) => (value as { status: string }).status,
			(err: Error) => err.message,
		);
		expect(late).toMatch(relayed ? /^already$/ : /^Not relayed/);
		expect(ops(v.worker, "resume")).toHaveLength(2);
		expect(workerSends(v)).toBe(relayed ? 1 : 0);
	});

	it("an ordinary choice that went to the owner through Rule 21 gets his exact words as that choice only", async () => {
		const w = await world();
		const { binding, original } = await w.escalate();
		const words = "Keep short cache";
		const record = ownerDialog(w.home("coo"), `RollCall #${id}: should the synthetic task keep short cache?`, words, { title: "Synthetic cache choice" });
		expect(await relay(w, record)).toMatchObject({ status: "relayed" });
		await w.drain();
		const task = w.task(w.worker);
		expect(task.status).toBe("working");
		expect(task.plan).toEqual(original.plan);
		const admissions = ops(w.worker, "owner_admission");
		expect(admissions).toHaveLength(1);
		expect(admissions[0]).toMatchObject({ id, n: binding.n, admission: { answer: words } });
		expect(await relay(w, record)).toMatchObject({ status: "already" });
		expect(ops(w.worker, "owner_admission")).toHaveLength(1);
	});

	it("Rule 21 races: a relay behind a delayed commit waits its turn and sends nothing again; a recall racing a relay leaves one outcome", async () => {
		const w = await world();
		await w.escalate();
		const record = ownerDialog(w.home("coo"), `RollCall #${id}: should the synthetic task keep short cache?`, "Keep short cache");
		const entered = latch(),
			release = latch();
		w.control.beforeCommit = async () => {
			entered.open();
			await release.promise;
		};
		const first = relay(w, record);
		await entered.promise;
		// One relay at a time per target home: the second waits behind the first, then finds it done.
		const second = relay(w, record);
		expect(ops(w.worker, "owner_admission")).toHaveLength(0);
		release.open();
		expect(await first).toMatchObject({ status: "relayed" });
		expect(await second).toMatchObject({ status: "already" });
		expect(ops(w.worker, "owner_admission")).toHaveLength(1);

		const v = await world();
		const { tag } = await v.escalate();
		const raced = ownerDialog(v.home("coo"), `RollCall #${id}: should the synthetic task keep short cache?`, "Keep short cache");
		await Promise.allSettled([relay(v, raced), v.recall(tag)]);
		await v.drain();
		const outcomes = ops(v.worker, "owner_admission").length + ops(v.worker, "recall").length;
		expect(outcomes).toBe(1);
	});
});
