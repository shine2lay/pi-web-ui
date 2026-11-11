/**
 * "Memory Explorer" workspace panel (frontend #258, Task 2).
 *
 * Layer 1 (shared) and Layer 2 (per-role) are grouped and never mixed. A collapsed row shows only
 * what is safe and scannable: title, category, the one-line L0 abstract and an age — never a raw
 * storage path, never a content hash, never a wall of L1/L2 markdown (design.md Tier 1).
 */

import { useId, type ReactElement } from "react";
import { Figure, PanelHeader } from "./ui-primitives.js";
import type {
	OpenVikingDisplayValue,
	OpenVikingMemoryGroupModel,
	OpenVikingMemoryRowModel,
} from "./view-model-types.js";

export type OpenVikingLayerFilter = "all" | "layer1_shared" | "layer2_personal";

const LAYER_FILTERS: readonly { readonly value: OpenVikingLayerFilter; readonly label: string }[] = [
	{ value: "all", label: "Both layers" },
	{ value: "layer1_shared", label: "Layer 1 Shared" },
	{ value: "layer2_personal", label: "Layer 2 Personal" },
];

export function ExplorerPanel({
	groups,
	panelAge,
	stale,
	badges,
	layerFilter,
	onLayerFilterChange,
	onOpenRow,
	openRowKey,
}: {
	readonly groups: readonly OpenVikingMemoryGroupModel[];
	readonly panelAge: OpenVikingDisplayValue | null;
	readonly stale: boolean;
	readonly badges: ReactElement;
	readonly layerFilter: OpenVikingLayerFilter;
	readonly onLayerFilterChange: (next: OpenVikingLayerFilter) => void;
	readonly onOpenRow: (rowKey: string, opener: HTMLElement) => void;
	readonly openRowKey: string | null;
}): ReactElement {
	const selectId = useId();
	return (
		<div className="ovk-panel-body">
			<PanelHeader
				title="Memory Explorer"
				meta={
					<>
						{panelAge ? <Figure value={panelAge} /> : null}
						{stale ? (
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
					onChange={(event) => onLayerFilterChange(event.target.value as OpenVikingLayerFilter)}
				>
					{LAYER_FILTERS.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			</div>
			{groups.length === 0 ? <p className="ovk-empty-note">No memory entries in this view.</p> : null}
			{groups.map((group) => (
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
								onOpen={(opener) => onOpenRow(row.key, opener)}
							/>
						))}
					</ul>
				</section>
			))}
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
				<span className="ovk-row-abstract">{row.l0Line}</span>
				<span className="ovk-row-foot">
					<span className="ovk-row-uri ovk-mono">{row.displayUri}</span>
					<Figure value={row.age} />
				</span>
			</button>
		</li>
	);
}
