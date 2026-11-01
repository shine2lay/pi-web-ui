/**
 * Process-wide memo of jiti module resolution (Ops #703).
 *
 * `@earendil-works/pi-coding-agent` 1.0.1 loads every extension of a new chat runtime through a
 * fresh jiti instance (`createJiti(..., { moduleCache: false, alias })` in
 * `dist/core/extensions/loader.js` `loadExtensionModule`). jiti 2.7's internal `jitiResolve` keeps
 * no cache, so each runtime repeats the whole resolution search for every import of every
 * extension: about 18,000 `statSync` probes per runtime for the installed extensions, almost all
 * of them on paths that don't exist (each throwing an ENOENT error), ~89% of a warm runtime's
 * extension import time.
 *
 * This module holds the shared memo that the startup patch (`server/patch-jiti-resolve-cache.ts`)
 * makes jiti consult: same resolution question -> same answer, without the search. Only the
 * resolved path strings are shared. Module instances are not: the SDK still imports each
 * extension with `moduleCache: false`, so every runtime evaluates its own copy of each module and
 * keeps its own module-level state.
 *
 * The key holds everything jiti 2.7's `jitiResolve(ctx, id, options)` reads: the importing file
 * (`ctx.filename`, `ctx.parentModule.filename`), the specifier, the call options (`parentURL`,
 * `async`, `conditions`, `paths`, `try`, `skipTsConfigPaths`) and the jiti options that change the
 * answer (`alias`, `extensions`, `nativeModules`, `tsconfigPaths`). Calls with tsconfig path
 * mapping are never cached (their answer also depends on the tsconfig file). Failed resolutions
 * are never cached. A cached file path is checked to still be a file before it is returned (one
 * stat, no search); if it was deleted or moved (an add-on updated on disk while the server runs),
 * the entry is dropped and resolved again.
 */

import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

/** Where the patched jiti looks for the cache (see `server/patch-jiti-resolve-cache.ts`). */
export const JITI_RESOLVE_CACHE_KEY = Symbol.for("pi-web-ui.jiti-resolve-cache.v1");

/** The jiti options that change a resolution's answer (jiti 2.7 `ctx.opts`). */
export interface JitiResolveContextOptions {
	alias?: Record<string, string> | null;
	extensions?: string[];
	nativeModules?: string[];
	tsconfigPaths?: unknown;
}

/** The parts of jiti 2.7's internal resolution context (`ctx`) the cache reads. */
export interface JitiResolveContext {
	filename: string;
	opts: JitiResolveContextOptions;
	parentModule?: { filename?: string } | null;
	resolveTsConfigPaths?: unknown;
}

/** jiti 2.7 `jitiResolve` call options. */
export interface JitiResolveCallOptions {
	parentURL?: string | URL;
	async?: boolean;
	conditions?: string[];
	paths?: string[];
	try?: boolean;
	skipTsConfigPaths?: boolean;
}

/** jiti's own, uncached resolution (`jitiResolveUncached` in the patched `dist/jiti.cjs`). */
export type JitiResolveUncached = (
	ctx: JitiResolveContext,
	id: string,
	options: JitiResolveCallOptions | undefined,
) => string | undefined;

export interface JitiResolveCache {
	/** Answers from the memo when it can, else asks `uncached` and remembers a successful answer. */
	resolve(
		ctx: JitiResolveContext,
		id: string,
		options: JitiResolveCallOptions | undefined,
		uncached: JitiResolveUncached,
	): string | undefined;
	/** Number of remembered resolutions. */
	readonly size: number;
	clear(): void;
}

function isExistingFile(path: string): boolean {
	return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

/** Creates an empty memo. `isFile` checks a remembered file path before reuse (tests inject it). */
export function createJitiResolveCache(isFile: (path: string) => boolean = isExistingFile): JitiResolveCache {
	const answers = new Map<string, string>();
	// Each distinct set of answer-changing jiti options gets a short id, so the ~2 KB alias table
	// isn't repeated in every key; the WeakMap spares re-serializing one jiti instance's options.
	const optionsIds = new Map<string, string>();
	const optionsKeys = new WeakMap<object, string>();

	const optionsKeyOf = (opts: JitiResolveContextOptions): string => {
		let key = optionsKeys.get(opts);
		if (key === undefined) {
			const serialized = JSON.stringify([
				opts.alias ?? null,
				opts.extensions ?? null,
				opts.nativeModules ?? null,
				opts.tsconfigPaths ?? null,
			]);
			key = optionsIds.get(serialized);
			if (key === undefined) {
				key = `o${optionsIds.size}`;
				optionsIds.set(serialized, key);
			}
			optionsKeys.set(opts, key);
		}
		return key;
	};

	const keyOf = (ctx: JitiResolveContext, id: string, options: JitiResolveCallOptions | undefined): string =>
		[
			optionsKeyOf(ctx.opts),
			ctx.filename,
			ctx.parentModule?.filename ?? "",
			id,
			options?.parentURL === undefined ? "" : String(options.parentURL),
			options?.async ? "async" : "sync",
			JSON.stringify(options?.conditions ?? null),
			JSON.stringify(options?.paths ?? null),
			options?.try ? "try" : "",
			options?.skipTsConfigPaths ? "skip-tsconfig" : "",
		].join("\0");

	return {
		resolve(ctx, id, options, uncached) {
			if (typeof id !== "string" || ctx.resolveTsConfigPaths || !ctx.opts) return uncached(ctx, id, options);
			const key = keyOf(ctx, id, options);
			const remembered = answers.get(key);
			if (remembered !== undefined) {
				if (!isAbsolute(remembered) || isFile(remembered)) return remembered;
				answers.delete(key);
			}
			const resolved = uncached(ctx, id, options);
			if (typeof resolved === "string" && resolved.length > 0) answers.set(key, resolved);
			return resolved;
		},
		get size() {
			return answers.size;
		},
		clear() {
			answers.clear();
		},
	};
}

/**
 * Puts one memo on `target` (default `globalThis`) under `JITI_RESOLVE_CACHE_KEY`, keeping one that is
 * already there, and returns it.
 */
export function installJitiResolveCache(target: object = globalThis): JitiResolveCache {
	const slot = target as Record<symbol, JitiResolveCache | undefined>;
	const existing = slot[JITI_RESOLVE_CACHE_KEY];
	if (existing) return existing;
	const cache = createJitiResolveCache();
	slot[JITI_RESOLVE_CACHE_KEY] = cache;
	return cache;
}
