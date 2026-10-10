import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * accent-contrast (Design rm-2c447ce9, Ops #97): the violet and amber used AS TEXT reach WCAG 2.2 AA 1.4.3, 4.5:1,
 * as tokens by role, without changing any other palette.
 *  - --accent-text: violet text. Default dark (and Purple Haze, Translucent, Transparent) #a78bfa, the link violet;
 *    --accent #8b5cf6 was 3.4-4.6:1 as text (3.36 on the Queue tab's needs-you row).
 *  - --accent-fill / --accent-fill-hover: the fill under white text, #7c3aed / #6d28d9 (white on #8b5cf6: 4.23).
 *  - --amber-fg: amber text. White #92400e (#d97706 was 3.19 on white, 2.79 on the needs-you row #faeee1);
 *    everywhere else var(--amber). Not --amber-text, which is another (lighter) amber.
 *  - --accent itself stays for what isn't text (focus rings, borders, switch tracks): 3:1 there (1.4.11).
 * Every palette with its own accent keeps today's look: text and fills = its accent, the hover = its accent as
 * the old `filter: brightness(1.12)` drew it, amber text = its amber.
 * The Queue tab is measured in the browser by tests/faint-contrast-test.mjs, the main views by
 * tests/accent-contrast-test.mjs.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** The custom properties of every `:root { ... }` block of a file, later blocks winning. */
function rootVars(css: string): Map<string, string> {
	const vars = new Map<string, string>();
	const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
	for (const block of clean.matchAll(/:root\s*\{([^}]*)\}/g))
		for (const m of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars.set(m[1], m[2].trim());
	return vars;
}

const hex = (h: string) => {
	const m = /^#([0-9a-f]{6})$/i.exec(h);
	if (!m) throw new Error(`not a #rrggbb colour: ${h}`);
	return [0, 2, 4].map((i) => Number.parseInt(m[1].slice(i, i + 2), 16));
};
const toHex = (rgb: number[]) => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
/** `color-mix(in srgb, fg p, bg)` / fg at alpha p over bg. */
const mix = (fg: string, bg: string, p: number) => toHex(hex(fg).map((c, i) => c * p + hex(bg)[i] * (1 - p)));
/** Chrome's `filter: brightness(1.12)`: each sRGB channel times 1.12, clamped. */
const brighten = (h: string) => toHex(hex(h).map((c) => Math.min(255, Math.round(c * 1.12))));

function luminance(h: string): number {
	const [r, g, b] = hex(h).map((c) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}
const AA = 4.5;
const NON_TEXT = 3;

const DEFAULT = rootVars(read("web/src/styles.css"));
const THEMES = readdirSync(join(ROOT, "themes"))
	.filter((f) => f.endsWith(".css"))
	.sort();
const theme = (f: string) => {
	const own = rootVars(read(`themes/${f}`));
	return new Map([...DEFAULT, ...own]);
};
/** A token's value with one level of var() resolved (--amber-fg: var(--amber)). */
const value = (vars: Map<string, string>, k: string) => {
	const v = vars.get(k) ?? "";
	const ref = /^var\((--[\w-]+)\)$/.exec(v);
	return ref ? (vars.get(ref[1]) ?? "") : v;
};

/** The dark backgrounds violet text sits on: the three surfaces, the panel (--bg-elev 62% over --bg), the white
 *  6% raised surface, the accent-soft tint (selected tabs, badges), and the Queue tab's tinted rows (needs-you:
 *  amber 12%; blocked: cyan 8%) over each surface. */
function darkBackgrounds(v: Map<string, string>) {
	const bases = ["--bg", "--bg-elev", "--bg-elev2"].map((k) => value(v, k));
	const panel = mix(value(v, "--bg-elev"), value(v, "--bg"), 0.62);
	const out: Record<string, string> = { panel, "raised (white 6% on --bg-elev)": mix("#ffffff", bases[1], 0.06) };
	for (const [i, b] of bases.entries()) {
		const name = ["--bg", "--bg-elev", "--bg-elev2"][i];
		out[name] = b;
		out[`accent-soft on ${name}`] = mix(value(v, "--accent"), b, 0.14);
		out[`needs-you row on ${name}`] = mix(value(v, "--amber"), b, 0.12);
		out[`blocked row on ${name}`] = mix(value(v, "--term-cyan"), b, 0.08);
	}
	out["needs-you row on panel"] = mix(value(v, "--amber"), panel, 0.12);
	out["blocked row on panel"] = mix(value(v, "--term-cyan"), panel, 0.08);
	return out;
}

describe("accent-contrast: the readable violet (default dark and the three themes that copy it)", () => {
	const violet = [
		["default dark (web/src/styles.css)", DEFAULT],
		["Purple Haze (themes/md-preview.css)", theme("md-preview.css")],
		["Translucent (themes/translucent.css)", theme("translucent.css")],
		["Transparent (themes/transparent.css)", theme("transparent.css")],
	] as const;

	it("the formula matches known ratios, and the old violet fails where #93 found it", () => {
		expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 5);
		expect(contrast("#ffffff", "#8b5cf6")).toBeLessThan(AA); // 4.23: white on the old fill
		expect(contrast("#8b5cf6", mix("#fbbf24", "#1a1d26", 0.12))).toBeLessThan(AA); // 3.36: needs-you row
		expect(contrast("#d97706", "#ffffff")).toBeLessThan(AA); // 3.19: White's old amber text
	});

	for (const [name, v] of violet) {
		it(`${name}: Design's values`, () => {
			expect(value(v, "--accent")).toBe("#8b5cf6");
			expect(value(v, "--accent-text")).toBe("#a78bfa");
			expect(value(v, "--accent-fill")).toBe("#7c3aed");
			expect(value(v, "--accent-fill-hover")).toBe("#6d28d9");
			expect(value(v, "--amber-fg")).toBe(value(v, "--amber"));
		});

		it(`${name}: --accent-text is 4.5:1 or more on every dark background, the tinted rows too`, () => {
			const weak = Object.entries(darkBackgrounds(v))
				.map(([bg, c]) => ({ bg, c, r: contrast(value(v, "--accent-text"), c) }))
				.filter((x) => x.r < AA);
			expect(weak, JSON.stringify(weak)).toEqual([]);
		});

		it(`${name}: white text on --accent-fill and its hover (= active) is 4.5:1 or more`, () => {
			const fill = contrast("#ffffff", value(v, "--accent-fill"));
			const hover = contrast("#ffffff", value(v, "--accent-fill-hover"));
			expect(fill).toBeGreaterThanOrEqual(AA);
			expect(hover).toBeGreaterThanOrEqual(fill); // the hover darkens: it never drops below the fill
		});

		it(`${name}: --accent (focus rings, borders, switch tracks) is 3:1 or more against the panels`, () => {
			const bgs = darkBackgrounds(v);
			for (const k of ["--bg", "--bg-elev", "--bg-elev2", "panel"])
				expect(contrast(value(v, "--accent"), bgs[k]), k).toBeGreaterThanOrEqual(NON_TEXT);
		});

		it(`${name}: dark amber text (--amber-fg) still passes on the surfaces`, () => {
			for (const k of ["--bg", "--bg-elev", "--bg-elev2"])
				expect(contrast(value(v, "--amber-fg"), value(v, k)), k).toBeGreaterThanOrEqual(AA);
		});
	}
});

describe("accent-contrast: White's amber text", () => {
	const w = theme("white.css");
	const row = mix(value(w, "--amber"), value(w, "--bg-elev"), 0.12);

	it("Design's #92400e, with --amber unchanged and the blue accent kept as it is", () => {
		expect(value(w, "--amber-fg")).toBe("#92400e");
		expect(value(w, "--amber")).toBe("#d97706");
		expect(value(w, "--accent")).toBe("#0969da");
		expect(value(w, "--accent-text")).toBe("#0969da");
		expect(value(w, "--accent-fill")).toBe("#0969da");
		expect(value(w, "--accent-fill-hover")).toBe(brighten("#0969da"));
	});

	it("is 4.5:1 or more on white, --bg-elev2 and the needs-you row (#faeee1)", () => {
		for (const bg of [value(w, "--bg"), value(w, "--bg-elev"), value(w, "--bg-elev2"), "#faeee1", row])
			expect(contrast(value(w, "--amber-fg"), bg), bg).toBeGreaterThanOrEqual(AA);
	});

	it("White's own blue: white text on its fill passes, and its text on the surfaces", () => {
		expect(contrast("#ffffff", value(w, "--accent-fill"))).toBeGreaterThanOrEqual(AA);
		for (const k of ["--bg", "--bg-elev", "--bg-elev2"])
			expect(contrast(value(w, "--accent-text"), value(w, k)), k).toBeGreaterThanOrEqual(AA);
	});
});

describe("accent-contrast: the other 24 palettes render as before", () => {
	const designs = new Set(["white.css", "md-preview.css", "translucent.css", "transparent.css"]);
	const others = THEMES.filter((f) => !designs.has(f));

	it("there are 28 themes, 24 of them left as they were", () => {
		expect(THEMES).toHaveLength(28);
		expect(others).toHaveLength(24);
	});

	for (const f of others) {
		it(`${f}: text and fills = its accent, hover = the old brightness(1.12), amber text = its amber`, () => {
			const v = theme(f);
			const own = rootVars(read(`themes/${f}`));
			const accent = own.get("--accent") ?? "";
			expect(accent, "the theme sets its own accent").toMatch(/^#[0-9a-f]{6}$/i);
			expect(value(v, "--accent-text")).toBe(accent);
			expect(value(v, "--accent-fill")).toBe(accent);
			expect(value(v, "--accent-fill-hover")).toBe(brighten(accent));
			expect(value(v, "--amber-fg")).toBe(value(v, "--amber"));
		});
	}
});

describe("accent-contrast: the rules use the tokens", () => {
	const CSS = [
		"web/src/styles.css",
		"web/src/model-management.css",
		"web/src/roles-view.css",
		"web/src/exchange-fold.css",
	];
	/** Rule bodies (selector, declarations) with comments taken out. */
	const rules = (css: string) =>
		[...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
			sel: m[1].trim(),
			body: m[2],
		}));

	for (const file of CSS) {
		it(`${file}: no text in --accent or --amber (they use --accent-text / --amber-fg)`, () => {
			const bad = rules(read(file))
				.filter((r) => /(^|[^-])color\s*:\s*var\(--(accent|amber)\s*[,)]/m.test(r.body))
				.map((r) => r.sel);
			expect(bad).toEqual([]);
		});

		it(`${file}: no white text on an --accent fill (it uses --accent-fill), and no hover filter on one`, () => {
			const bad = rules(read(file))
				.filter(
					(r) =>
						/background(-color)?\s*:\s*var\(--accent\)/.test(r.body) &&
						/(^|[^-])color\s*:\s*#fff(fff)?\b/m.test(r.body),
				)
				.map((r) => r.sel);
			expect(bad).toEqual([]);
			const filtered = rules(read(file))
				.filter((r) => /\.(btn\.primary|task-queue-toggle):hover/.test(r.sel) && /brightness/.test(r.body))
				.map((r) => r.sel);
			// Only the outlined Stop keeps the filter: there is no fill under its text.
			expect(filtered.every((s) => s.includes(".stop"))).toBe(true);
		});
	}

	it("the components' inline amber text uses --amber-fg", () => {
		for (const f of ["ToolApprovalDialog.tsx", "RollbackDialog.tsx", "ModelConfigModal.tsx"]) {
			const src = read(`web/src/components/${f}`);
			expect(src, f).not.toMatch(/color:\s*"var\(--amber[,)]/);
			expect(src, f).toMatch(/color:\s*"var\(--amber-fg/);
		}
	});

	it("the generator gives a new palette with its own accent the identity tokens", () => {
		const gen = read("make-light-theme.mjs");
		expect(gen).toMatch(/"--accent-fill-hover": \(a\) => brighten\(a\)/);
		expect(gen).toMatch(/"--amber-fg": "#92400e"/);
	});
});
