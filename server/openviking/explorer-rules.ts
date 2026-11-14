/**
 * Memory Explorer — the shared rules both build slices use, pure and in one place (backend #161): the uri rule
 * (R-EXPLORER-URI-1), the setup-file lock (R-EXPLORER-LOCK-1, G8), the Kind table, operation ids, mod_time
 * parsing and comparison, the exact-search escape, and the refusal error itself. Spec:
 * `.temper/features/openviking-dashboard/spec-explorer{,-writes}.md` (architecture #541).
 */
import {
	EXPLORER_SETUP_FILE_NAMES,
	EXPLORER_URI_MAX_CHARS,
	OPENVIKING_EXPLORER_REFUSAL_STATUS,
	type OpenVikingExplorerKind,
	type OpenVikingExplorerRefusalCode,
	type OpenVikingExplorerRefusalDetails,
	type OpenVikingExplorerRoot,
	type OpenVikingExplorerUri,
} from "./explorer-types.js";
import { OPENVIKING_EXPLORER_ROOTS } from "./memory-tree.js";
import { OpenVikingDashboardError } from "./types.js";
import { resolveRequestHeaders } from "./uri.js";

const SCHEME = "viking://";

/** A refusal in the existing error body `{ error: { code, message, details? } }`, with the spec's status. */
export function explorerRefusal(
	code: OpenVikingExplorerRefusalCode,
	message: string,
	details?: OpenVikingExplorerRefusalDetails & Record<string, unknown>,
): OpenVikingDashboardError {
	return new OpenVikingDashboardError(message, OPENVIKING_EXPLORER_REFUSAL_STATUS[code], code, details);
}

const invalid = (raw: unknown, reason: string) =>
	explorerRefusal("URI_INVALID", `Invalid memory uri: ${reason}.`, { uri: typeof raw === "string" ? raw : null });

/**
 * R-EXPLORER-URI-1. Takes the uri as the route received it (query value or body field), decodes it once, drops
 * one trailing `/`, and returns it with the root it lies under. `400 URI_INVALID`: not a string, a malformed
 * escape, not `viking://`, a `.` / `..` / empty segment, `\` or NUL, over 1024 chars. `400 URI_OUTSIDE_ROOTS`:
 * under none of the 17 roots, the aliases `viking://agent/...` and `viking://user/memories/...` included.
 */
export function parseExplorerUri(raw: unknown): OpenVikingExplorerUri {
	if (typeof raw !== "string") throw invalid(raw, "expected a string");
	let decoded: string;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		throw invalid(raw, "malformed percent-escape");
	}
	if (decoded.length > EXPLORER_URI_MAX_CHARS) throw invalid(raw, `over ${EXPLORER_URI_MAX_CHARS} characters`);
	if (decoded.includes("\\") || decoded.includes("\0")) throw invalid(raw, "backslash or NUL");
	if (!decoded.startsWith(SCHEME)) throw invalid(raw, `expected the ${SCHEME} scheme`);
	const uri = decoded.endsWith("/") ? decoded.slice(0, -1) : decoded;
	const segments = uri.slice(SCHEME.length).split("/");
	if (segments.some((s) => s === "" || s === "." || s === "..")) {
		throw invalid(raw, "empty, '.' or '..' path segment");
	}
	const root = OPENVIKING_EXPLORER_ROOTS.find((r) => uri === r.uri || uri.startsWith(`${r.uri}/`));
	if (!root) {
		throw explorerRefusal("URI_OUTSIDE_ROOTS", "The uri is under none of the memory explorer's roots.", { uri });
	}
	return { uri, root };
}

/** The root `uri` names exactly, or null (G4 `roots[]`: each exactly one of the 17, else `ROOT_UNKNOWN`). */
export const explorerRootNamed = (uri: unknown): OpenVikingExplorerRoot | null =>
	OPENVIKING_EXPLORER_ROOTS.find((r) => r.uri === uri) ?? null;

/** Outbound headers for a daemon call about a uri under `root`: the root's role, or shared. */
export const explorerRootHeaders = (root: OpenVikingExplorerRoot): Record<string, string> =>
	root.role === null
		? resolveRequestHeaders(root.group === "projects" ? "resources" : "user")
		: resolveRequestHeaders("agent", root.role);

/** R-EXPLORER-LOCK-1 (G8): the last segment is `identity.md` or `soul.md`, any case. */
export function isSetupFile(uri: string): boolean {
	const last = uri.slice(uri.lastIndexOf("/") + 1).toLowerCase();
	return (EXPLORER_SETUP_FILE_NAMES as readonly string[]).includes(last);
}

const KIND_OF_FIRST_SEGMENT: Record<string, OpenVikingExplorerKind> = {
	preferences: "rule",
	cases: "case",
	experiences: "case",
	entities: "fact",
	events: "event",
};

/** Kind, from the first segment under the root; anything under `viking://resources` is a document. */
export function explorerKindOf(uri: string, root: OpenVikingExplorerRoot): OpenVikingExplorerKind {
	if (root.group === "projects") return "document";
	const below = uri.startsWith(`${root.uri}/`) ? uri.slice(root.uri.length + 1) : "";
	const first = below.split("/")[0];
	return Object.hasOwn(KIND_OF_FIRST_SEGMENT, first) ? KIND_OF_FIRST_SEGMENT[first] : "other";
}

export const OPERATION_ID_RE = /^op-\d+-[0-9a-f]{8}$/;

/** `op-<ms>-<8 hex>`, set when the request is registered; `random` is 4 bytes (crypto in production). */
export function operationIdOf(ms: number, random: Uint8Array): string {
	if (!Number.isSafeInteger(ms) || ms < 0) throw new RangeError(`operation id time must be epoch ms, got ${ms}`);
	if (random.length !== 4) throw new RangeError(`operation id needs 4 random bytes, got ${random.length}`);
	return `op-${ms}-${Buffer.from(random).toString("hex")}`;
}

/** The daemon's `modTime` ("…:57Z" or "…:57.000Z") as ISO-8601 UTC with ms; null when absent or unparseable. */
export function isoModTime(raw: unknown): string | null {
	if (typeof raw !== "string" || raw.trim() === "") return null;
	const ms = Date.parse(raw);
	return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Two mod_times are the same instant, compared as ms (G5 `NOTE_CHANGED`, undo `UNDO_REFUSED`); unparseable never is. */
export function sameModTime(a: string, b: string): boolean {
	const x = Date.parse(a);
	const y = Date.parse(b);
	return !Number.isNaN(x) && x === y;
}

/** G4 exact: the query as a literal regex (the daemon's grep `pattern` is a regex, gap D6). */
export const escapeRegex = (query: string): string => query.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
