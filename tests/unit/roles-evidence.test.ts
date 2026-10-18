// roles-evidence (task #207): a working task's Completion evidence from wt's records and pi-web-deploy's,
// and how the Roles page shows it. Fixed record files in a temp folder and a fake git; no chats, models
// or writes by the code under test.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RolesEvidence, type RolesEvidencePaths } from "../../server/roles-evidence.js";
import { terminalSessionEnvPrefix } from "../../server/terminals.js";
import { exactEvidence } from "../../web/src/roles-exact-view.js";
import { evidenceOf } from "../../web/src/roles-useful-model.js";

const T = (hhmm: string) => Date.parse(`2026-10-18T${hhmm}:00.000Z`);
const iso = (hhmm: string) => new Date(T(hhmm)).toISOString();
const sha = (c: string) => c.repeat(40);
const A = sha("a");
const B = sha("b");
const C = sha("c");

let root = "";
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

function world(opts: {
	branches?: object[];
	lands?: object[];
	history?: object[];
	live?: string;
	/** outer -> the commits it contains (besides itself). */
	graph?: Record<string, string[]>;
}) {
	root = mkdtempSync(join(tmpdir(), "roles-evidence-"));
	const paths: RolesEvidencePaths = {
		wtState: join(root, "wt"),
		deployLive: join(root, "projects", "pi-web-ui"),
		deployStage: join(root, "stage"),
	};
	mkdirSync(paths.wtState, { recursive: true });
	mkdirSync(join(paths.deployLive, "dist"), { recursive: true });
	mkdirSync(paths.deployStage, { recursive: true });
	// "LIVE" in a record stands for this world's pi-web-ui main folder.
	const jsonl = (rows: object[] | undefined) =>
		(rows ?? []).map((r) => `${JSON.stringify(r).replaceAll('"LIVE"', JSON.stringify(paths.deployLive))}\n`).join("");
	if (opts.branches) writeFileSync(join(paths.wtState, "branches.jsonl"), jsonl(opts.branches));
	if (opts.lands) writeFileSync(join(paths.wtState, "lands.jsonl"), jsonl(opts.lands));
	if (opts.history) writeFileSync(join(paths.deployStage, "history.jsonl"), jsonl(opts.history));
	if (opts.live)
		writeFileSync(
			join(paths.deployLive, "dist", ".pi-web-deploy.json"),
			JSON.stringify({ commit: opts.live, action: "deploy", deployedAt: iso("12:00") }),
		);
	const asked: string[] = [];
	const ev = new RolesEvidence(
		() => paths,
		async (_repo, outer, inner) => {
			asked.push(`${outer.slice(0, 1)}>${inner.slice(0, 1)}`);
			return (opts.graph?.[outer] ?? []).includes(inner);
		},
	);
	return { paths, ev, asked };
}

const chat = (id: string) => `/s/--home--/2026-10-18T09-00-00-000Z_${id}.jsonl`;
const branch = (repo: string, name: string, at: string, ids: { session?: string; chat?: string }) => ({
	v: 1,
	at: iso(at),
	repo,
	branch: name,
	worktree: `${repo}-${name}`,
	...ids,
});
const land = (repo: string, name: string, at: string, commit: string, committed: string) => ({
	v: 1,
	at: iso(at),
	repo,
	branch: name,
	commit,
	committedAt: iso(committed),
});
const install = (commit: string, started: string, ended: string, extra: object = {}) => ({
	id: commit.slice(0, 4),
	action: "deploy",
	commit,
	result: "swapped",
	up: true,
	startedAt: iso(started),
	endedAt: iso(ended),
	checks: { at: iso(ended).replace(":00.000Z", ":45.000Z"), results: [{ name: "server", status: "pass" }] },
	...extra,
});

describe("RolesEvidence: task chat -> branch -> land -> install -> live", () => {
	it("joins a pi-web-ui task's chat to its landed commit, the install that took it in and the live build", async () => {
		const repo = "LIVE";
		const v = world({
			branches: [branch(repo, "feat", "09:00", { session: chat("aaaa1111-0000") })],
			lands: [land(repo, "feat", "10:00", A, "09:50")],
			history: [install(B, "08:00", "08:01"), install(A, "10:30", "10:31")],
			live: A,
		});
		const view = await v.ev.load();
		const e = await view.of({ file: chat("aaaa1111-0000"), status: "working" });
		expect(e).toEqual({
			repo: "pi-web-ui",
			commit: "aaaaaaaa",
			built: { at: T("09:50") },
			checked: { at: T("10:00") },
			installed: { at: T("10:31") },
			live: { at: T("10:31") + 45_000 },
			confirmed: { not: "yet" },
		});
		// Done after it went live: confirmed then.
		expect((await view.of({ file: chat("aaaa1111-0000"), status: "done", doneAt: T("11:00") })).confirmed).toEqual({
			at: T("11:00"),
		});
		// The install before the land is never asked about (it can't hold it).
		expect(v.asked).toEqual([]);
	});

	it("counts a newer install that contains the commit, skipping failed ones; the chat id alone also names the chat", async () => {
		const repo = "LIVE";
		const w = world({
			branches: [branch(repo, "feat", "09:00", { chat: "bbbb2222-0000" })],
			lands: [land(repo, "feat", "10:00", A, "09:50")],
			history: [
				install(B, "10:10", "10:11", { checks: { at: iso("10:12"), results: [{ name: "page", status: "fail" }] } }),
				install(C, "10:20", "10:21"),
			],
			live: C,
			graph: { [B]: [A], [C]: [B, A] },
		});
		const view = await w.ev.load();
		const e = await view.of({ file: chat("bbbb2222-0000"), status: "working" });
		expect(e.installed).toEqual({ at: T("10:21") });
		expect(e.live).toEqual({ at: T("10:21") + 45_000 });
		// Asked once per pair; a second read uses what git said.
		await (await w.ev.load()).of({ file: chat("bbbb2222-0000"), status: "working" });
		expect(w.asked).toEqual(["c>a"]);
	});

	it("says not yet while it isn't installed, and not live once the live build no longer contains it", async () => {
		const repo = "LIVE";
		const w = world({
			branches: [branch(repo, "feat", "09:00", { chat: "cccc3333-0000" })],
			lands: [land(repo, "feat", "10:00", A, "09:50")],
			history: [install(B, "07:00", "07:01")],
			live: B,
		});
		const e = await (await w.ev.load()).of({ file: chat("cccc3333-0000"), status: "working" });
		expect(e.checked).toEqual({ at: T("10:00") });
		expect(e.installed).toEqual({ not: "yet" });
		expect(e.live).toEqual({ not: "yet" });
		expect(e.confirmed).toEqual({ not: "yet" });
	});

	it("follows Installed and Live for pi-web-ui only: another repo says not tracked", async () => {
		const w = world({
			branches: [branch("/home/x/projects/agent-tools", "wt-records", "09:00", { chat: "dddd4444-0000" })],
			lands: [land("/home/x/projects/agent-tools", "wt-records", "10:00", A, "09:55")],
			history: [install(A, "10:30", "10:31")],
			live: A,
		});
		const e = await (await w.ev.load()).of({ file: chat("dddd4444-0000"), status: "done", doneAt: T("10:05") });
		expect(e).toEqual({
			repo: "agent-tools",
			commit: "aaaaaaaa",
			built: { at: T("09:55") },
			checked: { at: T("10:00") },
			installed: { not: "tracked" },
			live: { not: "tracked" },
			confirmed: { at: T("10:05") },
		});
		expect(w.asked).toEqual([]);
	});

	it("says not recorded for a task with no records, no chat, or no files at all", async () => {
		const none = await (await world({}).ev.load()).of({ file: chat("eeee5555-0000"), status: "working" });
		expect(Object.values(none)).toEqual(Array(5).fill({ not: "recorded" }));
		rmSync(root, { recursive: true, force: true });
		const w = world({ branches: [branch("/r/pi-web-ui", "x", "09:00", { chat: "ffff6666-0000" })] });
		const view = await w.ev.load();
		expect(Object.values(await view.of({ status: "working" }))).toEqual(Array(5).fill({ not: "recorded" }));
		// A branch with no land yet: recorded, not built yet.
		const started = await view.of({ file: chat("ffff6666-0000"), status: "working" });
		expect(started.built).toEqual({ not: "yet" });
		expect(started.installed).toEqual({ not: "tracked" });
	});

	it("never shows another task's commit: a reused branch name, a different chat, or a record naming two chats", async () => {
		const repo = "LIVE";
		const w = world({
			branches: [
				branch(repo, "fix", "08:00", { chat: "1111aaaa-0000" }),
				// Another chat makes a branch of the same name later and lands it.
				branch(repo, "fix", "09:00", { chat: "2222bbbb-0000" }),
				// A record whose ids disagree names no chat.
				branch(repo, "odd", "09:30", { session: chat("3333cccc-0000"), chat: "4444dddd-0000" }),
			],
			lands: [
				land(repo, "fix", "08:30", A, "08:20"),
				land(repo, "fix", "09:40", B, "09:35"),
				land(repo, "odd", "09:45", C, "09:44"),
			],
			live: B,
		});
		const view = await w.ev.load();
		expect((await view.of({ file: chat("1111aaaa-0000"), status: "working" })).commit).toBe("aaaaaaaa");
		expect((await view.of({ file: chat("2222bbbb-0000"), status: "working" })).commit).toBe("bbbbbbbb");
		expect((await view.of({ file: chat("3333cccc-0000"), status: "working" })).built).toEqual({ not: "recorded" });
		expect((await view.of({ file: chat("4444dddd-0000"), status: "working" })).built).toEqual({ not: "recorded" });
		expect((await view.of({ file: chat("5555eeee-0000"), status: "working" })).built).toEqual({ not: "recorded" });
	});
});

describe("the Completion evidence row", () => {
	const now = T("12:00");
	it("shows times in the design's done style, not yet in its pending style, and missing records plainly", () => {
		const e = evidenceOf({
			repo: "agent-tools",
			commit: "aaaaaaaa",
			built: { at: T("09:55") },
			checked: { at: Date.parse("2026-10-17T10:00:00Z") },
			installed: { not: "tracked" },
			live: { not: "tracked" },
			confirmed: { not: "yet" },
		});
		const row = exactEvidence(e, now);
		expect(row.map((s) => s.label)).toEqual(["Built", "Checked", "Installed", "Live", "Confirmed"]);
		expect(row[0]).toMatchObject({ fg: "#9FD8B8", bs: "solid" });
		expect(row[0].at).toMatch(/^\d\d:\d\d$/);
		expect(row[1].at).toMatch(/^Oct 1[67], \d\d:\d\d$/);
		expect(row[2]).toMatchObject({ at: "Not tracked for agent-tools", bs: "dashed", fg: "#C7B8FF" });
		expect(row[4]).toMatchObject({ at: "not yet", fg: "#A9AEB6", bs: "dashed" });
		// No evidence (an older server, no task, or a malformed step): every step says not recorded.
		for (const missing of [undefined, evidenceOf({ built: { at: 1 } }), evidenceOf({ built: "x" })])
			expect(exactEvidence(missing, now).map((s) => s.at)).toEqual(Array(5).fill("Not recorded"));
	});

	it("gives a terminal-mode bash command the chat's id and transcript, unsetting what it can't say", () => {
		const sm = (id: unknown, file: unknown) => ({
			sessionManager: { getSessionId: () => id, getSessionFile: () => file },
		});
		expect(terminalSessionEnvPrefix(sm("abc", "/s/it's.jsonl"))).toBe(
			"export PI_SESSION_ID='abc'; export PI_SESSION_FILE='/s/it'\\''s.jsonl'; ",
		);
		expect(terminalSessionEnvPrefix(sm("abc", undefined))).toBe("export PI_SESSION_ID='abc'; unset PI_SESSION_FILE; ");
		expect(terminalSessionEnvPrefix(undefined)).toBe("");
	});
});
