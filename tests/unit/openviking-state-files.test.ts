/**
 * Backend #137: spec 2677060e / 3a56d6a3 (Architecture rm-19da6607, rm-9724bae9, rm-84facfcf) and Ops #810's verified
 * telemetry names (rm-43f3ed93). Each state-file reader takes the #810 names and the older ones in the same file;
 * `session_commits_24h` counts a session committing its own work only, classified by URI + source, never one name;
 * `role_memory_folder_count` counts canonical `viking://user/<role>/memories` folders and never feeds a verdict.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenVikingClient, OPENVIKING_ROLES } from "../../server/openviking/index.js";
import {
	readChangelogRecords,
	readMetricsRecords,
	resolveOpenVikingStatePaths,
} from "../../server/openviking/state-files.js";

const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const ok = (result: unknown) =>
	new Response(JSON.stringify({ status: "ok", healthy: true, result }), {
		headers: { "Content-Type": "application/json" },
	});
const notFound = () => new Response(JSON.stringify({ status: "error", error: { code: "NOT_FOUND" } }), { status: 404 });

/** A `:1933` stand-in where only `withFolder` roles have a `viking://user/<role>/memories` folder. */
function daemon(withFolder: readonly string[] = OPENVIKING_ROLES, up = true): typeof fetch {
	return async (input) => {
		if (!up) throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:1933");
		const url = new URL(String(input));
		if (url.pathname === "/health") return ok(undefined);
		if (url.pathname === "/api/v1/observer/system") return ok({ components: {} });
		if (url.pathname !== "/api/v1/fs/ls") return notFound();
		const uri = url.searchParams.get("uri") ?? "";
		const role = /^viking:\/\/user\/([a-z]+)\/memories$/.exec(uri)?.[1];
		if (role === undefined || role === "default") return ok([]);
		return withFolder.includes(role) ? ok([]) : notFound();
	};
}

const write = (dir: string, name: string, value: object | object[]) =>
	writeFileSync(
		join(dir, name),
		Array.isArray(value) ? value.map((v) => `${JSON.stringify(v)}\n`).join("") : JSON.stringify(value),
	);

const change = (min: number, action: string, uri: string, source: string, role = "ops") => ({
	timestamp: minutesAgo(min),
	source,
	role,
	taskId: 820,
	uri,
	action,
	summary: "s",
});

describe("OpenViking state files and spec 2677060e (Backend #137)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});
	const stateDir = (files: Record<string, object | object[]> = {}) => {
		const dir = mkdtempSync(join(tmpdir(), "ov-state-files-"));
		dirs.push(dir);
		for (const [name, value] of Object.entries(files)) write(dir, name, value);
		return dir;
	};
	const overview = (dir: string, fetchImpl = daemon()) =>
		createOpenVikingClient({ stateDir: dir, fetchImpl, now: () => NOW }).getOverview();

	it("session commits (#521): queue_done / session_commit_200k adds to a session URI, old and new names; nothing else", async () => {
		const lines: [object, boolean][] = [
			[change(40, "add", "viking://session/20261111-105926-f1fd1b0f", "queue_done"), true],
			[change(39, "added", "viking://session/20261110-a", "queue_done"), true],
			[change(38, "session_commit", "viking://user/ops/memories/cases/old.md", "queue_done"), true],
			[change(37, "add", "viking://session/20261111-b/history/archive_001", "session_commit_200k"), true],
			[change(36, "add", "viking://user/ops/sessions/20261111-c", "queue_done"), true],
			[change(35, "updated", "viking://user/backend/memories/cases/c.md", "migration", "backend"), false],
			[change(34, "update", "viking://user/backend/memories/cases/c.md", "migration", "backend"), false],
			[change(33, "added", "viking://user/marketing/memories/cases/m.md", "lead_direct", "marketing"), false],
			[change(32, "add", "viking://user/marketing/memories/cases/m.md", "lead_direct", "marketing"), false],
			[change(31, "updated", "viking://user/marketing/memories/cases/m.md", "lead_direct", "marketing"), false],
			[change(30, "update", "viking://user/marketing/memories/cases/m.md", "lead_direct", "marketing"), false],
			[change(29, "add", "viking://agent/memories/cases/q.md", "queue_done", "qa"), false],
			[change(28, "update", "viking://session/20261111-d", "queue_done"), false],
			[change(27, "add", "viking://session/20261111-e", "migration"), false],
			[change(26, "add", "viking://resources/rollcall/core/new.md", "queue_done"), false],
			[change(25, "sync_resource_failed", "viking://resources/product-autopilot", "wt_land"), false],
		];
		const dir = stateDir({ "memory-changelog.jsonl": lines.map(([line]) => line) });

		const records = await readChangelogRecords(resolveOpenVikingStatePaths(dir));
		expect(records.map((r) => r.sessionCommit)).toEqual(lines.map(([, commit]) => commit));

		const o = await overview(dir);
		expect(o.changelog.session_commits_24h).toBe(5);
		expect(o.changelog).not.toHaveProperty("commits_24h");
		expect(o.observer.last_commit_at).toBe(minutesAgo(36));
	});

	it("sync_resource_failed is not a memory write: kept out of every changelog count and the panel's freshness", async () => {
		const failed = (min: number) =>
			change(min, "sync_resource_failed", "viking://resources/product-autopilot", "wt_land");
		const o = await overview(stateDir({ "memory-changelog.jsonl": [failed(3), failed(2)] }));
		expect(o.changelog).toMatchObject({
			session_commits_24h: 0,
			promotions_24h: 0,
			rejected_24h: 0,
			last_event_at: null,
			health_state: "zero-activity",
		});

		const mixed = stateDir({
			"memory-changelog.jsonl": [change(20, "sync_resource", "viking://resources/rollcall", "wt_land"), failed(1)],
		});
		expect((await overview(mixed)).changelog).toMatchObject({ promotions_24h: 1, last_event_at: minutesAgo(20) });
	});

	it("role_memory_folder_count: canonical role folders found (0..15), never liveness, never a degraded verdict", async () => {
		const some = OPENVIKING_ROLES.slice(0, 12);
		const o = await overview(stateDir(), daemon(some));
		expect(o.observer).toMatchObject({
			role_memory_folder_count: 12,
			roles_total_count: 15,
			mode_label: "Active",
			health_state: "healthy",
		});
		expect(o.observer).not.toHaveProperty("roles_online_count");
		expect(o.screen_state).not.toBe("stale");
		expect((await overview(stateDir(), daemon([]))).observer).toMatchObject({
			role_memory_folder_count: 0,
			mode_label: "Active",
		});

		const down = await overview(stateDir(), daemon(OPENVIKING_ROLES, false));
		expect(down.observer).toMatchObject({ role_memory_folder_count: null, mode_label: "Offline", queue_depth: null });

		const fallback = stateDir({ "rollout-state.json": { stage: "partial", fallback_roles: ["qa"] } });
		expect((await overview(fallback)).observer.mode_label).toBe("Degraded Local Fallback");
	});

	it("metrics.jsonl: #810 worker_prefetch_inject slots[] feed the slot strip; old turn_start lines stay totals only", async () => {
		const slot = (n: number, name: string, state: string, hits: number, tokens: number) => ({
			slot: n,
			name,
			state,
			uris: hits ? [`viking://user/ops/memories/cases/c${n}.md`] : [],
			l0_hit_count: hits,
			l1_expanded_count: hits,
			injected_tokens_est: tokens,
		});
		const dir = stateDir({
			"metrics.jsonl": [
				{ timestamp: minutesAgo(3), event: "turn_start", mode: "lead_l0", role: "ops", l0_hits: 1, tokens_est: 100 },
				{
					timestamp: minutesAgo(2),
					event: "worker_prefetch_inject",
					role: "architecture",
					session_id: "s1",
					chat_mode: "worker",
					project: null,
					l0_hit_count: 2,
					l1_expanded_count: 2,
					injected_tokens_est: 2247,
					degraded_slots: [],
					dropped_slots: [],
					slots: [
						slot(1, "project_overview", "skipped", 0, 0),
						slot(2, "shared_entity", "skipped", 0, 0),
						slot(3, "matching_spec", "miss", 0, 0),
						slot(4, "role_cases", "hit", 2, 1048),
						slot(5, "sibling_docs", "miss", 0, 0),
					],
				},
			],
		});
		const o = await overview(dir);
		expect(o.metrics).toMatchObject({ turns_sampled_24h: 2, avg_injected_tokens: 1174, slot_hit_rate_pct: 100 });
		expect(o.slots.map((s) => [s.slot_id, s.hit_rate_pct, s.avg_tokens])).toEqual([
			[1, null, null],
			[2, null, null],
			[3, 0, 0],
			[4, 100, 1048],
			[5, 0, 0],
		]);

		const noSlots = stateDir({
			"metrics.jsonl": [{ timestamp: minutesAgo(1), event: "turn_start", role: "ops", l0_hits: 0, tokens_est: 5 }],
		});
		expect((await overview(noSlots)).slots.every((s) => s.state === "unmeasured-gap")).toBe(true);
	});

	it("metrics.jsonl: post_task_digest extracted_count null stays null (not measured), never 0; old names still read", async () => {
		const digest = (min: number, fields: object) => ({
			timestamp: minutesAgo(min),
			event: "post_task_digest",
			role: "ops",
			taskId: 820,
			...fields,
		});
		const dir = stateDir({
			"metrics.jsonl": [
				digest(4, { extracted_count: null, dedup_skipped_count: 2, rm_dedup_skipped_count: 2 }),
				digest(3, { extracted_count: 0, dedup_skipped_count: 0, rm_dedup_skipped_count: 0 }),
				digest(2, { extracted: 3, dedup_skipped: 1 }),
				digest(1, {}),
			],
		});
		const records = await readMetricsRecords(resolveOpenVikingStatePaths(dir));
		expect(records.map((r) => [r.extractedCount, r.dedupSkippedCount])).toEqual([
			[null, 2],
			[0, 0],
			[3, 1],
			[null, null],
		]);
		expect((await overview(dir)).metrics.rm_dedup_skipped_24h).toBe(3);
	});

	it("rollout-state.json and migration-verification.json: #810 names and the older ones", async () => {
		const live = await overview(
			stateDir({
				"rollout-state.json": {
					stage: "full",
					updated_at: minutesAgo(5),
					fallback_roles: [],
					pending_wt_land_syncs: [],
				},
				"migration-verification.json": {
					verified_at: minutesAgo(60),
					status: "PASS",
					total_checked: 21,
					roles_passed: 15,
					total_roles: 15,
					repos_passed: 6,
					total_repos: 6,
				},
			}),
		);
		expect(live.auxiliary.rollout).toMatchObject({ stage: "full", updated_at: minutesAgo(5) });
		expect(live.auxiliary.migration).toMatchObject({
			verified_at: minutesAgo(60),
			status: "PASS",
			total_checked: 21,
			roles_passed: 15,
			total_roles: 15,
			repos_passed: 6,
			total_repos: 6,
		});

		const old = await overview(
			stateDir({
				"rollout-state.json": { phase: "phase2", cutover_ts: minutesAgo(600), pending_wt_land_syncs: [] },
				"migration-verification.json": { verified_at: minutesAgo(90), total_roles: 15, total_repos: 6 },
			}),
		);
		expect(old.auxiliary.rollout).toMatchObject({ stage: null, updated_at: minutesAgo(600) });
		expect(old.auxiliary.migration).toMatchObject({ verified_at: minutesAgo(90), total_checked: 21 });
	});

	it("seen-role-messages.json: schema_version or version envelope; an absent file gives null fields, not 0 or an error", async () => {
		const entries = { "rm-51ac955d": { role: "ops" }, "rm-dd387b45": { role: "product" } };
		const current = stateDir({
			"seen-role-messages.json": { schema_version: 1, updated_at: minutesAgo(7), entries },
		});
		expect((await overview(current)).auxiliary.dedup).toEqual({ seen_count: 2, updated_at: minutesAgo(7) });

		const older = stateDir({ "seen-role-messages.json": { version: 1, updated_at: minutesAgo(8), entries: {} } });
		expect((await overview(older)).auxiliary.dedup).toEqual({ seen_count: 0, updated_at: minutesAgo(8) });

		const absent = await overview(stateDir());
		expect(absent.auxiliary.dedup).toEqual({ seen_count: null, updated_at: null });
		expect(absent.screen_state).not.toBe("error");
	});
});
