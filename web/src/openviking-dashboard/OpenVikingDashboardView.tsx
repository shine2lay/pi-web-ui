/**
 * OpenViking Memory Dashboard — presentational root (frontend #258, Task 2 over the #261 seam).
 *
 * The view takes an already-fetched snapshot as a prop and paints it. It never fetches, never takes
 * a state from a URL query parameter, never defines a demo global and never embeds a canned payload
 * (spec.md §Prototype-Only Chrome). The container that polls
 * `/api/openviking/{overview,entries,audit}` is `web/src/components/OpenVikingDashboardPage.tsx`.
 */

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import type {
	OpenVikingAuditResponse,
	OpenVikingEntriesResponse,
	OpenVikingOverviewResponse,
} from "../../../server/openviking/types.js";
import { AuditPanel } from "./AuditPanel.js";
import { buildAuditFilters, buildAuditRows, buildAuditStatus } from "./audit-view-model.js";
import { buildDrawer } from "./drawer-view-model.js";
import { ExplorerPanel, type OpenVikingLayerFilter } from "./ExplorerPanel.js";
import { buildExplorerStatus, buildMemoryGroups } from "./explorer-view-model.js";
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
	applyEntryContent,
	deepReadUri,
	formatRowAddress,
	guardZeroActivityCards,
	guardZeroActivityHeader,
	nextTabIndex,
	parseRowAddress,
	resolveDrawerSource,
	type OpenVikingRowAddress,
} from "./view-composition.js";
import type {
	OpenVikingAuditFilterSelection,
	OpenVikingEntryContent,
	OpenVikingRenderState,
	OpenVikingSlice,
} from "./view-model-types.js";

/**
 * What the page knows right now: one slice per API call (frontend #273, M4 / #269 F2). The status header
 * and the cards paint from `overview` alone; the Explorer and the audit wait on, and fail with, their own
 * call only, so the slowest call never holds the whole screen.
 */
export interface OpenVikingDashboardSnapshot {
	readonly overview: OpenVikingSlice<OpenVikingOverviewResponse>;
	readonly entries: OpenVikingSlice<OpenVikingEntriesResponse>;
	readonly audit: OpenVikingSlice<OpenVikingAuditResponse>;
}

const dataOf = <T,>(slice: OpenVikingSlice<T>): T | null => (slice.status === "ready" ? slice.data : null);

export interface OpenVikingDashboardViewProps {
	readonly snapshot: OpenVikingDashboardSnapshot;
	/** Injected clock, so ages are deterministic in tests and never drift from the fetched data. */
	readonly nowMs: number;
	/** Selected workspace tab; the container keeps it in the URL so polling never resets the view. */
	readonly activeTab?: OpenVikingTabId;
	readonly onActiveTabChange?: (tab: OpenVikingTabId) => void;
	readonly auditFilter?: OpenVikingAuditFilterSelection;
	readonly onAuditFilterChange?: (selection: OpenVikingAuditFilterSelection) => void;
	/**
	 * The deep read of the open row's `L1`/`L2` (#259). The view never fetches: it says which URI it
	 * needs through `onDeepReadUriChange` and paints whatever the container hands back.
	 */
	readonly entryContent?: OpenVikingEntryContent | null;
	readonly onDeepReadUriChange?: (uri: string | null) => void;
	/** The open row as `ovrow` writes it (`memory:<uri>`, `audit:<id>`, `slot:<id>`); the container keeps it in the URL (#269 F6). */
	readonly openRow?: string | null;
	readonly onOpenRowChange?: (row: string | null) => void;
}

const ALL_FILTERS: OpenVikingAuditFilterSelection = { action: "all", role: "all" };

export function OpenVikingDashboardView(props: OpenVikingDashboardViewProps): ReactElement {
	const { snapshot, nowMs, onActiveTabChange, onAuditFilterChange, onOpenRowChange } = props;
	const [ownTab, setOwnTab] = useState<OpenVikingTabId>("mount-map");
	const [ownFilter, setOwnFilter] = useState<OpenVikingAuditFilterSelection>(ALL_FILTERS);
	const [layerFilter, setLayerFilter] = useState<OpenVikingLayerFilter>("all");
	const [ownOpenRow, setOwnOpenRow] = useState<string | null>(null);
	const openerRef = useRef<HTMLElement | null>(null);
	const tabsId = useId();
	const tabId = (tab: OpenVikingTabId): string => `${tabsId}-tab-${tab}`;
	const panelId = (tab: OpenVikingTabId): string => `${tabsId}-panel-${tab}`;

	const activeTab = props.activeTab ?? ownTab;
	const auditFilter = props.auditFilter ?? ownFilter;
	const openRow = parseRowAddress(props.openRow !== undefined ? props.openRow : ownOpenRow);
	const setOpenRow = useCallback(
		(address: OpenVikingRowAddress | null) => {
			const value = address ? formatRowAddress(address) : null;
			setOwnOpenRow(value);
			onOpenRowChange?.(value);
		},
		[onOpenRowChange],
	);

	const selectTab = useCallback(
		(tab: OpenVikingTabId) => {
			setOwnTab(tab);
			onActiveTabChange?.(tab);
		},
		[onActiveTabChange],
	);
	// Left / Right / Home / End select and focus the neighbouring tab (APG tabs, #274 / #269 F4).
	const moveTab = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
		const next = nextTabIndex(event.key, index, OPENVIKING_TABS.length);
		const target = next === null ? undefined : OPENVIKING_TABS[next];
		if (!target) return;
		event.preventDefault();
		selectTab(target.tab);
		event.currentTarget.ownerDocument.getElementById(tabId(target.tab))?.focus();
	};
	const selectFilter = useCallback(
		(next: OpenVikingAuditFilterSelection) => {
			setOwnFilter(next);
			onAuditFilterChange?.(next);
		},
		[onAuditFilterChange],
	);
	const openRowFrom = useCallback(
		(address: OpenVikingRowAddress, opener: HTMLElement) => {
			openerRef.current = opener;
			setOpenRow(address);
		},
		[setOpenRow],
	);
	// Focus goes back to the opener only after the reader has unmounted and released the inert page:
	// focusing it while the page is still inert does nothing in a browser (#274).
	const refocusOpenerRef = useRef(false);
	const closeDrawer = useCallback(() => {
		refocusOpenerRef.current = true;
		setOpenRow(null);
	}, [setOpenRow]);

	// Tier 1 (status header + cards) is overview's alone: it paints as soon as overview answers.
	const loading = snapshot.overview.status === "loading";
	const renderState: OpenVikingRenderState = loading
		? "loading"
		: snapshot.overview.status === "failed"
			? "error"
			: snapshot.overview.data.screen_state;
	const overview = dataOf(snapshot.overview);
	const entries = dataOf(snapshot.entries);
	const audit = dataOf(snapshot.audit);
	const explorerStatus = buildExplorerStatus(snapshot.entries, overview, nowMs);
	const auditStatus = buildAuditStatus(snapshot.audit);

	const header = guardZeroActivityHeader(buildStatusHeader(overview, nowMs, renderState), entries, audit);
	const cards = guardZeroActivityCards(buildSummaryCards(overview, nowMs, renderState), entries, audit);
	const slots = buildSlotRows(overview, nowMs, renderState);
	const groups = buildMemoryGroups(entries, nowMs).filter(
		(group) => layerFilter === "all" || group.layer === layerFilter,
	);
	const auditRows = buildAuditRows(audit, nowMs, auditFilter);
	const auditFilters = buildAuditFilters(audit, auditFilter);
	const drawerSource = resolveDrawerSource(openRow, overview, entries, audit);
	const drawerInput = applyEntryContent(drawerSource, props.entryContent ?? null);
	const drawer = drawerInput
		? buildDrawer(drawerInput.source, nowMs, renderState, drawerInput.contentError, drawerInput.read)
		: null;

	// A row that is gone once its own call has answered closes; one whose call is still out (a reloaded
	// address, ~60 s for entries) waits for it.
	const rowCallOut = openRow !== null && snapshot[rowSlice(openRow)].status === "loading";
	useEffect(() => {
		if (openRow && !drawerSource && !rowCallOut) setOpenRow(null);
	}, [openRow, drawerSource, rowCallOut, setOpenRow]);
	const drawerOpen = drawer !== null;
	useEffect(() => {
		if (drawerOpen || !refocusOpenerRef.current) return;
		refocusOpenerRef.current = false;
		openerRef.current?.focus();
	}, [drawerOpen]);

	const wantedUri = deepReadUri(drawerSource);
	const { onDeepReadUriChange } = props;
	useEffect(() => {
		onDeepReadUriChange?.(wantedUri);
	}, [wantedUri, onDeepReadUriChange]);

	return (
		// <main>, so the page's own content sits inside a landmark instead of loose in the shell: axe
		// reported the status header, the tab bar and the drawer's text under `region` and the document
		// under `landmark-one-main` (#259). The pane is display:none when another tab is shown, so this
		// is never a second main. The reader sits beside <main>, not in it, so that while it is open the
		// whole page behind it can be made inert (#274, M2) without making the dialog inert too.
		<div className="ovk-root">
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
							{OPENVIKING_TABS.map((tab, index) => (
								<button
									key={tab.tab}
									id={tabId(tab.tab)}
									type="button"
									role="tab"
									className="ovk-tab"
									data-tab={tab.tab}
									aria-selected={tab.tab === activeTab}
									aria-controls={panelId(tab.tab)}
									// Roving tabindex: the tablist is one Tab stop, the arrows move inside it.
									tabIndex={tab.tab === activeTab ? 0 : -1}
									onClick={() => selectTab(tab.tab)}
									onKeyDown={(event) => moveTab(event, index)}
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
							id={panelId("mount-map")}
							aria-labelledby={tabId("mount-map")}
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
							id={panelId("namespace-explorer")}
							aria-labelledby={tabId("namespace-explorer")}
							className={panelClass(activeTab === "namespace-explorer")}
						>
							<ExplorerPanel
								status={explorerStatus}
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
								onOpenRow={(row, opener) => openRowFrom({ kind: "memory", uri: row.uri }, opener)}
								openRowKey={drawerSource?.kind === "memory" ? drawerSource.rowKey : null}
							/>
						</section>
						<section
							role="tabpanel"
							data-tabpanel="commit-audit"
							id={panelId("commit-audit")}
							aria-labelledby={tabId("commit-audit")}
							className={panelClass(activeTab === "commit-audit")}
						>
							<AuditPanel
								status={auditStatus}
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
			</main>
			{drawer ? <ReaderDrawer model={drawer} onClose={closeDrawer} /> : null}
		</div>
	);
}

const MOUNT_MAP_BADGES = ["mode-2-turn-1", "granularity"] as const;
const EXPLORER_BADGES = ["granularity", "wt-land-sync"] as const;
const AUDIT_BADGES = ["write-guard", "mode-1-l0"] as const;

/** The call an open row's drawer reads from. */
function rowSlice(address: OpenVikingRowAddress): keyof OpenVikingDashboardSnapshot {
	return address.kind === "memory" ? "entries" : address.kind === "audit" ? "audit" : "overview";
}

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
