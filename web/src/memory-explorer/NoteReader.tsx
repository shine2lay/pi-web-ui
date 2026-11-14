/**
 * A note opened in the reader: where it is, its facts, and the three levels memory keeps (one-line
 * summary, the folder's overview, the full text). Edit and Delete go through a confirm that names the
 * note, and each change can be undone for 10 seconds. Setup files are locked.
 */

import { useState } from "react";
import type { ChangeRecord, ExplorerErrorCode, MemoryExplorerApi, NoteDetail } from "./explorer-api.js";
import { errorCode } from "./explorer-api.js";
import type { ConfirmAsk, MadeChange } from "./ChangeParts.js";
import {
	ago,
	departmentName,
	folderLabel,
	keptIn,
	kindWord,
	lengthWords,
	noteTitle,
	parentOf,
	summaryText,
} from "./explorer-text.js";
import { Crumbs, Facts, Level, OverviewFold, PathLine, StoredText, useFocusOnOpen } from "./ReaderParts.js";
import { useLoad } from "./use-load.js";

/** What the page does for a change: ask to confirm, then keep it in the list with its Undo. */
export interface ChangeHost {
	confirm(ask: ConfirmAsk): void;
	made(change: Omit<MadeChange, "undone" | "when">, record: ChangeRecord, afterUndo: () => void): void;
}

export interface NoteReaderProps {
	readonly api: MemoryExplorerApi;
	readonly uri: string;
	readonly nowMs: number;
	readonly canChange: boolean;
	readonly backLabel: string | null;
	readonly host: ChangeHost;
	onBack(): void;
	onFolder(uri: string): void;
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;

function whereItLives(uri: string): string {
	const parent = parentOf(uri);
	const inside = parent && parentOf(parent) !== null ? ` › ${folderLabel(parent)}` : "";
	return `${keptIn(uri)}${inside}`;
}

function saveFailedText(code: ExplorerErrorCode): string {
	if (code === "CHANGED_SINCE_OPENED") {
		return "Couldn't save: this note changed since you opened it. Your text is still here; copy it, then open the note again.";
	}
	return "Couldn't save: memory didn't answer. Your text is still here.";
}

function changedByWords(role: string | null): string {
	if (!role) return "";
	return role === "owner" ? ", by you" : `, by ${departmentName(role)}`;
}

export function NoteReader(props: NoteReaderProps) {
	const { api, uri, nowMs, host } = props;
	const note = useLoad(uri, (signal) => api.read(uri, signal));
	const [draft, setDraft] = useState<string | null>(null);
	const [saveError, setSaveError] = useState<ExplorerErrorCode | null>(null);
	const [deleteFailed, setDeleteFailed] = useState(false);
	const [deleted, setDeleted] = useState(false);
	const [editedAt, setEditedAt] = useState<string | null>(null);
	const titleRef = useFocusOnOpen<HTMLHeadingElement>(note.load.status === "ready", uri);
	const title = noteTitle(uri);
	const crumbs = (
		<Crumbs uri={uri} isFolder={false} backLabel={props.backLabel} onBack={props.onBack} onFolder={props.onFolder} />
	);

	if (deleted) {
		return (
			<div className="mx-reader">
				{crumbs}
				<div className="mx-empty">
					<h2>This note was deleted</h2>
					<p className="mx-dim">Chats no longer get it.</p>
				</div>
			</div>
		);
	}
	if (note.load.status !== "ready") {
		return (
			<div className="mx-reader">
				{crumbs}
				{note.load.status === "failed" ? (
					<div className="mx-empty">
						<h2>{note.load.code === "NOT_FOUND" ? "This note isn't in memory any more" : "Couldn't open this note"}</h2>
						<button type="button" className="mx-btn" onClick={note.reload}>
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

	const detail: NoteDetail = note.load.data;
	const editing = draft !== null;

	const save = async (text: string) => {
		setSaveError(null);
		try {
			const record = await api.save(uri, text, detail.item.changedAt);
			setDraft(null);
			// null: the text was already this, so nothing was written and there is nothing to undo.
			if (record === null) return;
			note.set((d) => ({ ...d, fullText: text, item: { ...d.item, size: byteLength(text), changedAt: record.at } }));
			setEditedAt(record.at);
			host.made({ id: record.id, what: "Changed", title, where: keptIn(uri) }, record, () => {
				setEditedAt(null);
				note.reload();
			});
		} catch (error) {
			setSaveError(errorCode(error));
		}
	};
	const remove = async () => {
		setDeleteFailed(false);
		try {
			const record = await api.remove(uri);
			setDeleted(true);
			host.made({ id: record.id, what: "Deleted", title, where: keptIn(uri) }, record, () => {
				setDeleted(false);
				note.reload();
			});
		} catch {
			setDeleteFailed(true);
		}
	};
	const askSave = () => {
		const text = draft ?? "";
		host.confirm({
			title: `Save changes to “${title}”?`,
			body: `The full text changes from ${lengthWords(byteLength(detail.fullText ?? ""))} to ${lengthWords(byteLength(text))}. Chats get the new text from their next start. You can undo for 10 seconds.`,
			yes: "Save",
			danger: false,
			onYes: () => void save(text),
		});
	};
	const askDelete = () =>
		host.confirm({
			title: `Delete “${title}”?`,
			body: `It will be removed from ${whereItLives(uri)}. Chats will no longer get it. You can undo for 10 seconds.`,
			yes: "Delete note",
			danger: true,
			onYes: () => void remove(),
		});

	const parent = parentOf(uri) as string;
	const department = keptIn(uri).replace(/'s own notes$/, "");
	let full;
	if (detail.locked) {
		full = (
			<div className="mx-locked" data-level="3">
				<b>This is {departmentName(department)}'s setup file.</b>
				<p className="mx-dim">It is managed with the department's settings, so it isn't shown or changed here.</p>
			</div>
		);
	} else if (editing) {
		full = (
			<div className="mx-editor" data-level="3">
				<label className="mx-sr" htmlFor="mx-edit">
					Full text of {title}
				</label>
				<textarea id="mx-edit" value={draft ?? ""} onChange={(e) => setDraft(e.target.value)} />
				{saveError ? (
					<p className="mx-error" role="alert">
						{saveFailedText(saveError)}{" "}
						{saveError === "CHANGED_SINCE_OPENED" ? null : (
							<button type="button" className="mx-btn" onClick={() => void save(draft ?? "")}>
								Try again
							</button>
						)}
					</p>
				) : null}
				<div className="mx-editbar">
					<button type="button" className="mx-btn mx-btn-solid" onClick={askSave}>
						Save changes
					</button>
					<button
						type="button"
						className="mx-btn"
						onClick={() => {
							setDraft(null);
							setSaveError(null);
						}}
					>
						Cancel
					</button>
					<span className="mx-dim">Chats get the new text from their next start.</span>
				</div>
			</div>
		);
	} else if (detail.fullText) {
		full = <StoredText text={detail.fullText} level={3} />;
	} else {
		full = (
			<p className="mx-missing" data-level="3">
				This note is empty.
			</p>
		);
	}
	const summary = summaryText(detail.item.summary);

	return (
		<article className="mx-reader" aria-labelledby="mx-note-title">
			{crumbs}
			<div className="mx-reader-head">
				<h2 id="mx-note-title" ref={titleRef} tabIndex={-1}>
					{title}
				</h2>
				{detail.locked || editing ? null : (
					<div className="mx-actions">
						<button
							type="button"
							className="mx-btn"
							disabled={!props.canChange}
							onClick={() => setDraft(detail.fullText ?? "")}
						>
							Edit
						</button>
						<button type="button" className="mx-btn mx-btn-danger" disabled={!props.canChange} onClick={askDelete}>
							Delete
						</button>
					</div>
				)}
			</div>
			<PathLine uri={uri} />
			{!props.canChange && !detail.locked ? (
				<p className="mx-dim">Editing and deleting are off while memory is down.</p>
			) : null}
			{deleteFailed ? (
				<p className="mx-error" role="alert">
					Couldn't delete: memory didn't answer. The note is still there.{" "}
					<button type="button" className="mx-btn" onClick={() => void remove()}>
						Try again
					</button>
				</p>
			) : null}
			<Facts
				rows={[
					["Kept in", keptIn(uri)],
					["Kind", kindWord(uri)],
					[
						"Changed",
						editedAt
							? "just now, by you"
							: `${ago(detail.item.changedAt, nowMs)}${changedByWords(detail.changedBy)}`,
					],
					["Length", lengthWords(detail.item.size)],
				]}
			/>
			<section className="mx-levels" aria-label="How memory keeps it">
				<h3>How memory keeps it</h3>
				<Level
					n={1}
					title="One-line summary"
					why={
						detail.summaryOf && detail.summaryOf !== uri
							? `What search and chats see first. Memory keeps it for the folder it sits in: ${folderLabel(parent)}.`
							: "What search and chats see first."
					}
				>
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
				<Level n={2} title="Overview" why={`The page about the folder it sits in: ${folderLabel(parent)}.`}>
					<OverviewFold text={detail.overview} />
				</Level>
				<Level n={3} title="Full text" why="The note itself. Chats read it when they need the detail.">
					{full}
				</Level>
			</section>
		</article>
	);
}
