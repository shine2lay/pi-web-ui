/** L0 native seams. INERT: no production imports/instances, I/O, hook registration or caller override.
 * T02/T05 and successful host incorporation are unavailable; T03 stays owned by O0.
 * J0 may replace these only with separately approved canonical host metadata, never file mtime,
 * before-agent-start preparation, a current profile, tool arguments or model payloads.
 */
import type { RtpiCapability, RtpiRef } from "./rtpi-core.js";
import type { NativeResourceCurrent, NativeResourceInput, ResourceCategory, ResourceScope } from "./roles-resource.js";

export function nativeResourceInput(): NativeResourceInput | null {
	return null;
}
export function nativeResourceCapability(): RtpiCapability | null {
	return null;
}
/** J0 must bind this lookup to O0's admitted owner of the canonical session, never a caller DTO. */
export function nativeResourceOwnerOfSession(_session: RtpiRef): RtpiRef | null {
	return null;
}
export function nativeResourceCurrent(
	_scope: ResourceScope,
	_category: ResourceCategory,
): NativeResourceCurrent | null {
	return null;
}
