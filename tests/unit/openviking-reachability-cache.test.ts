/**
 * Backend #147 (blind verify #144 row 33): `/overview` reports the daemon down only when `/health` fails.
 *
 * Contract (spec-states.md §4): `error` = `/health` fails. Reachability is `/health`'s alone, and since the explorer
 * replaced the dashboard (#164) `/overview` makes no other `:1933` call at all, so no listing can turn it `error`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenVikingClient, type OpenVikingOverviewResponse } from "../../server/openviking/index.js";
import { daemon, minutesAgo, NOW, type DaemonMode } from "./openviking-daemon-fake.js";

const iso = (ms: number) => new Date(ms).toISOString();
const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

const METRICS = [{ timestamp: minutesAgo(2), event: "turn_start", mode: "lead", role: "backend" }];
const CHANGELOG = [
	{
		timestamp: minutesAgo(3),
		source: "queue_done",
		role: "backend",
		taskId: "backend#147",
		uri: "viking://session/147",
		action: "session_commit",
		summary: "task #147 commit",
	},
];

describe("Offline only when /health fails (Backend #147)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	/** One client = one server process: its own transport, its own pinned clock. */
	const setup = (mode: DaemonMode = "up") => {
		const dir = mkdtempSync(join(tmpdir(), "ov-reach-"));
		dirs.push(dir);
		writeFileSync(join(dir, "metrics.jsonl"), jsonl(METRICS));
		writeFileSync(join(dir, "memory-changelog.jsonl"), jsonl(CHANGELOG));
		const fake = daemon(mode);
		const clock = { t: NOW };
		const client = createOpenVikingClient({
			stateDir: dir,
			fetchImpl: fake.fetchImpl,
			timeoutMs: 50,
			now: () => clock.t,
		});
		return { fake, clock, client };
	};

	// (a)
	it("/health ok with fs/ls hung: live, never unreachable, and /health is the only :1933 call", async () => {
		const { fake, client } = setup("up");
		fake.state.hangLsMatching = "viking://user/ops/memories";

		const o = await client.getOverview();

		expect(o).toMatchObject({ screen_state: "live", health_state: "healthy" });
		expect(o.observer).toEqual({
			checked_at: iso(NOW),
			last_reachable_at: iso(NOW),
			last_commit_at: minutesAgo(3),
		});
		expect(fake.calls.map((c) => c.url.pathname)).toEqual(["/health"]);
	});

	// (b)
	it("/health failing: screen_state error, last_reachable_at null, last_commit_at still read from the file", async () => {
		for (const mode of ["down", "hang", "unhealthy"] as const) {
			const { client } = setup(mode);
			const o = await client.getOverview();

			expect(o).toMatchObject({ screen_state: "error", health_state: "server-unreachable" });
			expect(o.observer).toEqual({ checked_at: iso(NOW), last_reachable_at: null, last_commit_at: minutesAgo(3) });
		}
	});

	// (c)
	it("never claims unreachable with a last_reachable_at later than its own checked_at (#144 fingerprint)", async () => {
		const holds = (o: OpenVikingOverviewResponse) =>
			o.health_state !== "server-unreachable" ||
			o.observer.last_reachable_at === null ||
			Date.parse(o.observer.last_reachable_at) <= Date.parse(o.observer.checked_at);

		const hung = setup("up");
		hung.fake.state.hangLsMatching = "viking://user/ops/memories";
		const real = createOpenVikingClient({
			stateDir: mkdtempSync(join(tmpdir(), "ov-reach-real-")),
			fetchImpl: hung.fake.fetchImpl,
			timeoutMs: 50,
		});
		dirs.push(real.stateDir);
		for (const o of [await real.getOverview(), await hung.client.getOverview()]) expect(holds(o)).toBe(true);
		for (const mode of ["down", "hang", "unhealthy"] as const) {
			const { client } = setup(mode);
			expect(holds(await client.getOverview())).toBe(true);
		}

		// Asserted, not merely unreachable in practice: the impossible pair fails loudly instead of being served.
		const back = setup("up");
		back.clock.t = NOW + 10 * 60_000;
		await back.client.getOverview();
		back.fake.state.mode = "down";
		back.clock.t = NOW;
		await expect(back.client.getOverview()).rejects.toThrow(/unreachable/i);
	});
});
