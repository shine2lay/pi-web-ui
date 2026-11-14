/**
 * Memory Explorer G1-G2 (spec-explorer.md): the answers of `GET /api/openviking/tree/roots` and
 * `GET /api/openviking/tree`, built on the one tree reader (`walkTree`, memory-tree.ts). A note is a file of the walk
 * (R-EXPLORER-COUNT-1); a root or folder the walk could not fully read has no count, never a short one.
 */
import { mapWithLimit, type OpenVikingDaemonHttp } from "./daemon-http.js";
import { isMemoryReachable, statUri, textWithReason } from "./explorer-daemon.js";
import { explorerKindOf, explorerRefusal, explorerRootHeaders, isoModTime, isSetupFile } from "./explorer-rules.js";
import {
	EXPLORER_RECENT_COUNT,
	EXPLORER_ROOT_WALK,
	EXPLORER_ROOTS_IN_FLIGHT,
	type OpenVikingExplorerKindCounts,
	type OpenVikingExplorerRoot,
	type OpenVikingExplorerUri,
	type OpenVikingRecentNote,
	type OpenVikingTreeChild,
	type OpenVikingTreeFolderResponse,
	type OpenVikingTreeRootRow,
	type OpenVikingTreeRootsResponse,
} from "./explorer-types.js";
import { OPENVIKING_EXPLORER_ROOTS, walkTree, type OpenVikingLsItem, type OpenVikingTreeWalk } from "./memory-tree.js";
import { OpenVikingDashboardError } from "./types.js";

const zeroKinds = (): OpenVikingExplorerKindCounts => ({ rule: 0, case: 0, fact: 0, event: 0, document: 0, other: 0 });
const lastSegment = (uri: string) => uri.slice(uri.lastIndexOf("/") + 1);
const msOf = (iso: string | null) => (iso === null ? Number.NEGATIVE_INFINITY : Date.parse(iso));
/** Newest first; equal times by uri, so the order never depends on the daemon's. */
const newestFirst = (a: { uri: string; mod_time: string | null }, b: { uri: string; mod_time: string | null }) =>
	msOf(b.mod_time) - msOf(a.mod_time) || a.uri.localeCompare(b.uri);

/** A root walk that did not answer is unread (`null`); a failure that is not the daemon's still throws. */
async function walkRoot(http: OpenVikingDaemonHttp, root: OpenVikingExplorerRoot): Promise<OpenVikingTreeWalk | null> {
	try {
		return await walkTree(http, root.uri, explorerRootHeaders(root), EXPLORER_ROOT_WALK);
	} catch (err) {
		if (err instanceof OpenVikingDashboardError) return null;
		throw err;
	}
}

/** One root's row: `read: false` with null counts when unread or truncated; `NOT_FOUND` reads as `0`. */
export function treeRootRow(root: OpenVikingExplorerRoot, walk: OpenVikingTreeWalk | null): OpenVikingTreeRootRow {
	const base = { uri: root.uri, group: root.group, role: root.role };
	if (walk === null || walk.state === "truncated")
		return { ...base, read: false, notes: null, folders: null, kinds: null };
	const items = walk.state === "read" ? walk.items : [];
	const kinds = zeroKinds();
	for (const item of items) if (!item.isDir) kinds[explorerKindOf(item.uri, root)]++;
	const notes = items.filter((i) => !i.isDir).length;
	return { ...base, read: true, notes, folders: items.length - notes, kinds };
}

/** `GET /api/openviking/tree/roots`. `showsRoot`: whether this request may list a root's files in `recent[]`. */
export async function buildTreeRoots(
	http: OpenVikingDaemonHttp,
	nowMs: number,
	showsRoot: (rootUri: string) => boolean,
): Promise<OpenVikingTreeRootsResponse> {
	const checked_at = new Date(nowMs).toISOString();
	const reachable = await isMemoryReachable(http);
	const walks = reachable
		? await mapWithLimit(OPENVIKING_EXPLORER_ROOTS, EXPLORER_ROOTS_IN_FLIGHT, (root) => walkRoot(http, root))
		: OPENVIKING_EXPLORER_ROOTS.map(() => null);
	const roots = OPENVIKING_EXPLORER_ROOTS.map((root, i) => treeRootRow(root, walks[i]));
	const unread_count = roots.filter((r) => !r.read).length;
	return {
		checked_at,
		health_state: reachable ? "healthy" : "server-unreachable",
		notes_total: unread_count > 0 ? null : roots.reduce((n, r) => n + (r.notes ?? 0), 0),
		unread_count,
		roots_partial: unread_count > 0,
		roots,
		recent: recentNotes(walks, showsRoot),
	};
}

/** The newest files over the read roots this request may show. */
export function recentNotes(
	walks: readonly (OpenVikingTreeWalk | null)[],
	showsRoot: (rootUri: string) => boolean,
): OpenVikingRecentNote[] {
	const rows: OpenVikingRecentNote[] = [];
	OPENVIKING_EXPLORER_ROOTS.forEach((root, i) => {
		const walk = walks[i];
		if (walk?.state !== "read" || !showsRoot(root.uri)) return;
		for (const item of walk.items) {
			const mod_time = isoModTime(item.modTime);
			if (item.isDir || mod_time === null || item.size === null) continue;
			const kind = explorerKindOf(item.uri, root);
			rows.push({ uri: item.uri, root: root.uri, kind, size: item.size, mod_time, locked: isSetupFile(item.uri) });
		}
	});
	return rows.sort(newestFirst).slice(0, EXPLORER_RECENT_COUNT);
}

/** A folder walk the explorer must count in full: `NOT_FOUND` and truncation are refusals, never a short count. */
function folderItems(walk: OpenVikingTreeWalk, uri: string): OpenVikingLsItem[] {
	if (walk.state === "read") return walk.items;
	if (walk.state === "absent") throw explorerRefusal("NOT_FOUND", "No memory at this uri.");
	throw explorerRefusal("MEMORY_ERROR", `The folder holds over ${EXPLORER_ROOT_WALK.node_limit} nodes to count.`, {
		uri,
	});
}

function treeChild(
	item: OpenVikingLsItem,
	root: OpenVikingExplorerRoot,
	notesBelow: ReadonlyMap<string, number>,
): OpenVikingTreeChild {
	const locked = isSetupFile(item.uri);
	const text = locked
		? { text: null, reason: "locked" as const }
		: item.isDir
			? textWithReason(item.abstract)
			: { text: null, reason: "none" as const };
	return {
		uri: item.uri,
		name: lastSegment(item.uri),
		is_folder: item.isDir,
		kind: explorerKindOf(item.uri, root),
		size: item.isDir ? null : item.size,
		mod_time: isoModTime(item.modTime),
		notes: item.isDir ? (notesBelow.get(item.uri) ?? 0) : null,
		abstract: text.text,
		abstract_reason: text.reason,
		locked,
	};
}

/** `GET /api/openviking/tree?uri=<folder>`: one level, children newest first, paged by `offset`/`limit`. */
export async function buildTreeFolder(
	http: OpenVikingDaemonHttp,
	target: OpenVikingExplorerUri,
	page: { offset: number; limit: number },
): Promise<OpenVikingTreeFolderResponse> {
	const { uri, root } = target;
	const headers = explorerRootHeaders(root);
	if (!(await statUri(http, uri, headers)).isDir) {
		throw explorerRefusal("NOT_A_FOLDER", "This uri is a note, not a folder.", { uri });
	}
	const [level, deep, own] = await Promise.all([
		walkTree(http, uri, headers, { include_abstract: true, level_limit: 1, node_limit: EXPLORER_ROOT_WALK.node_limit }),
		walkTree(http, uri, headers, EXPLORER_ROOT_WALK),
		http.result("/api/v1/content/abstract", { uri }, headers),
	]);
	const below = folderItems(deep, uri);
	const notesBelow = new Map<string, number>();
	for (const item of below) {
		if (item.isDir) continue;
		const child = `${uri}/${item.uri.slice(uri.length + 1).split("/")[0]}`;
		notesBelow.set(child, (notesBelow.get(child) ?? 0) + 1);
	}
	const children = folderItems(level, uri)
		.map((item) => treeChild(item, root, notesBelow))
		.sort(newestFirst);
	const notes = below.filter((i) => !i.isDir).length;
	const newest = below
		.map((i) => msOf(isoModTime(i.modTime)))
		.reduce((a, b) => Math.max(a, b), Number.NEGATIVE_INFINITY);
	const ownText = textWithReason(own);
	return {
		uri,
		root: root.uri,
		notes,
		folders: below.length - notes,
		last_change: Number.isFinite(newest) ? new Date(newest).toISOString() : null,
		abstract: ownText.text,
		abstract_reason: ownText.reason,
		total: children.length,
		children: children.slice(page.offset, page.offset + page.limit),
	};
}
