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
import { OPENVIKING_ISOLATION_NOTICE_TEXT, OPENVIKING_LAYER_LABELS, OPENVIKING_OFFLINE_CONTENT_TEXT } from "./text.js";
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

/** What the drawer may paint for one tier, once isolation and reachability have had their say. */
function buildTier(
	tier: OpenVikingDisclosureTier,
	sourceUri: string,
	body: string | null,
	isolated: boolean,
	offline: boolean,
): OpenVikingDrawerTierModel {
	const head = { tier, label: TIER_LABELS[tier], sourceUri };
	if (tier === "L0") {
		// L0 is the one line the server already redacted for a personal memory; it is safe to show.
		return { ...head, body: isolated ? ISOLATED_AGENT_MEMORY_ABSTRACT : (body ?? ""), unavailableReason: null };
	}
	// R-ISOLATION-1 first: another role's memory text is never painted, even when a payload carries it.
	if (isolated) return { ...head, body: "", unavailableReason: OPENVIKING_ISOLATION_NOTICE_TEXT };
	if (offline) return { ...head, body: "", unavailableReason: OPENVIKING_OFFLINE_CONTENT_TEXT };
	if (body === null || body === "") return { ...head, body: "", unavailableReason: "Not stored for this entry" };
	return { ...head, body, unavailableReason: null };
}

function entryIsPersonal(entry: OpenVikingExplorerEntry): boolean {
	return entry.layer === "layer2_personal" || entry.scope === "agent";
}

function isolatedByError(contentError: OpenVikingContentError | null): boolean {
	return contentError !== null && /ISOLATED/i.test(contentError.code);
}

function memoryTiers(
	entry: OpenVikingExplorerEntry,
	isolated: boolean,
	offline: boolean,
): readonly OpenVikingDrawerTierModel[] {
	const bodies: Record<OpenVikingDisclosureTier, string | null> = {
		L0: entry.l0_abstract,
		L1: entry.l1_overview,
		L2: entry.l2_content,
	};
	return entry.layers.map((tier) => buildTier(tier, entry.uri, bodies[tier], isolated, offline));
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
			tiers: memoryTiers(entry, isolated, offline),
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
