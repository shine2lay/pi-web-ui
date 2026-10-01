/**
 * carry-on: the live list of working chats (running-chats.json) and the note each cut-off chat
 * gets after a restart. The reopening itself is covered by tests/carry-on-restart-test.mjs.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CARRY_ON_PREFIX,
	carryOnLogLine,
	carryOnNote,
	cutoffCounts,
	cutoffWords,
	describeStep,
	guardNotice,
	LOOP_GUARD_CUTOFFS,
	newestInterrupted,
	PLANNED_CUTOFF_CEILING,
	planCarryOn,
	type RunningChat,
	RunningChats,
	type RunningChatsFile,
	readRunningChatsFile,
	stepFromTranscriptTail,
	takeRestartReason,
	toolDetail,
} from "../../server/running-chats.js";

const AT = new Date(2026, 8, 27, 1, 5).getTime(); // 01:05 local time, whatever the TZ

function chat(over: Partial<RunningChat> = {}): RunningChat {
	return { sessionFile: "/s/a.jsonl", title: "A", cwd: "/w", startedAt: AT - 1000, cutoffs: 0, tools: [], ...over };
}

describe("the note", () => {
	it("says when, why, and what was cut off", () => {
		expect(carryOnNote(new Date(AT), "an update was installed", "writing a reply")).toBe(
			"pi-web-ui restarted at 01:05 (an update was installed). You were in the middle of writing a reply; it was cut off. Check where it stopped and carry on.",
		);
		expect(carryOnNote(new Date(AT), "x", "y").startsWith(CARRY_ON_PREFIX)).toBe(true);
	});

	it("describes the step: writing, a command, another tool, a question, several at once", () => {
		expect(describeStep([])).toBe("writing a reply");
		expect(describeStep([{ id: "1", name: "bash", detail: "npm test" }])).toBe("running the bash command `npm test`");
		expect(describeStep([{ id: "1", name: "read", detail: "/x/y.ts" }])).toBe("running the read tool (/x/y.ts)");
		expect(describeStep([{ id: "1", name: "web_search" }])).toBe("running the web_search tool");
		expect(describeStep([{ id: "1", name: "ask_user_question" }])).toBe(
			"asking the user a question (ask_user_question) (they hadn't answered yet, so ask it again)",
		);
		expect(
			describeStep([
				{ id: "1", name: "bash", detail: "sleep 5" },
				{ id: "2", name: "read", detail: "a.txt" },
			]),
		).toBe("running 2 tools at once: the bash command `sleep 5`; the read tool (a.txt)");
	});

	it("takes one line of the tool's main argument", () => {
		expect(toolDetail("bash", { command: "cd x &&\n  npm   test" })).toBe("cd x && npm test");
		expect(toolDetail("read", { path: "/a/b" })).toBe("/a/b");
		expect(toolDetail("bash", { path: "/a/b" })).toBeUndefined();
		expect(toolDetail("x", null)).toBeUndefined();
		expect(toolDetail("bash", { command: "y".repeat(400) })?.length).toBe(160);
	});
});

describe("planning the carry-on", () => {
	const prev = (over: Partial<RunningChatsFile> = {}): RunningChatsFile => ({
		v: 1,
		pid: 1,
		shutdown: { at: AT - 5000, signal: "shutdown" },
		chats: [chat()],
		...over,
	});

	it("a planned restart uses pi-web-deploy's fresh reason", () => {
		const plan = planCarryOn(prev(), { reason: "update abc1234 installed", at: AT - 10_000 }, AT);
		expect(plan.kind).toBe("planned");
		expect(plan.reason).toBe("update abc1234 installed");
		expect(plan.carry).toHaveLength(1);
		expect(plan.carry[0].cutoffs).toBe(1);
		expect(plan.carry[0].note).toContain("(update abc1234 installed). You were in the middle of writing a reply;");
	});

	it('without a (fresh) reason it\'s "a restart"; without a shutdown mark it crashed', () => {
		expect(planCarryOn(prev(), null, AT).reason).toBe("a restart");
		expect(planCarryOn(prev(), { reason: "old", at: AT - 60 * 60_000 }, AT).reason).toBe("a restart");
		const crash = planCarryOn(prev({ shutdown: undefined }), { reason: "ignored", at: AT }, AT);
		expect(crash.kind).toBe("crash");
		expect(crash.reason).toBe("it crashed or was killed");
		expect(crash.carry[0].note).toContain("(it crashed or was killed)");
	});

	it("the loop guard: the 3rd crash in a row gets no note, only a notice", () => {
		expect(LOOP_GUARD_CUTOFFS).toBe(3);
		const plan = planCarryOn(
			prev({
				shutdown: undefined,
				chats: [
					chat({ sessionFile: "/s/1", cutoffs: 0, crashes: 0, planned: 0 }),
					chat({ sessionFile: "/s/2", cutoffs: 1, crashes: 1, planned: 0 }),
					chat({ sessionFile: "/s/3", cutoffs: 2, crashes: 2, planned: 0, title: "loops" }),
				],
			}),
			null,
			AT,
		);
		expect(plan.kind).toBe("crash");
		expect(plan.carry.map((i) => [i.chat.sessionFile, i.cutoffs, i.crashes, i.planned])).toEqual([
			["/s/1", 1, 1, 0],
			["/s/2", 2, 2, 0],
		]);
		expect(plan.guarded.map((g) => [g.chat.title, g.cutoffs, g.crashes, g.planned, g.why])).toEqual([
			["loops", 3, 3, 0, "crashes"],
		]);
	});

	it("planned restarts don't trip it: the note comes up to the 9th in a row, the 10th gets a notice", () => {
		expect(PLANNED_CUTOFF_CEILING).toBe(10);
		const plan = planCarryOn(
			prev({
				chats: [
					chat({ sessionFile: "/s/1", cutoffs: 2, crashes: 0, planned: 2, title: "third" }),
					chat({ sessionFile: "/s/2", cutoffs: 8, crashes: 0, planned: 8, title: "ninth" }),
					chat({ sessionFile: "/s/3", cutoffs: 9, crashes: 0, planned: 9, title: "tenth" }),
				],
			}),
			{ reason: "update abc1234 installed", at: AT - 10_000 },
			AT,
		);
		expect(plan.kind).toBe("planned");
		expect(plan.carry.map((i) => [i.chat.title, i.cutoffs, i.crashes, i.planned])).toEqual([
			["third", 3, 0, 3],
			["ninth", 9, 0, 9],
		]);
		expect(plan.carry[0].note).toContain("(update abc1234 installed)");
		expect(plan.guarded.map((g) => [g.chat.title, g.cutoffs, g.crashes, g.planned, g.why])).toEqual([
			["tenth", 10, 0, 10, "planned"],
		]);
	});

	it("crashes and planned stops are counted apart: neither adds to the other's limit", () => {
		const mixed = chat({ cutoffs: 9, crashes: 2, planned: 7, title: "mixed" });
		const planned = planCarryOn(prev({ chats: [mixed] }), null, AT);
		expect(planned.carry.map((i) => [i.cutoffs, i.crashes, i.planned])).toEqual([[10, 2, 8]]);
		expect(planned.guarded).toEqual([]);
		const crashed = planCarryOn(prev({ shutdown: undefined, chats: [mixed] }), null, AT);
		expect(crashed.carry).toEqual([]);
		expect(crashed.guarded.map((g) => [g.cutoffs, g.crashes, g.planned, g.why])).toEqual([[10, 3, 7, "crashes"]]);
	});

	it("a list an older build wrote (one count for both kinds) still reads: its count as crashes", () => {
		expect(cutoffCounts({ cutoffs: 2 })).toEqual({ cutoffs: 2, crashes: 2, planned: 0 });
		expect(cutoffCounts({ cutoffs: 3, crashes: 1, planned: 2 })).toEqual({ cutoffs: 3, crashes: 1, planned: 2 });
		expect(cutoffCounts({ cutoffs: 3, planned: 2 })).toEqual({ cutoffs: 2, crashes: 0, planned: 2 });
		expect(cutoffCounts({})).toEqual({ cutoffs: 0, crashes: 0, planned: 0 });
		expect(cutoffCounts({ cutoffs: -4 })).toEqual({ cutoffs: 0, crashes: 0, planned: 0 });
		expect(cutoffCounts({ cutoffs: "2" as unknown as number })).toEqual({ cutoffs: 0, crashes: 0, planned: 0 });
		// Cut off twice before the update: the install's own restart carries it on (a planned stop)...
		const old = prev({ chats: [chat({ cutoffs: 2 })] });
		const install = planCarryOn(old, { reason: "update abc1234 installed", at: AT }, AT);
		expect(install.carry.map((i) => [i.cutoffs, i.crashes, i.planned])).toEqual([[3, 2, 1]]);
		// ...and a crash leaves it alone, as the older build would have.
		expect(planCarryOn({ ...old, shutdown: undefined }, null, AT).guarded.map((g) => g.why)).toEqual(["crashes"]);
	});

	it("each chat once; the step from the tools or the transcript", () => {
		const plan = planCarryOn(
			prev({
				chats: [
					chat({ tools: [{ id: "t", name: "bash", detail: "make" }] }),
					chat({ title: "dup" }),
					chat({ sessionFile: "/s/b", step: "running the bash command `ls`" }),
				],
			}),
			null,
			AT,
		);
		expect(plan.carry).toHaveLength(2);
		expect(plan.carry[0].note).toContain("in the middle of running the bash command `make`;");
		expect(plan.carry[1].note).toContain("in the middle of running the bash command `ls`;");
	});

	it("no list, nothing to do", () => {
		const plan = planCarryOn(null, null, AT);
		expect(plan.carry).toEqual([]);
		expect(plan.guarded).toEqual([]);
	});
});

describe("the server log's carry-on line and the notice", () => {
	const prev = (chats: RunningChat[], shutdown = true): RunningChatsFile => ({
		v: 1,
		pid: 1,
		...(shutdown ? { shutdown: { at: AT - 5000, signal: "shutdown" } } : {}),
		chats,
	});

	it("each chat's real count of cut-offs in a row, and of which kind", () => {
		expect(cutoffWords({ cutoffs: 1, crashes: 0, planned: 1 })).toBe("cut off 1x");
		expect(cutoffWords({ cutoffs: 1, crashes: 1, planned: 0 })).toBe("cut off 1x: a crash");
		expect(cutoffWords({ cutoffs: 3, crashes: 0, planned: 3 })).toBe("cut off 3x in a row: all planned");
		expect(cutoffWords({ cutoffs: 3, crashes: 1, planned: 2 })).toBe("cut off 3x in a row: 2 planned, 1 crash");
		expect(cutoffWords({ cutoffs: 5, crashes: 2, planned: 3 })).toBe("cut off 5x in a row: 3 planned, 2 crashes");
		expect(cutoffWords({ cutoffs: 3, crashes: 3, planned: 0 })).toBe("cut off 3x in a row: all crashes");
	});

	it("last night's restart: a chat cut off by its third install in a row reads 3x, not 1x", () => {
		const plan = planCarryOn(
			prev([
				chat({ sessionFile: "/s/35", title: "Queue #35: Roles", cutoffs: 2, crashes: 0, planned: 2 }),
				chat({ sessionFile: "/s/new", title: "tooling" }),
			]),
			{ reason: "update 1a2b3c4 installed", at: AT - 10_000 },
			AT,
		);
		expect(carryOnLogLine(plan)).toBe(
			'[carry-on] restarted (update 1a2b3c4 installed): carrying on 2 chat(s): "Queue #35: Roles" (cut off 3x in a row: all planned), "tooling" (cut off 1x)',
		);
	});

	it("names the chats it left alone, with their counts", () => {
		const plan = planCarryOn(
			prev(
				[
					chat({ sessionFile: "/s/1", title: "fine" }),
					chat({ sessionFile: "/s/2", title: "loops", cutoffs: 3, crashes: 2, planned: 1 }),
				],
				false,
			),
			null,
			AT,
		);
		expect(carryOnLogLine(plan)).toBe(
			'[carry-on] restarted (it crashed or was killed): carrying on 1 chat(s): "fine" (cut off 1x: a crash); left alone: "loops" (cut off 4x in a row: 1 planned, 3 crashes)',
		);
		const none = planCarryOn(prev([chat({ title: "busy", cutoffs: 9, crashes: 0, planned: 9 })]), null, AT);
		expect(carryOnLogLine(none)).toBe(
			'[carry-on] restarted (a restart): carrying on 0 chat(s); left alone: "busy" (cut off 10x in a row: all planned)',
		);
	});

	it("the notice says which limit the chat reached", () => {
		const crashes = planCarryOn(prev([chat({ title: "loops", cutoffs: 2, crashes: 2, planned: 0 })], false), null, AT);
		expect(guardNotice(crashes.guarded[0])).toBe(
			'"loops" was cut off by 3 crashes without finishing a turn in between (pi-web-ui may be crashing because of it), so it wasn\'t told to carry on this time. Open it and tell it what to do.',
		);
		const planned = planCarryOn(prev([chat({ title: "busy", cutoffs: 9, crashes: 0, planned: 9 })]), null, AT);
		expect(guardNotice(planned.guarded[0])).toBe(
			'"busy" was cut off by 10 planned restarts without finishing a turn in between, so it wasn\'t told to carry on this time. Open it and tell it what to do.',
		);
	});
});

describe("the live list", () => {
	let dir = "";
	let file = "";
	let now = AT;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "running-chats-test-"));
		file = join(dir, "running-chats.json");
		now = AT;
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const ref = { sessionFile: "/s/a.jsonl", title: "A", cwd: "/w" };
	const onDisk = () => readRunningChatsFile(file);

	it("follows a turn: start, a tool, its end, the finish", () => {
		const list = new RunningChats(file, () => now);
		list.start(ref);
		expect(onDisk()?.chats).toEqual([{ ...ref, startedAt: AT, cutoffs: 0, crashes: 0, planned: 0, tools: [] }]);
		list.toolStart(ref, { id: "t1", name: "bash", detail: "sleep 60" });
		expect(onDisk()?.chats[0].tools).toEqual([{ id: "t1", name: "bash", detail: "sleep 60" }]);
		list.toolEnd(ref, "t1");
		expect(onDisk()?.chats[0].tools).toEqual([]);
		list.finish(ref.sessionFile);
		expect(onDisk()?.chats).toEqual([]);
		expect(onDisk()?.shutdown).toBeUndefined();
	});

	it("a shutdown freezes it: the runs the shutdown aborts stay, marked as planned", () => {
		const list = new RunningChats(file, () => now);
		list.start(ref);
		now = AT + 7000;
		list.freeze("shutdown");
		list.finish(ref.sessionFile); // the teardown aborting the run
		list.start({ ...ref, sessionFile: "/s/other" });
		const data = onDisk();
		expect(data?.shutdown).toEqual({ at: AT + 7000, signal: "shutdown" });
		expect(data?.chats.map((c) => c.sessionFile)).toEqual([ref.sessionFile]);
		expect(list.isFrozen).toBe(true);
	});

	it("a chat carried over keeps its cut-off count until a turn finishes", () => {
		const list = new RunningChats(file, () => now);
		list.seed([{ ...chat(), cutoffs: 2, awaiting: true }]);
		expect(onDisk()?.chats[0]).toMatchObject({ cutoffs: 2, awaiting: true });
		list.start(ref); // the carry-on turn starts
		expect(onDisk()?.chats[0]).toMatchObject({ cutoffs: 2 });
		expect(onDisk()?.chats[0].awaiting).toBeUndefined();
		list.finish(ref.sessionFile); // it finished: the count goes
		list.start(ref);
		expect(onDisk()?.chats[0].cutoffs).toBe(0);
	});

	/**
	 * One restart, the way the server does it (AgentService.prepareCarryOn): plan from the list the old
	 * process left, then start the new list with the chats being carried on. A planned stop freezes the
	 * old list first (its shutdown mark); a crash doesn't.
	 */
	function restart(list: RunningChats, how: "planned" | "crash") {
		if (how === "planned") list.freeze("shutdown");
		now += 60_000;
		const plan = planCarryOn(onDisk(), how === "planned" ? { reason: "update installed", at: now } : null, now);
		const next = new RunningChats(file, () => now);
		next.seed(
			plan.carry.map((i) => ({
				...i.chat,
				cutoffs: i.cutoffs,
				crashes: i.crashes,
				planned: i.planned,
				awaiting: true,
				startedAt: now,
			})),
		);
		if (plan.carry.length) next.start(ref); // its carry-on turn starts
		return { plan, list: next };
	}

	it("a long turn cut off by install after install is carried on each time, up to the 10th in a row", () => {
		let list = new RunningChats(file, () => now);
		list.start(ref);
		for (let n = 1; n < PLANNED_CUTOFF_CEILING; n++) {
			const r = restart(list, "planned");
			expect(r.plan.carry.map((i) => [i.cutoffs, i.crashes, i.planned])).toEqual([[n, 0, n]]);
			expect(r.plan.guarded).toEqual([]);
			list = r.list;
		}
		const tenth = restart(list, "planned");
		expect(tenth.plan.carry).toEqual([]);
		expect(tenth.plan.guarded.map((g) => [g.cutoffs, g.why])).toEqual([[10, "planned"]]);
		expect(onDisk()?.chats).toEqual([]);
	});

	it("crashes still stop it at the 3rd in a row, planned stops in between or not", () => {
		let list = new RunningChats(file, () => now);
		list.start(ref);
		const seen: string[] = [];
		for (const how of ["crash", "planned", "planned", "crash", "planned", "crash"] as const) {
			const r = restart(list, how);
			seen.push(r.plan.carry.length ? `${how}: note` : `${how}: notice (${r.plan.guarded[0]?.why})`);
			list = r.list;
		}
		expect(seen).toEqual([
			"crash: note",
			"planned: note",
			"planned: note",
			"crash: note",
			"planned: note",
			"crash: notice (crashes)",
		]);
	});

	it("a finished turn starts both counts over", () => {
		let list = new RunningChats(file, () => now);
		list.start(ref);
		for (const how of ["crash", "crash", "planned", "planned"] as const) list = restart(list, how).list;
		expect(onDisk()?.chats[0]).toMatchObject({ cutoffs: 4, crashes: 2, planned: 2 });
		list.finish(ref.sessionFile); // the carry-on turn finished
		list.start(ref); // a new turn
		expect(onDisk()?.chats[0]).toMatchObject({ cutoffs: 0, crashes: 0, planned: 0 });
		const r = restart(list, "crash");
		expect(r.plan.carry.map((i) => [i.cutoffs, i.crashes, i.planned])).toEqual([[1, 1, 0]]);
	});

	it("a list an older build wrote carries over: its count read as crashes, kept until a turn finishes", () => {
		writeFileSync(
			file,
			JSON.stringify({ v: 1, pid: 1, shutdown: { at: now, signal: "SIGTERM" }, chats: [{ ...chat(), cutoffs: 2 }] }),
		);
		const plan = planCarryOn(onDisk(), { reason: "update installed", at: now }, now);
		expect(plan.carry.map((i) => [i.cutoffs, i.crashes, i.planned])).toEqual([[3, 2, 1]]);
		const list = new RunningChats(file, () => now);
		list.seed(
			plan.carry.map((i) => ({
				...i.chat,
				cutoffs: i.cutoffs,
				crashes: i.crashes,
				planned: i.planned,
				awaiting: true,
			})),
		);
		list.start(ref);
		expect(onDisk()?.chats[0]).toMatchObject({ cutoffs: 3, crashes: 2, planned: 1 });
		expect(list.get(ref.sessionFile)).toMatchObject({ cutoffs: 3, crashes: 2, planned: 1 });
		expect(list.get("/s/none")).toBeUndefined();
	});

	it("a tool without a turn start we saw still puts the chat in the list", () => {
		const list = new RunningChats(file, () => now);
		list.toolStart(ref, { id: "t", name: "read" });
		expect(onDisk()?.chats.map((c) => c.sessionFile)).toEqual([ref.sessionFile]);
	});

	it("a broken or missing file reads as no list", () => {
		expect(readRunningChatsFile(file)).toBeNull();
		writeFileSync(file, "{not json");
		expect(readRunningChatsFile(file)).toBeNull();
	});

	it("pi-web-deploy's restart reason is read once", () => {
		const reasonFile = join(dir, "restart-reason.json");
		writeFileSync(reasonFile, JSON.stringify({ reason: "update abc installed", at: new Date(AT).toISOString() }));
		expect(takeRestartReason(reasonFile)).toEqual({ reason: "update abc installed", at: AT });
		expect(existsSync(reasonFile)).toBe(false);
		expect(takeRestartReason(reasonFile)).toBeNull();
		writeFileSync(reasonFile, "garbage");
		expect(takeRestartReason(reasonFile)).toBeNull();
		expect(existsSync(reasonFile)).toBe(false);
	});

	it("writes are atomic (no temp file left behind)", () => {
		const list = new RunningChats(file, () => now);
		list.start(ref);
		expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
		expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
	});
});

describe("the move from the old per-window records", () => {
	it("takes only the newest shutdown's records, each chat once", () => {
		const recs = [
			{ title: "old", cwd: "/w", at: AT - 3 * 60 * 60_000, sessionFile: "/s/old" },
			{ title: "a", cwd: "/w", at: AT - 20_000, sessionFile: "/s/a" },
			{ title: "a again", cwd: "/w", at: AT - 20_010, sessionFile: "/s/a" },
			{ title: "b", cwd: "/w", at: AT - 20_020, sessionFile: "/s/b" },
			{ title: "no file", cwd: "/w", at: AT - 20_000 },
		];
		expect(newestInterrupted(recs, AT).map((r) => r.title)).toEqual(["a", "b"]);
	});

	it("records from long ago are stale", () => {
		expect(newestInterrupted([{ title: "a", cwd: "/w", at: AT - 60 * 60_000, sessionFile: "/s/a" }], AT)).toEqual([]);
	});

	const line = (message: object) => JSON.stringify({ type: "message", id: "x", message });
	const call = (id: string, name: string, args: object) => ({ type: "toolCall", id, name, arguments: args });

	it("reads the cut-off step from the transcript's tail", () => {
		const asked = [
			line({ role: "user", content: "go" }),
			line({ role: "assistant", content: [call("c1", "bash", { command: "sleep 60" })] }),
		];
		expect(stepFromTranscriptTail(asked.join("\n"))).toBe("running the bash command `sleep 60`");
		const aborted = [
			...asked,
			line({ role: "toolResult", toolCallId: "c1", toolName: "bash", isError: true, content: [] }),
		];
		expect(stepFromTranscriptTail(aborted.join("\n"))).toBe("running the bash command `sleep 60`");
		const finished = [
			...asked,
			line({ role: "toolResult", toolCallId: "c1", toolName: "bash", isError: false, content: [] }),
		];
		expect(stepFromTranscriptTail(finished.join("\n"))).toBe("writing a reply");
		const writing = [
			line({ role: "user", content: "go" }),
			line({ role: "assistant", content: [{ type: "text", text: "Hal" }], stopReason: "aborted" }),
		];
		expect(stepFromTranscriptTail(writing.join("\n"))).toBe("writing a reply");
		expect(stepFromTranscriptTail(`{"type":"sess`)).toBe("writing a reply");
		expect(stepFromTranscriptTail([line({ role: "user", content: "hi" })].join("\n"))).toBe("writing a reply");
	});
});
