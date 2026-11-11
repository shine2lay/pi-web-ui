#!/usr/bin/env node
// check-token-provenance.mjs: proves that every token in .temper/design/tokens.json says truthfully where it comes from.
//
//   measured  needs at least one {file, line, text} citation; `text` must appear verbatim on that line of that file,
//             and the token's hex (colours) or value (type, spacing, radius) must appear in the cited text.
//   derived   a colour composited from cited app values: {base, alpha, over} must reproduce the hex, and base,
//             alpha and over must each appear in the cited text.
//   addition  a value the app does not have: needs a reason plus the app's own value with its citation (`app`).
//
// Rendered citations ({computed: "<selector> <property>", page, theme}) are checked against a measure.json
// (--evidence) when one is given; without it only their shape is checked.
//
// Exit 0: every citation holds. Exit 1: some citation, value, derivation or addition record is wrong (each named
// by token). Exit 2: the tokens file or a cited file is missing or unreadable, or the arguments are wrong.
//
// Usage: node .temper/design/check-token-provenance.mjs [--tokens <path>] [--root <repo dir>] [--rev <git rev>]
//        [--evidence <measure.json>] [--json]
//   --rev reads the tokens file and every cited file as they were at that git revision (e.g. --rev 5db1eb93).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "../..");
const DEFAULT_TOKENS = ".temper/design/tokens.json";
const ORIGINS = new Set(["measured", "derived", "addition"]);
const COLOR_THEMES = ["dark", "light"];
const SCALAR_GROUPS = ["typography", "spacing", "radius"];
const HEX_RE = /^#[0-9a-f]{6}$/i;
const CHANNEL_TOLERANCE = 2; // 8-bit sRGB steps allowed between an oklch value or a composite and its hex

class MissingFile extends Error {}

function usage(problem, code = 2) {
	if (problem) process.stderr.write(`check-token-provenance: ${problem}\n`);
	process.stderr.write(
		"usage: check-token-provenance.mjs [--tokens <path>] [--root <dir>] [--rev <git rev>] [--evidence <measure.json>] [--json]\n",
	);
	process.exit(code);
}

function parseArgs(argv) {
	const opts = { root: DEFAULT_ROOT, tokens: null, rev: null, evidence: null, json: false };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = () => {
			const v = argv[++i];
			if (v === undefined || v.startsWith("--")) usage(`${flag} needs a value`);
			return v;
		};
		if (flag === "--root") opts.root = resolve(value());
		else if (flag === "--tokens") opts.tokens = value();
		else if (flag === "--rev") opts.rev = value();
		else if (flag === "--evidence") opts.evidence = resolve(value());
		else if (flag === "--json") opts.json = true;
		else if (flag === "-h" || flag === "--help") usage(null, 0);
		else usage(`unknown argument ${flag}`);
	}
	return opts;
}

// Reads repo files from the working tree or, with --rev, from git. Cached; returns the file's lines.
function makeFileReader(root, rev) {
	const cache = new Map();
	return (file) => {
		if (cache.has(file)) return cache.get(file);
		if (typeof file !== "string" || !file || isAbsolute(file) || relative(root, resolve(root, file)).startsWith("..")) {
			throw new Error(`file must be a path inside the repo, got ${JSON.stringify(file)}`);
		}
		let text;
		if (rev) {
			try {
				text = execFileSync("git", ["-C", root, "show", `${rev}:${file}`], {
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
					maxBuffer: 64 * 1024 * 1024,
				});
			} catch {
				throw new MissingFile(`${file} does not exist at ${rev}`);
			}
		} else {
			const path = resolve(root, file);
			if (!existsSync(path)) throw new MissingFile(`${file} does not exist under ${root}`);
			text = readFileSync(path, "utf8");
		}
		const lines = text.split(/\r?\n/);
		cache.set(file, lines);
		return lines;
	};
}

// ---- colour math (sRGB 0-255 channels) ----
const hexToRgb = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
const maxChannelDiff = (a, b) => Math.max(...a.map((x, i) => Math.abs(x - b[i])));
const toHex = (rgb) => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;

function oklchToRgb(L, C, H) {
	const a = C * Math.cos((H * Math.PI) / 180);
	const b = C * Math.sin((H * Math.PI) / 180);
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const linear = [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	];
	return linear.map((x) => {
		const c = Math.min(1, Math.max(0, x));
		return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
	});
}

function parseOklch(value) {
	const m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(String(value ?? "").trim());
	return m ? oklchToRgb(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

const composite = (base, alpha, over) => base.map((b, i) => alpha * b + (1 - alpha) * over[i]);

// CSS colour from computed styles ("rgb(13, 14, 18)", "#0d0e12") -> lowercase hex, or null when not opaque sRGB.
function cssColorToHex(value) {
	const v = String(value).trim().toLowerCase();
	if (HEX_RE.test(v)) return v;
	const m = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)$/.exec(v);
	if (!m || (m[4] !== undefined && Number(m[4]) !== 1)) return null;
	return toHex([m[1], m[2], m[3]].map(Number));
}

// ---- text matching ----
const normalize = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The value must stand alone in the text: "4px" is not found in "14px", nor "#0d0e12" in "#0d0e1234".
function textHasValue(text, value) {
	return new RegExp(`(?<![\\w.#-])${escapeRe(normalize(value))}(?![\\w])`).test(normalize(text));
}

function textHasColor(text, hex) {
	if (textHasValue(text, hex)) return true;
	const [r, g, b] = hexToRgb(hex);
	return new RegExp(`(?<![\\d.])${r},\\s*${g},\\s*${b}(?![\\d.])`).test(normalize(text));
}

function textHasAlpha(text, alpha) {
	const t = normalize(text);
	const forms = new Set([String(alpha), alpha.toFixed(2), `${Number((alpha * 100).toFixed(2))}%`]);
	return [...forms].some((form) => new RegExp(`(?<![\\d.])${escapeRe(form)}(?![\\d])`).test(t));
}

// ---- checks ----
function makeContext(readFile, evidence) {
	return { readFile, evidence, errors: [], missing: [], tokens: 0, citations: 0, computedVerified: 0, computedUnverified: 0 };
}

function fail(ctx, where, message) {
	ctx.errors.push({ token: where, message });
}

function sourceList(source) {
	if (source === undefined || source === null) return [];
	return Array.isArray(source) ? source : [source];
}

// Returns the cited text when the citation holds, else records the problem and returns null.
function checkStaticSource(ctx, where, src) {
	ctx.citations++;
	const bad = (message) => {
		fail(ctx, where, message);
		return null;
	};
	if (typeof src.text !== "string" || !src.text.trim()) return bad(`citation ${src.file}:${src.line} has no text`);
	if (!Number.isInteger(src.line) || src.line < 1) return bad(`citation ${src.file} has a bad line ${JSON.stringify(src.line)}`);
	let lines;
	try {
		lines = ctx.readFile(src.file);
	} catch (err) {
		if (!(err instanceof MissingFile)) return bad(err.message);
		ctx.missing.push({ token: where, message: `cited file missing: ${err.message}` });
		return null;
	}
	const line = lines[src.line - 1];
	if (line === undefined) return bad(`${src.file}:${src.line} is past the end of the file (${lines.length} lines)`);
	if (!line.includes(src.text)) {
		return bad(`${src.file}:${src.line} does not contain ${JSON.stringify(src.text)} (line reads ${JSON.stringify(line.trim())})`);
	}
	return src.text;
}

function checkComputedSource(ctx, where, src, expected) {
	ctx.citations++;
	const spec = typeof src.computed === "string" ? src.computed.trim() : "";
	const cut = spec.lastIndexOf(" ");
	if (cut < 1) return fail(ctx, where, `computed citation must read "<selector> <property>", got ${JSON.stringify(src.computed)}`);
	if (typeof src.page !== "string" || !/^https?:\/\//.test(src.page)) return fail(ctx, where, `computed citation ${spec} needs a page URL`);
	if (typeof src.theme !== "string" || !src.theme) return fail(ctx, where, `computed citation ${spec} needs the theme it was read in`);
	if (!ctx.evidence) {
		ctx.computedUnverified++;
		return;
	}
	const selector = spec.slice(0, cut).trim();
	const property = spec.slice(cut + 1);
	if (ctx.evidence.page !== src.page) return fail(ctx, where, `computed citation page ${src.page} is not the evidence page ${ctx.evidence.page}`);
	const theme = ctx.evidence.themes?.[src.theme];
	if (!theme) return fail(ctx, where, `evidence has no theme ${src.theme}`);
	let actual;
	if (selector === ":root" && property.startsWith("--")) actual = theme.vars?.[property];
	else actual = Object.values(theme.elements ?? {}).find((el) => el.selector === selector && el.found)?.[property];
	if (actual === undefined || actual === "") return fail(ctx, where, `evidence has no "${spec}" for theme ${src.theme}`);
	const same = normalize(actual) === normalize(expected) || (HEX_RE.test(expected) && cssColorToHex(actual) === expected.toLowerCase());
	if (!same) return fail(ctx, where, `rendered ${spec} (${src.theme}) is ${actual}, token says ${expected}`);
	ctx.computedVerified++;
}

// Checks every citation in `source`; returns the joined static text, or null when a citation failed.
function checkSources(ctx, where, source, expected, { requireStatic }) {
	const sources = sourceList(source);
	let ok = true;
	const texts = [];
	for (const src of sources) {
		if (src && typeof src === "object" && "file" in src) {
			const text = checkStaticSource(ctx, where, src);
			if (text === null) ok = false;
			else texts.push(text);
		} else if (src && typeof src === "object" && "computed" in src) {
			const before = ctx.errors.length;
			checkComputedSource(ctx, where, src, expected);
			if (ctx.errors.length > before) ok = false;
		} else {
			fail(ctx, where, `citation must be {file, line, text} or {computed, page, theme}, got ${JSON.stringify(src)}`);
			ok = false;
		}
	}
	if (requireStatic && !sources.some((src) => src && typeof src === "object" && "file" in src)) {
		fail(ctx, where, "cites no file:line source");
		return null;
	}
	return ok ? texts.join(" ") : null;
}

function checkAddition(ctx, where, rec, value, isColor) {
	if (typeof rec.reason !== "string" || !rec.reason.trim()) fail(ctx, where, "addition has no reason");
	const app = rec.app;
	if (!app || typeof app !== "object") return fail(ctx, where, "addition does not record the app's own value (app: {value|hex, source})");
	const appValue = isColor ? app.hex : app.value;
	if (isColor ? !HEX_RE.test(appValue ?? "") : typeof appValue !== "string" || !appValue) {
		return fail(ctx, where, `addition's app value is missing or malformed: ${JSON.stringify(appValue)}`);
	}
	if (normalize(appValue) === normalize(value)) fail(ctx, where, `addition equals the app's value ${appValue}; mark it measured`);
	const text = checkSources(ctx, `${where} (app value)`, app.source, appValue, { requireStatic: true });
	if (text !== null && !(isColor ? textHasColor(text, appValue) : textHasValue(text, appValue))) {
		fail(ctx, where, `app value ${appValue} does not appear in its cited text ${JSON.stringify(text)}`);
	}
}

function checkDerived(ctx, where, rec) {
	const d = rec.derived;
	if (!d || !HEX_RE.test(d.base ?? "") || !HEX_RE.test(d.over ?? "") || !(d.alpha > 0 && d.alpha < 1)) {
		return fail(ctx, where, "derived colour needs derived: {base: #hex, alpha: 0-1, over: #hex}");
	}
	const made = composite(hexToRgb(d.base), d.alpha, hexToRgb(d.over));
	if (maxChannelDiff(made, hexToRgb(rec.hex)) > CHANNEL_TOLERANCE) {
		fail(ctx, where, `${d.base} at ${d.alpha} over ${d.over} makes ${toHex(made)}, token says ${rec.hex}`);
	}
	const text = checkSources(ctx, where, rec.source, rec.hex, { requireStatic: true });
	if (text === null) return;
	if (!textHasColor(text, d.base)) fail(ctx, where, `base ${d.base} does not appear in the cited text`);
	if (!textHasAlpha(text, d.alpha)) fail(ctx, where, `alpha ${d.alpha} does not appear in the cited text`);
	if (!textHasColor(text, d.over)) fail(ctx, where, `backdrop ${d.over} does not appear in the cited text`);
}

function checkColorTheme(ctx, name, theme, entry) {
	const where = `color.${name} [${theme}]`;
	const rec = entry[theme];
	if (!rec || typeof rec !== "object") return fail(ctx, where, "missing");
	const origin = rec.origin ?? entry.origin;
	if (!ORIGINS.has(origin)) return fail(ctx, where, `origin must be measured, derived or addition, got ${JSON.stringify(origin)}`);
	if (!HEX_RE.test(rec.hex ?? "")) return fail(ctx, where, `hex must be #rrggbb, got ${JSON.stringify(rec.hex)}`);
	if (rec.value !== undefined) {
		const rgb = parseOklch(rec.value);
		if (!rgb) fail(ctx, where, `value must be oklch(L C H), got ${JSON.stringify(rec.value)}`);
		else if (maxChannelDiff(rgb, hexToRgb(rec.hex)) > CHANNEL_TOLERANCE) fail(ctx, where, `${rec.value} renders ${toHex(rgb)}, hex says ${rec.hex}`);
	}
	if (origin === "measured") {
		const text = checkSources(ctx, where, rec.source, rec.hex, { requireStatic: true });
		if (text !== null && !textHasColor(text, rec.hex)) fail(ctx, where, `${rec.hex} does not appear in the cited text ${JSON.stringify(text)}`);
	} else if (origin === "derived") {
		checkDerived(ctx, where, rec);
	} else {
		checkAddition(ctx, where, rec, rec.hex, true);
	}
}

function checkScalar(ctx, group, name, entry) {
	const where = `${group}.${name}`;
	if (!ORIGINS.has(entry.origin) || entry.origin === "derived") {
		return fail(ctx, where, `origin must be measured or addition, got ${JSON.stringify(entry.origin)}`);
	}
	if (typeof entry.value !== "string" || !entry.value.trim()) return fail(ctx, where, "has no value");
	if (entry.origin === "addition") return checkAddition(ctx, where, entry, entry.value, false);
	const text = checkSources(ctx, where, entry.source, entry.value, { requireStatic: true });
	if (text !== null && !textHasValue(text, entry.value)) {
		fail(ctx, where, `${entry.value} does not appear in the cited text ${JSON.stringify(text)}`);
	}
}

export function checkTokens(tokens, readFile, evidence = null) {
	const ctx = makeContext(readFile, evidence);
	for (const [name, entry] of Object.entries(tokens.color ?? {})) {
		ctx.tokens++;
		if (!entry || typeof entry !== "object") fail(ctx, `color.${name}`, "is not an object");
		else for (const theme of COLOR_THEMES) checkColorTheme(ctx, name, theme, entry);
	}
	for (const group of SCALAR_GROUPS) {
		for (const [name, entry] of Object.entries(tokens[group] ?? {})) {
			ctx.tokens++;
			if (!entry || typeof entry !== "object") fail(ctx, `${group}.${name}`, "is not an object");
			else checkScalar(ctx, group, name, entry);
		}
	}
	if (ctx.tokens === 0) fail(ctx, "(file)", "has no color, typography, spacing or radius tokens");
	// meta.source: the citation for which theme is the app's default (the one the dark tokens are measured from).
	if (tokens.meta?.source !== undefined) checkSources(ctx, "meta.source", tokens.meta.source, null, { requireStatic: true });
	const exit = ctx.missing.length ? 2 : ctx.errors.length ? 1 : 0;
	return { exit, ...ctx, readFile: undefined, evidence: undefined };
}

function loadJson(label, read) {
	try {
		return JSON.parse(read());
	} catch (err) {
		process.stderr.write(`check-token-provenance: cannot read ${label}: ${err.message.split("\n")[0]}\n`);
		process.exit(2);
	}
}

function main() {
	const opts = parseArgs(process.argv.slice(2));
	const readFile = makeFileReader(opts.root, opts.rev);
	const tokensLabel = opts.rev ? `${opts.rev}:${opts.tokens ?? DEFAULT_TOKENS}` : resolve(opts.tokens ?? resolve(opts.root, DEFAULT_TOKENS));
	const tokens = loadJson(tokensLabel, () => (opts.rev ? readFile(opts.tokens ?? DEFAULT_TOKENS).join("\n") : readFileSync(tokensLabel, "utf8")));
	const evidence = opts.evidence ? loadJson(opts.evidence, () => readFileSync(opts.evidence, "utf8")) : null;
	const result = checkTokens(tokens, readFile, evidence);
	if (opts.json) {
		const { exit, tokens: count, citations, computedVerified, computedUnverified, missing, errors } = result;
		process.stdout.write(`${JSON.stringify({ tokensFile: tokensLabel, exit, tokens: count, citations, computedVerified, computedUnverified, missing, errors }, null, 1)}\n`);
	} else {
		for (const e of result.missing) process.stdout.write(`MISSING ${e.token}: ${e.message}\n`);
		for (const e of result.errors) process.stdout.write(`FAIL ${e.token}: ${e.message}\n`);
		const computed = evidence
			? `${result.computedVerified} rendered citations verified against ${opts.evidence}`
			: `${result.computedUnverified} rendered citations shape-checked only (no --evidence)`;
		const verdict = result.exit === 0 ? "OK" : result.exit === 2 ? "MISSING FILE" : `${result.errors.length} problem(s)`;
		process.stdout.write(`check-token-provenance: ${verdict}: ${tokensLabel}: ${result.tokens} tokens, ${result.citations} citations; ${computed}\n`);
	}
	process.exit(result.exit);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
