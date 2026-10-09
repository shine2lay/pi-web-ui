/**
 * decision-records (task #83): the store (server/decision-records.ts), each live hook (role message sent,
 * Board post, the owner's answer, the queue scanner), the initiative tag, and the backfill on fixtures.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AskHub, dialogAnswersOf, dialogAsk, questionAsk, stuckAsk, type Ask } from "../../server/asks.js";
import {
	answerRecord,
	backfill,
	boardRecord,
	checkInitiative,
	dayStart,
	DecisionRecords,
	messageRecord,
	parseDeliveredRoleMessage,
	planRecord,
	QueueScanner,
	readLinesFrom,
	recordId,
	type TaskInitiatives,
} from "../../server/decision-records.js";
import type { IdentityDef } from "../../server/identities.js";
import { RoleBoard, type BoardHost } from "../../server/role-board.js";
import { makeBoardTool } from "../../server/board-tool.js";
import { makeMessageRoleTool } from "../../server/role-message-tool.js";
import {
	RoleMessages,
	roleMessageText,
	type RoleMessageHost,
	type RoleMessageRecord,
	type RoleMessageSender,
} from "../../server/role-messages.js";

let dir = "";
let now = Date.parse("2026-10-09T19:00:00Z");
const clock = () => now;
const stops: Array<{ stop(): void }> = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "decisions-unit-"));
	now = Date.parse("2026-10-09T19:00:00Z");
});
afterEach(() => {
	for (const s of stops.splice(0)) s.stop();
	rmSync(dir, { recursive: true, force: true });
});

const role = (id: string, homeChat?: string): IdentityDef =>
	({ id, title: id, homeChat, pastHomeChats: [], raw: {}, dir: join(dir, id) }) as unknown as IdentityDef;

function chat(name: string): string {
	const file = join(dir, `${name}.jsonl`);
	writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: name, cwd: dir })}\n`);
	return file;
}
const line = (file: string, e: unknown): void => appendFileSync(file, `${JSON.stringify(e)}\n`);
const queue = (
	file: string,
	data: Record<string, unknown>,
	at = now,
	id = "e" + Math.random().toString(16).slice(2, 9),
) =>
	line(file, {
		type: "custom",
		customType: "queue",
		id,
		parentId: null,
		timestamp: new Date(at).toISOString(),
		data: { v: 1, ts: at, ...data },
	});
const PLAN = {
	title: "Decisions page",
	goal: "collect",
	doneWhen: "kept",
	decided: "jsonl",
	steps: "1. do",
	verify: "tests",
	mustNot: "no model",
};

describe("the store", () => {
	it("appends one line per record, dedupes by source and ref, and reads them back after a restart", () => {
		const d = join(dir, "decisions");
		const s = new DecisionRecords(d, { now: clock });
		const rec = { source: "board" as const, at: now, from: "owner", ref: "bp-1", title: "t", text: "x" };
		expect(s.append(rec)).toBe(true);
		expect(s.append({ ...rec, text: "changed" })).toBe(false);
		expect(s.append({ ...rec, source: "message" })).toBe(true);
		const again = new DecisionRecords(d, { now: clock });
		expect(again.append(rec)).toBe(false);
		expect(again.has("board", "bp-1")).toBe(true);
		const lines = readFileSync(join(d, "records.jsonl"), "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		const first = JSON.parse(lines[0]!);
		expect(first).toMatchObject({ v: 1, id: recordId("board", "bp-1"), how: "live", seen: now, text: "x" });
	});

	it("ends a line a crash cut off instead of gluing the next record to it", () => {
		const d = join(dir, "decisions");
		mkdirSync(d, { recursive: true });
		const ok = JSON.stringify({
			v: 1,
			id: "x",
			source: "board",
			at: 1,
			from: "owner",
			ref: "bp-1",
			how: "live",
			seen: 1,
		});
		writeFileSync(join(d, "records.jsonl"), `${ok}\n{"v":1,"source":"bo`);
		const s = new DecisionRecords(d);
		expect(s.append({ source: "board", at: 2, from: "owner", ref: "bp-2" })).toBe(true);
		expect(s.list().map((r) => r.ref)).toEqual(["bp-1", "bp-2"]);
	});

	it("lists by time, source and initiative, oldest first, and counts per day and source", () => {
		const s = new DecisionRecords(join(dir, "decisions"));
		const t = Date.parse("2026-10-05T19:00:00Z");
		s.append({ source: "message", at: t + 2, from: "ops", ref: "rm-2", initiative: "team" });
		s.append({ source: "message", at: t + 1, from: "ops", ref: "rm-1" });
		s.append({ source: "plan", at: t + 86_400_000, from: "ops", ref: "f:3", initiative: "team" });
		expect(s.list().map((r) => r.ref)).toEqual(["rm-1", "rm-2", "f:3"]);
		expect(s.list({ initiative: "team" }).map((r) => r.ref)).toEqual(["rm-2", "f:3"]);
		expect(s.list({ source: "plan" }).map((r) => r.ref)).toEqual(["f:3"]);
		expect(s.list({ since: t + 2, until: t + 3 }).map((r) => r.ref)).toEqual(["rm-2"]);
		const c = s.counts();
		expect(Object.values(c)).toEqual([{ message: 2 }, { plan: 1 }]);
		expect(dayStart("2026-10-03")).toBe(new Date(2026, 9, 3).getTime());
		expect(dayStart("Oct 3")).toBeUndefined();
	});
});

describe("the initiative tag", () => {
	it("takes a short id, none, or refuses with how to write one", () => {
		expect(checkInitiative(undefined)).toEqual({ ok: true });
		expect(checkInitiative("  ")).toEqual({ ok: true, value: "" });
		expect(checkInitiative(" team-in-temper ")).toEqual({ ok: true, value: "team-in-temper" });
		expect(checkInitiative("Team In Temper")).toMatchObject({ ok: false, error: expect.stringContaining("lowercase") });
		expect(checkInitiative("a".repeat(61))).toMatchObject({ ok: false });
		expect(checkInitiative(7)).toMatchObject({ ok: false });
	});
});

// ---------------------------------------------------------------------------
// Hook 1: a role message, when it is sent
// ---------------------------------------------------------------------------

function messages(store: DecisionRecords): { s: RoleMessages; A: string; B: string } {
	const A = chat("alpha-home");
	const B = chat("beta-home");
	const host: RoleMessageHost = {
		roles: () => [role("alpha", A), role("beta", B)],
		chatState: () => "closed",
		deliver: async () => ({ ok: true }),
		note: async () => ({ ok: true }),
		sent: (r) => store.append(messageRecord(r)),
		initiativeOf: (id) => store.messageInitiativeOf(id),
		log: () => {},
	};
	const s = new RoleMessages(join(dir, "data", "role-messages.json"), host, clock);
	stops.push(s);
	return { s, A, B };
}
const sender = (r: string, file: string): RoleMessageSender => ({
	role: r,
	title: r,
	chat: "home chat",
	file,
	handling: 0,
});

describe("hook: role message sent", () => {
	it("keeps each sent message at once, with its initiative; a reply without one takes its original's", () => {
		const store = new DecisionRecords(join(dir, "decisions"));
		const { s, A, B } = messages(store);
		const q = s.send(sender("alpha", A), {
			to: "beta",
			kind: "question",
			text: "Which store?",
			initiative: "decisions-page",
		});
		if (!q.ok) throw new Error(q.error);
		expect(q.record.initiative).toBe("decisions-page");
		const r = s.send(sender("beta", B), { to: "alpha", kind: "reply", replyTo: q.record.id, text: "jsonl" });
		if (!r.ok) throw new Error(r.error);
		const kept = store.list({ source: "message" });
		expect(kept).toHaveLength(2);
		expect(kept[0]).toMatchObject({
			ref: q.record.id,
			from: "alpha",
			to: "beta",
			kind: "question",
			text: "Which store?",
			initiative: "decisions-page",
			how: "live",
		});
		expect(kept[1]).toMatchObject({
			ref: r.record.id,
			kind: "reply",
			replyTo: q.record.id,
			initiative: "decisions-page",
		});
		expect(s.rows()[0]?.initiative).toBe("decisions-page");
	});

	it("refuses a bad initiative (nothing sent, nothing kept), and keeps no report requests", () => {
		const store = new DecisionRecords(join(dir, "decisions"));
		const { s, A } = messages(store);
		expect(s.send(sender("alpha", A), { to: "beta", kind: "fyi", text: "x", initiative: "Big Plan!" })).toMatchObject({
			ok: false,
			error: expect.stringContaining("isn't a short id"),
		});
		expect(s.rows()).toHaveLength(0);
		expect(store.list()).toHaveLength(0);
	});

	it("message_role passes the initiative through and shows it in its result", async () => {
		const store = new DecisionRecords(join(dir, "decisions"));
		const { s, A } = messages(store);
		const tool = makeMessageRoleTool({ service: () => s, sender: () => sender("alpha", A) });
		const params = (tool.parameters as { properties: Record<string, unknown> }).properties;
		expect(params.initiative).toBeDefined();
		const res = await (
			tool.execute as unknown as (
				id: string,
				p: Record<string, unknown>,
			) => Promise<{ details: { id: string; initiative?: string } }>
		)("call", { to: "beta", kind: "fyi", text: "Store is live.", initiative: "decisions-page" });
		expect(res.details.initiative).toBe("decisions-page");
		expect(store.list()[0]).toMatchObject({ ref: res.details.id, initiative: "decisions-page" });
	});
});

// ---------------------------------------------------------------------------
// Hook 2: a Board post
// ---------------------------------------------------------------------------

function board(store: DecisionRecords): RoleBoard {
	const host: BoardHost = {
		roles: () => [role("alpha", chat("a-home")), role("beta", chat("b-home"))],
		roleStates: async () => new Map(),
		steer: async () => false,
		chatState: () => "idle",
		deliver: async () => ({ ok: true }),
		posted: (p) => store.append(boardRecord(p)),
		log: () => {},
	};
	const b = new RoleBoard(join(dir, "data", "role-board.json"), host, clock);
	stops.push(b);
	return b;
}

describe("hook: Board post", () => {
	it("keeps a news post and an owner's order relayed by a role (from owner, via the role), with the initiative", async () => {
		const store = new DecisionRecords(join(dir, "decisions"));
		const b = board(store);
		const news = await b.post(
			{ role: "alpha" },
			{ kind: "news", to: ["all"], title: "Store live", text: "jsonl", initiative: "decisions-page" },
		);
		if (!news.ok) throw new Error(news.error);
		const order = await b.post(
			{ role: "alpha" },
			{ kind: "order", to: ["beta"], title: "Pause", text: "pause it", ownerWords: "Owner 10:00: pause it" },
		);
		if (!order.ok) throw new Error(order.error);
		const kept = store.list({ source: "board" });
		expect(kept).toHaveLength(2);
		expect(kept[0]).toMatchObject({
			ref: news.post.id,
			from: "alpha",
			kind: "news",
			title: "Store live",
			initiative: "decisions-page",
		});
		expect(kept[1]).toMatchObject({
			ref: order.post.id,
			from: "owner",
			via: "alpha",
			ownerWords: "Owner 10:00: pause it",
		});
		expect(news.post.initiative).toBe("decisions-page");
	});

	it("refuses a bad initiative; the board tool takes the param and shows it on the post", async () => {
		const store = new DecisionRecords(join(dir, "decisions"));
		const b = board(store);
		expect(
			await b.post(
				{ role: "alpha" },
				{ kind: "news", to: ["all"], title: "t", text: "x", initiative: "no spaces please" },
			),
		).toMatchObject({
			ok: false,
		});
		expect(store.list()).toHaveLength(0);
		const tool = makeBoardTool({ service: () => b, sender: () => sender("alpha", join(dir, "a-home.jsonl")) });
		const params = (tool.parameters as { properties: Record<string, unknown> }).properties;
		expect(params.initiative).toBeDefined();
		const run = tool.execute as unknown as (
			id: string,
			p: Record<string, unknown>,
		) => Promise<{ content: { text: string }[] }>;
		await run("c1", {
			action: "post",
			kind: "news",
			to: ["all"],
			title: "Tagged",
			text: "x",
			initiative: "decisions-page",
		});
		expect(store.list()[0]).toMatchObject({ title: "Tagged", initiative: "decisions-page" });
		const read = await run("c2", { action: "read", id: store.list()[0]!.ref });
		expect(read.content[0]!.text).toContain("Initiative: decisions-page");
	});
});

// ---------------------------------------------------------------------------
// Hook 3: the owner's answer
// ---------------------------------------------------------------------------

describe("hook: the owner's answer", () => {
	const meta = { conversationId: "c1", conversationTitle: "Build the Roles page", sessionFile: "/s/main.jsonl" };

	it("an answered event carries what was picked and typed, and becomes an answer record keyed by the tool call", () => {
		const hub = new AskHub();
		const seen: Ask[] = [];
		const kept = new DecisionRecords(join(dir, "decisions"));
		hub.on((ev) => {
			if (ev.type !== "answered") return;
			seen.push(ev.ask);
			kept.append(answerRecord(ev.ask, { summary: ev.summary, from: ev.from, answers: ev.answers }, now, "ops")!);
		});
		const ask: Ask = {
			...questionAsk(
				"q-1",
				[
					{
						id: "store",
						question: "Where do records go?",
						options: [
							{ label: "jsonl", description: "append-only" },
							{ label: "sqlite", description: "a db" },
						],
					},
				],
				meta,
				now,
			),
			toolCallId: "toolu_1",
		};
		hub.add(ask, () => ({ ok: true }));
		hub.settle("q-1", {
			how: "answered",
			summary: "jsonl",
			from: "browser",
			answers: [{ id: "store", selected: ["jsonl"], text: "and no cap" }],
		});
		expect(seen).toHaveLength(1);
		expect(kept.list()[0]).toMatchObject({
			source: "answer",
			ref: "ask:toolu_1",
			from: "owner",
			to: "ops",
			ask: "question",
			chat: "Build the Roles page",
			file: "main.jsonl",
			answeredIn: "browser",
			questions: [
				{
					id: "store",
					question: "Where do records go?",
					options: [
						{ label: "jsonl", description: "append-only" },
						{ label: "sqlite", description: "a db" },
					],
					picked: ["jsonl"],
					typed: "and no cap",
				},
			],
		});
	});

	it("a pop-up and a queued task's question become records; approvals don't", () => {
		const dlg = dialogAsk(
			"dlg-7",
			{ id: "7", kind: "select", title: "Approve the plan?", args: [["Approve", "Reject"]] } as never,
			meta,
		);
		const rec = answerRecord(
			dlg,
			{ summary: "Approve", from: "telegram", answers: dialogAnswersOf({ kind: "select" } as never, "Approve") },
			now,
		);
		expect(rec).toMatchObject({ ask: "dialog", answeredIn: "telegram", questions: [{ picked: ["Approve"] }] });
		expect(rec!.ref).toMatch(/^dlg:main\.jsonl:dlg-7@/);
		const stuck = stuckAsk(
			"stuck-1",
			{ taskId: 83, taskTitle: "Decisions", question: "Which way?", choices: ["A", "B"] },
			meta,
		);
		const s = answerRecord(stuck, { summary: "my own words", from: "browser" }, now);
		expect(s).toMatchObject({ ask: "stuck", task: 83, questions: [{ picked: [], typed: "my own words" }] });
		expect(answerRecord(stuck, { summary: "A", from: "browser" }, now)!.questions![0]!.picked).toEqual(["A"]);
		expect(answerRecord({ ...stuck, kind: "approval" }, { summary: "yes", from: "browser" }, now)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Hook 4: the queue scanner
// ---------------------------------------------------------------------------

describe("hook: queue plans (scanner)", () => {
	it("keeps add/update/done after it started, reads only what is new, follows the initiative, refs = file:line", async () => {
		const root = join(dir, "sessions");
		mkdirSync(join(root, "--home--"), { recursive: true });
		const file = join(root, "--home--", "main.jsonl");
		writeFileSync(file, `${JSON.stringify({ type: "session" })}\n`);
		queue(file, { op: "add", id: 1, plan: PLAN }, now - 60_000); // before the scanner started: the backfill's
		const store = new DecisionRecords(join(dir, "decisions"));
		const scanner = new QueueScanner(store, {
			root: () => root,
			statePath: join(dir, "decisions", "scan-state.json"),
			roleOf: async (files) => new Map(files.map((f) => [f, "ops"])),
			chatOf: () => "Build the Roles page",
			now: clock,
		});
		expect(await scanner.scan()).toBe(0);
		now += 1000;
		queue(file, { op: "add", id: 2, plan: PLAN, approval: "auto", initiative: "decisions-page" });
		queue(file, { op: "start", id: 2 });
		queue(file, { op: "update", id: 2, plan: { ...PLAN, goal: "collect all" }, approval: "dialog" });
		expect(await scanner.scan()).toBe(2);
		queue(file, { op: "update", id: 2, initiative: "" });
		queue(file, { op: "done", id: 2, summary: "kept" });
		// a restart: a new scanner reads the saved offsets
		const again = new QueueScanner(store, {
			root: () => root,
			statePath: join(dir, "decisions", "scan-state.json"),
			roleOf: async (files) => new Map(files.map((f) => [f, "ops"])),
			now: clock,
		});
		expect(await again.scan()).toBe(2);
		expect(await again.scan()).toBe(0);
		const plans = store.list({ source: "plan" });
		expect(plans.map((p) => [p.ref, p.op, p.approval, p.initiative])).toEqual([
			["main.jsonl:3", "add", "auto", "decisions-page"],
			["main.jsonl:5", "update", "dialog", "decisions-page"],
			["main.jsonl:6", "update", undefined, undefined],
			["main.jsonl:7", "done", undefined, undefined],
		]);
		expect(plans[0]).toMatchObject({ from: "ops", task: 2, chat: "Build the Roles page", plan: PLAN });
		expect(plans[3]).toMatchObject({ summary: "kept" });
	});

	it("reads a file again from the start when it was replaced, and keeps a half-written line for later", async () => {
		const file = chat("x");
		const seen: number[] = [];
		writeFileSync(file, `${JSON.stringify({ a: "queue" })}\n{"half":"queue`);
		const r = await readLinesFrom(file, 0, 0, ["queue"], (_t, n) => {
			seen.push(n);
		});
		expect(seen).toEqual([1]);
		expect(r.line).toBe(1);
		appendFileSync(file, `"}\n`);
		const r2 = await readLinesFrom(file, r.offset, r.line, ["queue"], (t, n) => {
			seen.push(n);
			expect(JSON.parse(t)).toEqual({ half: "queue" });
		});
		expect(seen).toEqual([1, 2]);
		expect(r2.line).toBe(2);
	});

	it("planRecord skips other queue ops", () => {
		const inits: TaskInitiatives = {};
		expect(planRecord({ data: { op: "start", id: 3 } }, { file: "/a/b.jsonl", line: 4, inits })).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

describe("backfill", () => {
	it("fills from role-messages.json, role-board.json and the transcripts; a second run adds nothing", async () => {
		const day = Date.parse("2026-10-04T19:00:00Z");
		const data = join(dir, "data");
		mkdirSync(data, { recursive: true });
		const msg = (id: string, at: number, extra: Partial<RoleMessageRecord> = {}): RoleMessageRecord =>
			({
				id,
				at,
				from: { role: "data", title: "Data", chat: "home chat", file: "/x" },
				to: { role: "ops" },
				kind: "request",
				text: `text ${id}`,
				chain: 1,
				state: "delivered",
				...extra,
			}) as unknown as RoleMessageRecord;
		writeFileSync(
			join(data, "role-messages.json"),
			JSON.stringify({
				v: 1,
				messages: [
					msg("rm-0000000a", day),
					msg("rm-0000000b", day, { kind: "report" } as never),
					msg("rm-00000old", Date.parse("2026-10-01T19:00:00Z")),
				],
			}),
		);
		writeFileSync(
			join(data, "role-board.json"),
			JSON.stringify({
				v: 1,
				posts: [
					{
						id: "bp-00000001",
						seq: 1,
						at: day,
						from: "owner",
						via: "coo",
						kind: "order",
						to: ["ops"],
						title: "T",
						text: "X",
						ownerWords: "W",
					},
				],
			}),
		);
		const root = join(dir, "sessions");
		mkdirSync(join(root, "--home--"), { recursive: true });
		const ops = join(root, "--home--", "ops.jsonl");
		const dataChat = join(root, "--home--", "data.jsonl");
		writeFileSync(ops, `${JSON.stringify({ type: "session" })}\n`);
		writeFileSync(dataChat, `${JSON.stringify({ type: "session" })}\n`);
		const ts = (t: number) => new Date(t).toISOString();
		// ops' chat: a queue plan, an ask_user_question and its answer, a message_role call and result,
		// and a delivered copy of a message whose sender's side isn't anywhere (older than role-messages.json)
		queue(ops, { op: "add", id: 5, plan: PLAN, approval: "dialog" }, day);
		line(ops, {
			type: "message",
			timestamp: ts(day + 1),
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "toolu_q",
						name: "ask_user_question",
						arguments: {
							questions: [
								{ id: "q", question: "Store?", options: [{ label: "jsonl", description: "d" }, { label: "db" }] },
							],
						},
					},
				],
			},
		});
		line(ops, {
			type: "message",
			timestamp: ts(day + 2),
			message: {
				role: "toolResult",
				toolCallId: "toolu_q",
				toolName: "ask_user_question",
				content: [{ type: "text", text: "x" }],
				details: { answers: [{ id: "q", selected: ["jsonl"] }] },
				timestamp: day + 2,
			},
		});
		line(ops, {
			type: "message",
			timestamp: ts(day + 3),
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "toolu_m",
						name: "message_role",
						arguments: { to: "data", kind: "fyi", text: "done", initiative: "decisions-page" },
					},
				],
			},
		});
		line(ops, {
			type: "message",
			timestamp: ts(day + 4),
			message: {
				role: "toolResult",
				toolCallId: "toolu_m",
				toolName: "message_role",
				content: [{ type: "text", text: "Sent" }],
				details: { id: "rm-000000c1", to: "data", kind: "fyi" },
				timestamp: day + 4,
			},
		});
		const delivered = roleMessageText({
			id: "rm-000000d1",
			from: { role: "data", title: "Data & analytics", chat: "Queue #12", file: "" },
			kind: "question",
			text: "Can you keep them?\n\nThanks.",
		});
		line(ops, {
			type: "message",
			timestamp: ts(day + 5),
			message: { role: "user", content: [{ type: "text", text: delivered }], timestamp: day + 5 },
		});
		// the same message, delivered as a note in another chat later: only the earliest copy counts
		line(dataChat, {
			type: "custom_message",
			customType: "role-message",
			content: [{ type: "text", text: delivered }],
			timestamp: ts(day + 9),
		});
		// an fyi that only ever arrived as a note (what pi writes for a message added without a turn)
		const fyi = roleMessageText({
			id: "rm-000000e1",
			from: { role: "ops", title: "ops/tooling", chat: "home chat", file: "" },
			kind: "fyi",
			text: "Store path is live.",
		});
		line(dataChat, {
			type: "custom_message",
			customType: "role-message",
			content: [{ type: "text", text: fyi }],
			display: true,
			timestamp: ts(day + 10),
		});

		const store = new DecisionRecords(join(dir, "decisions"));
		const src = {
			root,
			roleMessagesFile: join(data, "role-messages.json"),
			roleBoardFile: join(data, "role-board.json"),
			roleOf: async (files: string[]) => new Map(files.map((f) => [f, basename(f, ".jsonl")])),
		};
		const from = Date.parse("2026-10-03T07:00:00Z");
		const p = await backfill(store, src, from, "2026-10-03");
		expect(p).toMatchObject({
			running: false,
			filesTotal: 2,
			added: { message: 4, board: 1, answer: 1, plan: 1, files: 2 },
		});
		const byRef = new Map(store.list().map((r) => [r.ref, r]));
		expect(byRef.has("rm-0000000b")).toBe(false);
		expect(byRef.has("rm-00000old")).toBe(false);
		expect(byRef.get("rm-0000000a")).toMatchObject({ how: "backfill", from: "data", to: "ops" });
		expect(byRef.get("bp-00000001")).toMatchObject({ from: "owner", via: "coo", ownerWords: "W" });
		expect(byRef.get("ops.jsonl:2")).toMatchObject({ source: "plan", op: "add", approval: "dialog", from: "ops" });
		expect(byRef.get("ask:toolu_q")).toMatchObject({
			source: "answer",
			to: "ops",
			lines: "3->4",
			questions: [{ picked: ["jsonl"] }],
		});
		expect(byRef.get("rm-000000c1")).toMatchObject({
			from: "ops",
			to: "data",
			kind: "fyi",
			text: "done",
			initiative: "decisions-page",
		});
		expect(byRef.get("rm-000000d1")).toMatchObject({
			from: "data",
			to: "ops",
			kind: "question",
			text: "Can you keep them?\n\nThanks.",
			atIs: "delivered",
			at: day + 5,
			chat: "Queue #12",
		});
		expect(byRef.get("rm-000000e1")).toMatchObject({
			from: "ops",
			to: "data",
			kind: "fyi",
			text: "Store path is live.",
			at: day + 10,
		});
		const second = await backfill(store, src, from, "2026-10-03");
		expect(second.added).toMatchObject({ message: 0, board: 0, answer: 0, plan: 0 });
	});

	it("reads a delivered copy's header, kind and text (without the hint line)", () => {
		const text = roleMessageText({
			id: "rm-0123abcd",
			from: { role: "architecture", title: "System architecture", chat: "home chat", file: "" },
			kind: "reply",
			replyTo: "rm-00000001",
			text: "Carries.",
		});
		expect(parseDeliveredRoleMessage(text)).toEqual({
			id: "rm-0123abcd",
			from: "architecture",
			chat: "home chat",
			kind: "reply",
			replyTo: "rm-00000001",
			text: "Carries.",
		});
		expect(parseDeliveredRoleMessage("hello")).toBeUndefined();
	});
});
