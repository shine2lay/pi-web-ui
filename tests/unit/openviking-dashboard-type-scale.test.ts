/**
 * OpenViking Memory Dashboard — type sizes come from the design tokens, never below the floor
 * (frontend #274; Design PROD-SIGNOFF M3 + S3, frontend #269 F5).
 *
 * Design measured 50 of 178 visible text runs below 12px (a 9px help mark, 11px x45), body copy at
 * 12-13px and the largest type at 20px, against `tokens.json` (`size-xs` 12px, "Smallest size
 * allowed"), `design.md` (body >= 16px, labels >= 12px) and the prototype's 22px hero. The cause was
 * hand-written sizes: any literal can slip under the floor. So the dashboard's CSS declares the token
 * scale once, with the values `tokens.json` holds (this file is the parity check), and every
 * `font-size` names a step of that scale. The rendered measurement (0 runs below 12px on the live
 * page, drawer open) is `tests/openviking-modal-keyboard-test.mjs`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SEAM = join(ROOT, "web/src/openviking-dashboard");
const CSS_FILES = [
	"openviking-dashboard.css",
	"openviking-dashboard-rows.css",
	"openviking-dashboard-panel-states.css",
] as const;

const tokens = JSON.parse(readFileSync(join(ROOT, ".temper/design/tokens.json"), "utf8")) as {
	typography: Record<string, { value?: string }>;
};
const SCALE = Object.fromEntries(
	Object.entries(tokens.typography)
		.filter(([name]) => name.startsWith("size-"))
		.map(([name, entry]) => [name, entry.value ?? ""]),
);
const px = (value: string): number => Number(/^(\d+(?:\.\d+)?)px$/.exec(value)?.[1] ?? Number.NaN);
const css = (file: string): string => readFileSync(join(SEAM, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** `selector -> declarations` pairs, media blocks flattened, enough to find where a size is set. */
function rules(source: string): { readonly selector: string; readonly body: string }[] {
	return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
}

function fontSizes(): { readonly file: string; readonly selector: string; readonly value: string }[] {
	return CSS_FILES.flatMap((file) =>
		rules(css(file)).flatMap(({ selector, body }) =>
			[...body.matchAll(/(?:^|;)\s*font-size:\s*([^;]+);/g)].map((m) => ({ file, selector, value: m[1]!.trim() })),
		),
	);
}

describe("openviking dashboard type scale (#274, M3)", () => {
	it("declares the token scale once, with the values tokens.json holds", () => {
		expect(Object.keys(SCALE).length).toBeGreaterThanOrEqual(6);
		const declared = new Map<string, string>();
		for (const file of CSS_FILES) {
			for (const m of css(file).matchAll(/--(size-[a-z]+):\s*([^;]+);/g)) {
				expect(declared.has(m[1]!), `--${m[1]} declared twice`).toBe(false);
				declared.set(m[1]!, m[2]!.trim());
			}
		}
		expect(Object.fromEntries(declared)).toEqual(SCALE);
	});

	it("sets every font size from that scale — no literal can slip under the floor", () => {
		const literal = fontSizes().filter(({ value }) => !/^var\(--size-[a-z]+\)$/.test(value) && value !== "inherit");
		// One platform constant, not a design size: iOS Safari zooms the page into a focused control set
		// below 16px, so the phone-width filter select pins 16px (asserted by the #261 suite).
		expect(literal).toEqual([{ file: "openviking-dashboard-rows.css", selector: ".ovk-select", value: "16px" }]);
	});

	it("never names a step below size-xs (12px), and size-xs is 12px", () => {
		expect(px(SCALE["size-xs"]!)).toBe(12);
		const used = fontSizes()
			.map(({ value }) => /^var\(--(size-[a-z]+)\)$/.exec(value)?.[1])
			.filter((name): name is string => Boolean(name));
		expect(used.length).toBeGreaterThan(30);
		for (const name of used) {
			expect(SCALE[name], `--${name} is not a token`).toBeDefined();
			expect(px(SCALE[name]!)).toBeGreaterThanOrEqual(12);
		}
	});

	it("reads body copy at the design floor and leads with the 22px hero", () => {
		const sizeOf = (selector: string): string | undefined =>
			fontSizes().find((entry) =>
				entry.selector
					.split(",")
					.map((s) => s.trim())
					.includes(selector),
			)?.value;
		expect(px(SCALE["size-body"]!)).toBeGreaterThanOrEqual(16);
		expect(px(SCALE["size-xl"]!)).toBe(22);
		expect(sizeOf(".ovk-root")).toBe("var(--size-body)");
		expect(sizeOf(".ovk-card-headline")).toBe("var(--size-xl)");
		for (const body of [
			".ovk-mode-label",
			".ovk-row-abstract",
			".ovk-empty-note",
			".ovk-panel-failed",
			".ovk-drawer-body",
		]) {
			expect(sizeOf(body), body).toBe("var(--size-body)");
		}
	});
});
