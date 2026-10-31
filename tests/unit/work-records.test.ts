/**
 * roles-panel: the work registry's initiatives and projects as the Roles page reads them
 * (pi-work-management's events.jsonl, replayed by server/work-records.ts).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PI_QUEUE_READERS_KEY } from "../../server/pi-queue-readers.js";
import {
	WORK_LOG_MAX,
	WORK_RECORDS_SEND_MAX,
	WorkRecordsFile,
	workFolder,
	workProjectOf,
	workRecordsFrom,
} from "../../server/work-records.js";

let seq = 0;
const line = (e: Record<string, unknown>) => JSON.stringify({ v: 1, seq: ++seq, ts: 1000 + seq, by: "ops", ...e });
const log = (...events: Record<string, unknown>[]) => events.map(line).join("\n") + "\n";

const initiative = (id: string, extra: Record<string, unknown> = {}) => ({
	op: "initiative.create",
	id,
	name: `Initiative ${id}`,
	outcome: "Something worth having",
	doneWhen: ["First thing works", "Second thing works"],
	lead: "architecture",
	...extra,
});
const project = (id: string, extra: Record<string, unknown> = {}) => ({
	op: "project.create",
	id,
	name: `Project ${id}`,
	outcome: "A deliverable",
	doneWhen: ["It ships"],
	lead: "ops",
	initiative: null,
	...extra,
});

describe("workRecordsFrom", () => {
	it("recognises wait/resume without changing the Roles page's records (#284)", () => {
		const before = [initiative("team"), project("p")];
		const waits = ["project.wait", "project.resume", "initiative.wait", "initiative.resume"].map((op) => ({
			op,
			id: op.startsWith("project.") ? "p" : "team",
			until: Date.now() + 3600_000,
			why: "after the next review",
		}));
		const raw = log(...before);
		expect(workRecordsFrom(raw + log(...waits))).toEqual(workRecordsFrom(raw));
	});
	it("an empty log has nothing and no problem", () => {
		expect(workRecordsFrom("")).toEqual({ initiatives: [], projects: [] });
	});

	// Security's review of 2cadd193, note 2: what the server sends stays bounded by the store's own rules.
	it("records and changes the store could never have written are skipped and said", () => {
		const r = workRecordsFrom(
			log(
				initiative("Not An Id"),
				initiative("long-name", { name: "x".repeat(81) }),
				initiative("two-lines", { name: "One\nTwo" }),
				initiative("bad-lead", { lead: "../ops" }),
				project("bad-parent", { initiative: "Team In Temper" }),
				initiative("fine"),
				{
					op: "initiative.change",
					id: "fine",
					changes: { name: "y".repeat(81), lead: "Ops Team", status: "paused" },
				},
			),
		);
		expect(r).toEqual({
			initiatives: [{ id: "fine", name: "Initiative fine", lead: "architecture", status: "active", items: 2, met: 0 }],
			projects: [],
			problem: "unknown-change",
		});
		// At the store's limits exactly, it's kept.
		const edge = workRecordsFrom(log(initiative("a".repeat(60), { name: "n".repeat(80), lead: "owner" })));
		expect(edge.problem).toBeUndefined();
		expect(edge.initiatives[0]?.lead).toBe("owner");
	});

	it("sends at most WORK_RECORDS_SEND_MAX records, initiatives first, and says there were more", () => {
		const many = Array.from({ length: WORK_RECORDS_SEND_MAX }, (_, i) => initiative(`i-${i}`));
		const over = workRecordsFrom(log(...many, project("p")));
		expect(over.initiatives).toHaveLength(WORK_RECORDS_SEND_MAX);
		expect(over.projects).toEqual([]);
		expect(over.problem).toBe("too-big");
		const exact = workRecordsFrom(log(...many));
		expect(exact.initiatives).toHaveLength(WORK_RECORDS_SEND_MAX);
		expect(exact.problem).toBeUndefined();
	});

	it("creates initiatives and projects with their lead, initiative and done-when count", () => {
		const r = workRecordsFrom(log(initiative("team"), project("roles-page", { initiative: "team" }), project("solo")));
		expect(r).toEqual({
			initiatives: [{ id: "team", name: "Initiative team", lead: "architecture", status: "active", items: 2, met: 0 }],
			projects: [
				{
					id: "roles-page",
					name: "Project roles-page",
					lead: "ops",
					status: "active",
					initiative: "team",
					items: 1,
					met: 0,
				},
				{ id: "solo", name: "Project solo", lead: "ops", status: "active", initiative: null, items: 1, met: 0 },
			],
		});
	});

	it("met and unmet count items by their text, ignoring case and outer spaces", () => {
		const r = workRecordsFrom(
			log(
				initiative("team"),
				{ op: "initiative.met", id: "team", item: "  first THING works ", proof: "commit abc" },
				{ op: "initiative.met", id: "team", item: "Second thing works", proof: "test run" },
				{ op: "initiative.unmet", id: "team", item: "second thing works", reason: "it broke" },
			),
		);
		expect(r.initiatives[0]).toMatchObject({ items: 2, met: 1 });
		expect(r.problem).toBeUndefined();
	});

	it("change merges fields; a new done-when list keeps only marks of items still listed", () => {
		const r = workRecordsFrom(
			log(
				initiative("team"),
				project("p", { initiative: "team" }),
				{ op: "initiative.met", id: "team", item: "First thing works", proof: "x" },
				{ op: "initiative.met", id: "team", item: "Second thing works", proof: "y" },
				{
					op: "initiative.change",
					id: "team",
					changes: { name: "Team work", lead: "owner", doneWhen: ["first thing works", "A third thing"] },
				},
				{ op: "project.change", id: "p", changes: { initiative: null, status: "dropped" } },
			),
		);
		expect(r.initiatives[0]).toEqual({
			id: "team",
			name: "Team work",
			lead: "owner",
			status: "active",
			items: 2,
			met: 1,
		});
		expect(r.projects[0]).toMatchObject({ initiative: null, status: "dropped" });
	});

	it("an old single-text done when reads as one item", () => {
		const r = workRecordsFrom(log(project("p", { doneWhen: "It ships" })));
		expect(r.projects[0]).toMatchObject({ items: 1, met: 0 });
	});

	it("task links and task states are the queues' business: skipped without a problem", () => {
		const r = workRecordsFrom(
			log(
				project("p"),
				{ op: "task.link", task: { file: "/x.jsonl", id: 3 }, project: "p" },
				{ op: "task.state", task: { file: "/x.jsonl", id: 3 }, status: "done" },
			),
		);
		expect(r.projects).toHaveLength(1);
		expect(r.problem).toBeUndefined();
	});

	it("a change it doesn't know is skipped and said, never guessed", () => {
		for (const odd of [
			{ op: "initiative.rename", id: "team" },
			{ op: "initiative.change", id: "missing", changes: { name: "x" } },
			{ op: "initiative.met", id: "team", item: "No such item", proof: "x" },
			initiative("team"),
			{ op: "budget.create", id: "b" },
		]) {
			const r = workRecordsFrom(log(initiative("team"), odd));
			expect(r.problem, JSON.stringify(odd)).toBe("unknown-change");
			expect(r.initiatives).toHaveLength(1);
			expect(r.initiatives[0].name).toBe("Initiative team");
		}
		expect(workRecordsFrom(JSON.stringify({ v: 2, op: "initiative.create", id: "x" }) + "\n").problem).toBe(
			"unknown-change",
		);
	});

	it("a complete line that isn't JSON makes the whole log unreadable; a half-written last line is left out", () => {
		expect(workRecordsFrom(log(initiative("team")) + "{oops\n" + log(project("p")))).toEqual({
			initiatives: [],
			projects: [],
			problem: "unreadable",
		});
		const r = workRecordsFrom(log(initiative("team")) + '{"v":1,"op":"project.cre');
		expect(r).toEqual({
			initiatives: [{ id: "team", name: "Initiative team", lead: "architecture", status: "active", items: 2, met: 0 }],
			projects: [],
		});
	});
});

describe("WorkRecordsFile", () => {
	let dir = "";
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	it("no log yet: nothing, and no problem", async () => {
		dir = mkdtempSync(join(tmpdir(), "work-records-"));
		expect(await new WorkRecordsFile(() => join(dir, "events.jsonl")).get()).toEqual({ initiatives: [], projects: [] });
	});

	it("reads the log, and again only when it changed", async () => {
		dir = mkdtempSync(join(tmpdir(), "work-records-"));
		const file = join(dir, "events.jsonl");
		writeFileSync(file, log(initiative("team")));
		utimesSync(file, 1000, 1000);
		const reader = new WorkRecordsFile(() => file);
		const first = await reader.get();
		expect(first.initiatives.map((r) => r.id)).toEqual(["team"]);
		expect(await reader.get()).toBe(first);
		writeFileSync(file, log(initiative("team"), project("p")));
		utimesSync(file, 2000, 2000);
		expect((await reader.get()).projects.map((r) => r.id)).toEqual(["p"]);
	});

	it("a log over the limit isn't read: too-big", async () => {
		dir = mkdtempSync(join(tmpdir(), "work-records-"));
		const file = join(dir, "events.jsonl");
		writeFileSync(file, Buffer.alloc(WORK_LOG_MAX + 1, 0x20));
		expect(await new WorkRecordsFile(() => file).get()).toEqual({ initiatives: [], projects: [], problem: "too-big" });
	});

	// Security's review of 2cadd193, note 1: only a regular file is read, so nothing in its place can stall
	// the Roles look or be read without end.
	it("a FIFO in the log's place is refused at once, never waited on", async () => {
		dir = mkdtempSync(join(tmpdir(), "work-records-"));
		const file = join(dir, "events.jsonl");
		execFileSync("mkfifo", [file]);
		expect(await new WorkRecordsFile(() => file).get()).toEqual({
			initiatives: [],
			projects: [],
			problem: "unreadable",
		});
	});

	it("a link to a device is refused, never read", async () => {
		dir = mkdtempSync(join(tmpdir(), "work-records-"));
		const file = join(dir, "events.jsonl");
		symlinkSync("/dev/null", file);
		expect(await new WorkRecordsFile(() => file).get()).toEqual({
			initiatives: [],
			projects: [],
			problem: "unreadable",
		});
	});

	it("a link to a regular file is read", async () => {
		dir = mkdtempSync(join(tmpdir(), "work-records-"));
		const real = join(dir, "real.jsonl");
		const file = join(dir, "events.jsonl");
		writeFileSync(real, log(initiative("team")));
		symlinkSync(real, file);
		expect((await new WorkRecordsFile(() => file).get()).initiatives.map((r) => r.id)).toEqual(["team"]);
	});

	it("a path that can't be read (a folder) is unreadable", async () => {
		dir = mkdtempSync(join(tmpdir(), "work-records-"));
		expect(await new WorkRecordsFile(() => dir).get()).toEqual({
			initiatives: [],
			projects: [],
			problem: "unreadable",
		});
	});
});

describe("workProjectOf (owner-card-brief, Ops #682)", () => {
	const slot = globalThis as unknown as Record<symbol, unknown>;
	const dirs: string[] = [];
	afterEach(() => {
		delete slot[PI_QUEUE_READERS_KEY];
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});
	const folder = (content: string) => {
		const d = mkdtempSync(join(tmpdir(), "owner-card-work-"));
		dirs.push(d);
		writeFileSync(join(d, "events.jsonl"), content);
		return d;
	};
	const readers = (projects: Map<string, unknown>) => {
		let reads = 0;
		slot[PI_QUEUE_READERS_KEY] = {
			version: 1,
			replay: () => null,
			readWork: () => {
				reads++;
				return { projects };
			},
		};
		return () => reads;
	};

	it("a project's name and outcome from pi-queue's reader, read again only when the log changes", () => {
		const d = folder("x\n");
		const reads = readers(
			new Map<string, unknown>([
				["owner-cards", { name: "Owner cards he can answer cold", outcome: "He never picks blind." }],
				["no-outcome", { name: "Bare", outcome: "" }],
				["Bad Id", { name: "Skipped" }],
				["bad-name", { name: "One\nTwo" }],
			]),
		);
		expect(workProjectOf(d, "owner-cards")).toEqual({
			name: "Owner cards he can answer cold",
			outcome: "He never picks blind.",
		});
		expect(workProjectOf(d, "no-outcome")).toEqual({ name: "Bare" });
		expect(workProjectOf(d, "Bad Id")).toBeUndefined();
		expect(workProjectOf(d, "bad-name")).toBeUndefined();
		expect(workProjectOf(d, "missing")).toBeUndefined();
		expect(reads()).toBe(1);
		writeFileSync(join(d, "events.jsonl"), "xy\n");
		workProjectOf(d, "owner-cards");
		expect(reads()).toBe(2);
	});

	it("nothing when the log is missing, too big or pi-queue isn't loaded, or its reader throws", () => {
		const d = folder("x\n");
		expect(workProjectOf(d, "owner-cards")).toBeUndefined();
		expect(workProjectOf(join(d, "nope"), "owner-cards")).toBeUndefined();
		slot[PI_QUEUE_READERS_KEY] = {
			version: 1,
			replay: () => null,
			readWork: () => {
				throw new Error("refused");
			},
		};
		expect(workProjectOf(folder("y\n"), "owner-cards")).toBeUndefined();
		readers(new Map([["owner-cards", { name: "N" }]]));
		const big = folder("");
		truncateSync(join(big, "events.jsonl"), WORK_LOG_MAX + 1);
		expect(workProjectOf(big, "owner-cards")).toBeUndefined();
	});

	it("the folder is PI_WORK_DIR, or work in pi's agent folder", () => {
		expect(workFolder({ PI_WORK_DIR: "/w" })).toBe("/w");
		expect(workFolder({ PI_CODING_AGENT_DIR: "/a" })).toBe(join("/a", "work"));
	});
});
