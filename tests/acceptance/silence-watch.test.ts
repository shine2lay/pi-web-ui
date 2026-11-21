/**
 * Q-STALL-1 silence watch acceptance (Ops #1058 step 1 of 2; docs/silence-watch.md). Red until step 2 (Ops #1059)
 * builds server/silence-watch.ts; then step 2 moves this file into tests/unit and drops its acceptance config.
 * Never weaken or skip a case to make it pass.
 *
 * The real cases come from the 7-day replay of ops #1054 (replay_stalls.out, X = 60, option a1): its five "real"
 * alarms are the wakes this watch must send, its eight "covered" ones (all blocks) the ones it must not. The frozen
 * records (silence-watch/replay-7d.json, built by silence-watch/build-fixture.py) hold ids, roles, times and
 * states only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	findSilentWaits,
	SILENCE_COO_ROLE,
	SILENCE_WAIT_MINUTES,
	silenceRound,
	silenceWakeKey,
	type HomeChatTurns,
	type SilenceOptions,
	type SilentWait,
	type SilentWaitInput,
} from "../../server/silence-watch.js";
import { newReplay } from "../../server/work-page.js";
import type { RegistryComplete, RegistryIncomplete } from "../../server/work-registry-reader.js";

const M = 60_000;
const X = SILENCE_WAIT_MINUTES;

interface FixtureWait {
	role: string;
	id: number;
	state: "asking" | "blocked";
	start: number;
	end: number | null;
	decidingRole: string;
	n: number | null;
	parked: boolean;
	leadBlock: boolean;
	checkpoint: number | null;
	onTasks: number;
}
interface Fixture {
	about: string;
	t0: number;
	t1: number;
	waits: FixtureWait[];
	turns: Record<string, number[]>;
}

const FIXTURE_FILE = join(import.meta.dirname, "silence-watch", "replay-7d.json");
const fx = JSON.parse(readFileSync(FIXTURE_FILE, "utf8")) as Fixture;
const replayTurns: HomeChatTurns = new Map(Object.entries(fx.turns));
const NO_TURNS: HomeChatTurns = new Map();

/** The watch's input for a recorded wait, as step 2's adapter reads it from the queue mirror. A question reads no
 *  pi-queue timer; a block on another task or a need-only block is covered with no end; an owed block is covered
 *  until its rule-16 checkpoint. */
function inputOf(w: FixtureWait): SilentWaitInput {
	const nextNudgeAt =
		w.state === "asking" ? null : w.onTasks > 0 || !w.leadBlock ? Number.POSITIVE_INFINITY : w.checkpoint;
	return {
		task: { queue: w.role, id: w.id },
		role: w.role,
		kind: w.state === "asking" ? "question" : "block",
		start: w.start,
		decidingRole: w.decidingRole,
		nextNudgeAt,
	};
}

const minute = (ms: number) => new Date(ms).toISOString().slice(0, 16);

/** The recorded wait of `role` #`id` whose replay alarm minute (start + X) is `wake` (UTC, "YYYY-MM-DDTHH:MM"). */
function recorded(role: string, id: number, wake: string): FixtureWait {
	const hits = fx.waits.filter((w) => w.role === role && w.id === id && minute(w.start + X * M) === wake);
	expect(hits, `${role} #${id} waking ${wake} in the fixture`).toHaveLength(1);
	return hits[0];
}

const opts = (sent: ReadonlyMap<string, number> = new Map()): SilenceOptions => ({ waitMinutes: X, sent });
const brief = (f: SilentWait) => ({ task: `${f.task.queue}#${f.task.id}`, step: f.step, to: f.to });

/** The five "real" rows of replay_stalls.out (X = 60, a1): role, task, wake minute (UTC), kind, deciding role. */
const REAL = [
	{ case: "S1", role: "product", id: 86, wake: "2026-11-15T13:02", kind: "question", deciding: "product" },
	{ case: "S2", role: "product", id: 91, wake: "2026-11-15T21:17", kind: "question", deciding: "product" },
	{ case: "S3", role: "ops", id: 979, wake: "2026-11-17T08:26", kind: "block", deciding: "rollcall" },
	{ case: "S4", role: "backend", id: 218, wake: "2026-11-20T14:13", kind: "question", deciding: "backend" },
	{ case: "S5", role: "backend", id: 218, wake: "2026-11-21T06:34", kind: "question", deciding: "backend" },
] as const;

/** backend #218 question 19, asked 2026-11-21 05:34:01Z: the wait the round-by-round cases use. */
const q19 = () => inputOf(recorded("backend", 218, "2026-11-21T06:34"));

describe("Q-STALL-1 silence watch (Ops #1058)", () => {
	it("F0: the fixture holds ids, roles, times and states only (no message text)", () => {
		const keys = new Set(fx.waits.flatMap((w) => Object.keys(w)));
		expect([...keys].sort()).toEqual(
			[
				"checkpoint",
				"decidingRole",
				"end",
				"id",
				"leadBlock",
				"n",
				"onTasks",
				"parked",
				"role",
				"start",
				"state",
			].sort(),
		);
		expect(Object.keys(fx).sort()).toEqual(["about", "t0", "t1", "turns", "waits"]);
		for (const times of Object.values(fx.turns)) expect(times.every((t) => Number.isInteger(t))).toBe(true);
	});

	for (const r of REAL)
		it(`${r.case}: ${r.role} #${r.id} (${r.kind}) -> one lead wake to ${r.deciding} at wait + ${X} min (${r.wake}Z)`, () => {
			const w = inputOf(recorded(r.role, r.id, r.wake));
			expect(w.kind).toBe(r.kind);
			const at = w.start + X * M;
			expect(findSilentWaits([w], replayTurns, at - 1, opts())).toEqual([]);
			const found = findSilentWaits([w], replayTurns, at, opts());
			expect(found.map(brief)).toEqual([{ task: `${r.role}#${r.id}`, step: "lead", to: r.deciding }]);
			expect(found[0]).toMatchObject({ role: r.role, decidingRole: r.deciding, waitedMinutes: X, start: w.start });
		});

	describe("S6: a wait another nudge still covers gets no wake; the same wait uncovered does", () => {
		const covered = [
			{ why: "blocked on another task", role: "backend", id: 210, wake: "2026-11-19T22:38" },
			{ why: "before its rule-16 checkpoint", role: "ops", id: 1014, wake: "2026-11-19T04:48" },
			{ why: "need-only block (the queue pokes the task)", role: "frontend", id: 356, wake: "2026-11-20T11:59" },
		];
		for (const c of covered)
			it(`${c.why}: ${c.role} #${c.id} at ${c.wake}Z`, () => {
				const w = inputOf(recorded(c.role, c.id, c.wake));
				const at = w.start + X * M;
				expect(w.nextNudgeAt === null ? 0 : w.nextNudgeAt).toBeGreaterThan(at);
				expect(findSilentWaits([w], replayTurns, at, opts())).toEqual([]);
				const bare = { ...w, nextNudgeAt: null };
				expect(findSilentWaits([bare], replayTurns, at, opts()).map(brief)).toEqual([
					{ task: `${c.role}#${c.id}`, step: "lead", to: w.decidingRole },
				]);
			});
		it("a question reads no pi-queue timer: no wake at + 59 min, a wake at + 60 min", () => {
			const w = q19();
			expect(w.nextNudgeAt).toBeNull();
			expect(findSilentWaits([w], NO_TURNS, w.start + 59 * M, opts())).toEqual([]);
			expect(findSilentWaits([w], NO_TURNS, w.start + 60 * M, opts()).map((f) => f.step)).toEqual(["lead"]);
		});
	});

	it("S7: a turn in the deciding chat after the wait began -> no wake (without it, a wake)", () => {
		const w = q19();
		const at = w.start + X * M;
		const spoke: HomeChatTurns = new Map([["backend", [w.start - 5 * M, w.start + 30 * M]]]);
		expect(findSilentWaits([w], spoke, at, opts())).toEqual([]);
		expect(findSilentWaits([w], spoke, w.start + 2 * X * M, opts())).toEqual([]);
		const before: HomeChatTurns = new Map([["backend", [w.start - 5 * M]]]);
		expect(findSilentWaits([w], before, at, opts()).map((f) => f.step)).toEqual(["lead"]);
	});

	it("S8: still silent 60 min after the lead wake -> exactly one COO wake, then nothing more for that wait", () => {
		const w = q19();
		const sent = new Map<string, number>();
		const round = (min: number) => {
			const now = w.start + min * M;
			const found = findSilentWaits([w], NO_TURNS, now, opts(sent));
			for (const f of found) sent.set(silenceWakeKey(f, f.step), now);
			return found.map(brief);
		};
		expect(round(X)).toEqual([{ task: "backend#218", step: "lead", to: "backend" }]);
		expect(round(X + 1)).toEqual([]);
		expect(round(2 * X - 1)).toEqual([]);
		expect(round(2 * X)).toEqual([{ task: "backend#218", step: "coo", to: SILENCE_COO_ROLE }]);
		expect(round(2 * X + 1)).toEqual([]);
		expect(round(3 * X)).toEqual([]);
		expect(round(24 * X)).toEqual([]);
	});

	it("S9: the task is answered or unblocked between rounds -> the pending wake is dropped", () => {
		const w = q19();
		const sent = new Map<string, number>();
		const lead = findSilentWaits([w], NO_TURNS, w.start + X * M, opts(sent));
		expect(lead.map((f) => f.step)).toEqual(["lead"]);
		sent.set(silenceWakeKey(w, "lead"), w.start + X * M);
		// Answered at + 90 min: the round at + 120 min no longer holds the wait, so no COO wake.
		expect(findSilentWaits([], NO_TURNS, w.start + 2 * X * M, opts(sent))).toEqual([]);
		// Answered at + 59 min: the lead wake that would have been due at + 60 is dropped too.
		expect(findSilentWaits([], NO_TURNS, w.start + X * M, opts())).toEqual([]);
	});

	it("S10: the same wait across a restart -> no second lead wake (the ledger read back)", () => {
		const w = q19();
		const first = findSilentWaits([w], NO_TURNS, w.start + X * M, opts());
		expect(first.map((f) => f.step)).toEqual(["lead"]);
		const ledger = first.map((f) => JSON.stringify({ key: silenceWakeKey(f, f.step), at: w.start + X * M }));
		// Restart: the server's memory is gone; only the ledger lines are read back.
		const sent = new Map(
			ledger.map((l) => JSON.parse(l) as { key: string; at: number }).map((e) => [e.key, e.at] as const),
		);
		expect(findSilentWaits([w], NO_TURNS, w.start + (X + 10) * M, opts(sent))).toEqual([]);
		expect(findSilentWaits([w], NO_TURNS, w.start + 2 * X * M, opts(sent)).map((f) => f.step)).toEqual(["coo"]);
	});

	it("S11: an incomplete registry read -> no silence finding (the whole-list alarm covers it); a complete one finds", () => {
		const w = q19();
		const now = w.start + X * M;
		let asked = 0;
		const waitsOf = () => {
			asked++;
			return [w];
		};
		const broken: RegistryIncomplete = {
			complete: false,
			at: now,
			reason: "unreadable-line",
			detail: "line 7",
			tasksRead: 6,
		};
		expect(silenceRound(broken, waitsOf, NO_TURNS, now, opts())).toEqual({
			complete: false,
			reason: "unreadable-line",
			detail: "line 7",
		});
		expect(asked).toBe(0);
		const whole: RegistryComplete = {
			complete: true,
			at: now,
			replay: newReplay(),
			times: new Map(),
			tasksRead: 1,
			bytes: 1,
			tookMs: 1,
		};
		const round = silenceRound(whole, waitsOf, NO_TURNS, now, opts());
		expect(round.complete && round.findings.map(brief)).toEqual([{ task: "backend#218", step: "lead", to: "backend" }]);
		expect(asked).toBe(1);
	});

	it("S12: replay parity: over the frozen 7 days the watch sends exactly the five lead wakes of replay_stalls.out", () => {
		const waits = fx.waits.map((w) => ({ w, input: inputOf(w), end: w.end ?? Number.POSITIVE_INFINITY }));
		// A round at every wait's start + X inside the window (the replay's own alarm times), oldest first.
		const rounds = [...new Set(waits.map((x) => x.w.start + X * M))]
			.filter((t) => fx.t0 <= t && t < fx.t1)
			.sort((a, b) => a - b);
		const sent = new Map<string, number>();
		const leads: string[] = [];
		for (const now of rounds) {
			const open = waits.filter((x) => x.w.start <= now && now < x.end).map((x) => x.input);
			for (const f of findSilentWaits(open, replayTurns, now, opts(sent))) {
				sent.set(silenceWakeKey(f, f.step), now);
				if (f.step === "lead") leads.push(`${minute(now)} ${f.task.queue}#${f.task.id} -> ${f.to}`);
			}
		}
		expect(leads).toEqual(REAL.map((r) => `${r.wake} ${r.role}#${r.id} -> ${r.deciding}`));
	});
});
