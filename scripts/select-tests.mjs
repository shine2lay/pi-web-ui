#!/usr/bin/env node
/**
 * select-tests.mjs: picks the unit test files a change can affect for `scripts/check.sh --fast`
 * (Ops #693, docs/gate-selected-tests.md).
 *
 *   node scripts/select-tests.mjs               # prints "all <reason>" or one test path per line
 *   node scripts/select-tests.mjs --for-check   # line 1: "unit tests: ..." summary; lines 2+: test paths (none for all)
 *
 * Range: WT_BASE..WT_HEAD from wt (Ops #691). When WT_BASE is unset or unusable, or when any changed path can affect
 * every test or isn't understood by the selector, it prints `all <reason>` so check.sh runs the full unit suite.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { changedFiles, commitOf, filesAt, gitTop, isAncestor } from "./changed-files.mjs";
import { isMainModule } from "./is-main-module.mjs";
import { buildImportGraph, importClosure, importedBy, SOURCE_FILE } from "./test-import-graph.mjs";
import { findMap, mapFolder } from "./test-read-map-store.mjs";
import { isUnitTestFile, UNIT_TEST_INCLUDE } from "./unit-test-files.mjs";

const GATE_AND_SELECTOR_FILES = new Set([
	"scripts/check.sh",
	"scripts/sealed.sh",
	"scripts/sealed-summary.mjs",
	"tests/lib/sealed-test-launch.mjs",
	"tests/lib/sealed-fence.cjs",
	"scripts/select-tests.mjs",
	"scripts/changed-files.mjs",
	"scripts/is-main-module.mjs",
	"scripts/test-import-graph.mjs",
	"scripts/test-read-map.mjs",
	"scripts/test-read-map-store.mjs",
	"scripts/unit-test-files.mjs",
	"tests/lib/record-file-reads.ts",
	"tests/lib/file-read-recorder.cjs",
]);

/** Reads setupFiles and include from vitest.config.ts; returns { setupFiles } or { error }. */
export function readVitestConfig(root) {
	let text;
	try {
		text = readFileSync(join(root, "vitest.config.ts"), "utf8");
	} catch (error) {
		return { error: `vitest.config.ts unreadable (${error.code ?? error.message})` };
	}
	const includeMatch = text.match(/\binclude\s*:\s*\[([\s\S]*?)\]/);
	if (!includeMatch) return { error: "vitest.config.ts has no include list" };
	const includes = [...includeMatch[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
	if (includes.length !== 1 || includes[0] !== UNIT_TEST_INCLUDE) {
		return { error: `vitest.config.ts include changed (${includes.join(", ")})` };
	}
	const setupMatch = text.match(/\bsetupFiles\s*:\s*\[([\s\S]*?)\]/);
	if (!setupMatch) return { error: "vitest.config.ts has no setupFiles list" };
	const setupFiles = [...setupMatch[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1].replace(/^\.\//, ""));
	if (setupFiles.length === 0) return { error: "vitest.config.ts setupFiles is empty" };
	return { setupFiles };
}

/** Whether `path` is a repo note covered by check.sh's notes_paths check (PATCHES.md or docs/*.md). */
export function isNotesPath(path) {
	return path === "PATCHES.md" || (path.startsWith("docs/") && path.endsWith(".md"));
}

/** If `path` alone forces a full unit test run, returns the reason; otherwise undefined. */
export function alwaysFullRunReason(path, setupFiles) {
	const base = basename(path);
	if (
		path === "package.json" ||
		path === "package-lock.json" ||
		base === "package.json" ||
		base === "package-lock.json"
	) {
		return `${path} changed`;
	}
	if (/^vitest.*\.config\.[^/]+$/.test(base) || /^vite.*\.config\.[^/]+$/.test(base)) {
		return `${path} changed`;
	}
	if (/^tsconfig.*\.json$/.test(base)) {
		return `${path} changed`;
	}
	if (setupFiles.includes(path)) {
		return `setup file ${path} changed`;
	}
	if (GATE_AND_SELECTOR_FILES.has(path)) {
		return `gate/selector file ${path} changed`;
	}
	return undefined;
}

function isInDir(path, dir) {
	if (dir === "." || dir === "") return !path.includes("/");
	return dirname(path) === dir;
}

function isUnderTree(path, tree) {
	if (tree === "." || tree === "") return true;
	return path === tree || path.startsWith(`${tree}/`);
}

/**
 * Build output is gitignored, so no change ever names it: a read map path inside it is traced back to what it is
 * built from (docs/gate-selected-tests.md, "Build output").
 * - dist/server: tsc's output of server/ (tsconfig.server.json: rootDir server, outDir dist/server), file by file,
 *   plus the runtime files scripts/copy-dsh-runtime.mjs copies there as they are.
 * - web/dist: vite's one bundle of the web app (web/vite.config.ts), which any file under web/ or imported from it
 *   can change.
 * - Any other dist/ path isn't traced: a test that uses it runs on every change.
 */
const BUILD_OUTPUTS = [
	{ output: "dist/server", source: "server", fileByFile: true },
	{ output: "web/dist", source: "web", fileByFile: false },
	{ output: "dist", source: undefined, fileByFile: false },
];

/** For a path in build output: { sources } (file by file), { bundle } (a source tree), { untraced: true }; else undefined. */
export function builtFrom(path) {
	for (const { output, source, fileByFile } of BUILD_OUTPUTS) {
		if (path !== output && !path.startsWith(`${output}/`)) continue;
		if (source === undefined) return { untraced: true };
		if (!fileByFile) return { bundle: source };
		const sourcePath = source + path.slice(output.length);
		return { sources: sourcePath.endsWith(".js") ? [sourcePath, `${sourcePath.slice(0, -3)}.ts`] : [sourcePath] };
	}
	return undefined;
}

function buildReadIndex(map, existingUnitTests) {
	const byFile = new Map();
	const byModule = new Map();
	const dirReaders = [];
	const treeReaders = [];
	const bundleReaders = new Map(); // source tree of a bundle -> tests that use the bundle
	const everyChangeReaders = new Set(); // tests that use build output the selector can't trace
	const knownPaths = new Set();
	const knownDirs = new Set();
	const knownTrees = new Set();

	const addTo = (table, key, test) => {
		let set = table.get(key);
		if (set === undefined) table.set(key, (set = new Set()));
		set.add(test);
	};
	const recordAs = {
		reads(p, test) {
			knownPaths.add(p);
			addTo(byFile, p, test);
		},
		modules(p, test) {
			knownPaths.add(p);
			addTo(byModule, p, test);
		},
		dirs(p, test) {
			knownDirs.add(p);
			dirReaders.push([p, test]);
		},
		trees(p, test) {
			knownTrees.add(p);
			treeReaders.push([p, test]);
		},
	};

	for (const [test, entry] of Object.entries(map.tests ?? {})) {
		if (!existingUnitTests.has(test) || !entry || typeof entry !== "object") continue;
		for (const [kind, record] of Object.entries(recordAs)) {
			for (const p of entry[kind] ?? []) {
				record(p, test);
				const built = builtFrom(p);
				if (built === undefined) continue;
				if (built.sources) {
					for (const source of built.sources) record(source, test);
				} else if (built.bundle) {
					recordAs.trees(built.bundle, test);
					addTo(bundleReaders, built.bundle, test);
				} else {
					everyChangeReaders.add(test);
				}
			}
		}
	}

	return {
		bundleReaders,
		everyChangeReaders,
		isKnown(path) {
			if (knownPaths.has(path)) return true;
			for (const d of knownDirs) {
				if (isInDir(path, d)) return true;
			}
			for (const t of knownTrees) {
				if (isUnderTree(path, t)) return true;
			}
			return false;
		},
		readersOf(path) {
			const out = new Set();
			for (const t of byFile.get(path) ?? []) out.add(t);
			for (const [d, t] of dirReaders) {
				if (isInDir(path, d)) out.add(t);
			}
			for (const [tree, t] of treeReaders) {
				if (isUnderTree(path, tree)) out.add(t);
			}
			return out;
		},
		moduleImportersOf(paths) {
			const out = new Set();
			for (const p of paths) {
				for (const t of byModule.get(p) ?? []) out.add(t);
			}
			return out;
		},
	};
}

/**
 * Selects unit tests for a change range.
 * Options (all optional, for unit tests of the selector):
 * - cwd: repo checkout path
 * - env: environment object (reads WT_BASE, WT_HEAD, PI_TEST_READ_MAP_DIR)
 * - mapDir: read-map folder override
 * - includeDirty: when true (default when WT_HEAD is unset or equals HEAD), include uncommitted working-tree changes
 * - related(root, changedPaths, allFiles): replaces the built-in import walk (for the selector's own tests);
 *   returns the related test files, string[] | { error: string }
 */
export function selectTests(options = {}) {
	const env = options.env ?? process.env;
	const top = gitTop(options.cwd ?? process.cwd());
	if (top.error !== undefined) return { all: `not a git checkout (${top.error})`, total: 0 };
	const { root } = top;

	const headCommit = commitOf(root, "HEAD");
	if (headCommit.error !== undefined) return { all: "HEAD is not a commit", total: 0 };

	const wtHeadRaw = (env.WT_HEAD ?? "").trim();
	const targetRef = wtHeadRaw || "HEAD";
	const targetCommit = commitOf(root, targetRef);
	if (targetCommit.error !== undefined) {
		return { all: `WT_HEAD (${wtHeadRaw}) is not a commit`, total: 0 };
	}

	const listed = filesAt(root, targetCommit.sha);
	if (listed.error !== undefined) return { all: `cannot list repo files (${listed.error})`, total: 0 };
	const allFiles = listed.files;
	const unitTests = allFiles.filter(isUnitTestFile);
	const unitTestSet = new Set(unitTests);
	const total = unitTests.length;

	const wtBaseRaw = (env.WT_BASE ?? "").trim();
	if (!wtBaseRaw) return { all: "WT_BASE is not set", total };

	const baseCommit = commitOf(root, wtBaseRaw);
	if (baseCommit.error !== undefined) return { all: `WT_BASE (${wtBaseRaw}) is not a commit`, total };
	if (!isAncestor(root, baseCommit.sha, targetCommit.sha)) {
		return {
			all: `WT_BASE (${baseCommit.sha.slice(0, 7)}) is not an ancestor of WT_HEAD (${targetCommit.sha.slice(0, 7)})`,
			total,
		};
	}

	const cfg = readVitestConfig(root);
	if (cfg.error !== undefined) return { all: cfg.error, total };

	const includeDirty = options.includeDirty ?? (wtHeadRaw === "" || targetCommit.sha === headCommit.sha);
	const diff = changedFiles(root, baseCommit.sha, includeDirty ? undefined : targetCommit.sha);
	if (diff.error !== undefined) return { all: `git diff failed (${diff.error})`, total };
	if (diff.files.length === 0) return { all: "the range changes no files", total };

	for (const entry of diff.files) {
		const reason = alwaysFullRunReason(entry.path, cfg.setupFiles);
		if (reason !== undefined) return { all: reason, total };
	}

	for (const entry of diff.files) {
		if (entry.deleted && !isUnitTestFile(entry.path)) {
			return { all: `deleted or renamed non-test file ${entry.path}`, total };
		}
	}

	const folder = options.mapDir ?? mapFolder(env);
	const foundMap = findMap(root, folder, baseCommit.sha);
	if (foundMap.none !== undefined) return { all: foundMap.none, total };
	const { map } = foundMap;

	const diffPathSet = new Set(diff.files.map((e) => e.path));
	const readSource =
		!includeDirty && targetCommit.sha !== headCommit.sha
			? (path) => {
					if (!diffPathSet.has(path) && existsSync(join(root, path))) {
						return undefined;
					}
					const blob = spawnSync("git", ["show", `${targetCommit.sha}:${path}`], {
						cwd: root,
						encoding: "utf8",
						maxBuffer: 64 * 1024 * 1024,
					});
					if (blob.status === 0) return blob.stdout;
					throw new Error(`unreadable ${path}`);
				}
			: undefined;
	const graph = buildImportGraph(root, allFiles, readSource);
	if (graph.unread.length > 0) {
		return { all: `unreadable source file ${graph.unread[0]}`, total };
	}
	const setupClosure = importedBy(graph.importers, ["vitest.config.ts", ...cfg.setupFiles]);
	for (const entry of diff.files) {
		if (setupClosure.has(entry.path)) {
			return { all: `setup dependency ${entry.path} changed`, total };
		}
	}

	const readIndex = buildReadIndex(map, unitTestSet);

	const changedPaths = [];
	// Every changed path still there starts the import walk, not only JavaScript and TypeScript: an asset a module
	// imports ("./page.html?raw", a JSON file) reaches the tests that import that module, and a test that loaded the
	// asset itself as a module (a computed import the graph can't see) is in the read map's modules.
	const importWalkStart = [];
	const changedTestsSet = new Set();

	for (const entry of diff.files) {
		const { path, deleted } = entry;
		changedPaths.push(path);
		if (deleted) continue;
		importWalkStart.push(path);
		if (isUnitTestFile(path)) {
			if (unitTestSet.has(path)) changedTestsSet.add(path);
			continue;
		}
		if (isNotesPath(path)) continue;
		const isImportable = SOURCE_FILE.test(path) || graph.importers.has(path);
		if (!isImportable && !readIndex.isKnown(path)) {
			return { all: `unknown path ${path}`, total };
		}
	}

	const relatedSet = new Set();
	if (importWalkStart.length > 0) {
		if (typeof options.related === "function") {
			const custom = options.related(root, importWalkStart, allFiles);
			if (custom && typeof custom === "object" && "error" in custom) {
				return { all: `related failed (${custom.error})`, total };
			}
			for (const t of custom ?? []) {
				if (unitTestSet.has(t)) relatedSet.add(t);
			}
		} else {
			const reached = importClosure(graph.importers, importWalkStart);
			for (const p of reached) {
				if (unitTestSet.has(p)) relatedSet.add(p);
			}
			for (const t of readIndex.moduleImportersOf(reached)) {
				if (unitTestSet.has(t)) relatedSet.add(t);
			}
		}
		// A changed test is selected as changed; related counts only the tests it reaches (a test importing it).
		for (const t of changedTestsSet) relatedSet.delete(t);
	}

	const readMapSet = new Set();
	for (const path of changedPaths) {
		for (const t of readIndex.readersOf(path)) {
			if (unitTestSet.has(t)) readMapSet.add(t);
		}
	}
	// A bundle also holds what its source tree imports from outside it (readersOf already covers the tree itself).
	for (const [tree, readers] of readIndex.bundleReaders) {
		const bundleInputs = importedBy(
			graph.importers,
			allFiles.filter((f) => isUnderTree(f, tree)),
		);
		if (!changedPaths.some((p) => bundleInputs.has(p))) continue;
		for (const t of readers) {
			if (unitTestSet.has(t)) readMapSet.add(t);
		}
	}
	for (const t of readIndex.everyChangeReaders) {
		if (unitTestSet.has(t)) readMapSet.add(t);
	}

	const sinceMapSet = new Set();
	for (const t of map.incomplete ?? []) {
		if (unitTestSet.has(t)) sinceMapSet.add(t);
	}
	if (map.commit !== baseCommit.sha) {
		const sinceMapDiff = changedFiles(root, map.commit, baseCommit.sha);
		if (sinceMapDiff.error !== undefined) {
			return { all: `git diff since read map failed (${sinceMapDiff.error})`, total };
		}
		for (const entry of sinceMapDiff.files) {
			if (!entry.deleted && unitTestSet.has(entry.path)) sinceMapSet.add(entry.path);
		}
	}

	const selected = new Set([...relatedSet, ...readMapSet, ...changedTestsSet, ...sinceMapSet]);
	const files = [...selected].sort();
	const counts = {
		related: relatedSet.size,
		readMap: readMapSet.size,
		changedTests: changedTestsSet.size,
		sinceMap: sinceMapSet.size,
	};
	const parts = [];
	if (counts.related > 0) parts.push(`${counts.related} related`);
	if (counts.readMap > 0) parts.push(`${counts.readMap} read map`);
	if (counts.changedTests > 0) parts.push(`${counts.changedTests} changed`);
	if (counts.sinceMap > 0) parts.push(`${counts.sinceMap} since map ${map.commit.slice(0, 7)}`);
	// Nothing selected is rare (none of the last 100 code changes on mine): run everything rather than nothing.
	if (files.length === 0) return { all: `no unit test reaches the change, map ${map.commit.slice(0, 7)}`, total };
	const why = `${parts.join(", ")}, map ${map.commit.slice(0, 7)}`;

	return { files, total, why, counts, mapCommit: map.commit };
}

/** Formats the one-line summary that scripts/check.sh prints. */
export function formatCheckSummary(result) {
	if (result.all !== undefined) return `unit tests: all (${result.all})`;
	return `unit tests: ${result.files.length} of ${result.total} files (${result.why})`;
}

function main(argv = process.argv.slice(2)) {
	const forCheck = argv.includes("--for-check");
	const result = selectTests();
	if (forCheck) {
		console.log(formatCheckSummary(result));
		if (result.all === undefined) {
			for (const file of result.files) console.log(file);
		}
		return 0;
	}
	if (result.all !== undefined) {
		console.log(`all ${result.all}`);
		return 0;
	}
	for (const file of result.files) console.log(file);
	return 0;
}

if (isMainModule(import.meta.url)) process.exit(main());
