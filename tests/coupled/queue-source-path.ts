/** Explicit disposable-worktree source only; no installed extension or main-checkout fallback. */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export function queueSourcePath(): string {
	const source = process.env.PI_QUEUE_NATIVE_SOURCE;
	if (!source || !isAbsolute(source) || realpathSync(source) !== source || !lstatSync(join(source, ".git")).isFile()) {
		throw new Error(
			"Coupled proof requires PI_QUEUE_NATIVE_SOURCE to name an explicit canonical pi-queue worktree, never the installed/main checkout.",
		);
	}
	const metadata = JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as { name?: unknown };
	if (metadata.name !== "pi-work-management") throw new Error("The explicit worktree is not pi-queue.");
	return source;
}
