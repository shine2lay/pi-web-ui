/**
 * The Memory tab (design #316): the memory explorer on the explorer routes. It opens with no sign-in;
 * each change asks for the owner's passkey (spec-explorer-owner.md, Ops #1080).
 *
 * Builds the owner's passkey client and the one HTTP seam and hands them to the view. While the tab
 * is shown the address carries `view=openviking`, so a reload or a shared link opens the Memory tab
 * again; leaving the tab takes it off.
 */

import { useEffect, useMemo } from "react";
import { createHttpExplorerApi } from "../memory-explorer/explorer-http.js";
import { MemoryExplorerView } from "../memory-explorer/MemoryExplorerView.js";
import { AddForWriteBox, PasskeysBox } from "../memory-explorer/OwnerDialogs.js";
import { createOwnerSession, type OwnerWebAuthn } from "../memory-explorer/owner-session.js";
import { useOwnerAccess } from "../memory-explorer/use-owner-access.js";
import "../memory-explorer/memory-explorer.css";

const VIEW_PARAM = "view";
const VIEW_VALUE = "openviking";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface MemoryExplorerPageProps {
	/** The tab is shown. */
	readonly active: boolean;
	/** The browser's `fetch` unless given. */
	readonly fetch?: Fetch;
	/** The browser's passkey prompt unless given. */
	readonly webauthn?: OwnerWebAuthn;
}

function setViewParam(on: boolean): void {
	const url = new URL(window.location.href);
	if (on) url.searchParams.set(VIEW_PARAM, VIEW_VALUE);
	else if (url.searchParams.get(VIEW_PARAM) === VIEW_VALUE) url.searchParams.delete(VIEW_PARAM);
	if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
}

export function MemoryExplorerPage({ active, fetch, webauthn }: MemoryExplorerPageProps) {
	const session = useMemo(() => createOwnerSession({ fetch, webauthn }), [fetch, webauthn]);
	const access = useOwnerAccess(session);
	const { ownerAssertion } = access;
	const api = useMemo(() => createHttpExplorerApi({ fetch, ownerAssertion }), [fetch, ownerAssertion]);
	useEffect(() => {
		if (!active) return;
		setViewParam(true);
		return () => setViewParam(false);
	}, [active]);

	const account = (
		<div className="mx-account">
			<button type="button" className="mx-btn" onClick={(e) => access.openPasskeys(e.currentTarget)}>
				Passkeys
			</button>
		</div>
	);
	const box = access.box;

	return (
		<>
			<MemoryExplorerView api={api} account={account} />
			{box?.kind === "add-for-write" ? <AddForWriteBox access={access} /> : null}
			{box?.kind === "passkeys" ? <PasskeysBox access={access} opener={box.opener} /> : null}
		</>
	);
}

export default MemoryExplorerPage;
