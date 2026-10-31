/** Own-work budget lines and bars: a department card's budget line, and the colour and width rules the You panel's
 *  spending bar shares with it. */
import type { ExactSpend } from "../roles-exact-model";

/** A tally's bar colour, the You panel's rule: red over budget, amber stale or last received data, else blue. */
export function spendColor(spend: ExactSpend, lastReceived: boolean): string {
	return spend.over ? "#FF8A80" : spend.stale || lastReceived ? "#F0B95A" : "#7DB8FF";
}
export function spendWidth(ratio: number | null): string {
	return `${Math.round((ratio ?? 0) * 100_000) / 1000}%`;
}
/** roles-budget-card: true when a role's card shows its own-work budget line (a reported tally with figures). */
export function cardHasSpend(spend: ExactSpend | undefined): boolean {
	return !!spend?.reported && spend.amount !== null && spend.budget !== null && spend.ratio !== null;
}
/**
 * roles-budget-card (Ops #265): a reported role's own-work budget on its card, with the feed's exact figures and a
 * bar; "Budget used up" when over. A role with no budget, an old week or an unreadable tally gets no line, never
 * "$0". Its panel opens with the spending section first (`spendBelow` false); every other panel keeps it lower.
 */
export function exactCardSpend(
	spend: ExactSpend,
	label: string,
	lastReceived: boolean,
	manualReference = false,
): {
	hasSpend: boolean;
	spendText: string;
	spendBarWidth: string;
	spendBarColor: string;
	spendLabel: string;
	spendBelow: boolean;
} {
	if (!cardHasSpend(spend))
		return {
			hasSpend: false,
			spendText: "",
			spendBarWidth: "0%",
			spendBarColor: "transparent",
			spendLabel: "",
			spendBelow: true,
		};
	const figures = `${spend.amount} of ${spend.budget} this week`;
	return {
		hasSpend: true,
		spendText: spend.over ? "Budget used up" : figures,
		spendBarWidth: spendWidth(spend.ratio),
		spendBarColor: spendColor(spend, lastReceived),
		spendLabel: `${label} ${manualReference ? "manual own-work reference" : "own-work budget"}: ${spend.over ? `used up, ${figures}` : figures}`,
		spendBelow: false,
	};
}
