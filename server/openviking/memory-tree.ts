/**
 * OpenViking Memory Dashboard — the one walker over `/api/v1/fs/ls` (metadata only: names, sizes,
 * modTime). Shared trees read as `default`; each role's tree reads with that role's headers
 * (R-URI-REWRITE-1). It never calls `/api/v1/content/*`.
 */
import { mapWithLimit, OpenVikingDaemonRequestError, type OpenVikingDaemonHttp } from "./daemon-http.js";
import { resolveRequestHeaders } from "./uri.js";

export const RESOURCES_ROOT_URI = "viking://resources";
export const SHARED_MEMORIES_ROOT_URI = "viking://user/default/memories";
export const roleMemoriesRootUri = (role: string) => `viking://user/${role}/memories`;
/** Each role walk is one listing per folder; a few at a time keeps the daemon responsive. */
const ROLE_WALKS_IN_FLIGHT = 4;
/** Folder listings in flight within one walk (one tree level at a time). */
const LISTINGS_IN_FLIGHT = 8;

export interface OpenVikingLsItem {
	uri: string;
	isDir: boolean;
	size: number | null;
	modTime: string | null;
	abstract: string | null;
}

export interface OpenVikingMemoryFile extends OpenVikingLsItem {
	/** Path below the walked root, e.g. `cases/d2.md`. */
	relPath: string;
	/** First path segment below the root (`cases`, `preferences`, ...), or `root` for a top-level file. */
	category: string;
}

function toLsItems(result: unknown): OpenVikingLsItem[] {
	if (!Array.isArray(result)) return [];
	return result.flatMap((raw) => {
		if (typeof raw !== "object" || raw === null) return [];
		const o = raw as Record<string, unknown>;
		if (typeof o.uri !== "string" || typeof o.isDir !== "boolean") return [];
		return [
			{
				uri: o.uri,
				isDir: o.isDir,
				size: typeof o.size === "number" ? o.size : null,
				modTime: typeof o.modTime === "string" ? o.modTime : null,
				abstract: typeof o.abstract === "string" && o.abstract.trim() !== "" ? o.abstract : null,
			},
		];
	});
}

export async function listDir(
	http: OpenVikingDaemonHttp,
	uri: string,
	headers: Record<string, string>,
): Promise<OpenVikingLsItem[]> {
	return toLsItems(await http.result("/api/v1/fs/ls", { uri }, headers));
}

function toMemoryFile(rootUri: string, item: OpenVikingLsItem): OpenVikingMemoryFile {
	const relPath = item.uri.startsWith(`${rootUri}/`) ? item.uri.slice(rootUri.length + 1) : item.uri;
	const slash = relPath.indexOf("/");
	return { ...item, relPath, category: slash > 0 ? relPath.slice(0, slash) : "root" };
}

/**
 * Every file under `rootUri` at any depth: breadth-first, each folder listed once with a plain (one-level) listing.
 * The daemon's `recursive=true` listing stops 3 levels down (0.5.4), so it is not used. A failed listing fails the walk.
 */
export async function walkMemoryTree(
	http: OpenVikingDaemonHttp,
	rootUri: string,
	headers: Record<string, string>,
): Promise<OpenVikingMemoryFile[]> {
	const files: OpenVikingMemoryFile[] = [];
	for (let level = [rootUri]; level.length > 0;) {
		const items = (await mapWithLimit(level, LISTINGS_IN_FLIGHT, (uri) => listDir(http, uri, headers))).flat();
		for (const i of items) if (!i.isDir) files.push(toMemoryFile(rootUri, i));
		level = items.filter((i) => i.isDir).map((i) => i.uri);
	}
	return files;
}

/** A role's personal tree under canonical `viking://user/<role>/memories`, or null when the daemon has no such folder. */
export async function walkRoleTree(http: OpenVikingDaemonHttp, role: string): Promise<OpenVikingMemoryFile[] | null> {
	try {
		return await walkMemoryTree(http, roleMemoriesRootUri(role), resolveRequestHeaders("agent", role));
	} catch (err) {
		if (err instanceof OpenVikingDaemonRequestError) return null;
		throw err;
	}
}

export async function walkRoleTrees(
	http: OpenVikingDaemonHttp,
	roles: readonly string[],
): Promise<Map<string, OpenVikingMemoryFile[] | null>> {
	const trees = await mapWithLimit(roles, ROLE_WALKS_IN_FLIGHT, (role) => walkRoleTree(http, role));
	return new Map(roles.map((role, i) => [role, trees[i]]));
}
