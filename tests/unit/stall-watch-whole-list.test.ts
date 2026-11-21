/**
 * Q-STALL-1 acceptance (written in Ops #1055 step 1, built in #1056 step 2; docs/stall-watch-whole-list.md). The
 * stall watch reads the whole work registry through its one reader (server/work-registry-reader.ts), and when it
 * can't, it raises the owner alarm in that same round instead of going quiet. In the land gate (tests/unit) since
 * step 2. Never weaken or skip a case to make it pass.
 *
 * Registries are built here, line by line as the store writes them, in a temporary folder: never the live one.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deadEndAnswer } from "../../server/dead-end.js";
import type { OwnerTelegramNotice, OwnerTelegramResult } from "../../server/owner-telegram.js";
import { STALL_DEFAULTS, StallWatch, type StallFinding, type StallWatchOptions } from "../../server/stall-watch.js";
import { replayWork, WORK_PAGE_TASKS_MAX, workPageOf } from "../../server/work-page.js";
import {
	watchInputsOf,
	WorkRegistryReader,
	type RegistryHeartbeat,
	type RegistryWatchHooks,
} from "../../server/work-registry-reader.js";

const H = 3_600_000;
const M = 60_000;
const NOW = Date.UTC(2026, 10, 21, 18, 0);
const T = NOW - 5 * H;
const OPS = "/home/u/.pi/agent/sessions/ops-home.jsonl";
const repo = join(import.meta.dirname, "..", "..");

/** A registry as the store writes it: `total` linked tasks, all done in project "bulk" (then dropped), except
 *  link number `stuckAt`, in active project "p", blocked on a need only since 20 minutes ago (a dead end). */
function registry(total: number, stuckAt: number): string {
	let seq = 0;
	const lines: string[] = [];
	const ev = (ts: number, e: Record<string, unknown>) =>
		lines.push(JSON.stringify({ v: 1, seq: ++seq, ts, by: "ops", ...e }));
	const project = (id: string) =>
		ev(T - 2 * H, {
			op: "project.create",
			id,
			name: `Proj ${id}`,
			outcome: "o",
			doneWhen: ["d"],
			lead: "ops",
			initiative: null,
		});
	project("bulk");
	project("p");
	const link = (added: number, task: number, p: string) =>
		ev(added, {
			op: "task.link",
			queue: OPS,
			queueName: "ops",
			task,
			added,
			title: `Task ${task}`,
			parent: { project: p },
		});
	const state = (ts: number, task: number, added: number, status: string, block?: Record<string, unknown>) =>
		ev(ts, { op: "task.state", queue: OPS, task, added, status, ...(block ? { block } : {}) });
	const added = (i: number) => T - H + i;
	for (let i = 1; i <= total; i++) {
		link(added(i), i, i === stuckAt ? "p" : "bulk");
		state(added(i), i, added(i), i === stuckAt ? "working" : "done");
	}
	ev(NOW - 30 * M, { op: "project.change", id: "bulk", changes: { status: "dropped" } });
	state(NOW - 20 * M, stuckAt, added(stuckAt), "blocked", { need: "the deploy", reminders: 0, since: NOW - 20 * M });
	return lines.map((l) => `${l}\n`).join("");
}

/** The same text with a line that isn't JSON in its middle. */
function withUnreadableLine(text: string): string {
	const lines = text.split("\n");
	lines.splice(Math.floor(lines.length / 2), 0, "{not json");
	return lines.join("\n");
}

/** Linked tasks counted independently of the reader: each (queue, task, added) of a task.link line once. */
function independentCount(text: string): number {
	const keys = new Set<string>();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const e = JSON.parse(line) as { op?: string; queue?: string; task?: number; added?: number };
		if (e.op === "task.link") keys.add(`${e.queue}\u0000${e.task}\u0000${e.added}`);
	}
	return keys.size;
}

let dir = "";
let file = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "stall-whole-list-"));
	file = join(dir, "events.jsonl");
});
afterEach(() => {
	chmodSync(dir, 0o700);
	rmSync(dir, { recursive: true, force: true });
});

const write = (text: string) => {
	rmSync(file, { force: true });
	writeFileSync(file, text);
};
const breakRead = () => chmodSync(file, 0o000);

/** A stall watch over `file` through the one reader, with the alarm and heartbeat hooks and a log kept. */
function watch() {
	const alarm = vi.fn(async (_n: OwnerTelegramNotice): Promise<OwnerTelegramResult> => ({ ok: true, messageIds: [1] }));
	const heartbeat = vi.fn((_b: RegistryHeartbeat) => undefined);
	const act = vi.fn((_f: StallFinding[], _now: number) => undefined);
	const lines: string[] = [];
	const reader = new WorkRegistryReader(() => file);
	const opts: StallWatchOptions & RegistryWatchHooks = {
		read: async () => watchInputsOf(await reader.read(NOW), [], new Map(), NOW),
		act,
		settings: () => ({ ...STALL_DEFAULTS }),
		now: () => NOW,
		log: (line) => lines.push(line),
		alarm,
		heartbeat,
	};
	return { w: new StallWatch(opts), alarm, heartbeat, act, lines };
}

const stuck = (findings: readonly StallFinding[]) => findings.filter((f) => f.kind === "project" && f.id === "p");
const skippedKept = (lines: string[]) => lines.filter((l) => /round skipped.*last findings kept/.test(l));

describe("AC1: a registry of 3,500 linked tasks", () => {
	it("a round completes and finds the stuck task that is link number 3,400", async () => {
		write(registry(3500, 3400));
		const { w, lines } = watch();
		const review = await w.tick();
		expect(skippedKept(lines), "the round was skipped, last findings kept").toEqual([]);
		expect(review, "the round was skipped").toBeDefined();
		expect(stuck(review?.findings ?? [])).toMatchObject([{ rule: "dead-end", since: NOW - 20 * M }]);
		expect(stuck(w.list().findings)).toHaveLength(1);
	});
});

describe("AC2: input the reader can't read whole raises the owner alarm in that same round", () => {
	it("an unreadable line, then a read error: one alarm each, never repeated while it lasts, no stale findings", async () => {
		const good = registry(10, 5);
		const { w, alarm, lines } = watch();
		write(good);
		await w.tick();
		expect(stuck(w.list().findings), "the first, complete round's finding").toHaveLength(1);

		write(withUnreadableLine(good));
		await w.tick();
		expect(alarm, "one alarm in the round that met the unreadable line").toHaveBeenCalledTimes(1);
		expect(alarm.mock.calls[0][0].text).toMatch(/work registry/);
		expect(skippedKept(lines)).toEqual([]);
		expect(w.list().findings, "earlier findings shown as current").toEqual([]);

		await w.tick();
		expect(alarm, "the same condition alarmed again").toHaveBeenCalledTimes(1);

		write(good);
		await w.tick();
		expect(alarm).toHaveBeenCalledTimes(1);
		expect(stuck(w.list().findings)).toHaveLength(1);

		breakRead();
		await w.tick();
		expect(alarm, "a new break after recovery alarms again").toHaveBeenCalledTimes(2);
		expect(w.list().findings).toEqual([]);
		await w.tick();
		expect(alarm).toHaveBeenCalledTimes(2);
	});

	it("a read error in the very first round alarms in that round", async () => {
		write(registry(10, 5));
		breakRead();
		const { w, alarm, lines } = watch();
		await w.tick();
		expect(alarm).toHaveBeenCalledTimes(1);
		expect(skippedKept(lines)).toEqual([]);
	});
});

describe("AC3: the dead-end answer", () => {
	it('on an incomplete read is "unknown", never moving or quiet', async () => {
		const reader = new WorkRegistryReader(() => file);
		write(withUnreadableLine(registry(10, 5)));
		const unreadable = watchInputsOf(await reader.read(NOW), [], new Map(), NOW).page;
		expect(deadEndAnswer(unreadable, { project: "p" }, NOW).state).toBe("unknown");
		write(registry(10, 5));
		breakRead();
		const failed = watchInputsOf(await reader.read(NOW), [], new Map(), NOW).page;
		expect(deadEndAnswer(failed, { project: "p" }, NOW).state).toBe("unknown");
	});

	it("on a complete read of 3,500 links it sees the project's task at link 3,400", async () => {
		write(registry(3500, 3400));
		const page = watchInputsOf(await new WorkRegistryReader(() => file).read(NOW), [], new Map(), NOW).page;
		expect(deadEndAnswer(page, { project: "p" }, NOW)).toMatchObject({ state: "dead" });
	});
});

describe("AC4: heartbeat", () => {
	it("a complete round records one (time, tasks read); an incomplete one doesn't", async () => {
		const { w, heartbeat } = watch();
		write(registry(3500, 3400));
		await w.tick();
		expect(heartbeat.mock.calls).toEqual([[{ at: NOW, tasksRead: 3500 }]]);
		write(withUnreadableLine(registry(3500, 3400)));
		await w.tick();
		expect(heartbeat).toHaveBeenCalledTimes(1);
	});
});

describe("AC5: the display page (passes today: it must stay so)", () => {
	it("over 2,000 links it still sends at most WORK_PAGE_TASKS_MAX tasks, first linked first, with the same fields", () => {
		expect(WORK_PAGE_TASKS_MAX).toBe(2000);
		const big = workPageOf(replayWork(registry(2500, 2400)), [], NOW);
		const small = workPageOf(replayWork(registry(10, 5)), [], NOW);
		expect(big.tasks).toHaveLength(WORK_PAGE_TASKS_MAX);
		expect(big.tasks[0].task).toBe(1);
		expect(big.tasks.at(-1)?.task).toBe(WORK_PAGE_TASKS_MAX);
		expect(Object.keys(big.tasks[0]).sort()).toEqual(Object.keys(small.tasks[0]).sort());
		const fields = (p: object) =>
			Object.keys(p)
				.filter((k) => k !== "problem")
				.sort();
		expect(fields(big)).toEqual(fields(small));
	});
});

describe("AC6: one reader (rule 23)", () => {
	const source = (path: string) => readFileSync(join(repo, path), "utf8");
	it("stall-watch.ts and dead-end.ts get registry tasks only through work-registry-reader.ts", () => {
		const stall = source("server/stall-watch.ts");
		const dead = source("server/dead-end.ts");
		const service = source("server/agent-service.ts");
		// The first match only, never the whole file, in a failure.
		const found = (text: string, re: RegExp) => text.match(re)?.[0] ?? null;
		const reader = /from "\.\/work-registry-reader\.js"/;
		expect(found(stall, reader), "stall-watch.ts imports the reader").not.toBeNull();
		expect(found(dead, reader), "dead-end.ts imports the reader").not.toBeNull();
		// No second parser of the events file: the extra times come from the reader's own read.
		const second = /function stallTimesFrom|class StallTimesFile|"task\.link"|replayWork|WorkPageFile/;
		expect(found(stall, second), "a second registry parser in stall-watch.ts").toBeNull();
		expect(found(dead, /replayWork|WorkPageFile|JSON\.parse/), "a registry parser in dead-end.ts").toBeNull();
		expect(found(service, /new StallTimesFile\(/), "agent-service.ts reads the times apart").toBeNull();
		expect(found(service, /new WorkRegistryReader\(/), "agent-service.ts makes the reader").not.toBeNull();
	});
});

describe("AC7: the reader's count is the whole list", () => {
	it("complete, and its linked-task count equals an independent count (re-links counted once)", async () => {
		let text = registry(2600, 2500);
		// A title change re-links the same (queue, task, added): still one task.
		const relink = { v: 1, seq: 99_999, ts: NOW, by: "ops", op: "task.link", queue: OPS, queueName: "ops", task: 7 };
		text += `${JSON.stringify({ ...relink, added: T - H + 7, title: "Task 7, renamed", parent: { project: "bulk" } })}\n`;
		write(text);
		const read = await new WorkRegistryReader(() => file).read(NOW);
		expect(read.complete).toBe(true);
		expect(read.tasksRead).toBe(independentCount(text));
		expect(read.tasksRead).toBe(2600);
	});
});
