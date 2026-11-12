/**
 * "Memory Explorer" workspace panel (frontend #258, Task 2).
 *
 * Layer 1 (shared) and Layer 2 (per-role) are grouped and never mixed. A collapsed row shows only
 * what is safe and scannable: title, category, the one-line L0 abstract and an age — never a raw
 * storage path, never a content hash, never a wall of L1/L2 markdown (design.md Tier 1).
 */

import { useId, useState, type ReactElement } from "react";
import { pageMemoryGroups } from "./explorer-view-model.js";
import { buildStatePresentation } from "./state-presentation.js";
import {
	OPENVIKING_ENTRIES_EMPTY_TEXT,
	OPENVIKING_ENTRIES_NONE_READ_TEXT,
	OPENVIKING_ENTRIES_LISTING_FAILED_TEXT,
	OPENVIKING_ENTRIES_UNREACHABLE_TEXT,
	OPENVIKING_EXPLORER_PAGE_SIZE,
	OPENVIKING_PANEL_LOADING_TEXT,
	OPENVIKING_UNREAD_GLYPH,
	explorerPageCountText,
	explorerShowMoreText,
	panelFailedText,
	unreadBadgeLabel,
	unreadBadgeText,
} from "./text.js";
import { Figure, PanelFailed, PanelHeader, PanelSkeleton, StatePill } from "./ui-primitives.js";
import type {
	OpenVikingDisplayValue,
	OpenVikingMemoryGroupModel,
	OpenVikingMemoryRowModel,
	OpenVikingPanelStatus,
} from "./view-model-types.js";

export type OpenVikingLayerFilter = "all" | "layer1_shared" | "layer2_personal";

const LAYER_FILTERS: readonly { readonly value: OpenVikingLayerFilter; readonly label: string }[] = [
	{ value: "all", label: "Both layers" },
	{ value: "layer1_shared", label: "Layer 1 Shared" },
	{ value: "layer2_personal", label: "Layer 2 Personal" },
];

export function ExplorerPanel({
	status,
	groups,
	panelAge,
	stale,
	badges,
	layerFilter,
	onLayerFilterChange,
	onOpenRow,
	openRowKey,
}: {
	/** This panel's own call (frontend #273): loading, failed, unreachable, or ready (partial or whole). */
	readonly status: OpenVikingPanelStatus;
	readonly groups: readonly OpenVikingMemoryGroupModel[];
	readonly panelAge: OpenVikingDisplayValue | null;
	readonly stale: boolean;
	readonly badges: ReactElement;
	readonly layerFilter: OpenVikingLayerFilter;
	readonly onLayerFilterChange: (next: OpenVikingLayerFilter) => void;
	readonly onOpenRow: (row: OpenVikingMemoryRowModel, opener: HTMLElement) => void;
	readonly openRowKey: string | null;
}): ReactElement {
	const selectId = useId();
	const [limit, setLimit] = useState(OPENVIKING_EXPLORER_PAGE_SIZE);
	const page = pageMemoryGroups(groups, limit);
	const ready = status.kind === "ready";
	// A failed or unreachable read has no fresh age to show (M1: never "Updated 1s ago" over a failed list).
	const age = ready ? panelAge : null;
	const unread = ready ? status.unreadCount : 0;
	return (
		<div className="ovk-panel-body" data-panel-state={status.kind}>
			<PanelHeader
				title="Memory Explorer"
				meta={
					<>
						{status.kind === "unreachable" ? (
							<StatePill presentation={buildStatePresentation("server-unreachable", null)} />
						) : null}
						{age ? <Figure value={age} /> : null}
						{unread > 0 ? (
							<span
								className="ovk-unread-badge"
								data-component="unread-badge"
								data-unread-count={unread}
								role="img"
								aria-label={unreadBadgeLabel(unread)}
								title={unreadBadgeLabel(unread)}
							>
								<span className="ovk-pill-glyph" aria-hidden="true">
									{OPENVIKING_UNREAD_GLYPH}
								</span>{" "}
								<span aria-hidden="true">{unreadBadgeText(unread)}</span>
							</span>
						) : null}
						{stale && ready ? (
							<span className="ovk-panel-stale" data-stale-badge="true">
								Stale
							</span>
						) : null}
					</>
				}
			>
				{badges}
			</PanelHeader>
			<div className="ovk-filter-bar" data-component="explorer-filters">
				<label className="ovk-filter-label" htmlFor={selectId}>
					Layer
				</label>
				<select
					id={selectId}
					className="ovk-select"
					value={layerFilter}
					onChange={(event) => {
						setLimit(OPENVIKING_EXPLORER_PAGE_SIZE);
						onLayerFilterChange(event.target.value as OpenVikingLayerFilter);
					}}
				>
					{LAYER_FILTERS.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			</div>
			{status.kind === "loading" ? <PanelSkeleton label={OPENVIKING_PANEL_LOADING_TEXT.entries} /> : null}
			{status.kind === "failed" ? <PanelFailed text={panelFailedText("Memory entries", status.message)} /> : null}
			{status.kind === "unreachable" ? (
				<div className="ovk-panel-unreachable" data-component="explorer-unreachable">
					{status.healthAnswers ? (
						<p className="ovk-empty-note" data-component="listing-failed">
							{OPENVIKING_ENTRIES_LISTING_FAILED_TEXT}
						</p>
					) : (
						<p className="ovk-empty-note">{OPENVIKING_ENTRIES_UNREACHABLE_TEXT}</p>
					)}
					{status.lastAnswered ? (
						<p className="ovk-status-lastanswered" data-component="last-answered">
							<span data-source-field={status.lastAnswered.sourceField}>{status.lastAnswered.text}</span>
						</p>
					) : null}
				</div>
			) : null}
			{ready && groups.length === 0 ? (
				<p className="ovk-empty-note">
					{unread > 0 ? OPENVIKING_ENTRIES_NONE_READ_TEXT : OPENVIKING_ENTRIES_EMPTY_TEXT}
				</p>
			) : null}
			{page.groups.map((group) => (
				<section key={group.key} className="ovk-group" data-component="memory-group">
					<header className="ovk-group-head">
						<h3 className="ovk-group-title" data-group-title={group.title}>
							{group.title}
						</h3>
						{group.subtitle ? <span className="ovk-group-subtitle">{group.subtitle}</span> : null}
					</header>
					<ul className="ovk-row-list">
						{group.rows.map((row) => (
							<MemoryRow
								key={row.key}
								row={row}
								layer={group.layer}
								expanded={openRowKey === row.key}
								onOpen={(opener) => onOpenRow(row, opener)}
							/>
						))}
					</ul>
				</section>
			))}
			{page.total > page.shown ? (
				<div className="ovk-page-bar">
					<span className="ovk-empty-note" data-component="explorer-page-count">
						{explorerPageCountText(page.shown, page.total)}
					</span>
					<button
						type="button"
						className="ovk-page-more"
						data-component="explorer-show-more"
						onClick={() => setLimit((current) => current + OPENVIKING_EXPLORER_PAGE_SIZE)}
					>
						{explorerShowMoreText(Math.min(OPENVIKING_EXPLORER_PAGE_SIZE, page.total - page.shown))}
					</button>
				</div>
			) : null}
		</div>
	);
}

function MemoryRow({
	row,
	layer,
	expanded,
	onOpen,
}: {
	readonly row: OpenVikingMemoryRowModel;
	readonly layer: string;
	readonly expanded: boolean;
	readonly onOpen: (opener: HTMLElement) => void;
}): ReactElement {
	return (
		<li className="ovk-memory-row" data-component="memory-row" data-row-key={row.key} data-layer={layer}>
			<button
				type="button"
				className="ovk-row-button"
				data-open-reader="true"
				aria-expanded={expanded}
				onClick={(event) => onOpen(event.currentTarget)}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						onOpen(event.currentTarget);
					}
				}}
			>
				<span className="ovk-row-top">
					<span className="ovk-row-title">{row.title}</span>
					<span className="ovk-chip">{row.categoryLabel}</span>
					{row.isolated ? <span className="ovk-chip ovk-chip-muted">Isolated</span> : null}
				</span>
				<span className="ovk-row-abstract" data-l0-state={row.l0State}>
					{row.l0State === "not-read" ? (
						<span className="ovk-pill-glyph" aria-hidden="true">
							{OPENVIKING_UNREAD_GLYPH}{" "}
						</span>
					) : null}
					{row.l0Line}
				</span>
				<span className="ovk-row-foot">
					<span className="ovk-row-uri ovk-mono">{row.displayUri}</span>
					<Figure value={row.age} />
				</span>
			</button>
		</li>
	);
}
