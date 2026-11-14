/**
 * Backend #132: the OpenViking `/overview` and `/audit` API beyond Task 1's acceptance suite: cross-role isolation
 * (no `/api/v1/content/*` call, personal summaries redacted), old and new telemetry names in the same files
 * (Ops #808-#810), `:1933` down or slow, the read-only HTTP boundary (non-GET 405, nothing written, nothing sent
 * upstream), and (#137) `last_commit_at` dating session commits only (spec "Session Commits", rm-9724bae9,
 * rm-84facfcf): a queue_done add to a role-memory URI is not one, only to a session URI.
 * #164: `/entries` is gone with the dashboard view it served.
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
	ISOLATED_AGENT_MEMORY_ABSTRACT,
	registerOpenVikingRoutes,
	type OpenVikingDashboardOptions,
} from "../../server/openviking/index.js";
import { registerRouteModules } from "../../server/route-modules.js";
import { daemon, minutesAgo, NOW } from "./openviking-daemon-fake.js";

const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

/** metrics.jsonl and memory-changelog.jsonl mix pre-#809 and contract field names, as on spark. */
const MIXED_METRICS = [
	{ timestamp: minutesAgo(4), event: "turn_start", mode: "lead_l0", role: "ops" },
	{ timestamp: minutesAgo(3), event: "worker_prefetch_inject", role: "qa" },
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

describe("OpenViking overview and audit API (Backend #132)", () => {
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
	const listen = async (app: express.Express) => {
		const server = createServer(app).listen(0, "127.0.0.1");
		servers.push(server);
		await new Promise((r) => server.once("listening", r));
		return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/openviking`;
	};

	it("R-ISOLATION-1: no /api/v1/content/* call, personal summaries redacted in the audit", async () => {
		const { fetchImpl, calls } = daemon();
		const c = client({ stateDir: stateDir(), fetchImpl });

		await c.getOverview();
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
		expect(JSON.stringify(audit)).not.toContain("private");
		expect(calls.some((x) => x.url.pathname.startsWith("/api/v1/content/"))).toBe(false);
		expect(calls.every((x) => x.method === "GET")).toBe(true);
	});

	it("reads old and new telemetry names from the same files (G2-G7)", async () => {
		const { fetchImpl } = daemon();
		const dir = stateDir();
		const o = await client({ stateDir: dir, fetchImpl }).getOverview();
		expect(o).toMatchObject({ screen_state: "live", health_state: "healthy" });
		expect(o.observer.last_commit_at).toBe(minutesAgo(9));

		const audit = await client({ stateDir: dir, fetchImpl }).getAudit({ action: "reject_noise" });
		expect(audit.events.map((e) => [e.raw_action, e.guard_verdict])).toEqual([
			["reject_preference_candidate", "rejected"],
			["preference_write_blocked", "rejected"],
		]);
	});

	it(":1933 down or past the 2000 ms deadline: unreachable, and the state files are still read", async () => {
		expect(createOpenVikingClient().timeoutMs).toBe(2000);
		for (const mode of ["down", "hang"] as const) {
			const { fetchImpl } = daemon(mode);
			const c = client({ stateDir: stateDir(), fetchImpl, timeoutMs: 50 });
			const o = await c.getOverview();
			expect(o).toMatchObject({ screen_state: "error", health_state: "server-unreachable" });
			expect(o.observer).toMatchObject({ last_reachable_at: null, last_commit_at: minutesAgo(9) });
			expect((await c.getAudit({ limit: "2" })).events).toHaveLength(2);
		}
	});

	it("a missed deadline is retried once (pi-web-ui's event loop can stall ~2 s), a refused connection is not", async () => {
		const stalled = daemon("stall-once");
		const o = await client({ stateDir: stateDir(), fetchImpl: stalled.fetchImpl, timeoutMs: 50 }).getOverview();
		expect(o.screen_state).not.toBe("error");
		expect(stalled.calls.filter((c) => c.url.pathname === "/health")).toHaveLength(2);

		const down = daemon("down");
		const offline = await client({ stateDir: stateDir(), fetchImpl: down.fetchImpl }).getOverview();
		expect(offline.health_state).toBe("server-unreachable");
		expect(down.calls.filter((c) => c.url.pathname === "/health")).toHaveLength(1);
	});

	it("serves only GET over HTTP: other methods get 405 with Allow: GET, nothing reaches :1933 or the state files", async () => {
		const { fetchImpl, calls } = daemon();
		const dir = stateDir();
		const before = snapshot(dir);
		const app = express();
		registerOpenVikingRoutes(app, { stateDir: dir, fetchImpl, now: () => NOW });
		const base = await listen(app);

		for (const path of ["overview", "audit"]) {
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
		for (const bad of ["audit?limit=0", "audit?action=delete_all"]) {
			const res = await fetch(`${base}/${bad}`);
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_ARGUMENT");
		}
		expect(calls.every((x) => x.method === "GET")).toBe(true);
		expect(snapshot(dir)).toEqual(before);
	});

	it("server start-up mounts overview and audit (registerRouteModules); /entries is gone", async () => {
		const app = express();
		registerRouteModules(app, () => undefined);
		const base = await listen(app);
		for (const path of ["overview", "audit"]) {
			const res = await fetch(`${base}/${path}`, { method: "DELETE" });
			expect([res.status, res.headers.get("allow")]).toEqual([405, "GET"]);
		}
		expect((await fetch(`${base}/entries`)).status).toBe(404);
	});

	it("Session Commits: last_commit_at dates session commits only (queue_done + 200K lead), old and new names", async () => {
		const { fetchImpl } = daemon();
		const session = (min: number, action: string, uri: string, source: string) =>
			change(min, action, "ops", uri, "session commit", source);
		const write = (min: number, action: string, role: string, source: string) =>
			change(min, action, role, `viking://user/${role}/memories/cases/c${min}.md`, "role memory write", source);
		const dir = stateDir({
			"memory-changelog.jsonl": [
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
		expect(o.observer.last_commit_at).toBe(minutesAgo(28));
	});
});
