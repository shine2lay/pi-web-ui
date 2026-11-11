/**
 * Backend #132: the OpenViking dashboard API beyond Task 1's acceptance suite: cross-role isolation (no
 * `/api/v1/content/*` call for a personal URI), old and new telemetry names in the same files (Ops #808-#810),
 * `:1933` down or slow, and the read-only HTTP boundary (non-GET 405, nothing written, nothing sent upstream).
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
import { parseQueueDepth } from "../../server/openviking/observer.js";
import { registerRouteModules } from "../../server/route-modules.js";

const NOW = Date.parse("2026-11-11T08:30:00.000Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const QUEUE = ["| Queue | Pending | In Progress | Processed |", "| TOTAL | 4 | 1 | 99 |"].join("\n");

interface Call {
	url: URL;
	method: string;
	headers: Record<string, string>;
}

const ok = (result: unknown) =>
	new Response(JSON.stringify({ status: "ok", healthy: true, result }), {
		headers: { "Content-Type": "application/json" },
	});
const item = (uri: string, isDir: boolean, abstract = "") => ({
	uri,
	isDir,
	size: 1,
	modTime: minutesAgo(3),
	abstract,
});

function lsResult(uri: string): unknown[] {
	if (uri === "viking://resources") return [item("viking://resources/pi-web-ui", true, "pi-web-ui L0 abstract")];
	if (uri === "viking://user/default/memories") return [item(`${uri}/preferences`, true)];
	if (uri === "viking://user/default/memories/preferences") return [item(`${uri}/backend_code.md`, false)];
	const role = /^viking:\/\/user\/([a-z]+)\/memories(\/cases)?$/.exec(uri);
	if (role && !role[2]) return [item(`${uri}/cases`, true)];
	if (role) return [item(`${uri}/c1.md`, false)];
	return [];
}

/** A stand-in for the `:1933` daemon that records every request. */
function daemon(mode: "up" | "down" | "hang" = "up") {
	const calls: Call[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		calls.push({ url, method: init?.method ?? "GET", headers: { ...(init?.headers as Record<string, string>) } });
		if (mode === "down") throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:1933");
		if (mode === "hang") {
			return new Promise<Response>((_, reject) =>
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
			);
		}
		if (url.pathname === "/health") return ok(undefined);
		if (url.pathname === "/api/v1/observer/queue") return ok({ status: QUEUE });
		if (url.pathname === "/api/v1/observer/system") return ok({ components: {} });
		if (url.pathname === "/api/v1/fs/ls") return ok(lsResult(url.searchParams.get("uri") ?? ""));
		if (url.pathname.startsWith("/api/v1/content/")) return ok(`${url.pathname} of ${url.searchParams.get("uri")}`);
		return new Response(JSON.stringify({ status: "error", error: { code: "NOT_FOUND" } }), { status: 404 });
	};
	return { fetchImpl, calls };
}

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
		ts: minutesAgo(3),
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
		l0_hit_count: 1,
		injected_tokens_est: 200,
		slots: [
			{ slot: 1, state: "hit", l0_hit_count: 1, injected_tokens_est: 120 },
			{ slot: 4, state: "miss", l0_hits: 0, tokens_est: 80 },
		],
	},
];
const change = (min: number, action: string, role: string, uri: string, summary: string) => ({
	timestamp: minutesAgo(min),
	source: "test",
	role,
	taskId: `${role}#7`,
	uri,
	action,
	summary,
});
const MIXED_CHANGELOG = [
	change(9, "session_commit", "ops", "viking://user/ops/memories/cases/old.md", "ops private old-name commit"),
	change(8, "add", "qa", "viking://agent/memories/cases/new.md", "qa private new-name commit"),
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
		for (const uri of ["viking://user/ops/memories/cases/old.md", "viking://agent/memories/cases/new.md"]) {
			const ev = audit.events.find((e) => e.uri === uri);
			expect(ev).toMatchObject({ action: "commit", summary_1line: ISOLATED_AGENT_MEMORY_ABSTRACT });
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
		const { fetchImpl } = daemon();
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
		expect(o.changelog).toMatchObject({ commits_24h: 2, promotions_24h: 2, rejected_24h: 2, health_state: "healthy" });
		expect(o.auxiliary.rollout).toMatchObject({ stage: "phase2-live", updated_at: minutesAgo(30) });
		expect(o.auxiliary.migration).toMatchObject({ verified_at: "2026-11-11T00:53:35.455Z", total_checked: 3 });
		expect(o.auxiliary.dedup.seen_count).toBe(3);
		expect(o.auxiliary.resource_sync.status).toBe("missing");
		expect(o.observer.queue_depth).toBe(5);

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
				roles_online_count: null,
				queue_depth: null,
				retrieval_latency_avg_ms: null,
				retrieval_hit_rate_pct: null,
			});
			expect(Object.values(o.observer.store_counts.layer1_shared).every((v) => v === null)).toBe(true);
			expect(Object.values(o.observer.store_counts.layer2_personal).every((v) => v === null)).toBe(true);
			expect(o.metrics.turns_sampled_24h).toBe(3);
			expect(o.changelog.commits_24h).toBe(2);

			const entries = await c.getEntries({ scope: "all" });
			expect(entries).toMatchObject({ health_state: "server-unreachable", entries: [] });
			const one = await handleOpenVikingEntriesRequest(c, { uri: "viking://resources/pi-web-ui", tier: "L1" }, "GET");
			expect(one.status).toBe(503);
			expect((await c.getAudit({ limit: "2" })).events).toHaveLength(2);
		}
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

	it("G1: queue depth is Pending + In Progress of the TOTAL row, and null when the table drifts", () => {
		expect(parseQueueDepth(QUEUE)).toBe(5);
		for (const drifted of [
			"| Queue | Pending | In Progress |\n| Embedding | 4 | 1 |",
			"| Queue | Waiting | In Progress |\n| TOTAL | 4 | 1 |",
			"| Queue | Pending | In Progress |\n| TOTAL | 4 | n/a |",
			"queue idle",
			undefined,
		]) {
			expect(parseQueueDepth(drifted)).toBeNull();
		}
	});
});
