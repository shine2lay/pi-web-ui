/**
 * Telegram answers (telegram-answers patch).
 *
 * Sends you, on Telegram, everything a chat is waiting on you for: questions with their choices,
 * add-on pop-ups, permission prompts, and queued tasks that need you. Tap a button (or reply to
 * the message to type an answer) and the chat gets the answer exactly as if you had answered in
 * the browser. Whichever place answers first wins; the other one updates.
 *
 * - Reads its own bot's messages by long polling: outgoing connections only, no webhook.
 * - Only the owner's private chat counts (setting "ownerId"); everyone else is ignored.
 * - The bot token lives only in this plugin's encrypted settings; errors never show it.
 *
 * The host uses the default export; the tests use the named exports.
 */

export const PLUGIN_ID = "telegram";
export const API_BASE_DEFAULT = "https://api.telegram.org";
/** Tests (and only tests) point the plugin at a fake Telegram with this. */
export const API_BASE_ENV = "PI_WEB_TELEGRAM_API_BASE";

// Short enough that a connection that died quietly is noticed within half a minute.
const POLL_TIMEOUT_S = 25;
const POLL_FETCH_TIMEOUT_MS = 35_000;
const CALL_TIMEOUT_MS = 10_000;
/** Telegram allows 4096 characters; stay a little under. */
export const TEXT_BUDGET = 3900;
const LABEL_MAX = 60;
const MAX_OPTIONS = 90;
const RESYNC_MS = 60_000;
/** A call Telegram fumbled (a 5xx, a dropped connection, no answer in time) is tried again after these. */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

const KIND_ICON = {
	question: "\u2753",
	dialog: "\u{1F4AC}",
	approval: "\u{1F510}",
	stuck: "\u{1F4CC}",
};

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

export function escapeHtml(s) {
	return String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Cut to at most `max` characters, ending with "…" when something was cut (never half an emoji). */
export function cut(s, max) {
	const t = String(s ?? "");
	if (t.length <= max) return t;
	let end = Math.max(0, max - 1);
	if (end > 0 && /[\uD800-\uDBFF]/.test(t[end - 1])) end--;
	return `${t.slice(0, end).trimEnd()}\u2026`;
}

/** One line, at most `max` characters. */
const oneLine = (s, max) => cut(String(s ?? "").replace(/\s+/g, " ").trim(), max);

/** Like cut, at the end of a word when there's one near. */
export function cutWords(s, max) {
	const t = String(s ?? "");
	if (t.length <= max) return t;
	const space = t.lastIndexOf(" ", max - 1);
	return space > max * 0.6 ? `${t.slice(0, space).replace(/[\s,;:.\-\u2013\u2014]+$/, "")}\u2026` : cut(t, max);
}

/** How long Telegram counts our own HTML (tags don't count, entities count as one). */
export function visibleLength(html) {
	return String(html ?? "")
		.replace(/<[^>]*>/g, "")
		.replace(/&(amp|lt|gt|quot);/g, "_").length;
}

function shortPath(p) {
	const home = process.env.HOME;
	const s = String(p ?? "");
	return home && (s === home || s.startsWith(`${home}/`)) ? `~${s.slice(home.length)}` : s;
}

/** The web app link that opens one chat (`?chat=<saved chat file>`), or null. */
export function chatLink(webAppAddress, sessionFile) {
	if (!webAppAddress || !sessionFile) return null;
	try {
		const url = new URL(String(webAppAddress));
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		url.searchParams.set("chat", String(sessionFile));
		return url.toString();
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// A chat's text (markdown, and some HTML) as Telegram HTML
// ---------------------------------------------------------------------------

/** Inline code, a command or a JSON blob longer than this goes in a collapsed quote. */
export const QUOTE_OVER = 80;
/** A code block longer than this goes in a collapsed quote too. */
const PRE_MAX_CHARS = 600;
const PRE_MAX_LINES = 12;

// While a text is converted, its formatting is carried by characters from Unicode's private use
// area. Every such character is removed from the text first, so nothing in a text can pass for one.
const PRIVATE = /[\uE000-\uF8FF]/g;
const OPEN = { b: "\uE000", i: "\uE001", u: "\uE002", s: "\uE003" };
const CLOSE = { b: "\uE004", i: "\uE005", u: "\uE006", s: "\uE007" };
const LINK_END = "\uE008";
const MARKS = /[\uE000-\uE008]/g;
const MARK_OF = new Map([
	...Object.entries(OPEN).map(([tag, c]) => [c, { open: tag }]),
	...Object.entries(CLOSE).map(([tag, c]) => [c, { close: tag }]),
	[LINK_END, { close: "a" }],
]);
/** REF + n + REF_END stands for the n-th saved piece: code, a code block, a link, a URL, an escaped character. */
const REF = "\uE00A";
const REF_END = "\uE00B";
const REF_RE = /\uE00A(\d+)\uE00B/g;
const TOKEN_RE = /\uE00A(\d+)\uE00B|[\uE000-\uE008]/g;

const ENTITIES = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: "\u00A0",
	ndash: "\u2013",
	mdash: "\u2014",
	hellip: "\u2026",
	lsquo: "\u2018",
	rsquo: "\u2019",
	ldquo: "\u201C",
	rdquo: "\u201D",
	laquo: "\u00AB",
	raquo: "\u00BB",
	bull: "\u2022",
	middot: "\u00B7",
	times: "\u00D7",
	larr: "\u2190",
	rarr: "\u2192",
	copy: "\u00A9",
	reg: "\u00AE",
	trade: "\u2122",
	deg: "\u00B0",
	euro: "\u20AC",
};

/** &amp;, &#39;, &mdash;\u2026 as the characters they stand for (unknown ones stay as they are). */
export function decodeEntities(s) {
	return String(s ?? "").replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g, (all, e) => {
		if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? all;
		const cp = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
		const ok =
			(cp === 9 || cp === 10 || (cp >= 32 && (cp < 0x7f || cp >= 0xa0))) &&
			cp <= 0x10ffff &&
			!(cp >= 0xd800 && cp <= 0xdfff) &&
			!(cp >= 0xe000 && cp <= 0xf8ff);
		return ok ? String.fromCodePoint(cp) : all;
	});
}

/** A link Telegram opens: web, tg: or mailto: (anything else is left out, its text kept). */
function safeHref(href) {
	const h = decodeEntities(href ?? "").trim();
	return h.length <= 2048 && /^(https?:\/\/|tg:\/\/|mailto:)[^\s<>"]+$/i.test(h) ? h : "";
}

const restoreSrc = (s, saved) => String(s).replace(REF_RE, (_, n) => saved[Number(n)]?.src ?? "");
const restorePlain = (s, saved) =>
	String(s)
		.replace(REF_RE, (_, n) => {
			const item = saved[Number(n)];
			return item && item.kind !== "link" ? item.text : "";
		})
		.replace(MARKS, "");

/** ``` and ~~~ blocks, saved whole (a block that never closes runs to the end). */
function saveFences(t, keep) {
	const lines = t.split("\n");
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
		if (!m || (m[1][0] === "`" && m[2].includes("`"))) {
			out.push(lines[i]);
			continue;
		}
		const close = new RegExp(`^ {0,3}${m[1][0]}{${m[1].length},}\\s*$`);
		let j = i + 1;
		while (j < lines.length && !close.test(lines[j])) j++;
		const text = lines.slice(i + 1, j).join("\n");
		out.push(keep({ kind: "pre", text, src: lines.slice(i, j + 1).join("\n") }));
		i = j;
	}
	return out.join("\n");
}

/** `code` on one line (a run of n backticks closes with n backticks). */
function saveCodeSpans(t, keep, saved) {
	return t.replace(/(`+)([^`\n]|[^`\n][^\n]*?[^`\n])\1(?!`)/g, (src, _ticks, body) => {
		const inner = /^ .*\S.* $/.test(body) ? body.slice(1, -1) : body;
		return keep({ kind: "code", text: restoreSrc(inner, saved), src });
	});
}

/** HTML <pre> and <code>: their text, exactly. */
function saveHtmlLiterals(t, keep, saved) {
	const inner = (s) => decodeEntities(restoreSrc(s, saved).replace(/<\/?[a-zA-Z][^<>]*>/g, ""));
	return t
		.replace(
			/<pre\b[^<>]*>([\s\S]*?)<\/pre\s*>/gi,
			(src, body) => `\n${keep({ kind: "pre", text: inner(body).replace(/^\n+|\n+$/g, ""), src })}\n`,
		)
		.replace(/<code\b[^<>]*>([\s\S]*?)<\/code\s*>/gi, (src, body) => keep({ kind: "code", text: inner(body), src }));
}

// The HTML a chat may write. Any other <name> ("<sha>", "<folder>") is just text.
const HTML_TAGS = new Set(
	(
		"a b blockquote br code del div em h1 h2 h3 h4 h5 h6 hr i img li ol p pre s span strong table tbody td th " +
		"thead tr u ul"
	).split(" "),
);
// These could be a placeholder too ("<label>", "<time>"): they count as HTML only with attributes,
// or when the text also closes them.
const MAYBE_HTML_TAGS = new Set(
	(
		"abbr address article aside big body button caption center cite col colgroup dd details dfn dl dt figcaption " +
		"figure font footer form head header html iframe input ins kbd label main mark nav noscript option q samp " +
		"script section select small strike style sub summary sup svg tfoot textarea time title tt var wbr"
	).split(" "),
);
const HTML_TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[\s/][^<>]*)?)>/g;

function attrOf(attrs, name) {
	const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs ?? "");
	return m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
}

/** HTML tags become formatting marks, line breaks and list items; any other tag is dropped, its text kept. */
function htmlToMarks(t, keep) {
	const lists = [];
	const src = t.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
	const closed = new Set([...src.matchAll(/<\/([a-zA-Z][a-zA-Z0-9]*)\s*>/g)].map((m) => m[1].toLowerCase()));
	const opened = new Set([...src.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)[\s/>]/g)].map((m) => m[1].toLowerCase()));
	const isHtml = (name, attrs) =>
		HTML_TAGS.has(name) ||
		(MAYBE_HTML_TAGS.has(name) && (/[^\s/]/.test(attrs) || (opened.has(name) && closed.has(name))));
	const out = src.replace(HTML_TAG, (all, slash, rawName, attrs) => {
		const name = rawName.toLowerCase();
		if (!isHtml(name, attrs)) return all;
		const close = slash === "/";
		switch (name) {
			case "b":
			case "strong":
				return close ? CLOSE.b : OPEN.b;
			case "i":
			case "em":
			case "cite":
			case "dfn":
			case "var":
				return close ? CLOSE.i : OPEN.i;
			case "u":
			case "ins":
				return close ? CLOSE.u : OPEN.u;
			case "s":
			case "strike":
			case "del":
				return close ? CLOSE.s : OPEN.s;
			case "a": {
				if (close) return LINK_END;
				const href = safeHref(attrOf(attrs, "href"));
				return href ? keep({ kind: "link", href, src: "" }) : "";
			}
			case "br":
				return "\n";
			case "p":
				return "\n\n";
			case "h1":
			case "h2":
			case "h3":
			case "h4":
			case "h5":
			case "h6":
				return close ? "\n\n" : "\n\n# ";
			case "ul":
			case "ol":
				if (close) lists.pop();
				else lists.push({ ordered: name === "ol", n: 0 });
				return "\n";
			case "li": {
				if (close) return "";
				const list = lists[lists.length - 1];
				const pad = "  ".repeat(Math.max(0, lists.length - 1));
				return list?.ordered ? `\n${pad}${++list.n}. ` : `\n${pad}- `;
			}
			case "hr":
				return "\n\n---\n\n";
			case "tr":
				return close ? "\n" : "\n|";
			case "td":
			case "th":
				return close ? " |" : " ";
			case "img":
				return attrOf(attrs, "alt");
			case "address":
			case "article":
			case "aside":
			case "blockquote":
			case "body":
			case "caption":
			case "center":
			case "dd":
			case "details":
			case "div":
			case "dl":
			case "dt":
			case "figcaption":
			case "figure":
			case "footer":
			case "head":
			case "header":
			case "html":
			case "main":
			case "nav":
			case "section":
			case "summary":
			case "table":
			case "tbody":
			case "tfoot":
			case "thead":
				return "\n";
			default:
				return "";
		}
	});
	return decodeEntities(out);
}

/** [text](url) links, <url> autolinks and bare URLs (which Telegram links by itself). */
function saveLinks(t, keep, saved) {
	return t
		.replace(
			/(!?)\[([^[\]\n]*)\]\(\s*<?([^\s<>()]*(?:\([^\s<>()]*\)[^\s<>()]*)*)>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g,
			(src, bang, text, url) => {
				if (bang) return text; // a picture: its description
				const href = safeHref(restorePlain(url, saved));
				if (!href) return text;
				const shown = text.trim() ? text : keep({ kind: "url", text: href, src: href });
				return `${keep({ kind: "link", href, src: "" })}${shown}${LINK_END}`;
			},
		)
		.replace(/<((?:https?|tg):\/\/[^\s<>]+|mailto:[^\s<>]+)>/gi, (src, url) => keep({ kind: "url", text: url, src }))
		.replace(/\bhttps?:\/\/[^\s<>"'`\uE000-\uF8FF]*[^\s<>"'`.,;:!?)\]}*_~\uE000-\uF8FF]/gi, (src) =>
			keep({ kind: "url", text: src, src }),
		);
}

const LETTER = "\\p{L}\\p{N}_";
const EMPHASIS = [
	[/\*\*(?=[^\s*])([^\n]*?[^\s*])\*\*/gu, "b", false],
	[new RegExp(`(^|[^${LETTER}])__(?=[^\\s_])([^\\n]*?[^\\s_])__(?![${LETTER}])`, "gu"), "b", true],
	[/~~(?=[^\s~])([^\n]*?[^\s~])~~/gu, "s", false],
	[new RegExp(`(^|[^${LETTER}*])\\*(?=[^\\s*])([^\\n]*?[^\\s*])\\*(?![${LETTER}*])`, "gu"), "i", true],
	[new RegExp(`(^|[^${LETTER}])_(?=[^\\s_])([^\\n]*?[^\\s_])_(?![${LETTER}])`, "gu"), "i", true],
];

/** **bold**, __bold__, *italic*, _italic_ and ~~struck~~ as marks (an _ inside a word stays an _). */
function emphasis(s) {
	let t = s;
	for (const [re, tag, lead] of EMPHASIS) {
		t = t.replace(re, (...m) =>
			lead ? `${m[1]}${OPEN[tag]}${m[2]}${CLOSE[tag]}` : `${OPEN[tag]}${m[1]}${CLOSE[tag]}`,
		);
	}
	return t;
}

const plainOf = (s, saved) => restorePlain(emphasis(s), saved);

/** Empty tags go, and a tag closed and opened again right away is one tag. */
function tidy(html) {
	let t = html;
	for (let prev = ""; prev !== t; ) {
		prev = t;
		t = t
			.replace(/<(b|i|u|s)><\/\1>/g, "")
			.replace(/<a href="[^"]*"><\/a>/g, "")
			.replace(/<\/(b|i|u|s)><\1>/g, "");
	}
	return t;
}

/**
 * One line of marked-up text as HTML. Tags are opened and closed in order, so they always balance:
 * a tag closed out of turn closes the ones inside it and opens them again; one never closed is
 * closed at the end (and named in `open`, to go on in the next line). No link inside a link, no
 * formatting inside code; inline code longer than `quoteOver` becomes a collapsed quote of its own
 * (`parts`: { html } and { quote }).
 */
function inlineParts(src, saved, { outer = [], quoteOver = Infinity, carry = [] } = {}) {
	const s = emphasis(src);
	const parts = [];
	const stack = [];
	let html = "";
	const active = (tag) => outer.includes(tag) || stack.some((x) => x.tag === tag && !x.skip);
	const start = (x) => {
		html += x.tag === "a" ? `<a href="${escapeHtml(x.href)}">` : `<${x.tag}>`;
	};
	const closeAll = () => {
		for (let j = stack.length - 1; j >= 0; j--) if (!stack[j].skip) html += `</${stack[j].tag}>`;
	};
	const push = (tag, href) => {
		const x = { tag, href, skip: active(tag) };
		stack.push(x);
		if (!x.skip) start(x);
	};
	const pop = (tag) => {
		let k = stack.length - 1;
		while (k >= 0 && stack[k].tag !== tag) k--;
		if (k < 0) return;
		const above = stack.splice(k);
		for (let j = above.length - 1; j >= 0; j--) if (!above[j].skip) html += `</${above[j].tag}>`;
		for (const x of above.slice(1)) push(x.tag, x.href);
	};
	const text = (t) => {
		html += escapeHtml(String(t ?? "").replace(PRIVATE, ""));
	};
	const code = (t) => {
		const c = String(t ?? "");
		if (active("a")) return text(c);
		if (c.length > quoteOver && !outer.includes("blockquote")) {
			closeAll();
			parts.push({ html });
			parts.push({ quote: c });
			html = "";
			for (const x of stack) if (!x.skip) start(x);
			return;
		}
		if (c) html += `<code>${escapeHtml(c)}</code>`;
	};
	for (const tag of carry) push(tag);
	let last = 0;
	for (const m of s.matchAll(TOKEN_RE)) {
		text(s.slice(last, m.index));
		last = m.index + m[0].length;
		if (m[1] !== undefined) {
			const item = saved[Number(m[1])];
			if (!item) continue;
			if (item.kind === "link") push("a", item.href);
			else if (item.kind === "code" || item.kind === "pre") code(item.text);
			else text(item.text);
			continue;
		}
		const mark = MARK_OF.get(m[0]);
		if (mark?.open) push(mark.open);
		else if (mark?.close) pop(mark.close);
	}
	text(s.slice(last));
	const open = stack.filter((x) => !x.skip && x.tag !== "a").map((x) => x.tag);
	closeAll();
	parts.push({ html });
	return { parts: parts.map((p) => (p.quote === undefined ? { html: tidy(p.html) } : p)), open };
}

const quoteBlock = (text) => {
	const t = String(text ?? "").replace(/^\n+|\s+$/g, "");
	return t ? `<blockquote expandable>${escapeHtml(t)}</blockquote>` : "";
};

function preBlock(text) {
	const t = String(text ?? "").replace(/^\n+|\s+$/g, "");
	if (!t) return "";
	return t.length > PRE_MAX_CHARS || t.split("\n").length > PRE_MAX_LINES ? quoteBlock(t) : `<pre>${escapeHtml(t)}</pre>`;
}

/** A command, a path or some JSON: a code block, or a collapsed quote when it's long. */
export function codeBlock(raw, quoteOver = QUOTE_OVER) {
	const t = String(raw ?? "").replace(/^\n+|\s+$/g, "");
	if (!t) return "";
	return t.length > quoteOver || t.includes("\n") ? quoteBlock(t) : `<pre>${escapeHtml(t)}</pre>`;
}

const isPipeRow = (l) => /^\s*\|.*\|\s*$/.test(l ?? "");
const isRow = (l) => (l ?? "").includes("|") && (l ?? "").trim() !== "";
const isRule = (l) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l ?? "") && (l ?? "").includes("|");

/** A markdown table, as lined-up columns in a monospace block. */
function tableBlock(rows, saved) {
	const cellsOf = (r) => {
		let s = r.trim();
		if (s.startsWith("|")) s = s.slice(1);
		if (s.endsWith("|")) s = s.slice(0, -1);
		return s.split("|").map((c) => plainOf(c.trim(), saved).replace(/\s+/g, " "));
	};
	const ruled = isRule(rows[1]);
	const cells = rows.filter((r) => !isRule(r)).map(cellsOf);
	const n = Math.max(1, ...cells.map((r) => r.length));
	const width = Array.from({ length: n }, (_, k) => Math.min(30, Math.max(1, ...cells.map((r) => (r[k] ?? "").length))));
	const lines = cells.map((r) =>
		width
			.map((w, k) => (r[k] ?? "").padEnd(w))
			.join(" | ")
			.trimEnd(),
	);
	if (ruled && lines.length > 1) lines.splice(1, 0, width.map((w) => "-".repeat(w)).join("-+-"));
	return `<pre>${escapeHtml(lines.join("\n"))}</pre>`;
}

function isJson(s) {
	try {
		const v = JSON.parse(s);
		return v !== null && typeof v === "object";
	} catch {
		return false;
	}
}

/** Line by line: code blocks, rules, headings, tables, quotes, JSON, list items, text. */
function renderBlocks(t, saved, { quoteOver, outer }) {
	const lines = t.split("\n");
	const out = [];
	let carry = [];
	const blank = () => {
		if (out.length && out[out.length - 1] !== "") out.push("");
	};
	const emit = (prefix, content, { inner = outer, wrap = (h) => h } = {}) => {
		const r = inlineParts(content, saved, { outer: inner, quoteOver, carry });
		carry = r.open;
		let first = true;
		for (const p of r.parts) {
			if (p.quote !== undefined) {
				const q = quoteBlock(p.quote);
				if (q) out.push(q);
			} else if (p.html.trim()) out.push(wrap((first ? prefix : "") + (first ? p.html : p.html.trimStart()).trimEnd()));
			first = false;
		}
	};
	const level = (indent) => Math.min(3, Math.floor(indent.replace(/\t/g, "  ").length / 2));
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].replace(/\s+$/, "");
		if (!line.replace(MARKS, "").trim()) {
			if (line) carry = inlineParts(line, saved, { outer, carry }).open;
			else blank();
			continue;
		}
		const ref = /^\s*\uE00A(\d+)\uE00B\s*$/.exec(line);
		if (ref && saved[Number(ref[1])]?.kind === "pre") {
			const b = preBlock(saved[Number(ref[1])].text);
			if (b) out.push(b);
			continue;
		}
		if (/^ {0,3}([-*_])(?:[ \t]*\1){2,}$/.test(line)) {
			out.push("\u2014\u2014\u2014");
			continue;
		}
		let m = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?$/.exec(line);
		if (m) {
			// In bold (unless the whole text will be in bold already).
			emit("", m[1], outer.includes("b") ? {} : { inner: [...outer, "b"], wrap: (h) => `<b>${h}</b>` });
			continue;
		}
		if ((isPipeRow(line) && isPipeRow(lines[i + 1])) || (isRow(line) && isRule(lines[i + 1]))) {
			let j = i;
			while (j + 1 < lines.length && isRow(lines[j + 1])) j++;
			out.push(tableBlock(lines.slice(i, j + 1), saved));
			i = j;
			continue;
		}
		if (/^ {0,3}>/.test(line) && !outer.includes("blockquote")) {
			const quoted = [];
			let j = i;
			for (; j < lines.length && /^ {0,3}>/.test(lines[j]); j++) {
				const content = lines[j].replace(/^(?: {0,3}>[ \t]?)+/, "").replace(/^([-*+])[ \t]+/, "\u2022 ");
				const r = inlineParts(content, saved, { outer: [...outer, "blockquote"], carry });
				carry = r.open;
				quoted.push(r.parts.map((p) => p.html ?? "").join(""));
			}
			const inner = quoted.join("\n").replace(/^\n+|\s+$/g, "");
			if (inner) out.push(`<blockquote>${inner}</blockquote>`);
			i = j - 1;
			continue;
		}
		if (/^\s*[[{]/.test(line)) {
			let j = i;
			while (j + 1 < lines.length && lines[j + 1].trim()) j++;
			const plain = (s) => restoreSrc(s, saved).replace(MARKS, "").trim();
			const whole = plain(lines.slice(i, j + 1).join("\n"));
			const single = plain(line);
			if (whole.length > quoteOver && isJson(whole)) {
				out.push(quoteBlock(whole));
				i = j;
				continue;
			}
			if (single.length > quoteOver && isJson(single)) {
				out.push(quoteBlock(single));
				continue;
			}
		}
		m = /^([ \t]*)([-*+\u2022])[ \t]+(.*)$/.exec(line);
		if (m) {
			const depth = level(m[1]);
			let bullet = depth ? "\u25E6" : "\u2022";
			let content = m[3];
			const box = /^\[([ xX])\][ \t]+/.exec(content);
			if (box) {
				bullet = box[1] === " " ? "\u2610" : "\u2611";
				content = content.slice(box[0].length);
			}
			emit(`${"   ".repeat(depth)}${bullet} `, content);
			continue;
		}
		m = /^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$/.exec(line);
		if (m) {
			emit(`${"   ".repeat(level(m[1]))}${m[2]}. `, m[3]);
			continue;
		}
		emit("", line);
	}
	while (out.length && out[out.length - 1] === "") out.pop();
	while (out.length && out[0] === "") out.shift();
	return out.join("\n");
}

/**
 * A chat's text as Telegram HTML: markdown (**bold**, *italic*, `code`, code blocks, [links](url),
 * lists, headings, quotes, tables) and common HTML (<b>, <em>, <br>, <p>, <ul>/<li>, <h1>\u2026) become
 * Telegram's own tags; any other tag is dropped and its text kept; everything else is escaped.
 * Long code and JSON go in collapsed quotes. The result only ever uses Telegram's tags (b, i, u, s,
 * code, pre, a, blockquote), always balanced and properly nested, whatever the input.
 * `outer`: tags the result will sit inside (not repeated inside it).
 * @param {unknown} src
 * @param {{ quoteOver?: number, outer?: string[] }} [options]
 * @returns {string}
 */
export function toTelegramHtml(src, { quoteOver = QUOTE_OVER, outer = [] } = {}) {
	const saved = [];
	const keep = (item) => `${REF}${saved.push(item) - 1}${REF_END}`;
	let t = String(src ?? "")
		.replace(/\r\n?/g, "\n")
		.replace(PRIVATE, "");
	t = saveFences(t, keep);
	t = t.replace(/\\([\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E])/g, (src, c) => keep({ kind: "char", text: c, src }));
	t = saveCodeSpans(t, keep, saved);
	t = saveHtmlLiterals(t, keep, saved);
	t = htmlToMarks(t, keep);
	t = saveLinks(t, keep, saved);
	return renderBlocks(t, saved, { quoteOver, outer });
}

/** Telegram HTML as plain text (links as "text (address)", or just their text). */
export function htmlToPlain(html, { links = true } = {}) {
	return String(html ?? "")
		.replace(/<a href="([^"]*)">([\s\S]*?)<\/a>/g, (_, href, inner) => {
			const text = inner.replace(/<[^>]*>/g, "");
			return links && text !== href ? `${text} (${href})` : text;
		})
		.replace(/<[^>]*>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, "&");
}

/** A chat's text as one line of plain text, without its markdown or HTML (for buttons and titles). */
export function plainText(src) {
	return htmlToPlain(toTelegramHtml(src, { quoteOver: Infinity }), { links: false })
		.replace(/\s+/g, " ")
		.trim();
}

// ---------------------------------------------------------------------------
// Telegram Bot API client
// ---------------------------------------------------------------------------

export class TelegramError extends Error {
	constructor(method, code, description, retryAfter = 0) {
		super(`Telegram ${method} failed${code ? ` (${code})` : ""}: ${description}`);
		this.name = "TelegramError";
		this.method = method;
		this.code = code;
		this.description = description;
		this.retryAfter = retryAfter;
	}
}

/** call(method, params, {signal, timeoutMs}) -> result. Errors never contain the token. */
export function createTelegramApi({ base = API_BASE_DEFAULT, token, fetchImpl = globalThis.fetch }) {
	const secret = String(token ?? "");
	const root = `${String(base).replace(/\/+$/, "")}/bot${secret}/`;
	const scrub = (s) =>
		secret
			? String(s ?? "")
					.split(secret)
					.join("<token>")
			: String(s ?? "");
	async function call(method, params = {}, { signal, timeoutMs = CALL_TIMEOUT_MS } = {}) {
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), timeoutMs);
		const onAbort = () => ctl.abort();
		if (signal) {
			if (signal.aborted) ctl.abort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		try {
			let res;
			try {
				res = await fetchImpl(root + method, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(params),
					signal: ctl.signal,
				});
			} catch (err) {
				const why = ctl.signal.aborted && !signal?.aborted ? "timed out" : (err?.message ?? err);
				throw new TelegramError(method, 0, scrub(why));
			}
			let data = null;
			try {
				data = await res.json();
			} catch {
				data = null;
			}
			if (!data || data.ok !== true) {
				const code = Number(data?.error_code ?? res.status) || 0;
				throw new TelegramError(
					method,
					code,
					scrub(data?.description ?? `HTTP ${res.status}`),
					Number(data?.parameters?.retry_after) || 0,
				);
			}
			return data.result;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener?.("abort", onAbort);
		}
	}
	return { call };
}

// ---------------------------------------------------------------------------
// Which part of a question to show (mirrors the browser's question dialog)
// ---------------------------------------------------------------------------

function answerValues(a) {
	if (!a) return [];
	return [...(Array.isArray(a.selected) ? a.selected : []), ...(a.text ? [a.text] : [])].map(String);
}

/** A field shows when it depends on nothing, or on an earlier answer that matches. */
export function visibleField(ask, index, answers) {
	const f = ask?.fields?.[index];
	if (!f) return false;
	const dep = f.dependsOn;
	if (!dep || !dep.questionId) return true;
	const picked = answerValues(answers?.[dep.questionId]);
	if (!picked.length) return false;
	if (dep.value === undefined || dep.value === null) return true;
	const want = (Array.isArray(dep.value) ? dep.value : [dep.value]).map(String);
	return picked.some((v) => want.includes(v));
}

/** The choices of a field (they can depend on an earlier answer). */
export function fieldOptions(ask, index, answers) {
	const f = ask?.fields?.[index];
	if (!f) return [];
	if (f.optionsMap && f.dependsOn?.questionId) {
		for (const v of answerValues(answers?.[f.dependsOn.questionId])) {
			const list = f.optionsMap[v];
			if (Array.isArray(list) && list.length) return list.slice(0, MAX_OPTIONS);
		}
	}
	return (Array.isArray(f.options) ? f.options : []).slice(0, MAX_OPTIONS);
}

/** The first field that shows and has no answer yet, or -1 when all are answered. */
export function nextStep(ask, answers) {
	const fields = ask?.fields ?? [];
	for (let i = 0; i < fields.length; i++) {
		if (visibleField(ask, i, answers) && !answers?.[fields[i].id]) return i;
	}
	return -1;
}

/** The answers to send, in field order (only fields that show). */
export function collectAnswers(ask, answers) {
	const out = [];
	(ask?.fields ?? []).forEach((f, i) => {
		const a = answers?.[f.id];
		if (!a || !visibleField(ask, i, answers)) return;
		out.push({ id: f.id, selected: [...(a.selected ?? [])], ...(a.text ? { text: a.text } : {}) });
	});
	return out;
}

function describeAnswer(ask, index, answers) {
	const f = ask.fields[index];
	const a = answers?.[f.id];
	if (!a) return "";
	const opts = fieldOptions(ask, index, answers);
	const labels = (a.selected ?? []).map((v) => plainText(opts.find((o) => o.value === v)?.label ?? v) || v);
	if (a.text) labels.push(`\u201C${a.text}\u201D`);
	return labels.join(", ");
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Which queued task a "stuck" ask is about: { id, title } (id 0 when it doesn't say). */
export function stuckTask(ask) {
	const t = ask?.task;
	if (t && Number(t.id) > 0) return { id: Number(t.id), title: String(t.title ?? "") };
	const m = /^Task #(\d+) needs you(?::\s*([\s\S]*))?$/.exec(String(ask?.title ?? ""));
	return m ? { id: Number(m[1]), title: m[2] ?? "" } : { id: 0, title: "" };
}

/** About how many characters one line of a Telegram message holds on a phone. */
const PHONE_LINE = 36;

/**
 * The top of every message: icon, what it is, and which chat it's from, on one line when that fits
 * on a phone (else the chat goes on the next line, so the head doesn't break in the middle of a
 * name). A queued task that needs you says "Task #N needs you", with the task's title under it.
 */
export function renderHead(ask) {
	const icon = KIND_ICON[ask?.kind] ?? KIND_ICON.question;
	const task = ask?.kind === "stuck" ? stuckTask(ask) : null;
	if (task?.id) {
		const title = oneLine(plainText(task.title), 200);
		return `${icon} <b>Task #${task.id} needs you</b>${title ? `\n<i>${escapeHtml(title)}</i>` : ""}`;
	}
	const title = oneLine(plainText(ask?.title), 200) || "A chat needs you";
	const head = `${icon} <b>${escapeHtml(title)}</b>`;
	const chat = oneLine(plainText(ask?.conversationTitle), 100);
	if (!chat) return head;
	if ([...`${icon} ${title} \u00B7 from ${chat}`].length <= PHONE_LINE) return `${head} \u00B7 <i>from ${escapeHtml(chat)}</i>`;
	return `${head}\n<i>from ${escapeHtml(cutWords(chat, PHONE_LINE - 5))}</i>`;
}

/** The bottom line: the chat's folder, and a link that opens the chat. */
export function renderFooter(ask, link) {
	const folder = ask?.cwd ? `<i>\u{1F4C1} ${escapeHtml(cut(shortPath(ask.cwd), 150))}</i>` : "";
	const open = link ? `<a href="${escapeHtml(link)}">Open the chat</a>` : "";
	return [folder, open].filter(Boolean).join(" \u00B7 ");
}

function lineOf(titleHtml, whatHtml, link) {
	const title = `<b>${titleHtml}</b>`;
	const head = link ? `<a href="${escapeHtml(link)}">${title}</a>` : title;
	return whatHtml ? `${head} \u00B7 <i>${whatHtml}</i>` : head;
}

/**
 * What an ask was, in one line, for its final words: its title (a link to the chat) and its chat;
 * for a queued task, "Task #N" and the task's title.
 */
export function renderLine(ask, link) {
	const task = ask?.kind === "stuck" ? stuckTask(ask) : null;
	if (task?.id) return lineOf(`Task #${task.id}`, escapeHtml(oneLine(plainText(task.title), 100)), link);
	const title = oneLine(plainText(ask?.title), 120) || "A question";
	return lineOf(escapeHtml(title), escapeHtml(oneLine(plainText(ask?.conversationTitle), 100)), link);
}

/** The same line for a message sent before this layout, from the head that was kept with it. */
export function lineFromOldHead(head, link) {
	const lines = String(head ?? "").split("\n");
	const title = /<b>([\s\S]*?)<\/b>/.exec(lines[0] ?? "")?.[1] ?? "";
	const task = /^Task #(\d+) needs you: ([\s\S]*)$/.exec(title);
	if (task) return lineOf(`Task #${task[1]}`, task[2], link);
	const chat = lines.find((l) => l.startsWith("Chat: "))?.slice(6) ?? "";
	return lineOf(title || "A question", chat, link);
}

/** The buttons for the current part of a question. */
export function renderButtons(ask, st) {
	const i = st?.step ?? 0;
	const f = ask?.fields?.[i];
	if (!f || st?.sending) return { inline_keyboard: [] };
	const opts = fieldOptions(ask, i, st.answers);
	const ticks = st.ticks ?? [];
	const rows = opts.map((o, n) => {
		const label = cut(plainText(o.label) || String(o.value ?? ""), LABEL_MAX) || "\u2026";
		const text = f.multi ? `${ticks.includes(o.value) ? "\u2611" : "\u2610"} ${label}` : label;
		return [{ text, callback_data: `${st.ref}:${i}:o${n}` }];
	});
	if (f.multi && opts.length) rows.push([{ text: "\u2705 Done", callback_data: `${st.ref}:${i}:d` }]);
	if (f.allowText) rows.push([{ text: "\u270F\uFE0F Type an answer", callback_data: `${st.ref}:${i}:t` }]);
	return { inline_keyboard: rows };
}

const CUT_NOTE = "(cut: open the chat for the rest)";
const TOO_LONG = "(too long for Telegram: open the chat to read it)";

/** Cut to at most `max` characters, at the end of a line when there's one near. */
function cutAtLine(s, max) {
	const nl = s.lastIndexOf("\n", max);
	return nl > max * 0.8 ? s.slice(0, nl).trimEnd() : cut(s, max);
}

/** A field's question, without the ask's title said again (an approval's "Allow bash? <reason>"). */
function questionOf(ask, f) {
	const text = String(f?.text ?? "").trim();
	const title = String(ask?.title ?? "").trim();
	if (!text || text === title) return "";
	if (ask?.kind === "approval" && title && text.startsWith(title)) return text.slice(title.length).trim();
	return text;
}

/** Short words that end in a full stop without ending the sentence. */
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|approx|incl|cf|Mr|Mrs|Ms|Dr|St|No|Nr|Fig)\.$/i;
const LEAD_MAX = 200;

/**
 * Whether a paragraph cut in two at `end` shows the same as it did whole: the cut doesn't break a
 * piece of formatting (bold, a code span, a link) or turn the rest into something else (a list).
 */
function cutsClean(para, end) {
	const norm = (s) => s.replace(/\s+/g, " ").trim();
	const lead = toTelegramHtml(para.slice(0, end));
	const rest = toTelegramHtml(para.slice(end).trim());
	return norm(`${lead} ${rest}`) === norm(toTelegramHtml(para));
}

/**
 * The part of a question you must read, to show in bold: up to its first question mark, else its
 * first sentence, else its first line (all within the first line). { lead, sep, rest }: sep is how
 * the rest followed it ("\n\n" a new paragraph, "\n" the same one). lead is "" when there's none to
 * pick out: the text starts with a list, a quote, a heading, a table or code, holds HTML, the part
 * is too long, or cutting there would break a piece of formatting.
 */
export function leadOf(src) {
	const text = String(src ?? "")
		.replace(/\r\n?/g, "\n")
		.trim();
	const none = { lead: "", sep: "", rest: text };
	const line = text.split("\n", 1)[0] ?? "";
	if (!line || /^(?:```|~~~|>|#{1,6}\s|[-*+]\s|\d+[.)]\s|\|)/.test(line) || /<\/?[a-zA-Z][^>]*>/.test(line)) return none;
	let question = 0;
	let sentence = 0;
	let code = false;
	let depth = 0;
	for (let i = 0; i < line.length && !question; i++) {
		const c = line[i];
		if (c === "`") code = !code;
		if (code) continue;
		if (c === "(" || c === "[") depth++;
		else if ((c === ")" || c === "]") && depth > 0) depth--;
		if (depth > 0 || !"?!.".includes(c)) continue;
		// Closing marks right after the end go with it: "**Why?**", "\u201CYes?\u201D".
		let j = i + 1;
		while (j < line.length && /[*_~"'\u201D\u2019]/.test(line[j])) j++;
		if (j < line.length && !/\s/.test(line[j])) continue; // "3.5", "notes.md", "?x=1"
		if (c === ".") {
			const next = line.slice(j).trimStart()[0] ?? "";
			if (next && !/[\p{Lu}\p{N}`*_["'\u201C(]/u.test(next)) continue; // "e.g. the", "see p. 4"
			if (ABBREVIATION.test(line.slice(0, i + 1)) || /(?:^|\s)\p{Lu}\.$/u.test(line.slice(0, i + 1))) continue;
		}
		if (c === "?") question = j;
		else sentence ||= j;
	}
	const end = question || sentence || line.length;
	const lead = line.slice(0, end).trim();
	if (!lead || [...lead].length > LEAD_MAX || !cutsClean(text.split(/\n[ \t]*\n/, 1)[0], end)) return none;
	const after = text.slice(end);
	return { lead, sep: /^[ \t]*\n[ \t]*\n/.test(after) ? "\n\n" : "\n", rest: after.trim() };
}

/** In italics, unless it holds a quote or a code block. */
const italic = (html) => (!html || /<(blockquote|pre)\b/.test(html) ? html : `<i>${html}</i>`);
/** In bold, unless it holds a quote or a code block. */
const bold = (html) => (!html || /<(blockquote|pre)\b/.test(html) ? html : `<b>${html}</b>`);

/** A question as Telegram HTML, with the part you must read in bold. */
function questionHtml(question, max = 1000) {
	const { lead, sep, rest } = leadOf(question);
	if (!lead) return question ? toTelegramHtml(cut(question, max)) : "";
	const restHtml = rest ? toTelegramHtml(cut(rest, Math.max(100, max - lead.length))) : "";
	return [bold(toTelegramHtml(lead, { outer: ["b"] })), restHtml].filter(Boolean).join(sep);
}

/**
 * The whole message for a waiting question: { text, reply_markup }. A one-line head, then the
 * body, the question, its detail and each described choice with a blank line between them, and a
 * footer with the folder and a link to the chat.
 * st = { ref, step, answers, ticks, sending, link }. extra = { warning, note }.
 */
export function renderAsk(ask, st, extra = {}) {
	const answers = st?.answers ?? {};
	const step = st?.step ?? 0;
	const f = ask?.fields?.[step];
	const head = renderHead(ask);
	const approval = ask?.kind === "approval";
	const several = (ask?.fields?.length ?? 0) > 1;

	const done = [];
	(ask?.fields ?? []).forEach((field, i) => {
		if (!answers[field.id] || !visibleField(ask, i, answers)) return;
		const q = oneLine(plainText(field.header || field.text || field.id), 80);
		done.push(`\u2714\uFE0F ${escapeHtml(q)}: ${escapeHtml(cut(describeAnswer(ask, i, answers), 150))}`);
	});

	const parts = [];
	if (f && !st?.sending) {
		const text = questionHtml(questionOf(ask, f));
		if (several) {
			// Several questions: each shows its header (a single one has it as the title already), as a
			// label: the question under it is the part in bold.
			const shown = ask.fields.map((_, i) => i).filter((i) => visibleField(ask, i, answers));
			const pos = shown.indexOf(step) + 1;
			const count = pos > 0 && shown.length > 1 ? ` (${pos}/${shown.length})` : "";
			const header = `<i>${escapeHtml(oneLine(plainText(f.header), 100) || "Question")}${count}</i>`;
			parts.push(text ? `${header}\n${text}` : header);
		} else if (text) parts.push(text);
		if (f.detail) parts.push(italic(toTelegramHtml(cut(f.detail, 500), { outer: ["i"] })));
		const opts = fieldOptions(ask, step, answers);
		for (const o of opts.filter((o) => o.description).slice(0, 12)) {
			const label = `<b>${escapeHtml(cut(plainText(o.label) || String(o.value ?? ""), LABEL_MAX))}</b>`;
			const description = toTelegramHtml(cut(o.description, 200));
			parts.push(description ? `${label}\n${description}` : label);
		}
		if (f.multi && opts.length) parts.push("<i>Tick all that fit, then tap Done.</i>");
		else if (f.allowText && !opts.length) parts.push("<i>Reply to this message with your answer.</i>");
	}

	const tail = [];
	if (extra.warning) tail.push(`\u26A0\uFE0F ${escapeHtml(cut(extra.warning, 300))}`);
	if (st?.sending) tail.push(`<i>${escapeHtml(extra.note || "Sending your answer\u2026")}</i>`);
	const footer = renderFooter(ask, st?.link);

	const body = (raw) => (!raw ? "" : approval ? codeBlock(raw) : toTelegramHtml(raw));
	const build = (bodyRaw, note = "") =>
		[head, body(bodyRaw), note ? `<i>${escapeHtml(note)}</i>` : "", done.join("\n"), ...parts, ...tail, footer]
			.filter(Boolean)
			.join("\n\n");

	let bodyRaw = ask?.body ? String(ask.body) : "";
	let text = build(bodyRaw);
	if (bodyRaw && visibleLength(text) > TEXT_BUDGET) {
		// Too long: cut the body to the room left (formatting changes a text's length, so the cut
		// goes by how long it shows, and is tried again a little shorter when it's still too long).
		const room = TEXT_BUDGET - visibleLength(build("", CUT_NOTE)) - 2;
		for (let n = 1; bodyRaw && visibleLength(text) > TEXT_BUDGET && n <= 8; n++) {
			const shown = visibleLength(body(bodyRaw)) || 1;
			const keep = Math.min(bodyRaw.length - 1, Math.floor((bodyRaw.length * room * (1 - 0.03 * n)) / shown));
			bodyRaw = room > 200 && keep > 200 ? cutAtLine(bodyRaw, keep) : "";
			text = build(bodyRaw, bodyRaw ? CUT_NOTE : TOO_LONG);
		}
	}
	if (visibleLength(text) > TEXT_BUDGET) {
		// Still too long (a huge question): the short form, and when even that is too long (formatting
		// can make a text longer: a table's columns), the question as it was written.
		const question = f ? questionOf(ask, f) || f.header || "" : "";
		const short = (q) => [head, q, `<i>${escapeHtml(CUT_NOTE)}</i>`, ...tail, footer].filter(Boolean).join("\n\n");
		text = short(questionHtml(question, 1500));
		if (visibleLength(text) > TEXT_BUDGET) text = short(escapeHtml(cut(question, 1500)));
	}
	return { text, reply_markup: renderButtons(ask, st) };
}

/** The final words once it's answered: one line (the buttons go). `line` comes from renderLine. */
export function renderAnswered(line, summary, from) {
	const where = from === PLUGIN_ID ? "on Telegram" : from === "browser" || !from ? "in the browser" : `by ${from}`;
	return `\u2705 ${line}: ${escapeHtml(oneLine(summary || "done", 300))} <i>(${escapeHtml(where)})</i>`;
}

/** The final words once it's no longer waiting: one line (the buttons go). */
export function renderGone(line, reason) {
	return `\u23F9 ${line}: no longer waiting (${escapeHtml(oneLine(reason || "it went away", 200))})`;
}

// ---------------------------------------------------------------------------
// Only the owner, only in a private chat
// ---------------------------------------------------------------------------

export function isOwnerMessage(msg, ownerId) {
	const owner = String(ownerId ?? "");
	return (
		/^\d+$/.test(owner) &&
		String(msg?.from?.id ?? "") === owner &&
		msg?.chat?.type === "private" &&
		String(msg?.chat?.id ?? "") === owner
	);
}

export function isOwnerCallback(cq, ownerId) {
	const owner = String(ownerId ?? "");
	return (
		/^\d+$/.test(owner) &&
		String(cq?.from?.id ?? "") === owner &&
		isOwnerMessage({ ...cq?.message, from: cq?.from }, owner)
	);
}

// ---------------------------------------------------------------------------
// The bridge between host.asks and the bot
// ---------------------------------------------------------------------------

const keyOf = (ask) => `${ask.id}@${ask.createdAt}`;
/** A no-op for optional callbacks (takes any arguments, so callers' signatures check). */
const ignore = (..._args) => {};
const notModified = (err) => /not modified/i.test(String(err?.description ?? err?.message ?? ""));
/** Telegram couldn't read a text's formatting. */
const cantParse = (err) => err?.code === 400 && /can't parse entities/i.test(String(err?.description ?? ""));
/** Worth another try: Telegram asked us to slow down (429), had a hiccup (5xx), or the connection
 *  failed or got no answer in time (code 0). */
const retryable = (err) => err?.code === 429 || err?.code === 0 || (err?.code >= 500 && err?.code <= 599);

/** The ref our buttons carry ("<ref>:<part>:<action>"), read off a message Telegram shows us. */
function refOfButtons(message) {
	for (const row of message?.reply_markup?.inline_keyboard ?? []) {
		for (const b of row ?? []) {
			const m = /^(\d+):/.exec(String(b?.callback_data ?? ""));
			if (m) return m[1];
		}
	}
	return null;
}

/**
 * Keeps one Telegram message per waiting ask. Everything that talks to Telegram runs one at a
 * time, in order, so an edit never overtakes the message it edits.
 *
 * A message is sent with its ref in every button, and the ref is kept when a send fails: when
 * Telegram got a send whose answer was lost, and the next try sends it again, both copies carry
 * the same ref and a tap on either one counts. Refs start from the clock (seconds), so they never
 * repeat even if the storage is lost; a tap on an old message can't hit a newer question.
 *
 * storage keys: "sent" (key -> message state), "nextRef" (button ids).
 */
export function createBridge({
	api,
	asks,
	storage,
	ownerId,
	webAppAddress = "",
	selfId = PLUGIN_ID,
	log = ignore,
	sleep,
}) {
	const owner = String(ownerId);
	const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	const entries = new Map(Object.entries(storage.get("sent", {}) ?? {}));
	let nextRef = Number(storage.get("nextRef", 0)) || Math.floor(Date.now() / 1000);
	const pendingSends = new Set();
	let chain = Promise.resolve();
	let closed = false;

	const save = () => storage.set("sent", Object.fromEntries(entries));
	const byRef = (ref) => {
		for (const e of entries.values()) if (String(e.ref) === String(ref)) return e;
		return null;
	};
	const liveAsk = (e) => asks.list().find((a) => a.id === e.askId && a.createdAt === e.createdAt) ?? null;

	function enqueue(job) {
		const run = chain
			.then(() => (closed ? undefined : job()))
			.catch((err) => {
				log("warn", `telegram: ${err?.message ?? err}`);
			});
		chain = run;
		return run;
	}

	async function call(method, params) {
		for (let attempt = 0; ; attempt++) {
			try {
				return await api.call(method, params);
			} catch (err) {
				if (!retryable(err) || attempt >= RETRY_DELAYS_MS.length || closed) throw err;
				await wait(
					err.code === 429
						? Math.min(60, Math.max(1, err.retryAfter || 1)) * 1000
						: RETRY_DELAYS_MS[attempt],
				);
			}
		}
	}

	/** A call with an HTML text. When Telegram can't read its formatting, the same text goes as plain text. */
	async function callHtml(method, params) {
		try {
			return await call(method, { ...params, parse_mode: "HTML" });
		} catch (err) {
			if (!cantParse(err)) throw err;
			log("warn", `telegram: Telegram couldn't read a message's formatting (${cut(err.description, 160)}); sent as plain text`);
			return call(method, { ...params, text: cut(htmlToPlain(params.text), 4000) });
		}
	}

	const send = (text, extra = {}) =>
		callHtml("sendMessage", {
			chat_id: owner,
			text,
			link_preview_options: { is_disabled: true },
			...extra,
		});

	/** Every message that shows e: the one we sent, and copies found since (see noteCopy). */
	const messagesOf = (e) => [e.messageId, ...(e.copies ?? [])].filter((id) => Number(id) > 0);

	/** A tap or reply came from message msgId, which carries e's ref: it shows e too. */
	function noteCopy(e, msgId) {
		if (!msgId || messagesOf(e).includes(msgId)) return;
		// A send whose answer was lost did arrive: when no later try got through, that's the message.
		if (!e.messageId) e.messageId = msgId;
		else e.copies = [...(e.copies ?? []), msgId];
		save();
	}

	/** One edit on every message that shows e. A copy that can't be edited (deleted) doesn't matter. */
	async function editAll(e, method, params, via = call) {
		let failed = null;
		for (const id of messagesOf(e)) {
			try {
				await via(method, { chat_id: owner, message_id: id, ...params });
			} catch (err) {
				if (!notModified(err) && id === e.messageId) failed ??= err;
			}
		}
		if (failed) throw failed;
	}

	const edit = (e, text, reply_markup = { inline_keyboard: [] }) =>
		editAll(e, "editMessageText", { text, link_preview_options: { is_disabled: true }, reply_markup }, callHtml);

	/** What e was, in one line, for its final words (a message sent before this layout kept only its head). */
	const lineOfEntry = (e) => e.line || lineFromOldHead(e.head, e.link);

	async function removePrompts(e, onlyField) {
		for (const [pid, fi] of Object.entries(e.prompts ?? {})) {
			if (onlyField !== undefined && fi !== onlyField) continue;
			delete e.prompts[pid];
			await call("deleteMessage", { chat_id: owner, message_id: Number(pid) }).catch(ignore);
		}
	}

	/** Forget a message, and edit it to its final words. */
	async function finish(e, text) {
		if (entries.get(e.key) === e) {
			entries.delete(e.key);
			save();
		}
		await edit(e, text).catch((err) => log("warn", `telegram: ${err?.message ?? err}`));
		await removePrompts(e);
	}

	async function rerender(e, ask, extra) {
		const { text, reply_markup } = renderAsk(ask, e, extra);
		await edit(e, text, reply_markup);
	}

	/** Send ask's message, unless it has one. The entry is kept before sending, so a failed send
	 *  keeps its ref: the next try (the next resync) sends the same buttons. */
	function sendAsk(ask) {
		const key = keyOf(ask);
		if (entries.get(key)?.messageId || pendingSends.has(key)) return;
		pendingSends.add(key);
		enqueue(async () => {
			try {
				const live = asks.list().find((a) => keyOf(a) === key);
				if (!live) return;
				let e = entries.get(key);
				if (e?.messageId) return;
				if (!e) {
					const link = chatLink(webAppAddress, live.sessionFile);
					e = {
						key,
						ref: nextRef++,
						askId: live.id,
						createdAt: live.createdAt,
						messageId: 0,
						step: 0,
						answers: {},
						ticks: [],
						prompts: {},
						sending: false,
						link,
						line: renderLine(live, link),
					};
					storage.set("nextRef", nextRef);
					e.step = Math.max(0, nextStep(live, e.answers));
					entries.set(key, e);
					save();
				}
				const { text, reply_markup } = renderAsk(live, e);
				const msg = await send(text, { reply_markup });
				e.messageId = Number(msg?.message_id) || 0;
				save();
				log("info", `telegram: sent ${live.kind === "approval" ? "permission prompt" : "question"} ${live.id} as message ${e.messageId}`);
			} finally {
				pendingSends.delete(key);
			}
		});
	}

	function onAskEvent(ev) {
		if (closed || !ev?.ask) return;
		if (ev.type === "appeared") {
			sendAsk(ev.ask);
			return;
		}
		const key = keyOf(ev.ask);
		enqueue(async () => {
			const e = entries.get(key);
			if (!e) return;
			const line = renderLine(ev.ask, e.link);
			const text =
				ev.type === "answered" ? renderAnswered(line, ev.summary, ev.from) : renderGone(line, ev.reason);
			await finish(e, text);
		});
	}

	/** All fields answered: answer the chat. */
	async function submit(e, ask) {
		e.sending = true;
		save();
		await rerender(e, ask).catch(ignore);
		let res;
		try {
			res = await asks.answer(ask.id, collectAnswers(ask, e.answers));
		} catch (err) {
			res = { ok: false, error: String(err?.message ?? err) };
		}
		if (res?.ok) {
			log("info", `telegram: answered ${ask.id} from Telegram`);
			// The "answered" event writes the final words (it may already be queued).
			return;
		}
		if (/no longer waiting/i.test(String(res?.error ?? ""))) {
			await finish(e, renderGone(lineOfEntry(e), "it was answered or went away"));
			return;
		}
		e.sending = false;
		e.answers = {};
		e.ticks = [];
		e.step = Math.max(0, nextStep(ask, e.answers));
		save();
		await rerender(e, ask, { warning: `${res?.error || "That didn't work"}. Please answer again.` });
	}

	async function advance(e, ask) {
		const next = nextStep(ask, e.answers);
		if (next < 0) return submit(e, ask);
		e.step = next;
		e.ticks = [];
		save();
		await rerender(e, ask);
	}

	async function onCallback(cq) {
		const reply = (text) =>
			call("answerCallbackQuery", { callback_query_id: cq.id, ...(text ? { text: cut(text, 190) } : {}) }).catch(
				ignore,
			);
		const m = /^(\d+):(\d+):(o\d+|d|t)$/.exec(String(cq.data ?? ""));
		const msgId = Number(cq.message?.message_id) || 0;
		const e = m ? byRef(m[1]) : null;
		if (!e) {
			await reply("No longer waiting.");
			if (msgId) {
				await call("editMessageReplyMarkup", {
					chat_id: owner,
					message_id: msgId,
					reply_markup: { inline_keyboard: [] },
				}).catch(ignore);
			}
			return;
		}
		// Another message with this ref (a copy Telegram got twice) counts like the one we know.
		noteCopy(e, msgId);
		const ask = liveAsk(e);
		if (!ask) {
			await reply("No longer waiting.");
			await finish(e, renderGone(lineOfEntry(e), "it went away"));
			return;
		}
		if (e.sending) {
			await reply("Your answer is on its way.");
			return;
		}
		const fi = Number(m[2]);
		const field = ask.fields[fi];
		if (fi !== e.step || !field) {
			await reply("That part is already answered.");
			return;
		}
		const act = m[3];
		if (act === "t") {
			if (!field.allowText) {
				await reply("This one needs a button.");
				return;
			}
			await reply();
			// Just the part you must read (the whole question is right above), on a line of its own.
			const question = questionOf(ask, field) || String(field.text ?? "");
			const about =
				plainText(leadOf(question).lead || question) ||
				plainText(field.header) ||
				plainText(ask.title) ||
				"the question above";
			const p = await send(`Type your answer to:\n<b>${escapeHtml(cut(about, 200))}</b>`, {
				reply_parameters: { message_id: e.messageId, allow_sending_without_reply: true },
				reply_markup: { force_reply: true, input_field_placeholder: "Your answer" },
			});
			if (p?.message_id) {
				e.prompts[p.message_id] = fi;
				save();
			}
			return;
		}
		if (act === "d") {
			if (!field.multi) {
				await reply();
				return;
			}
			if (!e.ticks.length) {
				await reply("Tick at least one choice first.");
				return;
			}
			e.answers[field.id] = { selected: [...e.ticks] };
			e.ticks = [];
			await reply();
			await removePrompts(e, fi);
			await advance(e, ask);
			return;
		}
		const opt = fieldOptions(ask, fi, e.answers)[Number(act.slice(1))];
		if (!opt) {
			await reply("That choice changed; look again.");
			await rerender(e, ask);
			return;
		}
		if (field.multi) {
			e.ticks = e.ticks.includes(opt.value) ? e.ticks.filter((v) => v !== opt.value) : [...e.ticks, opt.value];
			save();
			await reply();
			await editAll(e, "editMessageReplyMarkup", { reply_markup: renderButtons(ask, e) });
			return;
		}
		e.answers[field.id] = { selected: [opt.value] };
		await reply(`Chosen: ${opt.label || opt.value}`);
		await removePrompts(e, fi);
		await advance(e, ask);
	}

	async function typedAnswer(e, fi, text, say) {
		const ask = liveAsk(e);
		if (!ask) {
			await say("That question is no longer waiting.");
			await finish(e, renderGone(lineOfEntry(e), "it went away"));
			return;
		}
		if (e.sending) {
			await say("Your answer is already on its way.");
			return;
		}
		const field = ask.fields[fi];
		if (fi !== e.step || !field) {
			await say("That part is already answered.");
			return;
		}
		if (!field.allowText) {
			await say("This one needs a button: tap one of the choices on the question.");
			return;
		}
		if (!text) {
			await say("Please answer with text.");
			return;
		}
		e.answers[field.id] = { selected: field.multi ? [...e.ticks] : [], text };
		e.ticks = [];
		save();
		await removePrompts(e, fi);
		await advance(e, ask);
	}

	/** Questions waiting for a typed answer to their current part (each once). */
	function openPrompts() {
		const open = new Set();
		for (const e of entries.values()) {
			for (const fi of Object.values(e.prompts ?? {})) if (Number(fi) === e.step && !e.sending) open.add(e);
		}
		return [...open];
	}

	async function onMessage(msg) {
		const text = typeof msg.text === "string" ? msg.text.trim() : "";
		const say = (t) =>
			send(escapeHtml(t), {
				reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
			}).catch(ignore);
		const replyTo = Number(msg.reply_to_message?.message_id) || 0;
		if (replyTo) {
			for (const e of entries.values()) {
				const fi = e.prompts?.[replyTo];
				if (fi !== undefined) return typedAnswer(e, Number(fi), text, say);
				if (messagesOf(e).includes(replyTo)) return typedAnswer(e, e.step, text, say);
			}
			// A copy we haven't met yet: its buttons carry the question's ref.
			const copyOf = byRef(refOfButtons(msg.reply_to_message));
			if (copyOf) {
				noteCopy(copyOf, replyTo);
				return typedAnswer(copyOf, copyOf.step, text, say);
			}
			// A "Type your answer" prompt we don't know (one sent twice when an answer got lost):
			// when just one question waits for a typed answer, it's that one.
			const to = msg.reply_to_message;
			if (to?.from?.is_bot && String(to.text ?? "").startsWith("Type your answer to:")) {
				const open = openPrompts();
				if (open.length === 1) {
					// Remember it, so it's cleared away with the prompt we know.
					open[0].prompts = { ...open[0].prompts, [replyTo]: open[0].step };
					save();
					return typedAnswer(open[0], open[0].step, text, say);
				}
			}
			await say("That question is no longer waiting.");
			return;
		}
		if (/^\/start(\s|@|$)/.test(text)) {
			const n = asks.list().length;
			await say(
				"Hi! pi sends you its questions and permission prompts here. Tap a button to answer, or reply to a question's message to type an answer." +
					(n ? `\n\nWaiting now: ${n}.` : ""),
			);
			resync("it went away");
			return;
		}
		const open = openPrompts();
		if (open.length === 1 && text) return typedAnswer(open[0], open[0].step, text, say);
		await say("To answer a question, tap one of its buttons, or reply to its message to type an answer.");
	}

	function handleUpdate(update) {
		if (closed) return Promise.resolve();
		const cq = update?.callback_query;
		if (cq) {
			if (!isOwnerCallback(cq, owner)) return Promise.resolve();
			log("info", `telegram: the owner tapped ${cut(cq.data, 40)} on message ${cq.message?.message_id ?? "?"}`);
			return enqueue(() => onCallback(cq));
		}
		const msg = update?.message;
		if (msg) {
			if (!isOwnerMessage(msg, owner)) return Promise.resolve();
			const to = Number(msg.reply_to_message?.message_id) || 0;
			// Never the text itself: it can be anything.
			log("info", `telegram: a message from the owner${to ? ` replying to message ${to}` : ""}`);
			return enqueue(() => onMessage(msg));
		}
		return Promise.resolve();
	}

	/** Old messages whose ask is gone get their final words; waiting asks without a message get one. */
	function resync(reason = "it went away") {
		return enqueue(async () => {
			const live = asks.list();
			const liveKeys = new Set(live.map(keyOf));
			for (const e of [...entries.values()]) {
				if (liveKeys.has(e.key)) continue;
				await finish(
					e,
					e.sending
						? renderAnswered(lineOfEntry(e), "your answer was sent", selfId)
						: renderGone(lineOfEntry(e), reason),
				);
			}
			for (const a of live) if (!entries.get(keyOf(a))?.messageId) sendAsk(a);
		});
	}

	return {
		onAskEvent,
		handleUpdate,
		resync,
		/** Resolves when everything queued so far has run (tests). */
		idle: () => chain,
		close() {
			closed = true;
		},
		/** For tests. */
		entries,
	};
}

// ---------------------------------------------------------------------------
// Long polling
// ---------------------------------------------------------------------------

export function createPoller({
	api,
	storage,
	offsetKey = "offset",
	onUpdate,
	onStatus = ignore,
	onFatal = ignore,
	log = ignore,
}) {
	const ctl = new AbortController();
	let started = false;
	const sleep = (ms) =>
		new Promise((resolve) => {
			if (ctl.signal.aborted) return resolve();
			const t = setTimeout(resolve, ms);
			ctl.signal.addEventListener(
				"abort",
				() => {
					clearTimeout(t);
					resolve();
				},
				{ once: true },
			);
		});

	async function loop() {
		let offset = Number(storage.get(offsetKey, 0)) || 0;
		let backoff = BACKOFF_MIN_MS;
		while (!ctl.signal.aborted) {
			try {
				const updates = await api.call(
					"getUpdates",
					{ offset, timeout: POLL_TIMEOUT_S, allowed_updates: ["message", "callback_query"] },
					{ signal: ctl.signal, timeoutMs: POLL_FETCH_TIMEOUT_MS },
				);
				if (ctl.signal.aborted) break;
				backoff = BACKOFF_MIN_MS;
				onStatus("listening");
				for (const u of Array.isArray(updates) ? updates : []) {
					const id = Number(u?.update_id);
					if (Number.isFinite(id) && id >= offset) {
						offset = id + 1;
						storage.set(offsetKey, offset);
					}
					try {
						await onUpdate(u);
					} catch (err) {
						log("warn", `telegram: an update failed: ${err?.message ?? err}`);
					}
				}
			} catch (err) {
				if (ctl.signal.aborted) break;
				const code = err?.code;
				if (code === 401 || code === 404) {
					onStatus("the bot token was refused: check it in the settings");
					onFatal(err);
					break;
				}
				if (code === 409) {
					onStatus("another program is reading this bot's messages");
					await sleep(BACKOFF_MAX_MS);
					continue;
				}
				if (code === 429) {
					await sleep(Math.max(1, err.retryAfter || 5) * 1000);
					continue;
				}
				onStatus(`can't reach Telegram, retrying (${cut(err?.description ?? err?.message ?? err, 120)})`);
				log("warn", `telegram: ${err?.message ?? err}`);
				await sleep(backoff);
				backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
			}
		}
	}

	return {
		start() {
			if (started) return;
			started = true;
			void loop();
		},
		stop() {
			ctl.abort();
		},
	};
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

export default {
	activate(host) {
		let current = null;
		const task = host.registerBackgroundTask({
			id: "telegram-bot",
			label: "\u{1F4E8} Telegram",
			status: "starting",
			stop: () => {
				stopAll();
				setStatus("stopped (save the settings to start again)");
			},
		});
		let lastStatus = "";
		function setStatus(status) {
			if (status === lastStatus) return;
			lastStatus = status;
			try {
				task.update({ status });
			} catch {
				/* ignore */
			}
		}
		const log = (level, ...args) => {
			try {
				host.log(level, ...args);
			} catch {
				/* ignore */
			}
		};

		function stopAll() {
			const c = current;
			current = null;
			if (!c) return;
			try {
				c.offAsks?.();
			} catch {
				/* ignore */
			}
			clearInterval(c.timer);
			c.poller?.stop();
			c.bridge?.close();
		}

		function start() {
			stopAll();
			let s = {};
			try {
				s = host.getSettings?.() ?? {};
			} catch {
				s = {};
			}
			if (s.enabled === false) {
				setStatus("off");
				return;
			}
			const token = String(s.botToken ?? "").trim();
			const ownerId = String(s.ownerId ?? "").trim();
			if (!token || !/^\d+$/.test(ownerId)) {
				const missing = [!token && "the bot token", !/^\d+$/.test(ownerId) && "your Telegram id"].filter(Boolean);
				setStatus(`not set up: add ${missing.join(" and ")} in the settings`);
				return;
			}
			// A new bot starts over: its update numbers and messages have nothing to do with the old one's.
			const botId = token.split(":")[0];
			if (host.storage.get("bot") !== botId) {
				host.storage.set("bot", botId);
				host.storage.delete("offset");
				host.storage.delete("sent");
			}
			const api = createTelegramApi({ base: process.env[API_BASE_ENV] || API_BASE_DEFAULT, token });
			const bridge = createBridge({
				api,
				asks: host.asks,
				storage: host.storage,
				ownerId,
				webAppAddress: String(s.webAppAddress ?? "").trim(),
				log,
			});
			const c = { bridge };
			current = c;
			// While we listen, a chat with no browser open waits for an answer instead of refusing.
			c.offAsks = host.asks.on((ev) => bridge.onAskEvent(ev));
			c.poller = createPoller({
				api,
				storage: host.storage,
				onUpdate: (u) => bridge.handleUpdate(u),
				onStatus: (st) => {
					if (current === c) setStatus(st);
				},
				onFatal: () => {
					// The token is refused: stop listening, so chats don't wait on a bot that can't reach you.
					if (current !== c) return;
					try {
						c.offAsks?.();
					} catch {
						/* ignore */
					}
					c.offAsks = null;
					clearInterval(c.timer);
				},
				log,
			});
			c.poller.start();
			void bridge.resync("pi restarted");
			c.timer = setInterval(() => void bridge.resync("it went away"), RESYNC_MS);
			c.timer.unref?.();
			setStatus("connecting");
		}

		start();
		const offSettings = host.onSettingsChanged?.(() => start());
		return () => {
			try {
				offSettings?.();
			} catch {
				/* ignore */
			}
			stopAll();
			try {
				task.unregister();
			} catch {
				/* ignore */
			}
		};
	},
};
