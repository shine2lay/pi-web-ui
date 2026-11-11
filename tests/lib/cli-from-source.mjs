/**
 * cli-from-source.mjs: run bin/pi-web-ui.mjs with no build (Ops #811, Architecture rm-a86b4982).
 *
 *   node --import <this file> …   (then import or run bin/pi-web-ui.mjs)
 *
 * The CLI statically imports tsc's output `../dist/server/<path>.js`, so in a checkout that was never
 * built (`scripts/check.sh --fast` skips the build) importing it throws ERR_MODULE_NOT_FOUND. This
 * registers tsx (the repo's TypeScript loader) and cli-from-source-hooks.mjs, which serves each of
 * those imports from its source, `server/<path>.ts`, whether or not dist/ exists: the test checks the
 * code as it is now, never a stale build. Test-only: the shipped CLI is unchanged.
 */
import { register } from "node:module";
import { register as registerTsx } from "tsx/esm/api";

registerTsx();
// Registered after tsx, so its resolve runs first and hands tsx the .ts path to compile.
register(new URL("./cli-from-source-hooks.mjs", import.meta.url));
