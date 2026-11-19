// @vitest-environment jsdom
// pages-fresh (Ops #245, H-PAGES-FRESH-1 in docs/pages-fresh.md): the background refresher (server/pages-fresh.ts)
// and the copy it keeps (RolesWatch.refresh).
import { afterEach, describe, expect, it, vi } from "vitest";
import { PagesRefresher } from "../../server/pages-fresh.js";
import type { UiRolesOverview } from "../../server/protocol.js";
import { RolesWatch } from "../../server/roles-overview.js";

/** A promise the test settles by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

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
