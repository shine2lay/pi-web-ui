/**
 * "Live Activity" workspace panel (frontend #258, Task 2).
 *
 * Two readable things, no invented numbers: the five context slots with what is (and is not) yet
 * measured, and the compact one-line activity rows the local metrics log recorded.
 */

import type { ReactElement } from "react";
import type { OpenVikingLiveActivityItem } from "../../../server/openviking/types.js";
import { Figure, PanelHeader, StatePill } from "./ui-primitives.js";
import type { OpenVikingDisplayValue, OpenVikingSlotRowModel } from "./view-model-types.js";

export function MountMapPanel({
	slots,
	activity,
	panelAge,
	stale,
	badges,
	onOpenSlot,
	openRowKey,
}: {
	readonly slots: readonly OpenVikingSlotRowModel[];
	readonly activity: readonly OpenVikingLiveActivityItem[];
	readonly panelAge: OpenVikingDisplayValue | null;
	readonly stale: boolean;
	readonly badges: ReactElement;
	readonly onOpenSlot: (slotId: number, opener: HTMLElement) => void;
	readonly openRowKey: string | null;
}): ReactElement {
	return (
		<div className="ovk-panel-body">
			<PanelHeader
				title="Context Mount Map"
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
			<ul className="ovk-slot-list">
				{slots.map((slot) => (
					<SlotRow
						key={slot.slotId}
						slot={slot}
						expanded={openRowKey === `slot-${slot.slotId}`}
						onOpen={(opener) => onOpenSlot(slot.slotId, opener)}
					/>
				))}
			</ul>
			<h3 className="ovk-subhead">Recent activity</h3>
			{activity.length === 0 ? (
				<p className="ovk-empty-note">No activity recorded in the window.</p>
			) : (
				<ul className="ovk-activity-list">
					{activity.map((item) => (
						<li key={item.id} className="ovk-activity-row" data-component="activity-row" data-status={item.status}>
							<span className="ovk-activity-role">{item.role}</span>
							<span className="ovk-activity-action">{item.action.replace(/_/g, " ")}</span>
							<span className="ovk-activity-summary">{item.summary_1line}</span>
							{item.count_value !== null && item.count_unit ? (
								<span className="ovk-activity-count ovk-num">
									{item.count_value.toLocaleString("en-US")} {item.count_unit}
								</span>
							) : null}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function SlotRow({
	slot,
	expanded,
	onOpen,
}: {
	readonly slot: OpenVikingSlotRowModel;
	readonly expanded: boolean;
	readonly onOpen: (opener: HTMLElement) => void;
}): ReactElement {
	return (
		<li className="ovk-slot-row" data-component="slot-row">
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
				<span className="ovk-slot-top">
					<StatePill presentation={slot.presentation} paintHealthState={false} className="ovk-slot-pill" />
					<span className="ovk-slot-name" data-slot-label={slot.label}>
						{slot.label}
					</span>
				</span>
				<span className="ovk-slot-uri ovk-mono">{slot.uriPrefix}</span>
				<span className="ovk-slot-figures">
					<Figure value={slot.hitRate} />
					<Figure value={slot.avgTokens} />
					<Figure value={slot.age} />
				</span>
			</button>
		</li>
	);
}
