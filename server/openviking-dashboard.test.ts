/**
 * Task 1 (#131) Acceptance Test Suite — OpenViking memory server API (`/overview`, `/audit`).
 * Grounded in .temper/features/openviking-dashboard/{brief,design,spec}.md.
 * #164: the dashboard view's `/entries` and its `/overview` fields are gone; what the Memory Explorer reads stays.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createOpenVikingClient,
	handleOpenVikingAuditRequest,
	handleOpenVikingOverviewRequest,
	ISOLATED_AGENT_MEMORY_ABSTRACT,
	type OpenVikingAuditResponse,
	type OpenVikingOverviewResponse,
} from "./openviking/index.js";

const FIXED_NOW = Date.parse("2026-11-11T08:30:00.000Z");
const V_USER_DEF = "viking://user/default/memories";

interface RecordedCall {
	url: string;
	method: string;
}

const jsonRes = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function createDaemonTransport(overrides: { healthy?: boolean } = {}): {
	fetchImpl: typeof fetch;
	calls: RecordedCall[];
} {
	const healthy = overrides.healthy ?? true;
	const calls: RecordedCall[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
		if (!healthy) throw new Error("connect ECONNREFUSED 127.0.0.1:1933");
		const u = new URL(url);
		if (u.pathname === "/health") return jsonRes({ status: "ok", healthy: true, version: "0.5.4", auth_mode: "dev" });
		return jsonRes({ status: "error", error: { code: "NOT_FOUND", message: u.pathname } }, 404);
	};
	return { fetchImpl, calls };
}

const turnRow = (min: string, mode: string, role: string) => ({
	timestamp: `2026-11-11T08:${min}:00.000Z`,
	event: "turn_start",
	mode,
	role,
});

const logRow = (min: string, source: string, role: string, uri: string, action: string, summary: string) => ({
	timestamp: `2026-11-11T08:${min}:00.000Z`,
	source,
	role,
	taskId: `${role}#1`,
	sessionId: null,
	uri,
	action,
	summary,
	diff: "+1/-0",
});

const DEFAULT_METRICS: object[] = [
	turnRow("28", "lead_l0", "ops"),
	turnRow("29", "worker_turn1", "backend"),
	turnRow("29", "lead_l0", "architecture"),
];

const DEFAULT_CHANGELOG: object[] = [
	logRow("25", "queue_done", "backend", "viking://user/backend/memories/cases/d6.md", "session_commit", "Private"),
	logRow("26", "wt_land_sync", "architecture", "viking://resources/pi-web-ui/spec.md", "resource_sync", "Synced"),
	logRow("26", "lead_promotion", "ops", `${V_USER_DEF}/preferences/backend_code.md`, "preference_write", "Promoted"),
	logRow("27", "guard", "backend", `${V_USER_DEF}/preferences/backend_code.md`, "reject_preference_candidate", "No"),
];

function seedStateFiles(
	dir: string,
	opts: { metricsLines?: object[]; changelogLines?: object[]; rollout?: object } = {},
): void {
	const jsonl = (rows: object[]) => (rows.length ? `${rows.map((r) => JSON.stringify(r)).join("\n")}\n` : "");
	writeFileSync(join(dir, "metrics.jsonl"), jsonl(opts.metricsLines ?? DEFAULT_METRICS));
	writeFileSync(join(dir, "memory-changelog.jsonl"), jsonl(opts.changelogLines ?? DEFAULT_CHANGELOG));
	const defaultRollout = { phase: "phase2", fallback_roles: [], pending_wt_land_syncs: [] };
	writeFileSync(join(dir, "rollout-state.json"), JSON.stringify(opts.rollout ?? defaultRollout));
}

describe("OpenViking memory server API (Task 1 Acceptance Suite)", () => {
	const tempDirs: string[] = [];
	const makeTempStateDir = (): string => {
		const d = mkdtempSync(join(tmpdir(), "ov-dash-test-"));
		tempDirs.push(d);
		return d;
	};
	afterEach(() => {
		for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("enforces read-only GET-only boundary (405 on non-GET) and R-URI-REWRITE-1 headers", async () => {
		const stateDir = makeTempStateDir();
		seedStateFiles(stateDir);
		const { fetchImpl } = createDaemonTransport();
		const client = createOpenVikingClient({ stateDir, fetchImpl, now: () => FIXED_NOW });

		const postOverview = await handleOpenVikingOverviewRequest(client, "POST");
		expect(postOverview.status).toBe(405);
		expect(postOverview.headers?.Allow).toBe("GET");
		expect((await handleOpenVikingAuditRequest(client, {}, "DELETE")).status).toBe(405);

		const sharedResource = client.rewriteVikingUri("viking://resources/pi-web-ui/design/DESIGN.md");
		expect(sharedResource.canonicalUri).toBe("viking://resources/pi-web-ui/design/DESIGN.md");
		expect(sharedResource.scope).toBe("resources");
		expect(sharedResource.layer).toBe("layer1_shared");
		expect(sharedResource.headers).toEqual({ "X-OpenViking-Account": "default", "X-OpenViking-User": "default" });

		const sharedPref = client.rewriteVikingUri("viking://user/memories/preferences/backend_code.md");
		expect(sharedPref.canonicalUri).toBe("viking://user/default/memories/preferences/backend_code.md");
		expect(sharedPref.logicalUri).toBe("viking://user/memories/preferences/backend_code.md");
		expect(sharedPref.scope).toBe("user");
		expect(sharedPref.headers).toEqual({ "X-OpenViking-Account": "default", "X-OpenViking-User": "default" });

		const roleMem = client.rewriteVikingUri("viking://agent/memories/instructions/preferences.md", "backend");
		expect(roleMem.canonicalUri).toBe("viking://user/backend/memories/instructions/preferences.md");
		expect(roleMem.logicalUri).toBe("viking://agent/memories/instructions/preferences.md");
		expect(roleMem.scope).toBe("agent");
		expect(roleMem.layer).toBe("layer2_personal");
		expect(roleMem.role).toBe("backend");
		expect(roleMem.headers).toEqual({
			"X-OpenViking-Account": "default",
			"X-OpenViking-User": "backend",
			"X-OpenViking-Agent": "backend",
		});

		expect(() => client.rewriteVikingUri("viking://agent/memories/cases/d2.md")).toThrow();
		expect(() => client.rewriteVikingUri("viking://user/ops/memories/cases/n544.md", "backend")).toThrow();
	});

	it("returns live health and the three observer times the explorer reads, and nothing else", async () => {
		const stateDir = makeTempStateDir();
		seedStateFiles(stateDir);
		const { fetchImpl } = createDaemonTransport();
		const client = createOpenVikingClient({ stateDir, fetchImpl, now: () => FIXED_NOW });

		const res = await handleOpenVikingOverviewRequest(client, "GET");
		expect(res.status).toBe(200);
		const body = res.body as OpenVikingOverviewResponse;
		expect(body).toEqual({
			screen_state: "live",
			health_state: "healthy",
			observer: {
				checked_at: new Date(FIXED_NOW).toISOString(),
				last_reachable_at: new Date(FIXED_NOW).toISOString(),
				last_commit_at: "2026-11-11T08:25:00.000Z",
			},
		});
	});

	it("distinguishes Stale (Degraded Local Fallback), Zero Activity (empty), and Offline (Server Unreachable)", async () => {
		const staleDir = makeTempStateDir();
		const failedSync = { project: "product-autopilot", failedAt: "2026-11-11T08:04:55.695Z", error: "sync error" };
		seedStateFiles(staleDir, {
			metricsLines: [turnRow("10", "lead_l0", "ops")],
			changelogLines: [
				logRow("00", "queue_done", "ops", "viking://user/ops/memories/cases/c1.md", "session_commit", "s"),
			],
			rollout: { phase: "phase2", pending_wt_land_syncs: [failedSync] },
		});
		const { fetchImpl: liveFetch } = createDaemonTransport();
		const staleOverview = await createOpenVikingClient({
			stateDir: staleDir,
			fetchImpl: liveFetch,
			now: () => FIXED_NOW,
		}).getOverview();
		expect(staleOverview.screen_state).toBe("stale");
		expect(staleOverview.health_state).toBe("stale");

		const emptyDir = makeTempStateDir();
		seedStateFiles(emptyDir, { metricsLines: [], changelogLines: [] });
		const emptyOverview = await createOpenVikingClient({
			stateDir: emptyDir,
			fetchImpl: liveFetch,
			now: () => FIXED_NOW,
		}).getOverview();
		expect(emptyOverview.screen_state).toBe("empty");
		expect(emptyOverview.health_state).toBe("zero-activity");
		expect(emptyOverview.observer.last_commit_at).toBeNull();

		const offlineDir = makeTempStateDir();
		seedStateFiles(offlineDir);
		const { fetchImpl: deadFetch } = createDaemonTransport({ healthy: false });
		const offlineOverview = await createOpenVikingClient({
			stateDir: offlineDir,
			fetchImpl: deadFetch,
			now: () => FIXED_NOW,
		}).getOverview();
		expect(offlineOverview.screen_state).toBe("error");
		expect(offlineOverview.health_state).toBe("server-unreachable");
		expect(offlineOverview.observer.last_reachable_at).toBeNull();
		expect(offlineOverview.observer.last_commit_at).toBe("2026-11-11T08:25:00.000Z");
	});

	it("serves the audit with R-ISOLATION-1 cross-role redaction and no /api/v1/content/* call", async () => {
		const stateDir = makeTempStateDir();
		seedStateFiles(stateDir);
		const { fetchImpl, calls } = createDaemonTransport();
		const client = createOpenVikingClient({ stateDir, fetchImpl, now: () => FIXED_NOW });

		const auditRes = await handleOpenVikingAuditRequest(client, { limit: "50" }, "GET");
		expect(auditRes.status).toBe(200);
		const auditBody = auditRes.body as OpenVikingAuditResponse;
		expect(auditBody.events.length).toBeGreaterThanOrEqual(4);
		expect(auditBody.events.find((e) => e.action === "reject_noise")?.guard_verdict).toBe("rejected");

		const agentCommitEvent = auditBody.events.find((e) => e.uri.includes("/backend/memories/cases/"));
		expect(agentCommitEvent?.action).toBe("commit");
		expect(agentCommitEvent?.l0_abstract).toBe(ISOLATED_AGENT_MEMORY_ABSTRACT);
		expect(agentCommitEvent?.summary_1line).toBe(ISOLATED_AGENT_MEMORY_ABSTRACT);
		expect(JSON.stringify(auditBody)).not.toContain("Private");
		expect(calls.some((c) => c.url.includes("/api/v1/content/"))).toBe(false);
	});
});
