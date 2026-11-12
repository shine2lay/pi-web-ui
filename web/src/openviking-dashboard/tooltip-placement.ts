/**
 * Where an open `(?)` tooltip sits so it never runs off the screen (frontend #280, QA #136 F1).
 *
 * The tip is anchored under its trigger at `left: 0`; this moves it sideways by the least amount that
 * keeps it `margin` px inside both viewport edges, and flips it above the trigger when it would run
 * past the bottom and there is room above. Pure: the caller measures, this decides.
 */

export interface TooltipBox {
	readonly left: number;
	readonly width: number;
	readonly top: number;
	readonly height: number;
}

export interface TooltipPlacement {
	/** Sideways shift in px from the default anchor (negative = left). */
	readonly shiftX: number;
	/** Above the trigger instead of below it. */
	readonly above: boolean;
}

export const TOOLTIP_EDGE_MARGIN_PX = 8;
/** The gap between trigger and tip, as `.ovk-tooltip` sets it with `calc(100% + 6px)`. */
export const TOOLTIP_GAP_PX = 6;

export function placeTooltip(
	tip: TooltipBox,
	trigger: { readonly top: number },
	viewport: { readonly width: number; readonly height: number },
	margin: number = TOOLTIP_EDGE_MARGIN_PX,
): TooltipPlacement {
	// The left edge wins when the tip is wider than the room: its start (the title) stays readable.
	const maxLeft = Math.max(margin, viewport.width - margin - tip.width);
	const left = Math.min(Math.max(tip.left, margin), maxLeft);
	const runsPastBottom = tip.top + tip.height > viewport.height - margin;
	const fitsAbove = trigger.top - TOOLTIP_GAP_PX - tip.height >= margin;
	return { shiftX: Math.round(left - tip.left), above: runsPastBottom && fitsAbove };
}
