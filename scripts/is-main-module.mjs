/**
 * is-main-module.mjs: whether a script runs as a command (`node scripts/x.mjs`) rather than imported by its test.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Pass the script's `import.meta.url`. Compared as real paths, so a symbolic link to the script still runs it. */
export function isMainModule(moduleUrl) {
	try {
		return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(moduleUrl));
	} catch {
		return false;
	}
}
