/**
 * What the work area shows before a note or folder is opened: the notes changed most recently, or the
 * results of a search, with their loading, empty, no-results and failed states.
 */

import type { MemoryItem, SearchHit, SearchMode } from "./explorer-api.js";
import { countWords, isSetupFile } from "./explorer-text.js";
import { NoteRow } from "./NoteRow.js";
import type { Load } from "./use-load.js";

export interface AskedSearch {
	readonly seq: number;
	readonly query: string;
	readonly mode: SearchMode;
	readonly scope: string;
}

function Placeholder({ heading }: { heading: string }) {
	return (
		<div aria-busy="true">
			<h2 className="mx-dim">{heading}</h2>
			{Array.from({ length: 5 }, (_, i) => (
				<span key={i} className="mx-skeleton" style={{ width: `${92 - i * 9}%` }} />
			))}
		</div>
	);
}

function Failed({ what, onRetry }: { what: string; onRetry(): void }) {
	return (
		<div className="mx-empty">
			<h2>{what}</h2>
			<p className="mx-dim">Memory didn't answer. Nothing was changed.</p>
			<button type="button" className="mx-btn" onClick={onRetry}>
				Try again
			</button>
		</div>
	);
}

export function RecentList({
	recent,
	memoryEmpty,
	nowMs,
	onOpen,
	onRetry,
}: {
	recent: Load<readonly MemoryItem[]>;
	memoryEmpty: boolean;
	nowMs: number;
	onOpen(item: MemoryItem): void;
	onRetry(): void;
}) {
	if (memoryEmpty) {
		return (
			<div className="mx-empty">
				<h2>Memory has no notes yet</h2>
				<p className="mx-dim">Notes show up here once your chats save something worth keeping.</p>
			</div>
		);
	}
	if (recent.status === "failed" && !recent.data) return <Failed what="Couldn't load memory" onRetry={onRetry} />;
	if (!recent.data) return <Placeholder heading="Loading memory…" />;
	// Setup files are managed with each department's settings, not browsed as notes.
	const notes = recent.data.filter((item) => !isSetupFile(item.uri));
	return (
		<>
			<div className="mx-vhead">
				<h2>Changed most recently</h2>
				<span className="mx-dim">Newest first</span>
			</div>
			{notes.length === 0 ? (
				<p className="mx-missing">Nothing here has changed yet.</p>
			) : (
				<ul className="mx-rows">
					{notes.map((item) => (
						<NoteRow key={item.uri} item={item} nowMs={nowMs} onOpen={onOpen} />
					))}
				</ul>
			)}
		</>
	);
}

function resultHeading(hits: readonly SearchHit[], mode: SearchMode): string {
	if (mode === "words") {
		const notes = new Set(hits.map((h) => h.item.uri)).size;
		return `${countWords(hits.length, "matching line", "matching lines")} in ${countWords(notes, "note", "notes")}`;
	}
	return hits.length === 1 ? "1 note matches" : `${hits.length} notes match`;
}

export function SearchResults({
	asked,
	results,
	nowMs,
	onOpen,
	onRetry,
	onEverywhere,
	onOtherWay,
}: {
	asked: AskedSearch;
	results: Load<readonly SearchHit[]>;
	nowMs: number;
	onOpen(item: MemoryItem): void;
	onRetry(): void;
	onEverywhere(): void;
	onOtherWay(): void;
}) {
	if (results.status === "failed") return <Failed what="Couldn't search memory" onRetry={onRetry} />;
	if (results.status === "loading") return <Placeholder heading={`Searching for “${asked.query}”…`} />;
	const hits = results.data;
	const otherWay = asked.mode === "meaning" ? "Exact words" : "By meaning";
	if (hits.length === 0) {
		return (
			<div className="mx-empty">
				<h2>Nothing found for “{asked.query}”</h2>
				<p className="mx-dim">
					{asked.mode === "meaning"
						? "No note is about this. Try other words, or look for the exact words."
						: "No note has these exact words. Try searching by meaning."}
				</p>
				<div className="mx-actions">
					<button type="button" className="mx-btn" onClick={onOtherWay}>
						Try {otherWay}
					</button>
					{asked.scope === "all" ? null : (
						<button type="button" className="mx-btn" onClick={onEverywhere}>
							Search everything
						</button>
					)}
				</div>
			</div>
		);
	}
	const best = Math.max(...hits.map((h) => h.score ?? 0));
	return (
		<>
			<div className="mx-vhead">
				<h2>{resultHeading(hits, asked.mode)}</h2>
				<span className="mx-dim">{asked.mode === "meaning" ? "Closest first" : "In the order memory found them"}</span>
			</div>
			<ul className="mx-rows">
				{hits.map((hit, i) => (
					<NoteRow
						key={`${hit.item.uri}#${hit.lineNumber ?? i}`}
						item={hit.item}
						nowMs={nowMs}
						onOpen={onOpen}
						extra={
							asked.mode === "meaning" ? { score: hit.score, best } : { line: hit.line, lineNumber: hit.lineNumber }
						}
					/>
				))}
			</ul>
		</>
	);
}
