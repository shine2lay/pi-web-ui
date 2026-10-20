// @vitest-environment jsdom
// pages-fresh (Ops #245, H-PAGES-FRESH-1 in docs/pages-fresh.md): the background refresher (server/pages-fresh.ts),
// the copies it keeps (RolesWatch.refresh, WorkPageWatch's kept page), and the Initiatives page's own data signal
// (web/src/work-page-state.ts). The real opens and the tab return: tests/pages-fresh-test.mjs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PagesRefresher } from "../../server/pages-fresh.js";
import type { ServerMessage, UiRolesOverview, UiWorkPage } from "../../server/protocol.js";
import { RolesWatch } from "../../server/roles-overview.js";
import { WORK_PAGE_COPY_MAX_AGE_MS, WorkPageWatch, workPageFrom } from "../../server/work-page.js";
import { resetAppGlobals, setAppSend } from "../../web/src/app-globals.js";
import { resetPageLive, viewFresh } from "../../web/src/page-live.js";
import {
	receiveWorkPage,
	resendWorkPageWatch,
	resetWorkPageState,
	watchWorkPage,
	workPageConnectionLost,
	type WorkPagePayload,
} from "../../web/src/work-page-state.js";

/** A promise the test settles by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

const LINE = (ts: number, e: Record<string, unknown>) => JSON.stringify({ v: 1, seq: ts, ts, by: "owner", ...e });
const ONE_INITIATIVE = `${LINE(1, { op: "initiative.create", id: "team-plan", name: "Team plan", outcome: "Seen", doneWhen: ["Live"], lead: "ops" })}\n`;

describe("pages-fresh: the refresher", () => {
	afterEach(() => vi.useRealTimers());

	it("skips a tick while the round before is still running, and counts the round's time", async () => {
		let clock = 1_000;
		let cpu = 0;
		const rounds: Array<ReturnType<typeof deferred>> = [];
		const r = new PagesRefresher(
			() => {
				const d = deferred();
				rounds.push(d);
				return d.promise;
			},
			{ now: () => clock, cpuMs: () => cpu, reportMs: 60_000 },
		);
		const first = r.tick();
		expect(first).not.toBeNull();
		expect(r.tick()).toBeNull();
		expect(rounds).toHaveLength(1);
		clock += 120;
		cpu += 150;
		rounds[0].resolve();
		await first;
		expect(r.snapshot()).toMatchObject({ rounds: 1, skipped: 1, failed: 0, wallMs: 120, maxWallMs: 120, cpuMs: 150 });
		// the next tick runs again
		const second = r.tick();
		expect(rounds).toHaveLength(2);
		rounds[1].resolve();
		await second;
		expect(r.snapshot().rounds).toBe(2);
	});

	it("says its cost once per report span, as an upper bound in % of one core, then counts afresh", async () => {
		let clock = 0;
		let cpu = 0;
		const lines: string[] = [];
		const r = new PagesRefresher(
			async () => {
				clock += 100;
				cpu += 120;
			},
			{ now: () => clock, cpuMs: () => cpu, reportMs: 60_000, log: (l) => lines.push(l) },
		);
		for (let i = 0; i < 4; i++) {
			await r.tick();
			clock += 14_900; // one round every 15 s
		}
		expect(lines).toHaveLength(0);
		await r.tick(); // 60.1 s since the count began
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(
			/^\[pages-fresh\] 5 rounds in 60 s \(0 skipped, 0 failed\): wall mean 100 ms, max 100 ms; CPU at most 1\.00% of one core$/,
		);
		expect(r.snapshot()).toMatchObject({ rounds: 0, cpuMs: 0, since: clock });
	});

	it("says a failing round once, and keeps going", async () => {
		const lines: string[] = [];
		let n = 0;
		const r = new PagesRefresher(
			async () => {
				n++;
				throw new Error("disk trouble");
			},
			{ log: (l) => lines.push(l), reportMs: 3_600_000 },
		);
		await r.tick();
		await r.tick();
		expect(n).toBe(2);
		expect(lines).toEqual(["[pages-fresh] a round failed: disk trouble"]);
		expect(r.snapshot()).toMatchObject({ rounds: 2, failed: 2 });
	});

	it("runs every interval while started, the first one interval after the start, and stops", async () => {
		vi.useFakeTimers();
		let n = 0;
		const r = new PagesRefresher(
			async () => {
				n++;
			},
			{ everyMs: 15_000 },
		);
		r.start();
		expect(r.started).toBe(true);
		await vi.advanceTimersByTimeAsync(14_999);
		expect(n).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(n).toBe(1);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(n).toBe(2);
		r.stop();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(n).toBe(2);
	});
});

describe("pages-fresh: the work page's kept copy", () => {
	it("answers a new watch at once from the page the refresher made with no window watching", async () => {
		let clock = 1_000;
		let reads = 0;
		const page = workPageFrom(ONE_INITIATIVE, [], 0);
		const watch = new WorkPageWatch<string>(async () => ({ ...page, at: ++reads }), {
			pollMs: 60_000,
			now: () => clock,
		});
		await watch.refresh();
		expect(reads).toBe(1);
		expect(watch.copyAgeMs).toBe(0);
		clock += 14_000;
		const sent: ServerMessage[] = [];
		const done = watch.watch("w", (m) => sent.push(m));
		// at once: before anything else runs, and without making it again
		expect(sent).toEqual([{ type: "work_page", page: { ...page, at: 1 } }]);
		await done;
		expect(reads).toBe(1);
		// the poll's next look: only its time differs, so nothing is sent
		await watch.look();
		expect(reads).toBe(2);
		expect(sent).toHaveLength(1);
		watch.drop("w");
	});

	it("never passes an old or failed copy off as current: the watch waits for a look, as before", async () => {
		let clock = 0;
		let fail = false;
		let reads = 0;
		const page = workPageFrom("", [], 0);
		const watch = new WorkPageWatch<string>(
			async () => {
				reads++;
				if (fail) throw new Error("disk trouble");
				return { ...page, at: reads };
			},
			{ pollMs: 60_000, now: () => clock, log: () => {} },
		);
		await watch.refresh();
		clock += WORK_PAGE_COPY_MAX_AGE_MS + 1;
		const a: ServerMessage[] = [];
		const p = watch.watch("a", (m) => a.push(m));
		expect(a).toHaveLength(0);
		await p;
		expect(a).toEqual([{ type: "work_page", page: { ...page, at: 2 } }]);
		watch.drop("a");
		// the latest look failed: a new watch hears that, not the older good page
		fail = true;
		await watch.refresh();
		const b: ServerMessage[] = [];
		const q = watch.watch("b", (m) => b.push(m));
		expect(b).toHaveLength(0);
		await q;
		expect(b).toEqual([{ type: "work_page", error: "disk trouble" }]);
		watch.drop("b");
	});

	it("makes nothing more while a look is under way, or while a watching window's page is young", async () => {
		let clock = 0;
		const gate = deferred();
		let reads = 0;
		const page = workPageFrom("", [], 0);
		const watch = new WorkPageWatch<string>(
			async () => {
				reads++;
				if (reads === 1) await gate.promise;
				return { ...page, at: reads };
			},
			{ pollMs: 60_000, now: () => clock },
		);
		const sent: ServerMessage[] = [];
		const looking = watch.watch("w", (m) => sent.push(m));
		const refreshing = watch.refresh(5_000);
		gate.resolve();
		await Promise.all([looking, refreshing]);
		expect(reads).toBe(1);
		expect(sent).toHaveLength(1);
		// young: taken as it is
		clock += 4_000;
		await watch.refresh(5_000);
		expect(reads).toBe(1);
		// older: made again, with the refresher's own read when it gives one; unchanged, so not sent
		clock += 2_000;
		let own = 0;
		await watch.refresh(5_000, async () => {
			own++;
			return { ...page, at: 99 };
		});
		expect(own).toBe(1);
		expect(reads).toBe(1);
		expect(sent).toHaveLength(1);
		watch.drop("w");
	});
});

describe("pages-fresh: the Roles overview's kept copy", () => {
	const overview = (asks: number, text = "x"): UiRolesOverview => ({
		at: Date.now(),
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

	it("looks with no window watching, and a new watch gets that copy at once, with its time", async () => {
		let reads = 0;
		const watch = new RolesWatch<string>(async () => {
			reads++;
			return overview(2);
		});
		const made = await watch.refresh();
		expect(reads).toBe(1);
		expect(made?.asks).toHaveLength(2);
		const page: unknown[] = [];
		watch.watch("page", true, (m) => page.push(m));
		expect(page).toEqual([
			expect.objectContaining({ type: "roles", asks: 2, overview: expect.anything(), checkedAt: made?.at }),
		]);
		expect(reads).toBe(1);
		watch.stop();
	});

	it("takes a young copy as it is, sends an unchanged one to nobody, and gives null when the look failed", async () => {
		let fail = false;
		let reads = 0;
		const watch = new RolesWatch<string>(
			async () => {
				reads++;
				if (fail) throw new Error("disk trouble");
				return overview(1);
			},
			{ log: () => {} },
		);
		const page: unknown[] = [];
		watch.watch("page", true, (m) => page.push(m));
		await watch.look();
		expect(page).toHaveLength(1);
		const before = reads; // the watch's own first look may have run twice
		await watch.refresh(5_000);
		expect(reads).toBe(before);
		await watch.refresh();
		expect(reads).toBe(before + 1);
		// unchanged: only the one "checked again" a new page waits for, no overview resent
		expect(page.filter((m) => (m as { overview?: unknown }).overview)).toHaveLength(1);
		fail = true;
		expect(await watch.refresh()).toBeNull();
		watch.stop();
		expect(await watch.refresh()).toBeNull();
	});
});

describe("pages-fresh: the Initiatives page's own data signal", () => {
	const page = workPageFrom("", [], 0) as unknown as NonNullable<WorkPagePayload["page"]>;
	const sent: Array<{ type: string }> = [];
	beforeEach(() => {
		resetAppGlobals();
		resetPageLive(Date.now());
		resetWorkPageState();
		sent.length = 0;
		setAppSend((m) => {
			sent.push(m);
			return true;
		});
	});

	it("is fresh once its watch is answered, and not after a lost connection until the next answer", () => {
		expect(viewFresh("initiatives")).toBeNull();
		const undo = watchWorkPage();
		expect(sent.map((m) => m.type)).toEqual(["work_page_watch"]);
		expect(viewFresh("initiatives")).toBe(false);
		receiveWorkPage({ type: "work_page", page });
		expect(viewFresh("initiatives")).toBe(true);
		// the tab comes back to a dead socket: the page stays, its data isn't known to be current
		workPageConnectionLost();
		expect(viewFresh("initiatives")).toBe(false);
		// the new socket asks again; the answer (the server's copy) makes it fresh
		resendWorkPageWatch();
		expect(sent.map((m) => m.type)).toEqual(["work_page_watch", "work_page_watch"]);
		expect(viewFresh("initiatives")).toBe(false);
		receiveWorkPage({ type: "work_page", page });
		expect(viewFresh("initiatives")).toBe(true);
		// a failed look doesn't make it fresh
		workPageConnectionLost();
		receiveWorkPage({ type: "work_page", error: "disk trouble" });
		expect(viewFresh("initiatives")).toBe(false);
		undo();
		expect(viewFresh("initiatives")).toBe(false);
		// a page that comes with nothing watching says nothing about freshness
		receiveWorkPage({ type: "work_page", page });
		expect(viewFresh("initiatives")).toBe(false);
	});
});
