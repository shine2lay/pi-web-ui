/**
 * progress-feed (task #85): the lead (seeded with the owner's own pick, set only by him), TL;DR lines filed by
 * their own or their task's initiative, initiative_update (lead-only post, the unlinked list), the asks'
 * triggers and throttle on a fake clock, the ask's delivery, and code's part of the second-hand check.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DecisionRecords,
	QueueScanner,
	recordId,
	withTaskInitiative,
	type DecisionRecord,
	type NewDecisionRecord,
} from "../../server/decision-records.js";
import { DecisionStore, INITIATIVES_FILE, SETTINGS_FILE, type DecisionEntry } from "../../server/decision-store.js";
import {
	buildMaterial,
	checkUpdate,
	codeCheck,
	isNotGiven,
	readerFlags,
	type MaterialLookup,
} from "../../server/feed-check.js";
import type { IdentityDef } from "../../server/identities.js";
import {
	needsYouCount,
	OWNER_REQUEST,
	pokeTextOf,
	ProgressFeed,
	type FeedHost,
	type PokeWhy,
} from "../../server/progress-feed.js";
import { RoleMessages, type RoleMessageHost, type RoleMessageSender } from "../../server/role-messages.js";

const TIT = "team-in-temper";
/** Local time on a day of October 2026 (the daily ask is local). */
const local = (day: number, h: number, m = 0): number => new Date(2026, 9, day, h, m).getTime();

let dir = "";
let now = 0;
const stops: Array<{ stop(): void }> = [];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "feed-unit-"));
	now = local(12, 9);
});
afterEach(() => {
	for (const s of stops.splice(0)) s.stop();
	rmSync(dir, { recursive: true, force: true });
});

interface Fx {
	ddir: string;
	store: DecisionStore;
	records: DecisionRecords;
	feed: ProgressFeed;
	pokes: { id: string; role: string; text: string; why: PokeWhy[] }[];
	states: Map<string, "waiting" | "delivered" | "replied" | "failed">;
	busy: Set<string>;
}

function fixture(opts: { feed?: string[]; initiatives?: unknown } = {}): Fx {
	const ddir = join(dir, "decisions");
	mkdirSync(ddir, { recursive: true });
	writeFileSync(join(ddir, SETTINGS_FILE), JSON.stringify({ enabled: false, feedInitiatives: opts.feed ?? [TIT] }));
	if (opts.initiatives) writeFileSync(join(ddir, INITIATIVES_FILE), JSON.stringify(opts.initiatives));
	const store = new DecisionStore(ddir, { now: () => now });
	const records = new DecisionRecords(ddir, { now: () => now });
	const fx = { ddir, store, records, pokes: [], states: new Map(), busy: new Set() } as unknown as Fx;
	const host: FeedHost = {
		store: () => store,
		records: () => records.list(),
		append: (r) => records.append(r),
		roles: () => [
			{ id: "architecture", name: "Architecture" },
			{ id: "data", name: "Data" },
		],
		poke: (p) => {
			const id = `rm-${String(fx.pokes.length + 1).padStart(8, "0")}`;
			fx.pokes.push({ id, role: p.role, text: p.text, why: p.why });
			fx.states.set(id, "waiting");
			return { ok: true, id };
		},
		pokeState: (id) => fx.states.get(id),
		leadBusy: (role) => fx.busy.has(role),
		now: () => now,
	};
	fx.feed = new ProgressFeed(host, ddir);
	stops.push(fx.feed);
	return fx;
}

const answer = (ref: string, at: number, picked: string, description = "the plain way"): NewDecisionRecord => ({
	source: "answer",
	at,
	from: "ops",
	ref,
	initiative: TIT,
	ask: "dialog",
	questions: [
		{
			id: "q1",
			header: "Which way",
			question: "Which way should it go?",
			options: [{ label: picked, description }, { label: "Wait a week" }],
			picked: [picked],
		},
	],
});

const message = (ref: string, at: number, text: string, initiative = TIT): NewDecisionRecord => ({
	source: "message",
	at,
	from: "temper",
	to: "architecture",
	ref,
	kind: "fyi",
	text,
	initiative,
});

/** Keep a record and a decision from it (what the #84 reader files). */
function decide(
	fx: Fx,
	rec: NewDecisionRecord,
	title: string,
	initiative: string = TIT,
): { rec: string; d: DecisionEntry } {
	fx.records.append(rec);
	const id = recordId(rec.source, rec.ref);
	const d = fx.store.addDecision({
		initiative,
		filedBy: "tag",
		title,
		what: title,
		at: rec.at,
		sources: [{ record: id, at: rec.at, quotes: [], by: "reader" }],
		by: "reader",
	});
	fx.store.save();
	return { rec: id, d };
}

const lead: RoleMessageSender = {
	role: "architecture",
	title: "Architecture",
	chat: "home chat",
	file: "/x/arch.jsonl",
	handling: 0,
};
const data: RoleMessageSender = { ...lead, role: "data", title: "Data", file: "/x/data.jsonl" };

async function post(fx: Fx, sources: string[], changed = "Linked the new decisions.", by = lead) {
	return fx.feed.post(by, { initiative: TIT, changed, next: "", needs_you: "", sources }, 1_000);
}

// ---------------------------------------------------------------------------
// The lead
// ---------------------------------------------------------------------------

describe("the lead", () => {
	it("a new store seeds Team in Temper with Architecture, the owner's own pick of Oct 9 (his answer's record)", () => {
		const store = new DecisionStore(join(dir, "d"));
		const [tit] = store.initiatives();
		expect(tit).toMatchObject({ id: TIT, lead: "architecture", leadSet: { by: "owner", source: "dr-2941468511bb" } });
		expect(new Date(tit!.leadSet!.at).toISOString()).toBe("2026-10-09T22:46:46.922Z");
	});

	it("an existing list without a lead gets his pick once; a lead he cleared or changed stays as he set it", () => {
		const fx = fixture({
			initiatives: {
				initiatives: [
					{ id: TIT, name: "Team in Temper", markers: ["Team in Temper"], lead: null },
					{ id: "other", name: "Other", markers: [], lead: null },
				],
			},
		});
		const list = fx.store.initiatives();
		expect(list.find((i) => i.id === TIT)).toMatchObject({ lead: "architecture", leadSet: { by: "owner" } });
		expect(list.find((i) => i.id === "other")?.lead).toBeNull();
		expect(list.find((i) => i.id === "other")?.leadSet).toBeUndefined();
		// He clears it on the page: never seeded again.
		expect(fx.feed.setLead(TIT, null)).toEqual({ ok: true });
		const again = new DecisionStore(fx.ddir).initiatives().find((i) => i.id === TIT);
		expect(again?.lead).toBeNull();
		expect(again?.leadSet).toMatchObject({ by: "owner", source: "page", at: now });
	});

	it("the page sets only a real role; the update shows who leads and refuses everyone else", async () => {
		const fx = fixture();
		expect(fx.feed.setLead(TIT, "nobody")).toEqual({ ok: false, error: 'there\'s no role "nobody"' });
		expect(fx.feed.setLead("nope", "data")).toMatchObject({ ok: false });
		expect(fx.feed.setLead(TIT, "Data")).toEqual({ ok: true });
		expect(fx.store.initiatives().find((i) => i.id === TIT)).toMatchObject({
			lead: "data",
			leadSet: { source: "page" },
		});
		const { rec } = decide(fx, answer("a1", now, "Go"), "Go");
		const refused = await post(fx, [rec]);
		expect(refused).toEqual({ ok: false, error: "Only Team in Temper's lead posts its updates: the lead is data." });
		expect((await post(fx, [rec], "Linked it.", data)).ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// TL;DR lines
// ---------------------------------------------------------------------------

const PLAN = {
	title: "Feed",
	goal: "one feed",
	doneWhen: "shown",
	decided: "lead",
	steps: "1. do",
	verify: "tests",
	mustNot: "none",
};
const header = (file: string): void =>
	writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "x", cwd: dir })}\n`);
const entry = (file: string, customType: string, data: Record<string, unknown>): void =>
	appendFileSync(
		file,
		`${JSON.stringify({ type: "custom", customType, id: Math.random().toString(16).slice(2, 10), parentId: null, timestamp: new Date(now).toISOString(), data: { v: 1, ts: now, ...data } })}\n`,
	);

describe("TL;DR lines", () => {
	it("withTaskInitiative: its own field, else the queue chat's op for the task, else the task's own, else none", () => {
		const rec: NewDecisionRecord = { source: "tldr", at: 1, from: "ops", ref: "t.jsonl:3", text: "x" };
		const task = { id: 7, from: "/s/q.jsonl", initiative: "at-start" };
		expect(withTaskInitiative({ ...rec, initiative: "own" }, task, () => ({ "7": "queue" })).initiative).toBe("own");
		expect(withTaskInitiative(rec, task, () => ({ "7": "queue" })).initiative).toBe("queue");
		expect(withTaskInitiative(rec, task, () => undefined).initiative).toBe("at-start");
		expect(withTaskInitiative(rec, task, () => ({ "8": "other" })).initiative).toBeUndefined();
		expect(withTaskInitiative(rec, null, () => ({ "7": "queue" })).initiative).toBeUndefined();
	});

	it("the scanner keeps the lines the feed wants, filed by their own or their task's initiative (the queue chat's ops win)", async () => {
		const root = join(dir, "sessions");
		mkdirSync(join(root, "--home--"), { recursive: true });
		const q = join(root, "--home--", "queue.jsonl");
		const t = join(root, "--home--", "task.jsonl");
		const plain = join(root, "--home--", "plain.jsonl");
		for (const f of [q, t, plain]) header(f);
		const records = new DecisionRecords(join(dir, "decisions"), { now: () => now });
		const offered: Record<string, string | undefined> = {};
		const opts = {
			root: () => root,
			statePath: join(dir, "decisions", "scan-state.json"),
			roleOf: async (files: string[]) => new Map(files.map((f) => [f, "ops"] as [string, string])),
			now: () => now,
			keepTldr: (r: NewDecisionRecord) => {
				offered[r.text ?? ""] = r.initiative;
				return r.initiative === TIT ? r : undefined;
			},
		};
		const scanner = new QueueScanner(records, opts);
		await scanner.scan();
		now += 1_000;
		entry(q, "queue", { op: "add", id: 7, plan: PLAN, initiative: TIT });
		expect(await scanner.scan()).toBe(1);
		now += 1_000;
		entry(t, "queue", {
			op: "assigned",
			id: 7,
			plan: PLAN,
			initiative: "old-name",
			from: { file: q, title: "Ops lead" },
		});
		entry(t, "tldr", { text: "Building the feed", needsYou: false });
		entry(t, "tldr", { text: "Own tag wins", needsYou: true, initiative: "elsewhere" });
		entry(plain, "tldr", { text: "A plain chat's line", needsYou: false });
		expect(await scanner.scan()).toBe(1);
		expect(offered).toEqual({
			"Building the feed": TIT,
			"Own tag wins": "elsewhere",
			"A plain chat's line": undefined,
		});
		const kept = records.list({ source: "tldr" });
		expect(kept).toHaveLength(1);
		expect(kept[0]).toMatchObject({
			source: "tldr",
			from: "ops",
			ref: "task.jsonl:3",
			text: "Building the feed",
			initiative: TIT,
		});
		// The task is moved to another initiative in its queue chat: later lines follow it.
		now += 1_000;
		entry(q, "queue", { op: "update", id: 7, initiative: "moved-on" });
		await scanner.scan();
		entry(t, "tldr", { text: "After the move", needsYou: false });
		await scanner.scan();
		expect(offered["After the move"]).toBe("moved-on");
	});

	it("a task chat read before lines were kept finds its task from the top of its transcript", async () => {
		const root = join(dir, "sessions");
		mkdirSync(join(root, "--home--"), { recursive: true });
		const q = join(root, "--home--", "queue.jsonl");
		const t = join(root, "--home--", "task.jsonl");
		for (const f of [q, t]) header(f);
		const records = new DecisionRecords(join(dir, "decisions"), { now: () => now });
		const base = {
			root: () => root,
			statePath: join(dir, "decisions", "scan-state.json"),
			roleOf: async (files: string[]) => new Map(files.map((f) => [f, "ops"] as [string, string])),
			now: () => now,
		};
		const before = new QueueScanner(records, base);
		await before.scan();
		now += 1_000;
		entry(q, "queue", { op: "add", id: 3, plan: PLAN, initiative: TIT });
		entry(t, "queue", { op: "assigned", id: 3, plan: PLAN, from: { file: q } });
		entry(t, "tldr", { text: "Not kept: no feed yet", needsYou: false });
		await before.scan();
		expect(records.list({ source: "tldr" })).toHaveLength(0);
		const after = new QueueScanner(records, {
			...base,
			keepTldr: (r: NewDecisionRecord) => (r.initiative === TIT ? r : undefined),
		});
		now += 1_000;
		entry(t, "tldr", { text: "Kept now", needsYou: false });
		expect(await after.scan()).toBe(1);
		expect(records.list({ source: "tldr" })[0]).toMatchObject({ text: "Kept now", initiative: TIT });
	});
});

// ---------------------------------------------------------------------------
// initiative_update
// ---------------------------------------------------------------------------

describe("initiative_update", () => {
	it("refuses a post with no lead, from another role, for an initiative without Progress, or without good sources", async () => {
		const fx = fixture({
			initiatives: {
				initiatives: [
					{
						id: TIT,
						name: "Team in Temper",
						markers: [],
						lead: "architecture",
						leadSet: { by: "owner", at: 1, source: "x" },
					},
					{ id: "other", name: "Other", markers: [], lead: "architecture" },
					{ id: "nolead", name: "No lead", markers: [], lead: null },
				],
			},
			feed: [TIT, "nolead"],
		});
		const { rec } = decide(fx, answer("a1", now, "Go"), "Go");
		const elsewhere = decide(fx, message("m9", now, "elsewhere", "other"), "Elsewhere", "other");
		expect(await post(fx, [rec], "x", data)).toEqual({
			ok: false,
			error: "Only Team in Temper's lead posts its updates: the lead is architecture.",
		});
		expect(await fx.feed.post(lead, { initiative: "nolead", changed: "x", sources: [rec] })).toMatchObject({
			ok: false,
			error: expect.stringMatching(/has no lead yet: only the owner names one/),
		});
		expect(await fx.feed.post(lead, { initiative: "other", changed: "x", sources: [rec] })).toEqual({
			ok: false,
			error: "Progress is off for Other.",
		});
		expect(await post(fx, [])).toMatchObject({ ok: false, error: expect.stringMatching(/^Give sources/) });
		const bad = await post(fx, ["dr-000000000000", elsewhere.d.id, elsewhere.rec, "hello"]);
		expect(bad.ok).toBe(false);
		const error = bad.ok ? "" : bad.error;
		expect(error).toContain("dr-000000000000 (no such record)");
		expect(error).toContain(`${elsewhere.d.id} (not a decision or change of Team in Temper)`);
		expect(error).toContain(`${elsewhere.rec} (not filed under Team in Temper)`);
		expect(error).toContain("hello (not a record or entry id)");
		expect(await fx.feed.post(lead, { initiative: TIT, changed: "x".repeat(1501), sources: [rec] })).toMatchObject({
			ok: false,
			error: expect.stringMatching(/changed is 1,501 characters/),
		});
		// A field that isn't text is refused, not dropped (stage test, poke run 1).
		expect(
			await fx.feed.post(lead, { initiative: TIT, changed: "x", impact: { d1: "not known" }, sources: [rec] }),
		).toMatchObject({
			ok: false,
			error: expect.stringMatching(/^impact must be plain text/),
		});
		expect(fx.records.list({ source: "update" })).toHaveLength(0);
	});

	it("new lists unlinked decisions and changes by record; each post says what is still unlinked; updates are records", async () => {
		const fx = fixture();
		const a = decide(fx, answer("a1", now, "Ship the feed"), "Ship the feed");
		now += 60_000;
		const b = decide(
			fx,
			message("m1", now, "Temper will run the team trial on temper-dev only."),
			"Trial on temper-dev",
		);
		now += 60_000;
		fx.records.append(message("m2", now, "Widened: the viewer comes down too."));
		const m2 = recordId("message", "m2");
		const change = fx.store.addChange(a.d, {
			type: "widened",
			what: "the viewer comes down too",
			at: now,
			sources: [{ record: m2, at: now, quotes: [], by: "reader" }],
			by: "reader",
		});
		fx.store.save();
		const first = fx.feed.newList(TIT);
		if (!first.ok) throw new Error(first.error);
		expect(first.text).toContain("Not linked by any update: 2 decisions, 1 changes (from 3 records)");
		expect(first.text).toContain("Decisions missing impact, options or until: 2 of 2");
		for (const id of [a.rec, b.rec, m2, a.d.id, b.d.id, change.id]) expect(first.text).toContain(id);
		expect(first.text).toContain("[no impact, options, until]");
		// A filled field is shown in its own words, so the lead can say it (stage test, poke runs 2-4).
		a.d.impact = { text: "The owner sees one feed per initiative.", by: "role:ops", at: now };
		fx.store.save();
		const filled = fx.feed.newList(TIT);
		expect(filled.ok && filled.text).toContain(
			`${a.d.id} "Ship the feed" (impact: "The owner sees one feed per initiative.") [no options, until]`,
		);

		now += 60_000;
		const one = await post(fx, [a.rec]);
		if (!one.ok) throw new Error(one.error);
		expect(one.text).toContain("covering 1 decisions and 0 changes");
		expect(one.text).toContain("Still not linked by any update: 1 decisions, 1 changes");
		// Linking a decision's record links the decision, not a change made in another record.
		const second = fx.feed.newList(TIT);
		expect(second.ok && second.text).toContain(b.d.id);
		expect(second.ok && second.text).toContain(change.id);
		expect(second.ok && second.text).not.toContain(`${a.d.id} "`);

		now += 60_000;
		const two = await post(fx, [b.d.id, change.id]);
		expect(two.ok && two.text).toContain("Every decision and change is linked now.");
		const ups = fx.records.list({ source: "update" });
		expect(ups).toHaveLength(2);
		expect(ups[1]).toMatchObject({
			from: "architecture",
			initiative: TIT,
			sources: [b.d.id, change.id],
			update: { changed: "Linked the new decisions.", next: "", needsYou: "" },
		});
		expect(fx.feed.newList(TIT)).toMatchObject({
			ok: true,
			text: expect.stringContaining("Nothing new and nothing unlinked."),
		});
	});
});

// ---------------------------------------------------------------------------
// Asks: triggers and throttle
// ---------------------------------------------------------------------------

describe("asks to the lead (fake clock)", () => {
	it("asks when a decision is filed, at most once per 3 hours, never while one is open, and not when nothing is new", async () => {
		const fx = fixture();
		const r1 = decide(fx, answer("a1", now, "One"), "One");
		fx.feed.stepNow(TIT); // the first round only notes where things stand
		expect(fx.pokes).toHaveLength(0);

		now = local(12, 10);
		const r2 = decide(fx, answer("a2", now, "Two"), "Two");
		fx.feed.stepNow(TIT);
		expect(fx.pokes.map((p) => [p.role, p.why])).toEqual([["architecture", ["decision"]]]);

		now = local(12, 10, 10);
		const r3 = decide(fx, answer("a3", now, "Three"), "Three");
		fx.feed.stepNow(TIT);
		expect(fx.pokes).toHaveLength(1); // one is open

		// The lead answers: its update closes the ask; with nothing left to link, the waiting trigger drops.
		now = local(12, 10, 20);
		fx.states.set(fx.pokes[0]!.id, "delivered");
		expect((await post(fx, [r1.rec, r2.rec, r3.rec])).ok).toBe(true);
		now = local(12, 10, 21);
		fx.feed.stepNow(TIT);
		const s1 = fx.feed.snapshot().initiatives[TIT]!;
		expect(s1.open).toBeUndefined();
		expect(s1.closed?.[0]).toMatchObject({ id: fx.pokes[0]!.id, how: "answered" });
		expect(s1.pending).toEqual([]);

		// A new decision inside the 3 hours waits for them to pass.
		now = local(12, 10, 30);
		const r4 = decide(fx, answer("a4", now, "Four"), "Four");
		fx.feed.stepNow(TIT);
		now = local(12, 12, 59);
		fx.feed.stepNow(TIT);
		expect(fx.pokes).toHaveLength(1);
		expect(fx.feed.snapshot().initiatives[TIT]!.pending).toEqual(["decision"]);
		now = local(12, 13, 1);
		fx.feed.stepNow(TIT);
		expect(fx.pokes).toHaveLength(2);
		expect(fx.pokes[1]!.why).toEqual(["decision"]);

		// The daily ask at 17:00 comes when something is new (here a TL;DR line, which asks nothing by itself).
		now = local(12, 13, 5);
		fx.states.set(fx.pokes[1]!.id, "delivered");
		expect((await post(fx, [r4.rec])).ok).toBe(true);
		now = local(12, 13, 6);
		fx.feed.stepNow(TIT);
		now = local(12, 16);
		fx.records.append({
			source: "tldr",
			at: now,
			from: "temper",
			ref: "t.jsonl:9",
			text: "Trial run started",
			initiative: TIT,
		});
		fx.feed.stepNow(TIT);
		expect(fx.pokes).toHaveLength(2);
		now = local(12, 17);
		fx.feed.stepNow(TIT);
		expect(fx.pokes).toHaveLength(3);
		expect(fx.pokes[2]!.why).toEqual(["daily"]);

		// Answered; the next day's 17:00 finds nothing new: no ask.
		now = local(12, 17, 5);
		fx.states.set(fx.pokes[2]!.id, "delivered");
		expect((await post(fx, [recordId("tldr", "t.jsonl:9")])).ok).toBe(true);
		now = local(12, 17, 6);
		fx.feed.stepNow(TIT);
		now = local(13, 17);
		fx.feed.stepNow(TIT);
		expect(fx.pokes).toHaveLength(3);
		expect(fx.feed.snapshot().initiatives[TIT]!.daily).toBe("2026-10-13");
	});

	it("the owner's button asks at once, unless an ask is still on its way; a lead still in its turn keeps the ask open", async () => {
		const fx = fixture();
		const r1 = decide(fx, answer("a1", now, "One"), "One");
		const first = fx.feed.ask(TIT);
		expect(first).toMatchObject({ ok: true });
		expect(fx.pokes[0]!.why).toEqual(["button"]);
		expect(fx.feed.ask(TIT)).toMatchObject({
			ok: false,
			error: expect.stringMatching(/already on its way to architecture/),
		});
		fx.states.set(fx.pokes[0]!.id, "delivered");
		fx.busy.add("architecture");
		expect(fx.feed.view(TIT)?.asked).toMatchObject({ delivered: true, by: "owner" });
		now += 60_000;
		expect((await post(fx, [r1.rec])).ok).toBe(true);
		now += 60_000;
		fx.feed.stepNow(TIT);
		expect(fx.feed.snapshot().initiatives[TIT]!.open?.id).toBe(fx.pokes[0]!.id);
		// The page no longer says "no update yet" once one came after the ask, though the ask stays open.
		expect(fx.feed.view(TIT)?.asked).toBeUndefined();
		fx.busy.clear();
		fx.feed.stepNow(TIT);
		expect(fx.feed.snapshot().initiatives[TIT]!.open).toBeUndefined();
		expect(fx.feed.ask(TIT)).toMatchObject({ ok: true });
		expect(fx.pokes).toHaveLength(2);
	});

	it("flags on the lead's last update ask it to correct them, quoting each flagged sentence", async () => {
		const fx = fixture();
		const r1 = decide(fx, message("m1", now, "Temper will keep the trial on temper-dev."), "Trial on temper-dev");
		fx.feed.stepNow(TIT);
		now = local(12, 13);
		expect((await post(fx, [r1.rec], "You decided to keep the trial on temper-dev.")).ok).toBe(true);
		now = local(12, 13, 1);
		fx.feed.stepNow(TIT);
		expect(fx.pokes).toHaveLength(1);
		expect(fx.pokes[0]!.why).toEqual(["flag"]);
		expect(fx.pokes[0]!.text).toContain(
			'- changed: "You decided to keep the trial on temper-dev.": Says you decided, but none of its linked records holds your own words.',
		);
		// Asked once per update.
		fx.states.set(fx.pokes[0]!.id, "failed");
		now = local(12, 17, 30);
		fx.feed.stepNow(TIT);
		fx.feed.stepNow(TIT);
		expect(fx.pokes.filter((p) => p.why.includes("flag"))).toHaveLength(1);
	});

	it("nothing is collected, asked or read for an initiative without Progress", async () => {
		const fx = fixture({ feed: [] });
		decide(fx, answer("a1", now, "One"), "One");
		await fx.feed.tick();
		now = local(12, 18);
		await fx.feed.tick();
		expect(fx.pokes).toHaveLength(0);
		expect(fx.feed.ask(TIT)).toEqual({ ok: false, error: "Progress is off for Team in Temper." });
		expect(fx.feed.newList(TIT)).toEqual({ ok: false, error: "Progress is off for Team in Temper." });
		expect(fx.feed.row(TIT)).toEqual({ on: false, needsYou: 0, newSinceSeen: false });
		expect(fx.feed.view(TIT)?.on).toBe(false);
	});
});

describe("the ask's text and delivery", () => {
	it("says the owner's request, what is new, the missing fields, the flags, then how to post", () => {
		const text = pokeTextOf({
			name: "Team in Temper",
			initiative: TIT,
			leadSet: { by: "owner", at: Date.parse("2026-10-09T22:46:46.922Z"), source: "dr-2941468511bb" },
			why: ["decision", "daily"],
			fresh: 3,
			unlinked: { decisions: 2, changes: 1, records: 2 },
			missing: 2,
			decisionsAll: 4,
			lines: ['dr-aaaa · the owner\'s answer · ops · Oct 12 09:00 · "Which way: Go" -> d1 "Go"'],
			flags: [
				{
					field: "changed",
					text: "You decided it.",
					why: "Says you decided, but none of its linked records holds your own words.",
				},
			],
			dailyAt: "17:00",
		});
		const order = [
			OWNER_REQUEST.ref,
			"requested work under rule 14",
			"What's new so far: 3 records filed; 2 decisions and 1 changes",
			"missing impact, options or until: 2 of 4",
			"1 flagged sentence",
			"Post with initiative_update; say only what the linked records hold; fill impact/options/until with decision_log where known, else say not known.",
		];
		let at = -1;
		for (const part of order) {
			const i = text.indexOf(part);
			expect(i, part).toBeGreaterThan(at);
			at = i;
		}
	});

	it("goes to the lead's home chat like a role request: the page's, a fresh chain, outside the role caps", async () => {
		const home = join(dir, "arch-home.jsonl");
		header(home);
		const sent: { file: string; text: string }[] = [];
		const host: RoleMessageHost = {
			roles: () => [
				{
					id: "architecture",
					title: "Architecture",
					homeChat: home,
					pastHomeChats: [],
					raw: {},
					dir,
				} as unknown as IdentityDef,
			],
			chatState: () => "idle",
			deliver: async (file, text) => {
				sent.push({ file, text });
				appendFileSync(
					file,
					`${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } })}\n`,
				);
				return { ok: true };
			},
			note: async () => ({ ok: true }),
			log: () => {},
		};
		const s = new RoleMessages(join(dir, "rm", "role-messages.json"), host, () => now);
		stops.push(s);
		const r = s.requestPoke({
			role: "architecture",
			initiative: TIT,
			name: "Team in Temper",
			text: "What's new: 2 records.",
			why: ["button"],
		});
		if (!r.ok) throw new Error(r.error);
		expect(r.record).toMatchObject({
			kind: "report",
			chain: 1,
			from: { role: "app", title: "the Initiatives page" },
			poke: { initiative: TIT, why: ["button"] },
		});
		await s.tick();
		expect(sent).toHaveLength(1);
		expect(sent[0]!.file).toBe(home);
		expect(sent[0]!.text.split("\n")[0]).toBe(
			`[Role message ${r.record.id} from the Initiatives page · progress update · Team in Temper]`,
		);
		expect(sent[0]!.text).toContain("Post it with initiative_update, not message_role.");
		expect(s.requestPoke({ role: "nobody", initiative: TIT, name: "x", text: "x", why: [] })).toMatchObject({
			ok: false,
		});
	});

	it("counts the items the lead says need the owner", () => {
		expect(needsYouCount("")).toBe(0);
		expect(needsYouCount("Nothing.")).toBe(0);
		expect(needsYouCount("not given")).toBe(0);
		expect(needsYouCount("Pick the trial date.")).toBe(1);
		expect(needsYouCount("- Pick the trial date\n- Say yes to SW-70")).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// The second-hand check: code's part
// ---------------------------------------------------------------------------

function lookupOf(recs: DecisionRecord[]): MaterialLookup {
	const byId = new Map(recs.map((r) => [r.id, r] as const));
	return { record: (id) => byId.get(id), decision: () => undefined, change: () => undefined, entriesOn: () => [] };
}

describe("the second-hand check (code)", () => {
	function material() {
		const records = new DecisionRecords(join(dir, "m"), { now: () => now });
		// Data's E60 case: COO's order adds "tailnet-only, with appropriate access controls"; his words don't say it.
		records.append({
			source: "board",
			kind: "order",
			at: local(7, 21, 22),
			from: "coo",
			ref: "bp-e072f992",
			title: "Send the owner a link to the Team page",
			text: "Give the owner a link to the Team page to watch the run; keep it tailnet-only, with appropriate access controls.",
			ownerWords: 'Owner to COO: "send me the link to the team page so i can watch the run"',
			initiative: TIT,
		});
		records.append(answer("a1", local(9, 15), "Keep the trial on temper-dev", "about $40 a run, on account 4"));
		const list = records.list();
		return { order: list[0]!.id, answer: list[1]!.id, look: lookupOf(list) };
	}
	const flagsOf = (changed: string, sources: string[], look: MaterialLookup) =>
		codeCheck({ changed, next: "", needsYou: "" }, buildMaterial(sources, look)).map((s) =>
			s.flags.map((f) => `${f.kind}:${f.claim}`),
		);

	it("flags owner credit no owner record backs (E60), and passes credit his own words hold", () => {
		const m = material();
		expect(flagsOf("You decided to keep it tailnet-only with access controls.", [m.order], m.look)[0]).toEqual([
			expect.stringMatching(/^owner:/),
		]);
		expect(flagsOf("The owner chose the tailnet-only setup.", [m.order], m.look)[0]).toEqual([
			expect.stringMatching(/^owner:/),
		]);
		expect(flagsOf("You asked for a link to the Team page to watch the run.", [m.order], m.look)[0]).toEqual([]);
		expect(flagsOf("You decided to keep the trial on temper-dev.", [m.answer], m.look)[0]).toEqual([]);
		expect(flagsOf("COO's order keeps the link tailnet-only, with access controls.", [m.order], m.look)[0]).toEqual([]);
		expect(flagsOf("You decided to keep the trial on temper-dev.", [m.order], m.look)[0]).toEqual([
			expect.stringMatching(/^owner:/),
		]);
	});

	it("flags money, dates, durations and numbers its linked records don't hold, and passes the ones they do", () => {
		const m = material();
		const both = [m.order, m.answer];
		expect(flagsOf("It costs about $40 a run.", both, m.look)[0]).toEqual([]);
		expect(flagsOf("It costs $90.", both, m.look)[0]).toEqual(["cost:$90"]);
		// A sum of money is held only by money: "account 4" (or a count of 4) doesn't hold "$4".
		expect(flagsOf("It costs $4 a run.", both, m.look)[0]).toEqual(["cost:$4"]);
		expect(flagsOf("It used 4 million tokens.", both, m.look)[0]).toEqual([
			expect.stringMatching(/^cost:4 million tokens/),
		]);
		expect(flagsOf("The order came on Oct 7.", both, m.look)[0]).toEqual([]);
		// "Oct 7:" opening a line is a date, not a bare 7 (stage test, poke run 2).
		expect(flagsOf("Oct 7: the order came.", both, m.look)[0]).toEqual([]);
		expect(flagsOf("It is due by Oct 20.", both, m.look)[0]).toEqual([expect.stringMatching(/^date:Oct 20/)]);
		expect(flagsOf("The trial takes 3 hours.", both, m.look)[0]).toEqual([expect.stringMatching(/^date:3 hours/)]);
		expect(flagsOf("It saves 30% of the tokens.", both, m.look)[0]).toEqual([expect.stringMatching(/^impact:30%/)]);
		expect(flagsOf("It runs on account 4.", both, m.look)[0]).toEqual([]);
		expect(
			codeCheck({ changed: "", next: "", needsYou: "", impact: "not given", until: "Not known." }, []).flatMap(
				(s) => s.flags,
			),
		).toEqual([]);
	});

	it("doesn't let a quote about another time hold the reader's date claim (stage test, run 2)", () => {
		const material = [
			{
				id: "dr-1",
				kind: "record" as const,
				text: "A fresh run starts within minutes; I send you the new link. It ends before the weekend.",
				ats: [],
				owner: [],
			},
		];
		const claim = (quote: string) => [
			{
				kind: "date" as const,
				claim: "fresh run is due to start before the weekend",
				evidence: [{ id: "dr-1", quote }],
			},
		];
		const s = { field: "until" as const, text: "The fresh run is due to start before the weekend." };
		expect(readerFlags(s, claim("A fresh run starts within minutes"), material).map((f) => f.kind)).toEqual(["date"]);
		expect(readerFlags(s, claim("It ends before the weekend"), material)).toEqual([]);
	});

	it("checks an option or cost claim the reader didn't list, found by its words (stage test, run 4)", () => {
		const material = [
			{
				id: "dr-1",
				kind: "record" as const,
				text: "You picked review rounds over every leader turn counts.",
				ats: [],
				owner: [],
			},
		];
		const changed = (text: string) => readerFlags({ field: "changed", text }, [], material).map((f) => f.kind);
		expect(changed("Instead of review rounds, you could have let every agent vote.")).toEqual(["option"]);
		expect(changed("It costs twice as much.")).toEqual(["cost"]);
		expect(changed("You picked review rounds.")).toEqual([]);
	});

	it("reads 'not known' with only decision ids around it as not given, and nothing more (stage test, poke runs 2-4)", () => {
		expect(isNotGiven("d308: not known. d2972: not known. d3353: not known.")).toBe(true);
		expect(isNotGiven("not known for d308, d2972, d3353 and d3776 as recorded in the feed")).toBe(true);
		expect(isNotGiven("Not known (none recorded for d2972).")).toBe(true);
		expect(isNotGiven("Not known, but it frees Security for other checks.")).toBe(false);
		expect(isNotGiven("d308: costs about $40, otherwise not known.")).toBe(false);
		const material = [{ id: "dr-1", kind: "record" as const, text: "Ship it.", ats: [], owner: [] }];
		expect(readerFlags({ field: "impact", text: "not known for d308 and d2972" }, [], material)).toEqual([]);
		expect(
			readerFlags({ field: "impact", text: "Not known, but it frees Security." }, [], material).map((f) => f.kind),
		).toEqual(["impact"]);
	});

	it("asks the reader once more when its answer isn't JSON (stage test, run 11)", async () => {
		const material = [{ id: "dr-1", kind: "record" as const, text: "You picked review rounds.", ats: [], owner: [] }];
		const answers = [
			"Sure, here are the claims:",
			JSON.stringify({
				sentences: [{ n: 1, claims: [{ kind: "option", claim: "move runs to account 3", evidence: [] }] }],
			}),
		];
		let calls = 0;
		const model = async () => ({
			ok: true as const,
			text: answers[calls++] ?? "",
			model: "fake/model",
			usage: { input: 1, output: 1 },
		});
		const check = await checkUpdate(
			{ changed: "", next: "", needsYou: "", options: "The other option was to move Team runs to account 3." },
			material,
			{ model, reader: true },
		);
		expect(calls).toBe(2);
		expect(check.reader?.error).toBeUndefined();
		expect(check.sentences[0]!.flags.map((f) => `${f.kind}:${f.by}`)).toEqual(["option:reader"]);
	});
});
