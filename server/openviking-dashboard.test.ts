/**
 * Task 1 (#131) Acceptance Test Suite — OpenViking Memory Dashboard Server API.
 * Grounded in .temper/features/openviking-dashboard/{brief,design,spec}.md.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import {
	createOpenVikingClient,
	handleOpenVikingAuditRequest,
	handleOpenVikingEntriesRequest,
	handleOpenVikingOverviewRequest,
	ISOLATED_AGENT_MEMORY_ABSTRACT,
	OPENVIKING_ROLES,
	registerOpenVikingRoutes,
	type OpenVikingAuditResponse,
	type OpenVikingEntriesResponse,
	type OpenVikingOverviewResponse,
} from "./openviking/index.js";

const FIXED_NOW = Date.parse("2026-11-11T08:30:00.000Z");
const V_USER_DEF = "viking://user/default/memories";

const QUEUE_ASCII_TABLE = [
	"|     Queue      | Pending | In Progress | Processed | Requeued | Errors | Total |",
	"|   Embedding    |    1    |      1      |   3743    |    0     |   0    | 3745  |",
	"|     TOTAL      |    2    |      1      |   6632    |   246    |   0    | 6635  |",
].join("\n");

const RETRIEVAL_ASCII_TABLE = [
	"|       Metric        |      Value      |",
	"|    Total Queries    |      1959       |",
	"|  Zero-Result Rate   |      0.3%       |",
	"|  Avg Latency (ms)   |      172.9      |",
].join("\n");

interface RecordedCall {
	url: string;
	method: string;
	headers: Record<string, string>;
}

function normalizeHeaders(init?: RequestInit): Record<string, string> {
	const out: Record<string, string> = {};
	const raw = init?.headers;
	if (!raw) return out;
	if (raw instanceof Headers) raw.forEach((v, k) => (out[k] = v));
	else if (Array.isArray(raw)) for (const [k, v] of raw) out[k] = v;
	else for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
	return out;
}

const jsonRes = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const lsItem = (name: string, uri: string, isDir: boolean, modTime = "2026-11-11T08:20:00.000Z") => ({
	name,
	uri,
	isDir,
	modTime,
});

const SHARED_REPOS = ["rollcall", "pi-web-ui", "pi-queue", "pi-worktree", "temper-ai", "architecture-conventions"];
const CRAFT_PREFS = [
	"frontend_code.md",
	"backend_code.md",
	"test_writing.md",
	"ui_ux_design.md",
	"architecture_contracts.md",
	"product_briefs.md",
	"ops_tooling.md",
	"rollcall_trading.md",
];

function handleLsUri(uri: string, onlineRoles: Set<string>): Response {
	if (uri === "viking://resources") {
		return jsonRes({ status: "ok", result: SHARED_REPOS.map((r) => lsItem(r, `viking://resources/${r}`, true)) });
	}
	if (uri === `${V_USER_DEF}/preferences`) {
		return jsonRes({ status: "ok", result: CRAFT_PREFS.map((f) => lsItem(f, `${uri}/${f}`, false)) });
	}
	if (uri === `${V_USER_DEF}/entities`) {
		return jsonRes({ status: "ok", result: ["spark.md", "rollcall.md"].map((f) => lsItem(f, `${uri}/${f}`, false)) });
	}
	if (uri === `${V_USER_DEF}/events`) {
		return jsonRes({ status: "ok", result: [lsItem("phase2-cutover.md", `${uri}/phase2-cutover.md`, false)] });
	}
	if (uri === V_USER_DEF) {
		const dirs = ["preferences", "entities", "events"].map((d) => lsItem(d, `${uri}/${d}`, true));
		return jsonRes({ status: "ok", result: dirs });
	}
	const roleMatch = /^viking:\/\/user\/([^/]+)\/memories(?:\/(.*))?$/.exec(uri);
	if (!roleMatch) return jsonRes({ status: "ok", result: [] });
	const [, role, sub = ""] = roleMatch;
	if (!onlineRoles.has(role)) return jsonRes({ status: "error", error: { code: "NOT_FOUND" } }, 404);
	const base = `viking://user/${role}/memories`;
	if (!sub) {
		const dirs = ["instructions", "cases", "experiences"].map((d) => lsItem(d, `${base}/${d}`, true));
		return jsonRes({ status: "ok", result: dirs });
	}
	if (sub === "instructions")
		return jsonRes({ status: "ok", result: [lsItem("preferences.md", `${uri}/preferences.md`, false)] });
	if (sub === "cases") {
		return jsonRes({
			status: "ok",
			result: [1, 2].map((n) => lsItem(`case-${role}-${n}.md`, `${uri}/case-${role}-${n}.md`, false)),
		});
	}
	if (sub === "experiences")
		return jsonRes({ status: "ok", result: [lsItem(`exp-${role}-1.md`, `${uri}/exp-${role}-1.md`, false)] });
	return jsonRes({ status: "ok", result: [] });
}

function createDaemonTransport(overrides: { healthy?: boolean; onlineRoles?: readonly string[] } = {}): {
	fetchImpl: typeof fetch;
	calls: RecordedCall[];
} {
	const healthy = overrides.healthy ?? true;
	const onlineRoles = new Set(overrides.onlineRoles ?? OPENVIKING_ROLES);
	const calls: RecordedCall[] = [];

	const fetchImpl: typeof fetch = async (input, init) => {
		const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const method = (init?.method ?? "GET").toUpperCase();
		const headers = normalizeHeaders(init);
		calls.push({ url: urlStr, method, headers });
		if (!healthy) throw new Error("connect ECONNREFUSED 127.0.0.1:1933");

		const u = new URL(urlStr);
		if (u.pathname === "/health") return jsonRes({ status: "ok", healthy: true, version: "0.5.4", auth_mode: "dev" });
		if (u.pathname === "/api/v1/system/status") {
			return jsonRes({ status: "ok", result: { initialized: true, user: headers["X-OpenViking-User"] ?? "default" } });
		}
		const queueComp = { name: "queue", is_healthy: true, has_errors: false, status: QUEUE_ASCII_TABLE };
		const retrievalComp = { name: "retrieval", is_healthy: true, has_errors: false, status: RETRIEVAL_ASCII_TABLE };
		if (u.pathname === "/api/v1/observer/system") {
			const sys = { is_healthy: true, errors: [], components: { queue: queueComp, retrieval: retrievalComp } };
			return jsonRes({ status: "ok", result: sys });
		}
		if (u.pathname === "/api/v1/fs/ls") return handleLsUri(u.searchParams.get("uri") ?? "", onlineRoles);
		const uri = u.searchParams.get("uri") ?? "";
		if (u.pathname === "/api/v1/content/abstract")
			return jsonRes({ status: "ok", result: `Single-sentence L0 abstract for ${uri}.` });
		if (u.pathname === "/api/v1/content/overview")
			return jsonRes({ status: "ok", result: `# L1 Overview for ${uri}\n\n- Section A` });
		if (u.pathname === "/api/v1/content/read")
			return jsonRes({ status: "ok", result: `# L2 Full Content for ${uri}\n\nDetailed body.` });
		return jsonRes({ status: "error", error: { code: "NOT_FOUND", message: u.pathname } }, 404);
	};

	return { fetchImpl, calls };
}

const turnRow = (min: string, mode: string, role: string, l0_hits: number, tokens_est: number, dedup = 0) => ({
	timestamp: `2026-11-11T08:${min}:00.000Z`,
	event: "turn_start",
	mode,
	role,
	l0_hits,
	tokens_est,
	rm_dedup_skipped_count: dedup,
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
	turnRow("28", "lead_l0", "ops", 3, 240, 2),
	turnRow("29", "worker_turn1", "backend", 4, 1960, 1),
	turnRow("29", "lead_l0", "architecture", 0, 0, 0),
	{ timestamp: "2026-11-11T08:27:00.000Z", event: "lead_200k_commit", role: "ops", evictedTokens: 155000 },
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
	const metrics = opts.metricsLines ?? DEFAULT_METRICS;
	const changelog = opts.changelogLines ?? DEFAULT_CHANGELOG;
	writeFileSync(
		join(dir, "metrics.jsonl"),
		metrics.length ? `${metrics.map((m) => JSON.stringify(m)).join("\n")}\n` : "",
	);
	writeFileSync(
		join(dir, "memory-changelog.jsonl"),
		changelog.length ? `${changelog.map((c) => JSON.stringify(c)).join("\n")}\n` : "",
	);
	const defaultRollout = { phase: "phase2", notebook_retired: true, fallback_roles: [], pending_wt_land_syncs: [] };
	writeFileSync(join(dir, "rollout-state.json"), JSON.stringify(opts.rollout ?? defaultRollout));
	const mig = {
		verified_at: "2026-11-11T00:53:35.455Z",
		status: "PASS",
		roles_passed: 15,
		total_roles: 15,
		repos_passed: 6,
		total_repos: 6,
	};
	writeFileSync(join(dir, "migration-verification.json"), JSON.stringify(mig));
	const dedup = {
		seen: { "rm-51ac955d": { role: "ops" }, "rm-dd387b45": { role: "product" } },
		updatedAt: "2026-11-11T08:05:00.000Z",
	};
	writeFileSync(join(dir, "seen-role-messages.json"), JSON.stringify(dedup));
}

describe("OpenViking Memory Dashboard Server API (Task 1 Acceptance Suite)", () => {
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
		expect((await handleOpenVikingEntriesRequest(client, {}, "PUT")).status).toBe(405);
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

	it("returns Live Active Status Header and all 3 Summary Cards when :1933 and state files are healthy", async () => {
		const stateDir = makeTempStateDir();
		seedStateFiles(stateDir);
		const { fetchImpl } = createDaemonTransport();
		const client = createOpenVikingClient({ stateDir, fetchImpl, now: () => FIXED_NOW });

		const res = await handleOpenVikingOverviewRequest(client, "GET");
		expect(res.status).toBe(200);
		const body = res.body as OpenVikingOverviewResponse;

		expect(body.screen_state).toBe("live");
		expect(body.health_state).toBe("healthy");
		// Spec 2677060e (Architecture rm-19da6607): no role liveness in v1; plain "Active", and a count of canonical
		// viking://user/<role>/memories folders found, not roles online.
		expect(body.observer.mode_label).toBe("Active");
		expect(body.observer.role_memory_folder_count).toBe(15);
		expect(body.observer.roles_total_count).toBe(15);
		expect(body.observer.daemon_bind).toBe("127.0.0.1:1933");
		// R-QUEUE-DEPTH-1 (spec f153952b G1, Architecture rm-a374e16b/rm-d9b87acf): unavailable in v1, never scraped.
		expect(body.observer.queue_depth).toBeNull();
		expect(body.observer.retrieval_latency_avg_ms).toBeCloseTo(172.9, 1);
		expect(body.observer.retrieval_hit_rate_pct).toBeCloseTo(99.7, 1);

		expect(body.metrics.turns_sampled_24h).toBe(3);
		expect(body.metrics.slot_hit_rate_pct).toBeCloseTo(66.7, 1);
		expect(body.metrics.avg_injected_tokens).toBe(733);
		expect(body.metrics.mode1_lead_l0_injections_24h).toBe(2);
		expect(body.metrics.mode2_worker_turn1_prefetches_24h).toBe(1);
		expect(body.metrics.lead_200k_commits_24h).toBe(1);
		expect(body.metrics.rm_dedup_skipped_24h).toBe(3);
		expect(body.slots).toHaveLength(5);
		expect(body.slots.every((s) => s.state === "unmeasured-gap" && s.hit_rate_pct === null)).toBe(true);

		expect(body.observer.store_counts.layer1_shared.repo_trees_count).toBe(6);
		expect(body.observer.store_counts.layer1_shared.craft_preference_domains_count).toBe(8);
		expect(body.observer.store_counts.layer1_shared.entities_count).toBe(2);
		expect(body.observer.store_counts.layer1_shared.events_count).toBe(1);
		expect(body.observer.store_counts.layer1_shared.total_count).toBe(17);
		expect(body.observer.store_counts.layer2_personal.roles_count).toBe(15);
		expect(body.observer.store_counts.layer2_personal.preferences_count).toBe(15);
		expect(body.observer.store_counts.layer2_personal.cases_count).toBe(30);
		expect(body.observer.store_counts.layer2_personal.experiences_count).toBe(15);
		expect(body.observer.store_counts.layer2_personal.total_count).toBe(60);
		expect(body.auxiliary.rollout.stage).toBeNull();
		// Spec 2500874d field table (Backend #153): sync state is `rollout-state.json`'s `pending_wt_land_syncs`
		// and nothing else — none pending here, and no writer anywhere records a sync time or a repo count.
		expect(body.auxiliary.resource_sync).toEqual({
			pending_syncs_count: 0,
			status: "ok",
			synced_at: null,
			repos_synced: null,
		});
		expect(body.auxiliary.migration.total_checked).toBe(21);
		expect(body.auxiliary.dedup.seen_count).toBe(2);

		// Spec 3a56d6a3 "Session Commits" (Architecture rm-9724bae9): renamed from commits_24h.
		expect(body.changelog.session_commits_24h).toBe(1);
		expect(body.changelog.promotions_24h).toBe(2);
		expect(body.changelog.rejected_24h).toBe(1);
	});

	it("distinguishes Stale (Degraded Local Fallback), Zero Activity (empty), and Offline (Server Unreachable)", async () => {
		const staleDir = makeTempStateDir();
		const failedSync = { project: "product-autopilot", failedAt: "2026-11-11T08:04:55.695Z", error: "sync error" };
		seedStateFiles(staleDir, {
			metricsLines: [turnRow("10", "lead_l0", "ops", 1, 200)],
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
		expect(staleOverview.observer.mode_label).toBe("Degraded Local Fallback");
		expect(staleOverview.metrics.stale_badge).toBe("> 5m");
		expect(staleOverview.changelog.stale_badge).toBe("> 15m");

		const emptyDir = makeTempStateDir();
		seedStateFiles(emptyDir, { metricsLines: [], changelogLines: [] });
		const emptyOverview = await createOpenVikingClient({
			stateDir: emptyDir,
			fetchImpl: liveFetch,
			now: () => FIXED_NOW,
		}).getOverview();
		expect(emptyOverview.screen_state).toBe("empty");
		expect(emptyOverview.health_state).toBe("zero-activity");
		expect(emptyOverview.metrics.turns_sampled_24h).toBe(0);
		expect(emptyOverview.metrics.slot_hit_rate_pct).toBeNull();
		expect(emptyOverview.metrics.avg_injected_tokens).toBeNull();
		expect(emptyOverview.changelog.session_commits_24h).toBe(0);

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
		expect(offlineOverview.observer.mode_label).toBe("Offline");
		// Spec 2677060e (Architecture rm-19da6607): the folder count is null when :1933 is down.
		expect(offlineOverview.observer.role_memory_folder_count).toBeNull();
		expect(offlineOverview.observer.queue_depth).toBeNull();
		expect(offlineOverview.observer.store_counts.layer1_shared.total_count).toBeNull();
		expect(offlineOverview.observer.store_counts.layer2_personal.total_count).toBeNull();
		expect(offlineOverview.metrics.turns_sampled_24h).toBe(3);
		expect(offlineOverview.changelog.rejected_24h).toBe(1);
	});

	it("serves the 3 Workspace Feeds, progressive disclosure L0/L1/L2 reader, and R-ISOLATION-1 cross-role redaction", async () => {
		const stateDir = makeTempStateDir();
		seedStateFiles(stateDir);
		const { fetchImpl, calls } = createDaemonTransport();
		const app = express();
		const client = registerOpenVikingRoutes(app, { stateDir, fetchImpl, now: () => FIXED_NOW });

		const overview = await client.getOverview();
		expect(overview.live_activity.length).toBeGreaterThanOrEqual(4);
		const agentActivity = overview.live_activity.find(
			(item) => item.role === "backend" && item.action === "session_commit",
		);
		expect(agentActivity?.summary_1line).toBe(ISOLATED_AGENT_MEMORY_ABSTRACT);

		const entriesRes = await handleOpenVikingEntriesRequest(client, { scope: "all" }, "GET");
		expect(entriesRes.status).toBe(200);
		const entriesBody = entriesRes.body as OpenVikingEntriesResponse;
		expect(entriesBody.entries.length).toBeGreaterThan(0);

		const sharedEntry = entriesBody.entries.find((e) => e.scope === "resources" || e.scope === "user");
		expect(sharedEntry).toBeDefined();
		expect(sharedEntry?.l0_abstract).toBeTruthy();
		expect(sharedEntry?.l1_overview).toBeNull();
		expect(sharedEntry?.l2_content).toBeNull();

		const agentEntry = entriesBody.entries.find((e) => e.scope === "agent");
		expect(agentEntry).toBeDefined();
		expect(agentEntry?.l0_abstract).toBe(ISOLATED_AGENT_MEMORY_ABSTRACT);
		expect(agentEntry?.l1_overview).toBeNull();
		expect(agentEntry?.l2_content).toBeNull();

		const contentCallsForAgent = calls.filter(
			(c) => c.url.includes("/api/v1/content/") && c.url.includes("viking%3A%2F%2Fuser%2Fbackend%2F"),
		);
		expect(contentCallsForAgent).toHaveLength(0);

		const expandedShared = await handleOpenVikingEntriesRequest(
			client,
			{ uri: "viking://user/memories/preferences/backend_code.md", include_content: "true" },
			"GET",
		);
		expect(expandedShared.status).toBe(200);
		const expandedEntry = (expandedShared.body as OpenVikingEntriesResponse).entries[0];
		expect(expandedEntry.canonical_uri).toBe("viking://user/default/memories/preferences/backend_code.md");
		expect(expandedEntry.l0_abstract).toContain("Single-sentence L0 abstract");
		expect(expandedEntry.l1_overview).toContain("# L1 Overview");
		expect(expandedEntry.l2_content).toContain("# L2 Full Content");

		const forbiddenAgentContent = await handleOpenVikingEntriesRequest(
			client,
			{ uri: "viking://agent/memories/cases/case-backend-1.md", role: "backend", include_content: "true" },
			"GET",
		);
		expect(forbiddenAgentContent.status).toBe(403);

		const auditRes = await handleOpenVikingAuditRequest(client, { limit: "50" }, "GET");
		expect(auditRes.status).toBe(200);
		const auditBody = auditRes.body as OpenVikingAuditResponse;
		expect(auditBody.events.length).toBeGreaterThanOrEqual(4);
		expect(auditBody.events.find((e) => e.action === "reject_noise")?.guard_verdict).toBe("rejected");

		const agentCommitEvent = auditBody.events.find((e) => e.uri.includes("/backend/memories/cases/"));
		expect(agentCommitEvent?.action).toBe("commit");
		expect(agentCommitEvent?.l0_abstract).toBe(ISOLATED_AGENT_MEMORY_ABSTRACT);
		expect(agentCommitEvent?.summary_1line).toBe(ISOLATED_AGENT_MEMORY_ABSTRACT);
	});
});
