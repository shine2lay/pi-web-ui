import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { composeToComposer, focusComposer } from "../composer-bridge";
import { formatQuote, readQuoteSelection } from "../quote-selection";

/** Selection and placement ported from 0.111.0; text is inserted, never sent. */
export function SelectionQuoteButton({
	rootRef,
	sessionId,
}: {
	rootRef: RefObject<HTMLDivElement | null>;
	sessionId: string;
}) {
	const [pending, setPending] = useState<{ text: string; left: number; top: number } | null>(null);
	useEffect(() => {
		setPending(null);
		const root = rootRef.current;
		if (!root) return;
		let frame = 0;
		let selecting = false;
		let current: typeof pending = null;
		const clear = () => {
			cancelAnimationFrame(frame);
			current = null;
			setPending(null);
		};
		const accept = () => {
			if (!current || !composeToComposer({ text: formatQuote(current.text) })) return;
			clear();
			window.getSelection()?.removeAllRanges();
			focusComposer();
		};
		const update = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				const selection = window.getSelection();
				const text = readQuoteSelection(root, selection);
				if (!text || !selection) {
					clear();
					return;
				}
				const rect = selection.getRangeAt(0).getBoundingClientRect();
				if (!rect.width && !rect.height) {
					clear();
					return;
				}
				current = {
					text,
					left: Math.max(8, Math.min(rect.right - 88, window.innerWidth - 96)),
					top: Math.max(8, Math.min(rect.top >= 44 ? rect.top - 40 : rect.bottom + 8, window.innerHeight - 42)),
				};
				setPending(current);
			});
		};
		const down = (event: PointerEvent) => {
			if ((event.target as Element)?.closest?.(".quote-selection-button")) return;
			selecting = event.button === 0 && root.contains(event.target as Node);
			clear();
		};
		const up = () => {
			selecting = false;
			update();
		};
		const change = () => {
			if (!selecting) update();
		};
		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape") clear();
			if (event.key === "Enter" && !event.isComposing && current) {
				const target = event.target instanceof Element ? event.target : null;
				// Do not steal Enter from a search/dialog input after keyboard focus moves.
				if (target?.closest("input, textarea, [contenteditable]") && !target.closest(".inputbox")) return;
				event.preventDefault();
				event.stopPropagation();
				accept();
			}
		};
		const click = (event: MouseEvent) => {
			if ((event.target as Element)?.closest?.(".quote-selection-button")) accept();
		};
		document.addEventListener("pointerdown", down);
		document.addEventListener("pointerup", up);
		document.addEventListener("pointercancel", up);
		document.addEventListener("selectionchange", change);
		document.addEventListener("keydown", key, true);
		document.addEventListener("click", click);
		window.addEventListener("scroll", clear, true);
		window.addEventListener("resize", clear);
		window.addEventListener("blur", clear);
		return () => {
			cancelAnimationFrame(frame);
			document.removeEventListener("pointerdown", down);
			document.removeEventListener("pointerup", up);
			document.removeEventListener("pointercancel", up);
			document.removeEventListener("selectionchange", change);
			document.removeEventListener("keydown", key, true);
			document.removeEventListener("click", click);
			window.removeEventListener("scroll", clear, true);
			window.removeEventListener("resize", clear);
			window.removeEventListener("blur", clear);
		};
	}, [rootRef, sessionId]);
	if (!pending) return null;
	return createPortal(
		<button
			type="button"
			className="quote-selection-button"
			style={{ left: pending.left, top: pending.top }}
			onPointerDown={(event) => event.preventDefault()}
			onMouseDown={(event) => event.preventDefault()}
		>
			<span aria-hidden="true">↪</span> Quote
		</button>,
		document.body,
	);
}
