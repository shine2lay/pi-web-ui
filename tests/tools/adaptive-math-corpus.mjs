#!/usr/bin/env node
/**
 * adaptive-math: run the markdown math layer over the assistant replies of real chats and list every
 * span it turns into a formula (counts + span shapes), next to what plain remark-math did before.
 *
 *   npx tsx tests/tools/adaptive-math-corpus.mjs [--last 30] [--exclude <session file>]... [--dir ~/.pi/agent/sessions]
 *
 * Reads ONLY the text parts of assistant messages: never system prompts, tool calls or tool results.
 * Prints span shapes (the formula source, cut to 80 characters), not the replies themselves.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { VFile } from "vfile";
import { remarkAdaptiveMath } from "../../web/src/components/md-adaptive-math.ts";

const args = process.argv.slice(2);
let last = 30;
let dir = join(homedir(), ".pi/agent/sessions");
const exclude = new Set();
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--last") last = Number(args[++i]);
	else if (args[i] === "--dir") dir = args[++i];
	else if (args[i] === "--exclude") exclude.add(resolve(args[++i]));
}

function sessionFiles(root) {
	const out = [];
	const walk = (d) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			const st = statSync(p);
			if (st.isDirectory()) walk(p);
			else if (name.endsWith(".jsonl")) out.push({ p, mtime: st.mtimeMs });
		}
	};
	walk(root);
	return out.sort((a, b) => b.mtime - a.mtime).map((f) => f.p);
}

/** The text parts of assistant messages, and nothing else. */
function replies(file) {
	const texts = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.includes('"assistant"')) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const msg = entry?.type === "message" ? entry.message : undefined;
		if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const part of msg.content) if (part?.type === "text" && typeof part.text === "string") texts.push(part.text);
	}
	return texts;
}

const before = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const after = unified()
	.use(remarkParse)
	.use(remarkGfm)
	.use(remarkMath, { singleDollarTextMath: false })
	.use(remarkAdaptiveMath);

function formulas(processor, text) {
	const file = new VFile({ value: text });
	const tree = processor.runSync(processor.parse(file), file);
	const found = [];
	const walk = (node) => {
		if (node.type === "inlineMath" || node.type === "math") {
			const src = text.slice(node.position.start.offset, node.position.end.offset);
			let kind = src.startsWith("$$") ? "$$" : src.startsWith("\\(") ? "\\(" : src.startsWith("\\[") ? "\\[" : "$";
			if (node.type === "math") kind += " (block)";
			found.push({ kind, src });
		}
		for (const c of node.children ?? []) walk(c);
	};
	walk(tree);
	return found;
}

const files = sessionFiles(dir)
	.filter((p) => !exclude.has(resolve(p)))
	.slice(0, last);
let replyCount = 0;
let dollars = 0;
let prices = 0;
let beforeSpans = 0;
const kinds = new Map();
const shapes = new Map();
const fixed = new Map();
let ms = 0;
for (const f of files) {
	for (const text of replies(f)) {
		replyCount++;
		dollars += (text.match(/\$/g) ?? []).length;
		prices += (text.match(/\$\d/g) ?? []).length;
		const old = formulas(before, text);
		beforeSpans += old.length;
		const t0 = performance.now();
		const now = formulas(after, text);
		ms += performance.now() - t0;
		const nowSet = new Set(now.map((x) => x.src));
		for (const o of old) {
			if (nowSet.has(o.src)) continue;
			const shape = o.src.replace(/\s+/g, " ").slice(0, 60);
			fixed.set(shape, (fixed.get(shape) ?? 0) + 1);
		}
		for (const x of now) {
			kinds.set(x.kind, (kinds.get(x.kind) ?? 0) + 1);
			const shape = `${x.kind.padEnd(10)} ${x.src.replace(/\s+/g, " ").slice(0, 80)}`;
			shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
		}
	}
}

console.log(`chats: ${files.length}, assistant replies: ${replyCount}, "$" signs: ${dollars}, "$"+digit: ${prices}`);
console.log(`plain remark-math (before): ${beforeSpans} spans drawn as math`);
console.log(
	`adaptive-math (now): ${[...kinds.values()].reduce((a, b) => a + b, 0)} spans as math, by kind:`,
	Object.fromEntries(kinds),
);
console.log(`layer time: ${ms.toFixed(0)} ms for all replies`);
console.log("\nEvery span drawn as a formula now (count × kind + source):");
for (const [shape, n] of [...shapes].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)} × ${shape}`);
console.log(
	`\nSpans that were math before and are text now: ${[...fixed.values()].reduce((a, b) => a + b, 0)} (first 15 shapes):`,
);
for (const [shape, n] of [...fixed].slice(0, 15)) console.log(`  ${String(n).padStart(3)} × ${shape}`);
// Text now, but with something formula-like inside (a TeX command, ^ or _ outside code): look at these by hand.
const suspects = [...fixed].filter(([shape]) => /\\[A-Za-z]|\^|_/.test(shape.replace(/`[^`]*`/g, "")));
console.log(`\nOf those, formula-like (a TeX command, ^ or _ outside code): ${suspects.length}`);
for (const [shape, n] of suspects) console.log(`  ${String(n).padStart(3)} × ${shape}`);
