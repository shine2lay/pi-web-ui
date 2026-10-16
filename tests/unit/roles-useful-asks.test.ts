// roles-needs-you (task #200): the real Roles reader (server/roles-overview.ts, fake host, temp files)
// feeding the page's closed projection. A needs-you line leaves "Needs you" once the owner typed a reply
// or answered a dialog; an automated message doesn't count; a live dialog shows until it closes.
// Nothing here loads a chat, calls a model or writes a file the app owns.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Ask } from "../../server/asks.js";
import type { IdentityDef } from "../../server/identities.js";
import type { UiRolesOverview } from "../../server/protocol.js";
import { RolesOverviewReader, type RolesOverviewHost } from "../../server/roles-overview.js";
import { projectUsefulRoles } from "../../web/src/roles-useful-model.js";

const T0 = Date.parse("2026-10-16T14:00:00Z");
let now = T0;
let dir = "";
let sessions = "";
let n = 0;
let liveAsks: Ask[] = [];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "roles-useful-asks-"));
	sessions = join(dir, "sessions");
	mkdirSync(sessions, { recursive: true });
	now = T0 + 3_600_000;
	n = 0;
	liveAsks = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Line = Record<string, unknown>;
const iso = (ms: number) => new Date(ms).toISOString();
const id8 = () => (++n).toString(16).padStart(8, "0");
function transcript(name: string, lines: Line[]): string {
	const file = join(sessions, `${name}.jsonl`);
	const head = { type: "session", version: 3, id: name, timestamp: iso(T0), cwd: dir };
	writeFileSync(file, `${[head, ...lines].map((l) => JSON.stringify(l)).join("\n")}\n`);
	return file;
}
const append = (file: string, lines: Line[]) =>
	appendFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
const needs = (text: string, ts: number, id = id8()): Line => ({
	type: "custom",
	customType: "tldr",
	data: { v: 1, text, needsYou: true, ts },
	id,
	parentId: null,
	timestamp: iso(ts),
});
const user = (text: string, ts: number): Line => ({
	type: "message",
	id: id8(),
	parentId: null,
	timestamp: iso(ts),
	message: { role: "user", content: [{ type: "text", text }], timestamp: ts },
});
const dialogAnswer = (ts: number, isError = false): Line => ({
	type: "message",
	id: id8(),
	parentId: null,
	timestamp: iso(ts),
	message: {
		role: "toolResult",
		toolCallId: "c1",
		toolName: "ask_user_question",
		content: [{ type: "text", text: "answered" }],
		isError,
		timestamp: ts,
	},
});
/** One pi-queue entry in a queue's chat. */
const q = (op: Line, ts: number): Line => ({
	type: "custom",
	customType: "queue",
	data: { v: 1, ts, ...op },
	id: id8(),
	parentId: null,
	timestamp: iso(ts),
});
const role = (id: string, homeChat: string): IdentityDef =>
	({
		id,
		title: `${id.charAt(0).toUpperCase()}${id.slice(1)} role`,
		homeChat,
		pastHomeChats: [],
		raw: {},
		dir: join(dir, "identities", id),
		role: { config: { workMode: null, goals: null }, problems: [] },
	}) as unknown as IdentityDef;
function reader(roles: IdentityDef[]): RolesOverviewReader {
	const host: RolesOverviewHost = {
		identities: () => roles,
		chatState: () => "closed",
		asks: () => liveAsks,
		openRequestsTo: () => ({ open: 0 }),
		latestReportTo: () => undefined,
		rolePaused: () => false,
		sessionRoots: () => [sessions],
		reportRunsFile: () => join(dir, "state", "runs.json"),
		schedulerJobsFile: () => join(dir, "scheduler", "jobs.json"),
		now: () => now,
	};
	return new RolesOverviewReader(host);
}
/** The page's view of one fresh, connected snapshot, applied as a full update in this connection. */
const page = (overview: UiRolesOverview) =>
	projectUsefulRoles(
		{ status: "ready", overview, checkedAt: overview.at, heardAt: overview.at, appliedAt: overview.at },
		"open",
		overview.at,
	).needsYou;

describe("Needs you follows the real reader", () => {
	it("a needs-you line shows with its link, and leaves once the owner types a reply", async () => {
		const home = transcript("ops-home", [needs("Your call: pick a port", T0 + 1000, "line0001")]);
		const r = reader([role("ops", home)]);
		const before = page(await r.read());
		expect(before.tell).toBe("can-tell");
		expect(before.total).toBe(1);
		expect(before.items).toEqual([
			{
				key: "0",
				roleLabel: "Ops role",
				text: "Your call: pick a port",
				since: T0 + 1000,
				link: { file: home, focus: { kind: "tldr", id: "line0001" } },
			},
		]);
		// An automated message is not the owner answering.
		append(home, [user("[Queue] Task #3 is done", T0 + 2000)]);
		expect(page(await r.read()).items).toHaveLength(1);
		append(home, [user("Use 8080", T0 + 3000)]);
		now += 5000;
		const after = page(await r.read());
		expect(after).toMatchObject({ tell: "can-tell", total: 0, items: [], more: 0 });
		expect(after.asOf).toBe(now);
	});
	it("leaves once the owner answers a dialog; a cancelled dialog doesn't count", async () => {
		const home = transcript("qa-home", [needs("Need you: approve the run", T0 + 1000)]);
		const r = reader([role("qa", home)]);
		expect(page(await r.read()).items).toHaveLength(1);
		append(home, [dialogAnswer(T0 + 2000, true)]);
		expect(page(await r.read()).items).toHaveLength(1);
		append(home, [dialogAnswer(T0 + 3000)]);
		expect(page(await r.read()).items).toEqual([]);
	});
	it("a live dialog in a role's chat shows (one item with its own line), and goes when it closes", async () => {
		const home = transcript("design-home", [needs("Need you: pick a layout", T0 + 1000, "line0002")]);
		const r = reader([role("design", home)]);
		liveAsks = [
			{
				id: "q1",
				kind: "question",
				title: "Pick a layout",
				fields: [],
				createdAt: T0 + 2000,
				sessionFile: home,
			} as unknown as Ask,
		];
		const open = page(await r.read());
		expect(open.tell).toBe("can-tell");
		expect(open.items).toEqual([
			{
				key: "0",
				roleLabel: "Design role",
				text: "Need you: pick a layout",
				since: T0 + 1000,
				link: { file: home, focus: { kind: "question", id: "q1" } },
			},
		]);
		liveAsks = [];
		append(home, [dialogAnswer(T0 + 3000)]);
		expect(page(await r.read()).items).toEqual([]);
	});
	it("a stuck task's question shows; once its queue is paused the server lists none and the page can still tell", async () => {
		const taskChat = transcript("ops-task-1", []);
		const home = transcript("ops-home", [
			q({ op: "add", id: 1, plan: { title: "Pick a port" } }, T0 + 100),
			q({ op: "start", id: 1, lane: true }, T0 + 200),
			q({ op: "chat", id: 1, file: taskChat, title: "Queue #1" }, T0 + 300),
			q({ op: "stuck", id: 1, question: "Which port?" }, T0 + 400),
		]);
		const r = reader([role("ops", home)]);
		const stuck = page(await r.read());
		expect(stuck.tell).toBe("can-tell");
		expect(stuck.items).toEqual([
			{
				key: "0",
				roleLabel: "Ops role",
				text: "Which port?",
				since: T0 + 400,
				link: { file: home, focus: { kind: "task", id: "1" } },
			},
		]);
		// The owner's pause on the whole queue: the task waits on nobody, and nothing is missing.
		append(home, [q({ op: "hold", why: "Owner: wait for Monday" }, T0 + 500)]);
		expect(page(await r.read())).toMatchObject({ tell: "can-tell", total: 0, items: [] });
	});
});
