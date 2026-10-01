import { beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { MarkdownBody, loadMarkdownExtras, mayHaveMath } from "../../web/src/components/Markdown.js";
import { looksLikeMath } from "../../web/src/components/md-adaptive-math.js";
import { LanguageProvider } from "../../web/src/i18n.js";

/**
 * adaptive-math: prices read as text, real formulas render. Each case renders a reply through the
 * chat's markdown pipeline (KaTeX loaded) and says exactly which TeX sources come out as math.
 */
beforeAll(() => loadMarkdownExtras());

// Code blocks bring a copy button (useT), hence the LanguageProvider.
function render(text: string, hardBreaks = false): string {
	return renderToStaticMarkup(createElement(LanguageProvider, null, createElement(MarkdownBody, { text, hardBreaks })));
}

function unescape(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/&amp;/g, "&");
}

/** Every formula KaTeX drew, as its TeX source; display formulas are marked "display: ". */
function formulas(html: string): string[] {
	const out: string[] = [];
	for (const chunk of html.split("<math").slice(1)) {
		const display = /^[^>]*display="block"/.test(chunk);
		const tex = /<annotation encoding="application\/x-tex">([\s\S]*?)<\/annotation>/.exec(chunk)?.[1] ?? "?";
		out.push((display ? "display: " : "") + unescape(tex));
	}
	return out;
}

/** The text a reader sees (tags dropped, KaTeX's hidden MathML too). */
function textOf(html: string): string {
	return unescape(html.replace(/<span class="katex-mathml">[\s\S]*?<\/span>/g, "").replace(/<[^>]+>/g, ""));
}

function mathOf(text: string, hardBreaks = false): string[] {
	return formulas(render(text, hardBreaks));
}

// The owner's screenshot: rollcall chat 2026-09-22, the AVGO reply, word for word.
const AVGO_REPLY =
	"No, I didn't add them together. Net per day = the calls' time value spread over the days left, minus margin. Theta isn't added in; it's shown separately for comparison only.\n\nThat's on purpose, because the \"$4 a day\" in your example and theta come from the same pool of money. Adding them would count it twice.\n\nTake AVGO, where your $230 call is deep in the money:\n- **Now:** the stock is $353.55 and the call is $166.82, so the position is worth $186.73 a share.\n- **At expiry, if the price holds:** the shares go at $230.\n- **The gain:** $43.27 a share, $4,327 in all. That is exactly the call's time value: its $166.82 price minus the $123.55 it is in the money.\n\nThe in-the-money part stays the same if the price holds, so the whole gain is that time value. Spread over 807 days, it's **$5.36 a day**.\n\nTheta ($4.67 a day today) measures how fast that same $4,327 is wearing off right now. If I added both, you'd get $10.03 a day. Over 807 days that would claim about $8,100, but only $4,327 can actually come in.\n\nSo the net per day of **$85.49** is the $101.85 a day of time value coming in, minus $16.37 of margin.";

describe("adaptive-math: prices stay text", () => {
	it("the AVGO reply has no formula, its text reads as written and its bold is intact", () => {
		const html = render(AVGO_REPLY);
		expect(formulas(html)).toEqual([]);
		expect(html).not.toContain("katex");
		const text = textOf(html);
		expect(text).toContain(
			"Now: the stock is $353.55 and the call is $166.82, so the position is worth $186.73 a share.",
		);
		expect(text).toContain("The gain: $43.27 a share, $4,327 in all.");
		expect(text).toContain("its $166.82 price minus the $123.55 it is in the money.");
		expect(text).toContain("Theta ($4.67 a day today) measures how fast that same $4,327 is wearing off right now.");
		expect(text).toContain(
			"So the net per day of $85.49 is the $101.85 a day of time value coming in, minus $16.37 of margin.",
		);
		expect(html).toContain("<strong>Now:</strong> the stock is $353.55 and the call is $166.82");
		expect(html).toContain("<strong>$5.36 a day</strong>");
		expect(html).toContain("<strong>$85.49</strong> is the $101.85 a day");
	});

	const prices: Array<[string, string]> = [
		["$353.55 and the call is $166.82", "$353.55 and the call is $166.82"],
		["**$85.49** is the $101.85 a day", "$85.49 is the $101.85 a day"],
		["$1,200.50", "$1,200.50"],
		["from $2bn to at least $4bn", "from $2bn to at least $4bn"],
		["$5M", "$5M"],
		["$100-$200", "$100-$200"],
		["$5/$10", "$5/$10"],
		["costs $5 and $10", "costs $5 and $10"],
		["$5k–$10k a year", "$5k–$10k a year"],
		["$1M+$2M", "$1M+$2M"],
		["($5) or ($10)", "($5) or ($10)"],
		["$0.50/$1.00 per share", "$0.50/$1.00 per share"],
		["US$5 or A$ 7, HK$ 3", "US$5 or A$ 7, HK$ 3"],
		["$5 a month, $50 a year", "$5 a month, $50 a year"],
		["$5 x 3 = $15", "$5 x 3 = $15"],
		["set $PATH and $HOME, then $a=$b and $a,$b", "set $PATH and $HOME, then $a=$b and $a,$b"],
		["$5$ is a bare number, $this is words$", "$5$ is a bare number, $this is words$"],
		["\\$5 and \\$10", "$5 and $10"],
		["\\$x^2$ is escaped", "$x^2$ is escaped"],
	];
	for (const [input, shown] of prices) {
		it(`no formula in ${JSON.stringify(input)}`, () => {
			const html = render(input);
			expect(formulas(html)).toEqual([]);
			expect(textOf(html).trim()).toBe(shown);
		});
	}

	it("a table of prices stays text", () => {
		const html = render("| Item | Cost |\n| --- | --- |\n| call | $166.82 |\n| stock | $353.55 |");
		expect(formulas(html)).toEqual([]);
		expect(html).toContain("<td>$166.82</td>");
	});
});

describe("adaptive-math: real formulas render", () => {
	const cases: Array<[string, string[]]> = [
		["$x^2$", ["x^2"]],
		["$\\frac{a}{b}$", ["\\frac{a}{b}"]],
		["$a_i$", ["a_i"]],
		["the variable $x$ grows", ["x"]],
		["$2x + 1$", ["2x + 1"]],
		["$E = mc^2$", ["E = mc^2"]],
		["$\\alpha$ and $\\beta$", ["\\alpha", "\\beta"]],
		["the $n$th term", ["n"]],
		["charge $H^+$", ["H^+"]],
		["inline $$x^2$$ in a sentence", ["x^2"]],
		["$$x^2$$", ["display: x^2"]],
		["$$\n\\int_0^1 x\\,dx\n$$", ["display: \\int_0^1 x\\,dx"]],
		["ChatGPT inline \\(x^2 + y^2\\) here", ["x^2 + y^2"]],
		["\\[x^2\\]", ["display: x^2"]],
		["\\[\nx = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}\n\\]", ["display: x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}"]],
		["so \\( \\frac{1}{2} \\) of it", ["\\frac{1}{2}"]],
		["\\( 42 \\)", ["42"]],
		[
			"the matrix \\[ \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix} \\] inline",
			["display: \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}"],
		],
		["> $$\n> x^2\n> $$", ["display: x^2"]],
		["- $$\n  x^2\n  $$", ["display: x^2"]],
	];
	for (const [input, expected] of cases) {
		it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
			const html = render(input);
			expect(formulas(html)).toEqual(expected);
			expect(html).not.toContain("katex-error");
		});
	}

	it("a price next to a real formula in the same sentence: only the formula is math", () => {
		const html = render("It costs $5 and $x^2$ grows, **$85.49** a day.");
		expect(formulas(html)).toEqual(["x^2"]);
		expect(textOf(html)).toContain("It costs $5 and ");
		expect(html).toContain("<strong>$85.49</strong> a day.");
	});

	it("user bubbles (hard line breaks) use the same rules", () => {
		const html = render("it costs $5\nand $x^2$ is a formula\nand $10 too", true);
		expect(formulas(html)).toEqual(["x^2"]);
		expect(html).toContain("<br/>");
		expect(textOf(html)).toContain("it costs $5");
		expect(textOf(html)).toContain("and $10 too");
	});
});

describe("adaptive-math: code, escapes and odd spans", () => {
	const cases: Array<[string, string[]]> = [
		["`$x^2$` in code", []],
		["```\n$x^2$ and \\(y\\)\n```", []],
		["`\\(x\\)` in code", []],
		["$ x$ (space after the opening)", []],
		["$x $ (space before the closing)", []],
		["$x$5 (a digit after the closing)", []],
		["$x\n$ (two lines)", []],
		["${a$ (open brace)", []],
		["$a}$ (stray brace)", []],
		["$a `b` c$", []],
		["\\(\\) empty", []],
		["\\[ \\] empty", []],
	];
	for (const [input, expected] of cases) {
		it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
			expect(mathOf(input)).toEqual(expected);
		});
	}

	it("code spans keep their dollars", () => {
		expect(render("`$x^2$` in code")).toContain("<code>$x^2$</code>");
	});
});

describe("adaptive-math: streaming (a formula that hasn't closed yet stays text)", () => {
	const growing: Array<[string, string[]]> = [
		["the area is $x^", []],
		["the area is $x^2", []],
		["the area is $x^2$", ["x^2"]],
		["inline \\(x^2", []],
		["inline \\(x^2\\)", ["x^2"]],
		["\\[\nx = \\frac{1}{2}", []],
		["\\[\nx = \\frac{1}{2}\n\\]", ["display: x = \\frac{1}{2}"]],
		["$$\nx^2", []],
		["$$\nx^2\n$$", ["display: x^2"]],
		["> $$\n> x^2", []],
		["inline $$x^2", []],
	];
	for (const [input, expected] of growing) {
		it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
			expect(mathOf(input)).toEqual(expected);
		});
	}

	it("an open $$ block shows its text instead of swallowing the rest", () => {
		const text = textOf(render("Here:\n\n$$\nx^2 + **bold**"));
		expect(text).toContain("$$");
		expect(text).toContain("x^2 + **bold**");
	});
});

describe("adaptive-math: helpers", () => {
	it("mayHaveMath also sees ChatGPT's \\( and \\[", () => {
		expect(mayHaveMath("costs $5")).toBe(true);
		expect(mayHaveMath("so \\(x\\)")).toBe(true);
		expect(mayHaveMath("so \\[x\\]")).toBe(true);
		expect(mayHaveMath("plain (text) [here]")).toBe(false);
	});

	it("looksLikeMath: a TeX command, a script, braces, an equation or a one-letter variable", () => {
		for (const yes of ["x", "\\alpha", "x^2", "a_i", "{a}", "E = mc^2", "2x + 1", "f(x)", "H^+", "α"]) {
			expect(looksLikeMath(yes), yes).toBe(true);
		}
		for (const no of ["5", "353.55 and the call is ", "this is words", "PATH", "a=", "a,", "1,200.50", "5M"]) {
			expect(looksLikeMath(no), no).toBe(false);
		}
	});
});
