/**
 * roles-by-project task maps (spec-graph.md): links, layers, cycles, root blockers, the mini-map window and
 * "Mostly held on". Shared by the server and the page: imports only types, no node:, no DOM.
 * Seam stub (frontend #293); Frontend #294 implements it and makes tests/unit/roles-by-project-graph.test.ts pass.
 */
import type { UiBoardTask } from "../../roles-board-protocol.js";

export const ROLES_BY_PROJECT_GRAPH_NOT_BUILT = "roles-by-project: not built (Frontend #294 task)";

export type TaskMapEdgeKind = "done" | "blocked" | "root" | "plain";

export interface TaskMap {
	/** Refs per layer, left to right, each layer ordered (spec-graph.md §Order). */
	layers: string[][];
	edges: { from: string; to: string; kind: TaskMapEdgeKind }[];
	/** Connected parts with 2+ tasks, ordered (§Order). */
	chains: string[][];
	/** Tasks with no link inside the group ("On their own"). */
	loose: string[];
	/** Root blockers and how many open tasks wait on each. */
	roots: { ref: string; waiting: number }[];
	/** Each set of tasks that wait on each other, refs sorted. */
	cycles: string[][];
}

export interface MiniMap {
	/** The windowed layers of the drawn chain. */
	columns: { refs: string[]; more: number }[];
	/** Layers cut before / after the window. */
	earlier: number;
	later: number;
	/** Loose open tasks, or done ones when nothing is open. */
	squares: { refs: string[]; more: number };
}

export interface LayerWindow {
	start: number;
	end: number;
	earlier: number;
	later: number;
}

/** One group's map over its rows, never windowed (the opened map). */
export function taskMapOf(_rows: readonly UiBoardTask[]): TaskMap {
	throw new Error(ROLES_BY_PROJECT_GRAPH_NOT_BUILT);
}

/** The closed tile's mini map: the biggest chain windowed to 5 layers, then loose squares (40, then "+N"). */
export function miniMapOf(_map: TaskMap, _rows: readonly UiBoardTask[]): MiniMap {
	throw new Error(ROLES_BY_PROJECT_GRAPH_NOT_BUILT);
}

/** The 5-layer window from the first layer holding an open task (null: none open). Layers are 0-based. */
export function layerWindow(_layerCount: number, _firstOpenLayer: number | null): LayerWindow {
	throw new Error(ROLES_BY_PROJECT_GRAPH_NOT_BUILT);
}

/** "Mostly held on <Role> (n)": the role most blocked tasks wait on, when 2 or more; else null. */
export function heldOnOf(_rows: readonly UiBoardTask[]): { role: string; count: number } | null {
	throw new Error(ROLES_BY_PROJECT_GRAPH_NOT_BUILT);
}
