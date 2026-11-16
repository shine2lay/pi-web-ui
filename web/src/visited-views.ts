import { useState } from "react";

/**
 * The views that have been the current view at least once (the current one included).
 *
 * Panes mount their page on its first opening and keep it mounted, hidden, after it: switching
 * tabs never refetches or resets a page, and a page nobody opened costs nothing (no fetch, no
 * timer, no embedded frame). Used by the built-in pages (PagePanes) and the plugin views
 * (PluginPanes).
 */
export function useVisitedViews(view: string): ReadonlySet<string> {
	const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set([view]));
	if (visited.has(view)) return visited;
	// Adjusting state while rendering (react.dev "storing information from previous renders"):
	// the pane mounts in this same render, not one effect later.
	const next = new Set(visited).add(view);
	setVisited(next);
	return next;
}
