/**
 * department-specialists (Ops #1097 seam, Ops #1101 build; Architecture #591 §4.3-§4.4, R-SPEC-UI-1): the one small
 * chip naming a task's specialist, on its queue row and its task chat's header.
 *
 * The chip shows the specialist's title from the launch snapshot (`launch.specialist.title`), or its slug before the
 * task started; only to the owner and the task's own department, never to another department. Nothing else of a
 * specialist reaches the page: no roster/sidebar/roles rows, picker, page, avatar or colour (§4.4).
 *
 * The fields come from the server's queue replay (server/task-queue-specialist.ts) and, for the header, the chat's
 * sticky binding (server/specialist-entry.ts); the page renders the chip with SpecialistChip (`data-specialist-chip`).
 * Shared cases: C-CHIP-*.
 */
export type { SpecialistChatIdentity, SpecialistTaskFields } from "../../server/task-queue-specialist";
import type { SpecialistTaskFields } from "../../server/task-queue-specialist";

/** Who is looking at the row or header. The web app is the owner's; a role's own views pass `own_dept`. */
export type ChipViewer = "owner" | "own_dept" | "other_dept";

/** The chip's words, or null for no chip. */
export function specialistChip(task: SpecialistTaskFields, viewer: ChipViewer): string | null {
	if (viewer === "other_dept" || !task.specialist) return null;
	return task.launch?.specialist?.title || task.specialist;
}
