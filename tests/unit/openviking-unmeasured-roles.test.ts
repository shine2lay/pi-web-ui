/**
 * Backend #149 (blind verify #148 rows 37-38): a read the daemon failed is unmeasured, never an absence.
 *
 * Row 37: five roles' `fs/ls` answered `503` while their folders were there, and the page showed
 * `10/15 role memory folders` with `layer2_personal` summed over the ten it had read — a wrong figure
 * presented as measured, under an `Active` / `healthy` header. The two daemon answers are now told apart at
 * the source: `NOT_FOUND` on the role's root listing is an absence (counted as a folder that is not there),
 * every other failure (503, 500, a missed deadline, a refused connection) leaves that role unmeasured, and
 * one unmeasured role nulls the whole personal layer.
 *
 * Row 38: a refresh whose listings fail no longer discards the last good tree. Inside
 * `MEMORY_TREE_MAX_SERVE_AGE_MS` the held tree keeps answering; only past that bound do the counts go null.
 *
 * Reachability is untouched: `/health` alone decides it (spec-states.md §4, Backend #147).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createOpenVikingClient,
	MEMORY_TREE_MAX_SERVE_AGE_MS,
	OPENVIKING_ROLES,
	OVERVIEW_OBSERVER_CADENCE_MS,
	type OpenVikingOverviewResponse,
} from "../../server/openviking/index.js";
import { daemon, minutesAgo, NOW } from "./openviking-daemon-fake.js";

const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
/** The fake daemon answers on microtasks; one macrotask is enough for a refresh started in the background. */
const settle = () => new Promise((r) => setTimeout(r, 20));
const allNull = (counts: Record<string, number | null>) => Object.values(counts).every((v) => v === null);
const noneNull = (counts: Record<string, number | null>) => Object.values(counts).every((v) => v !== null);

const METRICS = [{ timestamp: minutesAgo(2), event: "turn_start", mode: "lead", role: "backend", l0_hit_count: 1 }];
const CHANGELOG = [
	{
		timestamp: minutesAgo(3),
		source: "queue_done",
		role: "backend",
		taskId: "backend#149",
		uri: "viking://session/149",
		action: "session_commit",
		summary: "task #149 commit",
	},
];

/** The header a wrong count hid behind in #148: live screen, Active, healthy — it must stay that way. */
function expectHealthyHeader(o: OpenVikingOverviewResponse) {
	expect(o.screen_state).toBe("live");
	expect(o.health_state).toBe("healthy");
	expect(o.observer.mode_label).toBe("Active");
	expect(o.observer.health_state).toBe("healthy");
}

describe("a daemon error on a role listing is unmeasured, never a missing folder (Backend #149)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	/** One client = one server process: its own transport, its own held tree, its own pinned clock. */
	const setup = () => {
		const dir = mkdtempSync(join(tmpdir(), "ov-unmeasured-"));
		dirs.push(dir);
		writeFileSync(join(dir, "metrics.jsonl"), jsonl(METRICS));
		writeFileSync(join(dir, "memory-changelog.jsonl"), jsonl(CHANGELOG));
		const fake = daemon("up");
		const clock = { t: NOW };
		const client = createOpenVikingClient({
			stateDir: dir,
			fetchImpl: fake.fetchImpl,
			timeoutMs: 50,
			now: () => clock.t,
		});
		return { fake, clock, client };
	};

	// (a) row 37: five roles answer 503 while their folders exist.
	it("nulls the folder count and the whole personal layer when five roles' listings answer 503", async () => {
		const { fake, client } = setup();
		fake.state.errorLsRoles = ["design", "docs", "marketing", "qa", "temper"];

		const o = await client.getOverview();

		// The defect: 10 of 15 counted as measured, with layer2 summed over the ten that answered.
		expect(o.observer.role_memory_folder_count).toBeNull();
		expect(allNull(o.observer.store_counts.layer2_personal)).toBe(true);
		expect(o.observer.roles_total_count).toBe(OPENVIKING_ROLES.length);
		// Nothing partial and nothing zeroed is ever shown as a measured figure.
		for (const v of Object.values(o.observer.store_counts.layer2_personal)) expect(v).not.toBe(0);
		expect(o.observer.role_memory_folder_count).not.toBe(OPENVIKING_ROLES.length - 5);
		// A failed listing says nothing about reachability, and the shared layer is untouched.
		expectHealthyHeader(o);
		expect(o.observer.stale_badge).toBeNull();
		expect(o.observer.store_counts.layer1_shared.repo_trees_count).toBe(1);
		expect(o.observer.store_counts.layer1_shared.total_count).not.toBeNull();
	});

	// (b) a genuine absence still counts: the figure stays measured.
	it("counts a folder the daemon says is not there, and keeps the figure measured", async () => {
		const { fake, client } = setup();
		fake.state.absentRoles = ["marketing"];

		const o = await client.getOverview();

		expect(o.observer.role_memory_folder_count).toBe(OPENVIKING_ROLES.length - 1);
		expect(noneNull(o.observer.store_counts.layer2_personal)).toBe(true);
		expect(o.observer.store_counts.layer2_personal.cases_count).toBe(OPENVIKING_ROLES.length - 1);
		expectHealthyHeader(o);
	});

	// (b2) the two answers are told apart in the same walk.
	it("tells one absent role from one failing role in the same walk: unmeasured wins over a partial count", async () => {
		const { fake, client } = setup();
		fake.state.absentRoles = ["marketing"];
		fake.state.errorLsRoles = ["qa"];

		const o = await client.getOverview();

		expect(o.observer.role_memory_folder_count).toBeNull();
		expect(allNull(o.observer.store_counts.layer2_personal)).toBe(true);
		expect(o.observer.role_memory_folder_count).not.toBe(OPENVIKING_ROLES.length - 2);
	});

	// (c) row 38: a failed refresh keeps the last good tree inside the documented bound.
	it("keeps the last good tree while refreshes fail inside the serve-age bound, and nulls only past it", async () => {
		const { fake, clock, client } = setup();
		const first = await client.getOverview();
		expect(first.observer.role_memory_folder_count).toBe(OPENVIKING_ROLES.length);

		fake.state.failAllLs = true;

		// Past the cadence, far inside the bound: the held tree answers while the failing refresh runs.
		clock.t = NOW + OVERVIEW_OBSERVER_CADENCE_MS + 1_000;
		const held = await client.getOverview();
		expect(held.observer.role_memory_folder_count).toBe(OPENVIKING_ROLES.length);
		expect(held.observer.store_counts.layer1_shared.repo_trees_count).toBe(1);
		expectHealthyHeader(held);
		await settle();

		// Still inside the bound after that refresh failed: the good tree was not discarded.
		clock.t = NOW + 100_000;
		const stillHeld = await client.getOverview();
		expect(stillHeld.observer.role_memory_folder_count).toBe(OPENVIKING_ROLES.length);
		expect(stillHeld.observer.store_counts.layer2_personal.total_count).toBe(
			first.observer.store_counts.layer2_personal.total_count,
		);
		await settle();

		// Past the bound: unmeasured, never the old figure and never 0.
		clock.t = NOW + MEMORY_TREE_MAX_SERVE_AGE_MS + 1_000;
		const tooOld = await client.getOverview();
		expect(tooOld.observer.role_memory_folder_count).toBeNull();
		expect(allNull(tooOld.observer.store_counts.layer1_shared)).toBe(true);
		expect(allNull(tooOld.observer.store_counts.layer2_personal)).toBe(true);
		expectHealthyHeader(tooOld);

		// Not a dead end: once the listings answer again the counts come back.
		fake.state.failAllLs = false;
		await settle();
		clock.t = NOW + MEMORY_TREE_MAX_SERVE_AGE_MS + 40_000;
		await client.getOverview();
		await settle();
		const recovered = await client.getOverview();
		expect(recovered.observer.role_memory_folder_count).toBe(OPENVIKING_ROLES.length);
		expect(noneNull(recovered.observer.store_counts.layer2_personal)).toBe(true);
	});

	// (d) the harness `refreshfail` sequence: no load may read 0 folders or 0 memories under an Active header.
	it("never reports 0 folders or a 0 personal layer as measured while refreshes keep failing", async () => {
		const { fake, clock, client } = setup();
		await client.getOverview();
		fake.state.failAllLs = true;

		for (const offsetS of [31, 45, 100, 140, 200]) {
			clock.t = NOW + offsetS * 1_000;
			const o = await client.getOverview();
			const folders = o.observer.role_memory_folder_count;
			const personal = o.observer.store_counts.layer2_personal;
			expect(folders === null || folders === OPENVIKING_ROLES.length).toBe(true);
			expect(folders).not.toBe(0);
			expect(personal.total_count).not.toBe(0);
			expect(allNull(personal) || noneNull(personal)).toBe(true);
			expect(o.observer.mode_label).toBe("Active");
			expect(o.screen_state).not.toBe("error");
			await settle();
		}
	});
});
