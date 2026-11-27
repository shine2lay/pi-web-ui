/**
 * Memory Explorer, v2 §5l.15 (Architecture #597, R-V2-SPMEM-20): a department root's Specialists node. The slugs are
 * the union of the store listing of `specialists/` and of `notebook/specialists/`; each names its three canonical
 * places (Notebook, Memories, Archive) and a display-only label. Names come from the store: they are returned as data,
 * never trusted (Security SP5); a path under `specialists/` that is no slug folder is listed in `others`, kind
 * `other`, never hidden. The roots, their one count and the folder's own children are unchanged.
 */
import type { OpenVikingDaemonHttp } from "./daemon-http.js";
import { explorerKindOf, explorerPrincipalOf, explorerRootHeaders, SPECIALISTS_SEGMENT } from "./explorer-rules.js";
import { SPECIALIST_SLUG_RE } from "../task-queue-specialist.js";
import {
	EXPLORER_ROOT_WALK,
	type OpenVikingExplorerRoot,
	type OpenVikingSpecialistOther,
	type OpenVikingSpecialistSlug,
	type OpenVikingSpecialistsNode,
} from "./explorer-types.js";
import { walkTree, type OpenVikingLsItem, type OpenVikingTreeWalk } from "./memory-tree.js";
import { specialistConfigLabel } from "./specialist-config-label.js";
import { OpenVikingDashboardError } from "./types.js";

const NOTEBOOK_FOLDER = `notebook/${SPECIALISTS_SEGMENT}`;
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A walk's items, `[]` when the folder is not there, null when it did not answer or was truncated. */
async function listing(
	http: OpenVikingDaemonHttp,
	uri: string,
	root: OpenVikingExplorerRoot,
	levels: number,
): Promise<OpenVikingLsItem[] | null> {
	let walk: OpenVikingTreeWalk;
	try {
		walk = await walkTree(http, uri, explorerRootHeaders(root), { ...EXPLORER_ROOT_WALK, level_limit: levels });
	} catch (err) {
		if (err instanceof OpenVikingDashboardError) return null;
		throw err;
	}
	if (walk.state === "truncated") return null;
	return walk.state === "read" ? walk.items : [];
}

/** The node for a department root, or null for any other folder, or when it has no slug and nothing else. */
export async function buildSpecialistsNode(
	http: OpenVikingDaemonHttp,
	root: OpenVikingExplorerRoot,
	folderUri: string,
	identitiesDir: string,
): Promise<OpenVikingSpecialistsNode | null> {
	if (root.group !== "department" || root.role === null || folderUri !== root.uri) return null;
	const dept = root.role;
	const uri = `${root.uri}/${SPECIALISTS_SEGMENT}`;
	const notebookUri = `${root.uri}/${NOTEBOOK_FOLDER}`;
	const [below, notebooks] = await Promise.all([
		listing(http, uri, root, EXPLORER_ROOT_WALK.level_limit),
		listing(http, notebookUri, root, 1),
	]);

	const childName = (item: OpenVikingLsItem) => item.uri.slice(uri.length + 1).split("/")[0];
	const direct = (below ?? []).filter((item) => !item.uri.slice(uri.length + 1).includes("/"));
	const slugFolders = new Set(direct.filter((i) => i.isDir && SPECIALIST_SLUG_RE.test(childName(i))).map(childName));
	const others: OpenVikingSpecialistOther[] = direct
		.filter((i) => !slugFolders.has(childName(i)) || !i.isDir)
		.map((i) => ({ uri: i.uri, name: childName(i), is_folder: i.isDir, kind: explorerKindOf(i.uri, root) }))
		.sort((a, b) => byText(a.name, b.name));
	const notebookSlugs = new Set(
		(notebooks ?? [])
			.filter((i) => !i.isDir && i.uri.endsWith(".md"))
			.map((i) => i.uri.slice(notebookUri.length + 1, -".md".length))
			.filter((name) => SPECIALIST_SLUG_RE.test(name)),
	);

	const slugs = [...new Set([...slugFolders, ...notebookSlugs])].sort(byText);
	if (slugs.length === 0 && others.length === 0 && below !== null && notebooks !== null) return null;
	const rows: OpenVikingSpecialistSlug[] = slugs.map((slug) => {
		const memories = `${uri}/${slug}`;
		const notes = below === null ? null : below.filter((i) => !i.isDir && i.uri.startsWith(`${memories}/`)).length;
		return {
			slug,
			principal: explorerPrincipalOf(memories, root) ?? dept,
			label: specialistConfigLabel(identitiesDir, dept, slug),
			notebook: `${notebookUri}/${slug}.md`,
			memories,
			archive: `${memories}/archive`,
			has_notebook: notebooks === null ? null : notebookSlugs.has(slug),
			has_memories: below === null ? null : slugFolders.has(slug),
			notes,
		};
	});
	return { uri, read: below !== null && notebooks !== null, slugs: rows, others };
}
