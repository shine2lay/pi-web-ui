/**
 * The parts of a change the owner makes: the confirm that names the note (modal, Cancel focused,
 * Escape closes, focus goes back where it was), the 10 s Undo toast, and "Changes you made".
 */

import { useEffect, useRef } from "react";
import type { ChangeRecord } from "./explorer-api.js";
import { clock, keptIn, noteTitle } from "./explorer-text.js";
import { ModalBox } from "./ModalBox.js";

export const UNDO_WINDOW_MS = 10_000;

export interface ConfirmAsk {
	readonly title: string;
	readonly body: string;
	readonly yes: string;
	readonly danger: boolean;
	onYes(): void;
}

export function ConfirmDialog({ ask, onClose }: { ask: ConfirmAsk; onClose(): void }) {
	const cancelRef = useRef<HTMLButtonElement>(null);
	return (
		<ModalBox labelledBy="mx-confirm-title" describedBy="mx-confirm-body" initialFocus={cancelRef} onClose={onClose}>
			<h2 id="mx-confirm-title">{ask.title}</h2>
			<p id="mx-confirm-body">{ask.body}</p>
			<div className="mx-actions">
				<button ref={cancelRef} type="button" className="mx-btn" onClick={onClose}>
					Cancel
				</button>
				<button
					type="button"
					className={ask.danger ? "mx-btn mx-btn-danger" : "mx-btn mx-btn-solid"}
					onClick={() => {
						onClose();
						ask.onYes();
					}}
				>
					{ask.yes}
				</button>
			</div>
		</ModalBox>
	);
}

export interface UndoOffer {
	readonly id: string;
	readonly message: string;
	onUndo(): void;
}

/** "Saved …" / "Deleted …" with Undo, gone after the undo window. */
export function UndoToast({ offer, onGone }: { offer: UndoOffer; onGone(): void }) {
	useEffect(() => {
		const timer = setTimeout(onGone, UNDO_WINDOW_MS);
		return () => clearTimeout(timer);
	}, [offer.id, onGone]);
	return (
		<div className="mx-toast" role="status">
			<span>{offer.message}</span>
			<button
				type="button"
				className="mx-link"
				onClick={() => {
					onGone();
					offer.onUndo();
				}}
			>
				Undo
			</button>
		</div>
	);
}

export interface MadeChange {
	readonly id: string;
	readonly what: "Changed" | "Deleted";
	readonly title: string;
	readonly where: string;
	/** Clock time it was made, e.g. "9:05 PM". */
	readonly when: string;
	readonly undone: boolean;
}

/** A change read back from memory's change record, in the list's words. */
export function madeFromRecord(record: ChangeRecord): MadeChange {
	return {
		id: record.id,
		what: record.action === "delete" ? "Deleted" : "Changed",
		title: noteTitle(record.uri),
		where: keptIn(record.uri),
		when: clock(record.at),
		undone: record.undone,
	};
}

/** This visit's changes first, then earlier ones from the change record (each once). */
export function mergeChanges(made: readonly MadeChange[], recorded: readonly ChangeRecord[]): MadeChange[] {
	const seen = new Set(made.map((c) => c.id));
	return [...made, ...recorded.filter((r) => !seen.has(r.id)).map(madeFromRecord)];
}

export function ChangesYouMade({ changes }: { changes: readonly MadeChange[] }) {
	if (changes.length === 0) return null;
	return (
		<section className="mx-changes" aria-labelledby="mx-changes-title">
			<h2 id="mx-changes-title">Changes you made</h2>
			<ul>
				{changes.map((c) => (
					<li key={c.id}>
						<span>
							{c.what} <b>{c.title}</b> <span className="mx-dim">in {c.where}</span>
						</span>
						<span className="mx-dim">{c.undone ? `undone · ${c.when}` : `by you · ${c.when}`}</span>
					</li>
				))}
			</ul>
			<p className="mx-dim">Every change is kept in memory's change record, with your name and the time.</p>
		</section>
	);
}
