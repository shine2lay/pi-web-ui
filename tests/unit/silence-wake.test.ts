/**
 * silence-watch, step 2 (Ops #1059; docs/silence-watch.md): the round inside the stall watch. Reads waits from
 * the one queue mirror and last turns from the one chat reader, sends through the stall watch's route, ledger and
 * caps, and its off switch only logs. Synthetic records and a temporary ledger only; no real chat is read.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	SILENCE_FILE,
	type SilenceHome,
	silenceItemText,
	silenceSettings,
	silenceWaitsOf,
	SilenceWatch,
} from "../../server/silence-wake.js";
import { SILENCE_COO_HINT, SILENCE_HINT, stallHint, stallTopic } from "../../server/stall-hints.js";
import {
	readStallLedger,
	STALL_DAY_CAP,
	type StallLedgerLine,
	StallWake,
	type StallWakeHost,
} from "../../server/stall-wake.js";
import type { StallSettings } from "../../server/stall-watch.js";
import { newReplay } from "../../server/work-page.js";
import type { RegistryComplete, RegistryRead } from "../../server/work-registry-reader.js";

const MIN = 60_000;
const T0 = Date.parse("2026-11-21T05:34:01.000Z");
const plan = { title: "Task", goal: "g", doneWhen: "d", decided: "x", steps: "s", verify: "v", mustNot: "m" };
const line = (op: Record<string, unknown>, ts: number) => ({
	type: "custom",
	customType: "queue",
	data: { v: 1, ts, ...op },
});
const started = (id: number, at = T0 - 30 * MIN) => [
	line({ op: "add", id, plan: { ...plan, title: `Task ${id}` } }, at),
	line({ op: "start", id, lane: true }, at),
];
let homeN = 0;
const home = (role: string, queue: ReturnType<typeof line>[], lastTurnAt?: number): SilenceHome => ({
	role,
	scan: { queue, sessionId: `silence-${role}-${++homeN}`, lastTurnAt },
});
const complete = (at: number): RegistryComplete => ({
	complete: true,
	at,
	replay: newReplay(),
	times: new Map(),
	tasksRead: 1,
	bytes: 1,
	tookMs: 1,
});

describe("the off switch (silence-watch.json)", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-silence-file-"));
	it("missing: wakes on; wakes false: log only; unreadable or wrong: log only, with the problem", () => {
		const file = join(dir, SILENCE_FILE);
		const env = { PI_WEB_SILENCE_FILE: file };
		expect(silenceSettings(env)).toEqual({ wakes: true });
		writeFileSync(file, '{"wakes": false}');
		expect(silenceSettings(env)).toEqual({ wakes: false });
		writeFileSync(file, '{"wakes": true}');
		expect(silenceSettings(env)).toEqual({ wakes: true });
		writeFileSync(file, '{"wakes": "no"}');
		expect(silenceSettings(env)).toMatchObject({ wakes: false, problem: expect.stringContaining("true or false") });
		writeFileSync(file, "{oops");
		expect(silenceSettings(env)).toMatchObject({ wakes: false, problem: expect.any(String) });
	});
});

describe("waits from the queue mirror", () => {
	it("a question, an owed block, a block on a task, a need-only block, a paused question", () => {
		const q = [
			...started(1),
			line({ op: "ask", id: 1, n: 19, question: "Q?" }, T0),
			...started(2),
			line({ op: "block", id: 2, lead: "rollcall", owes: "the go-ahead", checkpoint: T0 + 90 * MIN }, T0),
			...started(3),
			line({ op: "block", id: 3, on: [{ file: "/q/backend.jsonl", id: 1 }] }, T0),
			...started(4),
			line({ op: "block", id: 4, need: "a restart" }, T0),
			...started(5),
			line({ op: "ask", id: 5, n: 1, question: "Q?" }, T0),
			line({ op: "hold", id: 5, why: "owner: pause it", by: "panel" }, T0 + MIN),
		];
		const waits = silenceWaitsOf([home("backend", q)]);
		const brief = waits.map((w) => [w.task.id, w.kind, w.start, w.decidingRole, w.nextNudgeAt, w.owed]);
		expect(brief).toEqual([
			[1, "question", T0, "backend", null, "an answer to its question 19"],
			[2, "block", T0, "rollcall", T0 + 90 * MIN, '"the go-ahead" from rollcall'],
			[3, "block", T0, "backend", Number.POSITIVE_INFINITY, "its block"],
			[4, "block", T0, "backend", Number.POSITIVE_INFINITY, "its block"],
		]);
		// An owed block with no checkpoint: pi-queue's first reminder, an hour after the block began.
		const b = silenceWaitsOf([home("ops", [...started(9), line({ op: "block", id: 9, lead: "coo" }, T0)])]);
		expect(b[0].nextNudgeAt).toBe(T0 + 60 * MIN);
	});
});

describe("the wake text and its hints", () => {
	const f = {
		task: { queue: "backend", id: 218 },
		role: "backend",
		kind: "question",
		start: T0,
		decidingRole: "backend",
	} as const;
	it("lead: the plain-words line; COO: the same facts plus how long the lead has not acted", () => {
		expect(
			silenceItemText({ ...f, waitedMinutes: 60, step: "lead", to: "backend" }, "an answer to its question 19"),
		).toBe(
			"Task backend #218 has waited 60 minutes on an answer to its question 19 and this chat has not had a turn since. Decide it, or say who should.",
		);
		const coo = silenceItemText({ ...f, waitedMinutes: 120, step: "coo", to: "coo" }, "an answer to its question 19");
		expect(coo).toContain("Task backend #218 has waited 120 minutes on an answer to its question 19");
		expect(coo).toContain("its lead has not acted for 120 minutes");
	});
	it("a silence batch gets the silence hints and topic; stalled work keeps its own", () => {
		const item = { kind: "task" as const, id: "backend#218", name: "backend #218", rule: "silent" as const, since: T0 };
		expect(stallHint([{ ...item, step: 1 }])).toBe(SILENCE_HINT);
		expect(stallHint([{ ...item, step: 2 }])).toBe(SILENCE_COO_HINT);
		expect(stallTopic([{ ...item, step: 1 }])).toBe("silent wait");
		expect(stallTopic([{ ...item, kind: "project", step: 1 }])).toBe("stalled work");
	});
});

/** A planted wait in a throwaway ledger: backend #218's question 19, nobody answers, the chat stays silent. */
function rig(opts: { wakes?: boolean; mode?: StallSettings["mode"]; paused?: boolean; lastTurnAt?: number } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-silence-"));
	const ledgerFile = join(dir, "stall-watch.jsonl");
	const sends: { role: string; text: string; steps: number[] }[] = [];
	const logs: string[] = [];
	let homesRead = 0;
	const queue = [...started(218), line({ op: "ask", id: 218, n: 19, question: "Q?" }, T0)];
	const host: StallWakeHost = {
		paused: () => !!opts.paused,
		wakesOn: () => true,
		hasHome: () => true,
		send: (input) => {
			sends.push({ role: input.role, text: input.text, steps: input.items.map((i) => i.step) });
			return { ok: true, id: `rm-${sends.length}` };
		},
		log: (l) => logs.push(l),
	};
	const make = () =>
		new SilenceWatch(new StallWake(host, ledgerFile, () => ({ gapHours: 2 })), {
			homes: async () => {
				homesRead++;
				return [home("backend", queue, opts.lastTurnAt), home("coo", [])];
			},
			stall: () => ({ mode: opts.mode ?? "on" }),
			settings: () => ({ wakes: opts.wakes ?? true }),
			log: (l) => logs.push(l),
		});
	const ledger = (): StallLedgerLine[] => readStallLedger(ledgerFile, T0 + 200 * MIN);
	return { opts, make, sends, logs, ledger, ledgerFile, homesRead: () => homesRead };
}

describe("the round: one lead wake, one COO wake, through the stall ledger", () => {
	it("+59 nothing; +60 the lead; +61..+119 nothing; +120 COO; nothing after; a restart sends nothing again", async () => {
		const r = rig();
		let w = r.make();
		const at = (m: number) => w.round(complete(T0 + m * MIN), T0 + m * MIN);
		expect((await at(59))?.due).toEqual([]);
		expect((await at(60))?.due.map((f) => f.step)).toEqual(["lead"]);
		expect(r.sends).toEqual([{ role: "backend", text: expect.stringContaining("has waited 60 minutes"), steps: [1] }]);
		for (const m of [61, 90, 119]) expect((await at(m))?.due).toEqual([]);
		w = r.make(); // restart: only the ledger is read back
		expect((await at(120))?.due.map((f) => f.step)).toEqual(["coo"]);
		expect(r.sends[1]).toEqual({
			role: "coo",
			text: expect.stringContaining("its lead has not acted for 120 minutes"),
			steps: [2],
		});
		w = r.make();
		for (const m of [121, 180, 24 * 60]) expect((await at(m))?.due).toEqual([]);
		expect(r.sends).toHaveLength(2);
		expect(r.ledger().map((l) => [l.stretch, l.step, l.to, l.state, l.id])).toEqual([
			[`task:backend#218:silent:${T0}`, 1, "backend", "sent", "rm-1"],
			[`task:backend#218:silent:${T0}`, 2, "coo", "sent", "rm-2"],
		]);
		expect(r.logs).toContain("silence: round: 1 waits examined, 1 due");
	});

	it("a turn in the lead's chat since the wait began: no wake", async () => {
		const r = rig({ lastTurnAt: T0 + 30 * MIN });
		expect((await r.make().round(complete(T0 + 60 * MIN), T0 + 60 * MIN))?.due).toEqual([]);
		expect(r.sends).toEqual([]);
	});

	it("off switch (wakes false) or stall mode dry: finds and logs once, wakes nobody, writes no ledger line", async () => {
		for (const o of [{ wakes: false }, { mode: "dry" as const }]) {
			const r = rig(o);
			const w = r.make();
			expect((await w.round(complete(T0 + 60 * MIN), T0 + 60 * MIN))?.due).toHaveLength(1);
			await w.round(complete(T0 + 70 * MIN), T0 + 70 * MIN);
			expect(r.sends).toEqual([]);
			expect(r.ledger()).toEqual([]);
			expect(r.logs.filter((l) => l.startsWith("silence: would wake backend about backend #218 (lead"))).toHaveLength(
				1,
			);
			expect(r.logs.some((l) => l.includes("(log only:"))).toBe(true);
		}
	});

	it("role messages paused: held once in the ledger, sent once they resume", async () => {
		const r = rig({ paused: true });
		const w = r.make();
		await w.round(complete(T0 + 60 * MIN), T0 + 60 * MIN);
		await w.round(complete(T0 + 70 * MIN), T0 + 70 * MIN);
		expect(r.sends).toEqual([]);
		expect(r.ledger().map((l) => l.state)).toEqual(["held"]);
		r.opts.paused = false;
		await w.round(complete(T0 + 80 * MIN), T0 + 80 * MIN);
		expect(r.sends.map((s) => s.steps)).toEqual([[1]]);
		expect(r.ledger().map((l) => l.state)).toEqual(["held", "sent"]);
	});

	it("the stall watch's day cap counts silence wakes too", async () => {
		const r = rig();
		const day = Array.from({ length: STALL_DAY_CAP }, (_, i) => ({
			stretch: `project:p${i}:empty:1`,
			step: 1,
			to: "backend",
			at: T0 + i,
			id: `rm-old-${i}`,
			state: "sent",
		}));
		writeFileSync(r.ledgerFile, `${day.map((l) => JSON.stringify(l)).join("\n")}\n`);
		await r.make().round(complete(T0 + 60 * MIN), T0 + 60 * MIN);
		expect(r.sends).toEqual([]);
		expect(readFileSync(r.ledgerFile, "utf8")).toContain('"state":"capped"');
	});

	it("an incomplete registry read or an unreadable home chat: no finding, no chat read", async () => {
		const r = rig();
		const broken: RegistryRead = { complete: false, at: T0, reason: "unreadable-line", detail: "line 7", tasksRead: 6 };
		expect(await r.make().round(broken, T0 + 60 * MIN)).toBeUndefined();
		expect(r.homesRead()).toBe(0);
		const failing = new SilenceWatch(new StallWake({} as StallWakeHost, r.ledgerFile, () => ({ gapHours: 2 })), {
			homes: () => Promise.reject(new Error("ops: couldn't read its home chat")),
			stall: () => ({ mode: "on" }),
			settings: () => ({ wakes: true }),
			log: (l) => r.logs.push(l),
		});
		expect(await failing.round(complete(T0 + 60 * MIN), T0 + 60 * MIN)).toBeUndefined();
		expect(r.logs).toContain("silence: round skipped: ops: couldn't read its home chat");
		expect(r.sends).toEqual([]);
	});
});
