/**
 * "Guardrail & Changelog Audit" workspace panel (frontend #258, Task 2).
 *
 * The write stream in server order, filterable by action and by role. A personal (agent) write is
 * metadata only — the row names the action, the role and the URI, never the content (R-ISOLATION-1).
 */

import { useId, type ReactElement } from "react";
import { Figure, PanelHeader } from "./ui-primitives.js";
import type {
	OpenVikingAuditFiltersModel,
	OpenVikingAuditRowModel,
	OpenVikingDisplayValue,
	OpenVikingFilterOption,
} from "./view-model-types.js";

export function AuditPanel({
	rows,
	filters,
	panelAge,
	stale,
	badges,
	onActionChange,
	onRoleChange,
	onOpenRow,
	openRowKey,
}: {
	readonly rows: readonly OpenVikingAuditRowModel[];
	readonly filters: OpenVikingAuditFiltersModel;
	readonly panelAge: OpenVikingDisplayValue | null;
	readonly stale: boolean;
	readonly badges: ReactElement;
	readonly onActionChange: (value: string) => void;
	readonly onRoleChange: (value: string) => void;
	readonly onOpenRow: (rowKey: string, opener: HTMLElement) => void;
	readonly openRowKey: string | null;
}): ReactElement {
	return (
		<div className="ovk-panel-body">
			<PanelHeader
				title="Commit & Guardrail Audit"
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
			<div className="ovk-filter-bar" data-component="audit-filters">
				<FilterSelect label="Action" options={filters.actions} onChange={onActionChange} />
				<FilterSelect label="Role" options={filters.roles} onChange={onRoleChange} />
			</div>
			{rows.length === 0 ? (
				<p className="ovk-empty-note">No audit events match this filter.</p>
			) : (
				<ul className="ovk-row-list">
					{rows.map((row) => (
						<AuditRow
							key={row.key}
							row={row}
							expanded={openRowKey === row.key}
							onOpen={(opener) => onOpenRow(row.key, opener)}
						/>
					))}
				</ul>
			)}
		</div>
	);
}

function FilterSelect({
	label,
	options,
	onChange,
}: {
	readonly label: string;
	readonly options: readonly OpenVikingFilterOption[];
	readonly onChange: (value: string) => void;
}): ReactElement {
	const selectId = useId();
	const selected = options.find((option) => option.selected)?.value ?? "all";
	return (
		<span className="ovk-filter-group">
			<label className="ovk-filter-label" htmlFor={selectId}>
				{label}
			</label>
			<select id={selectId} className="ovk-select" value={selected} onChange={(event) => onChange(event.target.value)}>
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		</span>
	);
}

function AuditRow({
	row,
	expanded,
	onOpen,
}: {
	readonly row: OpenVikingAuditRowModel;
	readonly expanded: boolean;
	readonly onOpen: (opener: HTMLElement) => void;
}): ReactElement {
	return (
		<li className="ovk-audit-row" data-component="audit-row" data-action={row.action} data-guard={row.guardVerdict}>
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
					<span className="ovk-chip" data-action-label={row.actionLabel}>
						{row.actionLabel}
					</span>
					<span className="ovk-chip ovk-chip-muted">{row.roleLabel}</span>
					<span className="ovk-chip ovk-chip-guard" data-guard-verdict={row.guardVerdict}>
						{row.guardLabel}
					</span>
				</span>
				{row.summaryLine ? <span className="ovk-row-abstract">{row.summaryLine}</span> : null}
				<span className="ovk-row-foot">
					<span className="ovk-row-uri ovk-mono">{row.displayUri}</span>
					<Figure value={row.age} />
				</span>
			</button>
		</li>
	);
}
