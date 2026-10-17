/**
 * queue-lead-reminders (AGENTS.md rule 24): server/queue-blocks.ts reminding the lead a blocked task waits
 * on (the round, remindLead, leadChat, the panel's next reminder), the queue host's checks of what pi-queue
 * hands in, and the mirror of pi-queue's "block" / "remind" / "lead" ops. Queues are made from ops (as
 * pi-queue saves them), the clock is fake; the chats themselves are covered by
 * tests/queue-lead-reminders-test.mjs (sealed E2E).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installQueueHost, parseLeadRemind, QUEUE_HOST_KEY, type QueueHost } from "../../server/queue-host.js";
import {
	blockVerdict,
	LEAD_DAY_CAP,
	leadCommand,
	leadReminderOf,
	type LeadReminderRecord,
	leadTimesMs,
	leadVerdict,
	localDay,
	QueueBlocks,
	type QueueBlocksHost,
	RENUDGE_MS,
} from "../../server/queue-blocks.js";
import type { UiTaskQueue } from "../../server/protocol.js";
import { taskQueueFromEntries } from "../../server/task-queue.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const plan = (title: string) => ({
	title,
	goal: "g",
	doneWhen: "d",
	decided: "x",
	steps: "s",
	verify: "v",
	mustNot: "m",
});
/** The queue's chat, temper's home chat (a lead), ops's home chat (a lead), task #1's own chat. */
const A = "/s/a.jsonl";
const B = "/s/temper-home.jsonl";
const O = "/s/ops-home.jsonl";
const T = "/s/task-1.jsonl";

// The real schedule (an hour, then two hours apart), whatever the shell running the tests sets.
const saved = { fast: process.env.PI_QUEUE_TEST_FAST, lead: process.env.PI_QUEUE_TEST_LEAD_MS };
beforeAll(() => {
	delete process.env.PI_QUEUE_TEST_FAST;
	delete process.env.PI_QUEUE_TEST_LEAD_MS;
});
afterAll(() => {
	if (saved.fast !== undefined) process.env.PI_QUEUE_TEST_FAST = saved.fast;
	if (saved.lead !== undefined) process.env.PI_QUEUE_TEST_LEAD_MS = saved.lead;
});

class World {
	/** Oct 15, 23:03 machine time: when Systems #15 blocked on Ops's admission. */
	now = new Date(2026, 9, 15, 23, 3).getTime();
	files = new Map<string, Record<string, unknown>[]>();
	versions = new Map<string, number>();
	commands: [string, string][] = [];
	logs: string[] = [];
	roles: { id: string; homeChat?: string }[] = [
		{ id: "temper", homeChat: B },
		{ id: "ops", homeChat: O },
		{ id: "docs" },
	];
	/** The owner's pause on role messages. */
	paused = false;
	/** The ledger file (queue-lead-reminders.jsonl). */
	ledger: LeadReminderRecord[] = [];
	/** runCommand reaches the chat. */
	reach = true;
	ops(file: string, ...ops: Record<string, unknown>[]) {
		const list = this.files.get(file) ?? [];
		for (const op of ops) list.push({ v: 1, ts: this.now, ...op });
		this.files.set(file, list);
		this.versions.set(file, (this.versions.get(file) ?? 0) + 1);
	}
	host(): QueueBlocksHost {
		return {
			now: () => this.now,
			readQueue: async (f) =>
				this.files.has(f) ? this.files.get(f)!.map((data) => ({ type: "custom", customType: "queue", data })) : null,
			stamp: (f) =>
				this.files.has(f) ? { size: this.files.get(f)!.length, mtimeMs: this.versions.get(f)! } : undefined,
			runCommand: async (f, line) => {
				this.commands.push([f, line]);
				return this.reach;
			},
			roles: () => this.roles,
			titledChats: async () => [],
			sameFile: (a, b) => a === b,
			rolePaused: () => this.paused,
			loadReminders: () => structuredClone(this.ledger),
			saveReminder: (r) => {
				this.ledger.push(structuredClone(r));
			},
			loadWatch: () => [],
			saveWatch: () => {},
			loadHeldSeen: () => ({}),
			saveHeldSeen: () => {},
			changed: () => {},
			log: (l) => this.logs.push(l),
		};
	}
	/** Commands that went to a chat. */
	to(file: string): string[] {
		return this.commands.filter(([f]) => f === file).map(([, l]) => l);
	}
}

/** Queue A: #1 at work in its own chat, #2 waiting; the queue runs. */
function world() {
	const w = new World();
	w.ops(
		A,
		{ op: "add", id: 1, plan: plan("Systems #15") },
		{ op: "add", id: 2, plan: plan("Other") },
		{ op: "run" },
		{ op: "start", id: 1, lane: true },
		{ op: "chat", id: 1, file: T, title: "Queue #1" },
	);
	return { w, blocks: new QueueBlocks(w.host()) };
}

/** pi-queue's "block" op for task #1 owed by `lead`. */
const leadBlock = (w: World, lead = "ops", extra: Record<string, unknown> = {}) => ({
	op: "block",
	id: 1,
	need: "Ops's admission for the diagnosis",
	lead,
	owes: "admission for the fresh diagnosis",
	start: w.now,
	tries: 0,
	...extra,
});

const panelOf = (w: World, file = A): UiTaskQueue =>
	taskQueueFromEntries(
		w.files.get(file)!.map((data) => ({ type: "custom", customType: "queue", data })),
		true,
	);

/** What pi-queue in the queue's chat does when nudged: a lead reminder that's due goes through remindLead
 *  and is recorded once it went (or can't go at all); an ask that's due becomes its ask poke. */
async function queueChatLooks(w: World, blocks: QueueBlocks, file = A) {
	for (const t of panelOf(w, file).tasks) {
		const b = t.block;
		if (t.status !== "blocked" || !b?.lead || b.poke) continue;
		const v = leadVerdict(b);
		if (v.kind !== "due" || v.at > w.now) continue;
		if (v.why === "ask") {
			w.ops(file, {
				op: "poke",
				id: t.id,
				since: b.since,
				note: "ask",
				ask: true,
				...(v.owner ? { owner: true } : {}),
			});
			continue;
		}
		if (v.why !== "remind") continue;
		const r = await blocks.remindLead({ lead: v.lead, queue: file, id: t.id, since: b.since, n: v.n });
		if ("held" in r) continue;
		w.ops(file, {
			op: "remind",
			id: t.id,
			since: b.since,
			n: v.n,
			to: v.lead,
			...("missed" in r ? { missed: r.missed } : {}),
		});
	}
}

/** Ticks once a minute for `minutes`; the queue's chat looks whenever it's nudged. */
async function run(w: World, blocks: QueueBlocks, minutes: number) {
	for (let i = 0; i < minutes; i++) {
		w.now += MIN;
		const before = w.to(A).length;
		await blocks.tick();
		if (w.to(A).length > before) await queueChatLooks(w, blocks);
	}
}

const sinceOf = (w: World, id = 1) => panelOf(w).tasks.find((t) => t.id === id)!.block!.since;

describe("leadVerdict (pi-queue's, mirrored)", () => {
	const b = { since: 100, start: 100, tries: 0, lead: "ops" };
	it("reminds at the checkpoint (an hour after the block started), again two hours later, then asks", () => {
		expect(blockVerdict({ ...b, need: "x" }, () => undefined)).toEqual({
			kind: "due",
			at: 100 + HOUR,
			why: "remind",
			n: 1,
			lead: "ops",
		});
		expect(blockVerdict({ ...b, reminders: [100 + HOUR] }, () => undefined)).toEqual({
			kind: "due",
			at: 100 + 3 * HOUR,
			why: "remind",
			n: 2,
			lead: "ops",
		});
		expect(blockVerdict({ ...b, reminders: [100 + HOUR, 100 + 3 * HOUR] }, () => undefined)).toEqual({
			kind: "due",
			at: 100 + 5 * HOUR,
			why: "ask",
		});
	});
	it("takes the checkpoint the task gave or the lead moved, and counts a new round from the lead's answer", () => {
		expect(leadVerdict({ ...b, checkpoint: 100 + 30 * MIN })).toMatchObject({ at: 100 + 30 * MIN, n: 1 });
		expect(leadVerdict({ ...b, checkpoint: 100 + 9 * HOUR, reminders: [100 + HOUR] })).toMatchObject({
			at: 100 + 9 * HOUR,
			n: 2,
		});
		expect(leadVerdict({ ...b, answeredAt: 5000 })).toMatchObject({ at: 5000 + HOUR, n: 1 });
		// Blocked again later than it was due: due at once, not before.
		expect(leadVerdict({ ...b, since: 100 + 2 * HOUR })).toMatchObject({ at: 100 + 2 * HOUR, n: 1 });
	});
	it("never pokes the task about its need; tasks it waits on still end the block at once", () => {
		for (const tries of [0, 1, 2, 3, 7])
			expect(blockVerdict({ ...b, need: "x", tries }, () => undefined)).toMatchObject({ why: "remind", n: 1 });
		const on = [{ file: "/x.jsonl", id: 3 }];
		expect(blockVerdict({ ...b, on }, () => ({ status: "done" as never }))).toEqual({
			kind: "due",
			at: 100,
			why: "over",
		});
		expect(blockVerdict({ ...b, on }, () => ({ status: "stuck" as never }))).toMatchObject({ why: "remind", n: 1 });
	});
	it("leaves blocks without a lead as they were", () => {
		const plain = { since: 100, start: 100, tries: 0 };
		expect(blockVerdict({ ...plain, need: "x" }, () => undefined)).toEqual({
			kind: "due",
			at: 100 + 10 * MIN,
			why: "need",
		});
		expect(blockVerdict({ ...plain, need: "x", tries: 3 }, () => undefined)).toEqual({
			kind: "due",
			at: 100,
			why: "ask",
		});
		expect(blockVerdict({ ...plain, on: [{ file: "/x.jsonl", id: 3 }] }, () => ({ status: "stuck" as never }))).toEqual(
			{
				kind: "wait",
				needsYou: 1,
			},
		);
	});
	it("takes the test schedule only in test mode", () => {
		const real = { checkpointMs: HOUR, gapMs: 2 * HOUR };
		expect(leadTimesMs({})).toEqual(real);
		expect(leadTimesMs({ PI_QUEUE_TEST_LEAD_MS: "1000,2000" })).toEqual(real);
		expect(leadTimesMs({ PI_QUEUE_TEST_FAST: "1", PI_QUEUE_TEST_LEAD_MS: "1000,2000" })).toEqual({
			checkpointMs: 1000,
			gapMs: 2000,
		});
		expect(leadTimesMs({ PI_QUEUE_TEST_FAST: "1", PI_QUEUE_TEST_LEAD_MS: "x,2" })).toEqual(real);
	});
});

describe("QueueBlocks: reminding the lead", () => {
	it("Systems #15's night: Ops is reminded at 00:03 and 02:03, the task asks at 04:03; nothing else goes anywhere", async () => {
		const { w, blocks } = world();
		w.ops(A, leadBlock(w));
		const since = sinceOf(w);
		blocks.watchQueue(A);
		// Oct 15 23:03 -> Oct 16 09:14, when Ops answered.
		await run(w, blocks, 10 * 60 + 11);
		const lead = (n: number) => leadCommand(1, since, n, A);
		expect(w.to(O)).toEqual([lead(1), lead(2)]);
		expect(w.to(A)).toEqual(["/queue blocks", "/queue blocks", "/queue blocks"]);
		expect(w.to(T)).toEqual([]);
		expect(w.to(B)).toEqual([]);
		const at = (h: number, m: number) => new Date(2026, 9, 16, h, m).getTime();
		expect(w.ledger.map((r) => [r.n, r.at, r.lead, r.to])).toEqual([
			[1, at(0, 3), "ops", O],
			[2, at(2, 3), "ops", O],
		]);
		const b = panelOf(w).tasks[0].block!;
		expect(b.reminders).toEqual([at(0, 3), at(2, 3)]);
		expect(b.poke).toMatchObject({ at: at(4, 3), ask: true });
		expect(
			w.logs.filter((l) => l.includes("nudged")).map((l) => l.replace(/.*\(#1@\d+:/, "").replace(")", "")),
		).toEqual(["remind1", "remind2", "ask"]);
	});

	it("rewording the need on a block it carried over keeps the clock (the reminders it had)", async () => {
		const { w, blocks } = world();
		w.ops(A, leadBlock(w));
		blocks.watchQueue(A);
		await run(w, blocks, 61);
		expect(w.to(O)).toHaveLength(1);
		const r1 = w.ledger[0].at;
		// It went back to work and blocked again on the same lead with other words: pi-queue carries the round over.
		w.ops(
			A,
			{ op: "resume", id: 1 },
			leadBlock(w, "ops", { need: "still Ops's go", reminders: [r1], start: w.now - 61 * MIN }),
		);
		await run(w, blocks, 30);
		expect(w.to(O)).toHaveLength(1);
		await run(w, blocks, 2 * 60);
		expect(w.to(O)).toHaveLength(2);
		expect(w.ledger[1].at).toBe(r1 + 2 * HOUR);
	});

	it("an answer before the checkpoint: no reminder at all", async () => {
		const { w, blocks } = world();
		w.ops(A, leadBlock(w));
		const since = sinceOf(w);
		blocks.watchQueue(A);
		await run(w, blocks, 20);
		w.ops(A, { op: "lead", id: 1, since, by: "ops", rid: "r0123456789ab", answer: "Admitted: go ahead" });
		expect(panelOf(w).tasks[0].block!.poke).toMatchObject({ lead: "ops" });
		await run(w, blocks, 6 * 60);
		expect(w.to(O)).toEqual([]);
		expect(await blocks.remindLead({ lead: "ops", queue: A, id: 1, since, n: 1 })).toEqual({
			held: "the task doesn't wait on that lead any more",
		});
	});

	it("a checkpoint the lead moved: nothing until then, and it doesn't wake the task", async () => {
		const { w, blocks } = world();
		w.ops(A, leadBlock(w));
		const since = sinceOf(w);
		blocks.watchQueue(A);
		await run(w, blocks, 30);
		w.ops(A, { op: "lead", id: 1, since, by: "ops", rid: "r0123456789ab", checkpoint: since + 4 * HOUR });
		const b = panelOf(w).tasks[0].block!;
		expect(b.poke).toBeUndefined();
		expect(b.checkpoint).toBe(since + 4 * HOUR);
		await run(w, blocks, 3 * 60 + 29);
		expect(w.to(O)).toEqual([]);
		expect(w.to(A)).toEqual([]);
		await run(w, blocks, 1);
		expect(w.to(O)).toEqual([leadCommand(1, since, 1, A)]);
	});

	it("a reply from another role doesn't count", () => {
		const { w } = world();
		w.ops(A, leadBlock(w));
		const since = sinceOf(w);
		w.ops(A, { op: "lead", id: 1, since, by: "temper", rid: "r0123456789ab", answer: "go" });
		w.ops(A, { op: "lead", id: 1, since, by: "temper", rid: "r0123456789ac", checkpoint: since + 9 * HOUR });
		const b = panelOf(w).tasks[0].block!;
		expect(b.poke).toBeUndefined();
		expect(b.checkpoint).toBeUndefined();
	});

	it("blocked on another task with a lead: done ends it at once; open, the lead is reminded at the checkpoint", async () => {
		const { w, blocks } = world();
		w.ops(B, { op: "add", id: 7, plan: plan("Temper's part") }, { op: "start", id: 7, lane: true });
		w.ops(A, leadBlock(w, "temper", { need: undefined, on: [{ file: B, name: "temper", id: 7 }] }));
		const since = sinceOf(w);
		blocks.watchQueue(A);
		await run(w, blocks, 60);
		expect(w.to(B)).toEqual([leadCommand(1, since, 1, A)]);
		w.ops(B, { op: "done", id: 7, summary: "Landed" });
		await blocks.tick();
		expect(w.logs.at(-1)).toContain(":over)");
	});

	it("sends each reminder once: twice at the same time, or asked again later, or after a restart", async () => {
		const { w, blocks } = world();
		w.ops(A, leadBlock(w));
		const since = sinceOf(w);
		w.now += HOUR;
		const req = { lead: "ops", queue: A, id: 1, since, n: 1 };
		const [a, b] = await Promise.all([blocks.remindLead(req), blocks.remindLead(req)]);
		expect([a, b]).toContainEqual({ held: "it is on its way" });
		expect([a, b]).toContainEqual({ sent: true, at: w.now, to: O });
		w.now += 5 * MIN;
		expect(await blocks.remindLead(req)).toEqual({ sent: true, at: w.now - 5 * MIN, to: O });
		const again = new QueueBlocks(w.host());
		expect(await again.remindLead(req)).toEqual({ sent: true, at: w.now - 5 * MIN, to: O });
		expect(w.to(O)).toHaveLength(1);
		expect(w.ledger).toHaveLength(1);
	});

	it("holds it while the owner paused the task, the queue or role messages, or the queue is stopped", async () => {
		// The owner's pause on the task or its queue stops its clock (queue-paused): the hour counts from the
		// release. A stopped queue or paused role messages only hold the reminder: it goes once they're lifted.
		const cases: [string, (w: World) => void, (w: World) => void, string, number][] = [
			[
				"task",
				(w) => w.ops(A, { op: "hold", id: 1, why: "owner: pause it", by: "panel" }),
				(w) => w.ops(A, { op: "release", id: 1 }),
				"the owner paused the task or its queue",
				60,
			],
			[
				"queue",
				(w) => w.ops(A, { op: "hold", why: "owner: pause it", by: "panel" }),
				(w) => w.ops(A, { op: "release" }),
				"the owner paused the task or its queue",
				60,
			],
			[
				"stopped",
				(w) => w.ops(A, { op: "pause", reason: "user" }),
				(w) => w.ops(A, { op: "run" }),
				"the queue is stopped",
				1,
			],
			[
				"role messages",
				(w) => {
					w.paused = true;
				},
				(w) => {
					w.paused = false;
				},
				"the owner paused role messages",
				1,
			],
		];
		for (const [name, hold, release, why, after] of cases) {
			const { w, blocks } = world();
			w.ops(A, leadBlock(w));
			const since = sinceOf(w);
			blocks.watchQueue(A);
			hold(w);
			await run(w, blocks, 3 * 60);
			expect(w.to(A), name).toEqual([]);
			expect(await blocks.remindLead({ lead: "ops", queue: A, id: 1, since, n: 1 }), name).toEqual({ held: why });
			expect(w.to(O), name).toEqual([]);
			release(w);
			await run(w, blocks, after - 1);
			expect(w.to(O), name).toEqual([]);
			await run(w, blocks, 1);
			expect(w.to(O), name).toEqual([leadCommand(1, since, 1, A)]);
		}
	});

	it("at most ten a day to one lead; the rest wait for the next day", async () => {
		const { w, blocks } = world();
		// Ten reminders to Ops earlier today (Oct 16), about other tasks.
		w.now = new Date(2026, 9, 16, 8, 0).getTime();
		for (let i = 0; i < LEAD_DAY_CAP; i++)
			w.ledger.push({ at: w.now - i * MIN, lead: "ops", to: O, queue: "/s/other.jsonl", id: i + 1, since: 1, n: 1 });
		// One to Temper doesn't count for Ops.
		w.ledger.push({ at: w.now, lead: "temper", to: B, queue: "/s/other.jsonl", id: 99, since: 1, n: 1 });
		w.ops(A, leadBlock(w));
		const since = sinceOf(w);
		blocks.watchQueue(A);
		await run(w, blocks, 3 * 60);
		expect(w.to(A)).toEqual([]);
		expect(await blocks.remindLead({ lead: "ops", queue: A, id: 1, since, n: 1 })).toEqual({
			held: `ops had its ${LEAD_DAY_CAP} reminders today`,
		});
		// Next day, just after midnight.
		w.now = new Date(2026, 9, 17, 0, 0).getTime();
		await run(w, blocks, 1);
		expect(w.to(O)).toEqual([leadCommand(1, since, 1, A)]);
		expect(localDay(w.ledger.at(-1)!.at)).toBe("2026-10-17");
	});

	it("a lead it can't reach: missed (recorded, so the round still gets to the ask), never retried in a loop", async () => {
		for (const [lead, why] of [
			["nobody", "there's no role nobody"],
			["docs", "docs has no home chat"],
		] as const) {
			const { w, blocks } = world();
			w.ops(A, leadBlock(w, lead));
			blocks.watchQueue(A);
			await run(w, blocks, 61);
			expect(panelOf(w).tasks[0].block!.reminders, lead).toHaveLength(1);
			expect(w.files.get(A)!.at(-1), lead).toMatchObject({ op: "remind", n: 1, missed: why });
			await run(w, blocks, 4 * 60);
			expect(panelOf(w).tasks[0].block!.poke, lead).toMatchObject({ ask: true });
			expect(w.to(A), lead).toHaveLength(3);
		}
		const { w, blocks } = world();
		w.reach = false;
		w.ops(A, leadBlock(w));
		blocks.watchQueue(A);
		await run(w, blocks, 61);
		expect(w.files.get(A)!.at(-1)).toMatchObject({ op: "remind", n: 1, missed: "ops's home chat couldn't be reached" });
		expect(w.ledger).toEqual([]);
		expect(w.logs.some((l) => l.includes("couldn't reach ops's home chat"))).toBe(true);
	});

	it("isn't due yet, or the block changed: held, nothing sent", async () => {
		const { w, blocks } = world();
		w.ops(A, leadBlock(w));
		const since = sinceOf(w);
		expect(await blocks.remindLead({ lead: "ops", queue: A, id: 1, since, n: 1 })).toEqual({ held: "it isn't due" });
		w.now += HOUR;
		expect(await blocks.remindLead({ lead: "ops", queue: A, id: 1, since, n: 2 })).toEqual({ held: "it isn't due" });
		expect(await blocks.remindLead({ lead: "temper", queue: A, id: 1, since, n: 1 })).toEqual({
			held: "the task doesn't wait on that lead any more",
		});
		expect(await blocks.remindLead({ lead: "ops", queue: A, id: 1, since: since - 1, n: 1 })).toEqual({
			held: "the task doesn't wait on that lead any more",
		});
		expect(await blocks.remindLead({ lead: "ops", queue: "/s/gone.jsonl", id: 1, since, n: 1 })).toEqual({
			held: "its queue can't be read",
		});
		expect(w.commands).toEqual([]);
	});

	it("shows the panel when the lead is reminded next, then when the task asks", async () => {
		const { w, blocks } = world();
		w.ops(A, leadBlock(w));
		const since = sinceOf(w);
		let q = panelOf(w);
		blocks.enrich(A, q);
		expect(q.tasks[0].block).toMatchObject({
			lead: "ops",
			owes: "admission for the fresh diagnosis",
			nextRemindAt: since + HOUR,
			nextRemindN: 1,
		});
		expect(q.tasks[0].block!.nextPokeAt).toBeUndefined();
		w.ops(A, { op: "remind", id: 1, since, n: 1, to: "ops" }, { op: "remind", id: 1, since, n: 2, to: "ops" });
		q = panelOf(w);
		blocks.enrich(A, q);
		expect(q.tasks[0].block!.nextRemindAt).toBeUndefined();
		expect(q.tasks[0].block).toMatchObject({ nextPokeAt: w.now + 2 * HOUR, nextIsAsk: true });
	});
});

describe("queue-escalation: up the chain, then the owner (owner 2026-10-16)", () => {
	const b = { since: 100, start: 100, tries: 0, lead: "ops" };
	const two = [100 + HOUR, 100 + 3 * HOUR];
	it("after the lead's two reminders, one to each lead of the chain two hours apart, then the owner", () => {
		const chain = ["temper", "design"];
		expect(leadVerdict({ ...b, chain, reminders: two })).toEqual({
			kind: "due",
			at: 100 + 5 * HOUR,
			why: "remind",
			n: 3,
			lead: "temper",
		});
		expect(leadVerdict({ ...b, chain, reminders: [...two, 100 + 5 * HOUR] })).toMatchObject({ n: 4, lead: "design" });
		expect(leadVerdict({ ...b, chain, reminders: [...two, 100 + 5 * HOUR, 100 + 7 * HOUR] })).toEqual({
			kind: "due",
			at: 100 + 9 * HOUR,
			why: "ask",
			owner: true,
		});
		// A recorded chain with nobody above: straight to the owner after the lead's two.
		expect(leadVerdict({ ...b, chain: [], reminders: two })).toEqual({
			kind: "due",
			at: 100 + 5 * HOUR,
			why: "ask",
			owner: true,
		});
		// No chain recorded (an older pi-queue): its main chat, as before.
		expect(leadVerdict({ ...b, reminders: two })).toEqual({ kind: "due", at: 100 + 5 * HOUR, why: "ask" });
	});

	it("the copy records the chain once, reminders up to four in order, and answers from a chain lead", () => {
		const { w } = world();
		w.ops(A, leadBlock(w));
		const since = sinceOf(w);
		w.ops(A, { op: "chain", id: 1, since: since + 1, chain: ["temper"] });
		expect(panelOf(w).tasks[0].block!.chain).toBeUndefined();
		w.ops(A, { op: "chain", id: 1, since, chain: ["Temper", "ops", "owner", "temper", "design", "qa"] });
		expect(panelOf(w).tasks[0].block!.chain).toEqual(["temper", "design"]);
		w.ops(A, { op: "chain", id: 1, since, chain: ["qa"] });
		expect(panelOf(w).tasks[0].block!.chain).toEqual(["temper", "design"]);
		for (const n of [1, 2, 3, 4, 5]) w.ops(A, { op: "remind", id: 1, since, n, to: "x" });
		expect(panelOf(w).tasks[0].block!.reminders).toHaveLength(4);
		// Someone outside the chain: not taken. A lead of the chain: it answers for the task.
		w.ops(A, { op: "lead", id: 1, since, by: "qa", answer: "go" });
		expect(panelOf(w).tasks[0].block!.poke).toBeUndefined();
		w.ops(A, { op: "lead", id: 1, since, by: "design", answer: "go" });
		expect(panelOf(w).tasks[0].block!.poke).toMatchObject({ lead: "design" });

		const o = world().w;
		o.ops(A, leadBlock(o));
		o.ops(A, { op: "poke", id: 1, since: sinceOf(o), note: "q", ask: true, owner: true });
		expect(panelOf(o).tasks[0].block!.poke).toMatchObject({ ask: true, owner: true });
		const p = world().w;
		p.ops(A, leadBlock(p));
		p.ops(A, { op: "poke", id: 1, since: sinceOf(p), note: "q", owner: true });
		expect(panelOf(p).tasks[0].block!.poke!.owner).toBeUndefined();
	});

	it("ops twice, then temper (its project's lead), then the owner; nothing to the task", async () => {
		const { w, blocks } = world();
		w.ops(A, leadBlock(w));
		const since = sinceOf(w);
		w.ops(A, { op: "chain", id: 1, since, chain: ["temper"] });
		blocks.watchQueue(A);
		await run(w, blocks, 7 * 60 + 1);
		const lead = (n: number) => leadCommand(1, since, n, A);
		expect(w.to(O)).toEqual([lead(1), lead(2)]);
		expect(w.to(B)).toEqual([lead(3)]);
		expect(w.to(T)).toEqual([]);
		expect(w.ledger.map((r) => [r.n, r.lead, r.to])).toEqual([
			[1, "ops", O],
			[2, "ops", O],
			[3, "temper", B],
		]);
		expect(panelOf(w).tasks[0].block!.poke).toMatchObject({ ask: true, owner: true, at: since + 7 * HOUR });
	});

	it("reminder 3 goes to the chain's lead only; the panel says who is next, then that it asks you", async () => {
		const { w, blocks } = world();
		w.ops(A, leadBlock(w));
		const since = sinceOf(w);
		w.ops(
			A,
			{ op: "chain", id: 1, since, chain: ["temper"] },
			{ op: "remind", id: 1, since, n: 1, to: "ops" },
			{ op: "remind", id: 1, since, n: 2, to: "ops" },
		);
		w.now += 3 * HOUR;
		expect(await blocks.remindLead({ lead: "ops", queue: A, id: 1, since, n: 3 })).toEqual({
			held: "reminder 3 goes to temper, not ops",
		});
		expect(await blocks.remindLead({ lead: "design", queue: A, id: 1, since, n: 3 })).toEqual({
			held: "the task doesn't wait on that lead any more",
		});
		let q = panelOf(w);
		blocks.enrich(A, q);
		expect(q.tasks[0].block).toMatchObject({ nextRemindN: 3, nextRemindLead: "temper" });
		expect(await blocks.remindLead({ lead: "temper", queue: A, id: 1, since, n: 3 })).toMatchObject({
			sent: true,
			to: B,
		});
		w.ops(A, { op: "remind", id: 1, since, n: 3, to: "temper" });
		q = panelOf(w);
		blocks.enrich(A, q);
		expect(q.tasks[0].block!.nextRemindAt).toBeUndefined();
		expect(q.tasks[0].block).toMatchObject({ nextPokeAt: w.now + 2 * HOUR, nextIsAsk: true, nextIsOwner: true });
		expect(w.commands).toEqual([[B, leadCommand(1, since, 3, A)]]);
	});
});

describe("the queue's copy of pi-queue's lead ops", () => {
	it("reads lead, owes and checkpoint off the block; reminders only in order; old blocks unchanged", () => {
		const { w } = world();
		w.ops(A, leadBlock(w, "OPS", { checkpoint: w.now + 30 * MIN }));
		const since = sinceOf(w);
		expect(panelOf(w).tasks[0].block).toMatchObject({ lead: "ops", checkpoint: since + 30 * MIN });
		w.ops(A, { op: "remind", id: 1, since, n: 2, to: "ops" });
		expect(panelOf(w).tasks[0].block!.reminders).toBeUndefined();
		w.ops(A, { op: "remind", id: 1, since, n: 1, to: "ops" }, { op: "remind", id: 1, since, n: 1, to: "ops" });
		expect(panelOf(w).tasks[0].block!.reminders).toEqual([w.now]);
		w.ops(A, { op: "remind", id: 1, since: since + 1, n: 2, to: "ops" });
		expect(panelOf(w).tasks[0].block!.reminders).toHaveLength(1);

		const old = world().w;
		old.ops(A, { op: "block", id: 1, need: "a login", start: old.now, tries: 0, owes: "x", checkpoint: 5 });
		const b = panelOf(old).tasks[0].block!;
		expect(b).toMatchObject({ need: "a login", tries: 0 });
		expect(b.lead).toBeUndefined();
		expect(b.owes).toBeUndefined();
		expect(b.checkpoint).toBeUndefined();
	});
});

describe("the queue host's remindLead and leadChat", () => {
	it("checks what pi-queue hands in", () => {
		const ok = { lead: " Ops ", queue: A, id: 1, since: 5, n: 2 };
		expect(parseLeadRemind(ok)).toEqual({ lead: "ops", queue: A, id: 1, since: 5, n: 2 });
		expect(parseLeadRemind({ ...ok, lead: "ops team" })).toBe("no lead given");
		expect(parseLeadRemind({ ...ok, queue: "rel.jsonl" })).toBe("no queue chat given");
		expect(parseLeadRemind({ ...ok, id: 0 })).toBe("no task number given");
		expect(parseLeadRemind({ ...ok, since: "5" })).toBe("no block given");
		expect(parseLeadRemind({ ...ok, n: 4 })).toEqual({ lead: "ops", queue: A, id: 1, since: 5, n: 4 });
		expect(parseLeadRemind({ ...ok, n: 5 })).toBe("no reminder number given");
		expect(parseLeadRemind({ ...ok, n: 1.5 })).toBe("no reminder number given");
		expect(parseLeadRemind(null)).toBe("no request");
	});

	it("hands pi-queue frozen answers, and a failure as held", async () => {
		const asked: unknown[] = [];
		const down = installQueueHost({
			startChat: async () => ({ sessionFile: T }),
			runCommand: async () => true,
			closeChat: async () => true,
			chatState: async () => ({ state: "idle" }),
			wakeChat: async () => true,
			leadChat: (role) => (role === "ops" ? { id: "ops", file: O } : undefined),
			remindLead: async (req) => {
				asked.push(req);
				if (req.id === 9) throw new Error("disk full");
				return { sent: true, at: 1, to: O };
			},
		});
		try {
			const host = (globalThis as Record<symbol, unknown>)[QUEUE_HOST_KEY] as QueueHost;
			const c = host.leadChat!(" OPS ");
			expect(c).toEqual({ id: "ops", file: O });
			expect(Object.isFrozen(c)).toBe(true);
			expect(host.leadChat!("temper")).toBeUndefined();
			expect(host.leadChat!("a b")).toBeUndefined();
			expect(await host.remindLead!({ lead: "ops", queue: A, id: 1, since: 5, n: 1 })).toEqual({
				sent: true,
				at: 1,
				to: O,
			});
			expect(await host.remindLead!({ lead: "ops", queue: A, id: 9, since: 5, n: 1 })).toEqual({
				held: "couldn't send it (disk full)",
			});
			expect(await host.remindLead!({ lead: "ops", queue: A, id: 1, since: 5, n: 7 })).toEqual({
				missed: "no reminder number given",
			});
			expect(asked).toHaveLength(2);
		} finally {
			down();
		}
	});

	it("reads the ledger's lines back, skipping what isn't one", () => {
		const r = { at: 5, lead: "ops", to: O, queue: A, id: 1, since: 4, n: 1 };
		expect(leadReminderOf(r)).toEqual(r);
		expect(leadReminderOf({ ...r, n: 0 })).toBeUndefined();
		expect(leadReminderOf({ ...r, lead: 3 })).toBeUndefined();
		expect(leadReminderOf("x")).toBeUndefined();
	});

	it("leadChat is the role's home chat from identity.json, or nothing", () => {
		const { blocks } = world();
		expect(blocks.leadChat("ops")).toEqual({ id: "ops", file: O });
		expect(blocks.leadChat(" Temper ")).toEqual({ id: "temper", file: B });
		expect(blocks.leadChat("docs")).toBeUndefined();
		expect(blocks.leadChat("nobody")).toBeUndefined();
	});

	it("a reminder sent before the round recorded it is asked about again, not resent (RENUDGE)", async () => {
		const { w, blocks } = world();
		w.ops(A, leadBlock(w));
		const since = sinceOf(w);
		blocks.watchQueue(A);
		w.now += HOUR;
		await blocks.tick();
		expect(w.to(A)).toEqual(["/queue blocks"]);
		// The queue's chat sends it but never gets to record it (cut off): the next nudge, the same answer.
		expect(await blocks.remindLead({ lead: "ops", queue: A, id: 1, since, n: 1 })).toMatchObject({ sent: true });
		w.now += RENUDGE_MS;
		await blocks.tick();
		expect(w.to(A)).toHaveLength(2);
		expect(await blocks.remindLead({ lead: "ops", queue: A, id: 1, since, n: 1 })).toMatchObject({ sent: true });
		expect(w.to(O)).toHaveLength(1);
	});
});
