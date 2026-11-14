/**
 * Memory Explorer — the owner gate (R-OWNER-GATE-1, spec-explorer-owner.md): every explorer route asks this one gate
 * before anything else (before it parses a uri, checks a query or body, applies the setup-file lock or calls the
 * daemon; Security rm-b52897e2 L1) and answers `403 OWNER_ONLY` when it says no, so a request without a session
 * learns nothing about its input. A read needs a passkey owner session, which reads all 17 roots (R-OWNER-READ-1).
 * A write names the exact operation it is about to execute and needs the session plus its own fresh passkey assertion
 * bound to that operation (R-OWNER-WRITE-1/2). A `Host` or `Origin` whose host ends in "." never passes
 * (rm-638da86a). Production's gate is the passkey owner check's (owner-check.ts, wired in route-modules.ts); with
 * no owner check wired the gate is `ownerCheckMissing`, which refuses everyone (fail closed). Tests inject theirs.
 */
import type { Request } from "express";
import { explorerRefusal } from "./explorer-rules.js";
import { OWNER_ONLY_BODY, type OwnerWriteOp } from "./owner-session-types.js";

export type OwnerReadAccess = { kind: "read" };
export type OwnerWriteAccess = { kind: "write"; op: OwnerWriteOp };
/** What a request asks for: a read, or the write `op`. */
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

/** `value` (a Host, or an Origin when `scheme` is "") parses as a URL whose host does not end in "." */
function undottedHost(value: string, scheme: "http://" | ""): boolean {
	try {
		const host = new URL(`${scheme}${value}`).hostname;
		return host !== "" && !host.endsWith(".");
	} catch {
		return false;
	}
}

/**
 * Whether the request's `Host` and `Origin` (when sent) name hosts the owner routes may answer: each must parse as a
 * URL (percent-encoding decoded) and its host must not end in "." (rm-638da86a). Exact origin matching comes after,
 * in the owner check. The app-wide Host allowlist (`httpHostAllowed`) is unchanged.
 */
export function ownerAddressAllowed(req: Request): boolean {
	const host = req.headers.host;
	if (typeof host !== "string" || !undottedHost(host, "http://")) return false;
	const origin = req.headers.origin;
	return origin === undefined || undottedHost(origin, "");
}

/** Throws `403 OWNER_ONLY` unless the address is allowed and the gate passes the read. Writes use `assertOwnerWrite`. */
export function assertOwner(gate: OpenVikingOwnerGate, req: Request): void {
	if (!ownerAddressAllowed(req) || gate(req, { kind: "read" }) !== true) throw refuse();
}

/** Rejects with `403 OWNER_ONLY` unless the address is allowed and the gate passes the write `op` (await it first). */
export async function assertOwnerWrite(gate: OpenVikingOwnerGate, req: Request, op: OwnerWriteOp): Promise<void> {
	let passed = false;
	try {
		passed = ownerAddressAllowed(req) && (await gate(req, { kind: "write", op })) === true;
	} catch {
		passed = false;
	}
	if (!passed) throw refuse();
}
