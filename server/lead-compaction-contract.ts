/** Shared H/E/T wire values. Proofs are private; Status must never carry chat content. */
export type LeadTrigger = "settled" | "startup" | "home-open" | "idle";
export interface Fence {
	readonly sessionId: string;
	readonly source: string;
	readonly generation: number;
	readonly mutationRevision: number;
	readonly bindingEpoch: number;
	readonly leafId: string | null;
	readonly cached: boolean;
}
export interface PreparedBase {
	readonly planId: string;
	readonly planHash: string;
	readonly originalFence: Fence;
	readonly bindingFingerprint: string;
	readonly archiveFingerprints: readonly string[];
	readonly sourceHash: string;
	readonly protectedHash: string;
	readonly tailHash: string;
	readonly checkpointHash: string;
}
export interface PrefixPrepared extends PreparedBase {
	readonly strategy?: "prefix";
	readonly boundary: string | null;
	readonly summaryHash: string;
	readonly anchorHash: string;
}
export interface SparsePrepared extends PreparedBase { readonly strategy: "sparse" }
export type Prepared = PrefixPrepared | SparsePrepared;
declare const ticketBrand: unique symbol;
/** Host-created identity capability; serialized/cloned objects cannot be used to commit. */
export interface Ticket {
	readonly [ticketBrand]: true;
}
export type LeadState =
	"checking" | "archiving" | "partial" | "waiting_busy" | "ready" | "applied" | "blocked" | "protected_floor";
export interface Status {
	readonly state: LeadState;
	readonly sessionId: string;
	readonly role?: string;
	readonly planId?: string;
	readonly planHash?: string;
	readonly cursor?: number;
	readonly total?: number;
	readonly trigger?: LeadTrigger;
	readonly measurementSource?: "native-usage" | "current-projection";
	readonly measurementRevision?: number;
	readonly beforeEstimate?: number;
	readonly afterEstimate?: number;
	readonly protectedFloorEstimate?: number;
	readonly lastAttempt?: string;
	readonly errorCode?: string;
	readonly at?: string;
	readonly nativeEntryId?: string;
	readonly nextRetryReason?: string;
}
/** T consumes this capability; construction/wiring belongs to integration, never client input. */
export interface LeadChecks {
	requestCheck(request: { sessionId: string; trigger: LeadTrigger }): Promise<Status>;
}
export interface CanonicalHome {
	readonly role: string;
	readonly sessionId: string;
}
export interface LeadDiscovery {
	enumerateCanonicalHomes(): readonly CanonicalHome[];
}
export type LeadProgress = (status: Status) => void;
/** Trusted E exports. resume revalidates archive/binding/content against fresh host fence.
 * E receives issueTicket only in the host-created bridge closure, never over public transport.
 * Native draft content is not in Prepared or Status and must never be logged.
 */
export interface PrefixNativeDraft {
	readonly strategy?: "prefix";
	readonly summary: string;
	readonly firstKeptEntryId: string | null;
	readonly tokensBefore: number;
	readonly details: Readonly<Record<string, unknown>>;
}
export interface SparseNativeDraft { readonly strategy: "sparse"; readonly application: unknown }
export type NativeDraft = PrefixNativeDraft | SparseNativeDraft;
export interface VerifiedCommit {
	readonly prepared: Prepared;
	readonly fence: Fence;
	readonly draft: NativeDraft;
}
export interface ExecutorHost {
	captureFence(sessionId: string): Fence;
	issueTicket(verified: VerifiedCommit): Ticket;
}
export interface LeadExecutor {
	prepare(fence: Fence): Promise<Prepared | Status>;
	resume(planId: string, planHash: string): Promise<Ticket | Status>;
	/** Append-only durable attempt in the existing E journal; rejects on failed durability. */
	acknowledge(prepared: Prepared, result: { nativeEntryId: string; fence: Fence; recovered: boolean }): Promise<void>;
	nativeProgress?(prepared: Prepared, cursor: number, nativeEntryId: string, fence: Fence): Promise<void>;
}
export interface LeadNativeHost extends ExecutorHost {
	tryApply(ticket: Ticket): Promise<Status>;
}
