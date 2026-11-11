/**
 * Backend #137: spec 2677060e / 3a56d6a3 (Architecture rm-19da6607, rm-9724bae9, rm-84facfcf) and Ops #810's verified
 * telemetry names (rm-43f3ed93). Each state-file reader takes the #810 names and the older ones in the same file;
 * `session_commits_24h` counts a session committing its own work only, classified by URI + source, never one name;
 * `role_memory_folder_count` counts canonical `viking://user/<role>/memories` folders and never feeds a verdict.
 * Backend #139 (Architecture #523 rm-0964900e, contract R-CHANGELOG-1d, spec c5c47e6 §3): a row's audit action is
 * decided by URI namespace + `source`, never the verb; "commit" is the session-commit classifier above, so audit
 * commits in 24h equal `session_commits_24h`, and migration / lead_direct role writes are `role_memory_write`.
 * Lines are read by the contract key names only (`timestamp`, `source`).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditActionOf } from "../../server/openviking/activity.js";
import {
	createOpenVikingClient,
	ISOLATED_AGENT_MEMORY_ABSTRACT,
	OPENVIKING_ROLES,
	WINDOW_24H_MS,
	type OpenVikingAuditAction,
} from "../../server/openviking/index.js";
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

const SHARED_PREF = "viking://user/default/memories/preferences";
const MARKETING_CASE = "viking://user/marketing/memories/cases/m.md";
const GUARD = "worker_preference_guard";

/** #139: one row per R-CHANGELOG-1d case, old (past tense, spec G4) and new (contract) names, with its audit action. */
const AUDIT_CASES: [ReturnType<typeof change>, OpenVikingAuditAction | null][] = [
	// Session commit: a session's own URI from queue_done / session_commit_200k (pre-rename `session_commit`).
	[change(60, "add", "viking://session/20261111-a", "queue_done"), "commit"],
	[change(59, "added", "viking://session/20261111-b", "queue_done"), "commit"],
	[change(58, "add", "viking://session/20261111-c/history/archive_001", "session_commit_200k"), "commit"],
	[change(57, "session_commit", "viking://user/ops/memories/cases/old.md", "queue_done"), "commit"],
	// Role memory write: any other add/update/delete on viking://user/<role>/ (alias viking://agent/).
	[change(56, "updated", "viking://user/backend/memories/cases/c.md", "migration", "backend"), "role_memory_write"],
	[change(55, "update", "viking://user/backend/memories/cases/c.md", "migration", "backend"), "role_memory_write"],
	[change(54, "added", MARKETING_CASE, "lead_direct", "marketing"), "role_memory_write"],
	[change(53, "add", MARKETING_CASE, "lead_direct", "marketing"), "role_memory_write"],
	[change(52, "updated", MARKETING_CASE, "lead_direct", "marketing"), "role_memory_write"],
	[change(51, "update", "viking://agent/memories/cases/m.md", "lead_direct", "marketing"), "role_memory_write"],
	[change(50, "deleted", "viking://user/qa/memories/cases/q.md", "lead_direct", "qa"), "role_memory_write"],
	[change(49, "add", "viking://agent/memories/cases/q.md", "queue_done", "qa"), "role_memory_write"],
	[change(48, "update", "viking://session/20261111-d", "queue_done"), "role_memory_write"],
	[change(47, "add", "viking://session/20261111-e", "migration"), "role_memory_write"],
	// Shared write: viking://resources/ or viking://user/default/ (alias viking://user/memories/).
	[change(46, "updated", `${SHARED_PREF}/backend_code.md`, "migration"), "promote_shared"],
	[change(45, "added", `${SHARED_PREF}/x.md`, "lead_direct"), "promote_shared"],
	[change(44, "update", "viking://user/memories/preferences/frontend_code.md", "lead_promotion"), "promote_shared"],
	[change(43, "preference_write", `${SHARED_PREF}/y.md`, "lead_promotion"), "promote_shared"],
	[change(42, "update", "viking://resources/architecture-conventions/contract.md", "manual"), "promote_shared"],
	[change(41, "updated", "viking://resources/pi-web-ui/spec.md", "wt_land_sync"), "promote_shared"],
	[change(40, "add", "viking://resources/rollcall/core/new.md", "queue_done"), "promote_shared"],
	[change(39, "sync_resource", "viking://resources/rollcall/", "wt_land"), "promote_shared"],
	[change(38, "resource_sync", "viking://resources/rollcall/", "wt_land_sync"), "promote_shared"],
	// Preference rows keep their own verdicts, whatever the URI.
	[change(37, "promote_preference_candidate", `${SHARED_PREF}/z.md`, "lead_promotion"), "promote_shared"],
	[change(36, "reject_preference_candidate", `${SHARED_PREF}/z.md`, GUARD), "reject_noise"],
	[change(35, "reject_preference_candidate", "viking://user/ops/memories/p.md", GUARD), "reject_noise"],
	[change(34, "reject_preference_candidate", "backend", GUARD, "backend"), "reject_noise"],
	[change(33, "preference_write_blocked", `${SHARED_PREF}/x.md`, GUARD), "reject_noise"],
	// A failed resource sync wrote nothing.
	[change(32, "sync_resource_failed", "viking://resources/product-autopilot", "wt_land"), "sidecar_timeout"],
	// An action no writer is known to emit stays out of the audit.
	[change(31, "renamed", "viking://user/ops/memories/cases/r.md", "lead_direct"), null],
];

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
	const client = (dir: string, fetchImpl = daemon()) =>
		createOpenVikingClient({ stateDir: dir, fetchImpl, now: () => NOW });
	const overview = (dir: string, fetchImpl = daemon()) => client(dir, fetchImpl).getOverview();

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

	it("#139 audit actions by URI namespace + source, old and new names; migration and lead_direct are never commit", async () => {
		const dir = stateDir({ "memory-changelog.jsonl": AUDIT_CASES.map(([row]) => row) });
		const records = await readChangelogRecords(resolveOpenVikingStatePaths(dir));
		expect(records.map(auditActionOf)).toEqual(AUDIT_CASES.map(([, action]) => action));

		const audit = await client(dir).getAudit({ limit: "500" });
		const byId = new Map(audit.events.map((e) => [e.id, e]));
		AUDIT_CASES.forEach(([row, action], i) => {
			expect(byId.get(`changelog:${i + 1}`)?.action, `${row.action} ${row.source} ${row.uri}`).toBe(
				action ?? undefined,
			);
		});
		const roleWrites = audit.events.filter(
			(e) => ["migration", "lead_direct"].includes(e.source) && /^viking:\/\/(user\/(?!default\/)|agent\/)/.test(e.uri),
		);
		expect(roleWrites.map((e) => e.action)).toEqual(Array(7).fill("role_memory_write"));
		for (const e of audit.events.filter((x) => x.action === "role_memory_write")) {
			expect(e).toMatchObject({
				guard_verdict: "allowed",
				summary_1line: ISOLATED_AGENT_MEMORY_ABSTRACT,
				l0_abstract: ISOLATED_AGENT_MEMORY_ABSTRACT,
			});
		}

		const filtered = await client(dir).getAudit({ action: "role_memory_write" });
		expect(filtered.events.map((e) => e.id).sort()).toEqual(
			AUDIT_CASES.flatMap(([, action], i) => (action === "role_memory_write" ? [`changelog:${i + 1}`] : [])).sort(),
		);
	});

	it('#139 audit "commit" rows in 24h equal changelog.session_commits_24h', async () => {
		const dir = stateDir({
			"memory-changelog.jsonl": [
				change(25 * 60, "add", "viking://session/yesterday", "queue_done"),
				change(25 * 60, "updated", "viking://user/backend/memories/cases/old.md", "migration", "backend"),
				...AUDIT_CASES.map(([row]) => row),
			],
		});
		const o = await overview(dir);
		const commits = (await client(dir).getAudit({ action: "commit", limit: "500" })).events;
		const commitsIn24h = commits.filter((e) => NOW - Date.parse(e.ts) <= WINDOW_24H_MS).length;

		expect(commits).toHaveLength(5);
		expect(o.changelog.session_commits_24h).toBe(4);
		expect(commitsIn24h).toBe(o.changelog.session_commits_24h);
		expect(o.changelog).toMatchObject({ promotions_24h: 10, rejected_24h: 4 });
	});

	it("#139 lines are read by the contract key names only: timestamp envelope, source (rm-0964900e)", async () => {
		const dir = stateDir({
			"memory-changelog.jsonl": [
				{ ...change(5, "sync_resource", "viking://resources/rollcall/", "wt_land"), trigger: "wt_land" },
				{ ts: minutesAgo(4), source: "queue_done", role: "ops", action: "add", uri: "viking://session/x" },
				{ timestamp: minutesAgo(3), trigger: "wt_land", role: "ops", action: "update", uri: "viking://resources/a" },
			],
			"metrics.jsonl": [
				{ timestamp: minutesAgo(2), event: "lead_200k_commit", role: "ops" },
				{ ts: minutesAgo(1), event: "lead_200k_commit", role: "ops" },
			],
		});
		const paths = resolveOpenVikingStatePaths(dir);
		expect((await readChangelogRecords(paths)).map((r) => [r.line, r.source])).toEqual([
			[1, "wt_land"],
			[3, "unknown"],
		]);
		expect((await readMetricsRecords(paths)).map((m) => m.line)).toEqual([1]);
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
