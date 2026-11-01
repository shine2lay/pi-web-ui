/**
 * Ops #703 (H-EXT-RESOLVE-CACHE): the shared jiti resolution memo.
 *
 * Unit part: what the memo remembers, keeps apart, re-checks and never remembers.
 * Integration part: a temporary copy of the installed jiti, patched by server/patch-jiti-resolve-cache.ts,
 * loads a fixture extension twice the way pi-coding-agent 1.0.1's loadExtensionModule does (a fresh
 * jiti per load, moduleCache: false, an alias). The second runtime must get its own module instances
 * and state, and must not repeat the resolution search (no statSync probe of a missing path); the
 * unpatched jiti repeats it (control: this check fails on the old code).
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	createJitiResolveCache,
	installJitiResolveCache,
	JITI_RESOLVE_CACHE_KEY,
	type JitiResolveContext,
} from "../../server/jiti-resolve-cache.js";
import {
	jitiDistFile,
	JITI_RESOLVE_REPLACEMENTS,
	patchJitiResolveFile,
} from "../../server/patch-jiti-resolve-cache.js";

const nodeRequire = createRequire(import.meta.url);
// jiti calls statSync through the CommonJS fs object, so wrapping its property sees every probe.
const fs = nodeRequire("node:fs") as typeof import("node:fs");
// The memo's own file check in the integration test goes around the counting wrapper.
const uncountedStatSync = fs.statSync;

function ctxOf(filename: string, opts: JitiResolveContext["opts"] = { extensions: [".ts"] }): JitiResolveContext {
	return { filename, opts };
}

describe("jiti-resolve-cache memo", () => {
	it("answers a repeated question from the memo, checking the remembered file once per reuse", () => {
		const isFile = vi.fn(() => true);
		const memo = createJitiResolveCache(isFile);
		const uncached = vi.fn(() => "/ext/lib/helper.ts");
		const ctx = ctxOf("/ext/index.ts");
		expect(memo.resolve(ctx, "./lib/helper.js", { async: true }, uncached)).toBe("/ext/lib/helper.ts");
		expect(memo.resolve(ctx, "./lib/helper.js", { async: true }, uncached)).toBe("/ext/lib/helper.ts");
		// A different jiti instance (new context and options objects) for the same file asks the same question.
		const otherRuntime = ctxOf("/ext/index.ts", { extensions: [".ts"] });
		expect(memo.resolve(otherRuntime, "./lib/helper.js", { async: true }, uncached)).toBe("/ext/lib/helper.ts");
		expect(uncached).toHaveBeenCalledTimes(1);
		expect(isFile).toHaveBeenCalledTimes(2);
		expect(isFile).toHaveBeenCalledWith("/ext/lib/helper.ts");
		expect(memo.size).toBe(1);
	});

	it("keeps answers apart for every input jiti's resolver reads", () => {
		const memo = createJitiResolveCache(() => true);
		let n = 0;
		const uncached = vi.fn(() => `/answer/${++n}.ts`);
		const base = (): [JitiResolveContext, string, Record<string, unknown>] => [
			{ filename: "/ext/index.ts", opts: { extensions: [".ts"], alias: { a: "/a.ts" } } },
			"./x.js",
			{ async: true },
		];
		const variants: Array<[JitiResolveContext, string, Record<string, unknown>]> = [
			base(),
			[{ filename: "/ext/other.ts", opts: { extensions: [".ts"], alias: { a: "/a.ts" } } }, "./x.js", { async: true }],
			[
				{
					filename: "/ext/index.ts",
					opts: { extensions: [".ts"], alias: { a: "/a.ts" } },
					parentModule: { filename: "/p.ts" },
				},
				"./x.js",
				{ async: true },
			],
			[base()[0], "./y.js", { async: true }],
			[base()[0], "./x.js", { async: true, parentURL: "file:///elsewhere/z.ts" }],
			[base()[0], "./x.js", { async: false }],
			[base()[0], "./x.js", { async: true, conditions: ["browser"] }],
			[base()[0], "./x.js", { async: true, paths: ["/lib"] }],
			[base()[0], "./x.js", { async: true, try: true }],
			[base()[0], "./x.js", { async: true, skipTsConfigPaths: true }],
			[{ filename: "/ext/index.ts", opts: { extensions: [".ts"], alias: { a: "/b.ts" } } }, "./x.js", { async: true }],
			[{ filename: "/ext/index.ts", opts: { extensions: [".mts"], alias: { a: "/a.ts" } } }, "./x.js", { async: true }],
			[
				{ filename: "/ext/index.ts", opts: { extensions: [".ts"], alias: { a: "/a.ts" }, nativeModules: ["x"] } },
				"./x.js",
				{ async: true },
			],
			[
				{ filename: "/ext/index.ts", opts: { extensions: [".ts"], alias: { a: "/a.ts" }, tsconfigPaths: "/t.json" } },
				"./x.js",
				{ async: true },
			],
		];
		const answers = variants.map(([ctx, id, options]) => memo.resolve(ctx, id, options, uncached));
		expect(new Set(answers).size).toBe(variants.length);
		expect(uncached).toHaveBeenCalledTimes(variants.length);
		// Asking every variant again comes from the memo.
		const again = variants.map(([ctx, id, options]) => memo.resolve(ctx, id, options, uncached));
		expect(again).toEqual(answers);
		expect(uncached).toHaveBeenCalledTimes(variants.length);
	});

	it("resolves again when a remembered file is gone, and remembers the new answer", () => {
		const existing = new Set(["/ext/foo.ts"]);
		const memo = createJitiResolveCache((path) => existing.has(path));
		const answers = ["/ext/foo.ts", "/ext/foo/index.ts"];
		const uncached = vi.fn(() => answers.shift());
		const ctx = ctxOf("/ext/index.ts");
		expect(memo.resolve(ctx, "./foo", undefined, uncached)).toBe("/ext/foo.ts");
		existing.delete("/ext/foo.ts");
		existing.add("/ext/foo/index.ts");
		expect(memo.resolve(ctx, "./foo", undefined, uncached)).toBe("/ext/foo/index.ts");
		expect(memo.resolve(ctx, "./foo", undefined, uncached)).toBe("/ext/foo/index.ts");
		expect(uncached).toHaveBeenCalledTimes(2);
	});

	it("never remembers a failed resolution", () => {
		const memo = createJitiResolveCache(() => true);
		const ctx = ctxOf("/ext/index.ts");
		const throwing = vi.fn(() => {
			throw new Error("Cannot find module './missing'");
		});
		expect(() => memo.resolve(ctx, "./missing", undefined, throwing)).toThrow("Cannot find module");
		expect(() => memo.resolve(ctx, "./missing", undefined, throwing)).toThrow("Cannot find module");
		expect(throwing).toHaveBeenCalledTimes(2);
		const empty = vi.fn(() => undefined);
		expect(memo.resolve(ctx, "./maybe", { try: true }, empty)).toBeUndefined();
		expect(memo.resolve(ctx, "./maybe", { try: true }, empty)).toBeUndefined();
		expect(empty).toHaveBeenCalledTimes(2);
		expect(memo.size).toBe(0);
	});

	it("leaves tsconfig path mapping to jiti every time", () => {
		const memo = createJitiResolveCache(() => true);
		const uncached = vi.fn(() => "/src/mapped.ts");
		const ctx: JitiResolveContext = { ...ctxOf("/src/index.ts"), resolveTsConfigPaths: () => [] };
		memo.resolve(ctx, "@app/mapped", undefined, uncached);
		memo.resolve(ctx, "@app/mapped", undefined, uncached);
		expect(uncached).toHaveBeenCalledTimes(2);
		expect(memo.size).toBe(0);
	});

	it("reuses a builtin answer without a file check", () => {
		const isFile = vi.fn(() => true);
		const memo = createJitiResolveCache(isFile);
		const uncached = vi.fn(() => "node:fs");
		const ctx = ctxOf("/ext/index.ts");
		memo.resolve(ctx, "fs", undefined, uncached);
		expect(memo.resolve(ctx, "fs", undefined, uncached)).toBe("node:fs");
		expect(uncached).toHaveBeenCalledTimes(1);
		expect(isFile).not.toHaveBeenCalled();
	});

	it("installs one memo per target and keeps one already there", () => {
		const target = {};
		const first = installJitiResolveCache(target);
		expect((target as Record<symbol, unknown>)[JITI_RESOLVE_CACHE_KEY]).toBe(first);
		expect(installJitiResolveCache(target)).toBe(first);
	});
});

interface RuntimeLoad {
	factory: () => { calls: number; helper: number; shared: { id: number } };
	loads: { count: number };
	/** statSync calls jiti made during this load, on paths under the fixture directory. */
	stats: number;
	/** Those that found nothing (a probe of a missing path). */
	missing: number;
}

describe("jiti-resolve-cache with the patched jiti (two runtimes, as the SDK loads extensions)", () => {
	let box = "";
	let entry = "";
	let shared = "";
	let oldJiti = "";
	let newJiti = "";
	const previousMemo = (globalThis as Record<symbol, unknown>)[JITI_RESOLVE_CACHE_KEY];

	beforeAll(() => {
		box = mkdtempSync(join(tmpdir(), "jiti-resolve-cache-"));
		const installed = jitiDistFile();
		if (!installed) throw new Error("jiti is not installed next to the pi SDK");
		const jitiRoot = dirname(dirname(installed));
		oldJiti = join(box, "jiti-old");
		newJiti = join(box, "jiti-new");
		cpSync(jitiRoot, oldJiti, { recursive: true });
		cpSync(jitiRoot, newJiti, { recursive: true });
		// The installed copy may already carry the patch (the startup patch runs whenever the server
		// modules load); the control copy gets jiti's own text back.
		const oldFile = join(oldJiti, "dist", "jiti.cjs");
		let source = readFileSync(oldFile, "utf8");
		for (const r of JITI_RESOLVE_REPLACEMENTS) source = source.replace(r.new, r.old);
		writeFileSync(oldFile, source);
		expect(source).not.toContain("jitiResolveUncached");
		expect(["patched", "already"]).toContain(patchJitiResolveFile(join(newJiti, "dist", "jiti.cjs")));

		const ext = join(box, "ext");
		mkdirSync(join(ext, "lib"), { recursive: true });
		mkdirSync(join(box, "aliased"), { recursive: true });
		mkdirSync(join(box, "host"), { recursive: true });
		entry = join(ext, "index.ts");
		shared = join(box, "aliased", "shared.ts");
		writeFileSync(
			entry,
			[
				`import { nextHelper } from "./lib/helper.js";`,
				`import { shared } from "fixture-alias";`,
				`let calls = 0;`,
				`export const loads = { count: 0 };`,
				`loads.count++;`,
				`export default function factory() {`,
				`  calls++;`,
				`  return { calls, helper: nextHelper(), shared };`,
				`}`,
			].join("\n"),
		);
		writeFileSync(
			join(ext, "lib", "helper.ts"),
			`let n = 0;\nexport function nextHelper(): number {\n  n++;\n  return n;\n}\n`,
		);
		writeFileSync(shared, `export const shared = { id: Math.random() };\n`);
		writeFileSync(join(box, "host", "loader.js"), "// stands in for the SDK's extensions/loader.js\n");
	});

	afterAll(() => {
		const slot = globalThis as Record<symbol, unknown>;
		if (previousMemo === undefined) delete slot[JITI_RESOLVE_CACHE_KEY];
		else slot[JITI_RESOLVE_CACHE_KEY] = previousMemo;
		if (box) rmSync(box, { recursive: true, force: true });
	});

	/** One runtime's extension load: a fresh jiti like loadExtensionModule, counting jiti's statSync probes. */
	async function loadRuntime(jitiDir: string): Promise<RuntimeLoad> {
		const { createJiti } = nodeRequire(join(jitiDir, "lib", "jiti.cjs")) as {
			createJiti: (
				id: string,
				opts: Record<string, unknown>,
			) => { import: (id: string, o: object) => Promise<unknown> };
		};
		const jiti = createJiti(join(box, "host", "loader.js"), {
			moduleCache: false,
			alias: { "fixture-alias": shared },
			fsCache: join(box, "fs-cache"),
		});
		const original = fs.statSync;
		let stats = 0;
		let missing = 0;
		const counting = function statSync(this: unknown, ...args: unknown[]) {
			const underBox = typeof args[0] === "string" && args[0].startsWith(box);
			if (underBox) stats++;
			try {
				const result = (original as (...a: unknown[]) => unknown).apply(this, args);
				if (underBox && result === undefined) missing++;
				return result;
			} catch (err) {
				if (underBox) missing++;
				throw err;
			}
		};
		fs.statSync = counting as typeof fs.statSync;
		let mod: unknown;
		try {
			mod = await jiti.import(entry, { default: false });
		} finally {
			fs.statSync = original;
		}
		const ns = mod as { default: RuntimeLoad["factory"]; loads: RuntimeLoad["loads"] };
		return { factory: ns.default, loads: ns.loads, stats, missing };
	}

	function expectOwnInstances(first: RuntimeLoad, second: RuntimeLoad): void {
		expect(second.factory).not.toBe(first.factory);
		expect(second.loads).not.toBe(first.loads);
		expect(first.loads.count).toBe(1);
		expect(second.loads.count).toBe(1);
		const a1 = first.factory();
		const a2 = first.factory();
		const b1 = second.factory();
		expect([a1.calls, a1.helper, a2.calls, a2.helper]).toEqual([1, 1, 2, 2]);
		expect([b1.calls, b1.helper]).toEqual([1, 1]);
		expect(b1.shared).not.toBe(a1.shared);
	}

	it("second runtime: own module instances and state, and no repeated resolution search", async () => {
		const checked: string[] = [];
		const memo = createJitiResolveCache((path) => {
			checked.push(path);
			return uncountedStatSync(path, { throwIfNoEntry: false })?.isFile() === true;
		});
		(globalThis as Record<symbol, unknown>)[JITI_RESOLVE_CACHE_KEY] = memo;

		const first = await loadRuntime(newJiti);
		expect(first.missing).toBeGreaterThan(0);
		const remembered = memo.size;
		expect(remembered).toBeGreaterThanOrEqual(3);

		checked.length = 0;
		const second = await loadRuntime(newJiti);
		expectOwnInstances(first, second);
		// No search: jiti probed nothing, the memo only re-checked files that exist.
		expect(second.missing).toBe(0);
		expect(second.stats).toBe(0);
		expect(checked.length).toBeGreaterThanOrEqual(3);
		expect(checked).toEqual(expect.arrayContaining([entry, shared, join(box, "ext", "lib", "helper.ts")]));
		expect(memo.size).toBe(remembered);
	});

	it("control: jiti's own resolver (old code, or the patch with no memo) repeats the search", async () => {
		delete (globalThis as Record<symbol, unknown>)[JITI_RESOLVE_CACHE_KEY];
		for (const jitiDir of [oldJiti, newJiti]) {
			const first = await loadRuntime(jitiDir);
			const second = await loadRuntime(jitiDir);
			expectOwnInstances(first, second);
			expect(second.missing).toBeGreaterThan(0);
			expect(second.missing).toBe(first.missing);
		}
	});
});
