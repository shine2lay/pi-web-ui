// roles-overview: the Roles page's reader (server/roles-overview.ts): every role's state from disk, with a
// fake host. Nothing here loads a chat, calls a model or writes a file the app owns.
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Ask } from "../../server/asks.js";
import type { IdentityDef } from "../../server/identities.js";
import type { RoleGoal, WorkMode } from "../../server/identity-config.js";
import type { UiRolesOverview } from "../../server/protocol.js";
import { RoleMessages } from "../../server/role-messages.js";
import { RULES_GOALS, rulesGoals, rulesWorkMode } from "../../server/role-rules.js";
import {
	ChatPaths,
	lineKind,
	reportJobOf,
	reportRunsOf,
	reportSections,
	ROLES_REPORT_MAX,
	RolesOverviewReader,
	type RolesOverviewHost,
	RolesWatch,
	roleWorkMode,
	statusOf,
	TranscriptScans,
} from "../../server/roles-overview.js";

const T0 = Date.parse("2026-10-05T14:00:00Z");
const MIN = 60_000;
let now = T0 + 60 * MIN;
let dir = "";
let sessions = "";
let n = 0;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "roles-unit-"));
	sessions = join(dir, "sessions");
	mkdirSync(sessions, { recursive: true });
	now = T0 + 60 * MIN;
	n = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ---- transcripts ---------------------------------------------------------------------------------------
type Line = Record<string, unknown>;
const iso = (ms: number) => new Date(ms).toISOString();
const id8 = () => (++n).toString(16).padStart(8, "0");

function transcript(name: string, lines: Line[] = []): string {
	const file = join(sessions, `${name}.jsonl`);
	const head = { type: "session", version: 3, id: name, timestamp: iso(T0), cwd: dir };
	writeFileSync(file, `${[head, ...lines].map((l) => JSON.stringify(l)).join("\n")}\n`);
	return file;
}
function append(file: string, lines: Line[]): void {
	appendFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}
const tldr = (text: string, ts: number, extra: Record<string, unknown> = {}): Line => ({
	type: "custom",
	customType: "tldr",
	data: { v: 1, text, needsYou: false, ts, ...extra },
	id: id8(),
	parentId: null,
	timestamp: iso(ts),
});
const needs = (text: string, ts: number, extra: Record<string, unknown> = {}) =>
	tldr(text, ts, { needsYou: true, ...extra });
const user = (text: string, ts: number): Line => ({
	type: "message",
	id: id8(),
	parentId: null,
	timestamp: iso(ts),
	message: { role: "user", content: [{ type: "text", text }], timestamp: ts },
});
const assistant = (text: string, ts: number, more: unknown[] = []): Line => ({
	type: "message",
	id: id8(),
	parentId: null,
	timestamp: iso(ts),
	message: { role: "assistant", content: [...more, { type: "text", text }], timestamp: ts, stopReason: "stop" },
});
const toolResult = (toolName: string, text: string, ts: number): Line => ({
	type: "message",
	id: id8(),
	parentId: null,
	timestamp: iso(ts),
	message: {
		role: "toolResult",
		toolCallId: "c1",
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: ts,
	},
});
const plan = (title: string) => ({
	title,
	goal: "g",
	doneWhen: "d",
	decided: "x",
	steps: "s",
	verify: "v",
	mustNot: "m",
});
const queue = (op: Record<string, unknown>, ts = T0): Line => ({
	type: "custom",
	customType: "queue",
	data: { v: 1, ts, ...op },
	id: id8(),
	parentId: null,
	timestamp: iso(ts),
});

// ---- roles and the host ----------------------------------------------------------------------------------
const role = (
	id: string,
	homeChat?: string,
	config: { workMode?: WorkMode | null; goals?: RoleGoal[] | null } = {},
): IdentityDef =>
	({
		id,
		title: id.charAt(0).toUpperCase() + id.slice(1),
		homeChat,
		pastHomeChats: [],
		raw: {},
		dir: join(dir, "identities", id),
		role: { config: { workMode: config.workMode ?? null, goals: config.goals ?? null }, problems: [] },
	}) as unknown as IdentityDef;

interface Fake {
	host: RolesOverviewHost;
	roles: IdentityDef[];
	state: Map<string, "working" | "idle" | "closed">;
	asks: Ask[];
	requests: Map<string, ReturnType<RolesOverviewHost["openRequestsTo"]>>;
	reports: Map<string, ReturnType<RolesOverviewHost["latestReportTo"]>>;
	paused: boolean;
	runs: string;
	jobs: string;
}
function fake(roles: IdentityDef[]): Fake {
	const f: Fake = {
		roles,
		state: new Map(),
		asks: [],
		requests: new Map(),
		reports: new Map(),
		paused: false,
		runs: join(dir, "state", "role-reports", "runs.json"),
		jobs: join(dir, "scheduler", "jobs.json"),
		host: {
			identities: () => f.roles,
			chatState: (file) => f.state.get(file) ?? "closed",
			asks: () => f.asks,
			openRequestsTo: (r) => f.requests.get(r) ?? { open: 0 },
			latestReportTo: (r) => f.reports.get(r),
			rolePaused: () => f.paused,
			sessionRoots: () => [sessions],
			reportRunsFile: () => f.runs,
			schedulerJobsFile: () => f.jobs,
			now: () => now,
		},
	};
	return f;
}
const read = (f: Fake) => new RolesOverviewReader(f.host).read();
const byId = (o: UiRolesOverview, id: string) => {
	const r = o.roles.find((x) => x.id === id);
	if (!r) throw new Error(`no role ${id}`);
	return r;
};
const ask = (o: Partial<Ask> & { id: string; sessionFile: string; createdAt: number }): Ask =>
	({ kind: "question", title: "A question", fields: [], ...o }) as Ask;

// ---------------------------------------------------------------------------------------------------------
describe("the roles, from disk", () => {
	it("lists every role alphabetically, with no chat loaded, and keeps what a closed chat showed", async () => {
		const z = transcript("zeta", [tldr("Zeta did a thing", T0 + MIN)]);
		const a = transcript("alpha", [tldr("Alpha started", T0 + 2 * MIN), tldr("Alpha checked it", T0 + 3 * MIN)]);
		const f = fake([role("zeta", z), role("mid"), role("alpha", a)]);
		const o = await read(f);
		expect(o.roles.map((r) => r.id)).toEqual(["alpha", "mid", "zeta"]);
		expect(byId(o, "alpha").tldr.map((l) => l.text)).toEqual(["Alpha checked it", "Alpha started"]);
		expect(byId(o, "alpha").tldr[0].chat).toEqual({ file: a, where: "home" });
		expect(byId(o, "alpha").status).toBe("idle");
		expect(byId(o, "mid").status).toBe("nothing-yet");
		expect(o.reportTz).toBe("America/Los_Angeles");
		// A second reader (the app restarted, every chat still closed) shows the same.
		const again = await read(f);
		expect({ ...again, at: 0 }).toEqual({ ...o, at: 0 });
	});

	it("has a fixed state order: needs you > busy > paused > idle > nothing yet", async () => {
		expect(statusOf({ asks: 1, busy: true, paused: true, something: true })).toBe("needs-you");
		expect(statusOf({ asks: 0, busy: true, paused: true, something: true })).toBe("busy");
		expect(statusOf({ asks: 0, busy: false, paused: true, something: true })).toBe("paused");
		expect(statusOf({ asks: 0, busy: false, paused: false, something: true })).toBe("idle");
		expect(statusOf({ asks: 0, busy: false, paused: false, something: false })).toBe("nothing-yet");

		const needy = transcript("needy", [needs("Pick a port", T0 + MIN)]);
		const busy = transcript("busy", [tldr("Working on it", T0 + MIN)]);
		const paused = transcript("paused", [
			tldr("Queued two", T0),
			queue({ op: "add", id: 1, plan: plan("One") }),
			queue({ op: "add", id: 2, plan: plan("Two") }),
			queue({ op: "run" }),
			queue({ op: "pause", reason: "user" }),
		]);
		const busyPaused = transcript("busy-paused", [
			queue({ op: "add", id: 1, plan: plan("One") }),
			queue({ op: "add", id: 2, plan: plan("Two") }),
			queue({ op: "run" }),
			queue({ op: "start", id: 1 }),
			queue({ op: "pause", reason: "user" }),
		]);
		const stoppedEmpty = transcript("stopped-empty", [
			tldr("All done", T0),
			queue({ op: "add", id: 1, plan: plan("One") }),
			queue({ op: "start", id: 1 }),
			queue({ op: "done", id: 1, summary: "ok" }),
			queue({ op: "pause", reason: "user" }),
		]);
		const f = fake([
			role("needy", needy),
			role("busy", busy),
			role("paused", paused),
			role("busypaused", busyPaused),
			role("stopped", stoppedEmpty),
			role("none"),
		]);
		f.state.set(needy, "working");
		f.state.set(busy, "working");
		const o = await read(f);
		expect(byId(o, "needy").status).toBe("needs-you");
		expect(byId(o, "busy").status).toBe("busy");
		expect(byId(o, "busy").homeBusy).toBe(true);
		expect(byId(o, "paused").status).toBe("paused");
		expect(byId(o, "paused").queue?.counts).toEqual({ active: 0, queued: 2, done: 0 });
		expect(byId(o, "paused").queue?.pausedReason).toBe("user");
		// a working task beats a stopped queue
		expect(byId(o, "busypaused").status).toBe("busy");
		// a stopped queue with nothing left to do is idle, not paused
		expect(byId(o, "stopped").status).toBe("idle");
		expect(byId(o, "none").status).toBe("nothing-yet");
	});
});

describe("what waits on the owner", () => {
	it("lists every distinct ask oldest first with its real start, folds copies and leaves out tasks asking their main chat", async () => {
		// Task 5's chat got stuck (the owner has to answer); task 6 asks its main chat (not the owner).
		const t5 = transcript("task5", [tldr("Task 5 started", T0 + MIN), needs("Which database?", T0 + 4 * MIN)]);
		const t6 = transcript("task6", [needs("Main chat: which name?", T0 + 6 * MIN)]);
		const home = transcript("home", [
			needs("Old question", T0),
			user("Here is my answer", T0 + 30_000),
			queue({ op: "add", id: 5, plan: plan("Five") }, T0 + MIN),
			queue({ op: "add", id: 6, plan: plan("Six") }, T0 + MIN),
			queue({ op: "run" }, T0 + MIN),
			queue({ op: "start", id: 5, lane: true }, T0 + MIN),
			queue({ op: "chat", id: 5, file: t5, title: "Task 5" }, T0 + MIN),
			queue({ op: "start", id: 6, lane: true }, T0 + MIN),
			queue({ op: "chat", id: 6, file: t6, title: "Task 6" }, T0 + MIN),
			queue({ op: "stuck", id: 5, question: "Which database: Postgres or SQLite?" }, T0 + 5 * MIN),
			queue({ op: "ask", id: 6, n: 1, question: "Which name?", ts: T0 + 6 * MIN }, T0 + 6 * MIN),
			// the queue chat's copies of the task chats' lines
			needs("Which database?", T0 + 5 * MIN, { chat: { file: t5, title: "Task 5" } }),
			needs("Main chat: which name?", T0 + 6 * MIN, { chat: { file: t6, title: "Task 6" } }),
			// two distinct asks of its own
			needs("Pick a port", T0 + 10 * MIN),
			needs("Approve the plan", T0 + 20 * MIN),
		]);
		const f = fake([role("arch", home)]);
		// the chat opened a question box for the second one, 2 s after its line
		f.asks.push(ask({ id: "q1", sessionFile: home, createdAt: T0 + 20 * MIN + 2000, title: "Approve?" }));
		// a stuck ask from the hub (its time is when it was found, not when it started): not used
		f.asks.push(ask({ id: "s1", kind: "stuck", sessionFile: home, createdAt: now }));
		const o = await read(f);
		const r = byId(o, "arch");
		expect(r.asks.map((a) => [a.kind, a.text, a.since])).toEqual([
			["task", "Which database: Postgres or SQLite?", T0 + 5 * MIN],
			["tldr", "Pick a port", T0 + 10 * MIN],
			["question", "Approve the plan", T0 + 20 * MIN],
		]);
		expect(r.asks.map((a) => a.focus)).toEqual(["task:5", expect.stringMatching(/^tldr:/), "question:q1"]);
		// the task's ask is answered in the queue's chat, about task 5
		expect(r.asks[0].chat).toEqual({ file: home, where: 5 });
		expect(r.status).toBe("needs-you");
		expect(o.asks.map((a) => a.key)).toEqual(r.asks.map((a) => a.key));
		// TL;DR keeps the task chats' own lines once (the queue chat's copies are left out)
		const texts = r.tldr.map((l) => `${l.chat.where}:${l.text}`);
		expect(texts.filter((t) => t.endsWith("Which database?"))).toEqual(["5:Which database?"]);
		expect(texts.filter((t) => t.endsWith("which name?"))).toEqual(["6:Main chat: which name?"]);
		expect(r.queue?.active.map((t) => [t.id, t.status])).toEqual([
			[5, "stuck"],
			[6, "asking"],
		]);
	});

	it("puts every role's asks on one oldest-first list, unknown starts last", async () => {
		const a = transcript("a", [needs("A asks", T0 + 9 * MIN)]);
		const b = transcript("b", [needs("B asks", T0 + 2 * MIN), needs("B asks again", T0 + 30 * MIN)]);
		const c = transcript("c", [needs("C asks, no time", 0)]);
		const f = fake([role("aa", a), role("bb", b), role("cc", c)]);
		const o = await read(f);
		expect(o.asks.map((x) => x.text)).toEqual(["B asks", "A asks", "B asks again", "C asks, no time"]);
		expect(o.asks.at(-1)?.since).toBeUndefined();
	});

	it("closes an ask once the owner answered, however long the chat is", async () => {
		const lines: Line[] = [];
		for (let i = 0; i < 300; i++) lines.push(tldr(`step ${i}`, T0 + i * 1000), assistant(`did ${i}`, T0 + i * 1000));
		const home = transcript("long", [...lines, needs("Need you: pick one", T0 + 400_000)]);
		const f = fake([role("long", home)]);
		const reader = new RolesOverviewReader(f.host);
		expect((await reader.read()).asks).toHaveLength(1);
		append(home, [user("Pick the first one", T0 + 401_000)]);
		const after = await reader.read();
		expect(after.asks).toHaveLength(0);
		expect(byId(after, "long").tldr[0]).toMatchObject({ text: "Need you: pick one", answered: true });
	});
});

describe("reading transcripts", () => {
	it("reads only what was added, and a file rewritten in place again from the start", async () => {
		const file = transcript("grow", [tldr("one", T0)]);
		const scans = new TranscriptScans();
		const first = await scans.read(file);
		expect(first.tldr).toHaveLength(1);
		// A changed file costs its first bytes (at most 256, to notice a rewrite) plus what was added.
		const head = (size: number) => Math.min(256, size);
		const size1 = statSync(file).size;
		expect(scans.bytesRead).toBe(head(size1) + size1);
		append(file, [tldr("two", T0 + 1000), assistant("x".repeat(5000), T0 + 2000)]);
		const second = await scans.read(file);
		expect(second.tldr).toHaveLength(2);
		const size2 = statSync(file).size;
		expect(scans.bytesRead).toBe(head(size1) + size1 + head(size2) + (size2 - size1));
		// unchanged: nothing read
		const before = scans.bytesRead;
		await scans.read(file);
		expect(scans.bytesRead).toBe(before);
		// rewritten (shorter, other start): read again from the start
		writeFileSync(
			file,
			`${JSON.stringify({ type: "session", version: 3, id: "other" })}\n${JSON.stringify(tldr("new", T0))}\n`,
		);
		const third = await scans.read(file);
		expect(third.tldr.map((e) => (e.data as { text: string }).text)).toEqual(["new"]);
	});

	it("tells lines apart by their first bytes", () => {
		expect(lineKind(JSON.stringify(tldr("x", 1)).slice(0, 512))).toBe("tldr");
		expect(lineKind(JSON.stringify(queue({ op: "run" })).slice(0, 512))).toBe("queue");
		expect(lineKind(JSON.stringify(user("hi", 1)).slice(0, 512))).toBe("user");
		expect(lineKind(JSON.stringify(toolResult("ask_user_question", "a", 1)).slice(0, 512))).toBe("replyTool");
		expect(lineKind(JSON.stringify(toolResult("bash", "a", 1)).slice(0, 512))).toBeNull();
		expect(lineKind(JSON.stringify(assistant("a", 1)).slice(0, 512))).toBeNull();
	});

	it("reads only plain transcripts inside the session folders: no traversal, symlinks or other files", async () => {
		const good = transcript("good", [tldr("fine", T0)]);
		const outside = join(dir, "outside.jsonl");
		writeFileSync(outside, `${JSON.stringify(tldr("SECRET-OUTSIDE", T0))}\n`);
		const link = join(sessions, "link.jsonl");
		symlinkSync(outside, link);
		mkdirSync(join(dir, "elsewhere"));
		const linkedDir = join(sessions, "linked");
		symlinkSync(join(dir, "elsewhere"), linkedDir);
		writeFileSync(join(dir, "elsewhere", "x.jsonl"), `${JSON.stringify(tldr("SECRET-LINKED-DIR", T0))}\n`);
		const notJsonl = join(sessions, "notes.txt");
		writeFileSync(notJsonl, "x");
		const paths = new ChatPaths(() => [sessions]);
		expect(await paths.check(good)).toBe(good);
		for (const bad of [
			outside,
			link,
			join(linkedDir, "x.jsonl"),
			notJsonl,
			`${sessions}/../outside.jsonl`,
			`${sessions}//good.jsonl`,
			"good.jsonl",
			`${good}\0`,
			join(sessions, "missing.jsonl"),
			sessions,
			42,
			null,
		]) {
			expect(await paths.check(bad)).toBeNull();
		}
		const f = fake([role("linky", link), role("outer", `${sessions}/../outside.jsonl`), role("good", good)]);
		const o = await read(f);
		expect(JSON.stringify(o)).not.toMatch(/SECRET-/);
		expect(byId(o, "linky").problems).toEqual(["home chat"]);
		expect(byId(o, "linky").tldr).toEqual([]);
		expect(byId(o, "outer").problems).toEqual(["home chat"]);
		expect(byId(o, "good").problems).toBeUndefined();
	});

	it("sends no thinking, tool calls, tool results, prompts or other entries: only TL;DR lines and queue facts", async () => {
		const home = transcript("canary", [
			user("CANARY-PROMPT the owner's words", T0),
			assistant("CANARY-ANSWER visible text", T0 + 1000, [
				{ type: "thinking", thinking: "CANARY-THINKING" },
				{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo CANARY-TOOLARG" } },
			]),
			toolResult("bash", "CANARY-RESULT sk-ant-CANARY-SECRET", T0 + 2000),
			{ type: "custom", customType: "identity", data: { v: 1, id: "x", note: "CANARY-CUSTOM" } },
			{ type: "custom_message", customType: "role-message", content: [{ type: "text", text: "CANARY-NOTE" }] },
			{ type: "model_change", provider: "CANARY-PROVIDER", modelId: "m" },
			tldr("Visible line", T0 + 3000),
		]);
		const f = fake([role("canary", home)]);
		const json = JSON.stringify(await read(f));
		expect(json).toContain("Visible line");
		expect(json).not.toMatch(/CANARY/);
	});
});

describe("the 6 am report", () => {
	const DAY = "2026-10-04";
	function reportChat(name: string, id: string, answer: string, extra: Line[] = []): string {
		return transcript(name, [
			user(`[Role message ${id} from the app · 6 am report · ${DAY}]\nPlease report.`, T0),
			assistant("CANARY-WORKING-NOTE", T0 + 1000, [{ type: "thinking", thinking: "CANARY-REPORT-THINKING" }]),
			toolResult("read", "CANARY-REPORT-TOOL", T0 + 1500),
			assistant(answer, T0 + 2000),
			...extra,
		]);
	}
	const report = (body: string) =>
		[
			"## Goal",
			`Goal ${body}`,
			"## Yesterday",
			"Built it.",
			"## Learnings",
			"Small is fast, so we ship small.",
			"## Next",
			"Ship it.",
		].join("\n");
	function runsFile(f: Fake, runs: unknown[]): void {
		mkdirSync(join(dir, "state", "role-reports"), { recursive: true });
		writeFileSync(f.runs, JSON.stringify({ v: 1, runs }));
	}
	function jobsFile(f: Fake, jobs: unknown[]): void {
		mkdirSync(join(dir, "scheduler"), { recursive: true });
		writeFileSync(f.jobs, JSON.stringify({ jobs }));
	}
	const replied = (id: string, target: string, answered = true) => ({
		id,
		date: DAY,
		at: T0,
		state: "replied" as const,
		target,
		scanFrom: 0,
		reply: { at: T0 + 3000, answered, headings: answered, missing: [] as string[], chars: 100 },
	});

	it("shows the whole answer under its four headings, and every reason there is none", async () => {
		const long = "y".repeat(3900);
		const chat = reportChat("rep", "rm-00000001", report(long));
		const f = fake([
			role("rep", chat),
			role("idle"),
			role("ops"),
			role("broken"),
			role("waiting"),
			role("silent"),
			role("moved"),
			role("later"),
		]);
		runsFile(f, [
			{
				runId: "r1",
				date: DAY,
				at: T0,
				active: { rep: {}, broken: {}, waiting: {}, silent: {}, moved: {} },
				inactive: ["idle"],
				skipped: {},
				sent: {
					rep: { id: "rm-00000001" },
					broken: { error: "the chat couldn't be opened" },
					waiting: { id: "rm-00000003" },
					silent: { id: "rm-00000004" },
					moved: { id: "rm-00000005" },
				},
			},
		]);
		f.reports.set("rep", replied("rm-00000001", chat));
		f.reports.set("waiting", { id: "rm-00000003", date: DAY, at: T0, state: "delivered", target: chat, scanFrom: 0 });
		f.reports.set("silent", replied("rm-00000004", chat, false));
		f.reports.set("moved", replied("rm-00000005", join(dir, "outside.jsonl")));
		const o = await read(f);
		const rep = byId(o, "rep").report;
		expect(rep.state).toBe("report");
		expect(rep.sections?.map((s) => s.heading)).toEqual(["Goal", "Yesterday", "Learnings", "Next"]);
		expect(rep.sections?.[0].text).toBe(`Goal ${long}`);
		expect(rep.cut).toBeUndefined();
		expect(rep.chat).toEqual({ file: chat });
		expect(rep.messageAt).toBe(T0 + 2000);
		expect(JSON.stringify(rep)).not.toMatch(/CANARY/);
		expect(byId(o, "idle").report).toMatchObject({ state: "not-active", date: DAY });
		expect(byId(o, "ops").report).toEqual({ state: "not-in-job" });
		expect(byId(o, "broken").report).toMatchObject({ state: "failed", error: "the chat couldn't be opened" });
		expect(byId(o, "waiting").report).toMatchObject({ state: "pending", date: DAY });
		expect(byId(o, "silent").report).toMatchObject({ state: "no-answer" });
		expect(byId(o, "moved").report).toMatchObject({ state: "unavailable" });
		// a role the run never named, with a newer request of its own, shows that request
		f.reports.set("later", { id: "rm-00000009", date: "2026-10-05", at: now, state: "held" });
		expect(byId(await read(f), "later").report).toMatchObject({ state: "pending", date: "2026-10-05" });
	});

	it("says when the first one comes, and cuts only a very long answer", async () => {
		const f = fake([role("fresh"), role("huge")]);
		jobsFile(f, [{ id: "j1", target: "role-reports run", enabled: true, nextRunAt: T0 + 16 * 60 * MIN }]);
		expect(byId(await read(f), "fresh").report).toEqual({ state: "first", next: T0 + 16 * 60 * MIN });
		const chat = reportChat("huge", "rm-0000000a", report("z".repeat(ROLES_REPORT_MAX + 500)));
		f.roles = [role("huge", chat)];
		f.reports.set("huge", replied("rm-0000000a", chat));
		const rep = byId(await read(f), "huge").report;
		expect(rep.state).toBe("report");
		expect(rep.cut).toBe(true);
		expect(rep.sections?.[0].text.endsWith("…")).toBe(true);
		expect(rep.sections?.reduce((s, x) => s + x.text.length, 0)).toBeLessThanOrEqual(ROLES_REPORT_MAX + 1);
	});

	it("reads the job's files strictly", () => {
		expect(reportRunsOf(null)).toEqual([]);
		expect(
			reportRunsOf({
				runs: [
					{ date: "bad", at: 1 },
					{ date: DAY, at: 2, inactive: ["a", 3] },
				],
			}),
		).toEqual([{ date: DAY, at: 2, active: [], inactive: ["a"], skipped: [], sent: {} }]);
		expect(reportJobOf({ jobs: [{ target: "role-reports run", enabled: false }] })).toBeNull();
		expect(reportJobOf({ jobs: [{ target: "echo role-reports runner" }] })).toBeNull();
		expect(reportJobOf({ jobs: [{ target: "role-reports run", nextRunAt: 5 }] })).toEqual({ nextRunAt: 5 });
		expect(reportSections("no headings")).toBeNull();
		expect(reportSections("## Next\nShip\n## goal or hypothesis\nG")).toEqual([
			{ heading: "Next", text: "Ship" },
			{ heading: "Goal or hypothesis", text: "G" },
		]);
		// today's headings (any case), and the ones asked for before 2026-10-06 still read
		expect(reportSections("## Goal\nG\n## yesterday\nY\n## Learnings\nL\n## Next\nN\n## Learned\nOld")).toEqual([
			{ heading: "Goal", text: "G" },
			{ heading: "Yesterday", text: "Y" },
			{ heading: "Learnings", text: "L" },
			{ heading: "Next", text: "N" },
			{ heading: "Learned", text: "Old" },
		]);
	});
});

describe("work mode and goals", () => {
	it("falls back to the every-chat rules read-only, and only the owner's fields override them", () => {
		expect(rulesWorkMode("product")).toBe("self-start");
		expect(rulesWorkMode("design")).toBe("self-start");
		expect(rulesWorkMode("qa")).toBe("self-start");
		for (const id of ["ops", "temper", "backend", "architecture", "someone-new"]) {
			expect(rulesWorkMode(id)).toBe("request-only");
		}
		expect(rulesGoals("architecture").map((g) => g.name)).toHaveLength(2);
		expect(rulesGoals("ops")).toEqual([]);
		expect(Object.keys(RULES_GOALS)).toEqual(["architecture"]);

		const legacy = roleWorkMode("architecture", { workMode: null, goals: null }, now);
		expect(legacy).toMatchObject({ workMode: "request-only", workModeFrom: "rules", goalsFrom: "rules" });
		expect(legacy.goals).toHaveLength(2);
		expect(legacy.conflict).toBeUndefined();

		const own = roleWorkMode(
			"backend",
			{
				workMode: "self-start",
				goals: [
					{ name: "Speed up builds", scope: "the CI cache", approvedAt: "2026-10-01" },
					{ name: "Old one", scope: "done", approvedAt: "2026-09-01", endsAt: "2026-10-01" },
				],
			},
			now,
		);
		expect(own.workMode).toBe("self-start");
		expect(own.workModeFrom).toBe("owner");
		expect(own.goals.map((g) => g.name)).toEqual(["Speed up builds"]);
		// a setting the rules don't allow is shown as a conflict, not granted
		expect(own.conflict).toMatch(/rules still decide/);
		// the owner's empty list replaces the rules' goals
		expect(roleWorkMode("architecture", { workMode: null, goals: [] }, now).goals).toEqual([]);
	});

	it("shows them on the page for every role, unknown roles working on request", async () => {
		const f = fake([role("architecture"), role("product"), role("newbie")]);
		const o = await read(f);
		expect(byId(o, "architecture").goals.map((g) => g.name)).toEqual(RULES_GOALS.architecture.map((g) => g.name));
		expect(byId(o, "product").workMode).toBe("self-start");
		expect(byId(o, "newbie")).toMatchObject({ workMode: "request-only", goals: [] });
	});
});

describe("twenty roles, many tasks", () => {
	it("stays bounded: queued tasks and TL;DR lines are capped, counts stay whole", async () => {
		const lines: Line[] = [queue({ op: "run" })];
		for (let i = 1; i <= 45; i++) lines.push(queue({ op: "add", id: i, plan: plan(`Task ${i}`) }));
		for (let i = 1; i <= 10; i++)
			lines.push(queue({ op: "start", id: i, lane: true }), queue({ op: "done", id: i, summary: "ok" }));
		for (let i = 0; i < 60; i++) lines.push(tldr(`line ${i}`, T0 + i * 1000));
		const roles: IdentityDef[] = [];
		for (let i = 0; i < 20; i++) {
			const id = `role-${String(i).padStart(2, "0")}`;
			roles.push(role(id, transcript(id, lines)));
		}
		const f = fake(roles);
		const o = await read(f);
		expect(o.roles).toHaveLength(20);
		const r = o.roles[0];
		expect(r.queue?.counts).toEqual({ active: 0, queued: 35, done: 10 });
		expect(r.queue?.queued).toHaveLength(20);
		expect(r.tldr).toHaveLength(20);
		expect(r.tldr[0].text).toBe("line 59");
		expect(JSON.stringify(o).length).toBeLessThan(400_000);
	});
});

describe("open requests and reports come from the whole store", () => {
	it("counts a request older than the last 100 messages until it is answered", () => {
		const file = join(dir, "data", "role-messages.json");
		mkdirSync(join(dir, "data"), { recursive: true });
		const msg = (i: number, extra: Record<string, unknown>) => ({
			id: `rm-${i.toString(16).padStart(8, "0")}`,
			at: T0 + i * 1000,
			from: { role: "product", title: "Product", chat: "home chat", file: "/x.jsonl" },
			to: { role: "ops", title: "Ops" },
			kind: "fyi",
			chain: 0,
			text: `message ${i}`,
			state: "delivered",
			sends: 1,
			attempts: 1,
			...extra,
		});
		const messages = [msg(1, { kind: "request", text: "Please fix the backup\nmore detail" })];
		for (let i = 2; i <= 160; i++) messages.push(msg(i, {}));
		writeFileSync(file, JSON.stringify({ v: 1, paused: false, messages }));
		const host = {
			roles: () => [],
			chatState: () => "closed" as const,
			deliver: async () => ({ ok: true as const }),
			note: async () => ({ ok: true as const }),
			log: () => {},
		};
		const store = new RoleMessages(file, host);
		try {
			expect(store.rows().length).toBeLessThanOrEqual(100);
			expect(store.rows().some((r) => r.id === "rm-00000001")).toBe(false);
			expect(store.openRequestsTo("ops")).toEqual({
				open: 1,
				newest: {
					id: "rm-00000001",
					from: "Product",
					kind: "request",
					firstLine: "Please fix the backup",
					at: T0 + 1000,
				},
			});
			expect(store.openRequestsTo("product")).toEqual({ open: 0 });
		} finally {
			store.stop();
		}
		// answered: closed
		messages[0] = msg(1, { kind: "request", replyId: "rm-000000ff", state: "replied" });
		writeFileSync(file, JSON.stringify({ v: 1, paused: false, messages }));
		const again = new RoleMessages(file, host);
		try {
			expect(again.openRequestsTo("ops")).toEqual({ open: 0 });
		} finally {
			again.stop();
		}
	});
});

describe("pushing it", () => {
	const overview = (asks: number, text = "x"): UiRolesOverview => ({
		at: now,
		roles: [],
		asks: Array.from({ length: asks }, (_, i) => ({
			key: `r:tldr:${i}`,
			role: "r",
			kind: "tldr" as const,
			text,
			chat: { file: "/f.jsonl", where: "home" as const },
			focus: `tldr:${i}`,
		})),
		paused: false,
		reportTz: "America/Los_Angeles",
	});

	it("sends the page everything, a top bar only the count, and only when something changed", async () => {
		let next = overview(2);
		let reads = 0;
		const watch = new RolesWatch<string>(async () => {
			reads++;
			return { ...next, at: now };
		});
		const page: unknown[] = [];
		const bar: unknown[] = [];
		watch.watch("page", true, (m) => page.push(m));
		watch.watch("bar", false, (m) => bar.push(m));
		await watch.look();
		expect(page).toEqual([expect.objectContaining({ type: "roles", asks: 2, overview: expect.anything() })]);
		expect(bar).toEqual([{ type: "roles", asks: 2 }]);
		// nothing changed: nothing sent (until the heartbeat)
		await watch.look();
		expect(page).toHaveLength(1);
		now += 31_000;
		await watch.look();
		expect(page.at(-1)).toEqual({ type: "roles", asks: 2, checkedAt: now });
		expect(bar).toHaveLength(1);
		// a change: the page gets it all, the bar only a new count
		next = overview(2, "changed");
		await watch.look();
		expect(page.at(-1)).toMatchObject({ overview: { asks: [{ text: "changed" }, { text: "changed" }] } });
		expect(bar).toHaveLength(1);
		next = overview(3);
		await watch.look();
		expect(bar.at(-1)).toEqual({ type: "roles", asks: 3 });
		// a late window gets what is known at once
		const late: unknown[] = [];
		watch.watch("late", true, (m) => late.push(m));
		expect(late[0]).toMatchObject({ type: "roles", asks: 3, overview: expect.anything() });
		// errors go to pages (with the last count); nothing is read with no one watching
		const before = reads;
		watch.drop("page");
		watch.drop("bar");
		watch.drop("late");
		await watch.look();
		expect(reads).toBe(before);
		watch.stop();
	});

	it("tells an open page why it couldn't look, and keeps the count", async () => {
		let fail = false;
		const watch = new RolesWatch<string>(
			async () => {
				if (fail) throw new Error("disk trouble");
				return overview(1);
			},
			{ log: () => {} },
		);
		const page: unknown[] = [];
		watch.watch("page", true, (m) => page.push(m));
		await watch.look();
		fail = true;
		await watch.look();
		expect(page.at(-1)).toEqual({ type: "roles", asks: 1, error: "disk trouble" });
		watch.stop();
	});
});

describe("nothing is changed", () => {
	it("leaves every transcript and the job's files exactly as they were", async () => {
		const home = transcript("still", [needs("Pick", T0), queue({ op: "add", id: 1, plan: plan("One") })]);
		const f = fake([role("still", home)]);
		mkdirSync(join(dir, "scheduler"), { recursive: true });
		writeFileSync(f.jobs, JSON.stringify({ jobs: [{ target: "role-reports run", nextRunAt: 1 }] }));
		const before = [home, f.jobs].map((p) => [readFileSync(p, "utf8"), statSync(p).mtimeMs]);
		await read(f);
		await read(f);
		expect([home, f.jobs].map((p) => [readFileSync(p, "utf8"), statSync(p).mtimeMs])).toEqual(before);
	});
});
