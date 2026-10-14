// The design's department ring, ported formula for formula from the supplied
// source (the design's "Layout:" block). Pure and
// deterministic: the same registry and graph size give the same positions.
// Unit tests compare it number for number with the verbatim source.

export interface RingRole {
	readonly id: string;
	readonly name: string;
}
export interface RingLayout {
	readonly width: number;
	readonly height: number;
	readonly nodeW: number;
	/** Centre of each node box in graph pixels, keyed by role id, plus "you". */
	readonly pos: ReadonlyMap<string, readonly [number, number]>;
}

/** The inner ring: the departments the owner uses most (source constant). */
export const HUB_IDS: readonly string[] = Object.freeze(["coo", "ops", "temper"]);
const SAMPLES = 720;

// The source sorts with String.prototype.localeCompare and no arguments. The
// reference capture pins en-US; pinning it here keeps the order the same
// whatever locale the host runs in.
const byName = (a: RingRole, b: RingRole): number => a.name.localeCompare(b.name, "en-US");

export function ringLayout(roles: readonly RingRole[], graphWidth?: number, graphHeight?: number): RingLayout {
	// Source: VW = st.gw || 1400, VH = st.gh || 780 (falsy sizes fall back).
	const VW = graphWidth || 1400,
		VH = graphHeight || 780;
	const outer = roles
		.filter((r) => HUB_IDS.indexOf(r.id) < 0)
		.slice()
		.sort(byName);
	const hub = roles
		.filter((r) => HUB_IDS.indexOf(r.id) >= 0)
		.slice()
		.sort(byName);
	const nodeWu = Math.max(150, Math.min(180, Math.round(VW / 9)));
	const CX = VW / 2,
		CY = VH / 2,
		RX = VW / 2 - nodeWu / 2 - 28,
		RY = VH / 2 - 64;
	const IRX = Math.max(250, RX * 0.46),
		IRY = Math.max(108, Math.min(RY * 0.55, RY - 120));
	const pos = new Map<string, readonly [number, number]>();
	pos.set("you", [CX, CY]);
	const INA = hub.length === 3 ? [180, 0, -90] : hub.map((_, i) => 180 + (i * 360) / hub.length);
	hub.forEach((r, i) => {
		const a = (INA[i] * Math.PI) / 180;
		pos.set(r.id, [CX + IRX * Math.cos(a), CY + IRY * Math.sin(a)]);
	});
	// Outer ring: equal spacing along the ellipse's length, as in the source.
	const epts: [number, number][] = [],
		cum = [0];
	for (let k = 0; k <= SAMPLES; k++) {
		const a = -Math.PI / 2 + (k * 2 * Math.PI) / SAMPLES;
		epts.push([CX + RX * Math.cos(a), CY + RY * Math.sin(a)]);
		if (k > 0) cum.push(cum[k - 1] + Math.hypot(epts[k][0] - epts[k - 1][0], epts[k][1] - epts[k - 1][1]));
	}
	const N = outer.length;
	outer.forEach((r, i) => {
		const target = ((i + 0.5) * cum[SAMPLES]) / N;
		let k = 0;
		while (k < SAMPLES && cum[k] < target) k++;
		pos.set(r.id, epts[k]);
	});
	return { width: VW, height: VH, nodeW: nodeWu, pos };
}

/** The template's box anchor: percentages of the graph, exactly as the source writes them. */
export function ringAnchor(layout: RingLayout, id: string): { px: string; py: string } | null {
	const p = layout.pos.get(id);
	return p ? { px: (p[0] / layout.width) * 100 + "%", py: (p[1] / layout.height) * 100 + "%" } : null;
}
