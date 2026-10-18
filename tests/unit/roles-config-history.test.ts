/** roles-config-history (Ops #209): the recorder of role settings changes, and the Config tab's text. */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ROLES_CONFIG_KEEP_MS,
	RolesConfigHistory,
	roleSettingsOf,
	type RoleSettings,
} from "../../server/roles-config-history.js";
import type { UiTaskQueue } from "../../server/protocol.js";
import { configHistoryActs, projectConfigHistory } from "../../web/src/roles-config-history.js";

const T0 = Date.UTC(2026, 9, 18, 17, 0); // Oct 18 2026, 10:00 PDT
const MIN = 60_000;
const dirs: string[] = [];

function dataDir(): string {
	const d = mkdtempSync(join(tmpdir(), "roles-config-"));
	dirs.push(d);
	return d;
}

afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function queue(over: Partial<UiTaskQueue> = {}): UiTaskQueue {
	return { autoApprove: false, autoStart: false, running: false, available: true, tasks: [], ...over };
}

function settings(
	over: { lanes?: number; goals?: { name: string; scope: string }[]; model?: string } = {},
): RoleSettings {
	return roleSettingsOf({
		title: "ops/tooling",
		focus: "the machine",
		workMode: "request-only",
		goals: over.goals ?? [],
		homeChat: "/home/u/.pi/agent/sessions/x/2026-10-18T10-00-00-000Z_abc.jsonl",
		queue: queue(over.lanes === undefined ? {} : { lanesAtOnce: over.lanes }),
		model: over.model ?? "Claude Opus 5.5 (#4)",
	});
}

function lines(file: string): unknown[] {
	return existsSync(file)
		? readFileSync(file, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];
}

describe("roles-config-history recorder", () => {
	it("records a baseline on its first run, not changes", () => {
		const dir = dataDir();
		const rec = new RolesConfigHistory(dir);
		expect(rec.record(new Map([["ops", settings()]]), T0)).toEqual([]);
		expect(existsSync(rec.historyFile)).toBe(false);
		expect(statSync(rec.snapshotFile).mode & 0o777).toBe(0o600);
		expect(rec.view("ops")).toEqual({ since: T0, changes: [] });
		expect(rec.view("qa")).toBeUndefined();
		// A new recorder on the same files (a restart) keeps the baseline: still no changes.
		const again = new RolesConfigHistory(dir);
		expect(again.record(new Map([["ops", settings()]]), T0 + 5 * MIN)).toEqual([]);
		expect(again.view("ops")).toEqual({ since: T0, changes: [] });
	});

	it("appends one line for one changed setting, with its old and new values", () => {
		const rec = new RolesConfigHistory(dataDir());
		rec.record(new Map([["ops", settings()]]), T0);
		const added = rec.record(new Map([["ops", settings({ lanes: 8 })]]), T0 + 5 * MIN);
		const line = { v: 1, at: T0 + 5 * MIN, role: "ops", field: "lanesAtOnce", from: "2", to: "8" };
		expect(added).toEqual([line]);
		expect(lines(rec.historyFile)).toEqual([line]);
		expect(statSync(rec.historyFile).mode & 0o777).toBe(0o600);
		expect(rec.view("ops")).toEqual({
			since: T0,
			changes: [{ at: T0 + 5 * MIN, field: "lanesAtOnce", from: "2", to: "8" }],
		});
	});

	it("adds no line when nothing changed or a setting couldn't be read", () => {
		const rec = new RolesConfigHistory(dataDir());
		rec.record(new Map([["ops", settings()]]), T0);
		expect(rec.record(new Map([["ops", settings()]]), T0 + 5 * MIN)).toEqual([]);
		// Home chat unreadable this run: its queue and model are left out, so their last values stay.
		const partial = { ...settings() };
		delete partial.lanesAtOnce;
		delete partial.model;
		expect(rec.record(new Map([["ops", partial]]), T0 + 10 * MIN)).toEqual([]);
		expect(rec.record(new Map([["ops", settings()]]), T0 + 15 * MIN)).toEqual([]);
		expect(existsSync(rec.historyFile)).toBe(false);
	});

	it("cuts long values at 200 characters in the history", () => {
		const rec = new RolesConfigHistory(dataDir());
		const long = (c: string) => [{ name: "g", scope: c.repeat(500) }];
		rec.record(new Map([["ops", settings({ goals: long("a") })]]), T0);
		const [line] = rec.record(new Map([["ops", settings({ goals: long("b") })]]), T0 + 5 * MIN);
		expect(line.field).toBe("goals");
		expect(line.from).toHaveLength(200);
		expect(line.to).toHaveLength(200);
		expect(line.from.endsWith("…")).toBe(true);
		expect(line.to.startsWith("g (bbb")).toBe(true);
	});

	it("drops lines older than 90 days", () => {
		const dir = dataDir();
		const rec = new RolesConfigHistory(dir);
		rec.record(new Map([["ops", settings()]]), T0);
		const old = { v: 1, at: T0 - ROLES_CONFIG_KEEP_MS - MIN, role: "ops", field: "model", from: "a", to: "b" };
		const recent = { v: 1, at: T0 - MIN, role: "ops", field: "model", from: "b", to: "Claude Opus 5.5 (#4)" };
		writeFileSync(join(dir, "roles-config-history.jsonl"), `${JSON.stringify(old)}\n${JSON.stringify(recent)}\n`);
		const fresh = new RolesConfigHistory(dir);
		fresh.record(new Map([["ops", settings()]]), T0);
		expect(lines(fresh.historyFile)).toEqual([recent]);
		expect(fresh.view("ops")?.changes).toEqual([
			{ at: recent.at, field: "model", from: "b", to: "Claude Opus 5.5 (#4)" },
		]);
	});
});

describe("roles-config-history Config tab text", () => {
	const when = (at: number) => `${new Date(at).getUTCHours()}:${String(new Date(at).getUTCMinutes()).padStart(2, "0")}`;

	it("lists changes newest first as time · setting: old → new, then says who isn't recorded", () => {
		const h = projectConfigHistory(
			{
				since: T0,
				changes: [
					{ at: T0 + 5 * MIN, field: "lanesAtOnce", from: "2", to: "8" },
					{ at: T0 + 10 * MIN, field: "model", from: "GPT-5", to: "Claude Opus 5.5 (#4)" },
					{ at: T0 + 15 * MIN, field: "unknown", from: "x", to: "y" },
					{ at: T0 + 20 * MIN, field: "autoStart", from: "x".repeat(201), to: "on" },
				],
			},
			T0 + 30 * MIN,
		);
		expect(configHistoryActs(h, when)).toEqual([
			{ at: "17:10", text: "Home chat model: GPT-5 → Claude Opus 5.5 (#4)" },
			{ at: "17:05", text: "Lanes at once: 2 → 8" },
			{ at: "", text: "Who changed it isn't recorded." },
		]);
		expect(configHistoryActs(projectConfigHistory({ since: T0, changes: [] }, T0), when)).toEqual([
			{ at: "", text: "No changes recorded since Oct 18." },
		]);
		expect(configHistoryActs(projectConfigHistory(undefined, T0), when)).toEqual([
			{ at: "", text: "Settings history is not recorded yet." },
		]);
	});
});
