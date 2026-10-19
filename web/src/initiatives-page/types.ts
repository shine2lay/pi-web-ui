// initiatives-page (docs/initiatives-page-exact.md): what the core model (model.ts) and the three section
// modules share. Each section module (plan.ts, tasks.ts, gaps.ts) is one function from the work registry
// page, the selection and an open callback to its part of the view's input. The core lays each part over
// its own, so steps 2-4 each change only their own module.
import type {
	InitiativesExactInitiative,
	InitiativesExactInput,
	InitiativesExactLooseItem,
	InitiativesExactRole,
} from "../initiatives-exact-model";
import type { UiWorkPage } from "../types";

/** Opens a chat by its session file (the Roles page's open path). */
export type InitiativesPageOpen = (file: string) => void;

/** The "Projects in no initiative" box's id when it is open. Registry ids are slugs, so it is never one. */
export const NO_INITIATIVE = "~no-initiative";

/** A section module's part of the view's input. */
export interface InitiativesPagePart {
	/** Card and detail fields by initiative id (NO_INITIATIVE: the box's detail). */
	initiatives?: Readonly<Record<string, Partial<InitiativesExactInitiative>>>;
	/** Fields of a project's row in "Who's doing what", by project id. */
	projects?: Readonly<Record<string, Partial<InitiativesExactRole>>>;
	/** initiatives-page-tasks: rows after an initiative's project rows in "Who's doing what", by initiative id. */
	rows?: Readonly<Record<string, readonly InitiativesExactRole[]>>;
	/** initiatives-page-tasks: fields of an item in the "in no initiative" box, by project id. */
	loose?: Readonly<Record<string, Partial<InitiativesExactLooseItem>>>;
	/** Page-wide fields. */
	page?: Partial<Pick<InitiativesExactInput, "summary" | "summaryNote" | "filtersNote">>;
}

/** One section module: the page, the open initiative's id (or NO_INITIATIVE), and how to open a chat. */
export type InitiativesPageSection = (
	page: UiWorkPage,
	selected: string | undefined,
	open: InitiativesPageOpen,
) => InitiativesPagePart;

/** What a section says until its step connects it. */
export const NOT_CONNECTED = "Not connected yet";

/** The ids a section part covers: every initiative, and the box when it has projects. */
export function partIds(page: UiWorkPage): string[] {
	const ids = new Set(page.initiatives.map((i) => i.id));
	const loose = page.projects.some((p) => !p.initiative || !ids.has(p.initiative));
	return [...ids, ...(loose ? [NO_INITIATIVE] : [])];
}

/** A project's own detail (initiatives-page-plan): its id among the view's `details`. Registry ids are slugs, so
 *  it is never an initiative's id or NO_INITIATIVE. A section module fills it by this id, like an initiative. */
export function projectFrameId(projectId: string): string {
	return "~project:" + projectId;
}
