/**
 * DOM helpers for the Memory explorer's tests (design #316).
 *
 * Queries go by role, accessible name and visible text, never by CSS class, so the markup stays
 * free and the tests bind only to what the owner perceives.
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryExplorerView } from "../../../web/src/memory-explorer/MemoryExplorerView.js";
import type { MemoryExplorerApi } from "../../../web/src/memory-explorer/explorer-api.js";
import { NOW_MS } from "./fake-api.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
	readonly container: HTMLElement;
	unmount(): void;
}

export async function mountExplorer(api: MemoryExplorerApi): Promise<Mounted> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root: Root = createRoot(container);
	await act(async () => root.render(createElement(MemoryExplorerView, { api, now: () => NOW_MS })));
	await flush();
	return {
		container,
		unmount() {
			act(() => root.unmount());
			container.remove();
		},
	};
}

/** Let every answered promise land and React re-render. */
export async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await act(async () => {});
}

export function text(el: Element | null | undefined): string {
	return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** The name a screen reader announces: aria-label, then aria-labelledby, then a <label for>, then text. */
export function accessibleName(el: Element): string {
	const label = el.getAttribute("aria-label");
	if (label) return label.trim();
	const labelledBy = el.getAttribute("aria-labelledby");
	if (labelledBy) {
		return labelledBy
			.split(/\s+/)
			.map((id) => text(el.ownerDocument.getElementById(id)))
			.join(" ")
			.trim();
	}
	if (el.id) {
		const forLabel = el.ownerDocument.querySelector(`label[for="${el.id}"]`);
		if (forLabel) return text(forLabel);
	}
	return text(el);
}

export function byRole(root: ParentNode, role: string, name?: string | RegExp): HTMLElement[] {
	const implicit: Record<string, string> = {
		button: "button",
		heading: "h1,h2,h3,h4",
		textbox: 'textarea,input[type="text"]',
		searchbox: 'input[type="search"]',
		combobox: "select",
		navigation: "nav",
		region: "section[aria-label],section[aria-labelledby]",
		dialog: "dialog",
		status: "output",
		alert: "",
		link: "a[href]",
		list: "ul,ol",
		listitem: "li",
	};
	const selector = [`[role="${role}"]`, implicit[role]].filter(Boolean).join(",");
	const all = [...root.querySelectorAll<HTMLElement>(selector)].filter((el) => !el.closest("[hidden]"));
	if (name === undefined) return all;
	return all.filter((el) => {
		const n = accessibleName(el);
		return typeof name === "string" ? n === name : name.test(n);
	});
}

export function oneByRole(root: ParentNode, role: string, name?: string | RegExp): HTMLElement {
	const found = byRole(root, role, name);
	if (found.length !== 1) {
		throw new Error(`expected one ${role} named ${String(name)}, found ${found.length}`);
	}
	return found[0];
}

export function maybeByRole(root: ParentNode, role: string, name?: string | RegExp): HTMLElement | null {
	return byRole(root, role, name)[0] ?? null;
}

export async function click(el: Element): Promise<void> {
	await act(async () => (el as HTMLElement).click());
	await flush();
}

export async function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
	const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	await act(async () => {
		Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
		el.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

export async function choose(el: HTMLSelectElement, value: string): Promise<void> {
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(el, value);
		el.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await flush();
}

export async function pressKey(el: Element, key: string): Promise<void> {
	await act(async () => {
		el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
	});
	await flush();
}

/** True when `a` comes before `b` in reading order. */
export function before(a: Node, b: Node): boolean {
	return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

/** Visible text, leaving out stored paths shown as data ([data-path]) and closed folds. */
export function visibleWords(root: HTMLElement): string {
	const clone = root.cloneNode(true) as HTMLElement;
	for (const el of clone.querySelectorAll("[data-path],[hidden],details:not([open]) > :not(summary)")) el.remove();
	return text(clone);
}

/** The internal words design #315's plain-word check bans from the first screen (plainwords.py TERMS). */
export const BANNED_TERMS: ReadonlyArray<readonly [string, RegExp]> = [
	["sidecar", /\bsidecar\b/],
	["L0", /\bL0\b/],
	["L1", /\bL1\b/],
	["L2", /\bL2\b/],
	["slot", /\bslots?\b/],
	["Mode", /\bMode\b/],
	["Turn-1", /\bTurn-?1\b/],
	["gate", /\bgates?\b/],
	["cadence", /\bcadence\b/],
	["viking://", /viking:\/\//],
	["R- rule id", /\bR-[A-Z]{3,}/],
	["localhost", /\blocalhost\b/],
	["127.0.0.1", /127\.0\.0\.1/],
	["port number", /:\d{2,5}\b(?!\s*(?:am|pm|AM|PM))|\b1933\b/],
	["hash", /\bhash(es)?\b/],
	["AGFS", /\bAGFS\b/],
	["pi-acp", /\bpi-acp\b/],
	["namespace", /\bnamespaces?\b/],
	["injection", /\binject(ion|ions|ed|s)?\b/],
	["mount", /\bmount(s|ed)?\b/],
];

export function bannedTermsIn(words: string): string[] {
	return BANNED_TERMS.filter(([, rx]) => rx.test(words)).map(([name]) => name);
}

/** Raw markdown marks that must never show in a one-line summary. */
export const MARKDOWN_MARKS = /(^|\s)#{1,6}\s|\*\*|`/;
