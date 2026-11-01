/**
 * SDK startup patches (server/patch-remote-catalog.ts, server/patch-lazy-boundary-context.ts) rewrite
 * installed @earendil-works/pi-coding-agent files. A rewrite only takes effect if it runs before the
 * SDK module is first evaluated; otherwise the running server keeps the old code until its next
 * restart (Ops #697: server/index.ts imported the SDK before agent-service.js, which imported the
 * patches, so the first start after a deploy ran the unpatched turn-end code).
 *
 * This walks the server's static import graph from server/index.ts in ESM evaluation order
 * (depth-first, imports in source order, type-only imports erased) and checks that every patch
 * module has finished evaluating before the first SDK import is reached.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SDK = "@earendil-works/pi-coding-agent";
const PATCH_MODULES = ["patch-remote-catalog.ts", "patch-lazy-boundary-context.ts"];
const SERVER_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "../../server/index.ts");

/** Runtime import specifiers of one TypeScript module, in source order (type-only imports skipped). */
function runtimeImports(source: string): string[] {
	const specifiers: string[] = [];
	const statement = /^\s*(import|export)\s+(?:(type)\s+)?(?:([^;"'`]*?)\s+from\s+)?["']([^"']+)["']/gm;
	for (const match of source.matchAll(statement)) {
		const [, keyword, typeOnly, clause, specifier] = match;
		if (typeOnly) continue;
		if (keyword === "export" && clause === undefined) continue;
		specifiers.push(specifier);
	}
	return specifiers;
}

/** Evaluation-order events from an entry file: a patch module finishing, or the SDK being reached. */
function evaluationEvents(entry: string): string[] {
	const events: string[] = [];
	const entered = new Set<string>();
	let sdkReached = false;
	const visit = (file: string): void => {
		if (entered.has(file)) return;
		entered.add(file);
		for (const specifier of runtimeImports(readFileSync(file, "utf8"))) {
			if (specifier.startsWith(".")) {
				visit(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
			} else if ((specifier === SDK || specifier.startsWith(`${SDK}/`)) && !sdkReached) {
				sdkReached = true;
				events.push("sdk");
			}
		}
		const name = file.slice(dirname(file).length + 1);
		if (PATCH_MODULES.includes(name)) events.push(name);
	};
	visit(entry);
	return events;
}

describe("sdk-patch-load-order", () => {
	const made: string[] = [];
	afterEach(() => {
		for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("server/index.ts evaluates every SDK startup patch before the SDK loads", () => {
		const events = evaluationEvents(SERVER_ENTRY);
		expect(events).toContain("sdk");
		for (const patch of PATCH_MODULES) {
			expect(events, `${patch} must be evaluated`).toContain(patch);
			expect(events.indexOf(patch), `${patch} before the SDK`).toBeLessThan(events.indexOf("sdk"));
		}
	});

	it("catches an entry that reaches the SDK before the patches (walker control)", () => {
		const dir = mkdtempSync(join(tmpdir(), "sdk-patch-order-"));
		made.push(dir);
		writeFileSync(
			join(dir, "index.ts"),
			[
				`import type { Thing } from "./types.js";`,
				`import { VERSION } from "${SDK}";`,
				`import { run } from "./service.js";`,
			].join("\n"),
		);
		writeFileSync(join(dir, "types.ts"), `export interface Thing { a: 1 }\n`);
		writeFileSync(
			join(dir, "service.ts"),
			`import "./patch-remote-catalog.js";\nimport "./patch-lazy-boundary-context.js";\n`,
		);
		writeFileSync(join(dir, "patch-remote-catalog.ts"), `import { readFileSync } from "node:fs";\n`);
		writeFileSync(join(dir, "patch-lazy-boundary-context.ts"), `export {};\n`);
		expect(evaluationEvents(join(dir, "index.ts"))).toEqual([
			"sdk",
			"patch-remote-catalog.ts",
			"patch-lazy-boundary-context.ts",
		]);

		writeFileSync(
			join(dir, "index.ts"),
			[
				`import "./patch-remote-catalog.js";`,
				`import "./patch-lazy-boundary-context.js";`,
				`import { VERSION } from "${SDK}";`,
			].join("\n"),
		);
		expect(evaluationEvents(join(dir, "index.ts"))).toEqual([
			"patch-remote-catalog.ts",
			"patch-lazy-boundary-context.ts",
			"sdk",
		]);
	});
});
