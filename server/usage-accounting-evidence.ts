/** Worker-private evidence for W5. Structural backwards compatibility, not a new collector importer. */
import type { AccountingFault } from "./usage-accounting-contract.js";
interface UsageEvidenceFields {
	/** Strictly increases within one Worker epoch, even across Pacific Monday. */
	sequence: number;
	/** End of the planned pass, not an occurrence watermark. */
	asOf: string;
	/** Committed log/checkpoint integrity. A failed hash is unavailable, never a healthy empty week. */
	storage: "healthy" | "partial" | "unavailable";
	/** Entire stat inventory finished under its cap, with no unreadable folder. */
	inventoryComplete: boolean;
	/** Grouped kind/week streams. Backlog and gaps are in their coverage, not hidden by pass completion. */
	requiredStreams: string[];
	faults: AccountingFault[];
	/** Affected code/source buckets, not charge counts. */
	faultCounts: { code: string; count: number }[];
}
export type UsageEvidence =
	| (UsageEvidenceFields & { v: "usage-collector-evidence/1" })
	| (UsageEvidenceFields & { v: "usage-evidence/2"; producer: "week-pass" });
export type WeekPassEvidence = Extract<UsageEvidence, { producer: "week-pass" }>;
export function supportedUsageEvidence(e: UsageEvidence): boolean {
	return e.v === "usage-collector-evidence/1" || (e.v === "usage-evidence/2" && e.producer === "week-pass");
}
