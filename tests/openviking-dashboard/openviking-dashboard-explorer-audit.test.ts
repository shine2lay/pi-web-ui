/**
 * OpenViking Memory Dashboard — acceptance assertions for the Memory Explorer groups, the audit
 * stream with its filters, the L0/L1/L2 reader drawer, and the production-source guards
 * (frontend #261, Task 1; built by #258, proved blind by #259).
 *
 * They all fail today for one reason: every seam function is a Task 1 stub.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ISOLATED_AGENT_MEMORY_ABSTRACT, OPENVIKING_AUDIT_ACTIONS } from "../../server/openviking/types.js";
import { buildAuditFilters, buildAuditRows } from "../../web/src/openviking-dashboard/audit-view-model.js";
import { buildDrawer } from "../../web/src/openviking-dashboard/drawer-view-model.js";
import { buildMemoryGroups } from "../../web/src/openviking-dashboard/explorer-view-model.js";
import { OPENVIKING_OFFLINE_CONTENT_TEXT } from "../../web/src/openviking-dashboard/text.js";
import {
	FIXTURE_BLOB_HASH,
	ISOLATED_ROLE_SECRET,
	NOW_MS,
	auditResponse,
	entriesResponse,
	leakyAgentEntry,
} from "./openviking-dashboard-fixtures.js";

const HASH_64 = /\b[0-9a-f]{64}\b/i;
const RAW_PATH = /\/(home|var|tmp|usr)\//;

describe("openviking dashboard — memory explorer groups", () => {
	it("groups entries by repo and by role instead of listing them flat", () => {
		const groups = buildMemoryGroups(entriesResponse(), NOW_MS, "live");
		expect(groups.length).toBeGreaterThan(1);
		const keys = groups.map((g) => g.key);
		expect(keys).toContain("repo:rollcall");
		expect(keys).toContain("repo:pi-web-ui");
		expect(keys).toContain("role:design");
		expect(keys).toContain("role:ops");
		const totalRows = groups.reduce((n, g) => n + g.rows.length, 0);
		expect(totalRows).toBe(entriesResponse().entries.length);
		expect(groups.every((g) => g.rows.length > 0)).toBe(true);
		expect(groups.every((g) => g.rows.length < totalRows)).toBe(true);
	});

	it("keeps each group inside one repo or one role, on the right layer", () => {
		const groups = buildMemoryGroups(entriesResponse(), NOW_MS, "live");
		const rollcall = groups.find((g) => g.key === "repo:rollcall");
		expect(rollcall?.kind).toBe("repo");
		expect(rollcall?.layer).toBe("layer1_shared");
		expect(rollcall?.rows).toHaveLength(2);
		expect(rollcall?.rows.every((r) => r.uri.startsWith("viking://resources/rollcall/"))).toBe(true);
		expect(rollcall?.title.toLowerCase()).toContain("rollcall");

		const design = groups.find((g) => g.key === "role:design");
		expect(design?.kind).toBe("role");
		expect(design?.layer).toBe("layer2_personal");
		expect(design?.rows.every((r) => r.roleLabel?.toLowerCase().includes("design"))).toBe(true);
		expect(design?.title.toLowerCase()).toContain("design");
	});

	it("names the two layers in words: L0/L1/L2 are content levels, not layers", () => {
		const groups = buildMemoryGroups(entriesResponse(), NOW_MS, "live");
		for (const group of groups) {
			expect(group.title).not.toMatch(/\bL[12]\s+(shared|role|personal)/i);
			for (const row of group.rows) {
				expect(row.tiers.every((t) => ["L0", "L1", "L2"].includes(t))).toBe(true);
			}
		}
	});

	it("shows no 64-char hash and no on-disk path in a row", () => {
		const groups = buildMemoryGroups(entriesResponse(), NOW_MS, "live");
		for (const row of groups.flatMap((g) => g.rows)) {
			const painted = [row.displayUri, row.title, row.l0Line, row.categoryLabel, row.scopeLabel].join(" ");
			expect(painted).not.toMatch(HASH_64);
			expect(painted).not.toContain(FIXTURE_BLOB_HASH);
			expect(painted).not.toMatch(RAW_PATH);
		}
	});

	it("keeps another role's personal memory to metadata only", () => {
		const groups = buildMemoryGroups(entriesResponse(), NOW_MS, "live");
		const personal = groups.filter((g) => g.layer === "layer2_personal").flatMap((g) => g.rows);
		expect(personal.length).toBeGreaterThan(0);
		for (const row of personal) {
			expect(row.isolated).toBe(true);
			expect(row.l0Line).toBe(ISOLATED_AGENT_MEMORY_ABSTRACT);
		}
	});
});

describe("openviking dashboard — audit stream", () => {
	const allRows = () => buildAuditRows(auditResponse(), NOW_MS, "live", { action: "all", role: "all" });

	it("lists the five contract actions in server order, each with its own badge", () => {
		const rows = allRows();
		expect(rows.map((r) => r.action)).toEqual([...OPENVIKING_AUDIT_ACTIONS]);
		expect(rows.every((r) => r.actionLabel.trim() !== "")).toBe(true);
		expect(rows.map((r) => r.key)).toEqual(["ev-1", "ev-2", "ev-3", "ev-4", "ev-5"]);
		expect(rows[0]?.age.sourceField).toBe("events[].ts");
		expect(rows[0]?.age.text).toContain("5m");
	});

	it("never labels a role memory write a commit", () => {
		const rows = allRows();
		const write = rows.find((r) => r.action === "role_memory_write");
		expect(write?.actionLabel).not.toMatch(/commit/i);
		expect(write?.actionLabel.toLowerCase()).toContain("role memory");
		expect(rows.find((r) => r.action === "commit")?.actionLabel).toMatch(/commit/i);
	});

	it("redacts a personal-memory row to metadata", () => {
		const write = allRows().find((r) => r.action === "role_memory_write");
		expect(write?.isolated).toBe(true);
		expect(write?.summaryLine === "" || /isolat/i.test(write?.summaryLine ?? "")).toBe(true);
	});

	it("filters by action and by role without computing anything", () => {
		const rejected = buildAuditRows(auditResponse(), NOW_MS, "live", { action: "reject_noise", role: "all" });
		expect(rejected.map((r) => r.key)).toEqual(["ev-4"]);
		const design = buildAuditRows(auditResponse(), NOW_MS, "live", { action: "all", role: "design" });
		expect(design.map((r) => r.key)).toEqual(["ev-2"]);
	});

	it("offers one filter option per contract action and per role in the window", () => {
		const filters = buildAuditFilters(auditResponse(), { action: "reject_noise", role: "all" });
		expect(filters.actions.map((o) => o.value)).toEqual(["all", ...OPENVIKING_AUDIT_ACTIONS]);
		expect(filters.actions.filter((o) => o.selected).map((o) => o.value)).toEqual(["reject_noise"]);
		expect(filters.roles.map((o) => o.value)).toEqual(["all", "backend", "design", "frontend", "qa", "systems"]);
		expect(filters.roles.filter((o) => o.selected).map((o) => o.value)).toEqual(["all"]);
		expect(filters.actions.every((o) => o.label.trim() !== "")).toBe(true);
	});

	it("keeps listing the local audit log while :1933 is unreachable", () => {
		const rows = buildAuditRows(auditResponse(), NOW_MS, "error", { action: "all", role: "all" });
		expect(rows).toHaveLength(5);
		for (const row of rows) {
			expect(row.displayUri).not.toMatch(HASH_64);
			expect(row.displayUri).not.toMatch(RAW_PATH);
		}
	});
});

describe("openviking dashboard — reader drawer", () => {
	const entries = entriesResponse().entries;
	const mapEntry = entries[0]!;
	const specEntry = entries[1]!;
	const agentEntry = entries[4]!;

	it("describes the row it was opened from", () => {
		const drawer = buildDrawer({ kind: "memory", rowKey: "mem-1", entry: mapEntry }, NOW_MS, "live", null);
		expect(drawer.rowKey).toBe("mem-1");
		expect(drawer.displayUri).toBe(mapEntry.uri);
		expect(drawer.displayUri).not.toMatch(HASH_64);
		expect(drawer.layerLabel).toBe("Layer 1 Shared");
		expect(drawer.tiers.map((t) => t.tier)).toEqual(["L0", "L1", "L2"]);
		expect(drawer.tiers.find((t) => t.tier === "L1")?.body).toBe(mapEntry.l1_overview);
		expect(drawer.provenance).toEqual(mapEntry.provenance);
		expect(drawer.isolationNotice).toBeNull();
	});

	it("never carries the previous row's content into the next one", () => {
		const first = buildDrawer({ kind: "memory", rowKey: "mem-1", entry: mapEntry }, NOW_MS, "live", null);
		const second = buildDrawer({ kind: "memory", rowKey: "mem-2", entry: specEntry }, NOW_MS, "live", null);
		expect(second.displayUri).toBe(specEntry.uri);
		expect(second.title).not.toBe(first.title);
		expect(second.tiers).not.toEqual(first.tiers);
	});

	it("shows an isolation notice and no memory text for another role's personal memory", () => {
		const drawer = buildDrawer({ kind: "memory", rowKey: "mem-5", entry: leakyAgentEntry() }, NOW_MS, "live", {
			code: "ISOLATED_ROLE_MEMORY",
			message: "403",
		});
		expect(drawer.isolationNotice).toMatch(/isolat/i);
		expect(drawer.layerLabel).toBe("Layer 2 Personal");
		for (const tier of drawer.tiers) {
			expect(tier.body).not.toContain(ISOLATED_ROLE_SECRET);
			if (tier.tier !== "L0") expect(tier.unavailableReason).toMatch(/isolat/i);
		}
	});

	it("holds back daemon-read content while :1933 is unreachable", () => {
		const drawer = buildDrawer({ kind: "memory", rowKey: "mem-1", entry: mapEntry }, NOW_MS, "error", null);
		for (const tier of drawer.tiers.filter((t) => t.tier !== "L0")) {
			expect(tier.unavailableReason).toBe(OPENVIKING_OFFLINE_CONTENT_TEXT);
			expect(tier.body).toBe("");
		}
	});

	it("opens on an audit row with that event's own data", () => {
		const event = auditResponse().events[3]!;
		const drawer = buildDrawer({ kind: "audit", rowKey: "ev-4", event }, NOW_MS, "live", null);
		expect(drawer.rowKey).toBe("ev-4");
		expect(drawer.displayUri).toBe(event.uri);
		expect(drawer.tiers.find((t) => t.tier === "L0")?.body).toBe(event.l0_abstract);
	});

	it("marks a personal entry isolated even when the payload still carries content", () => {
		const drawer = buildDrawer({ kind: "memory", rowKey: "mem-leaky", entry: leakyAgentEntry() }, NOW_MS, "live", null);
		expect(drawer.isolationNotice).toMatch(/isolat/i);
		expect(drawer.tiers.every((t) => !t.body.includes(ISOLATED_ROLE_SECRET))).toBe(true);
	});

	it("never names the layers L1/L2 (those are content levels)", () => {
		const drawer = buildDrawer({ kind: "memory", rowKey: "mem-5", entry: agentEntry }, NOW_MS, "live", null);
		expect(drawer.layerLabel).toBe("Layer 2 Personal");
		expect(drawer.layerLabel).not.toMatch(/^L[12]\b/);
	});
});

describe("openviking dashboard — production source guards", () => {
	const seamDir = fileURLToPath(new URL("../../web/src/openviking-dashboard/", import.meta.url));

	function seamFiles(dir = seamDir): string[] {
		return readdirSync(dir).flatMap((name) => {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) return seamFiles(full);
			return /\.(ts|tsx|css)$/.test(name) ? [full] : [];
		});
	}

	it("carries no prototype-only chrome", () => {
		const banned = [
			"stateStrip",
			"data-st-state",
			"__hidePrototypeChrome",
			"proto=0",
			"?state=",
			"?scenario=",
			"openviking-fixture-data",
			"__OPENVIKING_FIXTURE__",
		];
		const hits = seamFiles().flatMap((file) => {
			const source = readFileSync(file, "utf8");
			return banned.filter((token) => source.includes(token)).map((token) => `${file}: ${token}`);
		});
		expect(hits).toEqual([]);
	});

	it("keeps no fixture payload and no hard-coded colour in production code", () => {
		for (const file of seamFiles()) {
			const source = readFileSync(file, "utf8");
			expect(source).not.toMatch(/#[0-9a-fA-F]{6}\b/);
			expect(source).not.toMatch(HASH_64);
			expect(source).not.toMatch(/\bwindow\.__/);
			expect(source.split("\n").length).toBeLessThanOrEqual(500);
		}
	});

	it("has no Task 1 stub left: Task 2 (#258) implements the seam", () => {
		const marker = ["OPENVIKING", "SEAM", "NOT", "IMPLEMENTED"].join("_");
		const left = seamFiles().filter((file) => readFileSync(file, "utf8").includes(marker));
		expect(left).toEqual([]);
	});
});
