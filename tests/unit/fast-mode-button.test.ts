// @vitest-environment jsdom
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { setAppSend } from "../../web/src/app-globals.js";
import { FastModeButton, fastCooling } from "../../web/src/components/FastModeButton.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { UiFastMode } from "../../web/src/types.js";
let root: Root | null = null;
const standard: UiFastMode = { mode: "standard", effective: "standard", ultrafastAvailable: true };
function mount(fast: UiFastMode | null, disabled = false, conversationId: string | undefined = "c-test") {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const sent: unknown[] = [];
	setAppSend((message) => {
		sent.push(message);
		return true;
	});
	root = createRoot(container);
	act(() =>
		root!.render(
			createElement(LanguageProvider, null, createElement(FastModeButton, { fast, disabled, conversationId })),
		),
	);
	const button = container.querySelector<HTMLButtonElement>(".fast-chip");
	return { container, sent, button };
}
afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});
describe("per-chat speed selector", () => {
	it("is absent for unsupported providers/models", () => {
		expect(mount(null).container.innerHTML).toBe("");
	});
	it("starts Standard; exposes three named radios without warnings or help text", () => {
		const { button, container, sent } = mount(standard);
		expect(button?.textContent).toContain("Standard");
		act(() => button!.click());
		expect(button?.getAttribute("aria-expanded")).toBe("true");
		expect(container.querySelectorAll("input[type=radio]").length).toBe(3);
		expect(container.textContent).not.toMatch(/2\.5×|8×|6×|Pro \$500|credits|unconfirmed|confirmed by|requirements/i);
		expect(container.querySelector(".speed-menu p, .speed-menu a")).toBeNull();
		act(() => container.querySelector<HTMLInputElement>('input[value="ultrafast"]')!.click());
		expect(sent).toEqual([{ type: "set_fast_mode", mode: "ultrafast", conversationId: "c-test" }]);
	});
	it("Fast stays Fast; the other ChatGPT models offer only two choices", () => {
		const { button, container } = mount({ ...standard, mode: "fast", effective: "fast", ultrafastAvailable: false });
		expect(button?.textContent).toContain("Fast");
		expect(button?.textContent).not.toContain("?");
		act(() => button!.click());
		expect(container.querySelectorAll("input").length).toBe(2);
		expect(container.querySelector('input[value="ultrafast"]')).toBeNull();
	});
	it("visible temporary Standard preserves the requested Ultrafast radio", () => {
		const { button, container } = mount({
			...standard,
			mode: "ultrafast",
			coolingUntil: Date.now() + 60_000,
			reason: "ChatGPT refused Ultrafast",
		});
		expect(button?.textContent).toContain("Standard · now");
		act(() => button!.click());
		expect(container.querySelector<HTMLInputElement>('input[value="ultrafast"]')?.checked).toBe(true);
		expect(container.querySelector('[role="status"]')?.textContent).toContain("ChatGPT refused Ultrafast");
	});
	it("shows the selected setting without provider-confirmation commentary", () => {
		const { button, container } = mount({
			...standard,
			mode: "ultrafast",
			effective: "ultrafast",
			confirmedMode: "ultrafast",
		});
		expect(button?.textContent).not.toContain("?");
		act(() => button!.click());
		expect(container.textContent).not.toMatch(/confirmed|ChatGPT/);
		expect(container.querySelector(".speed-menu p")).toBeNull();
	});
	it("Escape closes and restores focus", () => {
		const { button, container } = mount(standard);
		act(() => button!.click());
		expect(document.activeElement?.getAttribute("value")).toBe("standard");
		act(() =>
			container.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
		);
		expect(button?.getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(button);
	});
	it("a disconnected control cannot change speed", () => {
		const { button, sent } = mount(standard, true);
		expect(button?.disabled).toBe(true);
		act(() => button!.click());
		expect(sent.length).toBe(0);
	});
	it("a read-only control without a chat id cannot change speed", () => {
		const { button, sent } = mount(standard, false, "");
		expect(button?.disabled).toBe(true);
		act(() => button!.click());
		expect(sent).toEqual([]);
	});
	it("cooldown expires and requested mode can return", () => {
		expect(fastCooling(null, 100)).toBe(false);
		expect(fastCooling({ ...standard, mode: "ultrafast", coolingUntil: 101 }, 100)).toBe(true);
		expect(fastCooling({ ...standard, mode: "ultrafast", coolingUntil: 99 }, 100)).toBe(false);
		const { button } = mount({ ...standard, mode: "ultrafast", coolingUntil: Date.now() - 1000 });
		expect(button?.textContent).toContain("Ultrafast");
		expect(button?.textContent).not.toContain("?");
	});
});
