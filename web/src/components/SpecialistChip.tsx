/**
 * department-specialists (Ops #1101; Architecture #591 §4.3, R-SPEC-UI-1): the one small chip naming the specialist
 * that does a task, on its Queue row and in its task chat's header. Words from specialistChip (title, else slug);
 * renders nothing when there is none. No colour, avatar or link of its own (§4.4). Screen readers hear
 * "<words> (specialist)" (the words stay the chip's first text node, as C-CHIP reads it); the tooltip carries the
 * full words when the chip cuts them short.
 */
import { specialistChip, type ChipViewer, type SpecialistTaskFields } from "../specialist-chip";

export function SpecialistChip({ task, viewer = "owner" }: { task: SpecialistTaskFields; viewer?: ChipViewer }) {
	const words = specialistChip(task, viewer);
	if (!words) return null;
	return (
		<span className="specialist-chip" data-specialist-chip="" title={`Done by the specialist ${words}`}>
			{words}
			<span className="visually-hidden"> (specialist)</span>
		</span>
	);
}
