/**
 * "Where memory keeps things": the places memory keeps notes in three groups (shared by every chat,
 * project documents, each department's own), each with its note count and a bar split by kind.
 * Folders open in place, one level at a time, as they are asked for.
 */

import { useState } from "react";
import type { MemoryExplorerApi, MemoryItem, MemoryRoot, RootGroup } from "./explorer-api.js";
import { GROUP_HEADINGS, folderLabel } from "./explorer-text.js";
import { KindBar, KindKey } from "./KindBar.js";
import type { Load } from "./use-load.js";
import { useLoad } from "./use-load.js";

const GROUPS: readonly RootGroup[] = ["shared", "projects", "department"];
const SHARED_OPEN_BY_DEFAULT = "viking://user/default/memories";

const Chevron = () => (
	<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
		<path d="M4.5 2.5L8 6l-3.5 3.5" />
	</svg>
);

interface TreeProps {
	readonly api: MemoryExplorerApi;
	readonly current: string | null;
	onOpen(uri: string): void;
}

function SubFolders({ api, uri, current, onOpen }: TreeProps & { uri: string }) {
	const { load } = useLoad(uri, (signal) => api.folder(uri, null, signal));
	if (load.status === "loading") return <p className="mx-tree-note">Opening…</p>;
	if (load.status === "failed") {
		return (
			<p className="mx-tree-note">
				{load.code === "OWNER_ONLY" ? "Sign in to open this folder." : "Couldn't open this folder."}
			</p>
		);
	}
	const folders = load.data.items.filter((item) => item.isFolder);
	if (folders.length === 0) return null;
	return (
		<ul>
			{folders.map((folder) => (
				<TreeRow key={folder.uri} api={api} item={folder} current={current} onOpen={onOpen} />
			))}
		</ul>
	);
}

function TreeRow({
	api,
	item,
	root,
	current,
	onOpen,
}: TreeProps & { item: Pick<MemoryItem, "uri" | "noteCount" | "kindCounts">; root?: boolean }) {
	const [open, setOpen] = useState(item.uri === SHARED_OPEN_BY_DEFAULT);
	const label = folderLabel(item.uri);
	// null: too many to count, or the place didn't answer; never shown as 0.
	const count = item.noteCount ?? null;
	return (
		<li>
			<div className="mx-tree-row" data-tree-row aria-current={current === item.uri ? "true" : undefined}>
				<button
					type="button"
					className="mx-tree-toggle"
					aria-expanded={open}
					aria-label={`${open ? "Close" : "Open"} ${label}`}
					onClick={() => setOpen(!open)}
					disabled={count === 0}
				>
					<Chevron />
				</button>
				<button type="button" className="mx-tree-open" data-folder={item.uri} onClick={() => onOpen(item.uri)}>
					<span className="mx-tree-name">{label}</span>
					{root ? <KindBar counts={item.kindCounts ?? {}} /> : null}
				</button>
				{count === null ? (
					<span className="mx-tree-count mx-dim">not counted</span>
				) : (
					<span className="mx-num mx-tree-count">
						{count.toLocaleString("en-US")}
						<span className="mx-sr">{count === 1 ? " note" : " notes"}</span>
					</span>
				)}
			</div>
			{open && count !== 0 ? <SubFolders api={api} uri={item.uri} current={current} onOpen={onOpen} /> : null}
		</li>
	);
}

export function ExplorerTree({
	roots,
	totalNotes,
	onRetry,
	...props
}: TreeProps & { roots: Load<readonly MemoryRoot[]>; totalNotes: number | null; onRetry(): void }) {
	return (
		<nav className="mx-tree" aria-label="Where memory keeps things">
			<h2>Where memory keeps things</h2>
			{totalNotes !== null && roots.data ? (
				<p className="mx-dim">
					{totalNotes.toLocaleString("en-US")} notes in {roots.data.length} places
				</p>
			) : null}
			<KindKey />
			{roots.data ? (
				GROUPS.map((group) => {
					const inGroup = (roots.data ?? []).filter((r) => r.group === group);
					if (inGroup.length === 0) return null;
					return (
						<section key={group} className="mx-tree-group" aria-labelledby={`mx-group-${group}`}>
							<h3 id={`mx-group-${group}`}>{GROUP_HEADINGS[group]}</h3>
							<ul>
								{inGroup.map((r) => (
									<TreeRow key={r.uri} {...props} item={r} root />
								))}
							</ul>
						</section>
					);
				})
			) : roots.status === "failed" && roots.code === "OWNER_ONLY" ? (
				<p className="mx-tree-note">The folders open once you sign in.</p>
			) : roots.status === "failed" ? (
				<p className="mx-tree-note">
					Couldn't load the folders.{" "}
					<button type="button" className="mx-btn" onClick={onRetry}>
						Try again
					</button>
				</p>
			) : (
				<div aria-busy="true">
					{Array.from({ length: 7 }, (_, i) => (
						<span key={i} className="mx-skeleton" style={{ width: `${88 - i * 7}%` }} />
					))}
				</div>
			)}
		</nav>
	);
}
