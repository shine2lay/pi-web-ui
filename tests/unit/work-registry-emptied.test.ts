/**
 * H-STALL-WHOLE-3 (Ops #1065; docs/stall-watch-registry-missing.md; QA L6/O9): a work list that drops from tasks to
 * none sends the owner one alarm, in the same process and after a restart, and the read stays complete. Cases a-i;
 * written red before the change.
 *
 * Everything runs in a temporary folder with a stub alarm sender and a fixed clock: never the live registry or
 * heartbeat. Every watch is wired the way production wires it: reader, alarm and heartbeat from `registryWatchOf`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deadEndAnswer } from "../../server/dead-end.js";
import type { OwnerTelegramNotice, OwnerTelegramResult } from "../../server/owner-telegram.js";
import { STALL_DEFAULTS, StallWatch } from "../../server/stall-watch.js";
import type { UiWorkPage } from "../../server/protocol.js";
import {
	registryWatchOf,
	STALL_HEARTBEAT_FILE,
	watchInputsOf,
	writeRegistryHeartbeat,
	type RegistryRead,
} from "../../server/work-registry-reader.js";

const H = 3_600_000;
const M = 60_000;
const NOW = Date.UTC(2026, 10, 23, 18, 0);
const OPS = "/home/u/.pi/agent/sessions/ops-home.jsonl";

/** `total` linked tasks in active project "p", all working. */
function registry(total: number): string {
	const T = NOW - 5 * H;
	let seq = 0;
	const lines: string[] = [];
	const ev = (ts: number, e: Record<string, unknown>) =>
		lines.push(JSON.stringify({ v: 1, seq: ++seq, ts, by: "ops", ...e }));
	ev(T, { op: "project.create", id: "p", name: "p", outcome: "o", doneWhen: ["d"], lead: "ops", initiative: null });
	for (let i = 1; i <= total; i++) {
		const added = T + i;
		ev(added, {
			op: "task.link",
			queue: OPS,
			queueName: "ops",
			task: i,
			added,
			title: `t${i}`,
			parent: { project: "p" },
		});
		ev(added, { op: "task.state", queue: OPS, task: i, added, status: "working" });
	}
	return lines.map((l) => `${l}\n`).join("");
}

let dir = "";
let file = "";
let beatFile = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "registry-emptied-"));
	file = join(dir, "events.jsonl");
	beatFile = join(dir, STALL_HEARTBEAT_FILE);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const beat = () => JSON.parse(readFileSync(beatFile, "utf8")) as { at: string; tasksRead: number };
type Send = (n: OwnerTelegramNotice) => Promise<OwnerTelegramResult>;
const sent: Send = async () => ({ ok: true, messageIds: [1] });

/**
 * One server process as production wires it: `registryWatchOf` gives the reader, the owner alarm route and the
 * heartbeat writer; a stub sender; a clock one minute on per round. A new rig over the same folder = a restart.
 * The stub notes what the heartbeat file said when the alarm went out (it must still be the old count).
 */
function rig(send: Send = sent) {
	let clock = NOW;
	const beatAtAlarm: Array<number | undefined> = [];
	const alarm = vi.fn(async (n: OwnerTelegramNotice) => {
		beatAtAlarm.push(readBeat());
		return send(n);
	});
	const lines: string[] = [];
	const made = registryWatchOf(dir, () => file, { alarm, log: (l) => lines.push(l) });
	let page: UiWorkPage | undefined;
	let read: RegistryRead | undefined;
	const w = new StallWatch({
		read: async () => {
			read = await made.reader.read(clock);
			const inputs = watchInputsOf(read, [], new Map(), clock);
			page = inputs.page;
			return inputs;
		},
		act: () => undefined,
		settings: () => ({ ...STALL_DEFAULTS }),
		now: () => clock,
		log: (l) => lines.push(l),
		...made.hooks,
	});
	const tick = async () => {
		clock += M;
		await w.tick();
		return { read: read!, deadEnd: deadEndAnswer(page!, { project: "p" }, clock).state };
	};
	return { alarm, lines, tick, beatAtAlarm, reader: made.reader };
}

function readBeat(): number | undefined {
	try {
		return beat().tasksRead;
	} catch {
		return undefined;
	}
}

const texts = (r: ReturnType<typeof rig>) => r.alarm.mock.calls.map((c) => c[0].text);

describe("H-STALL-WHOLE-3: a work list that drops from tasks to none", () => {
	it("(a) emptied in place between two rounds: complete, 0 tasks, 1 alarm naming 50, sent before the heartbeat says 0", async () => {
		writeFileSync(file, registry(50));
		const r = rig();
		expect((await r.tick()).read).toMatchObject({ complete: true, tasksRead: 50 });
		expect(beat().tasksRead).toBe(50);

		writeFileSync(file, "");
		const got = await r.tick();
		expect(got.read, "the read stays complete").toMatchObject({ complete: true, tasksRead: 0 });
		expect(got.deadEnd).toBe("quiet");
		expect(r.alarm, "exactly one owner alarm").toHaveBeenCalledTimes(1);
		const text = texts(r)[0];
		expect(text).toMatch(/from 50 linked tasks/);
		expect(text).toMatch(/to none/);
		expect(text).toContain(new Date(NOW + M).toISOString());
		expect(text).toMatch(/deliberate reset/);
		expect(text).toContain(file);
		expect(text).toMatch(/comes once/i);
		expect(r.beatAtAlarm, "the alarm went out while the heartbeat still said 50").toEqual([50]);
		expect(beat().tasksRead, "then the heartbeat says 0").toBe(0);
		expect(r.lines.filter((l) => l.includes("registry not read whole"))).toEqual([]);
		expect(r.lines.some((l) => /dropped from 50 linked tasks to none.*owner alarm sent/.test(l))).toBe(true);

		await r.tick();
		await r.tick();
		expect(r.alarm, "no alarm on the rounds after").toHaveBeenCalledTimes(1);
	});

	it("(b) after a restart: heartbeat on disk says 50, file present and empty -> 1 alarm, then heartbeat 0; next restart quiet", async () => {
		writeRegistryHeartbeat(beatFile, { at: NOW - H, tasksRead: 50 });
		writeFileSync(file, "");
		const first = rig();
		const got = await first.tick();
		expect(got.read).toMatchObject({ complete: true, tasksRead: 0 });
		expect(first.alarm).toHaveBeenCalledTimes(1);
		expect(texts(first)[0]).toMatch(/from 50 linked tasks/);
		expect(texts(first)[0]).toContain(new Date(NOW - H).toISOString());
		expect(first.beatAtAlarm).toEqual([50]);
		expect(beat().tasksRead).toBe(0);

		const second = rig();
		await second.tick();
		await second.tick();
		expect(second.alarm, "a second new reader").not.toHaveBeenCalled();
	});

	it("(c) a new machine (no file, no heartbeat) and heartbeat 0 + empty file -> 0 alarms", async () => {
		const fresh = rig();
		expect((await fresh.tick()).read).toMatchObject({ complete: true, tasksRead: 0 });
		expect(fresh.alarm).not.toHaveBeenCalled();

		writeRegistryHeartbeat(beatFile, { at: NOW - H, tasksRead: 0 });
		writeFileSync(file, "");
		const zero = rig();
		await zero.tick();
		await zero.tick();
		expect(zero.alarm, "0 -> 0").not.toHaveBeenCalled();
		expect(beat().tasksRead).toBe(0);
	});

	it("(d) a drop from 50 to 10 tasks -> 0 alarms", async () => {
		writeFileSync(file, registry(50));
		const r = rig();
		await r.tick();
		writeFileSync(file, registry(10));
		expect((await r.tick()).read).toMatchObject({ complete: true, tasksRead: 10 });
		expect(r.alarm).not.toHaveBeenCalled();
		expect(beat().tasksRead).toBe(10);
	});

	it("(e) tasks come back after the drop, then drop to none again -> a second alarm naming the new count", async () => {
		writeFileSync(file, registry(50));
		const r = rig();
		await r.tick();
		writeFileSync(file, "");
		await r.tick();
		expect(r.alarm).toHaveBeenCalledTimes(1);
		writeFileSync(file, registry(12));
		expect((await r.tick()).read).toMatchObject({ complete: true, tasksRead: 12 });
		expect(r.alarm, "tasks coming back: no alarm").toHaveBeenCalledTimes(1);
		writeFileSync(file, "");
		await r.tick();
		expect(r.alarm).toHaveBeenCalledTimes(2);
		expect(texts(r)[1]).toMatch(/from 12 linked tasks/);
	});

	it("(f) L6, accepted: emptied, then removed -> reads as a new machine and stays quiet, now and after a restart", async () => {
		writeFileSync(file, registry(50));
		const r = rig();
		await r.tick();
		writeFileSync(file, "");
		await r.tick();
		expect(r.alarm, "told once, at the drop").toHaveBeenCalledTimes(1);
		rmSync(file);
		expect((await r.tick()).read, "the heartbeat says 0: a new machine").toMatchObject({
			complete: true,
			tasksRead: 0,
		});
		expect(r.alarm).toHaveBeenCalledTimes(1);
		const restarted = rig();
		expect((await restarted.tick()).read).toMatchObject({ complete: true, tasksRead: 0 });
		expect(restarted.alarm).not.toHaveBeenCalled();
	});

	it("(g) a send that surely failed stays owed: tried again next round, then once only", async () => {
		writeFileSync(file, registry(50));
		const results: OwnerTelegramResult[] = [
			{ ok: false, error: "network down" },
			{ ok: true, messageIds: [2] },
		];
		const r = rig(async () => results.shift() ?? { ok: true, messageIds: [3] });
		await r.tick();
		writeFileSync(file, "");
		expect((await r.tick()).read).toMatchObject({ complete: true, tasksRead: 0 });
		expect(r.alarm).toHaveBeenCalledTimes(1);
		expect(r.lines.some((l) => /owner alarm not sent: network down/.test(l))).toBe(true);
		await r.tick();
		expect(r.alarm, "tried again").toHaveBeenCalledTimes(2);
		await r.tick();
		expect(r.alarm, "sent: not again").toHaveBeenCalledTimes(2);
	});

	it("(h) the way back after a missing file: a file put back empty ends 'missing' with no second alarm", async () => {
		writeFileSync(file, registry(50));
		const r = rig();
		await r.tick();
		rmSync(file);
		expect((await r.tick()).read).toMatchObject({ complete: false, reason: "missing" });
		writeFileSync(file, "");
		expect((await r.tick()).read).toMatchObject({ complete: true, tasksRead: 0 });
		expect(r.alarm.mock.calls.map((c) => /file is missing/.test(c[0].text))).toEqual([true]);
		expect(beat().tasksRead).toBe(0);
	});

	it("(i) two reads at once over the emptied file -> one alarm", async () => {
		writeRegistryHeartbeat(beatFile, { at: NOW - H, tasksRead: 50 });
		writeFileSync(file, "");
		const r = rig();
		const both = await Promise.all([r.reader.read(NOW), r.reader.read(NOW)]);
		expect(both.map((b) => b.complete)).toEqual([true, true]);
		expect(r.alarm).toHaveBeenCalledTimes(1);
	});
});
