/**
 * mobile-fixes: the message box and the on-screen keyboard on phones.
 *
 * index.html asks Android Chrome (108+) to shrink the whole page for the keyboard
 * (interactive-widget=resizes-content), so the app simply gets shorter and the message box sits right
 * above the keyboard. Two helpers here:
 *
 * - A browser that ignores that setting only shrinks the visible part and slides it over the page,
 *   which can hide the message box under the keyboard and push the top bar off screen. There, while
 *   the keyboard is up, the app's height follows the visible part (--app-vh) and the page stays at the
 *   top (html.vv-fallback).
 * - While the keyboard is up, html gets the class kb-up: a short screen then keeps room for the chat
 *   (styles.css moves the status line and the Goal pill aside; ChatInput keeps a long message box
 *   shorter). Both come back when the keyboard goes down.
 *
 * Android only: iPhone Safari moves the page its own way and is left as it was.
 */

/** The visible part this much shorter than the page (at normal zoom) means a keyboard. */
const KEYBOARD_MIN_PX = 120;

/** Should the app follow the visible part? (pure, for tests) */
export function needsFallback(layoutHeight: number, visibleHeight: number, scale: number): boolean {
	return Math.abs(scale - 1) < 0.01 && layoutHeight - visibleHeight > KEYBOARD_MIN_PX;
}

/** Is the keyboard up? A text field has focus and the screen is clearly shorter than it gets at this
 *  width (the browser's own bars coming and going move it by less). Pure, for tests. */
export function keyboardIsUp(tallest: number, height: number, editing: boolean): boolean {
	return editing && tallest - height > KEYBOARD_MIN_PX;
}

// -- "Is the keyboard up?" as a tiny store (ChatInput listens) --------------------
let kbUp = false;
const kbListeners = new Set<() => void>();

export function isKeyboardUp(): boolean {
	return kbUp;
}

export function subscribeKeyboard(l: () => void): () => void {
	kbListeners.add(l);
	return () => kbListeners.delete(l);
}

function isEditable(el: Element | null): boolean {
	if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
	if (el instanceof HTMLInputElement) {
		return (
			!el.readOnly &&
			!el.disabled &&
			!/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/i.test(el.type)
		);
	}
	return el instanceof HTMLElement && el.isContentEditable;
}

export function installMobileViewport(): void {
	const vv = window.visualViewport;
	if (!vv || !/Android/i.test(navigator.userAgent)) return;
	const root = document.documentElement;

	let fallbackOn = false;
	const updateFallback = () => {
		if (needsFallback(window.innerHeight, vv.height, vv.scale)) {
			root.style.setProperty("--app-vh", `${Math.round(vv.height)}px`);
			if (!fallbackOn) {
				fallbackOn = true;
				root.classList.add("vv-fallback");
			}
			if (window.scrollY !== 0) window.scrollTo(0, 0);
		} else if (fallbackOn) {
			fallbackOn = false;
			root.classList.remove("vv-fallback");
			root.style.removeProperty("--app-vh");
		}
	};

	let width = window.innerWidth;
	let tallest = 0;
	const updateKeyboard = () => {
		const height = Math.abs(vv.scale - 1) < 0.01 ? Math.min(window.innerHeight, vv.height) : window.innerHeight;
		// Turned sideways (or the window changed width): start measuring again.
		if (window.innerWidth !== width) {
			width = window.innerWidth;
			tallest = 0;
		}
		tallest = Math.max(tallest, height);
		const up = keyboardIsUp(tallest, height, isEditable(document.activeElement));
		if (up !== kbUp) {
			kbUp = up;
			root.classList.toggle("kb-up", up);
			for (const l of kbListeners) l();
		}
	};

	const update = () => {
		updateFallback();
		updateKeyboard();
	};
	vv.addEventListener("resize", update);
	vv.addEventListener("scroll", updateFallback);
	window.addEventListener("resize", updateKeyboard);
	document.addEventListener("focusin", updateKeyboard);
	// Focus has moved on only after focusout has run.
	document.addEventListener("focusout", () => setTimeout(updateKeyboard, 0));
	update();
}
