/**
 * H-STALL-WHOLE-2 (Ops #1064; docs/stall-watch-registry-missing.md): a registry file that had tasks and is now
 * missing, or that shrinks while it is read, is an incomplete read (Q-STALL-1: never report from a partial
 * list). A machine that never had a registry stays quiet. Cases a-h; written red before the change.
 *
 * Everything runs in a temporary folder with a stub alarm sender and a fixed clock: never the live registry or
 * heartbeat. The O1 cases wrap node:fs/promises `open` here (a test harness outside production code) so the
 * file changes between two pieces of one read, with no sleeps or timing races.
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deadEndAnswer } from "../../server/dead-end.js";
import type { OwnerTelegramNotice, OwnerTelegramResult } from "../../server/owner-telegram.js";
import { STALL_DEFAULTS, StallWatch, type StallFinding } from "../../server/stall-watch.js";
import type { UiWorkPage } from "../../server/protocol.js";
import {
	readShrank,
	STALL_HEARTBEAT_FILE,
	registryIncompleteAlarm,
	registryWatchOf,
	watchInputsOf,
	WorkRegistryReader,
	writeRegistryHeartbeat,
	type RegistryIncomplete,
	type RegistryRead,
} from "../../server/work-registry-reader.js";

/** Called after each piece one read takes from the file (the O1 cases change the file there). */
const pieces = vi.hoisted(() => ({ after: undefined as undefined | ((n: number) => void) }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs/promises")>();
	const open: typeof real.open = async (...args) => {
		const fh = await real.open(...args);
		const read = fh.read.bind(fh) as (...a: unknown[]) => Promise<{ bytesRead: number }>;
		let n = 0;
		Object.assign(fh, {
			read: async (...a: unknown[]) => {
				const got = await read(...a);
				pieces.after?.(++n);
				return got;
			},
		});
		return fh;
	};
	return { ...real, open, default: { ...real, open } };
});

const H = 3_600_000;
const M = 60_000;
const NOW = Date.UTC(2026, 10, 22, 18, 0);
const T = NOW - 5 * H;
const OPS = "/home/u/.pi/agent/sessions/ops-home.jsonl";

/** `total` linked tasks in active project "p", task `stuckAt` blocked 20 minutes ago (a dead end), the rest done. */
function registry(total: number, stuckAt: number): string {
	let seq = 0;
	const lines: string[] = [];
	const ev = (ts: number, e: Record<string, unknown>) =>
		lines.push(JSON.stringify({ v: 1, seq: ++seq, ts, by: "ops", ...e }));
	ev(T - 2 * H, {
		op: "project.create",
		id: "p",
		name: "Proj p",
		outcome: "o",
		doneWhen: ["d"],
		lead: "ops",
		initiative: null,
	});
	for (let i = 1; i <= total; i++) {
		const added = T - H + i;
		const parent = { project: "p" };
		ev(added, { op: "task.link", queue: OPS, queueName: "ops", task: i, added, title: `Task ${i}`, parent });
		const status = i === stuckAt ? "working" : "done";
		ev(added, { op: "task.state", queue: OPS, task: i, added, status });
	}
	const since = NOW - 20 * M;
	const block = { need: "the deploy", reminders: 0, since };
	ev(since, { op: "task.state", queue: OPS, task: stuckAt, added: T - H + stuckAt, status: "blocked", block });
	return lines.map((l) => `${l}\n`).join("");
}

let dir = "";
let file = "";
let beatFile = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "registry-missing-"));
	file = join(dir, "events.jsonl");
	beatFile = join(dir, STALL_HEARTBEAT_FILE);
});
afterEach(() => {
	pieces.after = undefined;
	rmSync(dir, { recursive: true, force: true });
});

/**
 * A stall watch as production wires it: the reader and the heartbeat writer from the one factory
 * (`registryWatchOf`), a stub alarm, a clock that moves one minute per round. `started` is "after a restart".
 */
function rig() {
	let clock = NOW;
	const alarm = vi.fn(async (_n: OwnerTelegramNotice): Promise<OwnerTelegramResult> => ({ ok: true, messageIds: [1] }));
	const lines: string[] = [];
	const { reader, heartbeat } = registryWatchOf(dir, () => file);
	let page: UiWorkPage | undefined;
	let read: RegistryRead | undefined;
	const w = new StallWatch({
		read: async () => {
			read = await reader.read(clock);
			const inputs = watchInputsOf(read, [], new Map(), clock);
			page = inputs.page;
			return inputs;
		},
		act: vi.fn((_f: StallFinding[], _now: number) => undefined),
		settings: () => ({ ...STALL_DEFAULTS }),
		now: () => clock,
		log: (line) => lines.push(line),
		alarm,
		heartbeat,
	});
	const tick = async () => {
		clock += M;
		await w.tick();
		return { read: read!, deadEnd: deadEndAnswer(page!, { project: "p" }, clock).state };
	};
	return { w, alarm, lines, tick };
}

const notWhole = (lines: string[]) => lines.filter((l) => l.includes("registry not read whole"));
const beatText = () => readFileSync(beatFile, "utf8");

/** The checks a missing registry that had tasks must pass in the round that meets it. */
function expectMissingRound(r: ReturnType<typeof rig>, got: { read: RegistryRead; deadEnd: string }, known: number) {
	expect(got.read).toMatchObject({ complete: false, reason: "missing", tasksRead: 0 });
	expect(r.alarm, "exactly one owner alarm").toHaveBeenCalledTimes(1);
	expect(r.w.list().findings, "no findings shown as current").toEqual([]);
	expect(notWhole(r.lines), 'the log says "registry not read whole"').toHaveLength(1);
	expect(got.deadEnd).toBe("unknown");
	const text = r.alarm.mock.calls[0][0].text;
	expect(text).toMatch(/registry file is missing/);
	expect(text).toContain(file);
	expect(text).toContain(`${known} linked tasks`);
	expect(text).toMatch(/creating the file \(even empty\)/i);
}

describe("D1: a missing registry file", () => {
	it("(a) had tasks in this process, then removed: incomplete 'missing', 1 alarm, no findings, unknown, no heartbeat", async () => {
		writeFileSync(file, registry(10, 5));
		const r = rig();
		const first = await r.tick();
		expect(first.read).toMatchObject({ complete: true, tasksRead: 10 });
		expect(r.w.list().findings.filter((f) => f.id === "p")).toHaveLength(1);
		const beat = beatText();
		expect(JSON.parse(beat)).toMatchObject({ tasksRead: 10 });

		rmSync(file);
		const got = await r.tick();
		expectMissingRound(r, got, 10);
		expect(beatText(), "heartbeat rewritten after an incomplete read").toBe(beat);
		await r.tick();
		expect(r.alarm, "once per break").toHaveBeenCalledTimes(1);
	});

	it("(a2) memory alone: a reader with no heartbeat source that read tasks, file removed -> 'missing'", async () => {
		writeFileSync(file, registry(4, 2));
		const reader = new WorkRegistryReader(() => file);
		expect(await reader.read(NOW)).toMatchObject({ complete: true, tasksRead: 4 });
		rmSync(file);
		expect(await reader.read(NOW + M)).toMatchObject({
			complete: false,
			reason: "missing",
			detail: `not found at ${file}; the last complete read (${new Date(NOW).toISOString()}) had 4 linked tasks`,
		});
	});

	it("(b) after a restart: a new reader from the factory, heartbeat says 3, no registry file -> same as (a)", async () => {
		writeRegistryHeartbeat(beatFile, { at: NOW - H, tasksRead: 3 });
		const beat = beatText();
		const r = rig();
		const got = await r.tick();
		expectMissingRound(r, got, 3);
		expect(got.read.complete || got.read.detail).toContain(new Date(NOW - H).toISOString());
		expect(beatText()).toBe(beat);
	});

	it("(c) a new machine: no registry file, no heartbeat -> complete and empty, 0 alarms, quiet", async () => {
		const r = rig();
		const got = await r.tick();
		expect(got.read).toMatchObject({ complete: true, tasksRead: 0 });
		expect(r.alarm).not.toHaveBeenCalled();
		expect(notWhole(r.lines)).toEqual([]);
		expect(got.deadEnd).toBe("quiet");
	});

	it("(d) heartbeat says 0 tasks, no registry file -> quiet", async () => {
		writeRegistryHeartbeat(beatFile, { at: NOW - H, tasksRead: 0 });
		const r = rig();
		const got = await r.tick();
		expect(got.read).toMatchObject({ complete: true, tasksRead: 0 });
		expect(r.alarm).not.toHaveBeenCalled();
		expect(got.deadEnd).toBe("quiet");
	});

	it("(e) a garbled heartbeat file, no registry file -> incomplete (it can't prove a new machine)", async () => {
		writeFileSync(beatFile, '{"at":"2026-11-22T17:00:00.000Z","tasksRe');
		const r = rig();
		const got = await r.tick();
		expect(got.read).toMatchObject({ complete: false, reason: "missing" });
		expect(r.alarm).toHaveBeenCalledTimes(1);
		expect(got.deadEnd).toBe("unknown");
		for (const bad of ["[]", '{"at":"x","tasksRead":3}', '{"at":"2026-11-22T17:00:00.000Z","tasksRead":-1}']) {
			writeFileSync(beatFile, bad);
			expect(await rig().tick(), bad).toMatchObject({ read: { complete: false, reason: "missing" } });
		}
	});

	it("(f) the file comes back (empty, then with tasks): the watch recovers; removed again: a second alarm", async () => {
		writeFileSync(file, registry(10, 5));
		const r = rig();
		await r.tick();
		rmSync(file);
		await r.tick();
		expect(r.alarm).toHaveBeenCalledTimes(1);

		writeFileSync(file, "");
		const empty = await r.tick();
		expect(empty.read, "an existing empty file is complete with 0 tasks").toMatchObject({
			complete: true,
			tasksRead: 0,
		});
		writeFileSync(file, registry(12, 5));
		const back = await r.tick();
		expect(back.read).toMatchObject({ complete: true, tasksRead: 12 });
		expect(r.w.list().findings.filter((f) => f.id === "p")).toHaveLength(1);
		expect(JSON.parse(beatText())).toMatchObject({ tasksRead: 12 });

		rmSync(file);
		const again = await r.tick();
		expect(again.read).toMatchObject({ complete: false, reason: "missing" });
		expect(r.alarm, "a new break after recovery alarms again").toHaveBeenCalledTimes(2);
		expect(r.alarm.mock.calls[1][0].text).toContain("12 linked tasks");
	});
});

describe("O1: the file changes while it is read", () => {
	/** A registry over two read pieces (1 MiB each), so the file can change between them. */
	const big = () => registry(9_000, 8_999);

	it("(g) the size verdict: short of the size at open, or the file now smaller than what was read", () => {
		expect(readShrank(100, 100, 100)).toBeUndefined();
		expect(readShrank(100, 120, 120), "grew during the read").toBeUndefined();
		expect(readShrank(100, 60, 60)).toBe("the file shrank while it was read (read 60 of 100 bytes)");
		expect(readShrank(100, 100, 40)).toBe("the file shrank while it was read (read 100 of 100 bytes)");
	});

	it("(g) a real file cut short in place after the first piece -> incomplete, naming bytes read and expected", async () => {
		const text = big();
		writeFileSync(file, text);
		const size = statSync(file).size;
		expect(size).toBeGreaterThan(2 << 20);
		const keep = (3 << 20) / 2;
		pieces.after = (n) => {
			if (n === 1) truncateSync(file, keep);
		};
		const r = rig();
		const got = await r.tick();
		expect(got.read).toMatchObject({
			complete: false,
			reason: "read-error",
			detail: `the file shrank while it was read (read ${keep} of ${size} bytes)`,
		});
		expect(r.alarm).toHaveBeenCalledTimes(1);
		expect(got.deadEnd).toBe("unknown");
	});

	it("(h) lines appended during a read -> complete", async () => {
		const text = big();
		writeFileSync(file, text);
		const extra = registry(3, 2)
			.split("\n")
			.filter((l) => l.includes('"task.state"'))
			.map((l) => `${l}\n`)
			.join("");
		pieces.after = (n) => {
			if (n === 1) appendFileSync(file, extra);
		};
		const r = rig();
		const got = await r.tick();
		expect(got.read).toMatchObject({ complete: true, tasksRead: 9_000 });
		expect(r.alarm).not.toHaveBeenCalled();
	});
});

describe("the owner alarm for a missing registry", () => {
	it("says where the file was expected, the last count, and what ends it", () => {
		const read: RegistryIncomplete = {
			complete: false,
			at: NOW,
			reason: "missing",
			detail: "not found at /x/events.jsonl; the last complete read (2026-11-22T17:00:00.000Z) had 3225 linked tasks",
			tasksRead: 0,
		};
		const text = registryIncompleteAlarm("stuck-work watch", read).text;
		expect(text).toMatch(/registry file is missing/);
		expect(text).toContain("/x/events.jsonl");
		expect(text).toContain("3225 linked tasks");
		expect(text).toMatch(/work-folder setting/);
		expect(text).toMatch(/comes once/);
	});
});
