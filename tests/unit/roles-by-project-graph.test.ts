/**
 * roles-by-project G-cases (spec-acceptance.md §G; spec-graph.md): task maps, the 5-layer window, root blockers and
 * "Mostly held on". Failing first (frontend #293 seam); Frontend #294 makes them pass by turning `notBuilt(` into
 * `it(`, never by deleting or weakening a case.
 */
import { describe, expect } from "vitest";
import type { UiRoleTask } from "../../server/protocol.js";
import type { UiBoardState, UiBoardTask } from "../../server/roles-board-protocol.js";
import {
	heldOnOf,
	layerWindow,
	miniMapOf,
	type TaskMap,
	taskMapOf,
} from "../../server/shared/roles-by-project/graph.js";
import { notBuilt } from "./roles-by-project-not-built.js";

const STATUS: Record<UiBoardState, UiRoleTask["status"]> = {
	"needs-you": "stuck",
	blocked: "blocked",
	waiting: "waiting",
	working: "working",
	queued: "ready",
	done: "done",
};

const row = (ref: string, state: UiBoardState, dependsOnRefs: string[] = [], queueIndex?: number): UiBoardTask => {
	const [role, id] = ref.split(" #");
	return {
		id: Number(id),
		role,
		title: `${ref} title`,
		status: STATUS[state],
		ref,
		groupKey: "tag:map",
		state,
		queueIndex: state === "done" ? null : (queueIndex ?? Number(id)),
		dependsOnRefs,
		...(state === "done" ? { finishedAt: 1_800_000_000_000 - Number(id), doneSummary: `${ref} done` } : {}),
	};
};

const nodesOf = (map: TaskMap) => new Set([...map.layers.flat(), ...map.loose]);
const layerOf = (map: TaskMap, ref: string) => map.layers.findIndex((l) => l.includes(ref));
const edgeSet = (map: TaskMap) => map.edges.map((e) => `${e.from} -> ${e.to}`).sort();

describe("roles-by-project G1-G2: links and cycles", () => {
	notBuilt(
		"G1 links only from dependsOnRefs inside the group; same-group cross-queue ref drawn; no guessed nodes",
		() => {
			const rows = [
				row("backend #1", "queued"),
				row("backend #2", "queued", ["backend #1", "backend #1", "backend #2", "qa #99", "frontend #5"]),
				row("temper #38", "working"),
				row("backend #3", "blocked", ["temper #38"]),
			];
			const map = taskMapOf(rows);
			expect(edgeSet(map)).toEqual(["backend #1 -> backend #2", "temper #38 -> backend #3"]);
			expect([...nodesOf(map)].sort()).toEqual(["backend #1", "backend #2", "backend #3", "temper #38"]);
			expect(map.layers.flat().includes("qa #99") || map.layers.flat().includes("frontend #5")).toBe(false);
			expect(layerOf(map, "temper #38")).toBeLessThan(layerOf(map, "backend #3"));
		},
	);

	notBuilt("G1 a self-reference alone makes no link: the task is loose", () => {
		const map = taskMapOf([row("backend #1", "queued", ["backend #1"]), row("backend #2", "queued")]);
		expect(map.edges).toEqual([]);
		expect([...map.loose].sort()).toEqual(["backend #1", "backend #2"]);
		expect(map.chains).toEqual([]);
	});

	notBuilt("G2 cycle A -> B -> A: one layer, both kept, listed in cycles, inner links plain", () => {
		const rows = [
			row("backend #1", "queued", ["backend #2"]),
			row("backend #2", "blocked", ["backend #1"]),
			row("backend #3", "queued", ["backend #1"]),
		];
		const map = taskMapOf(rows);
		expect(map.cycles).toEqual([["backend #1", "backend #2"]]);
		expect(layerOf(map, "backend #1")).toBeGreaterThanOrEqual(0);
		expect(layerOf(map, "backend #1")).toBe(layerOf(map, "backend #2"));
		expect(layerOf(map, "backend #3")).toBe(layerOf(map, "backend #1") + 1);
		expect(nodesOf(map)).toEqual(new Set(rows.map((r) => r.ref)));
		for (const e of map.edges.filter((x) => x.to !== "backend #3")) expect(e.kind).toBe("plain");
	});
});

describe("roles-by-project G3-G4: window and caps", () => {
	notBuilt("G3 layerWindow: from the first open layer, at most 5, at least 3", () => {
		expect(layerWindow(8, 5)).toEqual({ start: 5, end: 8, earlier: 5, later: 0 });
		expect(layerWindow(8, 0)).toEqual({ start: 0, end: 5, earlier: 0, later: 3 });
		expect(layerWindow(8, null)).toEqual({ start: 5, end: 8, earlier: 5, later: 0 });
		expect(layerWindow(2, 0)).toEqual({ start: 0, end: 2, earlier: 0, later: 0 });
	});

	notBuilt("G4 a layer of 7 shows 5 (queue order) and +2", () => {
		const rows = [row("backend #1", "working", [], 0)];
		for (let i = 2; i <= 8; i++) rows.push(row(`backend #${i}`, "queued", ["backend #1"], i - 1));
		const map = taskMapOf(rows);
		const mini = miniMapOf(map, rows);
		expect(mini.columns.map((c) => c.refs.length)).toEqual([1, 5]);
		expect(mini.columns[1]).toEqual({
			refs: ["backend #2", "backend #3", "backend #4", "backend #5", "backend #6"],
			more: 2,
		});
		expect([mini.earlier, mini.later]).toEqual([0, 0]);
	});

	notBuilt("G4 45 loose open tasks show 40 squares and +5", () => {
		const rows = Array.from({ length: 45 }, (_, i) => row(`qa #${i + 1}`, "queued"));
		const map = taskMapOf(rows);
		expect(map.loose.length).toBe(45);
		const mini = miniMapOf(map, rows);
		expect(mini.columns).toEqual([]);
		expect(mini.squares.refs.length).toBe(40);
		expect(mini.squares.more).toBe(5);
		expect(mini.squares.refs).toEqual(rows.slice(0, 40).map((r) => r.ref));
	});

	notBuilt("G4 nothing open and no chain: the done tasks as squares", () => {
		const rows = [row("qa #1", "done"), row("qa #2", "done")];
		const mini = miniMapOf(taskMapOf(rows), rows);
		expect([...mini.squares.refs].sort()).toEqual(["qa #1", "qa #2"]);
		expect(mini.squares.more).toBe(0);
	});
});

describe("roles-by-project G5-G6: root blockers and held on", () => {
	notBuilt("G5 root blocker with 3 open tasks after it: waiting 3, its edges root", () => {
		const rows = [
			row("backend #0", "done"),
			row("backend #1", "queued", ["backend #0"]),
			row("backend #2", "blocked", ["backend #1"]),
			row("backend #3", "queued", ["backend #2"]),
			row("frontend #4", "waiting", ["backend #1"]),
		];
		const map = taskMapOf(rows);
		expect(map.roots).toEqual([{ ref: "backend #1", waiting: 3 }]);
		const kind = (from: string, to: string) => map.edges.find((e) => e.from === from && e.to === to)?.kind;
		expect(kind("backend #1", "backend #2")).toBe("root");
		expect(kind("backend #1", "frontend #4")).toBe("root");
		expect(kind("backend #0", "backend #1")).toBe("done");
		expect(kind("backend #2", "backend #3")).toBe("plain");
	});

	notBuilt("G6 held on: 3 on Backend, 1 on QA -> backend 3 (first ref naming another role; blocked only)", () => {
		const rows = [
			row("frontend #1", "blocked", ["backend #10"]),
			row("frontend #2", "blocked", ["backend #10"]),
			row("frontend #3", "blocked", ["frontend #9", "backend #11"]),
			row("frontend #4", "blocked", ["qa #20"]),
			row("frontend #5", "queued", ["backend #12"]),
			row("frontend #9", "queued"),
		];
		expect(heldOnOf(rows)).toEqual({ role: "backend", count: 3 });
	});

	notBuilt("G6 held on: 1 and 1 -> null; 2 and 2 -> lexically first role id", () => {
		expect(heldOnOf([row("frontend #1", "blocked", ["backend #10"]), row("frontend #2", "blocked", ["qa #20"])])).toBe(
			null,
		);
		expect(
			heldOnOf([
				row("frontend #1", "blocked", ["qa #20"]),
				row("frontend #2", "blocked", ["qa #21"]),
				row("frontend #3", "blocked", ["architecture #5"]),
				row("frontend #4", "blocked", ["architecture #6"]),
			]),
		).toEqual({ role: "architecture", count: 2 });
	});
});

describe("roles-by-project G7: opened map, scale, empty", () => {
	notBuilt(
		"G7 opened map holds every row, none windowed; done links are done; the mini map windows the same chain",
		() => {
			const rows = [row("backend #1", "done")];
			for (let i = 2; i <= 9; i++) rows.push(row(`backend #${i}`, i <= 4 ? "done" : "queued", [`backend #${i - 1}`]));
			for (let i = 20; i < 30; i++) rows.push(row(`qa #${i}`, "queued"));
			const map = taskMapOf(rows);
			expect(nodesOf(map)).toEqual(new Set(rows.map((r) => r.ref)));
			expect(map.layers.filter((l) => l.some((r) => r.startsWith("backend"))).length).toBe(9);
			for (let i = 1; i <= 9; i++) expect(layerOf(map, `backend #${i}`)).toBe(i - 1);
			for (const e of map.edges)
				if (["backend #1", "backend #2", "backend #3", "backend #4"].includes(e.from)) expect(e.kind).toBe("done");
			expect(map.loose.length).toBe(10);
			const mini = miniMapOf(map, rows);
			expect(mini.columns.length).toBe(5);
			expect([mini.earlier, mini.later]).toEqual([4, 0]);
			expect(mini.columns[0].refs).toEqual(["backend #5"]);
		},
	);

	notBuilt("G7 260 tasks: every node and edge is in the data; a layer is 1 + its highest linked predecessor", () => {
		const rows: UiBoardTask[] = [];
		const states: UiBoardState[] = ["done", "queued", "working", "blocked", "waiting", "needs-you"];
		for (let i = 1; i <= 260; i++) {
			const deps = [
				i % 7 === 0 ? `ops #${i - 3}` : "",
				i % 5 === 0 ? `ops #${i - 1}` : "",
				i % 13 === 0 ? "temper #9999" : "",
			];
			rows.push(
				row(
					`ops #${i}`,
					states[i % states.length],
					deps.filter((d) => d && !d.endsWith("#0") && !d.includes("#-")),
				),
			);
		}
		const map = taskMapOf(rows);
		const refs = new Set(rows.map((r) => r.ref));
		expect(nodesOf(map)).toEqual(refs);
		const linked = new Set<string>();
		for (const r of rows)
			for (const d of new Set(r.dependsOnRefs)) if (refs.has(d) && d !== r.ref) linked.add(`${d} -> ${r.ref}`);
		expect(edgeSet(map)).toEqual([...linked].sort());
		for (const r of rows) {
			const preds = [...new Set(r.dependsOnRefs)].filter((d) => refs.has(d) && d !== r.ref);
			if (layerOf(map, r.ref) < 0) continue;
			const want = preds.length ? 1 + Math.max(...preds.map((p) => layerOf(map, p))) : 0;
			expect([r.ref, layerOf(map, r.ref)]).toEqual([r.ref, want]);
		}
		expect(map.cycles).toEqual([]);
	});

	notBuilt("G7 empty group: empty map, empty mini, nobody held on", () => {
		const map = taskMapOf([]);
		expect(map).toEqual({ layers: [], edges: [], chains: [], loose: [], roots: [], cycles: [] });
		expect(miniMapOf(map, [])).toEqual({ columns: [], earlier: 0, later: 0, squares: { refs: [], more: 0 } });
		expect(heldOnOf([])).toBe(null);
	});
});
