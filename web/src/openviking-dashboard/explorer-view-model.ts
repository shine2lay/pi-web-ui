/**
 * OpenViking Memory Dashboard — `GET /api/openviking/entries` -> Memory Explorer groups
 * (frontend #258 implements the #261 seam).
 */

import type { OpenVikingEntriesResponse, OpenVikingExplorerEntry } from "../../../server/openviking/types.js";
import { ISOLATED_AGENT_MEMORY_ABSTRACT } from "../../../server/openviking/types.js";
import { formatDisplayUri, formatFigure, formatPanelAge } from "./format.js";
import { OPENVIKING_LAYER_LABELS, OPENVIKING_SOURCE_FIELDS } from "./text.js";
import type {
	OpenVikingMemoryGroupKind,
	OpenVikingMemoryGroupModel,
	OpenVikingMemoryRowModel,
	OpenVikingRenderState,
} from "./view-model-types.js";

interface GroupIdentity {
	readonly key: string;
	readonly kind: OpenVikingMemoryGroupKind;
	readonly title: string;
	readonly subtitle: string | null;
}

/** `viking://resources/<repo>/…` — the repo a Layer 1 resource tree belongs to. */
const REPO_URI = /^viking:\/\/resources\/([^/]+)\//;
/** The shared craft-preference domains live under a `…/memories/preferences/` path. */
const CRAFT_PREFERENCE_URI = /\/memories\/preferences\//;

/** A memory is another role's personal memory: metadata only (`R-ISOLATION-1`). */
function isPersonal(entry: OpenVikingExplorerEntry): boolean {
	return entry.layer === "layer2_personal" || entry.scope === "agent";
}

function titleCase(value: string): string {
	return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

/**
 * Group keys are stable, so the page and its tests name the same group: `repo:<repo>`,
 * `craft-preferences`, `shared:<category>` and `role:<role>`.
 */
function identify(entry: OpenVikingExplorerEntry): GroupIdentity {
	if (isPersonal(entry)) {
		const role = entry.role ?? "unassigned";
		return {
			key: `role:${role}`,
			kind: "role",
			title: `Role ${role}`,
			subtitle: OPENVIKING_LAYER_LABELS.layer2_personal,
		};
	}
	const repo = REPO_URI.exec(entry.uri)?.[1];
	if (repo !== undefined) {
		return {
			key: `repo:${repo}`,
			kind: "repo",
			title: `Repo ${repo}`,
			subtitle: OPENVIKING_LAYER_LABELS.layer1_shared,
		};
	}
	if (CRAFT_PREFERENCE_URI.test(entry.uri)) {
		return {
			key: "craft-preferences",
			kind: "craft-preferences",
			title: "Craft preferences",
			subtitle: OPENVIKING_LAYER_LABELS.layer1_shared,
		};
	}
	return {
		key: `shared:${entry.category}`,
		kind: "shared-memory",
		title: `Shared ${entry.category}`,
		subtitle: OPENVIKING_LAYER_LABELS.layer1_shared,
	};
}

function buildRow(entry: OpenVikingExplorerEntry, index: number, nowMs: number): OpenVikingMemoryRowModel {
	const isolated = isPersonal(entry);
	return {
		key: `mem-${index + 1}`,
		uri: entry.uri,
		// Always the logical URI: `canonical_uri` may be an on-disk blob path and is never painted.
		displayUri: formatDisplayUri(entry.uri),
		title: entry.title,
		categoryLabel: titleCase(entry.category),
		scopeLabel: titleCase(entry.scope),
		roleLabel: entry.role,
		tiers: entry.layers,
		// The server already redacted a personal abstract; the browser never fills that gap in.
		l0Line: isolated ? ISOLATED_AGENT_MEMORY_ABSTRACT : (entry.l0_abstract ?? ""),
		age:
			formatPanelAge("Updated", entry.updated_at, nowMs, OPENVIKING_SOURCE_FIELDS.entryUpdatedAt) ??
			formatFigure(null, OPENVIKING_SOURCE_FIELDS.entryUpdatedAt, { notMeasured: true }),
		isolated,
	};
}

/**
 * Entries grouped for reading, never a flat list (owner rule, VERIFICATION.md M6): Layer 1 Shared
 * splits by repo, craft-preference domains and the other shared memories; Layer 2 Personal splits by
 * role. Groups keep the server's order inside them; a group with no rows is dropped.
 */
export function buildMemoryGroups(
	entries: OpenVikingEntriesResponse | null,
	nowMs: number,
	renderState: OpenVikingRenderState,
): readonly OpenVikingMemoryGroupModel[] {
	if (entries === null || renderState === "loading") return [];

	const order: string[] = [];
	const byKey = new Map<string, { identity: GroupIdentity; rows: OpenVikingMemoryRowModel[] }>();

	entries.entries.forEach((entry, index) => {
		const identity = identify(entry);
		let group = byKey.get(identity.key);
		if (group === undefined) {
			group = { identity, rows: [] };
			byKey.set(identity.key, group);
			order.push(identity.key);
		}
		group.rows.push(buildRow(entry, index, nowMs));
	});

	return order.flatMap((key) => {
		const group = byKey.get(key);
		if (group === undefined || group.rows.length === 0) return [];
		return [
			{
				key,
				layer: group.identity.kind === "role" ? "layer2_personal" : "layer1_shared",
				kind: group.identity.kind,
				title: group.identity.title,
				subtitle: group.identity.subtitle,
				rows: group.rows,
			},
		];
	});
}
