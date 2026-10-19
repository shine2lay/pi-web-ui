/**
 * who-fill (Architecture #115, H-INIT-WHO-FILL): the who-cache filled in the background after a start. The
 * fill yields between slices; a page built after it is the cold page, with no whoOf call left; a page asked
 * for during a fill waits for it and is sent once; a watcher dropped meanwhile gets nothing; a cache cleared
 * by a replaced records file is filled again; and a failed fill still lets pages build.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { type DecisionEntry, type DecisionSourceRef, DecisionStore } from "../../server/decision-store.js";
import { buildDecisionsPage } from "../../server/decision-view.js";
import { InitiativesWatch } from "../../server/initiatives-watch.js";
import type { ServerMessage, UiDecisionsPage } from "../../server/protocol.js";
import { WhoCache } from "../../server/who-cache.js";
import { fillWhoCache, WhoFiller, type WhoFillStats } from "../../server/who-fill.js";

const T0 = Date.parse("2026-10-05T09:00:00-07:00");
let dir: string;
let records: DecisionRecords;
let store: DecisionStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "who-fill-unit-"));
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

/** n decisions over a pick, an order, a role's message and a plan change, some with changes and a missing record. */
function fixture(n = 40): void {
	const answer = add({
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
					{ label: "Review rounds", description: "Every member reviews each round" },
					{ label: "Free flow", description: "Members work in parallel" },
				],
				picked: ["Free flow"],
			},
		],
	});
	const order = add({
		source: "board",
		at: T0 + 2_000,
		from: "coo",
		to: ["temper"],
		ref: "bp-1",
		kind: "order",
		title: "No rounds",
		text: "The owner wants parallel members.",
		ownerWords: "i want each member to work in parallel, always on",
		via: "coo",
	});
	const message = add({
		source: "message",
		at: T0 + 3_000,
		from: "temper",
		to: "architecture",
		ref: "rm-1",
		kind: "fyi",
		text: "The owner decided: members take turns one at a time.",
	});
	const plan = add({
		source: "plan",
		at: T0 + 4_000,
		from: "architecture",
		ref: "arch.jsonl:10",
		task: 7,
		op: "add",
		approval: "dialog",
		chat: "Arch lead",
		plan: { title: "Who cache", goal: "Keep answers between builds" },
	});
	const change = add({
		source: "plan",
		at: T0 + 5_000,
		from: "architecture",
		ref: "arch.jsonl:20",
		task: 7,
		op: "update",
		approval: "auto",
		chat: "Arch lead",
		plan: { title: "Who cache", goal: "Keep answers" },
	});
	const decisions: DecisionEntry[] = [];
	for (let i = 0; i < n; i++) {
		const sources = [
			src(answer, ["Free flow", `x${i}`], { part: "main" }),
			src(order, ["each member to work in parallel"]),
			src(message, ["members take turns one at a time"], i % 3 === 0 ? { by: "role:temper", claimsOwner: true } : {}),
			src(i % 5 === 0 ? recordId("message", `rm-later-${i}`) : plan, ["Keep answers between builds"]),
		];
		decisions.push({
			id: `d${i}`,
			initiative: i % 4 === 0 ? null : i % 2 ? "team-in-temper" : "other",
			filedBy: "tag",
			title: `Decision d${i}`,
			what: `What d${i}`,
			at: sources[0]!.at,
			sources,
			changes:
				i % 2
					? [
							{
								id: `c${i}`,
								type: "re-recorded",
								what: "Shorter goal",
								at: T0 + 90_000 + i,
								sources: [src(change, ["Keep answers"], { was: plan })],
								by: "reader",
							},
						]
					: [],
			by: "reader",
		});
	}
	writeFileSync(join(dir, "decisions.json"), JSON.stringify({ v: 1, next: n + 1, decisions }));
	store.forget();
}

const byIdOf = (): Map<string, DecisionRecord> => new Map(records.list().map((r) => [r.id, r] as const));
const pageOf = (cache?: WhoCache, initiative?: string): UiDecisionsPage =>
	buildDecisionsPage(store, byIdOf(), readerStatus(store, undefined, T0), {
		...(initiative !== undefined ? { initiative } : {}),
		limit: 200,
		...(cache ? { whoCache: cache } : {}),
	});

/** A clock each decision's work moves on by stepMs, so slices are counted without real time. */
function fakeClock(stepMs: number): { now: () => number; tick: () => void } {
	let t = 0;
	return { now: () => t, tick: () => (t += stepMs) };
}

describe("who-fill: the fill", () => {
	it("yields between slices, each stopping once its work reaches the slice time", async () => {
		fixture(40);
		const cache = new WhoCache();
		// 10 ms per check of the clock: a 25 ms slice ends after its third decision.
		let t = 0;
		const yields: number[] = [];
		let walked = 0;
		const stats = await fillWhoCache(store.decisions(), byIdOf(), cache, {
			sliceMs: 25,
			now: () => (t += 10),
			yieldNow: async () => {
				yields.push(cache.misses);
				walked++;
			},
		});
		expect(stats).not.toBeNull();
		expect(stats!.decisions).toBe(40);
		expect(stats!.slices).toBe(walked + 1);
		expect(stats!.slices).toBeGreaterThan(5);
		// The fill gave the loop back between slices, with the cache growing each time.
		expect(yields.length).toBe(stats!.slices - 1);
		for (let i = 1; i < yields.length; i++) expect(yields[i]!).toBeGreaterThanOrEqual(yields[i - 1]!);
		expect(yields.at(-1)!).toBeGreaterThan(yields[0]!);
		// Source by source: every source of every decision and change was walked.
		expect(stats!.sources).toBe(40 * 4 + 20);
		expect(stats!.answers).toBe(cache.size);
		expect(stats!.computed).toBe(cache.misses);
	});

	it("really waits for setImmediate between slices (other work runs in between)", async () => {
		fixture(30);
		const cache = new WhoCache();
		const order: string[] = [];
		let t = 0;
		const fill = fillWhoCache(store.decisions(), byIdOf(), cache, { sliceMs: 1, now: () => (t += 1) }).then(() =>
			order.push("fill end"),
		);
		setImmediate(() => order.push("other work"));
		await fill;
		expect(order).toEqual(["other work", "fill end"]);
	});

	it("leaves a cache whose page equals a cold page, with no whoOf call left, for every selection", async () => {
		fixture(40);
		const cache = new WhoCache();
		const stats = await fillWhoCache(store.decisions(), byIdOf(), cache);
		expect(stats!.computed).toBeGreaterThan(40);
		const misses = cache.misses;
		for (const initiative of [undefined, "", "team-in-temper", "other"]) {
			expect(JSON.stringify(pageOf(cache, initiative))).toBe(JSON.stringify(pageOf(undefined, initiative)));
		}
		expect(cache.misses).toBe(misses);
	});

	it("stops at the next slice when the cache is cleared meanwhile", async () => {
		fixture(40);
		const cache = new WhoCache();
		const clock = fakeClock(10);
		let slices = 0;
		const stats = await fillWhoCache(store.decisions(), byIdOf(), cache, {
			sliceMs: 25,
			now: () => {
				clock.tick();
				return clock.now();
			},
			yieldNow: async () => {
				if (++slices === 2) cache.clear();
			},
		});
		expect(stats).toBeNull();
		expect(cache.size).toBe(0);
	});
});

/** A watch with a fill we end by hand. */
function gate(): { ready: () => Promise<void> | undefined; open: () => void; start: () => void } {
	let p: Promise<void> | undefined;
	let open = () => {};
	return {
		ready: () => p,
		start: () => {
			p = new Promise<void>((resolve) => {
				open = () => {
					p = undefined;
					resolve();
				};
			});
		},
		open: () => open(),
	};
}

const flush = () => new Promise<void>((r) => setImmediate(r));

describe("who-fill: the Initiatives watch waits for a fill", () => {
	it("a watch during a fill waits, then gets one page, however often it is asked meanwhile", async () => {
		const g = gate();
		g.start();
		let builds = 0;
		const logs: string[] = [];
		const watch = new InitiativesWatch<string>(
			() => {
				builds++;
				return { initiatives: [] } as unknown as UiDecisionsPage;
			},
			{ ready: g.ready, debounceMs: 1, log: (l) => logs.push(l) },
		);
		const got: ServerMessage[] = [];
		watch.watch("a", {}, (m) => got.push(m));
		watch.poke();
		await new Promise((r) => setTimeout(r, 10));
		expect(builds).toBe(0);
		expect(got).toEqual([]);
		g.open();
		await flush();
		expect(builds).toBe(1);
		expect(got.length).toBe(1);
		expect(logs.filter((l) => /page waited \d+ ms for the who-fill/.test(l)).length).toBe(1);
		// Without a fill, a page is built at once, as before.
		watch.poke();
		await new Promise((r) => setTimeout(r, 10));
		expect(builds).toBe(2);
	});

	it("a watcher dropped (or replaced) during the fill gets nothing; the new one gets one page", async () => {
		const g = gate();
		g.start();
		const picks: (string | undefined)[] = [];
		const watch = new InitiativesWatch<string>(
			(initiative) => {
				picks.push(initiative);
				return { initiatives: [] } as unknown as UiDecisionsPage;
			},
			{ ready: g.ready },
		);
		const dropped: ServerMessage[] = [];
		const first: ServerMessage[] = [];
		const second: ServerMessage[] = [];
		watch.watch("gone", {}, (m) => dropped.push(m));
		watch.drop("gone");
		watch.watch("b", { initiative: "one" }, (m) => first.push(m));
		watch.watch("b", { initiative: "two" }, (m) => second.push(m));
		g.open();
		await flush();
		expect(dropped).toEqual([]);
		expect(first).toEqual([]);
		expect(second.length).toBe(1);
		expect(picks).toEqual(["two"]);
	});

	it("waits for a fill that starts while it waits", async () => {
		const g = gate();
		g.start();
		let builds = 0;
		const watch = new InitiativesWatch<string>(
			() => {
				builds++;
				return { initiatives: [] } as unknown as UiDecisionsPage;
			},
			{ ready: g.ready },
		);
		watch.watch("a", {}, () => {});
		g.open();
		g.start();
		await flush();
		expect(builds).toBe(0);
		g.open();
		await flush();
		expect(builds).toBe(1);
	});
});

describe("who-fill: the filler", () => {
	it("fills again after the cache is dropped (a replaced or shrunk file), one fill at a time", async () => {
		fixture(20);
		const cache = new WhoCache();
		const ends: (WhoFillStats | null)[] = [];
		let reads = 0;
		const filler = new WhoFiller(
			cache,
			() => {
				reads++;
				return { decisions: store.decisions(), recs: byIdOf() };
			},
			{ log: () => {}, onEnd: (s) => ends.push(s) },
		);
		filler.start();
		const first = filler.pending()!;
		filler.start(); // asked again while it runs, before it read anything: covered by the same fill
		await first;
		await flush();
		expect(filler.pending()).toBeUndefined();
		expect(ends.length).toBe(1);
		expect(reads).toBe(1);
		const filled = cache.size;
		expect(filled).toBeGreaterThan(0);

		// keptRecords saw the file replaced: sawFile drops everything and asks for a fill.
		cache.sawFile(1, 100);
		expect(cache.sawFile(2, 100)).toBe(true);
		expect(cache.size).toBe(0);
		filler.start();
		await filler.pending();
		await flush();
		expect(ends.length).toBe(2);
		expect(cache.size).toBe(filled);
		const misses = cache.misses;
		expect(JSON.stringify(pageOf(cache))).toBe(JSON.stringify(pageOf()));
		expect(cache.misses).toBe(misses);
	});

	it("a drop during a fill stops it and starts another, which fills the cache", async () => {
		fixture(40);
		const cache = new WhoCache();
		const ends: (WhoFillStats | null)[] = [];
		let slices = 0;
		let filler: WhoFiller | undefined;
		filler = new WhoFiller(cache, () => ({ decisions: store.decisions(), recs: byIdOf() }), {
			log: () => {},
			sliceMs: 0,
			yieldNow: async () => {
				if (++slices === 3) {
					cache.clear();
					filler!.start();
				}
				await flush();
			},
			onEnd: (s) => ends.push(s),
		});
		filler.start();
		while (filler.pending()) await filler.pending();
		expect(ends[0]).toBeNull();
		expect(ends[1]).not.toBeNull();
		expect(ends.length).toBe(2);
		const misses = cache.misses;
		expect(JSON.stringify(pageOf(cache))).toBe(JSON.stringify(pageOf()));
		expect(cache.misses).toBe(misses);
	});

	it("a failed fill is logged, never rejects, and pages still build (the same page as without a cache)", async () => {
		fixture(10);
		const cache = new WhoCache();
		const logs: string[] = [];
		const filler = new WhoFiller(
			cache,
			() => {
				throw new Error("no store");
			},
			{ log: (l) => logs.push(l) },
		);
		filler.start();
		await expect(filler.pending()).resolves.toBeUndefined();
		await flush();
		expect(filler.pending()).toBeUndefined();
		expect(logs).toEqual(["[who-fill] failed: no store"]);
		const g = new InitiativesWatch<string>(() => pageOf(cache), { ready: () => filler.pending() });
		const got: ServerMessage[] = [];
		g.watch("a", {}, (m) => got.push(m));
		expect(got.length).toBe(1);
		expect(JSON.stringify(got[0])).toBe(JSON.stringify({ type: "initiatives", page: pageOf() }));
	});

	it("logs one line per fill with its numbers", async () => {
		fixture(10);
		const logs: string[] = [];
		const filler = new WhoFiller(new WhoCache(), () => ({ decisions: store.decisions(), recs: byIdOf() }), {
			log: (l) => logs.push(l),
		});
		filler.start();
		await filler.pending();
		expect(logs.length).toBe(1);
		expect(logs[0]).toMatch(
			/^\[who-fill\] decisions=10 sources=\d+ answers=\d+ computed=\d+ slices=\d+ longest_ms=\d+ total_ms=\d+$/,
		);
	});
});
