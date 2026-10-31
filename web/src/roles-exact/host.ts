/** What the page that mounts the Roles view (components/RolesExactView.tsx) hands it: the actions its buttons and
 *  links call, and the clock its panel animation runs on. */
import type { NeedsYouItem, UsefulOpenTarget } from "../roles-useful-model";
import type { NativeDialogSummary } from "../roles-answer-actions";

export interface ExactViewClock {
	raf(fn: () => void): unknown;
	cancelRaf(handle: unknown): void;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}
export interface ExactViewActions {
	open(target: UsefulOpenTarget): void;
	about(roleId: string): void;
	answer?(item: NeedsYouItem, from: HTMLElement): void;
	dialogs?(): readonly NativeDialogSummary[];
	reload(): void;
}
