/**
 * Ops #703: the startup patch that puts the shared resolution memo in front of jiti's resolver
 * (server/patch-jiti-resolve-cache.ts). Guarded like the other SDK startup patches: exact
 * single-occurrence match, idempotent, warns and leaves the file alone on any other jiti text.
 * The memo's behaviour and the two-runtime check are in tests/unit/jiti-resolve-cache.test.ts.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { JITI_RESOLVE_CACHE_KEY } from "../../server/jiti-resolve-cache.js";
import {
	applyJitiResolveCachePatch,
	jitiDistFile,
	JITI_RESOLVE_REPLACEMENTS,
	patchJitiResolveSource,
} from "../../server/patch-jiti-resolve-cache.js";
import { resolvePiSdkFile } from "../../server/sdk-file-patch.js";

function unpatched(source: string): string {
	let text = source;
	for (const r of JITI_RESOLVE_REPLACEMENTS) if (text.includes(r.new)) text = text.replace(r.new, r.old);
	return text;
}

describe("patch-jiti-resolve-cache", () => {
	it("takes the jiti the installed pi SDK loads (fails when that jiti changed)", () => {
		const file = jitiDistFile();
		expect(file).toBeTruthy();
		expect(existsSync(file!)).toBe(true);
		expect(file!.endsWith(`${sep}jiti${sep}dist${sep}jiti.cjs`)).toBe(true);
		// The SDK's extension loader is what imports jiti (createJiti with moduleCache: false).
		const loader = readFileSync(resolvePiSdkFile("core", "extensions", "loader.js")!, "utf8");
		expect(loader).toContain("moduleCache: false");
		const jitiManifest = JSON.parse(readFileSync(join(file!, "..", "..", "package.json"), "utf8"));
		expect(jitiManifest.version).toBe("2.7.0");

		// Importing patch-jiti-resolve-cache.ts above already applied the patch and installed the memo.
		expect((globalThis as Record<symbol, unknown>)[JITI_RESOLVE_CACHE_KEY]).toBeTruthy();
		const result = applyJitiResolveCachePatch({ warn: null, log: null });
		expect(result.status).toBe("already");
		expect(result.files["jiti/dist/jiti.cjs"]).toBe("already");
		const source = readFileSync(file!, "utf8");
		for (const r of JITI_RESOLVE_REPLACEMENTS) expect(source).toContain(r.new);
	});

	it("rewrites jiti's own source once and is idempotent", () => {
		const pristine = unpatched(readFileSync(jitiDistFile()!, "utf8"));
		expect(pristine).not.toContain("jitiResolveUncached");
		const first = patchJitiResolveSource(pristine);
		expect(first.status).toBe("patched");
		expect(first.source).toContain("function jitiResolveUncached(e,t,i){let n,a;");
		expect(patchJitiResolveSource(first.source).status).toBe("already");

		const box = mkdtempSync(join(tmpdir(), "pi-jiti-resolve-patch-"));
		try {
			const file = join(box, "jiti.cjs");
			writeFileSync(file, pristine, "utf8");
			const target = {};
			const logs: string[] = [];
			const firstBatch = applyJitiResolveCachePatch({
				file,
				cacheTarget: target,
				warn: null,
				log: (m) => logs.push(m),
			});
			expect(firstBatch.status).toBe("patched");
			expect((target as Record<symbol, unknown>)[JITI_RESOLVE_CACHE_KEY]).toBeTruthy();
			const secondBatch = applyJitiResolveCachePatch({
				file,
				cacheTarget: target,
				warn: null,
				log: (m) => logs.push(m),
			});
			expect(secondBatch.status).toBe("already");
			expect(logs).toEqual([
				"[patch-jiti-resolve-cache] applied (patched)",
				"[patch-jiti-resolve-cache] applied (already)",
			]);
			expect(readFileSync(file, "utf8")).toBe(first.source);
		} finally {
			rmSync(box, { recursive: true, force: true });
		}
	});

	it("warns and leaves the file unchanged on a source mismatch or a missing file", () => {
		const changed = unpatched(readFileSync(jitiDistFile()!, "utf8")).replace(
			"function jitiResolve(e,t,i){let n,a;",
			"function jitiResolve(e,t,i){let n,a,o;",
		);
		expect(patchJitiResolveSource(changed).status).toBe("mismatch");

		const box = mkdtempSync(join(tmpdir(), "pi-jiti-resolve-mismatch-"));
		try {
			const file = join(box, "jiti.cjs");
			writeFileSync(file, changed, "utf8");
			const warnings: string[] = [];
			const res = applyJitiResolveCachePatch({ file, cacheTarget: {}, warn: (m) => warnings.push(m), log: null });
			expect(res.status).toBe("mismatch");
			expect(res.files["jiti/dist/jiti.cjs"]).toBe("mismatch");
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("jiti/dist/jiti.cjs no longer matches");
			expect(readFileSync(file, "utf8")).toBe(changed);

			const missingWarnings: string[] = [];
			const missing = applyJitiResolveCachePatch({
				file: join(box, "nope.cjs"),
				cacheTarget: {},
				warn: (m) => missingWarnings.push(m),
				log: null,
			});
			expect(missing.status).toBe("missing");
			expect(missingWarnings.some((w) => w.includes("was not found"))).toBe(true);
		} finally {
			rmSync(box, { recursive: true, force: true });
		}
	});
});
