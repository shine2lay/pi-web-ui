import { afterEach, describe, expect, it, vi } from "vitest";
import {
	isOpenGaveWay,
	makeOpenChain,
	type OpenChainTiming,
	type OpenJob,
	openJobsConflict,
} from "../../server/open-chain.js";

/**
 * open-chain (Ops #641, H-OPEN-CHAIN-1): the queue every chat open goes through. Jobs that finish keep their order
 * and never overlap (as before); a job that passes its bound stops holding the queue up, its caller gets an honest
 * error, and what it may still touch (its window, its transcript) stays its own until it ends. Fake clocks: nothing
 * here depends on how busy the machine is.
 */

const job = (label: string, owner: string, disk: OpenJob["disk"] = null): OpenJob => ({ label, owner, disk });

function chainWithLog(timing: OpenChainTiming) {
	const lines: string[] = [];
	const chain = makeOpenChain({ timing: () => timing, log: (l) => lines.push(l) });
	return { chain, lines };
}

const T: OpenChainTiming = { boundMs: 300_000, slowAfterMs: 60_000, slowEveryMs: 60_000 };

afterEach(() => {
	vi.useRealTimers();
});

describe("open-chain: jobs that finish", () => {
	it("run one at a time, in order, and pass their results and errors through", async () => {
		const { chain, lines } = chainWithLog(T);
		let running = 0;
		let most = 0;
		const order: string[] = [];
		const step =
			(name: string, fail = false) =>
			async () => {
				running++;
				most = Math.max(most, running);
				order.push(`start ${name}`);
				await new Promise((r) => setImmediate(r));
				order.push(`end ${name}`);
				running--;
				if (fail) throw new Error(`${name} failed`);
				return name;
			};
		const a = chain(job("a", "w1"), step("a"));
		const b = chain(job("b", "w2"), step("b", true));
		const c = chain(job("c", "w1"), step("c"));
		await expect(a).resolves.toBe("a");
		await expect(b).rejects.toThrow("b failed");
		await expect(c).resolves.toBe("c");
		expect(most).toBe(1);
		expect(order).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
		expect(lines).toEqual([]);
	});
});

describe("open-chain: a job that never finishes", () => {
	it("is named in the log after a minute, once a minute, and gives way at its bound; the next open goes ahead", async () => {
		vi.useFakeTimers();
		const { chain, lines } = chainWithLog(T);
		let unstick!: () => void;
		const stuck = chain(
			job("new chat in /home/x", "ops-live-look-632"),
			() => new Promise<string>((r) => (unstick = () => r("late"))),
		);
		const stuckSettled = stuck.then(
			() => "resolved",
			(e: unknown) => e,
		);
		let laterDone = false;
		const later = chain(job("open /s/a.jsonl in /home/x", "owner-tab", "/s/a.jsonl"), async () => "opened").then(
			(v) => {
				laterDone = true;
				return v;
			},
		);

		await vi.advanceTimersByTimeAsync(59_999);
		expect(lines).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("still running after 60 s: new chat in /home/x (window ops-live-look-632)");
		expect(lines[0]).toContain("1 open(s) waiting behind it");
		await vi.advanceTimersByTimeAsync(60_000 * 3);
		expect(lines.filter((l) => l.includes("still running"))).toHaveLength(4);
		expect(laterDone).toBe(false);

		await vi.advanceTimersByTimeAsync(60_000);
		const err = await stuckSettled;
		expect(isOpenGaveWay(err)).toBe(true);
		expect((err as Error).message).toContain('"new chat in /home/x" was still running after 300 s');
		await expect(later).resolves.toBe("opened");
		expect(lines.some((l) => l.includes("gave way after 300 s: new chat in /home/x (window ops-live-look-632)"))).toBe(
			true,
		);
		expect(chain.held().map((h) => h.job.owner)).toEqual(["ops-live-look-632"]);

		// Its own late end is logged and lets go of what it held.
		unstick();
		await vi.advanceTimersByTimeAsync(0);
		expect(chain.held()).toEqual([]);
		expect(lines.at(-1)).toContain("ended");
		expect(lines.at(-1)).toContain("its caller had already been told it failed");
	});

	it("a later open of the same window waits for it, and gives way without ever starting if it doesn't end", async () => {
		vi.useFakeTimers();
		const { chain, lines } = chainWithLog(T);
		void chain(job("new chat", "w1"), () => new Promise(() => {})).catch(() => {});
		await vi.advanceTimersByTimeAsync(300_000); // the first gives way
		let started = false;
		const same = chain(job("open /s/b.jsonl", "w1", "/s/b.jsonl"), async () => {
			started = true;
		}).catch((e: unknown) => e);
		let otherDone = false;
		const other = chain(job("new chat", "w2"), async () => "w2 ok").then((v) => {
			otherDone = true;
			return v;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(lines.some((l) => l.includes("open /s/b.jsonl (window w1) waits for new chat (window w1)"))).toBe(true);
		// While it waits it is out of the line: the other window's open doesn't wait behind it.
		expect(otherDone).toBe(true);
		await vi.advanceTimersByTimeAsync(300_000);
		const err = await same;
		expect(isOpenGaveWay(err)).toBe(true);
		expect((err as { started: boolean }).started).toBe(false);
		expect(started).toBe(false);
		await expect(other).resolves.toBe("w2 ok");
	});

	it("a later open of the same window starts as soon as the stuck one ends, and the late result goes to onLate", async () => {
		vi.useFakeTimers();
		const { chain } = chainWithLog(T);
		let unstick!: () => void;
		const late: string[] = [];
		void chain(
			job("client create (most recent chat)", "w1"),
			() => new Promise<string>((r) => (unstick = () => r("late window"))),
			(v) => late.push(v),
		).catch(() => {});
		await vi.advanceTimersByTimeAsync(300_000);
		const next = chain(job("new chat", "w1"), async () => "next ok");
		await vi.advanceTimersByTimeAsync(1000);
		unstick();
		await expect(next).resolves.toBe("next ok");
		expect(late).toEqual(["late window"]);
	});
});

describe("open-chain: what a stuck job keeps while it hasn't ended", () => {
	const recent = (dir: string, file: string | null) => ({ dir, newest: () => file });
	it("its window, and the transcript it may open; nothing else", () => {
		const held = job("open /s/x/a.jsonl", "w1", "/s/x/a.jsonl");
		expect(openJobsConflict(held, job("new chat", "w1"))).toBe(true);
		expect(openJobsConflict(held, job("new chat", "w2"))).toBe(false);
		expect(openJobsConflict(held, job("open", "w2", "/s/x/a.jsonl"))).toBe(true);
		expect(openJobsConflict(held, job("open", "w2", "/s/x/b.jsonl"))).toBe(false);
		// A new window that would open that same file as its folder's most recent chat waits; one that wouldn't, doesn't.
		expect(openJobsConflict(held, job("create", "w2", recent("/s/x", "/s/x/a.jsonl")))).toBe(true);
		expect(openJobsConflict(held, job("create", "w2", recent("/s/x", "/s/x/c.jsonl")))).toBe(false);
		expect(openJobsConflict(held, job("create", "w2", recent("/s/x", null)))).toBe(false);
		expect(openJobsConflict(held, job("open", "w2", "any"))).toBe(true);
	});
	it("a stuck most-recent open keeps its whole chats folder", () => {
		const held = job("create", "w1", recent("/s/x", "/s/x/a.jsonl"));
		expect(openJobsConflict(held, job("open", "w2", "/s/x/b.jsonl"))).toBe(true);
		expect(openJobsConflict(held, job("open", "w2", "/s/y/b.jsonl"))).toBe(false);
		expect(openJobsConflict(held, job("switch", "w2", recent("/s/x", "/s/x/b.jsonl")))).toBe(true);
		expect(openJobsConflict(held, job("switch", "w2", recent("/s/y", "/s/y/b.jsonl")))).toBe(false);
		expect(openJobsConflict(held, job("switch", "w2", recent("/s/x", null)))).toBe(false);
	});
});
