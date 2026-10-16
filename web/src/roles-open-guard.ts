/**
 * roles-needs-you: the chats the Roles page asked to open, kept in this page's memory only.
 *
 * Security's addendum for Ops #200 (ADDENDUM-OPS200.md §6): a chat's file path stays in JS memory, and
 * a failed switch shows generic text. The shared switch overlay names a chat it can't find in its
 * lists by the file's name, and a failure shows the server's reason, which can quote the path. For a
 * chat opened from the Roles page, App (overlay) and use-chat (toast) ask here and show fixed words.
 * Never stored, logged or put in the address bar; only the last few are kept.
 */
import { sameSessionPath } from "./switch-pending";
import type { SwitchTarget } from "./types";

/** What a failed open from the Roles page says, instead of the server's reason. */
export const ROLES_OPEN_FAILED = "The chat couldn't be opened. Try again, or open it from the chat list.";

const KEEP = 32;
const asked: string[] = [];

export function markRolesOpen(file: string): void {
	const at = asked.findIndex((path) => sameSessionPath(path, file));
	if (at >= 0) asked.splice(at, 1);
	asked.push(file);
	if (asked.length > KEEP) asked.splice(0, asked.length - KEEP);
}

/** Was this switch asked for by the Roles page (one of the last 32 chats it opened)? */
export function isRolesOpen(target: SwitchTarget | null | undefined): boolean {
	if (target?.kind !== "session") return false;
	return asked.some((path) => sameSessionPath(path, target.path));
}

/** Tests only. */
export function resetRolesOpen(): void {
	asked.length = 0;
}
