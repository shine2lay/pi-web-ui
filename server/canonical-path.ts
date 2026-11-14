/**
 * The one spelling of a path that the server compares paths by: "~" expanded, then resolved.
 * identities.samePath compares two of them; a caller that compares one path with many (the Roles
 * page's evidence join) keeps the canonical form instead of resolving both sides every time.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type Env = Record<string, string | undefined>;

export function home(env: Env): string {
	return env.HOME || homedir();
}

export function expandHome(p: string, env: Env): string {
	if (p === "~") return home(env);
	if (p.startsWith("~/")) return join(home(env), p.slice(2));
	return p;
}

export function canonicalPath(p: string, env: Env = process.env): string {
	return resolve(expandHome(p, env));
}
