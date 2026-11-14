/**
 * The one modal box the Memory page uses (the change confirm, the owner's sign-in, his passkeys):
 * `role="dialog"` + `aria-modal`, the page behind made inert, the first control (or `initialFocus`)
 * focused, Tab and Shift+Tab kept inside, Escape closes, and focus goes back to what opened it.
 */

import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject, useEffect, useRef } from "react";
import { holdBackgroundInert } from "./modal-inert.js";

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select, a[href]";

export interface ModalBoxProps {
	readonly labelledBy: string;
	readonly describedBy?: string;
	readonly className?: string;
	/** Focused when the box opens; the first control otherwise. */
	readonly initialFocus?: RefObject<HTMLElement | null>;
	/** Where focus goes on close; what had focus when it opened otherwise. */
	readonly returnFocus?: HTMLElement | null;
	onClose(): void;
	readonly children: ReactNode;
}

export function ModalBox({
	labelledBy,
	describedBy,
	className,
	initialFocus,
	returnFocus,
	onClose,
	children,
}: ModalBoxProps) {
	const boxRef = useRef<HTMLDivElement>(null);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;

	useEffect(() => {
		const box = boxRef.current as HTMLDivElement;
		const doc = box.ownerDocument;
		const opener = returnFocus ?? (doc.activeElement instanceof HTMLElement ? doc.activeElement : null);
		const release = holdBackgroundInert(box);
		(initialFocus?.current ?? box.querySelector<HTMLElement>(FOCUSABLE) ?? box).focus();
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			event.preventDefault();
			closeRef.current();
		};
		doc.addEventListener("keydown", closeOnEscape);
		return () => {
			doc.removeEventListener("keydown", closeOnEscape);
			release();
			if (opener?.isConnected) opener.focus();
		};
		// Opened once per mount: a new opener or first focus is a new box (keyed by the caller).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const keepFocusInside = (event: ReactKeyboardEvent) => {
		if (event.key !== "Tab") return;
		const controls = [...(boxRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
		const first = controls[0];
		const last = controls[controls.length - 1];
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
				className={className ?? "mx-confirm"}
				role="dialog"
				aria-modal="true"
				aria-labelledby={labelledBy}
				aria-describedby={describedBy}
				tabIndex={-1}
				onKeyDown={keepFocusInside}
			>
				{children}
			</div>
		</div>
	);
}
