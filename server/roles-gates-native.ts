/** G0 (#143) missing production inputs. INERT; no reader, I/O, timer, registry or instance.
 * These getters always return null. No options/env/caller data may substitute inputs.
 * Native producers/atomic confirmation commit require a separate reviewed T02/T03/T05 change.
 */
import type { RtpiCapability, RtpiQualification, RtpiRef } from "./rtpi-core.js";
import type {
	RolesArtifactIdentity,
	RolesGateBinding,
	RolesLifecycleStage,
	RolesProducerContext,
} from "./roles-artifact.js";
import type { ContactEnvelope } from "./roles-contact.js";

/** A committed canonical operation and its OWN native run-record context. */
export interface NativeGateReceipt {
	readonly root: unknown;
	readonly reference: RtpiRef;
	readonly producer: RolesProducerContext;
	readonly qualification: RtpiQualification;
}
export interface NativeGateOperation {
	readonly measurement: unknown;
	readonly receipt: NativeGateReceipt;
}
/** Content-free closed index; refs are tokens, NEVER paths/sidecar reader instructions. */
export interface NativeGateIndexEntry {
	readonly kind: RolesArtifactIdentity["kind"];
	readonly artifact: RtpiRef;
	readonly contract: RtpiRef;
	readonly targetEnvironment: string;
	readonly stage: RolesLifecycleStage | "owner-confirmed";
	readonly reference: RtpiRef;
	readonly source: RtpiRef;
	readonly issuer: RtpiRef;
	readonly lineage: RtpiRef;
	readonly incarnation: string;
	readonly sequence: number;
	readonly revision: number;
	readonly digest: string;
	readonly producer: RolesProducerContext;
	readonly installReceipt: RtpiRef | null;
}
export interface NativeGateStream {
	readonly source: RtpiRef;
	readonly issuer: RtpiRef;
	readonly lineage: RtpiRef;
	readonly incarnation: string;
	readonly sequence: number;
	readonly revision: number;
}
export interface NativeGateIndex {
	readonly complete: boolean;
	readonly streams: readonly NativeGateStream[];
	readonly entries: readonly NativeGateIndexEntry[];
}
export interface NativeGateTaskLink {
	readonly binding: RolesGateBinding;
	/** Native FULL-key index resolutions for the task's own producer receipt. */
	readonly resolutions: readonly RolesArtifactIdentity[];
	readonly receipt: NativeGateReceipt;
}
export interface NativeGateInstallPointer {
	readonly identity: RolesArtifactIdentity;
	readonly operation: "install" | "rollback";
	readonly operationReceipt: NativeGateOperation;
}
export interface NativeGateState {
	readonly binding: RolesArtifactIdentity;
	readonly contract: unknown;
	readonly qualification: RtpiQualification;
	readonly index: NativeGateIndex | null;
	/** ONE current native task/run record, or null for artifact-only history. */
	readonly currentTask: RolesProducerContext | null;
	readonly taskLink: NativeGateTaskLink | null;
	readonly latestInstall: NativeGateInstallPointer | null;
	readonly projection: RtpiRef | null;
	readonly coverage: RtpiRef | null;
	readonly policy: RtpiRef | null;
}
export function nativeGateState(): NativeGateState | null {
	return null;
}
export function nativeGateCapability(_stage?: RolesLifecycleStage): RtpiCapability | null {
	return null;
}
export function nativeGateObservation(_stage: RolesLifecycleStage): NativeGateOperation | null {
	return null;
}
export interface NativeGateConfirmationSource {
	readonly envelope: ContactEnvelope;
	readonly qualification: RtpiQualification;
	/** MUST be the canonical root already atomically committed with challenge consumption. */
	readonly root: unknown;
}
/** OWN client-native canonical source; never lifecycle sourceCommitted/capability. */
export function nativeGateConfirmationSource(): NativeGateConfirmationSource | null {
	return null;
}
