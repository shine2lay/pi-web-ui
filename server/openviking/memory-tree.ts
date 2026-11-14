/**
 * OpenViking Memory Dashboard — the one tree reader: the walker over `/api/v1/fs/ls` (metadata only: names, sizes,
 * modTime) and, for the Memory Explorer, `walkTree` over `/api/v1/fs/tree`. Shared trees read as `default`; each
 * role's tree reads with that role's headers (R-URI-REWRITE-1). It never calls `/api/v1/content/*`.
 */
import {
	DAEMON_BAD_RESPONSE,
	mapWithLimit,
	OpenVikingDaemonRequestError,
	type OpenVikingDaemonHttp,
} from "./daemon-http.js";
import type { OpenVikingExplorerRoot } from "./explorer-types.js";
import { OPENVIKING_ROLES, OpenVikingDashboardError } from "./types.js";
import { resolveRequestHeaders } from "./uri.js";

export const RESOURCES_ROOT_URI = "viking://resources";
export const SHARED_MEMORIES_ROOT_URI = "viking://user/default/memories";
export const roleMemoriesRootUri = (role: string) => `viking://user/${role}/memories`;

/**
 * R-EXPLORER-ROOTS-1 (spec-explorer.md, addendum A5): the Memory Explorer's 17 roots in their constant order, the
 * only list of them: the shared resources tree, the shared memories, then every role's memories in
 * `OPENVIKING_ROLES` order.
 */
export const OPENVIKING_EXPLORER_ROOTS: readonly OpenVikingExplorerRoot[] = Object.freeze([
	{ uri: RESOURCES_ROOT_URI, group: "projects", role: null },
	{ uri: SHARED_MEMORIES_ROOT_URI, group: "shared", role: null },
	...OPENVIKING_ROLES.map((role): OpenVikingExplorerRoot => ({
		uri: roleMemoriesRootUri(role),
		group: "department",
		role,
	})),
]);
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

/**
 * A listing the daemon would not answer — rejected, or past both deadlines. The rows below it are missing from
 * the walk, which is not the same as not being there: whoever reads the walk must say so (Backend #151).
 */
export interface OpenVikingUnreadListing {
	uri: string;
	error: OpenVikingDashboardError;
}

/** One listing as far as it answered. */
export interface OpenVikingDirReading {
	items: OpenVikingLsItem[];
	unread: OpenVikingUnreadListing[];
}

/** One walk as far as it got: the files it did read, and every listing that did not answer. */
export interface OpenVikingTreeReading {
	files: OpenVikingMemoryFile[];
	unread: OpenVikingUnreadListing[];
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

/** `/api/v1/fs/tree` params (spec-explorer.md G2). */
export interface OpenVikingTreeWalkParams {
	include_abstract: boolean;
	level_limit: number;
	node_limit: number;
}

/**
 * One `fs/tree` walk. `absent`: the daemon says there is no such folder (`NOT_FOUND`). `truncated`: the walk returned
 * `node_limit` nodes, so the folder may hold more than it shows — never a short count (G2). Every other failure throws.
 */
export type OpenVikingTreeWalk =
	{ state: "read"; items: OpenVikingLsItem[] } | { state: "absent" } | { state: "truncated" };

export async function walkTree(
	http: OpenVikingDaemonHttp,
	uri: string,
	headers: Record<string, string>,
	params: OpenVikingTreeWalkParams,
): Promise<OpenVikingTreeWalk> {
	let result: unknown;
	try {
		result = await http.result(
			"/api/v1/fs/tree",
			{
				uri,
				include_abstract: String(params.include_abstract),
				level_limit: String(params.level_limit),
				node_limit: String(params.node_limit),
			},
			headers,
		);
	} catch (err) {
		if (saysFolderIsNotThere(err)) return { state: "absent" };
		throw err;
	}
	if (!Array.isArray(result)) {
		throw new OpenVikingDashboardError(`fs/tree of ${uri} did not answer a list`, 502, DAEMON_BAD_RESPONSE, { uri });
	}
	if (result.length >= params.node_limit) return { state: "truncated" };
	return { state: "read", items: toLsItems(result) };
}

export async function listDir(
	http: OpenVikingDaemonHttp,
	uri: string,
	headers: Record<string, string>,
): Promise<OpenVikingLsItem[]> {
	return toLsItems(await http.result("/api/v1/fs/ls", { uri }, headers));
}

/** One listing, or none with the failure recorded: a read that did not answer hides rows, it is not an absence. */
async function listOrRecord(
	http: OpenVikingDaemonHttp,
	uri: string,
	headers: Record<string, string>,
	unread: OpenVikingUnreadListing[],
): Promise<OpenVikingLsItem[]> {
	try {
		return await listDir(http, uri, headers);
	} catch (err) {
		if (!(err instanceof OpenVikingDashboardError)) throw err;
		unread.push({ uri, error: err });
		return [];
	}
}

/**
 * The root listing of a read unit (spec 2500874d §3a). `NOT_FOUND` is the daemon answering "there is no such
 * folder": absent, `0` rows, nothing unread. Every other failure is a read that did not happen.
 */
async function listRootOrRecord(
	http: OpenVikingDaemonHttp,
	uri: string,
	headers: Record<string, string>,
	unread: OpenVikingUnreadListing[],
): Promise<OpenVikingLsItem[]> {
	try {
		return await listDir(http, uri, headers);
	} catch (err) {
		if (saysFolderIsNotThere(err)) return [];
		if (!(err instanceof OpenVikingDashboardError)) throw err;
		unread.push({ uri, error: err });
		return [];
	}
}

/** One listing as far as it answered, for a caller that returns its rows rather than failing (Backend #151). */
export async function readDir(
	http: OpenVikingDaemonHttp,
	uri: string,
	headers: Record<string, string>,
): Promise<OpenVikingDirReading> {
	const unread: OpenVikingUnreadListing[] = [];
	return { items: await listRootOrRecord(http, uri, headers, unread), unread };
}

function toMemoryFile(rootUri: string, item: OpenVikingLsItem): OpenVikingMemoryFile {
	const relPath = item.uri.startsWith(`${rootUri}/`) ? item.uri.slice(rootUri.length + 1) : item.uri;
	const slash = relPath.indexOf("/");
	return { ...item, relPath, category: slash > 0 ? relPath.slice(0, slash) : "root" };
}

/**
 * Every file under `rootUri` at any depth: breadth-first, each folder listed once with a plain (one-level) listing.
 * The daemon's `recursive=true` listing stops 3 levels down (0.5.4), so it is not used. A failed listing fails the
 * walk: a caller that counts may not count a tree short (Backend #149).
 */
export async function walkMemoryTree(
	http: OpenVikingDaemonHttp,
	rootUri: string,
	headers: Record<string, string>,
): Promise<OpenVikingMemoryFile[]> {
	const reading = await readMemoryTree(http, rootUri, headers);
	const failed = reading.unread[0];
	if (failed) throw failed.error;
	return reading.files;
}

/**
 * The same walk, as far as it got: the files it read plus the listings that did not answer. A caller that lists
 * rows (the Memory Explorer) returns what was read and declares the rest unread, instead of throwing away a
 * listing of 1700 readable rows over one (Backend #151).
 */
export async function readMemoryTree(
	http: OpenVikingDaemonHttp,
	rootUri: string,
	headers: Record<string, string>,
): Promise<OpenVikingTreeReading> {
	const unread: OpenVikingUnreadListing[] = [];
	const rootItems = await listRootOrRecord(http, rootUri, headers, unread);
	return filesBelow(http, rootUri, headers, rootItems, unread);
}

/** The same walk from an already-listed root, so the root listing's own failure can be told apart from the rest. */
async function filesBelow(
	http: OpenVikingDaemonHttp,
	rootUri: string,
	headers: Record<string, string>,
	rootItems: OpenVikingLsItem[],
	unread: OpenVikingUnreadListing[],
): Promise<OpenVikingTreeReading> {
	const files: OpenVikingMemoryFile[] = [];
	for (let items = rootItems; items.length > 0;) {
		for (const i of items) if (!i.isDir) files.push(toMemoryFile(rootUri, i));
		const dirs = items.filter((i) => i.isDir).map((i) => i.uri);
		items = (await mapWithLimit(dirs, LISTINGS_IN_FLIGHT, (uri) => listOrRecord(http, uri, headers, unread))).flat();
	}
	return { files, unread };
}

/**
 * What one role's tree reading came to (Backend #149, blind verify #148 row 37). The two daemon answers are
 * never conflated: `absent` is the daemon saying there is no such folder, `unmeasured` is a read it would not
 * answer. Only `measured` and `absent` are figures; `unmeasured` is the absence of a figure.
 */
export type OpenVikingRoleTree =
	| { state: "measured"; files: OpenVikingMemoryFile[] }
	| { state: "absent" }
	/** What was read before the failure, kept for the Explorer: real rows, under a count that may not be used. */
	| { state: "unmeasured"; files: OpenVikingMemoryFile[]; unreadListings: number };

/** The files of a measured reading; an absent or unmeasured role contributes no file to a count (#149). */
export const roleTreeFiles = (tree: OpenVikingRoleTree): OpenVikingMemoryFile[] =>
	tree.state === "measured" ? tree.files : [];

/**
 * Every row a reading did produce, measured or not (Backend #151). A listing that failed hides the rows below
 * it; it does not unread the rows that were read, and the Explorer shows them with the shortfall declared.
 */
export const roleTreeReadFiles = (tree: OpenVikingRoleTree): OpenVikingMemoryFile[] =>
	tree.state === "absent" ? [] : tree.files;

/**
 * Whether this role tree is one unread read unit (spec 2500874d §3a). A tree is all-or-nothing: however many
 * of its listings did not answer, the unit is one — and a tree the daemon says is not there is absent, not
 * unread, so it is never one.
 */
export const roleTreeIsUnread = (tree: OpenVikingRoleTree): boolean => tree.state === "unmeasured";

/**
 * The daemon's own "there is no such folder" answer: `fs/ls` rejects the role's root listing with `NOT_FOUND`
 * (`:1933` 0.5.4 answers `404 {"error":{"code":"NOT_FOUND"}}`). Every other failure — `503`, `500`, a missed
 * deadline, a refused connection, an unreadable body — is a read that did not happen, not an absence.
 */
function saysFolderIsNotThere(err: unknown): boolean {
	return err instanceof OpenVikingDaemonRequestError && err.upstreamCode === "NOT_FOUND";
}

/** A role's personal tree under canonical `viking://user/<role>/memories`. */
export async function walkRoleTree(http: OpenVikingDaemonHttp, role: string): Promise<OpenVikingRoleTree> {
	const rootUri = roleMemoriesRootUri(role);
	const headers = resolveRequestHeaders("agent", role);
	let rootItems: OpenVikingLsItem[];
	try {
		rootItems = await listDir(http, rootUri, headers);
	} catch (err) {
		if (saysFolderIsNotThere(err)) return { state: "absent" };
		if (err instanceof OpenVikingDashboardError) return { state: "unmeasured", files: [], unreadListings: 1 };
		throw err;
	}
	const reading = await filesBelow(http, rootUri, headers, rootItems, []);
	// The folder is there; a failure below it (including a subfolder that vanished mid-walk) would leave a
	// partial count, so the role is unmeasured rather than counted short — while the rows it did read stay
	// readable for a listing that declares the shortfall (#151).
	return reading.unread.length === 0
		? { state: "measured", files: reading.files }
		: { state: "unmeasured", files: reading.files, unreadListings: reading.unread.length };
}

export async function walkRoleTrees(
	http: OpenVikingDaemonHttp,
	roles: readonly string[],
): Promise<Map<string, OpenVikingRoleTree>> {
	const trees = await mapWithLimit(roles, ROLE_WALKS_IN_FLIGHT, (role) => walkRoleTree(http, role));
	return new Map(roles.map((role, i) => [role, trees[i]]));
}
