/**
 * Memory Explorer — the owner check (R-OWNER-GATE-1, spec-explorer-owner.md): every explorer route asks this one gate
 * and answers `403 OWNER_ONLY` when it says no. A read names the roots whose content its answer would show; a write
 * names nothing more. Routes get the gate as a dependency; tests inject their own.
 *
 * Until the passkey owner session deploys (backend #165) the production gate is `ownerCheckPending`
 * (R-OWNER-INTERIM-1): no new exposure before the session exists, so writes are refused and a read passes only when
 * every root it would show is a shared root (what `/api/openviking/entries` already shows without a session).
 */
import type { Request } from "express";
import { explorerRefusal } from "./explorer-rules.js";
import { OPENVIKING_EXPLORER_ROOTS } from "./memory-tree.js";

/** What a request asks for: a write, or a read showing the content of `roots` (`[]`: counts only). */
export type OpenVikingOwnerAccess = { kind: "write" } | { kind: "read"; roots: readonly string[] };

/** true only when the owner may have `access`. */
export type OpenVikingOwnerGate = (req: Request, access: OpenVikingOwnerAccess) => boolean;

const SHARED_ROOTS: ReadonlySet<string> = new Set(
	OPENVIKING_EXPLORER_ROOTS.filter((r) => r.role === null).map((r) => r.uri),
);

/** R-OWNER-INTERIM-1: no session exists yet; shared-root reads and counts only, every write refused. */
export const ownerCheckPending: OpenVikingOwnerGate = (_req, access) =>
	access.kind === "read" && access.roots.every((root) => SHARED_ROOTS.has(root));

/** Throws `403 OWNER_ONLY` unless the gate passes the request for `access`. */
export function assertOwner(gate: OpenVikingOwnerGate, req: Request, access: OpenVikingOwnerAccess): void {
	if (!gate(req, access)) {
		throw explorerRefusal("OWNER_ONLY", "The memory explorer is for the owner only.");
	}
}
