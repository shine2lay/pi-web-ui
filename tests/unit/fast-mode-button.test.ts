// @vitest-environment jsdom
/**
 * fast-mode: the "⚡ Fast" button (web/src/components/FastModeButton.tsx): nothing without fast mode,
 * highlighted when on, dimmed with the reason while at "normal speed for now", and a click asks the
 * server for the other state.
 */
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { setAppSend } from "../../web/src/app-globals.js";
import { FastModeButton, fastCooling } from "../../web/src/components/FastModeButton.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { UiFastMode } from "../../web/src/types.js";

let root: Root | null = null;

function mount(fast: UiFastMode | null, disabled = false) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const sent: unknown[] = [];
	setAppSend((message) => {
		sent.push(message);
		return true;
	});
	root = createRoot(container);
	act(() => {
		root!.render(createElement(LanguageProvider, null, createElement(FastModeButton, { fast, disabled })));
	});
	return { container, sent, button: container.querySelector("button.fast-chip") as HTMLButtonElement | null };
}

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

const TIP = "Fast mode: faster replies; uses your ChatGPT plan's limits 2.5\u00d7 quicker";

describe("fast-mode button", () => {
	it("no fast mode (Claude, other models): no button", () => {
		const { container } = mount(null);
		expect(container.innerHTML).toBe("");
	});

	it("off: a plain chip with the tip; a click turns it on", () => {
		const { button, sent } = mount({ on: false });
		expect(button).not.toBeNull();
		expect(button!.classList.contains("on")).toBe(false);
		expect(button!.getAttribute("aria-pressed")).toBe("false");
		expect(button!.dataset.tip).toBe(TIP);
		expect(button!.textContent).toContain("\u26a1");
		expect(button!.textContent).toContain("Fast");
		act(() => button!.click());
		expect(sent).toEqual([{ type: "set_fast_mode", on: true }]);
	});

	it("on: highlighted; a click turns it off", () => {
		const { button, sent } = mount({ on: true });
		expect(button!.classList.contains("on")).toBe(true);
		expect(button!.classList.contains("cooling")).toBe(false);
		expect(button!.getAttribute("aria-pressed")).toBe("true");
		expect(button!.dataset.tip).toBe(TIP);
		act(() => button!.click());
		expect(sent).toEqual([{ type: "set_fast_mode", on: false }]);
	});

	it("normal speed for now: dimmed, says so, and the tip gives the reason", () => {
		const reason = "ChatGPT refused fast mode (HTTP 400)";
		const { button, sent } = mount({ on: true, coolingUntil: Date.now() + 15 * 60_000, reason });
		expect(button!.classList.contains("on")).toBe(true);
		expect(button!.classList.contains("cooling")).toBe(true);
		expect(button!.textContent).toContain("Normal speed for now");
		expect(button!.dataset.tip).toContain(TIP);
		expect(button!.dataset.tip).toContain(reason);
		// Clicking turns it off (off-and-on again tries fast right away).
		act(() => button!.click());
		expect(sent).toEqual([{ type: "set_fast_mode", on: false }]);
	});

	it("a cooldown that has run out shows plain on", () => {
		const { button } = mount({ on: true, coolingUntil: Date.now() - 1000, reason: "old" });
		expect(button!.classList.contains("cooling")).toBe(false);
		expect(button!.dataset.tip).toBe(TIP);
	});

	it("while disconnected the button can't be clicked", () => {
		const { button } = mount({ on: false }, true);
		expect(button!.disabled).toBe(true);
	});

	it("fastCooling", () => {
		const now = 1000;
		expect(fastCooling(null, now)).toBe(false);
		expect(fastCooling({ on: false, coolingUntil: 2000 }, now)).toBe(false);
		expect(fastCooling({ on: true }, now)).toBe(false);
		expect(fastCooling({ on: true, coolingUntil: 2000 }, now)).toBe(true);
		expect(fastCooling({ on: true, coolingUntil: 500 }, now)).toBe(false);
	});
});
