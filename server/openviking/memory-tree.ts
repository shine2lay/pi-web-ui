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
/** Each role walk is 1 + (sub-folders) listings; a few at a time keeps the daemon responsive. */
const ROLE_WALKS_IN_FLIGHT = 4;

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
	recursive = false,
): Promise<OpenVikingLsItem[]> {
	const params: Record<string, string> = recursive ? { uri, recursive: "true" } : { uri };
	return toLsItems(await http.result("/api/v1/fs/ls", params, headers));
}

function toMemoryFile(rootUri: string, item: OpenVikingLsItem): OpenVikingMemoryFile {
	const relPath = item.uri.startsWith(`${rootUri}/`) ? item.uri.slice(rootUri.length + 1) : item.uri;
	const slash = relPath.indexOf("/");
	return { ...item, relPath, category: slash > 0 ? relPath.slice(0, slash) : "root" };
}

/** Every file under `rootUri`: one listing of the root, then one recursive listing per sub-folder. */
export async function walkMemoryTree(
	http: OpenVikingDaemonHttp,
	rootUri: string,
	headers: Record<string, string>,
): Promise<OpenVikingMemoryFile[]> {
	const top = await listDir(http, rootUri, headers);
	const nested = await Promise.all(top.filter((i) => i.isDir).map((dir) => listDir(http, dir.uri, headers, true)));
	return [...top, ...nested.flat()].filter((i) => !i.isDir).map((i) => toMemoryFile(rootUri, i));
}

/** A role's personal tree, or null when the daemon has no tree for that role (role not live). */
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
