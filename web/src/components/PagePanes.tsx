/**
 * The three page views that live beside the chat: Roles, Initiatives and Memory
 * (openviking-dashboard).
 *
 * Split out of `App.tsx` so adding a page does not grow that file (Rule 23's 500-line cap and
 * `wt check`'s legacy ratchet). Each page is loaded lazily with its first opening and then stays
 * mounted and hidden, exactly as before, so switching tabs never refetches or resets it.
 */
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import type { UsefulOpenTarget } from "../roles-useful-model";

// roles-overview: the Roles page loads with its first opening and stays mounted after it.
const RolesExactView = lazy(() => import("./RolesExactView").then((m) => ({ default: m.RolesExactView })));
// initiatives-page-exact (#225): the supplied design; the old InitiativesView stays in source, unmounted.
const InitiativesPage = lazy(() => import("./InitiativesPage").then((m) => ({ default: m.InitiativesPage })));
// openviking-dashboard: the Memory tab, a memory explorer (design #316).
const MemoryExplorerPage = lazy(() =>
	import("./MemoryExplorerPage").then((m) => ({ default: m.MemoryExplorerPage })),
);

export interface PagePanesProps {
	/** The view shown right now (any of the app's views, not only these three). */
	readonly view: string;
	/** Roles only: the native dialogs to show, or `[]` while the chat is not ready. */
	readonly dialogs: RolesDialogs;
	readonly onOpen: (target: UsefulOpenTarget) => void;
	readonly onAbout: (role: string) => void;
}

type RolesProps = Parameters<typeof RolesExactView>[0];
type RolesDialogs = RolesProps["dialogs"];

/** True once `view` has been this page at least once (the page then stays mounted). */
function useSeen(view: string, name: string): boolean {
	const [seen, setSeen] = useState(false);
	useEffect(() => {
		if (view === name) setSeen(true);
	}, [view, name]);
	return seen || view === name;
}

export function PagePanes({ view, dialogs, onOpen, onAbout }: PagePanesProps): ReactNode {
	const rolesSeen = useSeen(view, "roles");
	const initiativesSeen = useSeen(view, "initiatives");
	const openVikingSeen = useSeen(view, "openviking");
	return (
		<>
			{/* roles-overview: the Roles page: what every role is doing and what waits on the owner. */}
			<div className={`view-pane roles-pane ${view === "roles" ? "" : "hidden"}`}>
				{rolesSeen && (
					<Suspense fallback={null}>
						<RolesExactView active={view === "roles"} dialogs={dialogs} onOpen={onOpen} onAbout={onAbout} />
					</Suspense>
				)}
			</div>
			{/* initiatives-page: the supplied design with the work registry, decisions and the leads' updates. */}
			<div className={`view-pane initiatives-pane ${view === "initiatives" ? "" : "hidden"}`}>
				{initiativesSeen && (
					<Suspense fallback={null}>
						<InitiativesPage active={view === "initiatives"} onOpen={onOpen} />
					</Suspense>
				)}
			</div>
			{/* openviking-dashboard: find, read, fix or delete what memory holds, and see where it lives. */}
			<div className={`view-pane openviking-pane ${view === "openviking" ? "" : "hidden"}`}>
				{openVikingSeen && (
					<Suspense fallback={null}>
						<MemoryExplorerPage active={view === "openviking"} />
					</Suspense>
				)}
			</div>
		</>
	);
}
