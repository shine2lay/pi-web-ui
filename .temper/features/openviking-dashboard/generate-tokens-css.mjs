#!/usr/bin/env node
// Mechanically generates the CSS token block from .temper/design/tokens.json
// and optionally injects or verifies it in prototype/index.html.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOKENS = resolve(HERE, "../../design/tokens.json");
const DEFAULT_PROTO = resolve(HERE, "./prototype/index.html");
const START_MARKER = "/* BEGIN GENERATED TOKENS (from .temper/design/tokens.json) */";
const END_MARKER = "/* END GENERATED TOKENS */";

export function buildTokensCssBlock(tokens) {
	const rootLines = [];
	const lightLines = [];

	for (const [name, entry] of Object.entries(tokens.color || {})) {
		if (entry?.dark?.hex) rootLines.push(`  --${name}: ${entry.dark.hex};`);
		if (entry?.light?.hex) lightLines.push(`  --${name}: ${entry.light.hex};`);
	}
	for (const group of ["typography", "spacing", "radius"]) {
		for (const [name, entry] of Object.entries(tokens[group] || {})) {
			if (entry?.value) rootLines.push(`  --${name}: ${entry.value};`);
		}
	}

	return [
		START_MARKER,
		":root {",
		...rootLines,
		"}",
		'html[data-theme="light"] {',
		...lightLines,
		"}",
		END_MARKER,
	].join("\n");
}

function main() {
	const args = process.argv.slice(2);
	let tokensPath = DEFAULT_TOKENS;
	let protoPath = null;
	let checkOnly = false;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--tokens" && args[i + 1]) {
			tokensPath = resolve(args[++i]);
		} else if (args[i] === "--inject") {
			protoPath = args[i + 1] && !args[i + 1].startsWith("-") ? resolve(args[++i]) : DEFAULT_PROTO;
		} else if (args[i] === "--check") {
			checkOnly = true;
			protoPath = args[i + 1] && !args[i + 1].startsWith("-") ? resolve(args[++i]) : DEFAULT_PROTO;
		}
	}

	const tokens = JSON.parse(readFileSync(tokensPath, "utf8"));
	const block = buildTokensCssBlock(tokens);

	if (!protoPath) {
		process.stdout.write(`${block}\n`);
		return;
	}

	const html = readFileSync(protoPath, "utf8");
	const startIdx = html.indexOf(START_MARKER);
	const endIdx = html.indexOf(END_MARKER);
	if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
		process.stderr.write(`generate-tokens-css: missing token markers in ${protoPath}\n`);
		process.exit(2);
	}
	const updated = html.slice(0, startIdx) + block + html.slice(endIdx + END_MARKER.length);
	if (checkOnly) {
		if (updated !== html) {
			process.stderr.write(`generate-tokens-css: token block drift detected in ${protoPath}\n`);
			process.exit(1);
		}
		process.stdout.write(`generate-tokens-css: OK (${protoPath} matches ${tokensPath})\n`);
		return;
	}
	writeFileSync(protoPath, updated, "utf8");
	process.stdout.write(`generate-tokens-css: injected tokens into ${protoPath}\n`);
}

main();
