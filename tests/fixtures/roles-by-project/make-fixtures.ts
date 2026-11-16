/**
 * roles-by-project fixtures (spec-acceptance.md): the design's two real snapshots (busy 2026-11-05, tonight
 * 2026-11-16), converted once to UiRoleTask rows through the real taskOf, as the overview reader would hold them.
 *
 *   node --import tsx tests/fixtures/roles-by-project/make-fixtures.ts [design fixtures.json] [--check]
 *
 * Deterministic: same source, same bytes (no clock, no file reads besides the source). --check rewrites nothing
 * and exits 1 when a committed fixture differs from what the source makes now.
 *
 * Each fixture: { snapshot, source, sourceSha256, at, roster, registry, rows }.
 * - registry: the work registry as pi-queue's readWork holds it (entries of [id, record]); tests turn it into
 *   Maps and read it with the real workRecordsFromState, so `doneWhen` comes from the real producer.
 * - rows: { task: UiRoleTask, queueIndex } per role in queue order; queueIndex = open non-ready rows first, then
 *   ready rows, in queue order; null for done and dropped.
 * Source quirk: every design task's `outside` is "undefined #undefined" (the design's extractor lost them), so it
 * is dropped; `after` (same queue) and `block.on` ("<role> #<id>") carry the links.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UiRoleTask, UiTaskQueueRef, UiTaskQueueTask } from "../../../server/protocol.js";
import { taskOf } from "../../../server/roles-task-next.js";
import { workRecordsFromState } from "../../../server/work-records.js";

const DEFAULT_SOURCE = "/home/shinelay/design-lab/results/roles-grouping-20261115/shared/fixtures.json";
const SNAPSHOTS = ["busy", "tonight"] as const;
const OPEN_ACTIVE = new Set(["working", "asking", "stuck", "waiting", "blocked"]);

interface DesignTask {
	role: string;
	id: number;
	title: string;
	goal?: string;
	status: UiTaskQueueTask["status"];
	project?: string;
	initiative?: string;
	standalone?: boolean;
	tags?: string[];
	after?: number[];
	question?: string;
	choices?: string[];
	block?: { on?: string[]; need?: string; lead?: string; owes?: string; since?: number };
	wait?: { what: string; since?: number };
	summary?: string;
	dropped?: string;
	endedAt?: number;
}
interface DesignRecord {
	id: string;
	name: string;
	lead: string;
	status: "active" | "done" | "dropped";
	doneWhen: string[];
	met: string[];
	initiative?: string | null;
}
interface DesignSnapshot {
	takenAt: string;
	initiatives: DesignRecord[];
	projects: DesignRecord[];
	tasks: DesignTask[];
}

export interface RolesByProjectFixture {
	snapshot: string;
	source: string;
	sourceSha256: string;
	at: number;
	roster: { id: string; title: string }[];
	registry: {
		initiatives: [string, RegistryRecord][];
		projects: [string, RegistryRecord][];
	};
	rows: { task: UiRoleTask; queueIndex: number | null }[];
}
interface RegistryRecord {
	name: string;
	lead: string;
	status: "active" | "done" | "dropped";
	doneWhen: string[];
	met: { item: string }[];
	initiative?: string | null;
}

function refOf(text: string): UiTaskQueueRef {
	const m = /^([a-z0-9][a-z0-9-]*) #(\d+)$/.exec(text.trim());
	if (!m) throw new Error(`make-fixtures: unreadable block ref ${JSON.stringify(text)}`);
	return { file: "", name: m[1], id: Number(m[2]) };
}

function queueTaskOf(t: DesignTask, at: number): UiTaskQueueTask {
	const since = t.block?.since ?? t.wait?.since ?? t.endedAt ?? at;
	return {
		id: t.id,
		status: t.status,
		plan: { title: t.title, goal: t.goal ?? "", doneWhen: "", decided: "", steps: "", verify: "", mustNot: "" },
		addedAt: since,
		...(t.project ? { parent: { project: t.project } } : t.initiative ? { parent: { initiative: t.initiative } } : {}),
		...(t.standalone && !t.project && !t.initiative ? { parent: { standalone: true as const } } : {}),
		...(t.tags?.length ? { tags: [...t.tags] } : {}),
		...(t.after?.length ? { after: [...t.after] } : {}),
		...(t.question ? { question: t.question } : {}),
		...(t.choices?.length ? { choices: [...t.choices] } : {}),
		...(t.block
			? {
					block: {
						on: (t.block.on ?? []).map(refOf),
						...(t.block.need ? { need: t.block.need } : {}),
						...(t.block.lead ? { lead: t.block.lead } : {}),
						...(t.block.owes ? { owes: t.block.owes } : {}),
						since,
						start: since,
						tries: 0,
					},
				}
			: {}),
		...(t.wait ? { wait: { what: t.wait.what, check: "true", everyMs: 120_000, since, until: since + 86_400_000 } } : {}),
		...(t.summary ? { summary: t.summary } : {}),
		...(t.status === "done" && t.endedAt !== undefined ? { doneAt: t.endedAt } : {}),
		...(t.status === "dropped" ? { dropped: { why: t.dropped ?? "", at: t.endedAt ?? at } } : {}),
	};
}

function registryOf(records: DesignRecord[], kind: "initiative" | "project"): [string, RegistryRecord][] {
	return records.map((r) => [
		r.id,
		{
			name: r.name,
			lead: r.lead,
			status: r.status,
			doneWhen: [...r.doneWhen],
			met: r.met.map((item) => ({ item })),
			...(kind === "project" ? { initiative: r.initiative ?? null } : {}),
		},
	]);
}

export function fixtureOf(name: string, snap: DesignSnapshot, source: string, sha: string): RolesByProjectFixture {
	const at = Date.parse(snap.takenAt);
	if (!Number.isFinite(at)) throw new Error(`make-fixtures: ${name}.takenAt unreadable`);
	const byRole = new Map<string, DesignTask[]>();
	for (const t of snap.tasks) byRole.set(t.role, [...(byRole.get(t.role) ?? []), t]);
	const roles = [...byRole.keys()].sort();
	const rows: RolesByProjectFixture["rows"] = [];
	for (const role of roles) {
		const tasks = byRole.get(role) ?? [];
		const order = [
			...tasks.filter((t) => OPEN_ACTIVE.has(t.status)),
			...tasks.filter((t) => t.status === "ready"),
		];
		const index = new Map(order.map((t, i) => [t, i]));
		for (const t of tasks) rows.push({ task: taskOf(queueTaskOf(t, at), role, undefined, { now: at }), queueIndex: index.get(t) ?? null });
	}
	const registry = {
		initiatives: registryOf(snap.initiatives, "initiative"),
		projects: registryOf(snap.projects, "project"),
	};
	const work = workRecordsFromState({ initiatives: new Map(registry.initiatives), projects: new Map(registry.projects) });
	if (!work) throw new Error(`make-fixtures: ${name} registry is not a shape workRecordsFromState reads`);
	return {
		snapshot: name,
		source,
		sourceSha256: sha,
		at,
		roster: roles.map((id) => ({ id, title: id })),
		registry,
		rows,
	};
}

function main(argv: string[]): number {
	const check = argv.includes("--check");
	const source = argv.find((a) => !a.startsWith("--")) ?? DEFAULT_SOURCE;
	const bytes = readFileSync(source);
	const sha = createHash("sha256").update(bytes).digest("hex");
	const all = JSON.parse(bytes.toString("utf8")) as Record<string, DesignSnapshot>;
	const here = dirname(fileURLToPath(import.meta.url));
	let differs = 0;
	for (const name of SNAPSHOTS) {
		const snap = all[name];
		if (!snap) throw new Error(`make-fixtures: source has no "${name}" snapshot`);
		const text = `${JSON.stringify(fixtureOf(name, snap, source, sha))}\n`;
		const out = join(here, `${name}.json`);
		let committed = "";
		try {
			committed = readFileSync(out, "utf8");
		} catch {
			committed = "";
		}
		if (committed === text) {
			console.log(`${name}.json unchanged`);
			continue;
		}
		if (check) {
			console.error(`${name}.json differs from what ${source} makes now`);
			differs++;
			continue;
		}
		writeFileSync(out, text);
		console.log(`${name}.json written (${text.length} bytes)`);
	}
	return differs ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
