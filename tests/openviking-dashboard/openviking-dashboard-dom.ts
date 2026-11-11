/**
 * DOM helpers for the OpenViking Memory Dashboard acceptance tests (frontend #261, Task 1).
 *
 * Queries go by role, accessible name and the contract's `data-*` attributes — never by CSS class
 * or DOM shape, so Task 2 (#258) is free in its markup and bound only to what a user perceives.
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	OpenVikingDashboardView,
	type OpenVikingDashboardViewProps,
} from "../../web/src/openviking-dashboard/OpenVikingDashboardView.js";

export interface MountedDashboard {
	readonly container: HTMLElement;
	rerender(props: OpenVikingDashboardViewProps): void;
	unmount(): void;
}

export function mountDashboard(props: OpenVikingDashboardViewProps): MountedDashboard {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root: Root = createRoot(container);
	act(() => root.render(createElement(OpenVikingDashboardView, props)));
	return {
		container,
		rerender(next: OpenVikingDashboardViewProps) {
			act(() => root.render(createElement(OpenVikingDashboardView, next)));
		},
		unmount() {
			act(() => root.unmount());
			container.remove();
		},
	};
}

/**
 * Every DOM acceptance test starts here: while the Task 1 stub is mounted there is nothing to
 * assert, and the failure says so instead of pretending the page is wrong in some other way.
 */
export function requireSeamImplemented(container: HTMLElement): void {
	if (container.querySelector('[data-openviking-seam="not-implemented"]')) {
		throw new Error(
			"OpenViking dashboard seam is still the Task 1 stub: Task 2 (#258) must render the page " +
				"(web/src/openviking-dashboard/OpenVikingDashboardView.tsx).",
		);
	}
}

export function queryAllByRole(root: ParentNode, role: string): HTMLElement[] {
	return [...root.querySelectorAll<HTMLElement>(`[role="${role}"]`)];
}

export function queryByRole(root: ParentNode, role: string): HTMLElement | null {
	return root.querySelector<HTMLElement>(`[role="${role}"]`);
}

/** The name a screen reader announces: `aria-label`, then the `aria-labelledby` target, then text. */
export function accessibleName(el: Element): string {
	const label = el.getAttribute("aria-label");
	if (label) return label.trim();
	const labelledBy = el.getAttribute("aria-labelledby");
	if (labelledBy) {
		const target = el.ownerDocument.getElementById(labelledBy);
		if (target) return text(target);
	}
	return text(el);
}

export function text(el: Element | null): string {
	return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function part(root: ParentNode, component: string): HTMLElement | null {
	return root.querySelector<HTMLElement>(`[data-component="${component}"]`);
}

export function parts(root: ParentNode, component: string): HTMLElement[] {
	return [...root.querySelectorAll<HTMLElement>(`[data-component="${component}"]`)];
}

export function tabButtons(root: ParentNode): HTMLElement[] {
	const list = queryByRole(root, "tablist");
	return list ? queryAllByRole(list, "tab") : [];
}

export function tabPanel(root: ParentNode, tab: string): HTMLElement | null {
	return root.querySelector<HTMLElement>(`[data-tabpanel="${tab}"]`);
}

export function click(el: Element): void {
	act(() => (el as HTMLElement).click());
}

export function pressKey(el: Element, key: string): void {
	act(() => {
		el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
	});
}

export function focus(el: Element): void {
	act(() => (el as HTMLElement).focus());
}

/** Every `data-source-field` value painted inside `root` — the proof a figure names its server field. */
export function sourceFields(root: ParentNode): string[] {
	return [...root.querySelectorAll<HTMLElement>("[data-source-field]")].map(
		(el) => el.getAttribute("data-source-field") ?? "",
	);
}

export const HASH_64 = /\b[0-9a-f]{64}\b/i;
export const RAW_PATH = /(^|[\s"'(])\/(home|var|tmp|usr)\//;
