/**
 * The plugin view tabs (`plugin:<id>`), split out of `App.tsx`.
 *
 * A plugin's client bundle still loads at start (plugin-loader's syncPluginViews), but its view
 * mounts only when its tab is first opened and then stays mounted and hidden, like PagePanes'
 * pages: switching tabs keeps the plugin's state, and a plugin nobody opened draws nothing. That
 * matters for views that embed a page: the Temper plugin's iframe used to load on every page and,
 * where the site refuses framing, put a console error on every page (frontend #297).
 *
 * Code that must run at start without the tab being opened belongs in the bundle's top level
 * (manifest `preload: true`), not in mount().
 */
import type { ReactNode } from "react";
import type { LoadedPluginView } from "../plugin-loader";
import type { UiPluginInfo } from "../types";
import { useVisitedViews } from "../visited-views";
import { PluginView } from "./PluginView";
import { PluginViewFallback } from "./PluginViewFallback";

export interface PluginPanesProps {
	/** The view shown right now (any of the app's views, not only plugin views). */
	readonly view: string;
	/** Plugin views whose client bundle has loaded. */
	readonly pluginViews: readonly LoadedPluginView[];
	/** Every plugin the server lists (the fallback names the one being opened). */
	readonly plugins: readonly UiPluginInfo[];
	readonly epoch: number;
	/** Ids of the plugins whose view failed to load. */
	readonly failedIds: readonly string[];
}

const PLUGIN_VIEW_PREFIX = "plugin:";

export function PluginPanes({ view, pluginViews, plugins, epoch, failedIds }: PluginPanesProps): ReactNode {
	const visited = useVisitedViews(view);
	const openId = view.startsWith(PLUGIN_VIEW_PREFIX) ? view.slice(PLUGIN_VIEW_PREFIX.length) : null;
	return (
		<>
			{pluginViews.map((entry) => {
				const name = `${PLUGIN_VIEW_PREFIX}${entry.info.id}`;
				if (!visited.has(name)) return null;
				return (
					<div key={entry.info.id} className={`view-pane ${view === name ? "" : "hidden"}`}>
						<PluginView entry={entry} />
					</div>
				);
			})}
			{/* issue #225: the open view is a plugin that has not loaded: say so (loading, or failed + retry). */}
			{openId !== null && !pluginViews.some((v) => v.info.id === openId) && (
				<PluginViewFallback
					pluginId={openId}
					info={plugins.find((p) => p.id === openId)}
					epoch={epoch}
					failed={failedIds.includes(openId)}
				/>
			)}
		</>
	);
}
