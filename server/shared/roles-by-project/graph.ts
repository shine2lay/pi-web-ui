/**
 * roles-by-project task maps (spec-graph.md): links, layers, cycles, root blockers, the mini-map window and
 * "Mostly held on". Shared by the server and the page: imports only types, no node:, no DOM.
 */
import type { UiBoardState, UiBoardTask } from "../../roles-board-protocol.js";

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

const LAYERS_MAX = 5;
const LAYERS_MIN = 3;
const PER_LAYER = 5;
const SQUARES_MAX = 40;

const STATE_RANK: Record<UiBoardState, number> = {
	"needs-you": 0,
	blocked: 1,
	waiting: 2,
	working: 3,
	queued: 4,
	done: 5,
};

type Row = Pick<UiBoardTask, "ref" | "state" | "queueIndex" | "dependsOnRefs" | "role">;

const isOpen = (row: Row) => row.state !== "done";

function compareRef(a: string, b: string): number {
	const [ra, ia] = a.split(" #");
	const [rb, ib] = b.split(" #");
	if (ra !== rb) return ra < rb ? -1 : 1;
	const na = Number(ia);
	const nb = Number(ib);
	if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
	return a < b ? -1 : a > b ? 1 : 0;
}

/** §Order: state rank, then queueIndex (null last), then ref. */
export function compareTasks(a: Row, b: Row): number {
	const rank = STATE_RANK[a.state] - STATE_RANK[b.state];
	if (rank) return rank;
	const qa = a.queueIndex ?? Number.POSITIVE_INFINITY;
	const qb = b.queueIndex ?? Number.POSITIVE_INFINITY;
	if (qa !== qb) return qa < qb ? -1 : 1;
	return compareRef(a.ref, b.ref);
}

interface Links {
	byRef: Map<string, Row>;
	preds: Map<string, string[]>;
	succs: Map<string, string[]>;
}

function linksOf(rows: readonly Row[]): Links {
	const byRef = new Map(rows.map((r) => [r.ref, r]));
	const preds = new Map<string, string[]>();
	const succs = new Map<string, string[]>();
	for (const r of rows) {
		preds.set(r.ref, []);
		succs.set(r.ref, []);
	}
	for (const r of rows) {
		for (const p of new Set(r.dependsOnRefs ?? [])) {
			if (p === r.ref || !byRef.has(p)) continue;
			preds.get(r.ref)?.push(p);
			succs.get(p)?.push(r.ref);
		}
	}
	return { byRef, preds, succs };
}

/** Strongly connected sets (Tarjan, iterative): each ref -> its unit id. */
function unitsOf(refs: readonly string[], succs: Map<string, string[]>): Map<string, number> {
	const index = new Map<string, number>();
	const low = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	const unit = new Map<string, number>();
	let next = 0;
	let units = 0;
	for (const start of refs) {
		if (index.has(start)) continue;
		const work: { ref: string; i: number }[] = [{ ref: start, i: 0 }];
		index.set(start, next);
		low.set(start, next++);
		stack.push(start);
		onStack.add(start);
		while (work.length) {
			const top = work[work.length - 1];
			const out = succs.get(top.ref) ?? [];
			if (top.i < out.length) {
				const s = out[top.i++];
				if (!index.has(s)) {
					index.set(s, next);
					low.set(s, next++);
					stack.push(s);
					onStack.add(s);
					work.push({ ref: s, i: 0 });
				} else if (onStack.has(s)) {
					low.set(top.ref, Math.min(low.get(top.ref) ?? 0, index.get(s) ?? 0));
				}
				continue;
			}
			work.pop();
			if (work.length) {
				const parent = work[work.length - 1].ref;
				low.set(parent, Math.min(low.get(parent) ?? 0, low.get(top.ref) ?? 0));
			}
			if (low.get(top.ref) === index.get(top.ref)) {
				let member: string | undefined;
				do {
					member = stack.pop();
					if (member === undefined) break;
					onStack.delete(member);
					unit.set(member, units);
				} while (member !== top.ref);
				units++;
			}
		}
	}
	return unit;
}

/** Undirected connected parts. */
function partsOf(refs: readonly string[], links: Links): string[][] {
	const seen = new Set<string>();
	const parts: string[][] = [];
	for (const ref of refs) {
		if (seen.has(ref)) continue;
		const part: string[] = [];
		const todo = [ref];
		seen.add(ref);
		while (todo.length) {
			const x = todo.pop() as string;
			part.push(x);
			for (const y of [...(links.preds.get(x) ?? []), ...(links.succs.get(x) ?? [])]) {
				if (!seen.has(y)) {
					seen.add(y);
					todo.push(y);
				}
			}
		}
		parts.push(part);
	}
	return parts;
}

/** One group's map over its rows, never windowed (the opened map). */
export function taskMapOf(rows: readonly UiBoardTask[]): TaskMap {
	const links = linksOf(rows);
	const refs = rows.map((r) => r.ref);
	const row = (ref: string) => links.byRef.get(ref) as Row;
	const byOrder = (a: string, b: string) => compareTasks(row(a), row(b));

	const unit = unitsOf(refs, links.succs);
	const members = new Map<number, string[]>();
	for (const ref of refs) {
		const u = unit.get(ref) as number;
		members.set(u, [...(members.get(u) ?? []), ref]);
	}
	const cyclic = (ref: string) => (members.get(unit.get(ref) as number)?.length ?? 0) > 1;
	const cycles = [...members.values()]
		.filter((m) => m.length > 1)
		.map((m) => [...m].sort(compareRef))
		.sort((a, b) => compareRef(a[0], b[0]));

	const unitLayer = new Map<number, number>();
	const layerOfUnit = (u: number): number => {
		const known = unitLayer.get(u);
		if (known !== undefined) return known;
		unitLayer.set(u, 0);
		let layer = 0;
		for (const m of members.get(u) ?? []) {
			for (const p of links.preds.get(m) ?? []) {
				const pu = unit.get(p) as number;
				if (pu !== u) layer = Math.max(layer, layerOfUnit(pu) + 1);
			}
		}
		unitLayer.set(u, layer);
		return layer;
	};

	const parts = partsOf(refs, links);
	const linked = parts.filter((p) => p.length > 1);
	const loose = parts
		.filter((p) => p.length === 1)
		.map((p) => p[0])
		.sort(byOrder);

	const layers: string[][] = [];
	for (const part of linked) {
		for (const ref of part) {
			const layer = layerOfUnit(unit.get(ref) as number);
			(layers[layer] ??= []).push(ref);
		}
	}
	for (const layer of layers) layer.sort(byOrder);

	const openCount = (part: string[]) => part.filter((r) => isOpen(row(r))).length;
	const lowestRank = (part: string[]) => Math.min(...part.map((r) => STATE_RANK[row(r).state]));
	const layerIndex = new Map<string, number>();
	layers.forEach((layer, i) => {
		for (const r of layer) layerIndex.set(r, i);
	});
	const chains = linked
		.map((part) => [...part].sort((a, b) => (layerIndex.get(a) ?? 0) - (layerIndex.get(b) ?? 0) || byOrder(a, b)))
		.sort((a, b) => lowestRank(a) - lowestRank(b) || openCount(b) - openCount(a) || compareRef(a[0] ?? "", b[0] ?? ""));

	const roots: TaskMap["roots"] = [];
	for (const ref of refs) {
		if (!isOpen(row(ref))) continue;
		if ((links.preds.get(ref) ?? []).some((p) => isOpen(row(p)))) continue;
		const seen = new Set<string>();
		const todo = [...(links.succs.get(ref) ?? [])];
		while (todo.length) {
			const x = todo.pop() as string;
			if (seen.has(x) || x === ref || !isOpen(row(x))) continue;
			seen.add(x);
			todo.push(...(links.succs.get(x) ?? []));
		}
		if (seen.size) roots.push({ ref, waiting: seen.size });
	}
	roots.sort((a, b) => b.waiting - a.waiting || byOrder(a.ref, b.ref));
	const rootSet = new Set(roots.map((r) => r.ref));

	const edges: TaskMap["edges"] = [];
	for (const to of refs) {
		for (const from of links.preds.get(to) ?? []) {
			const inner = cyclic(from) && unit.get(from) === unit.get(to);
			const kind: TaskMapEdgeKind = inner
				? "plain"
				: rootSet.has(from)
					? "root"
					: row(from).state === "done"
						? "done"
						: row(to).state === "blocked"
							? "blocked"
							: "plain";
			edges.push({ from, to, kind });
		}
	}

	return { layers: layers.filter(Boolean), edges, chains, loose, roots, cycles };
}

/** The 5-layer window from the first layer holding an open task (null: none open). Layers are 0-based. */
export function layerWindow(layerCount: number, firstOpenLayer: number | null): LayerWindow {
	let start = firstOpenLayer ?? Math.max(0, layerCount - LAYERS_MIN);
	const end = Math.min(layerCount, start + LAYERS_MAX);
	start = Math.max(0, Math.min(start, end - LAYERS_MIN));
	return { start, end, earlier: start, later: layerCount - end };
}

/** The closed tile's mini map: the biggest chain windowed to 5 layers, then loose squares (40, then "+N"). */
export function miniMapOf(map: TaskMap, rows: readonly UiBoardTask[]): MiniMap {
	const byRef = new Map(rows.map((r) => [r.ref, r]));
	const open = (ref: string) => {
		const r = byRef.get(ref);
		return r ? isOpen(r) : false;
	};
	let chain: string[] | undefined;
	for (const c of map.chains) if (!chain || c.length > chain.length) chain = c;

	let columns: MiniMap["columns"] = [];
	let earlier = 0;
	let later = 0;
	if (chain) {
		const inChain = new Set(chain);
		const chainLayers = map.layers.map((l) => l.filter((r) => inChain.has(r))).filter((l) => l.length);
		const firstOpen = chainLayers.findIndex((l) => l.some(open));
		const win = layerWindow(chainLayers.length, firstOpen < 0 ? null : firstOpen);
		columns = chainLayers.slice(win.start, win.end).map((l) => ({
			refs: l.slice(0, PER_LAYER),
			more: Math.max(0, l.length - PER_LAYER),
		}));
		earlier = win.earlier;
		later = win.later;
	}

	const anyOpen = rows.some(isOpen);
	const pool = anyOpen ? map.loose.filter(open) : chain ? [] : map.loose;
	return {
		columns,
		earlier,
		later,
		squares: { refs: pool.slice(0, SQUARES_MAX), more: Math.max(0, pool.length - SQUARES_MAX) },
	};
}

/** "Mostly held on <Role> (n)": the role most blocked tasks wait on, when 2 or more; else null. */
export function heldOnOf(rows: readonly UiBoardTask[]): { role: string; count: number } | null {
	const counts = new Map<string, number>();
	for (const r of rows) {
		if (r.state !== "blocked") continue;
		const other = (r.dependsOnRefs ?? []).map((d) => d.split(" #")[0]).find((role) => role && role !== r.role);
		if (other) counts.set(other, (counts.get(other) ?? 0) + 1);
	}
	let top: { role: string; count: number } | null = null;
	for (const [role, count] of counts) {
		if (!top || count > top.count || (count === top.count && role < top.role)) top = { role, count };
	}
	return top && top.count >= 2 ? top : null;
}
