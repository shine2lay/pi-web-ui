/**
 * The parts of a change the owner makes: the confirm that names the note (modal, Cancel focused,
 * Escape closes, focus goes back where it was), the 10 s Undo toast, and "Changes you made".
 */

import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef } from "react";
import { holdBackgroundInert } from "./modal-inert.js";

export const UNDO_WINDOW_MS = 10_000;

export interface ConfirmAsk {
	readonly title: string;
	readonly body: string;
	readonly yes: string;
	readonly danger: boolean;
	onYes(): void;
}

export function ConfirmDialog({ ask, onClose }: { ask: ConfirmAsk; onClose(): void }) {
	const boxRef = useRef<HTMLDivElement>(null);
	const cancelRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		const box = boxRef.current as HTMLDivElement;
		const doc = box.ownerDocument;
		const returnTo = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
		const release = holdBackgroundInert(box);
		cancelRef.current?.focus();
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			event.preventDefault();
			onClose();
		};
		doc.addEventListener("keydown", closeOnEscape);
		return () => {
			doc.removeEventListener("keydown", closeOnEscape);
			release();
			if (returnTo?.isConnected) returnTo.focus();
		};
	}, [onClose]);

	// Tab and Shift+Tab stay inside the confirm.
	const keepFocusInside = (event: ReactKeyboardEvent) => {
		if (event.key !== "Tab") return;
		const buttons = [...(boxRef.current?.querySelectorAll<HTMLElement>("button") ?? [])];
		const first = buttons[0];
		const last = buttons[buttons.length - 1];
		const active = boxRef.current?.ownerDocument.activeElement;
		if (!event.shiftKey && active === last) {
			event.preventDefault();
			first?.focus();
		} else if (event.shiftKey && active === first) {
			event.preventDefault();
			last?.focus();
		}
	};

	return (
		<div className="mx-scrim">
			<div
				ref={boxRef}
				className="mx-confirm"
				role="dialog"
				aria-modal="true"
				aria-labelledby="mx-confirm-title"
				aria-describedby="mx-confirm-body"
				onKeyDown={keepFocusInside}
			>
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
			</div>
		</div>
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
