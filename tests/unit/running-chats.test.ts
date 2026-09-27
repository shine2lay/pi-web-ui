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
	carryOnNote,
	describeStep,
	newestInterrupted,
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

	it("the loop guard: the 3rd cut-off in a row gets no note", () => {
		const plan = planCarryOn(
			prev({
				chats: [
					chat({ sessionFile: "/s/1", cutoffs: 0 }),
					chat({ sessionFile: "/s/2", cutoffs: 1 }),
					chat({ sessionFile: "/s/3", cutoffs: 2, title: "loops" }),
				],
			}),
			null,
			AT,
		);
		expect(plan.carry.map((i) => [i.chat.sessionFile, i.cutoffs])).toEqual([
			["/s/1", 1],
			["/s/2", 2],
		]);
		expect(plan.guarded.map((c) => c.title)).toEqual(["loops"]);
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
		expect(onDisk()?.chats).toEqual([{ ...ref, startedAt: AT, cutoffs: 0, tools: [] }]);
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
