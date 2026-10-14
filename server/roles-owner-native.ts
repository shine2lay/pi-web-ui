/** Native inputs of O0 (#140), production defaults only. INERT: no production importer, instance, I/O or timer.
 *
 * Security rm-4c755cd7 (B1): the production default is the only reachable admitter and capability. No option,
 * argument, env, config or flag selects another one: the challenge handler and the contact roots read them from
 * here and nowhere else. Tests replace this module with vi.mock; production modules export no fixture admitter or
 * capability. T03 (native owner principal) and T05 (native issuer registry) need their own Security review before
 * any body below changes; until then every owner principal is unknown and no owner root can be accepted.
 */
import type { RtpiCapability, RtpiRef } from "./rtpi-core.js";
import type { OwnerHostConnection, OwnerPrincipalAdmission } from "./roles-owner-challenge.js";

/** T03 is missing: no connection is admitted as the owner, whatever its origin, scope, channel or labels. */
export function admitNativeOwnerPrincipal(_connection: OwnerHostConnection): OwnerPrincipalAdmission {
	return { admitted: false, reason: "owner-principal-not-admitted" };
}

/** The native owner principal a saved answer belongs to (T03): missing, so the owner is unknown. */
export function nativeOwnerOfSession(_session: RtpiRef): RtpiRef | null {
	return null;
}

/** T05 is missing and C0 has no native capability constructor: no owner root can be accepted. */
export function nativeContactCapability(): RtpiCapability | null {
	return null;
}

/** Native server wall clock, ms. */
export function serverWallNow(): number {
	return Date.now();
}

/** Monotonic server clock, ms: a wall-clock step does not move it. */
export function serverMonotonicNow(): number {
	return performance.now();
}
