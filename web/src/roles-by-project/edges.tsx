/**
 * roles-by-project arrows (prototype elbow()): links drawn as bordered boxes (elbows with rounded corners) plus a
 * small head, measured from the laid-out cards so the map follows any width. On a phone the columns stack and
 * the arrows become brackets in the left gutter. Edge kinds: done (green), blocked (dashed coral), root (thick blue).
 */
import { useLayoutEffect, useRef, useState } from "react";
import type { TaskMapEdgeKind } from "../../../server/shared/roles-by-project/graph";

export interface Seg {
	cls: string;
	left: number;
	top: number;
	width: number;
	height: number;
}

const TIP = 6;
const GUTTER = 14;

/** One link from (x0,y0) to (x1,y1) as elbow pieces; `head` adds an arrow head, `bracket` draws left of both. */
export function elbow(
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	kind: TaskMapEdgeKind,
	head: boolean,
	bracket = false,
): Seg[] {
	const k = `e-${kind}`;
	const tip = head ? TIP : 0;
	const out: Seg[] = [];
	if (bracket) {
		out.push({
			cls: `ln br ${k}`,
			left: x0 - GUTTER,
			top: Math.min(y0, y1),
			width: GUTTER + x1 - x0 - tip,
			height: Math.abs(y1 - y0),
		});
	} else if (Math.abs(y1 - y0) < 3) {
		out.push({ cls: `ln h ${k}`, left: x0, top: y1, width: Math.max(0, x1 - x0 - tip), height: 0 });
	} else {
		const mid = Math.round((x0 + x1) / 2);
		const half = Math.abs(y1 - y0) / 2;
		const w1 = Math.max(0, mid - x0);
		const w2 = Math.max(0, x1 - mid - tip);
		if (y1 > y0) {
			out.push({ cls: `ln d1 ${k}`, left: x0, top: y0, width: w1, height: half });
			out.push({ cls: `ln d2 ${k}`, left: mid, top: y0 + half, width: w2, height: half });
		} else {
			out.push({ cls: `ln u1 ${k}`, left: x0, top: y1 + half, width: w1, height: half });
			out.push({ cls: `ln u2 ${k}`, left: mid, top: y1, width: w2, height: half });
		}
	}
	if (head) out.push({ cls: `hd ${k}`, left: x1 - 7, top: y1 - 4, width: 0, height: 0 });
	return out;
}

export function Segs({ segs }: { segs: readonly Seg[] }) {
	return (
		<>
			{segs.map((s, i) => (
				<i
					key={i}
					className={s.cls}
					style={{
						left: s.left,
						top: s.top,
						width: s.cls.startsWith("hd") ? undefined : s.width,
						height: s.cls.startsWith("hd") ? undefined : s.height,
					}}
				/>
			))}
		</>
	);
}

/**
 * Measures the cards (`[data-ref]`) inside `dag` after layout and draws `links` between them; re-measures when
 * the map resizes. Returns the ref for the dag box and the arrow layer to render inside it.
 */
export function useEdges(links: readonly { from: string; to: string; kind: TaskMapEdgeKind }[], key: string) {
	const dag = useRef<HTMLDivElement | null>(null);
	const [segs, setSegs] = useState<Seg[]>([]);
	useLayoutEffect(() => {
		const box = dag.current;
		if (!box) return;
		const draw = () => {
			const origin = box.getBoundingClientRect();
			const vertical = getComputedStyle(box).flexDirection === "column";
			const at = new Map<string, DOMRect>();
			for (const el of box.querySelectorAll<HTMLElement>("[data-ref]"))
				at.set(el.dataset.ref ?? "", el.getBoundingClientRect());
			const out: Seg[] = [];
			for (const e of links) {
				const a = at.get(e.from);
				const b = at.get(e.to);
				if (!a || !b || (!a.width && !b.width)) continue;
				const ax = a.left - origin.left + box.scrollLeft;
				const bx = b.left - origin.left + box.scrollLeft;
				const ay = a.top - origin.top + box.scrollTop + Math.min(a.height / 2, 24);
				const by = b.top - origin.top + box.scrollTop + Math.min(b.height / 2, 24);
				if (vertical || bx <= ax) out.push(...elbow(ax, ay, bx, by, e.kind, true, true));
				else out.push(...elbow(ax + a.width, ay, bx, by, e.kind, true));
			}
			setSegs((prev) => (JSON.stringify(prev) === JSON.stringify(out) ? prev : out));
		};
		draw();
		if (typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(draw);
		ro.observe(box);
		return () => ro.disconnect();
		// links are derived from `key` (the rows' refs and states); re-measure only when they change.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key]);
	return {
		dag,
		layer: (
			<span className="rbp-edges" aria-hidden="true">
				<Segs segs={segs} />
			</span>
		),
	};
}
