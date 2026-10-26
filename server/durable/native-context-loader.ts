import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Resolve BCP's public ./durable adapter, not its CommonJS entry.
 * Node 22's import.meta.resolve cannot anchor a parent without an experimental flag;
 * require.resolve and jiti's require fallback both mis-handle this import-only contract.
 * Deliberately support the published import/types map and the older unconditional target,
 * not a partial general-purpose Node exports resolver. New shapes must fail visibly.
 */
export function resolveNativeContextModule(agentDir: string): string | undefined {
	for (const root of [
		join(agentDir, "node_modules", "billion-context-pi"),
		join(agentDir, "npm", "node_modules", "billion-context-pi"),
	]) {
		try {
			lstatSync(root);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		// Once an installation is found, nothing is optional: even a dangling link is a broken install.
		const packageRoot = realpathSync(root);
		const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
		if (manifest?.name !== "billion-context-pi") throw new Error(`Invalid billion-context-pi installation: ${root}`);
		const entry = manifest.exports?.["./durable"];
		const target =
			typeof entry === "string"
				? entry
				: entry &&
					  typeof entry === "object" &&
					  !Array.isArray(entry) &&
					  Object.keys(entry).every((key) => key === "types" || key === "import") &&
					  (entry.types === undefined || typeof entry.types === "string")
					? entry.import
					: undefined;
		const parts = typeof target === "string" && target.startsWith("./") ? target.slice(2).split("/") : [];
		if (
			!parts.length ||
			parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || [".", "..", "node_modules"].includes(part))
		)
			throw new Error(`Unsupported billion-context-pi/durable export: ${root}`);
		return pathToFileURL(join(packageRoot, ...parts)).href;
	}
	return undefined;
}
