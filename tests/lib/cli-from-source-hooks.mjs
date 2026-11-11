/**
 * cli-from-source-hooks.mjs: module hooks for cli-from-source.mjs (Ops #811).
 *
 * An import of `../dist/server/<path>.js` made by a `bin/pi-web-ui.mjs` (this repo's, or a copy of it
 * in another folder) resolves to this repo's `server/<path>.ts`: dist/server is tsc's file-by-file
 * output of server/ (tsconfig.server.json: rootDir server, outDir dist/server). Every other import
 * resolves as usual. A mapped source that doesn't exist fails loudly, naming it.
 */
import { existsSync } from "node:fs";

const SERVER_SOURCE = new URL("../../server/", import.meta.url);
const BUILT_SERVER = /^\.\.\/dist\/server\/(.+)\.js$/;

/** @type {import("node:module").ResolveHook} */
export async function resolve(specifier, context, nextResolve) {
	const built = BUILT_SERVER.exec(specifier);
	if (!built || !context.parentURL?.endsWith("/bin/pi-web-ui.mjs")) return nextResolve(specifier, context);
	const source = new URL(`${built[1]}.ts`, SERVER_SOURCE);
	if (!existsSync(source)) throw new Error(`cli-from-source: no source ${source.pathname} for ${specifier}`);
	return nextResolve(source.href, context);
}
