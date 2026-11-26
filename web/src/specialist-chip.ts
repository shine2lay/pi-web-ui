/**
 * department-specialists (Ops #1097, Rule 18 Task 1 seam; Architecture #591 §4.3-§4.4, R-SPEC-UI-1): the one small
 * chip naming a task's specialist, on its queue row and its task chat's header.
 *
 * The chip shows the specialist's title from the launch snapshot (`launch.specialist.title`), or its slug before the
 * task started; only to the owner and the task's own department, never to another department. Nothing else of a
 * specialist reaches the page: no roster/sidebar/roles rows, picker, page, avatar or colour (§4.4).
 *
 * Task 1 leaves `specialistChip` unbuilt (it throws E_NOT_BUILT); Ops #1097 Task 2 builds it, adds the fields to the
 * wire types and renders the chip (marked `data-specialist-chip`). Shared cases: C-CHIP-*.
 */

/** The task fields the chip reads (pi-queue's task `specialist` and its launch snapshot's title). */
export interface SpecialistTaskFields {
	specialist?: string;
	launch?: { specialist?: { title?: string } };
}

/** What a task chat's identity (the header's IdentityTag) gains in a specialist's task chat. */
export interface SpecialistChatIdentity {
	specialist?: { slug: string; title?: string };
}

/** Who is looking at the row or header. */
export type ChipViewer = "owner" | "own_dept" | "other_dept";

/** The chip's words, or null for no chip. */
export function specialistChip(_task: SpecialistTaskFields, _viewer: ChipViewer): string | null {
	throw new Error("E_NOT_BUILT: specialistChip (department specialists, Ops #1097 Task 2)");
}
