/**
 * Tier-1 status header (frontend #258, Task 2).
 *
 * States what the dashboard actually knows: the sidecar's own `mode_label`, how many role memory
 * folders exist, and when the health check was last read. It never claims a role is live — nothing
 * measures role liveness in v1 (spec.md §4 "No role liveness").
 */

import type { ReactElement } from "react";
import { Figure, StatePill } from "./ui-primitives.js";
import type { OpenVikingDisplayValue, OpenVikingStatusHeaderModel } from "./view-model-types.js";

export function StatusHeader({
	model,
	lastInjection,
	lastCommit,
}: {
	readonly model: OpenVikingStatusHeaderModel;
	readonly lastInjection: OpenVikingDisplayValue;
	readonly lastCommit: OpenVikingDisplayValue;
}): ReactElement {
	return (
		// A <header> here would be a second `banner` landmark next to the app's top bar (axe
		// landmark-no-duplicate-banner + landmark-unique, measured on the live page in #259).
		<div className="ovk-status-header" data-component="status-header">
			<div className="ovk-status-main">
				<div className="ovk-status-identity">
					<h2 className="ovk-status-title">OpenViking Memory Observability</h2>
					<div className="ovk-status-pills">
						<StatePill presentation={model.presentation} className="ovk-status-pill" />
						{model.modeLabel ? (
							<span className="ovk-mode-label" data-source-field="observer.mode_label">
								{model.modeLabel}
							</span>
						) : null}
						<Figure value={model.roleMemoryFolders} className="ovk-status-folders" />
					</div>
				</div>
				<dl className="ovk-status-facts">
					<StatusFact label="Health check" value={model.checkedAge} />
					<StatusFact label="Last injection" value={lastInjection} />
					<StatusFact label="Last commit" value={lastCommit} />
				</dl>
			</div>
			<p className="ovk-status-subtitle">
				The OpenViking sidecar at <Figure value={model.daemonBind} className="ovk-mono" /> answers the dashboard&apos;s
				health check. Each panel below says when its own source was last read.
			</p>
			{model.lastAnswered ? (
				<p className="ovk-status-lastanswered" data-component="last-answered">
					<span data-source-field={model.lastAnswered.sourceField}>{model.lastAnswered.text}</span>
				</p>
			) : null}
		</div>
	);
}

function StatusFact({
	label,
	value,
}: {
	readonly label: string;
	readonly value: OpenVikingDisplayValue;
}): ReactElement {
	return (
		<div className="ovk-status-fact">
			<dt>{label}</dt>
			<dd>
				<Figure value={value} />
			</dd>
		</div>
	);
}
