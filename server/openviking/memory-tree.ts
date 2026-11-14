/**
 * OpenViking memory — the Memory Explorer's roots and its one tree reader, `walkTree` over `/api/v1/fs/tree`
 * (metadata only: names, sizes, modTime, abstracts). It never calls `/api/v1/content/*`.
 */
import { DAEMON_BAD_RESPONSE, OpenVikingDaemonRequestError, type OpenVikingDaemonHttp } from "./daemon-http.js";
import type { OpenVikingExplorerRoot } from "./explorer-types.js";
import { OPENVIKING_ROLES, OpenVikingDashboardError } from "./types.js";

const RESOURCES_ROOT_URI = "viking://resources";
const SHARED_MEMORIES_ROOT_URI = "viking://user/default/memories";
const roleMemoriesRootUri = (role: string) => `viking://user/${role}/memories`;

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

export interface OpenVikingLsItem {
	uri: string;
	isDir: boolean;
	size: number | null;
	modTime: string | null;
	abstract: string | null;
}

function toLsItems(result: unknown[]): OpenVikingLsItem[] {
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
interface OpenVikingTreeWalkParams {
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

/**
 * The daemon's own "there is no such folder" answer (`:1933` 0.5.4 answers `404 {"error":{"code":"NOT_FOUND"}}`).
 * Every other failure — `503`, `500`, a missed deadline, a refused connection, an unreadable body — is a read that
 * did not happen, not an absence.
 */
function saysFolderIsNotThere(err: unknown): boolean {
	return err instanceof OpenVikingDaemonRequestError && err.upstreamCode === "NOT_FOUND";
}
