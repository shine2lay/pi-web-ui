import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Resolve through the host repository's common git directory, not its temporary
// worktree name. Dependencies are canonical sibling repositories and must land first.
const hostRoot = fileURLToPath(new URL("../../", import.meta.url));
const commonGit = execFileSync(
	"git",
	["-C", hostRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"],
	{ encoding: "utf8" },
).trim();
const repositories = dirname(dirname(commonGit));

export function inboxRepoFile(repo: "pi-queue" | "pi-identity", relativePath: string): URL {
	return pathToFileURL(join(repositories, repo, relativePath));
}
