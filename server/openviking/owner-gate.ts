/**
 * Memory Explorer — the owner check (R-EXPLORER-OWNER-1, open item OI-1). Every explorer route, reads too, asks its
 * gate before anything else and answers `403 OWNER_ONLY` when it says no. pi-web-ui has no owner session yet:
 * Security names the check (separate task). Until then the production gate is `ownerCheckMissing`, which refuses
 * every request (fail closed). Routes get the gate as a dependency; tests inject their own allow or deny gate.
 */
import type { Request } from "express";
import { explorerRefusal } from "./explorer-rules.js";

/** true only for a request the owner made. */
export type OpenVikingOwnerGate = (req: Request) => boolean;

/** No owner check exists yet (OI-1): nobody passes. */
export const ownerCheckMissing: OpenVikingOwnerGate = () => false;

/** Throws `403 OWNER_ONLY` unless the gate passes the request. */
export function assertOwner(gate: OpenVikingOwnerGate, req: Request): void {
	if (!gate(req)) {
		throw explorerRefusal("OWNER_ONLY", "The memory explorer is for the owner only.");
	}
}
