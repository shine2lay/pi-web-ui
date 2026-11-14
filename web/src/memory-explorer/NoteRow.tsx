/**
 * One note or folder in a list (recent changes, results, a folder's contents): title, how well it
 * matches or the matching line, where it lives and its kind, when it changed and how long it is, the
 * one-line summary as plain words, and the stored path as data.
 */

import type { ReactNode } from "react";
import type { MemoryItem, NoteKind } from "./explorer-api.js";
import {
	MATCH_WORDS,
	ago,
	countWords,
	folderLabel,
	groupOf,
	keptIn,
	kindOf,
	kindWord,
	lengthWords,
	matchLevel,
	noteTitle,
	parentOf,
	summaryText,
} from "./explorer-text.js";
import { KindBar } from "./KindBar.js";

const ICON_PATHS: Readonly<Record<NoteKind | "folder", ReactNode>> = {
	rule: (
		<>
			<rect x="3" y="3" width="14" height="14" rx="3" />
			<path d="M6.5 10l2.5 2.5 4.5-5" />
		</>
	),
	case: <path d="M4 6h12v10H4zM7.5 6V4h5v2" />,
	fact: (
		<>
			<circle cx="10" cy="10" r="7" />
			<path d="M10 9v5M10 6.2v.1" />
		</>
	),
	event: (
		<>
			<rect x="3" y="4.5" width="14" height="12" rx="2" />
			<path d="M3 8.5h14M7 3v3M13 3v3" />
		</>
	),
	doc: <path d="M5 2.5h7l3.5 3.5v11.5H5zM8 10h5M8 13h5" />,
	other: <path d="M5 2.5h7l3.5 3.5v11.5H5z" />,
	folder: <path d="M2.5 5.5a1 1 0 011-1h4l2 2h7a1 1 0 011 1v8a1 1 0 01-1 1h-13a1 1 0 01-1-1z" />,
};

export function KindIcon({ kind }: { kind: NoteKind | "folder" }) {
	return (
		<svg className="mx-icon" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
			{ICON_PATHS[kind]}
		</svg>
	);
}

export function MatchLabel({ score, best }: { score: number; best: number }) {
	const level = matchLevel(score, best);
	return (
		<span className="mx-match" data-match>
			<span className="mx-match-dots" aria-hidden="true">
				{[1, 2, 3].map((i) => (
					<i key={i} className={i <= level ? "on" : undefined} />
				))}
			</span>
			{MATCH_WORDS[level]}
		</span>
	);
}

/** The folder a note sits in, below the kind folder ("Nov 12"), when it says more than the kind. */
function whereShort(uri: string): string | null {
	const parent = parentOf(uri);
	if (!parent || parentOf(parent) === null) return null;
	if (groupOf(uri) !== "projects" && parentOf(parentOf(parent) as string) === null) return null;
	return folderLabel(parent);
}

export interface RowExtra {
	readonly score?: number;
	readonly best?: number;
	readonly line?: string;
	readonly lineNumber?: number;
}

export function NoteRow({
	item,
	extra = {},
	nowMs,
	onOpen,
}: {
	item: MemoryItem;
	extra?: RowExtra;
	nowMs: number;
	onOpen(item: MemoryItem): void;
}) {
	const kind = item.isFolder ? "folder" : kindOf(item.uri);
	const where = item.isFolder ? null : whereShort(item.uri);
	const summary = summaryText(item.summary);
	const facts = item.isFolder
		? countWords(item.noteCount ?? 0, "note", "notes")
		: `${ago(item.changedAt, nowMs)} · ${lengthWords(item.size)}`;
	const data = item.isFolder ? { "data-folder": item.uri } : { "data-note": item.uri };
	return (
		<li>
			<button type="button" className="mx-row" onClick={() => onOpen(item)} {...data}>
				<KindIcon kind={kind} />
				<span className="mx-row-title">{item.isFolder ? folderLabel(item.uri) : noteTitle(item.uri)}</span>
				<span className="mx-row-side">
					{extra.score != null && extra.best != null ? <MatchLabel score={extra.score} best={extra.best} /> : null}
				</span>
				<span className="mx-row-where">
					{item.isFolder ? (
						<KindBar counts={item.kindCounts ?? {}} small />
					) : (
						<i className={`mx-kind-dot k-${kind}`} aria-hidden="true" />
					)}
					<span>
						{keptIn(item.uri)} · {item.isFolder ? "Folder" : kindWord(item.uri)}
						{where ? ` · ${where}` : ""}
					</span>
					<span className="mx-num">{facts}</span>
				</span>
				{extra.line != null ? (
					<span className="mx-row-sum">
						{extra.lineNumber ? <span className="mx-dim">Line {extra.lineNumber}: </span> : null}
						{extra.line}
					</span>
				) : summary ? (
					<span className="mx-row-sum">{summary}</span>
				) : null}
				<span className="mx-path" data-path>
					{item.uri}
				</span>
			</button>
		</li>
	);
}
