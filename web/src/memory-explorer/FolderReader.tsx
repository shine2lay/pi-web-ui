/**
 * A folder opened in the reader: where it is, its one-line summary and overview, and what's inside
 * (folders first, then notes, newest first), with "Show more" when there are more.
 */

import { useState } from "react";
import type { MemoryExplorerApi, MemoryItem } from "./explorer-api.js";
import { ago, countWords, folderLabel, keptIn, summaryText } from "./explorer-text.js";
import { KindBar } from "./KindBar.js";
import { NoteRow } from "./NoteRow.js";
import { Crumbs, Facts, Level, OverviewFold, PathLine, useFocusOnOpen } from "./ReaderParts.js";
import { useLoad } from "./use-load.js";

export interface FolderReaderProps {
	readonly api: MemoryExplorerApi;
	readonly uri: string;
	readonly nowMs: number;
	readonly backLabel: string | null;
	onBack(): void;
	onFolder(uri: string): void;
	onOpen(item: MemoryItem): void;
}

export function FolderReader(props: FolderReaderProps) {
	const { api, uri, nowMs } = props;
	const listing = useLoad(uri, (signal) => api.folder(uri, null, signal));
	const [more, setMore] = useState<{ items: MemoryItem[]; cursor: string | null; failed: boolean } | null>(null);
	const titleRef = useFocusOnOpen<HTMLHeadingElement>(listing.load.status === "ready", uri);
	const title = folderLabel(uri);
	const crumbs = (
		<Crumbs uri={uri} isFolder backLabel={props.backLabel} onBack={props.onBack} onFolder={props.onFolder} />
	);

	if (listing.load.status !== "ready") {
		return (
			<div className="mx-reader">
				{crumbs}
				{listing.load.status === "failed" ? (
					<div className="mx-empty">
						<h2>Couldn't open this folder</h2>
						<button type="button" className="mx-btn" onClick={listing.reload}>
							Try again
						</button>
					</div>
				) : (
					<div aria-busy="true">
						<h2 className="mx-dim">Opening {title}…</h2>
						<span className="mx-skeleton" style={{ width: "70%" }} />
						<span className="mx-skeleton" style={{ width: "50%" }} />
					</div>
				)}
			</div>
		);
	}

	const data = listing.load.data;
	const items = [...data.items, ...(more?.items ?? [])];
	const cursor = more ? more.cursor : data.nextCursor;
	const showMore = async () => {
		try {
			const next = await api.folder(uri, cursor, undefined);
			setMore({ items: [...(more?.items ?? []), ...next.items], cursor: next.nextCursor, failed: false });
		} catch {
			setMore({ items: more?.items ?? [], cursor, failed: true });
		}
	};
	const summary = summaryText(data.folder.summary);
	const notes = data.folder.noteCount ?? 0;

	return (
		<article className="mx-reader" aria-labelledby="mx-folder-title">
			{crumbs}
			<div className="mx-reader-head">
				<h2 id="mx-folder-title" ref={titleRef} tabIndex={-1}>
					{title}
				</h2>
			</div>
			<PathLine uri={uri} />
			<Facts
				rows={[
					["Kept in", keptIn(uri)],
					["Holds", countWords(notes, "note", "notes")],
					["Changed", ago(data.folder.changedAt, nowMs)],
					["Kinds", <KindBar key="kinds" counts={data.folder.kindCounts ?? {}} />],
				]}
			/>
			<section className="mx-levels" aria-label="How memory keeps it">
				<h3>How memory keeps it</h3>
				<Level n={1} title="One-line summary" why="What search and chats see first.">
					{summary ? (
						<p className="mx-text" data-level="1">
							{summary}
						</p>
					) : (
						<p className="mx-missing" data-level="1">
							No summary written yet.
						</p>
					)}
				</Level>
				<Level n={2} title="Overview" why="The page about this folder that chats read before opening notes.">
					<OverviewFold text={data.overview} />
				</Level>
			</section>
			<section className="mx-inside" aria-labelledby="mx-inside-title">
				<h3 id="mx-inside-title">Inside · {countWords(data.total, "item", "items")}</h3>
				{items.length === 0 ? (
					<p className="mx-missing">This folder is empty.</p>
				) : (
					<ul className="mx-rows">
						{items.map((item) => (
							<NoteRow key={item.uri} item={item} nowMs={nowMs} onOpen={props.onOpen} />
						))}
					</ul>
				)}
				{more?.failed ? (
					<p className="mx-error" role="alert">
						Couldn't load more.
					</p>
				) : null}
				{cursor ? (
					<button type="button" className="mx-btn mx-more" onClick={() => void showMore()}>
						Show more ({items.length} of {data.total})
					</button>
				) : null}
			</section>
		</article>
	);
}
