/** The Instructions line of a department panel's Configuration tab: what its home chat loaded, against the files now. */
import { NR, exactWhen, type ExactInstructions } from "../roles-exact-model";

/**
 * roles-instructions (Ops #208): the panel's Instructions line, in the supplied design's label colours (its
 * INSTR map: active green, saved-not-confirmed amber, not reported violet).
 */
export function instructionsOf(
	instr: ExactInstructions,
	now: number,
): { instrLabel: string; instrFg: string; instr: { text: string } } {
	if (instr.state === "current")
		return {
			instrLabel: "Current",
			instrFg: "#9FD8B8",
			instr: { text: `Loaded ${exactWhen(instr.loadedAt, now)} · up to date` },
		};
	if (instr.state === "outdated")
		return {
			instrLabel: "Outdated",
			instrFg: "#F0B95A",
			instr: { text: `Loaded ${exactWhen(instr.loadedAt, now)} · ${instr.changed.join(", ")} changed since` },
		};
	return { instrLabel: NR, instrFg: "#C7B8FF", instr: { text: "what its home chat loaded is not recorded" } };
}
