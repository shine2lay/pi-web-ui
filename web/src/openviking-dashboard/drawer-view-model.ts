/**
 * OpenViking Memory Dashboard — the L0/L1/L2 reader drawer (frontend #258 implements the #261 seam).
 */

import type {
	OpenVikingDisclosureTier,
	OpenVikingEntryProvenance,
	OpenVikingExplorerEntry,
} from "../../../server/openviking/types.js";
import { ISOLATED_AGENT_MEMORY_ABSTRACT } from "../../../server/openviking/types.js";
import { formatDisplayUri } from "./format.js";
import {
	openVikingClampNote,
	OPENVIKING_ABSTRACT_NOT_READ_TEXT,
	OPENVIKING_ISOLATION_NOTICE_TEXT,
	OPENVIKING_LAYER_LABELS,
	OPENVIKING_LOADING_CONTENT_TEXT,
	OPENVIKING_OFFLINE_CONTENT_TEXT,
	OPENVIKING_TIER_BODY_LIMIT,
	OPENVIKING_TIER_EMPTY_TEXT,
	OPENVIKING_TIER_READ_FAILED_TEXT,
} from "./text.js";
import type {
	OpenVikingContentError,
	OpenVikingDrawerModel,
	OpenVikingDrawerSource,
	OpenVikingDrawerTierModel,
	OpenVikingRenderState,
} from "./view-model-types.js";

const TIER_LABELS: Record<OpenVikingDisclosureTier, string> = {
	L0: "L0 Abstract",
	L1: "L1 Overview",
	L2: "L2 Full Content",
};

/**
 * How far the deep read of this row has got (#259). The list payload carries `L0` only, so
 * `L1`/`L2` may be null because nobody has asked for them yet — which is not the same as empty.
 */
export type OpenVikingTierReadState = "settled" | "pending" | "failed";

/** Long bodies are clamped so one 966,000-character `L2` cannot stall the drawer (#259). */
function clampBody(body: string): string {
	if (body.length <= OPENVIKING_TIER_BODY_LIMIT) return body;
	return body.slice(0, OPENVIKING_TIER_BODY_LIMIT) + openVikingClampNote(OPENVIKING_TIER_BODY_LIMIT, body.length);
}

/** What the drawer may paint for one tier, once isolation and reachability have had their say. */
function buildTier(
	tier: OpenVikingDisclosureTier,
	sourceUri: string,
	body: string | null,
	isolated: boolean,
	offline: boolean,
	read: OpenVikingTierReadState = "settled",
): OpenVikingDrawerTierModel {
	const head = { tier, label: TIER_LABELS[tier], sourceUri };
	if (tier === "L0") {
		// L0 is the one line the server already redacted for a personal memory; it is safe to show.
		if (isolated) return { ...head, body: ISOLATED_AGENT_MEMORY_ABSTRACT, unavailableReason: null };
		// A null L0 is a read that did not answer (spec §3a), never an empty abstract (frontend #273, M1).
		if (body === null) {
			const reason = read === "pending" ? OPENVIKING_LOADING_CONTENT_TEXT : OPENVIKING_ABSTRACT_NOT_READ_TEXT;
			return { ...head, body: "", unavailableReason: reason };
		}
		return { ...head, body, unavailableReason: null };
	}
	// R-ISOLATION-1 first: another role's memory text is never painted, even when a payload carries it.
	if (isolated) return { ...head, body: "", unavailableReason: OPENVIKING_ISOLATION_NOTICE_TEXT };
	if (offline) return { ...head, body: "", unavailableReason: OPENVIKING_OFFLINE_CONTENT_TEXT };
	if (body !== null && body !== "") return { ...head, body: clampBody(body), unavailableReason: null };
	// Nothing to paint yet: say which of the three reasons it is, never "empty" before the read answered.
	if (read === "pending") return { ...head, body: "", unavailableReason: OPENVIKING_LOADING_CONTENT_TEXT };
	if (read === "failed") return { ...head, body: "", unavailableReason: OPENVIKING_TIER_READ_FAILED_TEXT };
	return { ...head, body: "", unavailableReason: OPENVIKING_TIER_EMPTY_TEXT };
}

/** The one test for "this row's text belongs to another role" (Rule 23: a single canonical owner). */
export function entryIsPersonal(entry: OpenVikingExplorerEntry): boolean {
	return entry.layer === "layer2_personal" || entry.scope === "agent";
}

function isolatedByError(contentError: OpenVikingContentError | null): boolean {
	return contentError !== null && /ISOLATED/i.test(contentError.code);
}

function memoryTiers(
	entry: OpenVikingExplorerEntry,
	isolated: boolean,
	offline: boolean,
	read: OpenVikingTierReadState,
): readonly OpenVikingDrawerTierModel[] {
	const bodies: Record<OpenVikingDisclosureTier, string | null> = {
		L0: entry.l0_abstract,
		L1: entry.l1_overview,
		L2: entry.l2_content,
	};
	return entry.layers.map((tier) => buildTier(tier, entry.uri, bodies[tier], isolated, offline, read));
}

/**
 * The drawer always describes the row it was opened from: its URI, scope, layer, L0/L1/L2 tiers and
 * provenance come from `source` alone, so a second row can never show the first row's content or age.
 */
export function buildDrawer(
	source: OpenVikingDrawerSource,
	nowMs: number,
	renderState: OpenVikingRenderState,
	contentError: OpenVikingContentError | null,
	read: OpenVikingTierReadState = "settled",
): OpenVikingDrawerModel {
	void nowMs;
	const offline = renderState === "error";

	if (source.kind === "memory") {
		const entry = source.entry;
		const isolated = entryIsPersonal(entry) || isolatedByError(contentError);
		return {
			rowKey: source.rowKey,
			title: entry.title,
			displayUri: formatDisplayUri(entry.uri),
			scopeLabel: entry.scope,
			layerLabel: isolated ? OPENVIKING_LAYER_LABELS.layer2_personal : OPENVIKING_LAYER_LABELS[entry.layer],
			tiers: memoryTiers(entry, isolated, offline, contentError ? "failed" : read),
			provenance: entry.provenance,
			isolationNotice: isolated ? OPENVIKING_ISOLATION_NOTICE_TEXT : null,
		};
	}

	if (source.kind === "audit") {
		const event = source.event;
		const isolated = event.uri.startsWith("viking://agent/");
		const provenance: OpenVikingEntryProvenance = {
			action: event.action,
			source: event.source,
			role: event.role,
			task_id: event.task_id,
			guard_verdict: event.guard_verdict,
			updated_at: event.ts,
		};
		return {
			rowKey: source.rowKey,
			title: event.summary_1line === "" ? event.action : event.summary_1line,
			displayUri: formatDisplayUri(event.uri),
			scopeLabel: "audit",
			layerLabel: isolated ? OPENVIKING_LAYER_LABELS.layer2_personal : OPENVIKING_LAYER_LABELS.layer1_shared,
			// An audit event carries its own L0 line only; L1/L2 belong to the memory it names.
			tiers: [buildTier("L0", event.uri, event.l0_abstract, isolated, offline)],
			provenance,
			isolationNotice: isolated ? OPENVIKING_ISOLATION_NOTICE_TEXT : null,
		};
	}

	const slot = source.slot;
	return {
		rowKey: source.rowKey,
		title: slot.label,
		displayUri: formatDisplayUri(slot.uri_prefix),
		scopeLabel: "context slot",
		layerLabel: OPENVIKING_LAYER_LABELS.layer1_shared,
		tiers: [
			buildTier(
				"L0",
				slot.uri_prefix,
				`Context slot ${slot.slot_id} reads ${slot.uri_prefix} at injection time.`,
				false,
				offline,
			),
		],
		provenance: null,
		isolationNotice: null,
	};
}
