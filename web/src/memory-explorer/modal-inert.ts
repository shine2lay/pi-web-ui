/**
 * The page behind an open modal is inert (frontend #274, Design PROD-SIGNOFF M2).
 *
 * `aria-modal="true"` tells a screen reader that nothing outside the dialog exists; `inert` makes
 * that true for the keyboard, the pointer and the accessibility tree alike. Measured on the live page
 * before this: `shellInert: false`, and the third Tab from the reader landed in the app's status bar.
 *
 * Every sibling of the dialog and of each of its ancestors up to <body> is made inert — the
 * dashboard beside it, then the app's top bar and status bar — and only what this call made inert is
 * released again, so an element that was inert for its own reason stays so.
 *
 * If the dialog stops rendering while still mounted (the app switched to another view, whose pane is
 * `display: none`), holding the app inert would leave nothing usable at all, so the hold follows the
 * dialog's own box: released while it has no size, taken again when it shows.
 */
export function holdBackgroundInert(dialog: HTMLElement): () => void {
	let held: HTMLElement[] = [];

	const take = (): void => {
		if (held.length > 0) return;
		const body = dialog.ownerDocument.body;
		for (let node: HTMLElement = dialog; node !== body && node.parentElement; node = node.parentElement) {
			for (const sibling of node.parentElement.children) {
				if (sibling === node || !(sibling instanceof HTMLElement) || sibling.hasAttribute("inert")) continue;
				sibling.setAttribute("inert", "");
				held.push(sibling);
			}
		}
	};
	const release = (): void => {
		for (const element of held) element.removeAttribute("inert");
		held = [];
	};

	take();
	const view = dialog.ownerDocument.defaultView;
	const Observer = view?.ResizeObserver;
	const observer = Observer ? new Observer(() => (dialog.getClientRects().length > 0 ? take() : release())) : null;
	observer?.observe(dialog);
	return () => {
		observer?.disconnect();
		release();
	};
}
