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

/** One listing as far as it answered, for a caller that returns its rows rather than failing (Backend #151). */
export async function readDir(
	http: OpenVikingDaemonHttp,
	uri: string,
	headers: Record<string, string>,
): Promise<OpenVikingDirReading> {
	const unread: OpenVikingUnreadListing[] = [];
	return { items: await listOrRecord(http, uri, headers, unread), unread };
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
	const rootItems = await listOrRecord(http, rootUri, headers, unread);
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

/** How many listings of this reading did not answer; each may hide rows (Backend #151). */
export const roleTreeUnreadListings = (tree: OpenVikingRoleTree): number =>
	tree.state === "unmeasured" ? tree.unreadListings : 0;

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
