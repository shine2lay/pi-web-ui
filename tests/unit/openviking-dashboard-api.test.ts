/**
 * Backend #132: the OpenViking dashboard API beyond Task 1's acceptance suite: cross-role isolation (no
 * `/api/v1/content/*` call for a personal URI), old and new telemetry names in the same files (Ops #808-#810),
 * `:1933` down or slow, the read-only HTTP boundary (non-GET 405, nothing written, nothing sent upstream), and (#136)
 * queue depth never scraped (R-QUEUE-DEPTH-1) and (#137) `changelog.session_commits_24h` counting session commits only
 * (spec "Session Commits", rm-9724bae9, rm-84facfcf): a queue_done add to a role-memory URI is not one, only to a session URI.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import {
	createOpenVikingClient,
	handleOpenVikingEntriesRequest,
	ISOLATED_AGENT_MEMORY_ABSTRACT,
	OPENVIKING_ROLES,
	registerOpenVikingRoutes,
	type OpenVikingDashboardOptions,
	type OpenVikingEntriesResponse,
} from "../../server/openviking/index.js";
import { registerRouteModules } from "../../server/route-modules.js";
import { daemon, minutesAgo, NOW } from "./openviking-daemon-fake.js";

const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

/** metrics.jsonl and memory-changelog.jsonl mix pre-#809 and contract field names, as on spark. */
const MIXED_METRICS = [
	{
		timestamp: minutesAgo(4),
		event: "turn_start",
		mode: "lead_l0",
		role: "ops",
		l0_hits: 2,
		tokens_est: 100,
		rm_dedup_skipped_count: 1,
	},
	{
		timestamp: minutesAgo(3),
		event: "worker_prefetch_inject",
		role: "qa",
		l0_hit_count: 0,
		l1_expanded_count: 1,
		injected_tokens_est: 300,
		dedup_skipped_count: 2,
	},
	{
		timestamp: minutesAgo(2),
		event: "turn_start",
		mode: "lead",
		role: "backend",
		project: "pi-web-ui",
		l0_hit_count: 1,
		injected_tokens_est: 200,
		slots: [
			{ slot: 1, state: "hit", l0_hit_count: 1, injected_tokens_est: 120 },
			{ slot: 4, state: "miss", l0_hits: 0, tokens_est: 80 },
		],
	},
];
const change = (min: number, action: string, role: string, uri: string, summary: string, source = "test") => ({
	timestamp: minutesAgo(min),
	source,
	role,
	taskId: `${role}#7`,
	uri,
	action,
	summary,
});
const MIXED_CHANGELOG = [
	change(9, "session_commit", "ops", "viking://user/ops/memories/cases/old.md", "ops private old-name commit"),
	change(8, "add", "qa", "viking://agent/memories/cases/new.md", "qa private new-name write", "queue_done"),
	change(7, "preference_write", "ops", "viking://user/default/memories/preferences/backend_code.md", "old promote"),
	change(6, "update", "architecture", "viking://user/memories/preferences/frontend_code.md", "new promote"),
	change(5, "preference_write_blocked", "backend", "viking://user/default/memories/preferences/x.md", "old reject"),
	change(4, "reject_preference_candidate", "backend", "viking://user/memories/preferences/y.md", "new reject"),
];

function seed(dir: string, files: Record<string, object | object[]>) {
	for (const [name, value] of Object.entries(files)) {
		writeFileSync(join(dir, name), Array.isArray(value) ? jsonl(value) : JSON.stringify(value));
	}
}

const snapshot = (dir: string) => readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]);

describe("OpenViking dashboard API (Backend #132)", () => {
	const dirs: string[] = [];
	const servers: Server[] = [];
	afterEach(async () => {
		for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});
	const stateDir = (files: Record<string, object | object[]> = {}) => {
		const dir = mkdtempSync(join(tmpdir(), "ov-dash-api-"));
		dirs.push(dir);
		seed(dir, { "metrics.jsonl": MIXED_METRICS, "memory-changelog.jsonl": MIXED_CHANGELOG, ...files });
		return dir;
	};
	const client = (opts: OpenVikingDashboardOptions) => createOpenVikingClient({ now: () => NOW, ...opts });

	it("R-ISOLATION-1: no /api/v1/content/* call for any role's memory, personal content is a 403, summaries redacted", async () => {
		const { fetchImpl, calls } = daemon();
		const c = client({ stateDir: stateDir(), fetchImpl });

		const all = await c.getEntries({ scope: "all" });
		const personal = all.entries.filter((e) => e.scope === "agent");
		expect(new Set(personal.map((e) => e.role))).toEqual(new Set(OPENVIKING_ROLES));
		for (const e of personal) {
			expect(e).toMatchObject({ l0_abstract: ISOLATED_AGENT_MEMORY_ABSTRACT, l1_overview: null, l2_content: null });
			expect(e.layers).toEqual([]);
		}
		expect(all.entries.find((e) => e.scope === "resources")?.l0_abstract).toBe("pi-web-ui L0 abstract");
		expect(all.entries.find((e) => e.scope === "user")?.l0_abstract).toContain("/api/v1/content/abstract");

		const contentUris = calls
			.filter((x) => x.url.pathname.startsWith("/api/v1/content/"))
			.map((x) => x.url.searchParams.get("uri"));
		expect(contentUris.length).toBeGreaterThan(0);
		for (const uri of contentUris) expect(uri).toMatch(/^viking:\/\/(resources|user\/default)\//);
		const opsListing = calls.find((x) => x.url.searchParams.get("uri") === "viking://user/ops/memories");
		expect(opsListing?.headers).toEqual({
			"X-OpenViking-Account": "default",
			"X-OpenViking-User": "ops",
			"X-OpenViking-Agent": "ops",
		});

		const before = calls.length;
		for (const query of [
			{ uri: "viking://agent/memories/cases/c1.md", role: "qa", tier: "L1" },
			{ uri: "viking://user/qa/memories/cases/c1.md", include_content: "true" },
		]) {
			expect((await handleOpenVikingEntriesRequest(c, query, "GET")).status).toBe(403);
		}
		await expect(c.readContentTier("viking://agent/memories/cases/c1.md", "L2", { role: "ops" })).rejects.toMatchObject(
			{
				statusCode: 403,
			},
		);
		expect(calls.length).toBe(before);

		const audit = await c.getAudit({});
		// #139 (R-CHANGELOG-1d): a queue_done add to a role's memory, not to a session URI, is a role memory write.
		for (const [uri, action] of [
			["viking://user/ops/memories/cases/old.md", "commit"],
			["viking://agent/memories/cases/new.md", "role_memory_write"],
		]) {
			const ev = audit.events.find((e) => e.uri === uri);
			expect(ev).toMatchObject({ action, summary_1line: ISOLATED_AGENT_MEMORY_ABSTRACT });
			expect(ev?.l0_abstract).toBe(ISOLATED_AGENT_MEMORY_ABSTRACT);
		}
		expect(audit.events.find((e) => e.raw_action === "update")?.summary_1line).toBe("new promote");
		const activity = (await c.getOverview()).live_activity;
		expect(activity.find((a) => a.role === "qa" && a.action === "add")?.summary_1line).toBe(
			ISOLATED_AGENT_MEMORY_ABSTRACT,
		);
		expect(JSON.stringify([audit, activity])).not.toContain("private");
		expect(calls.every((x) => x.method === "GET")).toBe(true);
	});

	it("reads old and new telemetry names from the same files (G2-G7)", async () => {
		const { fetchImpl, calls } = daemon();
		const dir = stateDir({
			"rollout-state.json": { stage: "phase2-live", updated_at: minutesAgo(30), pending_wt_land_syncs: [] },
			"migration-verification.json": {
				checked_at: "2026-11-11T00:53:35.455Z",
				status: "PASS",
				source_files: ["a", "b", "c"],
			},
			"seen-role-messages.json": { "rm-1": { role: "ops" }, "rm-2": { role: "qa" }, "rm-3": { role: "qa" } },
		});
		const o = await client({ stateDir: dir, fetchImpl }).getOverview();

		expect(o.metrics).toMatchObject({
			turns_sampled_24h: 3,
			avg_injected_tokens: 200,
			mode1_lead_l0_injections_24h: 2,
			mode2_worker_turn1_prefetches_24h: 1,
			rm_dedup_skipped_24h: 3,
			health_state: "healthy",
		});
		expect(o.metrics.slot_hit_rate_pct).toBeCloseTo(66.7, 1);
		expect(o.slots.map((s) => [s.slot_id, s.hit_rate_pct, s.avg_tokens])).toEqual([
			[1, 100, 120],
			[2, null, null],
			[3, null, null],
			[4, 0, 80],
			[5, null, null],
		]);
		expect(o.slots.filter((s) => s.state === "unmeasured-gap").map((s) => s.slot_id)).toEqual([2, 3, 5]);
		expect(o.changelog).toMatchObject({
			session_commits_24h: 1,
			promotions_24h: 2,
			rejected_24h: 2,
			health_state: "healthy",
		});
		expect(o.auxiliary.rollout).toMatchObject({ stage: "phase2-live", updated_at: minutesAgo(30) });
		expect(o.auxiliary.migration).toMatchObject({ verified_at: "2026-11-11T00:53:35.455Z", total_checked: 3 });
		expect(o.auxiliary.dedup.seen_count).toBe(3);
		// Spec 2500874d field table: `rollout-state.json` read with an empty `pending_wt_land_syncs` is `0`
		// pending and `"ok"` — "looked and none pending", not "missing" (Backend #153).
		expect(o.auxiliary.resource_sync).toEqual({
			pending_syncs_count: 0,
			status: "ok",
			synced_at: null,
			repos_synced: null,
		});
		// R-QUEUE-DEPTH-1 (spec G1, Architecture rm-a374e16b): unavailable in v1, never scraped, never 0.
		expect(o.observer.queue_depth).toBeNull();
		expect(calls.some((c) => c.url.pathname === "/api/v1/observer/queue")).toBe(false);

		const audit = await client({ stateDir: dir, fetchImpl }).getAudit({ action: "reject_noise" });
		expect(audit.events.map((e) => [e.raw_action, e.guard_verdict])).toEqual([
			["reject_preference_candidate", "rejected"],
			["preference_write_blocked", "rejected"],
		]);
	});

	it("#809 per-slot lines: skipped and unavailable slots made no lookup, so they are not misses", async () => {
		const slot = (n: number, state: string, hits: number, tokens: number) => ({
			slot: n,
			name: `slot${n}`,
			state,
			uris: [],
			l0_hit_count: hits,
			l1_expanded_count: hits,
			injected_tokens_est: tokens,
		});
		const line = (min: number, s3: string) => ({
			timestamp: minutesAgo(min),
			event: "worker_prefetch_inject",
			role: "ops",
			chat_mode: "worker",
			project: "pi-web-ui",
			l0_hit_count: 2,
			l1_expanded_count: 2,
			injected_tokens_est: 400,
			slots: [
				slot(1, "skipped", 0, 0),
				slot(2, "unavailable", 0, 0),
				slot(3, s3, 0, 0),
				slot(4, "hit", 2, 328),
				slot(5, "miss", 0, 0),
			],
		});
		const { fetchImpl } = daemon();
		const dir = stateDir({ "metrics.jsonl": [line(2, "miss"), line(1, "skipped")] });
		const o = await client({ stateDir: dir, fetchImpl }).getOverview();
		expect(o.slots.map((s) => [s.slot_id, s.hit_rate_pct, s.avg_tokens])).toEqual([
			[1, null, null],
			[2, null, null],
			[3, 0, 0],
			[4, 100, 328],
			[5, 0, 0],
		]);
		expect(o.slots.every((s) => s.state !== "unmeasured-gap")).toBe(true);
		expect(o.metrics).toMatchObject({
			turns_sampled_24h: 2,
			mode2_worker_turn1_prefetches_24h: 2,
			avg_injected_tokens: 400,
		});
	});

	it("#156 slots 1-3 look up by project: a turn with no project is not a slot 1-3 sample, whatever state it recorded", async () => {
		type SlotRow = [state: string, hits: number, tokens: number];
		const turn = (min: number, project: string | null, rows: SlotRow[]) => ({
			timestamp: minutesAgo(min),
			event: "worker_prefetch_inject",
			role: "qa",
			session_id: `01a1cb7f-f95a-7723-8686-${String(min).padStart(12, "0")}`,
			chat_mode: "worker",
			project,
			l0_hit_count: 1,
			injected_tokens_est: 100,
			slots: rows.map(([state, hits, tokens], i) => ({
				slot: i + 1,
				state,
				l0_hit_count: hits,
				injected_tokens_est: tokens,
			})),
		});
		// The pre-cutoff defect row as on spark (QA #136 F2): no project, slots 1-2 skipped, slot 3 a "miss".
		const preCutoff = turn(50, null, [
			["skipped", 0, 0],
			["skipped", 0, 0],
			["miss", 0, 0],
			["hit", 1, 200],
			["hit", 1, 100],
		]);
		// A later no-project turn that still recorded a state for slots 1-3: excluded all the same.
		const laterNoProject = turn(10, null, [
			["miss", 0, 0],
			["hit", 1, 900],
			["miss", 0, 0],
			["miss", 0, 0],
			["miss", 0, 0],
		]);
		const rows = [
			preCutoff,
			turn(30, "pi-web-ui", [
				["hit", 1, 300],
				["hit", 1, 100],
				["hit", 1, 200],
				["hit", 2, 400],
				["miss", 0, 0],
			]),
			turn(20, "rollcall", [
				["hit", 1, 100],
				["miss", 0, 0],
				["hit", 1, 220],
				["miss", 0, 0],
				["miss", 0, 0],
			]),
			laterNoProject,
		];
		const { fetchImpl } = daemon();
		const o = await client({ stateDir: stateDir({ "metrics.jsonl": rows }), fetchImpl }).getOverview();
		// Slots 1-3 read the two project turns only; slots 4-5 still read all four turns.
		expect(o.slots.map((s) => [s.slot_id, s.hit_rate_pct, s.avg_tokens, s.last_sampled_at])).toEqual([
			[1, 100, 200, minutesAgo(20)],
			[2, 50, 50, minutesAgo(20)],
			[3, 100, 210, minutesAgo(20)],
			[4, 50, 150, minutesAgo(10)],
			[5, 25, 25, minutesAgo(10)],
		]);
		// Totals are not per-slot figures: every turn still counts there.
		expect(o.metrics.turns_sampled_24h).toBe(4);

		// No-project turns alone: slots 1-3 were never measured (not a 0% rate); slots 4-5 are.
		const onlyNoProject = await client({
			stateDir: stateDir({ "metrics.jsonl": [preCutoff, laterNoProject] }),
			fetchImpl,
		}).getOverview();
		expect(onlyNoProject.slots.map((s) => [s.slot_id, s.hit_rate_pct, s.state === "unmeasured-gap"])).toEqual([
			[1, null, true],
			[2, null, true],
			[3, null, true],
			[4, 50, false],
			[5, 50, false],
		]);
	});

	it(":1933 down or past the 2000 ms deadline: Offline with null daemon figures, never zeros; files still read", async () => {
		expect(createOpenVikingClient().timeoutMs).toBe(2000);
		for (const mode of ["down", "hang"] as const) {
			const { fetchImpl } = daemon(mode);
			const c = client({ stateDir: stateDir(), fetchImpl, timeoutMs: 50 });
			const o = await c.getOverview();
			expect(o).toMatchObject({ screen_state: "error", health_state: "server-unreachable" });
			expect(o.observer).toMatchObject({
				mode_label: "Offline",
				health_state: "server-unreachable",
				role_memory_folder_count: null,
				queue_depth: null,
				retrieval_latency_avg_ms: null,
				retrieval_hit_rate_pct: null,
			});
			expect(Object.values(o.observer.store_counts.layer1_shared).every((v) => v === null)).toBe(true);
			expect(Object.values(o.observer.store_counts.layer2_personal).every((v) => v === null)).toBe(true);
			expect(o.metrics.turns_sampled_24h).toBe(3);
			expect(o.changelog.session_commits_24h).toBe(1);

			const entries = await c.getEntries({ scope: "all" });
			expect(entries).toMatchObject({ health_state: "server-unreachable", entries: [] });
			const one = await handleOpenVikingEntriesRequest(c, { uri: "viking://resources/pi-web-ui", tier: "L1" }, "GET");
			expect(one.status).toBe(503);
			expect((await c.getAudit({ limit: "2" })).events).toHaveLength(2);
		}
	});

	it("a missed deadline is retried once (pi-web-ui's event loop can stall ~2 s), a refused connection is not", async () => {
		const stalled = daemon("stall-once");
		const o = await client({ stateDir: stateDir(), fetchImpl: stalled.fetchImpl, timeoutMs: 50 }).getOverview();
		expect(o.screen_state).not.toBe("error");
		expect(o.observer.mode_label).not.toBe("Offline");
		expect(o.observer.role_memory_folder_count).toBe(OPENVIKING_ROLES.length);
		expect(stalled.calls.filter((c) => c.url.pathname === "/health")).toHaveLength(2);

		const down = daemon("down");
		const offline = await client({ stateDir: stateDir(), fetchImpl: down.fetchImpl }).getOverview();
		expect(offline.observer.mode_label).toBe("Offline");
		expect(down.calls.filter((c) => c.url.pathname === "/health")).toHaveLength(1);
	});

	it("serves only GET over HTTP: other methods get 405 with Allow: GET, nothing reaches :1933 or the state files", async () => {
		const { fetchImpl, calls } = daemon();
		const dir = stateDir();
		const before = snapshot(dir);
		const app = express();
		registerOpenVikingRoutes(app, { stateDir: dir, fetchImpl, now: () => NOW });
		const server = createServer(app).listen(0, "127.0.0.1");
		servers.push(server);
		await new Promise((r) => server.once("listening", r));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/openviking`;

		for (const path of ["overview", "entries", "audit"]) {
			for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
				const res = await fetch(`${base}/${path}`, {
					method,
					body: "{}",
					headers: { "Content-Type": "application/json" },
				});
				expect(res.status).toBe(405);
				expect(res.headers.get("allow")).toBe("GET");
			}
		}
		expect(calls).toHaveLength(0);

		expect((await fetch(`${base}/overview`)).status).toBe(200);
		const entries = await fetch(`${base}/entries?scope=agent&role=ops`);
		expect(((await entries.json()) as OpenVikingEntriesResponse).entries.map((e) => e.role)).toEqual(["ops"]);
		for (const bad of ["entries?scope=everything", "entries?role=root", "audit?limit=0", "audit?action=delete_all"]) {
			const res = await fetch(`${base}/${bad}`);
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_ARGUMENT");
		}
		expect(calls.every((x) => x.method === "GET")).toBe(true);
		expect(snapshot(dir)).toEqual(before);
	});

	it("server start-up mounts the three endpoints (registerRouteModules)", async () => {
		const app = express();
		registerRouteModules(app, () => undefined);
		const server = createServer(app).listen(0, "127.0.0.1");
		servers.push(server);
		await new Promise((r) => server.once("listening", r));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/openviking`;
		for (const path of ["overview", "entries", "audit"]) {
			const res = await fetch(`${base}/${path}`, { method: "DELETE" });
			expect([res.status, res.headers.get("allow")]).toEqual([405, "GET"]);
		}
	});

	it("Session Commits: session_commits_24h and last_commit_at count session commits only (queue_done + 200K lead), old and new names", async () => {
		const { fetchImpl } = daemon();
		const session = (min: number, action: string, uri: string, source: string) =>
			change(min, action, "ops", uri, "session commit", source);
		const write = (min: number, action: string, role: string, source: string) =>
			change(min, action, role, `viking://user/${role}/memories/cases/c${min}.md`, "role memory write", source);
		const dir = stateDir({
			"memory-changelog.jsonl": [
				change(25 * 60, "add", "ops", "viking://session/old-day", "older than 24 h", "queue_done"),
				session(30, "session_commit", "viking://user/ops/memories/cases/old-name.md", "queue_done"),
				session(29, "add", "viking://session/20261111-a", "queue_done"),
				session(28, "add", "viking://session/20261111-b/history/archive_001", "session_commit_200k"),
				write(27, "added", "architecture", "migration"),
				write(26, "updated", "backend", "migration"),
				write(25, "add", "qa", "migration"),
				write(24, "added", "marketing", "lead_direct"),
				write(23, "updated", "marketing", "lead_direct"),
				change(22, "update", "ops", "viking://resources/rollcall/core/gotchas.md", "Synced", "queue_done"),
				change(21, "add", "ops", "viking://resources/rollcall/core/new.md", "Synced", "queue_done"),
			],
		});
		const o = await client({ stateDir: dir, fetchImpl }).getOverview();
		expect(o.changelog).toMatchObject({ session_commits_24h: 3, promotions_24h: 2, rejected_24h: 0 });
		expect(o.observer.last_commit_at).toBe(minutesAgo(28));
		expect(o.changelog.last_event_at).toBe(minutesAgo(21));
	});
});
