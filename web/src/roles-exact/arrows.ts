/** The ring's arrows: from a department to the owner for its asks waiting on him, and between departments for open
 *  requests and questions; each with its label placed clear of the cards. */
import { exactAge, type ExactPair, type ExactRoles } from "../roles-exact-model";
import type { ringLayout } from "../roles-u0/layout";
import type { SurfaceValues } from "../roles-u0/types";
import { obstacleHalfHeight } from "./card-layout";
import { roleName } from "./sent-requests";

/** The source's owner-edge geometry, without message history, animations or invented kinds. */
export function ownerEdges(
	model: ExactRoles,
	layout: ReturnType<typeof ringLayout>,
	hover: string | null,
): SurfaceValues[] {
	if (model.needs.tell !== "can-tell") return [];
	const end = layout.pos.get("you");
	if (!end) return [];
	const obstacles = [...layout.pos].map(([id, p]) => ({
		p,
		x: id === "you" ? 82 : layout.nodeW / 2 + 10,
		y: obstacleHalfHeight(model, id),
	}));
	const clear = (p: number[]) =>
		obstacles.every((o) => Math.abs(p[0] - o.p[0]) > o.x + 70 || Math.abs(p[1] - o.p[1]) > o.y + 14);
	return model.roles
		.filter((r) => r.panel?.status === "needs-you" || model.needs.items.some((i) => i.roleId === r.row.roleId))
		.flatMap((r) => {
			const start = layout.pos.get(r.row.roleId);
			if (!start) return [];
			const dx = end[0] - start[0],
				dy = end[1] - start[1],
				length = Math.hypot(dx, dy) || 1;
			const ux = dx / length,
				uy = dy / length;
			const at = (t: number) => [start[0] + dx * t, start[1] + dy * t];
			const t = [0.5, 0.42, 0.58, 0.35, 0.65, 0.3, 0.7, 0.25, 0.75].find((t) => clear(at(t))) ?? 0.5;
			const point = at(t),
				label = clear(point) ? point : [point[0] - uy * 28, point[1] + ux * 28];
			const head = at(t <= 0.5 ? Math.min(0.88, t + 0.16) : Math.max(0.12, t - 0.16));
			const connected = !hover || hover === "you" || hover === r.row.roleId;
			return [
				{
					d: `M${start[0]} ${start[1]} Q${(start[0] + end[0]) / 2} ${(start[1] + end[1]) / 2} ${end[0]} ${end[1]}`,
					arrow: `M${head[0] + ux * 8} ${head[1] + uy * 8} L${head[0] - ux * 6 - uy * 6} ${head[1] - uy * 6 + ux * 6} L${head[0] - ux * 6 + uy * 6} ${head[1] - uy * 6 - ux * 6} Z`,
					stroke: "#B08433",
					sw: hover && connected ? "2.5" : "1.6",
					op: connected ? "0.95" : "0.08",
					lxp: `${(label[0] / layout.width) * 100}%`,
					lyp: `${(label[1] / layout.height) * 100}%`,
					chip: "Waiting on you",
					chipFg: "#F0B95A",
					chipBd: "#2F343A",
					glow: "none",
					aria: `${r.row.roleLabel}: waiting on you`,
				},
			];
		});
}
const LABEL_AT = [0.5, 0.42, 0.58, 0.35, 0.65, 0.3, 0.7, 0.25, 0.75];
/**
 * roles-sent: the design's between-department edges (its "dept" kind), one per sender → receiver pair with
 * open requests or questions: curved toward the centre, split apart when both directions are open, the head
 * pointing at the receiver. Same hover rules as the owner edges.
 */
export function roleEdges(
	model: ExactRoles,
	layout: ReturnType<typeof ringLayout>,
	hover: string | null,
): { edge: SurfaceValues; pair: ExactPair }[] {
	const pairs = model.pairs ?? [];
	const centre = layout.pos.get("you");
	if (!pairs.length || !centre) return [];
	const obstacles = [...layout.pos].map(([id, p]) => ({
		p,
		x: id === "you" ? 82 : layout.nodeW / 2 + 10,
		y: obstacleHalfHeight(model, id),
	}));
	const clear = (p: number[]) =>
		obstacles.every((o) => Math.abs(p[0] - o.p[0]) > o.x + 70 || Math.abs(p[1] - o.p[1]) > o.y + 14);
	const open = new Set(pairs.map((p) => `${p.from}>${p.to}`));
	return pairs.flatMap((pair) => {
		const p1 = layout.pos.get(pair.from),
			p2 = layout.pos.get(pair.to);
		if (!p1 || !p2) return [];
		const mx = (p1[0] + p2[0]) / 2,
			my = (p1[1] + p2[1]) / 2;
		let c = [mx + (centre[0] - mx) * 0.38, my + (centre[1] - my) * 0.38];
		if (open.has(`${pair.to}>${pair.from}`)) {
			const dx = p2[0] - p1[0],
				dy = p2[1] - p1[1],
				L = Math.hypot(dx, dy) || 1;
			c = [c[0] - (dy / L) * 30, c[1] + (dx / L) * 30];
		}
		const at = (t: number) => {
			const u = 1 - t;
			return [u * u * p1[0] + 2 * u * t * c[0] + t * t * p2[0], u * u * p1[1] + 2 * u * t * c[1] + t * t * p2[1]];
		};
		const lt = LABEL_AT.find((t) => clear(at(t))) ?? 0.5;
		const aT = lt <= 0.5 ? Math.min(0.88, lt + 0.16) : Math.max(0.12, lt - 0.16);
		const ah = at(aT);
		const tv = [
			2 * (1 - aT) * (c[0] - p1[0]) + 2 * aT * (p2[0] - c[0]),
			2 * (1 - aT) * (c[1] - p1[1]) + 2 * aT * (p2[1] - c[1]),
		];
		const tl = Math.hypot(tv[0], tv[1]) || 1,
			ux = tv[0] / tl,
			uy = tv[1] / tl;
		const lp0 = at(lt);
		const lp = clear(lp0) ? lp0 : [lp0[0] - uy * 28, lp0[1] + ux * 28];
		const connected = !hover || hover === pair.from || hover === pair.to;
		const what = `${pair.count} open ${pair.count === 1 ? "request or question" : "requests or questions"}`;
		const newest = pair.at === null ? "" : `, newest ${exactAge(pair.at, model.now)} ago`;
		return [
			{
				pair,
				edge: {
					d: `M${p1[0]} ${p1[1]} Q${c[0]} ${c[1]} ${p2[0]} ${p2[1]}`,
					arrow: `M${ah[0] + ux * 8} ${ah[1] + uy * 8} L${ah[0] - ux * 6 - uy * 6} ${ah[1] - uy * 6 + ux * 6} L${ah[0] - ux * 6 + uy * 6} ${ah[1] - uy * 6 - ux * 6} Z`,
					stroke: "#4A82C0",
					sw: hover && connected ? "2.5" : "1.6",
					op: connected ? (model.lastReceived ? "0.55" : "0.95") : "0.08",
					lxp: `${(lp[0] / layout.width) * 100}%`,
					lyp: `${(lp[1] / layout.height) * 100}%`,
					chip: `${pair.count} open`,
					chipFg: "#9CC7FF",
					chipBd: "#2F343A",
					glow: "none",
					aria: `${roleName(model, pair.from)} waiting on ${roleName(model, pair.to)}: ${what}${newest}`,
				},
			},
		];
	});
}
