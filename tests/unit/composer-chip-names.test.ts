// @vitest-environment jsdom
/**
 * Ops #640: the composer's model and thinking chips keep an accessible name on a phone.
 *
 * At 560px or less styles.css hides the chips' text (display:none) and leaves only their icons, so
 * the two buttons had no name at all: a screen reader read them as "button", and axe reported
 * button-name (critical) on the phone layout only. Their name now comes from aria-label, which says
 * what the button is for and its current value, and holds the text the desktop chip shows.
 *
 * jsdom applies plain style rules but not @media ones, so the test takes the phone rule out of
 * styles.css and applies it as a plain rule.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ModelThinking } from "../../web/src/components/ModelThinking.js";
import { LanguageProvider } from "../../web/src/i18n.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = readFileSync(join(ROOT, "web", "src", "styles.css"), "utf8");
/** The phone rule that leaves the chips with only their icons. */
const PHONE_RULE =
	/@media \(max-width: 560px\) \{\s*(\.composer-tools \.chip > span\.chip-model,\s*\.composer-tools \.chip > span\.chip-sub\s*\{\s*display:\s*none;\s*\})/;

type State = ComponentProps<typeof ModelThinking>["state"];
const STATE: State = {
	model: { id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "claude-real", vision: true },
	thinkingLevel: "high",
	availableThinkingLevels: ["off", "low", "medium", "high"],
};

let root: Root | null = null;
const added: Element[] = [];

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	for (const el of added.splice(0)) el.remove();
});

function phoneLayout() {
	const rule = PHONE_RULE.exec(CSS);
	expect(rule, "styles.css hides the composer chips' text at 560px or less").not.toBeNull();
	const style = document.createElement("style");
	style.textContent = rule![1];
	document.head.appendChild(style);
	added.push(style);
}

/** The two chips as ChatInput draws them: one picker each, compact, inside .composer-tools. */
function mountChips(state: State) {
	const tools = document.createElement("div");
	tools.className = "composer-tools";
	document.body.appendChild(tools);
	added.push(tools);
	root = createRoot(tools);
	const common = { state, models: [], modelsLoading: false, onManageModels: () => {}, providerKeys: {}, compact: true };
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(ModelThinking, { ...common, defaultModel: null, only: "model" }),
				createElement(ModelThinking, { ...common, only: "thinking" }),
			),
		);
	});
	const buttons = [...tools.querySelectorAll<HTMLButtonElement>(".dropdown > button.chip")];
	expect(buttons).toHaveLength(2);
	return { model: buttons[0], thinking: buttons[1] };
}

const hidden = (el: Element) => {
	const cs = getComputedStyle(el);
	return cs.display === "none" || cs.visibility === "hidden" || el.getAttribute("aria-hidden") === "true";
};

/** The steps of the accessible name computation (accname 1.2) that apply to these buttons:
 *  aria-labelledby, aria-label, the text of what is rendered inside it, then title. */
function accessibleName(button: HTMLButtonElement): string {
	const byIds = (button.getAttribute("aria-labelledby") ?? "")
		.split(/\s+/)
		.filter(Boolean)
		.map((id) => document.getElementById(id)?.textContent ?? "")
		.join(" ")
		.trim();
	if (byIds) return byIds;
	const label = button.getAttribute("aria-label")?.trim();
	if (label) return label;
	const text = (node: Node): string => {
		if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
		if (!(node instanceof Element) || hidden(node)) return "";
		return node.getAttribute("aria-label")?.trim() || [...node.childNodes].map(text).join("");
	};
	const content = [...button.childNodes].map(text).join("").replace(/\s+/g, " ").trim();
	return content || (button.getAttribute("title")?.trim() ?? "");
}

describe("composer model and thinking chips: accessible name (Ops #640)", () => {
	it("on a phone, where only the icons show, both buttons keep a name with the current model and level", () => {
		phoneLayout();
		const { model, thinking } = mountChips(STATE);
		// the phone layout really is in force: the text the desktop shows is hidden
		expect(hidden(model.querySelector(".chip-model")!)).toBe(true);
		expect(hidden(thinking.querySelector(".chip-sub")!)).toBe(true);
		expect(accessibleName(model)).toBe("Model: Claude Opus 5.5");
		expect(accessibleName(thinking)).toBe("Thinking: High");
	});

	it("before the chat's state arrives, the phone buttons still say what they are for", () => {
		phoneLayout();
		const { model, thinking } = mountChips(null);
		expect(accessibleName(model)).toBe("Select model");
		expect(accessibleName(thinking)).toBe("Thinking level");
	});

	it("on a desktop, each name holds the text the chip shows (label in name)", () => {
		const { model, thinking } = mountChips(STATE);
		expect(model.textContent?.trim()).toBe("Claude Opus 5.5");
		expect(thinking.textContent?.trim()).toBe("High");
		expect(accessibleName(model)).toContain("Claude Opus 5.5");
		expect(accessibleName(thinking)).toContain("High");
	});
});
