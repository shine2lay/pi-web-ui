/**
 * test-import-graph.mjs: which files import which, in a checkout's source code (Ops #693, docs/gate-selected-tests.md).
 * scripts/select-tests.mjs walks it backwards from the changed files to the unit test files that can load them.
 *
 * One job: the static import graph. It reads each JavaScript/TypeScript file's import specifiers with regular
 * expressions, not a parser: a parser that builds a syntax tree took 15 s for the repo's 1,700 files (33 MB, the
 * vendored bundles included), the expressions take well under one. They err on the side of more edges: a specifier
 * in a comment or a string still counts, an import used only as a type counts. The one edge left out is a pure type
 * import (every `from "x"` of that specifier in the file is an `import type` / `export type` statement): TypeScript
 * erases it, so the imported file never runs because of it. What only a running test can show (a computed
 * `import(path)`, a file read by path) is the read map's part (scripts/test-read-map.mjs).
 *
 * Only relative specifiers ("./", "../") and root ones ("/") lead to files here; a bare one ("vitest",
 * "node:fs") is a package, and a package changes only with package.json or package-lock.json, which run every test.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";

/** The files the graph reads: JavaScript and TypeScript, every flavour. */
export const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

// One pass finds every string literal (one line; a template one with ${...} is dropped) that follows one of the
// words that name a module: from "a" (import x from, export { y } from, export * from), import "a", import("a"),
// require("a"), import.meta.resolve("a"), new URL("a", ...).
const SPECIFIER = /\b(from|import|require|URL|(?<=import\.meta\.)resolve)\s*\(?\s*(["'`])([^"'`\n]+)\2/g;
// import type X from "a"; import type { X } from "a"; import type * as X from "a"; export type { X } from "a";
// export type * from "a"; export type * as X from "a".
const TYPE_ONLY_STATEMENT =
	/\b(?:import|export)\s+type\s+(?:[\w$]+|\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?)\s*from\s*(["'`])([^"'`\n]+)\1/g;
const MAY_HAVE_TYPE_STATEMENT = /\b(?:import|export)\s+type\b/;

const specCache = new Map();

/** The specifiers a file's text imports, without the pure type imports, each once, in no special order. */
export function importSpecifiers(text) {
	const cached = specCache.get(text);
	if (cached !== undefined) return cached;
	const named = new Map(); // specifier -> how many times; the `from` ones and the others apart
	for (const m of text.matchAll(SPECIFIER)) {
		if (m[2] === "`" && m[3].includes("${")) continue;
		const counts = named.get(m[3]) ?? { from: 0, other: 0 };
		if (m[1] === "from") counts.from++;
		else counts.other++;
		named.set(m[3], counts);
	}
	let result;
	if (!MAY_HAVE_TYPE_STATEMENT.test(text)) {
		result = [...named.keys()];
	} else {
		// A specifier that only type statements name is a pure type import.
		const typeOnly = new Map();
		for (const m of text.matchAll(TYPE_ONLY_STATEMENT)) typeOnly.set(m[2], (typeOnly.get(m[2]) ?? 0) + 1);
		result = [...named]
			.filter(([spec, counts]) => counts.other > 0 || counts.from !== typeOnly.get(spec))
			.map(([spec]) => spec);
	}
	if (specCache.size >= 2500) specCache.clear();
	specCache.set(text, result);
	return result;
}

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
// TypeScript's ESM style names the output file: "./a.js" means a.ts (or a.tsx) in the source.
const SOURCE_FOR = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };

/**
 * The paths (from the top of the checkout) that `specifier`, imported by `importer`, can mean, most likely first,
 * or [] for a package. `root` is the checkout's top folder.
 */
export function candidatePaths(root, importer, specifier) {
	const bare = specifier.replace(/[?#].*$/, "");
	if (bare === "") return [];
	let absolute;
	if (bare.startsWith("./") || bare.startsWith("../") || bare === "." || bare === "..") {
		absolute = resolve(root, dirname(importer), bare);
	} else if (bare.startsWith("/")) {
		// vite reads "/x" from the project's top folder first, node from the disk's.
		const fromTop = resolve(root, `.${bare}`);
		absolute = bare.startsWith(root + sep) || bare === root ? normalize(bare) : fromTop;
	} else {
		return [];
	}
	const path = relative(root, absolute);
	if (path.startsWith("..") || path === "") return [];
	const found = [path];
	const dot = path.lastIndexOf(".");
	const extension = dot > path.lastIndexOf("/") ? path.slice(dot) : "";
	for (const swap of SOURCE_FOR[extension] ?? []) found.push(path.slice(0, dot) + swap);
	for (const add of EXTENSIONS) found.push(path + add);
	for (const add of EXTENSIONS) found.push(join(path, `index${add}`));
	return found;
}

const diskSpecCache = new Map();

function diskImportCandidates(root, importer) {
	const full = join(root, importer);
	const st = statSync(full);
	const hit = diskSpecCache.get(full);
	if (hit !== undefined && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
		return hit.candidates;
	}
	const specs = importSpecifiers(readFileSync(full, "utf8"));
	const candidates = specs.map((specifier) => candidatePaths(root, importer, specifier));
	if (diskSpecCache.size >= 4000) diskSpecCache.clear();
	diskSpecCache.set(full, { size: st.size, mtimeMs: st.mtimeMs, candidates });
	return candidates;
}

/**
 * The graph of the files `paths` (from the top of the checkout at `root`; only the JavaScript and TypeScript ones
 * are read), each edge resolved against the same set of paths: { importers, unread } where `importers` maps a path
 * to the set of paths that import it, and `unread` lists the files that couldn't be read. `readText(path)` reads a
 * file's text (default: from the disk under `root`, cached by file size and mtime).
 */
export function buildImportGraph(root, paths, readText) {
	const known = new Set(paths);
	const importers = new Map();
	const unread = [];
	for (const importer of paths) {
		if (!SOURCE_FILE.test(importer)) continue;
		let candidateLists;
		try {
			if (readText !== undefined) {
				const custom = readText(importer);
				candidateLists =
					custom === undefined
						? diskImportCandidates(root, importer)
						: importSpecifiers(custom).map((specifier) => candidatePaths(root, importer, specifier));
			} else {
				candidateLists = diskImportCandidates(root, importer);
			}
		} catch {
			unread.push(importer);
			continue;
		}
		for (const list of candidateLists) {
			const target = list.find((path) => known.has(path));
			if (target === undefined || target === importer) continue;
			let set = importers.get(target);
			if (set === undefined) importers.set(target, (set = new Set()));
			set.add(importer);
		}
	}
	return { importers, unread };
}

/** Every path that imports one of `paths`, directly or through others, `paths` themselves included. */
export function importClosure(importers, paths) {
	const reached = new Set(paths);
	const queue = [...paths];
	while (queue.length > 0) {
		for (const importer of importers.get(queue.pop()) ?? []) {
			if (reached.has(importer)) continue;
			reached.add(importer);
			queue.push(importer);
		}
	}
	return reached;
}

/** Every path that `paths` import, directly or through others, `paths` themselves included (the forward walk). */
export function importedBy(importers, paths) {
	const imports = new Map(); // importer -> its imports
	for (const [target, set] of importers) {
		for (const importer of set) {
			let list = imports.get(importer);
			if (list === undefined) imports.set(importer, (list = []));
			list.push(target);
		}
	}
	const reached = new Set(paths);
	const queue = [...paths];
	while (queue.length > 0) {
		for (const target of imports.get(queue.pop()) ?? []) {
			if (reached.has(target)) continue;
			reached.add(target);
			queue.push(target);
		}
	}
	return reached;
}
