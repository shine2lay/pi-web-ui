/**
 * Backend #143 (ruling rm-b5272a3e, `.temper/features/openviking-dashboard/spec-states.md` §4, blind verify #138
 * row 32): a stale badge names its true reason. `observer.stale_badge` is `"> 30s"|"pending sync"|null`,
 * `entries.stale_badge` and `audit.stale_badge` are `"> 15m"|"pending sync"|null`. Age wins when both causes hold,
 * `"pending sync"` appears only inside the cadence while a `wt land` sync waits, and a sync-caused stale never
 * reports an age. One rule (`panelHealth`) decides it for all three panels; metrics and changelog stay age-only.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { panelHealth } from "../../server/openviking/overview.js";
import {
	AUDIT_CADENCE_MS,
	createOpenVikingClient,
	ENTRIES_CADENCE_MS,
	OPENVIKING_PENDING_SYNC_BADGE,
	OVERVIEW_OBSERVER_CADENCE_MS,
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

	/**
	 * (a)-(d) of the ruling, for each panel's own cadence and age badge. `entries` and `observer` read `:1933` live,
	 * so (c) and (d) can only reach them through this rule — their data is fetched during the request and is never
	 * past its cadence, which is exactly why neither may print an age (the #138 row 32 bug).
	 */
	it("one rule for all three panels: age wins, a pending sync inside the cadence reads 'pending sync'", () => {
		const panels = [
			{ panel: "observer", cadenceMs: OVERVIEW_OBSERVER_CADENCE_MS, ageBadge: "> 30s" as const },
			{ panel: "entries", cadenceMs: ENTRIES_CADENCE_MS, ageBadge: "> 15m" as const },
			{ panel: "audit", cadenceMs: AUDIT_CADENCE_MS, ageBadge: "> 15m" as const },
		];
		for (const { panel, cadenceMs, ageBadge } of panels) {
			const inCadence = NOW - cadenceMs + 1_000;
			const pastCadence = NOW - cadenceMs - 1_000;
			const syncs = (pending: number) => ({ pending, badge: OPENVIKING_PENDING_SYNC_BADGE });
			const verdict = (lastMs: number, pending: number) =>
				panelHealth(1, lastMs, NOW, cadenceMs, ageBadge, syncs(pending));

			expect({ panel, ...verdict(inCadence, 0) }).toEqual({ panel, health_state: "healthy", stale_badge: null });
			expect({ panel, ...verdict(inCadence, 2) }).toEqual({
				panel,
				health_state: "stale",
				stale_badge: "pending sync",
			});
			expect({ panel, ...verdict(pastCadence, 0) }).toEqual({ panel, health_state: "stale", stale_badge: ageBadge });
			expect({ panel, ...verdict(pastCadence, 2) }).toEqual({ panel, health_state: "stale", stale_badge: ageBadge });
		}
	});

	it("observer: 'pending sync' while syncs wait, null when none, never an age for a live /health", async () => {
		const healthy = await client({ dataAgeMin: 1, pendingSyncs: 0 }).getOverview();
		expect(healthy.observer).toMatchObject({ health_state: "healthy", stale_badge: null });

		const waiting = await client({ dataAgeMin: 1, pendingSyncs: 2 }).getOverview();
		expect(waiting.observer).toMatchObject({
			health_state: "stale",
			stale_badge: "pending sync",
			mode_label: "Degraded Local Fallback",
		});
		expect(waiting.screen_state).toBe("stale");
		expect(waiting.observer.stale_badge).not.toMatch(/>\s*\d/);
	});

	it("entries: a sync-caused stale reads 'pending sync', never the false '> 15m' of #138 row 32", async () => {
		const healthy = await client({ dataAgeMin: 1, pendingSyncs: 0 }).getEntries({ scope: "resources" });
		expect(healthy.entries.length).toBeGreaterThan(0);
		expect(healthy).toMatchObject({ health_state: "healthy", stale_badge: null });

		const waiting = await client({ dataAgeMin: 1, pendingSyncs: 2 }).getEntries({ scope: "resources" });
		expect(waiting).toMatchObject({ health_state: "stale", stale_badge: "pending sync" });
		expect(waiting.stale_badge).not.toMatch(/>\s*\d/);
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

	it("metrics and changelog stay age-only: a pending sync never writes their badge (ruling names three panels)", async () => {
		const waiting = await client({ dataAgeMin: 1, pendingSyncs: 2 }).getOverview();
		expect(waiting.metrics).toMatchObject({ health_state: "healthy", stale_badge: null });
		expect(waiting.changelog).toMatchObject({ health_state: "healthy", stale_badge: null });

		const old = await client({ dataAgeMin: 42, pendingSyncs: 2 }).getOverview();
		expect(old.metrics.stale_badge).toBe("> 5m");
		expect(old.changelog.stale_badge).toBe("> 15m");
	});
});
