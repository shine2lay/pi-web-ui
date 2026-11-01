/**
 * Shared jiti resolution for extension loads (Ops #703).
 *
 * `@earendil-works/pi-coding-agent` 1.0.1 imports each extension of every new chat runtime through
 * a fresh jiti 2.7 instance (`dist/core/extensions/loader.js` `loadExtensionModule`:
 * `createJiti(import.meta.url, { moduleCache: false, alias })`). jiti's internal `jitiResolve`
 * (in `jiti/dist/jiti.cjs`) has no cache, so every runtime repeats the full resolution search for
 * every import: ~18,000 `statSync` probes, nearly all on missing paths, ~89% of a warm runtime's
 * extension import time (1.65 s per not-loaded chat open in #689's profile, 632 ms of it in
 * `statSync`).
 *
 * This startup patch renames jiti's resolver to `jitiResolveUncached` and puts a small
 * `jitiResolve` in front of it that asks the process-wide memo from `server/jiti-resolve-cache.ts`
 * (found on `globalThis` under `Symbol.for("pi-web-ui.jiti-resolve-cache.v1")`), which this module
 * installs. With no memo installed (any other process using the same `node_modules`), the patched
 * jiti calls `jitiResolveUncached` exactly as before. Only resolved paths are shared: module
 * instances and their state stay per runtime (the SDK keeps `moduleCache: false`).
 *
 * Idempotent and guarded by an exact single-occurrence source match via `server/sdk-file-patch.ts`;
 * on any other jiti text it warns and leaves the file alone. jiti loads lazily on the first extension
 * load, after startup; this module is still imported with the other startup patches at the top of
 * `server/index.ts`.
 */

import {
	applySdkFilePatches,
	patchFile,
	patchSource,
	resolveSdkDependencyFile,
	type FilePatchStatus,
	type PatchBatchResult,
	type SourcePatchResult,
	type SourceReplacement,
} from "./sdk-file-patch.js";
import { installJitiResolveCache, JITI_RESOLVE_CACHE_KEY } from "./jiti-resolve-cache.js";

const CACHE_LOOKUP = `globalThis[Symbol.for(${JSON.stringify(JITI_RESOLVE_CACHE_KEY.description)})]`;

export const JITI_RESOLVE_REPLACEMENTS: ReadonlyArray<SourceReplacement> = [
	{
		old: "function jitiResolve(e,t,i){let n,a;if(e.isNativeRe.test(t))return t;",
		new:
			`function jitiResolve(e,t,i){const r=${CACHE_LOOKUP};` +
			"return r?r.resolve(e,t,i,jitiResolveUncached):jitiResolveUncached(e,t,i)}" +
			"function jitiResolveUncached(e,t,i){let n,a;if(e.isNativeRe.test(t))return t;",
	},
];

/** Rewrites jiti's dist/jiti.cjs source (pure; no file access). */
export function patchJitiResolveSource(source: string): SourcePatchResult {
	return patchSource(source, JITI_RESOLVE_REPLACEMENTS);
}

/** Absolute path of the `jiti/dist/jiti.cjs` the pi SDK loads, or null. */
export function jitiDistFile(): string | null {
	return resolveSdkDependencyFile("jiti", "dist", "jiti.cjs");
}

/** Patches one jiti.cjs file on disk. */
export function patchJitiResolveFile(file: string | null = jitiDistFile()): FilePatchStatus {
	return patchFile(file, JITI_RESOLVE_REPLACEMENTS);
}

/**
 * Installs the shared memo on `cacheTarget` (default `globalThis`) and patches the installed
 * `jiti/dist/jiti.cjs` (or `file` in tests).
 */
export function applyJitiResolveCachePatch(options?: {
	file?: string | null;
	cacheTarget?: object;
	warn?: ((msg: string) => void) | null;
	log?: ((msg: string) => void) | null;
}): PatchBatchResult {
	installJitiResolveCache(options?.cacheTarget ?? globalThis);
	const file = options && "file" in options ? options.file : jitiDistFile();
	return applySdkFilePatches([{ name: "jiti/dist/jiti.cjs", file, replacements: JITI_RESOLVE_REPLACEMENTS }], {
		tag: "patch-jiti-resolve-cache",
		warn: options?.warn,
		log: options?.log,
	});
}

applyJitiResolveCachePatch({
	log: (msg) => console.log(msg),
});
