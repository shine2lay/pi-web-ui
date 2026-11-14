/**
 * Memory Explorer read routes — the daemon calls they share (spec-explorer.md "Errors", spec-explorer-build.md table):
 * the reachability check, `fs/stat`, a text answer's null reason, and the one mapping of daemon failures onto the
 * explorer's codes (`503 MEMORY_UNREACHABLE`, `404 NOT_FOUND`, `502 MEMORY_ERROR`).
 */
import {
	DAEMON_BAD_RESPONSE,
	OpenVikingDaemonRequestError,
	OpenVikingDaemonUnreachableError,
	type OpenVikingDaemonHttp,
} from "./daemon-http.js";
import type { OpenVikingAbstractReason } from "./explorer-types.js";
import { explorerRefusal, isoModTime } from "./explorer-rules.js";
import { OpenVikingDashboardError } from "./types.js";
import { resolveRequestHeaders } from "./uri.js";

const SHARED_HEADERS = resolveRequestHeaders("user");

/** The daemon's text for a folder whose abstract is still being built (spec-explorer-build.md, `content/abstract`). */
const NOT_READY_MARK = "[Directory abstract is not ready]";

/** A daemon failure as the explorer answers it; any other error (a refusal, a bad request) is returned as is. */
export function toExplorerError(err: unknown): unknown {
	if (err instanceof OpenVikingDaemonUnreachableError) {
		return explorerRefusal("MEMORY_UNREACHABLE", "The memory store is not answering.");
	}
	if (err instanceof OpenVikingDaemonRequestError && err.upstreamCode === "NOT_FOUND") {
		return explorerRefusal("NOT_FOUND", "No memory at this uri.");
	}
	if (
		err instanceof OpenVikingDaemonRequestError ||
		(err instanceof OpenVikingDashboardError && err.code === DAEMON_BAD_RESPONSE)
	) {
		return explorerRefusal("MEMORY_ERROR", `The memory store answered an error: ${err.message}`, {
			upstream_code: err instanceof OpenVikingDaemonRequestError ? err.upstreamCode : err.code,
		});
	}
	return err;
}

/** `/health` must answer ok before a route reads anything (`503 MEMORY_UNREACHABLE` otherwise). */
export async function isMemoryReachable(http: OpenVikingDaemonHttp): Promise<boolean> {
	return http.isHealthy(SHARED_HEADERS);
}

export async function assertMemoryReachable(http: OpenVikingDaemonHttp): Promise<void> {
	if (!(await isMemoryReachable(http))) {
		throw explorerRefusal("MEMORY_UNREACHABLE", "The memory store is not answering.");
	}
}

export interface OpenVikingExplorerStat {
	isDir: boolean;
	size: number | null;
	/** ISO-8601 UTC with ms. */
	modTime: string;
}

/** `fs/stat` of one uri; a missing uri throws the daemon's `NOT_FOUND` (callers map it). */
export async function statUri(
	http: OpenVikingDaemonHttp,
	uri: string,
	headers: Record<string, string>,
): Promise<OpenVikingExplorerStat> {
	const raw = await http.result("/api/v1/fs/stat", { uri }, headers);
	const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
	const modTime = isoModTime(o.modTime);
	if (typeof o.isDir !== "boolean" || modTime === null) {
		throw new OpenVikingDashboardError(`fs/stat of ${uri} lacks isDir or modTime`, 502, DAEMON_BAD_RESPONSE, { uri });
	}
	return { isDir: o.isDir, size: typeof o.size === "number" ? o.size : null, modTime };
}

/**
 * A text answer, or null with why: `none` (empty) or, for a folder abstract only, `not_ready` (the daemon's
 * not-ready mark, never shown as text). A note's own text is returned whole whatever it ends with.
 */
export function textWithReason(
	raw: unknown,
	isAbstract = true,
): {
	text: string | null;
	reason: Exclude<OpenVikingAbstractReason, "locked"> | null;
} {
	if (typeof raw !== "string" || raw.trim() === "") return { text: null, reason: "none" };
	if (isAbstract && raw.trimEnd().endsWith(NOT_READY_MARK)) return { text: null, reason: "not_ready" };
	return { text: raw, reason: null };
}
