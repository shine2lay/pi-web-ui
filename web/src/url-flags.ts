/**
 * debug-controls (Ops #621): controls the owner doesn't use stay off the page unless its address asks for them.
 *
 * - `?debugPerm=1`: the agent preset ("Full") and permission ("Full access") selectors, in the composer and in
 *   Settings (owner, 2026-10-28, m77284 and m77313).
 * - `?recovery=1` or `?debugTools=1`: the Tools button (Tool Inspector) above the chat (owner, 2026-10-28, m77409).
 *   `?recovery=1` also shows the recovery panels (#611).
 *
 * Nothing changes without them: the chat keeps its preset and permission, and the server's own defaults apply.
 * The app never rewrites these switches (open-chat-link.ts and auth-token.ts remove only their own parameters), so
 * one stays on until the page is opened without it.
 */

/** The page's query string; "" outside a browser. */
const pageSearch = (): string => (typeof window === "undefined" ? "" : window.location.search);

/** Whether the switch `name` is on (`?name=1`) in `search`. */
export function urlFlag(name: string, search: string = pageSearch()): boolean {
	try {
		return new URLSearchParams(search).get(name) === "1";
	} catch {
		return false;
	}
}

/** The agent preset ("Full") and permission ("Full access") selectors: only with `?debugPerm=1`. */
export const showPermissionControls = (search: string = pageSearch()): boolean => urlFlag("debugPerm", search);

/** The Tools button (Tool Inspector): only with `?recovery=1` or `?debugTools=1`. */
export const showToolInspector = (search: string = pageSearch()): boolean =>
	urlFlag("recovery", search) || urlFlag("debugTools", search);
