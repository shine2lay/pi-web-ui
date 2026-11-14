/**
 * The Memory tab (design #316): the memory explorer on the explorer routes.
 *
 * Builds the one HTTP seam and hands it to the view. While the tab is shown the address carries
 * `view=openviking`, so a reload or a shared link opens the Memory tab again; leaving the tab takes it
 * off. The owner's passkey sign-in and write confirm plug in through `signIn` and `ownerAssertion`.
 */

import { useEffect, useMemo, type ReactNode } from "react";
import type { OwnerWriteOp } from "../../../server/openviking/owner-session-types.js";
import { createHttpExplorerApi } from "../memory-explorer/explorer-http.js";
import { MemoryExplorerView } from "../memory-explorer/MemoryExplorerView.js";
import "../memory-explorer/memory-explorer.css";

const VIEW_PARAM = "view";
const VIEW_VALUE = "openviking";

export interface MemoryExplorerPageProps {
	/** The tab is shown. */
	readonly active: boolean;
	/** The owner's passkey sign-in, shown while memory asks who is looking. */
	readonly signIn?: ReactNode;
	/** The owner's passkey confirm for one write; without it the page can't change anything. */
	readonly ownerAssertion?: (op: OwnerWriteOp) => Promise<string>;
}

function setViewParam(on: boolean): void {
	const url = new URL(window.location.href);
	if (on) url.searchParams.set(VIEW_PARAM, VIEW_VALUE);
	else if (url.searchParams.get(VIEW_PARAM) === VIEW_VALUE) url.searchParams.delete(VIEW_PARAM);
	if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
}

export function MemoryExplorerPage({ active, signIn, ownerAssertion }: MemoryExplorerPageProps) {
	const api = useMemo(() => createHttpExplorerApi({ ownerAssertion }), [ownerAssertion]);
	useEffect(() => {
		if (!active) return;
		setViewParam(true);
		return () => setViewParam(false);
	}, [active]);
	return <MemoryExplorerView api={api} signIn={signIn} />;
}

export default MemoryExplorerPage;
