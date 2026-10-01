/**
 * adaptive-math: decides, dollar by dollar, what is a price and what is a formula.
 *
 * remark-math's default treats any text between two `$` signs as TeX, so a reply such as
 * "$353.55 and the call is $166.82" was drawn as one slanted formula with the spaces gone (and
 * the bold after it broke). Chat replies hold thousands of dollar amounts for every real
 * formula, so a single `$` now has to earn its formula:
 *
 * - remark-math keeps running with `singleDollarTextMath: false`: it still reads `$$…$$`, both
 *   inline and as a block on lines of its own.
 * - A `$…$` span is a formula only when it passes Pandoc's rule (no space just inside either
 *   `$`, the closing `$` not followed by a digit), stays on one line, holds no backtick, has
 *   balanced braces, and its inside looks like math (a TeX command, `^`, `_`, braces, an `=`
 *   with something on both sides, or a single-letter variable). The opening `$` can't follow
 *   a letter or digit either ("US$5", "A$ 7" are money). Anything else stays plain text.
 * - `\(…\)` (inline) and `\[…\]` (display) are formulas, as ChatGPT writes them. They are read
 *   here, before markdown's backslash escapes would eat the brackets.
 * - `\$` stays a literal dollar (markdown's own escape).
 *
 * It is a micromark extension rather than a rewrite of the text, so code spans, code blocks and
 * links are left alone by construction, and a rejected span is untouched text. Only the display
 * changes: saved chats and what the copy buttons copy keep the original text.
 *
 * The tree pass after parsing does two things: a `$$` block that hasn't closed yet (a reply still
 * streaming, or a stray `$$`) shows as its text instead of swallowing the rest as a formula, and a
 * paragraph that is nothing but one `$$…$$` or `\[…\]` becomes a display block.
 */
import type { Code, Construct, Effects, Extension, State, TokenizeContext } from "micromark-util-types";
import type { CompileContext, Extension as FromMarkdownExtension, Token } from "mdast-util-from-markdown";
import type { Root } from "mdast";
import type { Plugin } from "unified";

declare module "micromark-util-types" {
	interface TokenTypeMap {
		adaptiveMath: "adaptiveMath";
		adaptiveMathMarker: "adaptiveMathMarker";
		adaptiveMathData: "adaptiveMathData";
	}
}

// micromark character codes (micromark-util-symbol), spelled out so this file needs no runtime
// import beyond what remark-math already brings.
const TAB = -2;
const VIRTUAL_SPACE = -1;
const SPACE = 32;
const DOLLAR = 36;
const LEFT_PAREN = 40;
const RIGHT_PAREN = 41;
const LEFT_BRACKET = 91;
const BACKSLASH = 92;
const RIGHT_BRACKET = 93;
const BACKTICK = 96;
const LEFT_BRACE = 123;
const RIGHT_BRACE = 125;

function isLineEnding(code: Code): boolean {
	return code !== null && code < TAB;
}
function isSpace(code: Code): boolean {
	return code === TAB || code === VIRTUAL_SPACE || code === SPACE;
}
function isDigit(code: Code): boolean {
	return code !== null && code >= 48 && code <= 57;
}
function isAsciiAlphanumeric(code: Code): boolean {
	return code !== null && ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122));
}
function charOf(code: number): string {
	if (code === TAB) return "\t";
	if (code === VIRTUAL_SPACE) return " ";
	return String.fromCharCode(code);
}

const LETTER = "A-Za-z\\u0370-\\u03FF";
const TEX_COMMAND = /\\(?:[A-Za-z]+|[,;:!{}|%#&_ ])/;
const SCRIPT_OR_GROUP = /[\^_{}]/;
const EQUATION = /\S\s*=\s*\S/;
const SINGLE_LETTER = new RegExp(`(?:^|[^${LETTER}])[${LETTER}](?![${LETTER}])`);
// "$a=$b", "$a,$b" (PHP, shell): a formula doesn't end on an operator, unless it is a script ($H^+$).
const DANGLING_OPERATOR = /(?<![\^_])[=+\-*/,;:&|]$/;
// A price: a number with commas, a decimal point, or a K/M/B/bn/k suffix ("5M" is money, "2x" isn't).
const PRICE = /^\d[\d,]*(?:\.\d+)?\s*(?:[kKMBT]|bn|mn|tn)?$/;

/**
 * Does the inside of a `$…$` span look like a formula? A bare number, or words, don't:
 * "$5$" and "$this$" stay text, "$x$", "$2x + 1$", "$a_i$", "$\frac{a}{b}$" and "$E = mc^2$" are formulas.
 */
export function looksLikeMath(inner: string): boolean {
	if (DANGLING_OPERATOR.test(inner) || PRICE.test(inner)) return false;
	return TEX_COMMAND.test(inner) || SCRIPT_OR_GROUP.test(inner) || EQUATION.test(inner) || SINGLE_LETTER.test(inner);
}

/** `$…$`: a formula only when every check holds; a failed check gives the whole span up (`nok`). */
function tokenizeDollar(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
	// micromark only asks `previous` whether ANY `$` construct may start here (remark-math's may),
	// then tries them all, so the check is made again here (tokenize runs at the `$` itself).
	const allowed = previousDollar.call(this, this.previous);
	let inner = "";
	let depth = 0;
	let last: Code = null;
	return start;

	function start(code: Code): State | undefined {
		if (!allowed) return nok(code);
		effects.enter("adaptiveMath");
		effects.enter("adaptiveMathMarker");
		effects.consume(code);
		effects.exit("adaptiveMathMarker");
		return open;
	}

	function open(code: Code): State | undefined {
		// "$ 5", "$$" (remark-math's), "$`": not an opening.
		if (code === null || code === DOLLAR || code === BACKTICK || isSpace(code) || isLineEnding(code)) return nok(code);
		effects.enter("adaptiveMathData");
		return inside(code);
	}

	function inside(code: Code): State | undefined {
		if (code === null || code === BACKTICK || isLineEnding(code)) return nok(code);
		if (code === DOLLAR) {
			// The first `$` decides: "$5 and $10" can't stretch on to a later dollar.
			if (isSpace(last) || depth !== 0 || !looksLikeMath(inner)) return nok(code);
			effects.exit("adaptiveMathData");
			effects.enter("adaptiveMathMarker");
			effects.consume(code);
			effects.exit("adaptiveMathMarker");
			return after;
		}
		if (code === BACKSLASH) {
			take(code);
			return escaped;
		}
		if (code === LEFT_BRACE) depth++;
		else if (code === RIGHT_BRACE) {
			if (depth === 0) return nok(code);
			depth--;
		}
		take(code);
		return inside;
	}

	// `\x` is one unit inside the span: `\$` doesn't close it, `\{` doesn't count as a brace.
	function escaped(code: Code): State | undefined {
		if (code === null || isLineEnding(code)) return nok(code);
		take(code);
		return inside;
	}

	function take(code: number): void {
		inner += charOf(code);
		last = code;
		effects.consume(code);
	}

	// "$100-$200": a closing `$` followed by a digit is the next price.
	function after(code: Code): State | undefined {
		if (code === DOLLAR || isDigit(code)) return nok(code);
		effects.exit("adaptiveMath");
		return ok(code);
	}
}

/** A `$` opens unless it follows an unescaped `$` (that's `$$`) or a letter or digit ("US$5"). */
function previousDollar(this: TokenizeContext, code: Code): boolean {
	if (code === DOLLAR) return this.events[this.events.length - 1]?.[1].type === "characterEscape";
	return !isAsciiAlphanumeric(code);
}

function closer(char: number): Construct {
	return {
		partial: true,
		tokenize(effects, ok, nok) {
			return start;
			function start(code: Code): State | undefined {
				effects.enter("adaptiveMathMarker");
				effects.consume(code);
				return bracket;
			}
			function bracket(code: Code): State | undefined {
				if (code !== char) return nok(code);
				effects.consume(code);
				effects.exit("adaptiveMathMarker");
				return ok;
			}
		},
	};
}
const closeParen = closer(RIGHT_PAREN);
const closeBracket = closer(RIGHT_BRACKET);

/** `\(…\)` and `\[…\]`: always formulas once closed (and not empty); may run over several lines. */
function tokenizeBackslash(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
	let close: Construct = closeParen;
	let inData = false;
	let hasContent = false;
	return start;

	function start(code: Code): State | undefined {
		effects.enter("adaptiveMath");
		effects.enter("adaptiveMathMarker");
		effects.consume(code);
		return bracket;
	}

	function bracket(code: Code): State | undefined {
		if (code === LEFT_PAREN) close = closeParen;
		else if (code === LEFT_BRACKET) close = closeBracket;
		else return nok(code);
		effects.consume(code);
		effects.exit("adaptiveMathMarker");
		return inside;
	}

	function inside(code: Code): State | undefined {
		// Not closed (yet): the text stays as written, so a reply still streaming doesn't flicker.
		if (code === null || code === BACKTICK) return nok(code);
		if (isLineEnding(code)) {
			if (inData) {
				effects.exit("adaptiveMathData");
				inData = false;
			}
			effects.enter("lineEnding");
			effects.consume(code);
			effects.exit("lineEnding");
			return inside;
		}
		if (code === BACKSLASH) return effects.check(close, atClose, escapePair)(code);
		take(code);
		return inside;
	}

	function escapePair(code: Code): State | undefined {
		take(code as number);
		return escaped;
	}

	// `\\)` is a TeX line break followed by `)`, not the end.
	function escaped(code: Code): State | undefined {
		if (code === null) return nok(code);
		if (isLineEnding(code)) return inside(code);
		take(code);
		return inside;
	}

	function take(code: number): void {
		if (!inData) {
			effects.enter("adaptiveMathData");
			inData = true;
		}
		if (!isSpace(code)) hasContent = true;
		effects.consume(code);
	}

	function atClose(code: Code): State | undefined {
		if (!hasContent) return nok(code);
		if (inData) {
			effects.exit("adaptiveMathData");
			inData = false;
		}
		effects.enter("adaptiveMathMarker");
		effects.consume(code);
		return closeChar;
	}

	function closeChar(code: Code): State | undefined {
		effects.consume(code);
		effects.exit("adaptiveMathMarker");
		effects.exit("adaptiveMath");
		return ok;
	}
}

/** The micromark syntax: tried before remark-math's `$` and before markdown's `\` escapes. */
export const adaptiveMathSyntax: Extension = {
	text: {
		[DOLLAR]: { name: "adaptiveMathDollar", tokenize: tokenizeDollar, previous: previousDollar },
		[BACKSLASH]: { name: "adaptiveMathBackslash", tokenize: tokenizeBackslash },
	},
};

type HastText = { type: "text"; value: string };
type MathData = { hName: string; hProperties?: { className: string[] }; hChildren: unknown[] };
type InlineMathNode = { type: "inlineMath"; value: string; data: MathData };

function enterAdaptiveMath(this: CompileContext, token: Token): undefined {
	const display = this.sliceSerialize(token).startsWith("\\[");
	const node: InlineMathNode = {
		type: "inlineMath",
		value: "",
		data: {
			hName: "code",
			hProperties: { className: ["language-math", display ? "math-display" : "math-inline"] },
			hChildren: [],
		},
	};
	this.enter(node as never, token);
	this.buffer();
}

function exitAdaptiveMath(this: CompileContext, token: Token): undefined {
	const value = this.resume().trim();
	const node = this.stack[this.stack.length - 1] as unknown as InlineMathNode;
	this.exit(token);
	node.value = value;
	node.data.hChildren.push({ type: "text", value } satisfies HastText);
}

function exitAdaptiveMathData(this: CompileContext, token: Token): undefined {
	this.config.enter.data.call(this, token);
	this.config.exit.data.call(this, token);
}

/** Turns the tokens above into the same `inlineMath` nodes remark-math makes (KaTeX draws both). */
export const adaptiveMathFromMarkdown: FromMarkdownExtension = {
	enter: { adaptiveMath: enterAdaptiveMath },
	exit: { adaptiveMath: exitAdaptiveMath, adaptiveMathData: exitAdaptiveMathData },
};

type AnyNode = {
	type: string;
	value?: string;
	meta?: string | null;
	children?: AnyNode[];
	data?: MathData;
	position?: { start: { offset?: number }; end: { offset?: number } };
};

function sourceOf(node: AnyNode, source: string): string | undefined {
	const start = node.position?.start.offset;
	const end = node.position?.end.offset;
	return start === undefined || end === undefined ? undefined : source.slice(start, end);
}

// The closing fence of a `$$` block, after any blockquote or list indent in front of it.
const CLOSING_FENCE = /^[\t >]*\${2,}[\t ]*$/;

function displayBlock(value: string, position: AnyNode["position"]): AnyNode {
	return {
		type: "math",
		meta: null,
		value,
		position,
		data: {
			hName: "pre",
			hChildren: [
				{
					type: "element",
					tagName: "code",
					properties: { className: ["language-math", "math-display"] },
					children: [{ type: "text", value }],
				},
			],
		},
	};
}

function isDisplayInline(node: AnyNode, source: string): boolean {
	if (node.type !== "inlineMath") return false;
	if (node.data?.hProperties?.className.includes("math-display")) return true;
	return sourceOf(node, source)?.startsWith("$$") ?? false;
}

function tidy(parent: AnyNode, source: string): void {
	const children = parent.children;
	if (!children) return;
	for (let i = 0; i < children.length; i++) {
		const node = children[i];
		if (node.type === "math") {
			const text = sourceOf(node, source);
			const lines = text?.split(/\r?\n|\r/) ?? [];
			if (text !== undefined && (lines.length < 2 || !CLOSING_FENCE.test(lines[lines.length - 1]))) {
				// `$$` that never closed: its text, not a formula that swallows the rest of the reply.
				const body = lines[0] + (node.value ? "\n" + node.value : "");
				children[i] = { type: "paragraph", children: [{ type: "text", value: body }], position: node.position };
			}
			continue;
		}
		if (node.type === "paragraph" && node.children) {
			const meaningful = node.children.filter((c) => !(c.type === "text" && !c.value?.trim()));
			if (meaningful.length === 1 && isDisplayInline(meaningful[0], source)) {
				children[i] = displayBlock(meaningful[0].value ?? "", node.position);
				continue;
			}
		}
		tidy(node, source);
	}
}

/**
 * The remark plugin: adds the syntax above and the tree pass. Runs next to
 * `[remarkMath, { singleDollarTextMath: false }]`, which owns `$$`.
 */
export const remarkAdaptiveMath: Plugin<[], Root> = function remarkAdaptiveMath() {
	const data = this.data() as {
		micromarkExtensions?: Extension[];
		fromMarkdownExtensions?: Array<FromMarkdownExtension | FromMarkdownExtension[]>;
	};
	(data.micromarkExtensions ??= []).push(adaptiveMathSyntax);
	(data.fromMarkdownExtensions ??= []).push(adaptiveMathFromMarkdown);
	return (tree, file) => {
		tidy(tree as unknown as AnyNode, String(file.value ?? ""));
	};
};
