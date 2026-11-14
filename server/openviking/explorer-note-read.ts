/**
 * Memory Explorer G3 (spec-explorer.md): the answer of `GET /api/openviking/note`. `fs/stat` backs every call; the
 * text comes from `/api/v1/content/{abstract,overview,read}`. A file's abstract and overview are its folder's (gap D1),
 * so the answer names whose text it is (`text_of`). Full text is never cut. `last_write` is the newest change-record
 * line for the uri.
 */
import type { OpenVikingDaemonHttp } from "./daemon-http.js";
import { statUri, textWithReason } from "./explorer-daemon.js";
import { explorerKindOf, explorerRefusal, explorerRootHeaders } from "./explorer-rules.js";
import {
	OPENVIKING_NOTE_LEVELS,
	type OpenVikingExplorerUri,
	type OpenVikingNoteLastWrite,
	type OpenVikingNoteLevel,
	type OpenVikingNoteResponse,
} from "./explorer-types.js";
import { readChangelogRecords, type OpenVikingStatePaths } from "./state-files.js";

const CONTENT_PATH: Record<OpenVikingNoteLevel, string> = {
	abstract: "/api/v1/content/abstract",
	overview: "/api/v1/content/overview",
	full: "/api/v1/content/read",
};

/** `400 LEVEL_INVALID` unless `level` is one of abstract, overview, full. */
export function parseNoteLevel(raw: unknown): OpenVikingNoteLevel {
	if (!(OPENVIKING_NOTE_LEVELS as readonly unknown[]).includes(raw)) {
		throw explorerRefusal("LEVEL_INVALID", `level is one of ${OPENVIKING_NOTE_LEVELS.join(", ")}.`);
	}
	return raw as OpenVikingNoteLevel;
}

/** The newest change-record line for `uri` (ties: the later line), or null. */
export async function lastWriteOf(paths: OpenVikingStatePaths, uri: string): Promise<OpenVikingNoteLastWrite | null> {
	let newest: Awaited<ReturnType<typeof readChangelogRecords>>[number] | null = null;
	for (const r of await readChangelogRecords(paths)) {
		if (r.uri === uri && (newest === null || r.tsMs >= newest.tsMs)) newest = r;
	}
	return newest === null ? null : { role: newest.role, source: newest.source, task_id: newest.taskId, ts: newest.ts };
}

/** A note or folder at one level, for a uri the owner gate and the setup-file lock have passed. */
export async function buildNote(
	http: OpenVikingDaemonHttp,
	paths: OpenVikingStatePaths,
	target: OpenVikingExplorerUri,
	level: OpenVikingNoteLevel,
): Promise<OpenVikingNoteResponse> {
	const { uri, root } = target;
	const headers = explorerRootHeaders(root);
	const stat = await statUri(http, uri, headers);
	if (level === "full" && stat.isDir) throw explorerRefusal("NOT_A_FILE", "A folder has no full text.", { uri });
	const text_of = level !== "full" && !stat.isDir ? uri.slice(0, uri.lastIndexOf("/")) : uri;
	const [raw, last_write] = await Promise.all([
		http.result(CONTENT_PATH[level], { uri: text_of }, headers),
		lastWriteOf(paths, uri),
	]);
	const text = textWithReason(raw, level === "abstract");
	return {
		uri,
		root: root.uri,
		kind: explorerKindOf(uri, root),
		is_folder: stat.isDir,
		size: stat.isDir ? null : stat.size,
		mod_time: stat.modTime,
		level,
		text: text.text,
		text_reason: text.reason,
		text_of,
		last_write,
	};
}
