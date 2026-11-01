import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { changedFiles, commitOf, filesAt, isAncestor } from "../../scripts/changed-files.mjs";
import {
	alwaysFullRunReason,
	formatCheckSummary,
	isNotesPath,
	readVitestConfig,
	selectTests,
} from "../../scripts/select-tests.mjs";
import { buildMap, mergeRecords } from "../../scripts/test-read-map.mjs";
import { findMap, MAP_VERSION, writeMap } from "../../scripts/test-read-map-store.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(repo, "scripts", "select-tests.mjs");
const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(dir: string, relPath: string, content = "export const x = 1;\n"): void {
	const full = join(dir, relPath);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content);
}

const VITEST_CONFIG = `import { defineConfig } from "vitest/config";
export default defineConfig({
	test: {
		include: ["tests/unit/**/*.test.ts"],
		setupFiles: [
			"tests/lib/record-file-reads.ts",
			"tests/unit/setup-temp-pi-dirs.ts",
		],
	},
});
`;

/** Makes a small git checkout with 3 unit test files and a read map at its initial commit. */
function makeRepo() {
	const root = mkdtempSync(join(tmpdir(), "pi-select-tests-"));
	tempDirs.push(root);
	const dir = join(root, "repo");
	const mapDir = join(root, "maps");
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q", "-b", "mine");
	git(dir, "config", "user.email", "test@example.com");
	git(dir, "config", "user.name", "Test");

	write(dir, "vitest.config.ts", VITEST_CONFIG);
	write(dir, "tests/lib/record-file-reads.ts", "export {};\n");
	write(dir, "tests/unit/setup-helper.ts", "export const setupHelp = () => 1;\n");
	write(dir, "tests/unit/setup-temp-pi-dirs.ts", 'import { setupHelp } from "./setup-helper.js";\nsetupHelp();\n');
	write(dir, "server/leaf.ts", "export const leaf = () => 1;\n");
	write(dir, "server/mid.ts", 'import { leaf } from "./leaf.js";\nexport const mid = () => leaf();\n');
	write(dir, "server/read-only.ts", "export const magic = 'v1';\n");
	write(dir, "web/view.html", "<div>v1</div>\n");
	write(dir, "tests/fixtures/items/a.json", '{"ok":true}\n');
	write(
		dir,
		"tests/unit/alpha.test.ts",
		'import { mid } from "../../server/mid.js";\nexport const run = () => mid();\n',
	);
	write(dir, "tests/unit/beta.test.ts", "export const beta = 1;\n");
	write(dir, "tests/unit/gamma.test.ts", "export const gamma = 1;\n");

	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "base");
	const baseSha = git(dir, "rev-parse", "HEAD");

	const mapFile = writeMap(mapDir, {
		v: MAP_VERSION,
		commit: baseSha,
		createdAt: "2026-10-31T00:00:00.000Z",
		tests: {
			"tests/unit/alpha.test.ts": {
				reads: [],
				dirs: [],
				trees: [],
				modules: ["tests/unit/alpha.test.ts", "server/mid.ts", "server/leaf.ts"],
			},
			"tests/unit/beta.test.ts": {
				reads: ["server/read-only.ts", "web/view.html"],
				dirs: ["tests/fixtures/items"],
				trees: [],
				modules: ["tests/unit/beta.test.ts"],
			},
			"tests/unit/gamma.test.ts": {
				reads: [],
				dirs: [],
				trees: ["themes"],
				modules: ["tests/unit/gamma.test.ts"],
			},
		},
		incomplete: [],
		run: { exitCode: 0, seconds: 1, failed: [] },
	});

	return { dir, mapDir, baseSha, mapFile };
}

function commitAll(dir: string, message: string): string {
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", message);
	return git(dir, "rev-parse", "HEAD");
}

function runCli(dir: string, mapDir: string, env: Record<string, string | undefined>, ...args: string[]) {
	const mergedEnv: NodeJS.ProcessEnv = { ...process.env, PI_TEST_READ_MAP_DIR: mapDir };
	// The landing check runs this file with wt's range set; the CLI under test sees only the range each case gives.
	delete mergedEnv.WT_BASE;
	delete mergedEnv.WT_HEAD;
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) delete mergedEnv[k];
		else mergedEnv[k] = v;
	}
	const r = spawnSync(process.execPath, [script, ...args], { cwd: dir, env: mergedEnv, encoding: "utf8" });
	return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

describe("changed-files: shared git diff helper", () => {
	it("lists added, modified, renamed (old + new) and deleted files between base and head", () => {
		const { dir, baseSha } = makeRepo();
		git(dir, "mv", "server/read-only.ts", "server/renamed.ts");
		unlinkSync(join(dir, "web/view.html"));
		write(dir, "server/added.ts", "export const a = 1;\n");
		const headSha = commitAll(dir, "changes");

		const diff = changedFiles(dir, baseSha, headSha);
		expect(diff.error).toBeUndefined();
		expect(diff.files).toEqual([
			{ path: "server/added.ts", status: "A", deleted: false },
			{ path: "server/read-only.ts", status: "D", deleted: true },
			{ path: "server/renamed.ts", status: "A", deleted: false },
			{ path: "web/view.html", status: "D", deleted: true },
		]);
		expect(isAncestor(dir, baseSha, headSha)).toBe(true);
		expect(isAncestor(dir, headSha, baseSha)).toBe(false);
		expect(commitOf(dir, "HEAD").sha).toBe(headSha);
		expect(filesAt(dir, headSha).files).toContain("server/renamed.ts");
	});
});

describe("test-read-map: recorder merge and store permissions", () => {
	it("writes 0600 map files and merges reads, dirs, trees, modules and incomplete tests", () => {
		const { mapFile } = makeRepo();
		expect(statSync(mapFile).mode & 0o777).toBe(0o600);

		const rawDir = mkdtempSync(join(tmpdir(), "pi-raw-map-"));
		tempDirs.push(rawDir);
		writeFileSync(
			join(rawDir, "1-1.jsonl"),
			[
				JSON.stringify(["tests/unit/alpha.test.ts", "r", "server/read-only.ts"]),
				JSON.stringify(["tests/unit/alpha.test.ts", "d", "tests/unit"]),
				JSON.stringify(["tests/unit/alpha.test.ts", "t", "themes"]),
				JSON.stringify(["tests/unit/alpha.test.ts", "m", "server/mid.ts"]),
				JSON.stringify(["tests/unit/alpha.test.ts", "c", "."]),
				"{corrupt trailing line",
			].join("\n") + "\n",
		);
		const merged = mergeRecords(rawDir);
		const map = buildMap({
			commit: "a".repeat(40),
			testFiles: ["tests/unit/alpha.test.ts", "tests/unit/beta.test.ts"],
			merged,
			failed: [],
			exitCode: 0,
			seconds: 2,
		});
		expect((map.tests as Record<string, unknown>)["tests/unit/alpha.test.ts"]).toEqual({
			reads: ["server/read-only.ts"],
			dirs: ["tests/unit"],
			trees: ["themes"],
			modules: ["server/mid.ts"],
		});
		// beta.test.ts had no completion record ("c"), so it is marked incomplete.
		expect(map.incomplete).toEqual(["tests/unit/beta.test.ts"]);
	});
});

describe("select-tests: unit test selection for scripts/check.sh --fast", () => {
	it("falls back to all when WT_BASE is unset, invalid, or not an ancestor of WT_HEAD", () => {
		const { dir, mapDir, baseSha } = makeRepo();
		write(dir, "server/leaf.ts", "export const leaf = () => 2;\n");
		const headSha = commitAll(dir, "edit leaf");

		expect(selectTests({ cwd: dir, mapDir, env: {} })).toMatchObject({ all: "WT_BASE is not set" });
		expect(selectTests({ cwd: dir, mapDir, env: { WT_BASE: "not-a-sha" } })).toMatchObject({
			all: "WT_BASE (not-a-sha) is not a commit",
		});
		expect(selectTests({ cwd: dir, mapDir, env: { WT_BASE: headSha, WT_HEAD: baseSha } }).all).toContain(
			"is not an ancestor",
		);
	});

	it("falls back to all when the range changes nothing or no unit test reaches the change", () => {
		const { dir, mapDir, baseSha } = makeRepo();
		expect(selectTests({ cwd: dir, mapDir, env: { WT_BASE: baseSha, WT_HEAD: baseSha } })).toMatchObject({
			all: "the range changes no files",
		});

		write(dir, "server/orphan.ts", "export const orphan = () => 1;\n");
		const headSha = commitAll(dir, "add a module no test imports or reads");
		const res = selectTests({ cwd: dir, mapDir, env: { WT_BASE: baseSha, WT_HEAD: headSha } });
		expect(res.all).toBe(`no unit test reaches the change, map ${baseSha.slice(0, 7)}`);
		expect(formatCheckSummary(res)).toBe(
			`unit tests: all (no unit test reaches the change, map ${baseSha.slice(0, 7)})`,
		);
	});

	it("falls back to all when no read map matches WT_BASE or its ancestors", () => {
		const { dir, baseSha } = makeRepo();
		const emptyMapDir = mkdtempSync(join(tmpdir(), "pi-empty-maps-"));
		tempDirs.push(emptyMapDir);
		write(dir, "server/leaf.ts", "export const leaf = () => 2;\n");
		const headSha = commitAll(dir, "edit leaf");

		const res = selectTests({
			cwd: dir,
			mapDir: emptyMapDir,
			env: { WT_BASE: baseSha, WT_HEAD: headSha },
		});
		expect(res.all).toContain("no read map");
		expect(findMap(dir, join(emptyMapDir, "missing"), baseSha).none).toContain("no read map folder");
	});

	it("falls back to all for every config, setupFiles, gate, selector and read-recorder trigger", () => {
		const repoConfig = readVitestConfig(repo);
		expect(repoConfig.error).toBeUndefined();
		const setupFiles = repoConfig.setupFiles!;

		const triggers = [
			"package.json",
			"package-lock.json",
			"vitest.config.ts",
			"vitest.e2e.config.mjs",
			"vite.config.ts",
			"web/vite.config.ts",
			"tsconfig.json",
			"tsconfig.question-coupled.json",
			"tests/lib/record-file-reads.ts",
			"tests/unit/setup-temp-pi-dirs.ts",
			"tests/unit/setup-chrome-i18n.ts",
			"tests/unit/setup-hang-guards.ts",
			"scripts/check.sh",
			"scripts/sealed.sh",
			"tests/lib/sealed-test-launch.mjs",
			"scripts/select-tests.mjs",
			"scripts/changed-files.mjs",
			"scripts/is-main-module.mjs",
			"scripts/test-import-graph.mjs",
			"scripts/test-read-map.mjs",
			"scripts/test-read-map-store.mjs",
			"scripts/unit-test-files.mjs",
			"tests/lib/file-read-recorder.cjs",
		];
		for (const file of triggers) {
			expect(alwaysFullRunReason(file, setupFiles), file).toBeTruthy();
		}
		expect(alwaysFullRunReason("server/index.ts", setupFiles)).toBeUndefined();

		const { dir, mapDir, baseSha } = makeRepo();
		write(dir, "tests/unit/setup-temp-pi-dirs.ts", "// changed setup file\n");
		const headSha = commitAll(dir, "touch setup file");
		expect(
			selectTests({
				cwd: dir,
				mapDir,
				env: { WT_BASE: baseSha, WT_HEAD: headSha },
			}),
		).toMatchObject({ all: "setup file tests/unit/setup-temp-pi-dirs.ts changed" });

		git(dir, "reset", "-q", "--hard", baseSha);
		write(dir, "tests/unit/setup-helper.ts", "export const setupHelp = () => 2;\n");
		const helperHead = commitAll(dir, "touch setup helper");
		expect(
			selectTests({
				cwd: dir,
				mapDir,
				env: { WT_BASE: baseSha, WT_HEAD: helperHead },
			}),
		).toMatchObject({ all: "setup dependency tests/unit/setup-helper.ts changed" });
	});

	it("falls back to all on an unknown path, and allows notes paths alongside code changes", () => {
		const { dir, mapDir, baseSha } = makeRepo();
		write(dir, "deploy/pi-web-ui.service", "[Service]\n");
		const unknownHead = commitAll(dir, "touch service file");
		expect(
			selectTests({
				cwd: dir,
				mapDir,
				env: { WT_BASE: baseSha, WT_HEAD: unknownHead },
			}),
		).toMatchObject({ all: "unknown path deploy/pi-web-ui.service" });

		const patchesMd = `${"PATCHES"}.${"md"}`;
		const gateDoc = `${"docs"}/gate-selected-tests.${"md"}`;
		expect(isNotesPath(patchesMd)).toBe(true);
		expect(isNotesPath(gateDoc)).toBe(true);
		expect(isNotesPath("deploy/pi-web-ui.service")).toBe(false);

		git(dir, "reset", "-q", "--hard", baseSha);
		write(dir, "server/leaf.ts", "export const leaf = () => 3;\n");
		write(dir, gateDoc, "# doc\n");
		const withNoteHead = commitAll(dir, "code + note");
		expect(
			selectTests({
				cwd: dir,
				mapDir,
				env: { WT_BASE: baseSha, WT_HEAD: withNoteHead },
			}).files,
		).toEqual(["tests/unit/alpha.test.ts"]);
	});

	it("falls back to all when a non-test file is deleted or renamed away", () => {
		const { dir, mapDir, baseSha } = makeRepo();
		unlinkSync(join(dir, "server/leaf.ts"));
		const delHead = commitAll(dir, "delete leaf");
		expect(
			selectTests({
				cwd: dir,
				mapDir,
				env: { WT_BASE: baseSha, WT_HEAD: delHead },
			}),
		).toMatchObject({ all: "deleted or renamed non-test file server/leaf.ts" });

		git(dir, "reset", "-q", "--hard", baseSha);
		git(dir, "mv", "server/leaf.ts", "server/leaf-renamed.ts");
		const renHead = commitAll(dir, "rename leaf");
		expect(
			selectTests({
				cwd: dir,
				mapDir,
				env: { WT_BASE: baseSha, WT_HEAD: renHead },
			}),
		).toMatchObject({ all: "deleted or renamed non-test file server/leaf.ts" });
	});

	it("selects only the renamed unit test file when a test file is renamed", () => {
		const { dir, mapDir, baseSha } = makeRepo();
		git(dir, "mv", "tests/unit/gamma.test.ts", "tests/unit/gamma-renamed.test.ts");
		const headSha = commitAll(dir, "rename test");
		const res = selectTests({
			cwd: dir,
			mapDir,
			env: { WT_BASE: baseSha, WT_HEAD: headSha },
		});
		expect(res.all).toBeUndefined();
		expect(res.files).toEqual(["tests/unit/gamma-renamed.test.ts"]);
	});

	it("selects a test that imports a changed test file", () => {
		const { dir, mapDir, baseSha } = makeRepo();
		write(dir, "tests/unit/canonical.test.ts", 'await import("./beta.test.js");\nexport {};\n');
		const midBase = commitAll(dir, "add canonical");
		write(dir, "tests/unit/beta.test.ts", "export const beta = 2;\n");
		const headSha = commitAll(dir, "edit beta");
		const res = selectTests({ cwd: dir, mapDir, env: { WT_BASE: midBase, WT_HEAD: headSha } });
		expect(res.all).toBeUndefined();
		expect(res.files).toEqual(["tests/unit/beta.test.ts", "tests/unit/canonical.test.ts"]);
		expect(res.counts).toMatchObject({ related: 1, changedTests: 1 });
		expect(baseSha).not.toBe(midBase);
	});

	it("selects related tests across the static import graph (related-only change)", () => {
		const { dir, mapDir, baseSha } = makeRepo();
		// Add a brand-new module imported by alpha.test.ts so only the static import graph knows the edge.
		write(dir, "server/new-helper.ts", "export const help = () => 42;\n");
		write(
			dir,
			"tests/unit/alpha.test.ts",
			'import { mid } from "../../server/mid.js";\nimport { help } from "../../server/new-helper.js";\nexport const run = () => mid() + help();\n',
		);
		const midBase = commitAll(dir, "add new-helper");
		// Rewrite the map at midBase without new-helper in modules, so only static import graph links new-helper -> alpha.
		writeMap(mapDir, {
			v: MAP_VERSION,
			commit: midBase,
			createdAt: "2026-10-31T00:00:00.000Z",
			tests: {
				"tests/unit/alpha.test.ts": { reads: [], dirs: [], trees: [], modules: ["tests/unit/alpha.test.ts"] },
				"tests/unit/beta.test.ts": { reads: ["server/read-only.ts"], dirs: [], trees: [], modules: [] },
				"tests/unit/gamma.test.ts": { reads: [], dirs: [], trees: [], modules: [] },
			},
			incomplete: [],
			run: { exitCode: 0, seconds: 1, failed: [] },
		});

		write(dir, "server/new-helper.ts", "export const help = () => 43;\n");
		const headSha = commitAll(dir, "edit new-helper");

		const res = selectTests({
			cwd: dir,
			mapDir,
			env: { WT_BASE: midBase, WT_HEAD: headSha },
		});
		expect(res.all).toBeUndefined();
		expect(res.files).toEqual(["tests/unit/alpha.test.ts"]);
		expect(res.counts).toMatchObject({ related: 1, readMap: 0, changedTests: 0, sinceMap: 0 });
	});

	it("selects tests from the read map (reads, dirs and trees) when no test imports the changed file", () => {
		const { dir, mapDir, baseSha } = makeRepo();
		write(dir, "server/read-only.ts", "export const magic = 'v2';\n");
		const head1 = commitAll(dir, "edit read-only");
		const r1 = selectTests({ cwd: dir, mapDir, env: { WT_BASE: baseSha, WT_HEAD: head1 } });
		expect(r1.files).toEqual(["tests/unit/beta.test.ts"]);
		expect(r1.counts).toMatchObject({ related: 0, readMap: 1, changedTests: 0, sinceMap: 0 });

		// A new file inside a directory a test listed via readdirSync ("dirs") selects that test.
		git(dir, "reset", "-q", "--hard", baseSha);
		write(dir, "tests/fixtures/items/b.json", '{"ok":true}\n');
		const head2 = commitAll(dir, "add fixture in read dir");
		expect(selectTests({ cwd: dir, mapDir, env: { WT_BASE: baseSha, WT_HEAD: head2 } }).files).toEqual([
			"tests/unit/beta.test.ts",
		]);

		// A file inside a copied tree ("trees") selects that test.
		git(dir, "reset", "-q", "--hard", baseSha);
		write(dir, "themes/dark/main.css", "body {}\n");
		const head3 = commitAll(dir, "add theme file");
		expect(selectTests({ cwd: dir, mapDir, env: { WT_BASE: baseSha, WT_HEAD: head3 } }).files).toEqual([
			"tests/unit/gamma.test.ts",
		]);
	});

	it("selects tests that import a changed asset (?raw HTML, JSON) or loaded it as a module", () => {
		const { dir, mapDir } = makeRepo();
		write(dir, "web/panel.html", "<p>v1</p>\n");
		write(dir, "web/limits.json", '{"max":1}\n');
		write(dir, "web/dynamic.json", '{"v":1}\n');
		write(
			dir,
			"web/panel.ts",
			'import html from "./panel.html?raw";\nimport limits from "./limits.json";\nexport const panel = () => html + limits.max;\n',
		);
		write(
			dir,
			"tests/unit/delta.test.ts",
			'import { panel } from "../../web/panel.js";\nexport const run = () => panel();\n',
		);
		write(
			dir,
			"tests/unit/epsilon.test.ts",
			'const name = "dynamic";\nexport const load = () => import(/* @vite-ignore */ `../../web/${name}.json`);\n',
		);
		const midBase = commitAll(dir, "add assets");
		// The map knows delta only as its own module, so only the import graph links the assets to it;
		// epsilon's computed import is seen only by the map, as a loaded module.
		writeMap(mapDir, {
			v: MAP_VERSION,
			commit: midBase,
			createdAt: "2026-10-31T00:00:00.000Z",
			tests: {
				"tests/unit/alpha.test.ts": { reads: [], dirs: [], trees: [], modules: ["tests/unit/alpha.test.ts"] },
				"tests/unit/beta.test.ts": { reads: [], dirs: [], trees: [], modules: [] },
				"tests/unit/gamma.test.ts": { reads: [], dirs: [], trees: [], modules: [] },
				"tests/unit/delta.test.ts": { reads: [], dirs: [], trees: [], modules: ["tests/unit/delta.test.ts"] },
				"tests/unit/epsilon.test.ts": {
					reads: [],
					dirs: [],
					trees: [],
					modules: ["tests/unit/epsilon.test.ts", "web/dynamic.json"],
				},
			},
			incomplete: [],
			run: { exitCode: 0, seconds: 1, failed: [] },
		});

		for (const [path, content] of [
			["web/panel.html", "<p>v2</p>\n"],
			["web/limits.json", '{"max":2}\n'],
		]) {
			git(dir, "reset", "-q", "--hard", midBase);
			write(dir, path, content);
			const head = commitAll(dir, `edit ${path}`);
			const res = selectTests({ cwd: dir, mapDir, env: { WT_BASE: midBase, WT_HEAD: head } });
			expect(res.all, path).toBeUndefined();
			expect(res.files, path).toEqual(["tests/unit/delta.test.ts"]);
			expect(res.counts, path).toMatchObject({ related: 1, readMap: 0 });
		}

		git(dir, "reset", "-q", "--hard", midBase);
		write(dir, "web/dynamic.json", '{"v":2}\n');
		const dynamicHead = commitAll(dir, "edit dynamic.json");
		const dynamic = selectTests({ cwd: dir, mapDir, env: { WT_BASE: midBase, WT_HEAD: dynamicHead } });
		expect(dynamic.files).toEqual(["tests/unit/epsilon.test.ts"]);
	});

	it("selects tests that use built server code (dist/server) when the source it is built from changes", () => {
		const { dir, mapDir } = makeRepo();
		write(dir, "server/i18n.ts", "export const t = (key: string) => key;\n");
		write(dir, "server/durable-dep.ts", "export const dep = 1;\n");
		write(dir, "server/durable.ts", 'import { dep } from "./durable-dep.js";\nexport const durable = () => dep;\n');
		write(dir, "server/dsh/runtime/steps.yml", "steps: []\n");
		write(dir, "tests/unit/built.test.ts", "export const built = 1;\n");
		const midBase = commitAll(dir, "add a test of built server code");
		// built.test.ts runs dist/server/durable.js (which loads dist/server/durable-dep.js), reads dist/server/i18n.js as
		// text and lists the copied runtime folder; dist/ is gitignored, so no change ever names these paths.
		writeMap(mapDir, {
			v: MAP_VERSION,
			commit: midBase,
			createdAt: "2026-10-31T00:00:00.000Z",
			tests: {
				"tests/unit/alpha.test.ts": {
					reads: [],
					dirs: [],
					trees: [],
					modules: ["tests/unit/alpha.test.ts", "server/mid.ts", "server/leaf.ts"],
				},
				"tests/unit/beta.test.ts": { reads: [], dirs: [], trees: [], modules: [] },
				"tests/unit/gamma.test.ts": { reads: [], dirs: [], trees: [], modules: [] },
				"tests/unit/built.test.ts": {
					reads: ["dist/server/i18n.js"],
					dirs: ["dist/server/dsh/runtime"],
					trees: [],
					modules: ["tests/unit/built.test.ts", "dist/server/durable.js", "dist/server/durable-dep.js"],
				},
			},
			incomplete: [],
			run: { exitCode: 0, seconds: 1, failed: [] },
		});

		// Each edit comes with a leaf edit, so another test is selected too and the built-code test must not be dropped.
		for (const path of ["server/i18n.ts", "server/durable-dep.ts", "server/dsh/runtime/steps.yml"]) {
			git(dir, "reset", "-q", "--hard", midBase);
			write(dir, path, path.endsWith(".yml") ? "steps: [one]\n" : "export const edited = 2;\n");
			write(dir, "server/leaf.ts", "export const leaf = () => 3;\n");
			const head = commitAll(dir, `edit ${path} and leaf`);
			const res = selectTests({ cwd: dir, mapDir, env: { WT_BASE: midBase, WT_HEAD: head } });
			expect(res.all, path).toBeUndefined();
			expect(res.files, path).toEqual(["tests/unit/alpha.test.ts", "tests/unit/built.test.ts"]);
		}
	});

	it("selects tests that use the web bundle when anything it is built from changes, and tests using other build output always", () => {
		const { dir, mapDir } = makeRepo();
		write(dir, "shared/strings.ts", "export const hello = 'hi';\n");
		write(dir, "web/main.ts", 'import { hello } from "../shared/strings.js";\nexport const main = () => hello;\n');
		write(dir, "web/public/logo.svg", "<svg/>\n");
		write(dir, "tests/unit/bundle.test.ts", "export const bundle = 1;\n");
		write(dir, "tests/unit/desktop.test.ts", "export const desktop = 1;\n");
		const midBase = commitAll(dir, "add tests of the web bundle and of desktop build output");
		writeMap(mapDir, {
			v: MAP_VERSION,
			commit: midBase,
			createdAt: "2026-10-31T00:00:00.000Z",
			tests: {
				"tests/unit/alpha.test.ts": {
					reads: [],
					dirs: [],
					trees: [],
					modules: ["tests/unit/alpha.test.ts", "server/mid.ts", "server/leaf.ts"],
				},
				"tests/unit/beta.test.ts": { reads: [], dirs: [], trees: [], modules: [] },
				"tests/unit/gamma.test.ts": { reads: [], dirs: [], trees: [], modules: [] },
				"tests/unit/bundle.test.ts": { reads: [], dirs: ["web/dist/assets"], trees: [], modules: [] },
				"tests/unit/desktop.test.ts": { reads: ["dist/desktop/main.js"], dirs: [], trees: [], modules: [] },
			},
			incomplete: [],
			run: { exitCode: 0, seconds: 1, failed: [] },
		});

		// A web asset and a file outside web/ that the web app imports both change the bundle.
		for (const path of ["web/public/logo.svg", "shared/strings.ts"]) {
			git(dir, "reset", "-q", "--hard", midBase);
			write(dir, path, path.endsWith(".svg") ? "<svg></svg>\n" : "export const hello = 'hello';\n");
			const head = commitAll(dir, `edit ${path}`);
			const res = selectTests({ cwd: dir, mapDir, env: { WT_BASE: midBase, WT_HEAD: head } });
			expect(res.all, path).toBeUndefined();
			expect(res.files, path).toEqual(["tests/unit/bundle.test.ts", "tests/unit/desktop.test.ts"]);
		}

		// Build output the selector can't trace to its source (dist/desktop) is used by a test that runs on every change.
		git(dir, "reset", "-q", "--hard", midBase);
		write(dir, "server/leaf.ts", "export const leaf = () => 4;\n");
		const leafHead = commitAll(dir, "edit leaf");
		const leafOnly = selectTests({ cwd: dir, mapDir, env: { WT_BASE: midBase, WT_HEAD: leafHead } });
		expect(leafOnly.files).toEqual(["tests/unit/alpha.test.ts", "tests/unit/desktop.test.ts"]);
	});

	it("includes test files changed between the read map's commit and WT_BASE", () => {
		const { dir, mapDir, baseSha } = makeRepo();
		write(dir, "tests/unit/delta.test.ts", "export const delta = 1;\n");
		const nextBase = commitAll(dir, "add delta test after map");

		write(dir, "server/read-only.ts", "export const magic = 'v3';\n");
		const headSha = commitAll(dir, "edit read-only");

		const res = selectTests({ cwd: dir, mapDir, env: { WT_BASE: nextBase, WT_HEAD: headSha } });
		expect(res.files).toEqual(["tests/unit/beta.test.ts", "tests/unit/delta.test.ts"]);
		expect(res.counts).toMatchObject({ readMap: 1, sinceMap: 1 });
	});

	it("prints 'all <reason>' or the file list on CLI, and formats the check.sh summary line", () => {
		const { dir, mapDir, baseSha } = makeRepo();
		write(dir, "server/read-only.ts", "export const magic = 'v4';\n");
		const headSha = commitAll(dir, "edit read-only");

		const cliAll = runCli(dir, mapDir, { WT_BASE: undefined });
		expect(cliAll.code).toBe(0);
		expect(cliAll.out).toBe("all WT_BASE is not set");

		const cliFiles = runCli(dir, mapDir, { WT_BASE: baseSha, WT_HEAD: headSha });
		expect(cliFiles.code).toBe(0);
		expect(cliFiles.out).toBe("tests/unit/beta.test.ts");

		const cliCheck = runCli(dir, mapDir, { WT_BASE: baseSha, WT_HEAD: headSha }, "--for-check");
		expect(cliCheck.code).toBe(0);
		expect(cliCheck.out.split("\n")).toEqual([
			`unit tests: 1 of 3 files (1 read map, map ${baseSha.slice(0, 7)})`,
			"tests/unit/beta.test.ts",
		]);
		expect(formatCheckSummary({ all: "WT_BASE is not set", total: 3 })).toBe("unit tests: all (WT_BASE is not set)");
	});

	it("wires check.sh --fast to select before sealing and keeps full check and --notes unchanged", () => {
		const check = readFileSync(join(repo, "scripts", "check.sh"), "utf8");
		const selectIdx = check.indexOf("node scripts/select-tests.mjs --for-check");
		const sealIdx = check.indexOf('exec scripts/sealed.sh env "PI_SELECTED_TESTS_FILE=$selected_file"');
		expect(selectIdx).toBeGreaterThan(0);
		expect(selectIdx).toBeLessThan(sealIdx);
		expect(check).toContain('npm test -- "${selected_tests[@]}"');
	});
});
