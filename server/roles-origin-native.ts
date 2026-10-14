/** R0 (#141) native-only inputs. INERT: no production importer, registration, I/O, key or timer.
 * T02/T03/T05 are absent. No argument, option, environment variable, plugin/model flag or caller-supplied
 * admitter can replace these defaults. Tests use vi.mock, as O0 does. A future native implementation needs
 * independent issuer/outbox/owner review; this file is not an authentication or persistence implementation.
 */
import type { RtpiCapability, RtpiRef } from "./rtpi-core.js";
import type { NativeOriginInput, NativeOwnWorkPolicy } from "./roles-origin.js";

/** Must come from canonical queue-origin admission at the atomic plan commit, never parsed prose/approval. */
export function nativeOriginInput(): NativeOriginInput | null {
	return null;
}
export function nativeOriginCapability(): RtpiCapability | null {
	return null;
}
/** Explicit typed native declaration AND its authenticated policy action, not Board text or queue.running. */
export function nativeOwnWorkPolicy(_target: RtpiRef): NativeOwnWorkPolicy | null {
	return null;
}
