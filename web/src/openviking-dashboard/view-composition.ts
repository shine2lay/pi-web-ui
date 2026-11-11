/**
 * Composition rules the root view applies on top of the view models (frontend #258, Task 2).
 *
 * Two jobs, both about not claiming more than the data supports:
 *  - the zero-activity guard: the 24h summary may only be read as "nothing happened" when the logs
 *    the page is showing are empty too; otherwise the summary is simply behind, which is `stale`;
 *  - resolving a clicked row back to the API object the drawer reads from.
 */

import type {
	OpenVikingAuditResponse,
	OpenVikingEntriesResponse,
	OpenVikingOverviewResponse,
} from "../../../server/openviking/types.js";
import { entryIsPersonal, type OpenVikingTierReadState } from "./drawer-view-model.js";
import { formatAge, loadingValue, textValue } from "./format.js";
import { buildStatePresentation } from "./state-presentation.js";
import { OPENVIKING_UNREACHABLE_TEXT, OPENVIKING_ZERO_ACTIVITY_TEXT } from "./text.js";
import type {
	OpenVikingContentError,
	OpenVikingDisplayValue,
	OpenVikingDrawerSource,
	OpenVikingEntryContent,
	OpenVikingStatePresentation,
	OpenVikingStatusHeaderModel,
	OpenVikingSummaryCardModel,
} from "./view-model-types.js";

/** Which row the reader drawer is open on. */
export type OpenVikingRowAddress =
	| { readonly kind: "memory"; readonly rowKey: string }
	| { readonly kind: "audit"; readonly rowKey: string }
	| { readonly kind: "slot"; readonly slotId: number };

/**
 * May the page say "zero activity"? Only when the streams it is showing are empty as well. With
 * rows on screen, a 24h summary of zero is a summary that has not caught up — never a healthy
 * quiet period, and never a reason to paint a zero-activity badge next to a list of events.
 */
export function allowZeroActivityClaim(
	entries: OpenVikingEntriesResponse | null,
	audit: OpenVikingAuditResponse | null,
): boolean {
	return (entries?.entries.length ?? 0) === 0 && (audit?.events.length ?? 0) === 0;
}

export function guardPresentation(
	presentation: OpenVikingStatePresentation,
	allowZero: boolean,
): OpenVikingStatePresentation {
	if (allowZero || presentation.healthState !== "zero-activity") return presentation;
	return buildStatePresentation("stale", presentation.staleBadge);
}

export function guardZeroActivityCards(
	cards: readonly OpenVikingSummaryCardModel[],
	entries: OpenVikingEntriesResponse | null,
	audit: OpenVikingAuditResponse | null,
): readonly OpenVikingSummaryCardModel[] {
	const allowZero = allowZeroActivityClaim(entries, audit);
	if (allowZero) return cards;
	return cards.map((card) => ({
		...card,
		presentation: guardPresentation(card.presentation, allowZero),
		fields: card.fields.filter((field) => field.text !== OPENVIKING_ZERO_ACTIVITY_TEXT),
	}));
}

export function guardZeroActivityHeader(
	header: OpenVikingStatusHeaderModel,
	entries: OpenVikingEntriesResponse | null,
	audit: OpenVikingAuditResponse | null,
): OpenVikingStatusHeaderModel {
	const allowZero = allowZeroActivityClaim(entries, audit);
	if (allowZero || header.presentation.healthState !== "zero-activity") return header;
	return { ...header, presentation: guardPresentation(header.presentation, allowZero) };
}

/** "2m ago" for the header's own timestamps; a missing value never reads as a duration. */
export function ageValue(
	iso: string | null,
	nowMs: number,
	sourceField: string,
	loading: boolean,
): OpenVikingDisplayValue {
	if (loading) return loadingValue(sourceField);
	const age = formatAge(iso, nowMs);
	if (age === null) {
		return { text: OPENVIKING_UNREACHABLE_TEXT, sourceField, unreachable: true, notMeasured: false };
	}
	return textValue(`${age} ago`, sourceField);
}

/** The clicked row, resolved back to the API object the drawer reads. */
export function resolveDrawerSource(
	address: OpenVikingRowAddress | null,
	overview: OpenVikingOverviewResponse | null,
	entries: OpenVikingEntriesResponse | null,
	audit: OpenVikingAuditResponse | null,
): OpenVikingDrawerSource | null {
	if (!address) return null;
	if (address.kind === "memory") {
		const index = Number.parseInt(address.rowKey.replace(/^mem-/, ""), 10) - 1;
		const entry = entries?.entries[index];
		return entry ? { kind: "memory", rowKey: address.rowKey, entry } : null;
	}
	if (address.kind === "audit") {
		const event = audit?.events.find((candidate) => candidate.id === address.rowKey);
		return event ? { kind: "audit", rowKey: address.rowKey, event } : null;
	}
	const slot = overview?.slots.find((candidate) => candidate.slot_id === address.slotId);
	return slot ? { kind: "slot", rowKey: `slot-${address.slotId}`, slot } : null;
}

/** Which URI the container must deep-read for the open row; null when there is nothing to read. */
export function deepReadUri(source: OpenVikingDrawerSource | null): string | null {
	if (!source || source.kind !== "memory") return null;
	// R-ISOLATION-1: another role's content is never even requested.
	return entryIsPersonal(source.entry) ? null : source.entry.uri;
}

export interface OpenVikingDrawerInput {
	readonly source: OpenVikingDrawerSource;
	readonly contentError: OpenVikingContentError | null;
	readonly read: OpenVikingTierReadState;
}

/**
 * The open row plus the deep read of its `L1`/`L2` (#259). The list payload carries `L0` only, so
 * without this the drawer would call every deeper tier "Not stored for this entry" even when the
 * daemon holds the text. A read still in flight reads as "Loading…", a failed one says so.
 */
export function applyEntryContent(
	source: OpenVikingDrawerSource | null,
	content: OpenVikingEntryContent | null,
): OpenVikingDrawerInput | null {
	if (!source) return null;
	const uri = deepReadUri(source);
	if (uri === null || source.kind !== "memory") return { source, contentError: null, read: "settled" };
	if (content === null || content.uri !== uri) return { source, contentError: null, read: "pending" };
	if (content.status === "loading") return { source, contentError: null, read: "pending" };
	if (content.status === "failed") return { source, contentError: content.error, read: "failed" };
	const deep = content.entry;
	return {
		source: {
			...source,
			entry: {
				...source.entry,
				l0_abstract: deep.l0_abstract ?? source.entry.l0_abstract,
				l1_overview: deep.l1_overview,
				l2_content: deep.l2_content,
				layers: deep.layers.length > 0 ? deep.layers : source.entry.layers,
			},
		},
		contentError: null,
		read: "settled",
	};
}
