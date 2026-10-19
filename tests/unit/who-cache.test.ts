/**
 * who-cache (Architecture #99, H-INIT-WHO-CACHE): who decided, kept between Initiatives page builds. The page
 * built with the cache must be the page built without it (cold, warm, after an appended record, after a
 * rewritten records file); kept answers are handed out as copies; answers no build uses are dropped; and
 * texts holding the key's separators can't share a key.
 */
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readerStatus } from "../../server/decision-reader.js";
import {
	DecisionRecords,
	type DecisionRecord,
	type NewDecisionRecord,
	recordId,
} from "../../server/decision-records.js";
import type { DecisionEntry, DecisionSourceRef } from "../../server/decision-store.js";
import { DecisionStore } from "../../server/decision-store.js";
import { buildDecisionsPage, type UiDecisionsPage } from "../../server/decision-view.js";
import { whoOf } from "../../server/decision-who.js";
import { WhoCache, whoKey } from "../../server/who-cache.js";

const T0 = Date.parse("2026-10-05T09:00:00-07:00");
let dir: string;
let records: DecisionRecords;
let store: DecisionStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "who-cache-unit-"));
	records = new DecisionRecords(dir, { now: () => T0 });
	store = new DecisionStore(dir, { now: () => T0 });
	writeFileSync(
		join(dir, "initiatives.json"),
		JSON.stringify({
			initiatives: [
				{ id: "team-in-temper", name: "Team in Temper", markers: [], lead: "architecture" },
				{ id: "other", name: "Other", markers: [], lead: null },
			],
		}),
	);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const add = (r: NewDecisionRecord): string => {
	records.append(r);
	return recordId(r.source, r.ref);
};

const ANSWER: NewDecisionRecord = {
	source: "answer",
	at: T0 + 1_000,
	from: "owner",
	to: "temper",
	ref: "ask:1",
	ask: "dialog",
	chat: "temper",
	title: "Turns",
	questions: [
		{
			id: "q1",
			question: "How should members take turns?",
			options: [
				{ label: "Review rounds (recommended)", description: "Every member reviews each round" },
				{ label: "Free flow", description: "Members work in parallel" },
			],
			picked: ["Free flow"],
		},
	],
};
const ORDER: NewDecisionRecord = {
	source: "board",
	at: T0 + 2_000,
	from: "coo",
	to: ["temper"],
	ref: "bp-1",
	kind: "order",
	title: "No rounds",
	text: "The owner wants parallel members. COO adds: keep the $100 pause.",
	ownerWords: "i want each member to work in parallel, always on",
	via: "coo",
};
const MESSAGE: NewDecisionRecord = {
	source: "message",
	at: T0 + 3_000,
	from: "temper",
	to: "architecture",
	ref: "rm-1",
	kind: "fyi",
	text: "The owner decided: members take turns one at a time. The report is written.",
};
const PLAN: NewDecisionRecord = {
	source: "plan",
	at: T0 + 4_000,
	from: "architecture",
	ref: "arch.jsonl:10",
	task: 7,
	op: "add",
	approval: "dialog",
	chat: "Arch lead",
	plan: { title: "Who cache", goal: "Keep answers between builds", decided: "Lead: Architecture" },
};
const PLAN_CHANGE: NewDecisionRecord = {
	source: "plan",
	at: T0 + 5_000,
	from: "architecture",
	ref: "arch.jsonl:20",
	task: 7,
	op: "update",
	approval: "auto",
	chat: "Arch lead",
	plan: { title: "Who cache", goal: "Keep answers" },
};
/** Cited by a decision before it is kept. */
const LATER: NewDecisionRecord = {
	source: "message",
	at: T0 + 6_000,
	from: "data",
	to: "architecture",
	ref: "rm-later",
	kind: "fyi",
	text: "Data says the quote is here.",
};

let at = T0;
const src = (
	record: string | undefined,
	quotes: string[],
	over: Partial<DecisionSourceRef> = {},
): DecisionSourceRef => ({
	...(record ? { record } : {}),
	at: (at += 1_000),
	quotes,
	by: "reader",
	...over,
});

const decision = (
	id: string,
	initiative: string | null,
	sources: DecisionSourceRef[],
	over: Partial<DecisionEntry> = {},
): DecisionEntry => ({
	id,
	initiative,
	filedBy: "tag",
	title: `Decision ${id}`,
	what: `What ${id}`,
	at: sources[0]?.at ?? T0,
	sources,
	changes: [],
	by: "reader",
	...over,
});

function saveDecisions(decisions: DecisionEntry[]): void {
	writeFileSync(join(dir, "decisions.json"), JSON.stringify({ v: 1, next: decisions.length + 1, decisions }));
	store.forget();
}

/** Every kind of source whoOf tells apart: his pick, a rider, an order (his words and the relayer's), a
 *  role's claim, a plan he approved, a plan change read against the version before it, a record not kept
 *  yet, and a role's own link. */
function fixture(): { ids: Record<string, string> } {
	const ids = {
		answer: add(ANSWER),
		order: add(ORDER),
		message: add(MESSAGE),
		plan: add(PLAN),
		change: add(PLAN_CHANGE),
		later: recordId(LATER.source, LATER.ref),
	};
	saveDecisions([
		decision(
			"d1",
			"team-in-temper",
			[
				src(ids.answer, ["Free flow"], { part: "main" }),
				src(ids.answer, ["Members work in parallel"], { part: "rider" }),
			],
			{
				changes: [
					{
						id: "c1",
						type: "reversed",
						what: "Members work in parallel",
						at: T0 + 50_000,
						sources: [src(ids.order, ["each member to work in parallel"])],
						by: "reader",
					},
				],
			},
		),
		decision(
			"d2",
			"team-in-temper",
			[
				src(ids.order, ["keep the $100 pause"]),
				src(ids.message, ["members take turns one at a time"]),
				src(ids.message, ["nobody wrote this"]),
			],
			{ alsoIn: ["other"] },
		),
		decision("d3", "other", [src(ids.plan, ["Keep answers between builds"])], {
			changes: [
				{
					id: "c2",
					type: "re-recorded",
					what: "Shorter goal",
					at: T0 + 60_000,
					sources: [src(ids.change, ["between builds"], { was: ids.plan }), src(ids.answer, ["Review rounds"])],
					by: "reader",
				},
			],
		}),
		decision("d4", null, [
			src(ids.later, ["the quote is here"], { by: "role:temper", claimsOwner: true }),
			{ link: "plans/x.md", at: (at += 1_000), quotes: [], by: "role:ops" },
		]),
		decision("d5", "gone", [src(ids.message, ["The report is written"])], {
			notDecision: { by: "role:ops", at: T0 + 70_000 },
		}),
	]);
	return { ids };
}

const byIdOf = (): Map<string, DecisionRecord> => new Map(records.list().map((r) => [r.id, r] as const));

const SELECTIONS: (string | undefined)[] = [undefined, "", "team-in-temper", "other", "nobody"];
const LIMITS: (number | undefined)[] = [undefined, 1, 200, 2000];

/** The page for every selection and limit, as JSON (what the tab is sent). */
function pages(recs: Map<string, DecisionRecord>, whoCache?: WhoCache): string[] {
	const reader = readerStatus(store, undefined, T0);
	const out: string[] = [];
	for (const initiative of SELECTIONS)
		for (const limit of LIMITS)
			out.push(
				JSON.stringify(
					buildDecisionsPage(store, recs, reader, { initiative, limit, ...(whoCache ? { whoCache } : {}) }),
				),
			);
	return out;
}

function onePage(recs: Map<string, DecisionRecord>, whoCache?: WhoCache): UiDecisionsPage {
	return buildDecisionsPage(store, recs, readerStatus(store, undefined, T0), whoCache ? { whoCache } : {});
}

const statOf = (): { ino: number; size: number } => {
	const st = statSync(records.file);
	return { ino: st.ino, size: st.size };
};

describe("who-cache: the page with the cache is the page without it", () => {
	it("is the same for every selection and limit, cold and warm, and a warm build calls whoOf for nothing", () => {
		fixture();
		const recs = byIdOf();
		const plain = pages(recs);
		// The fixture gets several kinds of answer from whoOf, so the comparison means something.
		const sources = onePage(recs).decisions.flatMap((d) => [...d.sources, ...d.changes.flatMap((c) => c.sources)]);
		expect(new Set(sources.map((s) => s.approval)).size).toBeGreaterThanOrEqual(5);
		expect(new Set(sources.map((s) => s.you))).toEqual(new Set([true, false]));
		expect(sources.flatMap((s) => s.flags)).toEqual(expect.arrayContaining(["claims-owner", "quote-not-found"]));

		const cache = new WhoCache();
		expect(pages(recs, cache)).toEqual(plain);
		const cold = cache.misses;
		// Every source in the fixture is a key of its own, and 20 builds work each out once.
		expect(cold).toBe(sources.length);
		expect(pages(recs, cache)).toEqual(plain);
		expect(cache.misses).toBe(cold);
		expect(cache.size).toBe(cold);
	});

	it("shows a record appended after the first build, and keeps the other answers", () => {
		const { ids } = fixture();
		const cache = new WhoCache();
		cache.sawFile(statOf().ino, statOf().size);
		const before = onePage(byIdOf(), cache);
		const d4 = before.decisions.find((d) => d.id === "d4")!;
		expect(d4.sources[0]).toMatchObject({ record: ids.later, kind: "role", writer: "temper", approval: "role-entry" });
		const misses = cache.misses;

		add(LATER);
		const after = statOf();
		expect(cache.sawFile(after.ino, after.size)).toBe(false);
		const recs = byIdOf();
		const page = onePage(recs, cache);
		expect(page.decisions.find((d) => d.id === "d4")!.sources[0]).toMatchObject({
			record: ids.later,
			kind: "message",
			writer: "data",
			approval: "message",
			flags: ["claims-owner"],
		});
		expect(cache.misses).toBe(misses + 1);
		expect(JSON.stringify(page)).toBe(JSON.stringify(onePage(recs)));
		expect(pages(recs, cache)).toEqual(pages(recs));
	});
});

describe("who-cache: a rewritten records file", () => {
	it("drops every answer when the file is replaced, so the page follows the new records", () => {
		fixture();
		const cache = new WhoCache();
		const stale = new WhoCache();
		let st = statOf();
		cache.sawFile(st.ino, st.size);
		stale.sawFile(st.ino, st.size);
		onePage(byIdOf(), cache);
		onePage(byIdOf(), stale);
		expect(cache.size).toBeGreaterThan(0);

		// The same record id, other words: the quote is gone from the message (a rewrite, not an append).
		const raw = readFileSync(records.file, "utf8");
		const rewritten = raw.replace("members take turns one at a time", "members work as they like");
		expect(rewritten).not.toBe(raw);
		writeFileSync(`${records.file}.tmp`, rewritten);
		renameSync(`${records.file}.tmp`, records.file);
		const recs = byIdOf();
		const plain = JSON.stringify(onePage(recs));
		// A cache never told about the new file keeps the old answer: the check below matters.
		expect(JSON.stringify(onePage(recs, stale))).not.toBe(plain);

		st = statOf();
		expect(cache.sawFile(st.ino, st.size)).toBe(true);
		expect(cache.size).toBe(0);
		expect(JSON.stringify(onePage(recs, cache))).toBe(plain);
		expect(pages(recs, cache)).toEqual(pages(recs));
	});

	it("drops every answer when the file shrinks in place, and none when it only grows", () => {
		fixture();
		const cache = new WhoCache();
		let st = statOf();
		cache.sawFile(st.ino, st.size);
		onePage(byIdOf(), cache);
		const kept = cache.size;

		add(LATER);
		st = statOf();
		expect(cache.sawFile(st.ino, st.size)).toBe(false);
		expect(cache.size).toBe(kept);

		const lines = readFileSync(records.file, "utf8").split("\n").filter(Boolean);
		writeFileSync(records.file, `${lines.slice(0, 2).join("\n")}\n`);
		const shrunk = statOf();
		expect(shrunk.ino).toBe(st.ino);
		expect(cache.sawFile(shrunk.ino, shrunk.size)).toBe(true);
		expect(cache.size).toBe(0);
		const recs = byIdOf();
		expect(pages(recs, cache)).toEqual(pages(recs));
	});

	it("drops every answer when the file is gone", () => {
		fixture();
		const cache = new WhoCache();
		const st = statOf();
		cache.sawFile(st.ino, st.size);
		onePage(byIdOf(), cache);
		rmSync(records.file);
		expect(cache.sawFile(-1, 0)).toBe(true);
		expect(cache.size).toBe(0);
	});
});

describe("who-cache: kept answers", () => {
	it("hands out copies: changing one doesn't change the kept answer", () => {
		const { ids } = fixture();
		const rec = byIdOf().get(ids.order)!;
		const point = { quotes: ["keep the $100 pause"], by: "reader" };
		const cache = new WhoCache();
		const first = cache.get(rec, point);
		expect(first.flags).toEqual(["claims-owner"]);
		first.flags.push("rider");
		first.places.push("label");
		first.you = true;
		const again = cache.get(rec, point);
		expect(again).toStrictEqual(whoOf(rec, point));
		expect(again.flags).not.toBe(first.flags);
		expect(cache.misses).toBe(1);

		// Through the page too: a page's arrays are its own.
		const recs = byIdOf();
		const page = onePage(recs, cache);
		for (const d of page.decisions) for (const s of d.sources) s.flags.push("rider");
		expect(JSON.stringify(onePage(recs, cache))).toBe(JSON.stringify(onePage(recs)));
	});

	it("drops an answer that neither of the last two builds used", () => {
		const id = add(MESSAGE);
		const recs = byIdOf();
		const cache = new WhoCache();
		saveDecisions([decision("d1", "other", [src(id, ["members take turns one at a time"])])]);
		onePage(recs, cache); // build 1 uses the first point
		expect(cache.size).toBe(1);
		saveDecisions([decision("d1", "other", [src(id, ["The report is written"])])]);
		onePage(recs, cache); // build 2: the first point unused once
		onePage(recs, cache); // build 3: unused twice
		expect(cache.size).toBe(2);
		onePage(recs, cache); // build 4 starts: neither build 2 nor 3 used it
		expect(cache.size).toBe(1);
		const kept = { quotes: ["The report is written"], by: "reader" };
		expect(cache.get(recs.get(id), kept)).toStrictEqual(whoOf(recs.get(id), kept));
		expect(cache.misses).toBe(2);
	});

	it("never mixes up two points whose texts hold the key's separators", () => {
		const id = add({ ...MESSAGE, ref: "rm-tea", text: "We chose tea and coffee." });
		const rec = byIdOf().get(id)!;
		const joined = { quotes: ['tea","coffee'], by: "reader" };
		const split = { quotes: ["tea", "coffee"], by: "reader" };
		expect(whoKey(rec, joined)).not.toBe(whoKey(rec, split));
		expect(whoKey(rec, { quotes: ["x"], by: 'reader","main' })).not.toBe(
			whoKey(rec, { quotes: ["x"], by: "reader", part: "main" }),
		);
		expect(whoKey(rec, { quotes: ["a\u0000b"] })).not.toBe(whoKey(rec, { quotes: ["a", "b"] }));
		expect(whoKey(undefined, { quotes: [] })).not.toBe(whoKey(rec, { quotes: [] }));

		const cache = new WhoCache();
		const a = cache.get(rec, joined);
		const b = cache.get(rec, split);
		expect(a).toStrictEqual(whoOf(rec, joined));
		expect(b).toStrictEqual(whoOf(rec, split));
		expect(a.flags).toContain("quote-not-found");
		expect(b.flags).not.toContain("quote-not-found");
		expect(cache.size).toBe(2);
	});
});
