/**
 * Memory Explorer — the owner gate (R-OWNER-GATE-1, spec-explorer-owner.md): every explorer route asks this one gate
 * before anything else and answers `403 OWNER_ONLY` when it says no. A read names the roots whose content its answer
 * would show (`[]`: counts only) and needs a passkey owner session (R-OWNER-READ-1). A write names the exact operation
 * it is about to execute and needs the session plus its own fresh passkey assertion bound to that operation
 * (R-OWNER-WRITE-1/2). Production's gate is the passkey owner check's (owner-check.ts, wired in route-modules.ts);
 * with no owner check wired the gate is `ownerCheckMissing`, which refuses everyone (fail closed). Tests inject theirs.
 */
import type { Request } from "express";
import { explorerRefusal } from "./explorer-rules.js";
import { OWNER_ONLY_BODY, type OwnerWriteOp } from "./owner-session-types.js";

export type OwnerReadAccess = { kind: "read"; roots: readonly string[] };
export type OwnerWriteAccess = { kind: "write"; op: OwnerWriteOp };
/** What a request asks for: a read showing the content of `roots`, or the write `op`. */
export type OpenVikingOwnerAccess = OwnerReadAccess | OwnerWriteAccess;

/**
 * `true` only when the owner made the request and may have `access`. A read is answered synchronously (anything but
 * `true`, a promise included, refuses it); a write may be answered with a promise (its assertion is verified async).
 */
export type OpenVikingOwnerGate = (req: Request, access: OpenVikingOwnerAccess) => boolean | Promise<boolean>;

/** No owner check wired: nobody passes. */
export const ownerCheckMissing: OpenVikingOwnerGate = () => false;

/** R-OWNER-REFUSE-1: the same body as the owner routes' refusal, whatever failed. */
const refuse = () => explorerRefusal("OWNER_ONLY", OWNER_ONLY_BODY.error.message);

/** Whether the gate lets the request read the content of `roots` (for filtering, e.g. `recent[]`). */
export function ownerMayRead(gate: OpenVikingOwnerGate, req: Request, roots: readonly string[]): boolean {
	return gate(req, { kind: "read", roots }) === true;
}

/** Throws `403 OWNER_ONLY` unless the gate passes the read. Writes use `assertOwnerWrite`. */
export function assertOwner(gate: OpenVikingOwnerGate, req: Request, access: OwnerReadAccess): void {
	if (!ownerMayRead(gate, req, access.roots)) throw refuse();
}

/** Rejects with `403 OWNER_ONLY` unless the gate passes the write `op` (await it before executing anything). */
export async function assertOwnerWrite(gate: OpenVikingOwnerGate, req: Request, op: OwnerWriteOp): Promise<void> {
	let passed = false;
	try {
		passed = (await gate(req, { kind: "write", op })) === true;
	} catch {
		passed = false;
	}
	if (!passed) throw refuse();
}
