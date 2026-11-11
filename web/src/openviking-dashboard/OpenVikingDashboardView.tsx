/**
 * OpenViking Memory Dashboard — presentational root (frontend #258, Task 2 over the #261 seam).
 *
 * The view takes an already-fetched snapshot as a prop and paints it. It never fetches, never takes
 * a state from a URL query parameter, never defines a demo global and never embeds a canned payload
 * (spec.md §Prototype-Only Chrome). The container that polls
 * `/api/openviking/{overview,entries,audit}` is `web/src/components/OpenVikingDashboardPage.tsx`.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type {
	OpenVikingAuditResponse,
	OpenVikingEntriesResponse,
	OpenVikingOverviewResponse,
} from "../../../server/openviking/types.js";
import { AuditPanel } from "./AuditPanel.js";
import { buildAuditFilters, buildAuditRows } from "./audit-view-model.js";
import { buildDrawer } from "./drawer-view-model.js";
import { ExplorerPanel, type OpenVikingLayerFilter } from "./ExplorerPanel.js";
import { buildMemoryGroups } from "./explorer-view-model.js";
import { formatPanelAge } from "./format.js";
import { MountMapPanel } from "./MountMapPanel.js";
import { buildSlotRows, buildStatusHeader, buildSummaryCards } from "./overview-view-model.js";
import { ReaderDrawer } from "./ReaderDrawer.js";
import { StatusHeader } from "./StatusHeader.js";
import { SummaryCards } from "./SummaryCards.js";
import {
	OPENVIKING_CONTRACT_TOOLTIPS,
	OPENVIKING_SOURCE_FIELDS,
	OPENVIKING_TABS,
	type OpenVikingTabId,
} from "./text.js";
import { InfoTooltip } from "./ui-primitives.js";
import {
	ageValue,
	guardZeroActivityCards,
	guardZeroActivityHeader,
	resolveDrawerSource,
	type OpenVikingRowAddress,
} from "./view-composition.js";
import type { OpenVikingAuditFilterSelection, OpenVikingRenderState } from "./view-model-types.js";

/** What the page knows right now. `loading` is the browser's own state; the rest come from the API. */
export type OpenVikingDashboardSnapshot =
	| { readonly status: "loading" }
	| {
			readonly status: "ready";
			readonly overview: OpenVikingOverviewResponse;
			readonly entries: OpenVikingEntriesResponse;
			readonly audit: OpenVikingAuditResponse;
	  }
	| { readonly status: "fetch-failed"; readonly message: string };

export interface OpenVikingDashboardViewProps {
	readonly snapshot: OpenVikingDashboardSnapshot;
	/** Injected clock, so ages are deterministic in tests and never drift from the fetched data. */
	readonly nowMs: number;
	/** Selected workspace tab; the container keeps it in the URL so polling never resets the view. */
	readonly activeTab?: OpenVikingTabId;
	readonly onActiveTabChange?: (tab: OpenVikingTabId) => void;
	readonly auditFilter?: OpenVikingAuditFilterSelection;
	readonly onAuditFilterChange?: (selection: OpenVikingAuditFilterSelection) => void;
}

const ALL_FILTERS: OpenVikingAuditFilterSelection = { action: "all", role: "all" };

export function OpenVikingDashboardView(props: OpenVikingDashboardViewProps): ReactElement {
	const { snapshot, nowMs, onActiveTabChange, onAuditFilterChange } = props;
	const [ownTab, setOwnTab] = useState<OpenVikingTabId>("mount-map");
	const [ownFilter, setOwnFilter] = useState<OpenVikingAuditFilterSelection>(ALL_FILTERS);
	const [layerFilter, setLayerFilter] = useState<OpenVikingLayerFilter>("all");
	const [openRow, setOpenRow] = useState<OpenVikingRowAddress | null>(null);
	const openerRef = useRef<HTMLElement | null>(null);

	const activeTab = props.activeTab ?? ownTab;
	const auditFilter = props.auditFilter ?? ownFilter;

	const selectTab = useCallback(
		(tab: OpenVikingTabId) => {
			setOwnTab(tab);
			onActiveTabChange?.(tab);
		},
		[onActiveTabChange],
	);
	const selectFilter = useCallback(
		(next: OpenVikingAuditFilterSelection) => {
			setOwnFilter(next);
			onAuditFilterChange?.(next);
		},
		[onAuditFilterChange],
	);
	const openRowFrom = useCallback((address: OpenVikingRowAddress, opener: HTMLElement) => {
		openerRef.current = opener;
		setOpenRow(address);
	}, []);
	const closeDrawer = useCallback(() => {
		setOpenRow(null);
		openerRef.current?.focus();
	}, []);

	const loading = snapshot.status === "loading";
	const renderState: OpenVikingRenderState = loading
		? "loading"
		: snapshot.status === "fetch-failed"
			? "error"
			: snapshot.overview.screen_state;
	const overview = snapshot.status === "ready" ? snapshot.overview : null;
	const entries = snapshot.status === "ready" ? snapshot.entries : null;
	const audit = snapshot.status === "ready" ? snapshot.audit : null;

	const header = guardZeroActivityHeader(buildStatusHeader(overview, nowMs, renderState), entries, audit);
	const cards = guardZeroActivityCards(buildSummaryCards(overview, nowMs, renderState), entries, audit);
	const slots = buildSlotRows(overview, nowMs, renderState);
	const groups = buildMemoryGroups(entries, nowMs, renderState).filter(
		(group) => layerFilter === "all" || group.layer === layerFilter,
	);
	const auditRows = buildAuditRows(audit, nowMs, renderState, auditFilter);
	const auditFilters = buildAuditFilters(audit, auditFilter);
	const drawerSource = resolveDrawerSource(openRow, overview, entries, audit);
	const drawer = drawerSource ? buildDrawer(drawerSource, nowMs, renderState, null) : null;

	useEffect(() => {
		if (openRow && !drawerSource) setOpenRow(null);
	}, [openRow, drawerSource]);

	return (
		// <main>, so the page's own content sits inside a landmark instead of loose in the shell: axe
		// reported the status header, the tab bar and the drawer's text under `region` and the document
		// under `landmark-one-main` (#259). The pane is display:none when another tab is shown, so this
		// is never a second main.
		<main className="ovk-dashboard" data-component="openviking-dashboard" data-screen-state={renderState}>
			<StatusHeader
				model={header}
				lastInjection={ageValue(
					overview?.observer.last_injection_at ?? null,
					nowMs,
					"observer.last_injection_at",
					loading,
				)}
				lastCommit={ageValue(overview?.observer.last_commit_at ?? null, nowMs, "observer.last_commit_at", loading)}
			/>
			<SummaryCards cards={cards} />
			<div className="ovk-workspace">
				<div className="ovk-tabbar">
					<div role="tablist" aria-label="OpenViking workspace" className="ovk-tablist">
						{OPENVIKING_TABS.map((tab) => (
							<button
								key={tab.tab}
								type="button"
								role="tab"
								className="ovk-tab"
								data-tab={tab.tab}
								aria-selected={tab.tab === activeTab}
								onClick={() => selectTab(tab.tab)}
							>
								{tab.label}
							</button>
						))}
					</div>
					<p className="ovk-tab-hint">Open any slot, memory or audit row to read its L0 / L1 / L2 in the drawer.</p>
				</div>
				<div className="ovk-panels">
					<section
						role="tabpanel"
						data-tabpanel="mount-map"
						aria-label="Live Activity"
						className={panelClass(activeTab === "mount-map")}
					>
						<MountMapPanel
							slots={slots}
							activity={overview?.live_activity ?? []}
							panelAge={formatPanelAge(
								"Last turn",
								overview?.metrics.last_recorded_at ?? null,
								nowMs,
								OPENVIKING_SOURCE_FIELDS.metricsRecordedAt,
							)}
							stale={Boolean(overview?.metrics.stale_badge)}
							badges={<ContractBadges ids={MOUNT_MAP_BADGES} />}
							onOpenSlot={(slotId, opener) => openRowFrom({ kind: "slot", slotId }, opener)}
							openRowKey={openRow?.kind === "slot" ? `slot-${openRow.slotId}` : null}
						/>
					</section>
					<section
						role="tabpanel"
						data-tabpanel="namespace-explorer"
						aria-label="Memory Explorer"
						className={panelClass(activeTab === "namespace-explorer")}
					>
						<ExplorerPanel
							groups={groups}
							panelAge={formatPanelAge(
								"Updated",
								entries?.panel_updated_at ?? null,
								nowMs,
								OPENVIKING_SOURCE_FIELDS.entriesPanelUpdatedAt,
							)}
							stale={Boolean(entries?.stale_badge)}
							badges={<ContractBadges ids={EXPLORER_BADGES} />}
							layerFilter={layerFilter}
							onLayerFilterChange={setLayerFilter}
							onOpenRow={(rowKey, opener) => openRowFrom({ kind: "memory", rowKey }, opener)}
							openRowKey={openRow?.kind === "memory" ? openRow.rowKey : null}
						/>
					</section>
					<section
						role="tabpanel"
						data-tabpanel="commit-audit"
						aria-label="Guardrail and Changelog Audit"
						className={panelClass(activeTab === "commit-audit")}
					>
						<AuditPanel
							rows={auditRows}
							filters={auditFilters}
							panelAge={formatPanelAge(
								"Updated",
								audit?.panel_updated_at ?? null,
								nowMs,
								OPENVIKING_SOURCE_FIELDS.auditPanelUpdatedAt,
							)}
							stale={Boolean(audit?.stale_badge)}
							badges={<ContractBadges ids={AUDIT_BADGES} />}
							onActionChange={(value) =>
								selectFilter({ ...auditFilter, action: value as OpenVikingAuditFilterSelection["action"] })
							}
							onRoleChange={(value) => selectFilter({ ...auditFilter, role: value })}
							onOpenRow={(rowKey, opener) => openRowFrom({ kind: "audit", rowKey }, opener)}
							openRowKey={openRow?.kind === "audit" ? openRow.rowKey : null}
						/>
					</section>
				</div>
			</div>
			{drawer ? <ReaderDrawer model={drawer} onClose={closeDrawer} /> : null}
		</main>
	);
}

const MOUNT_MAP_BADGES = ["mode-2-turn-1", "granularity"] as const;
const EXPLORER_BADGES = ["granularity", "wt-land-sync"] as const;
const AUDIT_BADGES = ["write-guard", "mode-1-l0"] as const;

function panelClass(active: boolean): string {
	return active ? "ovk-panel" : "ovk-panel ovk-is-hidden";
}

function ContractBadges({ ids }: { readonly ids: readonly string[] }): ReactElement {
	return (
		<>
			{OPENVIKING_CONTRACT_TOOLTIPS.filter((tip) => ids.includes(tip.id)).map((tip) => (
				<InfoTooltip key={tip.id} label={tip.label} body={tip.body} badge />
			))}
		</>
	);
}
