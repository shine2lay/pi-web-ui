/**
 * roles-by-project page (spec-page.md, design.md): replaces RolesExactView in PagePanes with the same props.
 * Seam stub (frontend #293); Frontend #294 builds it (parts under web/src/roles-by-project/, each under 500 lines)
 * and makes tests/unit/roles-by-project-page.test.ts and tests/roles-by-project-test.mjs pass.
 */
import type { NativeDialogSummary } from "../roles-answer-actions";
import type { UsefulOpenTarget } from "../roles-useful-model";
import { TASKS_ROLES_V8_TOKENS_CSS } from "../tasks-roles-v8/styles-tokens";

export const ROLES_BY_PROJECT_PAGE_NOT_BUILT = "roles-by-project: not built (Frontend #294 task)";

/** The page's only colour and font source: the v8 carbon tokens (spec-build.md §Modules: no new colours or fonts). */
export const ROLES_BY_PROJECT_TOKENS_CSS = TASKS_ROLES_V8_TOKENS_CSS;

export interface RolesByProjectViewProps {
	active: boolean;
	dialogs?: readonly NativeDialogSummary[];
	onOpen: (target: UsefulOpenTarget) => void;
	onAbout: (roleId: string) => void;
}

export function RolesByProjectView(_props: RolesByProjectViewProps): never {
	throw new Error(ROLES_BY_PROJECT_PAGE_NOT_BUILT);
}
