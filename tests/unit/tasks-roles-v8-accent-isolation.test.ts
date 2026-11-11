// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { injectTasksRolesV8Styles, TASKS_ROLES_V8_CSS } from "../../web/src/tasks-roles-v8/styles.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function stripComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function parseTopLevelRules(css: string): Array<{ selector: string; body: string }> {
	const clean = stripComments(css);
	const out: Array<{ selector: string; body: string }> = [];
	for (const match of clean.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
		out.push({
			selector: match[1].trim(),
			body: match[2].trim(),
		});
	}
	return out;
}

describe("tasks-roles-v8 CSS isolation (#260, m14902)", () => {
	afterEach(() => {
		document.head.innerHTML = "";
		document.body.innerHTML = "";
		document.documentElement.removeAttribute("data-theme");
	});

	it("never defines :root or --accent-text in TASKS_ROLES_V8_CSS", () => {
		const clean = stripComments(TASKS_ROLES_V8_CSS);
		expect(clean).not.toMatch(/:root\b/);
		expect(clean).not.toMatch(/--accent-text\s*:/);
		expect(clean).toMatch(/--v8-cta-text\s*:\s*#0E0F11/i);
		expect(clean).toMatch(/--v8-cta-text\s*:\s*#FFFFFF/i);
	});

	it("scopes all v8 theme token blocks to .app-shell / v8 host selectors instead of bare html[data-theme]", () => {
		const rules = parseTopLevelRules(TASKS_ROLES_V8_CSS);
		const tokenRules = rules.filter((r) => r.body.includes("--bg-canvas:"));
		expect(tokenRules.length).toBeGreaterThanOrEqual(2);
		for (const rule of tokenRules) {
			const parts = rule.selector.split(",").map((s) => s.trim());
			for (const part of parts) {
				expect(part).not.toBe(":root");
				expect(part).not.toBe('html[data-theme="dark"]');
				expect(part).not.toBe('html[data-theme="light"]');
			}
		}
	});

	it("scopes .topbar and .status-dot in TASKS_ROLES_V8_CSS to .app-shell", () => {
		const rules = parseTopLevelRules(TASKS_ROLES_V8_CSS);
		const topbarRules = rules.filter((r) => /(^|[\s,])\.topbar(\b|$)/.test(r.selector));
		expect(topbarRules.length).toBeGreaterThan(0);
		for (const rule of topbarRules) {
			const parts = rule.selector
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.includes(".topbar"));
			for (const part of parts) {
				expect(part).toContain(".app-shell .topbar");
			}
		}

		const statusDotRules = rules.filter((r) => /\.status-dot\b/.test(r.selector));
		expect(statusDotRules.length).toBeGreaterThan(0);
		for (const rule of statusDotRules) {
			const parts = rule.selector
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.includes(".status-dot"));
			for (const part of parts) {
				expect(part).toContain(".app-shell .status-dot");
			}
		}
	});

	it("preserves global :root --accent-text in dark and white themes after injectTasksRolesV8Styles()", () => {
		const mainStyles = read("web/src/styles.css");
		const rootMatch = stripComments(mainStyles).match(/:root\s*\{[^}]*\}/);
		expect(rootMatch).not.toBeNull();

		const baseStyle = document.createElement("style");
		baseStyle.textContent = rootMatch![0];
		document.head.appendChild(baseStyle);

		injectTasksRolesV8Styles(document);

		expect(getComputedStyle(document.documentElement).getPropertyValue("--accent-text").trim()).toBe("#a78bfa");

		const whiteStyles = read("themes/white.css");
		const whiteRootMatch = stripComments(whiteStyles).match(/:root\s*\{[^}]*\}/);
		expect(whiteRootMatch).not.toBeNull();

		const themeStyle = document.createElement("style");
		themeStyle.id = "theme-stylesheet";
		themeStyle.textContent = whiteRootMatch![0];
		baseStyle.after(themeStyle);
		document.documentElement.setAttribute("data-theme", "light");

		expect(getComputedStyle(document.documentElement).getPropertyValue("--accent-text").trim()).toBe("#0969da");
	});

	it("selected-items.css is imported in main.tsx and styles active slot tabs and provider keys with --accent-text", () => {
		const mainTsx = read("web/src/main.tsx");
		expect(mainTsx).toContain('import "./selected-items.css";');

		const selectedCss = stripComments(read("web/src/selected-items.css"));
		expect(selectedCss).toContain('.slot-tabs-bar [role="tab"][aria-selected="true"]');
		expect(selectedCss).toContain(".dd-provider-item.active .dd-provider-txt .dd-provider-key");
		expect(selectedCss).toContain("color: var(--accent-text);");
		expect(selectedCss).not.toContain("color: var(--accent-soft);");
	});
});
