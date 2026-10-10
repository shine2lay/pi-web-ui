import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * faint-contrast (Design rm-947a15e3): --text-faint carries information (ids, times, Touches, after lines,
 * hints), so in the default dark palette and in White it must reach WCAG 2.2 AA 1.4.3, 4.5:1, on the three
 * page backgrounds (--bg, --bg-elev, --bg-elev2), and stay fainter than --text-dim. A later palette edit
 * can't quietly bring the old greys back (#6b7284 dark: 3.50-4.01:1, #818b98 White: 3.24-3.45:1).
 *
 * Reads the palettes as shipped: the first :root block of web/src/styles.css (the default, which
 * make-light-theme.mjs and the hand-made Translucent / Transparent copy) and the generated themes/white.css.
 * The Queue tab's tinted rows are measured in the browser by tests/faint-contrast-test.mjs (axe).
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** The custom properties of a file's first `:root { ... }` block. */
function rootVars(css: string): Map<string, string> {
	const start = css.indexOf(":root");
	const open = css.indexOf("{", start);
	const close = css.indexOf("}", open);
	expect(start, "a :root block").toBeGreaterThanOrEqual(0);
	const body = css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, "");
	const vars = new Map<string, string>();
	for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars.set(m[1], m[2].trim());
	return vars;
}

/** WCAG 2.x relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
	const m = /^#([0-9a-f]{6})$/i.exec(hex);
	if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
	const [r, g, b] = [0, 2, 4].map((i) => {
		const c = Number.parseInt(m[1].slice(i, i + 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two #rrggbb colours (1 to 21). */
function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

const BACKGROUNDS = ["--bg", "--bg-elev", "--bg-elev2"] as const;
const AA = 4.5;

const palettes = [
	{ name: "default dark (web/src/styles.css)", vars: rootVars(read("web/src/styles.css")), old: "#6b7284" },
	{ name: "White (themes/white.css)", vars: rootVars(read("themes/white.css")), old: "#818b98" },
];

describe("faint-contrast: --text-faint is readable text", () => {
	it("the WCAG formula matches known ratios (white on black 21, the old greys under 4.5)", () => {
		expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 5);
		expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
		// The guard would catch the old values: both fail on every background of their palette.
		for (const p of palettes)
			for (const bg of BACKGROUNDS) expect(contrast(p.old, p.vars.get(bg) ?? "")).toBeLessThan(AA);
	});

	for (const p of palettes) {
		it(`${p.name}: faint reaches ${AA}:1 on --bg, --bg-elev and --bg-elev2`, () => {
			const faint = p.vars.get("--text-faint") ?? "";
			for (const bg of BACKGROUNDS) {
				const ratio = contrast(faint, p.vars.get(bg) ?? "");
				expect(ratio, `${faint} on ${bg} ${p.vars.get(bg)}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
			}
		});

		it(`${p.name}: faint stays fainter than --text-dim on each background`, () => {
			const faint = p.vars.get("--text-faint") ?? "";
			const dim = p.vars.get("--text-dim") ?? "";
			for (const bg of BACKGROUNDS) {
				const back = p.vars.get(bg) ?? "";
				expect(contrast(dim, back), `dim ${dim} vs faint ${faint} on ${bg}`).toBeGreaterThan(contrast(faint, back));
			}
		});

		it(`${p.name}: disabled controls keep the old grey on --text-disabled`, () => {
			expect(p.vars.get("--text-disabled")).toBe(p.old);
		});
	}

	it("Translucent and Transparent copy the default faint grey (not the old failing one)", () => {
		const faint = palettes[0].vars.get("--text-faint");
		for (const file of ["themes/translucent.css", "themes/transparent.css"]) {
			const vars = rootVars(read(file));
			expect(vars.get("--text-faint"), file).toBe(faint);
			expect(vars.get("--text-disabled"), file).toBe(palettes[0].old);
		}
	});
});
