/** Where department cards sit on the ring, and how much room a card takes: a card with a budget line is taller,
 *  so it moves away from a close neighbour, and the arrows' labels keep clear of it. */
import type { ExactRoles } from "../roles-exact-model";
import type { ringLayout } from "../roles-u0/layout";
import { cardHasSpend } from "./spending";

/**
 * roles-budget-card: what a budget line adds to a card's height (gap, two 11.5 px mono lines, gap, 4 px bar);
 * measured 48.35 px in the sealed browser check (146.77 px against 98.42 px).
 */
const CARD_SPEND_HEIGHT = 48;
/** Half a label obstacle's height around a role's spot; cards are centred there, so a budget line adds half each way. */
export function obstacleHalfHeight(model: ExactRoles, id: string): number {
	if (id === "you") return 42;
	return 60 + (cardHasSpend(model.roles.find((r) => r.row.roleId === id)?.spend) ? CARD_SPEND_HEIGHT / 2 : 0);
}
/** roles-budget-card: half a card without a budget line (the template's card measures 98.4 px tall). */
const CARD_HALF = 50;
/** Half a card's width: nodeW plus the template's 10 px each side, as the label obstacles count it. */
const cardHalfWidth = (ring: ReturnType<typeof ringLayout>) => ring.nodeW / 2 + 10;
/**
 * roles-budget-card: how far a card with a budget line moves from its ring spot, in px (down +, up -). Centred, the
 * taller card grows CARD_SPEND_HEIGHT / 2 each way. Under ~1300 px wide the inner ring's 250 px floor sets Ops and
 * COO close beside the outer cards at the sides (at 1050 px Design sits ~95 px below Ops), so when either side lacks
 * that room the card keeps its edge on the tighter side where the design puts it and grows toward the roomier side.
 * Room is the gap to the nearest card in its column, or to the ring's own top or bottom. Cards without a line keep
 * the design's spots; the phone column needs none of this, as it stacks measured heights.
 */
export function exactCardShifts(model: ExactRoles, ring: ReturnType<typeof ringLayout>): Map<string, number> {
	const shifts = new Map<string, number>();
	const half = CARD_SPEND_HEIGHT / 2;
	for (const role of model.roles) {
		const id = role.row.roleId;
		const p = ring.pos.get(id);
		if (!p || !cardHasSpend(role.spend)) continue;
		let up = p[1] - CARD_HALF;
		let down = ring.height - p[1] - CARD_HALF;
		for (const [other, q] of ring.pos) {
			if (other === id) continue;
			const you = other === "you";
			if (Math.abs(q[0] - p[0]) >= cardHalfWidth(ring) + (you ? 82 : cardHalfWidth(ring))) continue;
			const tall = !you && cardHasSpend(model.roles.find((r) => r.row.roleId === other)?.spend);
			const gap = Math.abs(q[1] - p[1]) - CARD_HALF - (you ? 42 : CARD_HALF + (tall ? half : 0));
			if (q[1] < p[1]) up = Math.min(up, gap);
			else down = Math.min(down, gap);
		}
		if (up < half || down < half) shifts.set(id, down >= up ? half : -half);
	}
	return shifts;
}
