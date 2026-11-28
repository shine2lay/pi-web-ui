import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { NativeDraft, Prepared } from "./lead-compaction-contract.js";

export const LEAD_COMPACTION_DETAIL = "leadCompaction";
export function nativeDetails(prepared: Prepared, draft: NativeDraft): Record<string, unknown> {
	if (prepared.strategy === "sparse" || draft.strategy === "sparse") throw new Error("prefix-draft-required");
	return {
		...draft.details,
		[LEAD_COMPACTION_DETAIL]: {
			planId: prepared.planId,
			planHash: prepared.planHash,
			summaryHash: prepared.summaryHash,
			boundary: prepared.boundary,
		},
	};
}
export function validateDraft(prepared: Prepared, draft: NativeDraft): void {
	if (prepared.strategy === "sparse" || draft.strategy === "sparse") throw new Error("sparse-adapter-required");
	if (
		createHash("sha256").update(draft.summary).digest("hex") !== prepared.summaryHash ||
		draft.firstKeptEntryId !== prepared.boundary ||
		!Number.isFinite(draft.tokensBefore) ||
		draft.tokensBefore < 0
	)
		throw new Error("native-draft-mismatch");
}
/** Fsync uses the existing file only; no new journal or alternate native writer. */
export async function syncNativeFile(source: string): Promise<void> {
	const handle = await open(source, "r+");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}
/** The native manager is authoritative for applied identity. Never inspect model payloads. */
export function appliedEntry(session: AgentSession, prepared: Prepared): string | undefined {
	if (prepared.strategy === "sparse") throw new Error("sparse-adapter-required");
	for (const entry of session.sessionManager.getEntries()) {
		if (entry.type !== "compaction") continue;
		const details = entry.details as Record<string, unknown> | undefined;
		const marker = details?.[LEAD_COMPACTION_DETAIL] as Record<string, unknown> | undefined;
		if (marker?.planId !== prepared.planId) continue;
		if (
			marker.planHash !== prepared.planHash ||
			marker.summaryHash !== prepared.summaryHash ||
			marker.boundary !== prepared.boundary ||
			entry.firstKeptEntryId !== prepared.boundary ||
			createHash("sha256").update(entry.summary).digest("hex") !== prepared.summaryHash
		)
			throw new Error("native-plan-conflict");
		return entry.id;
	}
	return undefined;
}
