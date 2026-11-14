/**
 * The Memory page (design #316, from design #315's picked prototype): a memory explorer.
 *
 * Top to bottom: title and health line, Find, the recent list or search results (or the opened note
 * or folder), the owner's changes, then the tree of places memory keeps things (beside the work
 * area on wide screens). Every read and change goes through the one `MemoryExplorerApi` seam.
 */

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
	type ConfirmAsk,
	ChangesYouMade,
	ConfirmDialog,
	type MadeChange,
	mergeChanges,
	type UndoOffer,
	UndoToast,
} from "./ChangeParts.js";
import {
	errorCode,
	type MemoryExplorerApi,
	type MemoryItem,
	type SearchMode,
	type SearchScope,
} from "./explorer-api.js";
import { ExplorerTree } from "./ExplorerTree.js";
import { clock, folderLabel } from "./explorer-text.js";
import { FindPanel } from "./FindPanel.js";
import { FolderReader } from "./FolderReader.js";
import { HealthLine, memoryAnswers } from "./HealthLine.js";
import { type ChangeHost, NoteReader } from "./NoteReader.js";
import { type AskedSearch, RecentList, SearchResults } from "./StartView.js";
import { useLoad } from "./use-load.js";
import type { OwnerState } from "./use-owner-access.js";

const RECENT_LIMIT = 12;
const SEARCH_LIMIT = 30;

/** What the work area shows; `focus` is the row to focus again when the owner comes back here. */
type Place = { kind: "start" } | { kind: "note"; uri: string } | { kind: "folder"; uri: string };
interface Step {
	readonly place: Place;
	readonly returnTo: string | null;
}

export interface MemoryExplorerViewProps {
	readonly api: MemoryExplorerApi;
	readonly ownerState?: OwnerState;
	readonly now?: () => number;
	/** The owner's passkey sign-in, shown in place of the notes while memory asks who is looking. */
	readonly signIn?: ReactNode;
	/** The owner's Sign out and Passkeys, at the end of the header. */
	readonly account?: ReactNode;
}

function OwnerOnly({ signIn }: { signIn: ReactNode }) {
	return (
		<div className="mx-empty" data-owner-only>
			<h2>Sign in to see memory</h2>
			<p className="mx-dim">Memory holds every department's notes, so only you can open it, with your passkey.</p>
			{signIn ?? <p className="mx-dim">Passkey sign-in isn't on this page yet.</p>}
		</div>
	);
}

function backLabel(previous: Place | undefined, searching: boolean): string | null {
	if (!previous) return null;
	if (previous.kind === "start") return searching ? "Back to results" : "Back to start";
	return `Back to ${folderLabel(previous.uri)}`;
}

export function MemoryExplorerView({
	api,
	ownerState = "unknown",
	now = Date.now,
	signIn,
	account,
}: MemoryExplorerViewProps) {
	const health = useLoad("health", (signal) => api.health(signal));
	const roots = useLoad("roots", (signal) => api.roots(signal));
	const signedIn = ownerState === "signed-in";
	const recorded = useLoad(signedIn ? "changes" : null, (signal) => api.changes(signal));
	const [scope, setScope] = useState<SearchScope>("all");
	const recent = useLoad(`recent:${scope}`, (signal) => api.recent(scope, RECENT_LIMIT, signal));
	const [query, setQuery] = useState("");
	const [mode, setMode] = useState<SearchMode>("meaning");
	const [asked, setAsked] = useState<AskedSearch | null>(null);
	const results = useLoad(asked ? `search:${asked.seq}` : null, (signal) =>
		api.search(
			{ mode: asked?.mode ?? mode, query: asked?.query ?? "", scope: asked?.scope ?? scope, limit: SEARCH_LIMIT },
			signal,
		),
	);
	const [steps, setSteps] = useState<Step[]>([{ place: { kind: "start" }, returnTo: null }]);
	const [focusAfterBack, setFocusAfterBack] = useState<string | null>(null);
	const [ask, setAsk] = useState<ConfirmAsk | null>(null);
	const [offer, setOffer] = useState<UndoOffer | null>(null);
	const [changes, setChanges] = useState<MadeChange[]>([]);
	const [undoFailed, setUndoFailed] = useState<string | null>(null);
	const workRef = useRef<HTMLDivElement>(null);
	const seqRef = useRef(0);
	const nowMs = now();
	const place = steps[steps.length - 1].place;
	const canChange = memoryAnswers(health.load);
	const memoryEmpty = health.load.data?.totalNotes === 0;

	const runSearch = (q: string, m: SearchMode, s: SearchScope) => {
		seqRef.current += 1;
		setQuery(q);
		setMode(m);
		setAsked({ seq: seqRef.current, query: q, mode: m, scope: s });
		setSteps([{ place: { kind: "start" }, returnTo: null }]);
	};
	const changeScope = (s: SearchScope) => {
		setScope(s);
		if (asked) runSearch(query, mode, s);
	};
	const clearSearch = () => {
		setQuery("");
		setAsked(null);
		setSteps([{ place: { kind: "start" }, returnTo: null }]);
	};
	const go = (next: Place, returnTo: string | null) => setSteps((s) => [...s, { place: next, returnTo }]);
	const openItem = (item: MemoryItem) =>
		go(item.isFolder ? { kind: "folder", uri: item.uri } : { kind: "note", uri: item.uri }, item.uri);
	const openFolder = (uri: string) => go({ kind: "folder", uri }, null);
	const back = () => {
		const top = steps[steps.length - 1];
		setSteps((s) => (s.length > 1 ? s.slice(0, -1) : s));
		setFocusAfterBack(top.returnTo);
	};

	// Back lands on the row that opened what was just closed.
	useEffect(() => {
		if (!focusAfterBack) return;
		const rows = workRef.current?.querySelectorAll<HTMLElement>("[data-note],[data-folder]") ?? [];
		[...rows].find((el) => (el.dataset.note ?? el.dataset.folder) === focusAfterBack)?.focus();
		setFocusAfterBack(null);
	}, [focusAfterBack]);

	const closeConfirm = useCallback(() => setAsk(null), []);
	const dropOffer = useCallback(() => setOffer(null), []);
	const host: ChangeHost = {
		confirm: setAsk,
		made(change, record, afterUndo) {
			setUndoFailed(null);
			setChanges((list) => [{ ...change, when: clock(record.at), undone: false }, ...list]);
			recent.reload();
			setOffer({
				id: record.id,
				message: `${change.what === "Deleted" ? "Deleted" : "Saved"} “${change.title}”.`,
				onUndo: () => {
					const undone = () => {
						setChanges((list) => list.map((c) => (c.id === change.id ? { ...c, undone: true } : c)));
						recent.reload();
						afterUndo();
					};
					api.undo(record.id).then(undone, (error: unknown) => {
						const deleting = change.what === "Deleted";
						if (errorCode(error) !== "NOT_CONFIRMED") {
							setUndoFailed("Couldn't undo: memory didn't answer. The change stays.");
						} else if (deleting) {
							// Asking to undo holds a delete; a hold the owner didn't confirm cancels it (R-OWNER-UNDO-1).
							undone();
							setUndoFailed("You didn't confirm Undo, but the delete was stopped: the note is kept.");
						} else {
							setUndoFailed("You didn't confirm Undo, so your change stays.");
						}
					});
				},
			});
		},
	};

	const reloadAll = () => {
		health.reload();
		roots.reload();
		recent.reload();
	};
	// Recheck when the owner returns to the page, retaining the same-key snapshots.
	useEffect(() => {
		const refresh = () => {
			health.reload();
			roots.reload();
			recent.reload();
			recorded.reload();
		};
		window.addEventListener("focus", refresh);
		return () => window.removeEventListener("focus", refresh);
	}, [health.reload, roots.reload, recent.reload, recorded.reload]);
	const previous = steps[steps.length - 2]?.place;
	const label = backLabel(previous, asked !== null);
	let work;
	const ownerOnly = roots.load.status === "failed" && roots.load.code === "OWNER_ONLY";
	if (ownerOnly) {
		work = <OwnerOnly signIn={signIn} />;
	} else if (place.kind === "note") {
		work = (
			<NoteReader
				key={place.uri}
				api={api}
				uri={place.uri}
				nowMs={nowMs}
				canChange={canChange}
				backLabel={label}
				host={host}
				onBack={back}
				onFolder={openFolder}
			/>
		);
	} else if (place.kind === "folder") {
		work = (
			<FolderReader
				key={place.uri}
				api={api}
				uri={place.uri}
				nowMs={nowMs}
				backLabel={label}
				onBack={back}
				onFolder={openFolder}
				onOpen={openItem}
			/>
		);
	} else if (asked) {
		work = (
			<SearchResults
				asked={asked}
				results={results.load}
				nowMs={nowMs}
				onOpen={openItem}
				onRetry={results.reload}
				onEverywhere={() => changeScope("all")}
				onOtherWay={() => runSearch(asked.query, asked.mode === "meaning" ? "words" : "meaning", asked.scope)}
			/>
		);
	} else {
		work = (
			<RecentList recent={recent.load} memoryEmpty={memoryEmpty} nowMs={nowMs} onOpen={openItem} onRetry={reloadAll} />
		);
	}

	return (
		<>
			<main className="mx-page" data-explorer-page>
				<header className="mx-head">
					<div>
						<h1>Memory</h1>
						<p className="mx-dim">
							Everything your chats have saved: find it, read it, see where it lives, fix or delete it.
						</p>
					</div>
					<div className="mx-head-side">
						<HealthLine health={health.load} nowMs={nowMs} onRetry={reloadAll} />
						{account}
					</div>
				</header>
				<div className="mx-layout">
					<div className="mx-work" ref={workRef}>
						<FindPanel
							disabled={!canChange}
							query={query}
							mode={mode}
							scope={scope}
							roots={roots.load.data ?? []}
							onQuery={setQuery}
							onMode={setMode}
							onScope={changeScope}
							onSearch={(q, m) => runSearch(q, m, scope)}
							onClear={clearSearch}
						/>
						<section className="mx-view" aria-label="What you're looking at" aria-live="polite">
							{work}
						</section>
						{signedIn && recorded.load.status === "failed" && recorded.load.code === "OWNER_ONLY" ? (
							<p className="mx-dim">Sign in to see your changes</p>
						) : signedIn ? (
							<ChangesYouMade changes={mergeChanges(changes, recorded.load.data ?? [])} />
						) : null}
					</div>
					<ExplorerTree
						api={api}
						roots={roots.load}
						totalNotes={health.load.data?.totalNotes ?? null}
						onRetry={roots.reload}
						current={place.kind === "start" ? null : place.uri}
						onOpen={openFolder}
					/>
				</div>
			</main>
			{ask ? <ConfirmDialog ask={ask} onClose={closeConfirm} /> : null}
			{offer ? <UndoToast offer={offer} onGone={dropOffer} /> : null}
			{undoFailed ? (
				<p className="mx-toast" role="alert">
					{undoFailed}
				</p>
			) : null}
		</>
	);
}
