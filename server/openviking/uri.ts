/**
 * OpenViking Memory Dashboard — the one canonical URI rewriter (R-URI-REWRITE-1, R-URI-CANONICAL-1).
 *
 * openviking==0.5.4 resolves bare `viking://user/memories/...` to owner `memories`, so every request
 * goes out with the canonical form (G8):
 * - `viking://resources/...`                      -> as is, shared headers
 * - `viking://user/memories/...`                  -> `viking://user/default/memories/...`, shared headers
 * - `viking://agent/memories/...` + role          -> `viking://user/<role>/memories/...`, role headers
 * - `viking://session/<rest>` + role              -> `viking://user/<role>/sessions/<rest>`, role headers
 */
import {
	DEFAULT_OPENVIKING_ACCOUNT,
	DEFAULT_OPENVIKING_SHARED_USER,
	OPENVIKING_ACCOUNT_HEADER,
	OPENVIKING_AGENT_HEADER,
	OPENVIKING_USER_HEADER,
	OpenVikingDashboardError,
	type OpenVikingEntryScope,
	type RewrittenVikingUri,
} from "./types.js";

const SCHEME = "viking://";
const ROLE_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

function invalidUri(uri: unknown, reason: string): OpenVikingDashboardError {
	return new OpenVikingDashboardError(`Invalid OpenViking URI "${String(uri)}": ${reason}.`, 400, "INVALID_ARGUMENT", {
		uri,
	});
}

/** A personal-memory owner: a role id, never the shared `default` user. */
export function assertRoleId(role: unknown): string {
	if (typeof role !== "string" || !ROLE_ID_RE.test(role) || role === DEFAULT_OPENVIKING_SHARED_USER) {
		throw new OpenVikingDashboardError(
			`Invalid role "${String(role)}": expected a role id such as "backend".`,
			400,
			"INVALID_ARGUMENT",
			{ role },
		);
	}
	return role;
}

/** R-URI-REWRITE-1 outbound headers: Layer 1 shared reads as `default`, Layer 2 reads as the role. */
export function resolveRequestHeaders(scope: OpenVikingEntryScope, role?: string): Record<string, string> {
	if (scope !== "agent") {
		return {
			[OPENVIKING_ACCOUNT_HEADER]: DEFAULT_OPENVIKING_ACCOUNT,
			[OPENVIKING_USER_HEADER]: DEFAULT_OPENVIKING_SHARED_USER,
		};
	}
	const id = assertRoleId(role);
	return {
		[OPENVIKING_ACCOUNT_HEADER]: DEFAULT_OPENVIKING_ACCOUNT,
		[OPENVIKING_USER_HEADER]: id,
		[OPENVIKING_AGENT_HEADER]: id,
	};
}

function joinPath(prefix: string, segments: readonly string[]): string {
	const rest = segments.join("/");
	return rest ? `${prefix}/${rest}` : prefix;
}

function shared(canonicalUri: string, logicalUri: string, scope: "resources" | "user"): RewrittenVikingUri {
	return {
		canonicalUri,
		logicalUri,
		scope,
		layer: "layer1_shared",
		role: null,
		headers: resolveRequestHeaders(scope),
	};
}

function personal(canonicalUri: string, logicalUri: string, role: string): RewrittenVikingUri {
	return {
		canonicalUri,
		logicalUri,
		scope: "agent",
		layer: "layer2_personal",
		role,
		headers: resolveRequestHeaders("agent", role),
	};
}

function requireRole(uri: string, role: string | undefined): string {
	if (role === undefined) throw invalidUri(uri, "a personal memory URI needs the owning role");
	return assertRoleId(role);
}

export function rewriteVikingUri(uri: string, role?: string): RewrittenVikingUri {
	if (typeof uri !== "string" || !uri.startsWith(SCHEME)) throw invalidUri(uri, `expected the ${SCHEME} scheme`);
	const segments = uri.slice(SCHEME.length).split("/");
	if (segments.some((s, i) => s === ".." || s === "." || (s === "" && i < segments.length - 1))) {
		throw invalidUri(uri, "empty, '.' or '..' path segments are not allowed");
	}
	const [head, ...rest] = segments;
	if (head === "resources") return shared(uri, uri, "resources");
	if (head === "user") {
		const [owner, ...tail] = rest;
		if (owner === "memories") return shared(joinPath("viking://user/default/memories", tail), uri, "user");
		if (owner === DEFAULT_OPENVIKING_SHARED_USER) {
			const logical = tail[0] === "memories" ? joinPath("viking://user/memories", tail.slice(1)) : uri;
			return shared(uri, logical, "user");
		}
		const ownerRole = assertRoleId(owner);
		if (role !== undefined && role !== ownerRole) {
			throw invalidUri(uri, `the URI belongs to role "${ownerRole}", not "${role}"`);
		}
		const logical = tail[0] === "memories" ? joinPath("viking://agent/memories", tail.slice(1)) : uri;
		return personal(uri, logical, ownerRole);
	}
	if (head === "agent") {
		const id = requireRole(uri, role);
		return personal(joinPath(`viking://user/${id}`, rest), uri, id);
	}
	if (head === "session") {
		const id = requireRole(uri, role);
		return personal(joinPath(`viking://user/${id}/sessions`, rest), uri, id);
	}
	throw invalidUri(uri, `unknown namespace "${head}"`);
}

/** Scope of a URI as written in a state file, or null when it is not a well-formed OpenViking URI. */
export function scopeOfUri(uri: string, role: string | null): RewrittenVikingUri | null {
	try {
		return rewriteVikingUri(uri, role ?? undefined);
	} catch {
		return null;
	}
}

/**
 * R-ISOLATION-1: only Layer 1 shared URIs may show content. Anything personal, or anything that
 * cannot be classified, is treated as another role's private memory (fail closed).
 */
export function isSharedUri(uri: string, role: string | null): boolean {
	const scope = scopeOfUri(uri, role)?.scope;
	return scope === "resources" || scope === "user";
}

/** A session's own URI: `viking://session/<id>`, or its canonical form `viking://user/<role>/sessions/<id>`. */
export const isSessionUri = (uri: string): boolean => /^viking:\/\/(?:session|user\/[^/]+\/sessions)\/[^/]/.test(uri);
