/**
 * OpenViking Memory Dashboard — the one walker over `/api/v1/fs/ls` (metadata only: names, sizes,
 * modTime). Shared trees read as `default`; each role's tree reads with that role's headers
 * (R-URI-REWRITE-1). It never calls `/api/v1/content/*`.
 */
import { mapWithLimit, OpenVikingDaemonRequestError, type OpenVikingDaemonHttp } from "./daemon-http.js";
import { OpenVikingDashboardError } from "./types.js";
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
	return filesBelow(http, rootUri, headers, await listDir(http, rootUri, headers));
}

/** The same walk from an already-listed root, so the root listing's own failure can be told apart from the rest. */
async function filesBelow(
	http: OpenVikingDaemonHttp,
	rootUri: string,
	headers: Record<string, string>,
	rootItems: OpenVikingLsItem[],
): Promise<OpenVikingMemoryFile[]> {
	const files: OpenVikingMemoryFile[] = [];
	for (let items = rootItems; items.length > 0;) {
		for (const i of items) if (!i.isDir) files.push(toMemoryFile(rootUri, i));
		const dirs = items.filter((i) => i.isDir).map((i) => i.uri);
		items = (await mapWithLimit(dirs, LISTINGS_IN_FLIGHT, (uri) => listDir(http, uri, headers))).flat();
	}
	return files;
}

/**
 * What one role's tree reading came to (Backend #149, blind verify #148 row 37). The two daemon answers are
 * never conflated: `absent` is the daemon saying there is no such folder, `unmeasured` is a read it would not
 * answer. Only `measured` and `absent` are figures; `unmeasured` is the absence of a figure.
 */
export type OpenVikingRoleTree =
	{ state: "measured"; files: OpenVikingMemoryFile[] } | { state: "absent" } | { state: "unmeasured" };

/** The files of a measured reading; an absent or unmeasured role contributes no file to a listing. */
export const roleTreeFiles = (tree: OpenVikingRoleTree): OpenVikingMemoryFile[] =>
	tree.state === "measured" ? tree.files : [];

/**
 * The daemon's own "there is no such folder" answer: `fs/ls` rejects the role's root listing with `NOT_FOUND`
 * (`:1933` 0.5.4 answers `404 {"error":{"code":"NOT_FOUND"}}`). Every other failure — `503`, `500`, a missed
 * deadline, a refused connection, an unreadable body — is a read that did not happen, not an absence.
 */
const saysFolderIsNotThere = (err: unknown): boolean =>
	err instanceof OpenVikingDaemonRequestError && err.upstreamCode === "NOT_FOUND";

/** A role's personal tree under canonical `viking://user/<role>/memories`. */
export async function walkRoleTree(http: OpenVikingDaemonHttp, role: string): Promise<OpenVikingRoleTree> {
	const rootUri = roleMemoriesRootUri(role);
	const headers = resolveRequestHeaders("agent", role);
	let rootItems: OpenVikingLsItem[];
	try {
		rootItems = await listDir(http, rootUri, headers);
	} catch (err) {
		if (saysFolderIsNotThere(err)) return { state: "absent" };
		if (err instanceof OpenVikingDashboardError) return { state: "unmeasured" };
		throw err;
	}
	try {
		return { state: "measured", files: await filesBelow(http, rootUri, headers, rootItems) };
	} catch (err) {
		// The folder is there; a failure below it (including a subfolder that vanished mid-walk) would leave a
		// partial count, so the role is unmeasured rather than counted short.
		if (err instanceof OpenVikingDashboardError) return { state: "unmeasured" };
		throw err;
	}
}

export async function walkRoleTrees(
	http: OpenVikingDaemonHttp,
	roles: readonly string[],
): Promise<Map<string, OpenVikingRoleTree>> {
	const trees = await mapWithLimit(roles, ROLE_WALKS_IN_FLIGHT, (role) => walkRoleTree(http, role));
	return new Map(roles.map((role, i) => [role, trees[i]]));
}
