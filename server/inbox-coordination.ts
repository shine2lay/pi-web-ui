import type { InboxClaim } from "./inbox-runtime.js";
import type { InboxLine, InboxView } from "./shared/inbox-wire.js";

export type InboxMutation<Line extends InboxLine = InboxLine> = Line extends unknown
	? Omit<Line, "v" | "seq" | "at" | "key" | "contentHash">
	: never;

/** Trusted server integration only. All callbacks execute under the canonical per-key lock.
 * Helpers consume this port; they must not create another ledger/store or copy lease checks.
 * append uses the canonical codec, sequence, content hash and fsync writer.
 */
export interface InboxCoordination {
	item(): InboxView | undefined;
	current(claim: InboxClaim, ending?: boolean): InboxView;
	lines(): readonly InboxLine[];
	append(fields: InboxMutation): void;
}
