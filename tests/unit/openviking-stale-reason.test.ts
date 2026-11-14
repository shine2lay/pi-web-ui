/**
 * Backend #143 (ruling rm-b5272a3e, `.temper/features/openviking-dashboard/spec-states.md` §4, blind verify #138
 * row 32): a stale badge names its true reason. `audit.stale_badge` is `"> 15m"|"pending sync"|null`. Age wins
 * when both causes hold, `"pending sync"` appears only inside the cadence while a `wt land` sync waits, and a
 * sync-caused stale never reports an age. One rule (`panelHealth`) decides it; `/overview` reads a waiting sync as
 * a stale `health_state`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { panelHealth } from "../../server/openviking/overview.js";
import {
	AUDIT_CADENCE_MS,
	createOpenVikingClient,
	OPENVIKING_PENDING_SYNC_BADGE,
	type OpenVikingDashboardOptions,
} from "../../server/openviking/index.js";
import { daemon, minutesAgo, NOW } from "./openviking-daemon-fake.js";

const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

const turn = (min: number) => ({
	timestamp: minutesAgo(min),
	event: "turn_start",
	mode: "lead",
	role: "ops",
	l0_hit_count: 1,
	injected_tokens_est: 100,
});

const commit = (min: number) => ({
	timestamp: minutesAgo(min),
	source: "queue_done",
	role: "ops",
	taskId: "ops#1",
	uri: "viking://user/ops/memories/sessions/s1.md",
	action: "session_commit",
	summary: "ops session commit",
});

const pendingSync = (project: string) => ({ project, failedAt: minutesAgo(9), error: "sync error" });

/** The two causes the ruling distinguishes: how old the newest data is, and whether a `wt land` sync waits. */
interface StateOptions {
	dataAgeMin: number;
	pendingSyncs: number;
}

describe("stale_badge names its true reason (Backend #143, ruling rm-b5272a3e)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	const stateDir = ({ dataAgeMin, pendingSyncs }: StateOptions) => {
		const dir = mkdtempSync(join(tmpdir(), "ov-stale-reason-"));
		dirs.push(dir);
		writeFileSync(join(dir, "metrics.jsonl"), jsonl([turn(dataAgeMin)]));
		writeFileSync(join(dir, "memory-changelog.jsonl"), jsonl([commit(dataAgeMin)]));
		writeFileSync(
			join(dir, "rollout-state.json"),
			JSON.stringify({
				phase: "phase2",
				fallback_roles: [],
				pending_wt_land_syncs: Array.from({ length: pendingSyncs }, (_u, i) => pendingSync(`project-${i}`)),
			}),
		);
		return dir;
	};

	const client = (state: StateOptions, opts: OpenVikingDashboardOptions = {}) =>
		createOpenVikingClient({ stateDir: stateDir(state), fetchImpl: daemon().fetchImpl, now: () => NOW, ...opts });

	/** (a)-(d) of the ruling, at the audit's cadence and age badge. */
	it("one rule: age wins, a pending sync inside the cadence reads 'pending sync'", () => {
		const inCadence = NOW - AUDIT_CADENCE_MS + 1_000;
		const pastCadence = NOW - AUDIT_CADENCE_MS - 1_000;
		const syncs = (pending: number) => ({ pending, badge: OPENVIKING_PENDING_SYNC_BADGE });
		const verdict = (lastMs: number, pending: number) =>
			panelHealth(1, lastMs, NOW, AUDIT_CADENCE_MS, "> 15m" as const, syncs(pending));

		expect(verdict(inCadence, 0)).toEqual({ health_state: "healthy", stale_badge: null });
		expect(verdict(inCadence, 2)).toEqual({ health_state: "stale", stale_badge: "pending sync" });
		expect(verdict(pastCadence, 0)).toEqual({ health_state: "stale", stale_badge: "> 15m" });
		expect(verdict(pastCadence, 2)).toEqual({ health_state: "stale", stale_badge: "> 15m" });
	});

	it("overview: a waiting sync reads stale, none reads live, for a live /health", async () => {
		const healthy = await client({ dataAgeMin: 1, pendingSyncs: 0 }).getOverview();
		expect(healthy).toMatchObject({ screen_state: "live", health_state: "healthy" });

		const waiting = await client({ dataAgeMin: 1, pendingSyncs: 2 }).getOverview();
		expect(waiting).toMatchObject({ screen_state: "stale", health_state: "stale" });
	});

	it("audit: 'pending sync' inside the cadence, '> 15m' past it, the age when both hold", async () => {
		const fresh = await client({ dataAgeMin: 1, pendingSyncs: 0 }).getAudit({});
		expect(fresh.events.length).toBeGreaterThan(0);
		expect(fresh).toMatchObject({ health_state: "healthy", stale_badge: null });

		const freshWaiting = await client({ dataAgeMin: 1, pendingSyncs: 2 }).getAudit({});
		expect(freshWaiting).toMatchObject({ health_state: "stale", stale_badge: "pending sync" });

		const old = await client({ dataAgeMin: 42, pendingSyncs: 0 }).getAudit({});
		expect(old).toMatchObject({ health_state: "stale", stale_badge: "> 15m" });

		const oldWaiting = await client({ dataAgeMin: 42, pendingSyncs: 2 }).getAudit({});
		expect(oldWaiting).toMatchObject({ health_state: "stale", stale_badge: "> 15m" });
	});

	it("overview: data past the metrics and changelog cadences reads stale", async () => {
		const old = await client({ dataAgeMin: 42, pendingSyncs: 0 }).getOverview();
		expect(old).toMatchObject({ screen_state: "stale", health_state: "stale" });
	});
});
