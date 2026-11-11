/**
 * Tier-3 click-to-expand reader drawer (frontend #258, Task 2).
 *
 * The one place the dashboard shows a document's body, and only on request: L0 abstract, L1
 * overview and L2 full content as three tabs, plus where the entry came from. Another role's
 * personal memory stays metadata only, whatever the API happened to return (R-ISOLATION-1).
 */

import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import type { OpenVikingDisclosureTier } from "../../../server/openviking/types.js";
import type { OpenVikingDrawerModel } from "./view-model-types.js";

export function ReaderDrawer({
	model,
	onClose,
}: {
	readonly model: OpenVikingDrawerModel;
	readonly onClose: () => void;
}): ReactElement {
	const titleId = useId();
	const drawerRef = useRef<HTMLDivElement | null>(null);
	const [activeTier, setActiveTier] = useState<OpenVikingDisclosureTier>(model.tiers[0]?.tier ?? "L0");

	useEffect(() => {
		setActiveTier(model.tiers[0]?.tier ?? "L0");
	}, [model.rowKey, model.tiers]);

	const shown = model.tiers.find((tier) => tier.tier === activeTier) ?? model.tiers[0];

	return (
		<div
			ref={drawerRef}
			className="ovk-drawer"
			data-component="reader-drawer"
			data-row-key={model.rowKey}
			role="dialog"
			aria-modal="true"
			aria-labelledby={titleId}
			tabIndex={-1}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					onClose();
				}
			}}
		>
			<header className="ovk-drawer-head">
				<div className="ovk-drawer-ident">
					<h3 className="ovk-drawer-title" id={titleId}>
						{model.title}
					</h3>
					<p className="ovk-drawer-uri ovk-mono">{model.displayUri}</p>
					<p className="ovk-drawer-scope">
						<span className="ovk-chip">{model.layerLabel}</span>
						<span className="ovk-chip ovk-chip-muted">{model.scopeLabel}</span>
					</p>
				</div>
				<button
					type="button"
					role="button"
					className="ovk-drawer-close"
					aria-label="Close reader"
					onClick={onClose}
					onKeyDown={(event) => {
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							onClose();
						}
					}}
				>
					<span aria-hidden="true">✕</span>
				</button>
			</header>
			{model.isolationNotice ? (
				<p className="ovk-drawer-isolation" data-component="isolation-notice">
					{model.isolationNotice}
				</p>
			) : null}
			<div className="ovk-drawer-tabs" role="tablist" aria-label="Disclosure level">
				{model.tiers.map((tier) => (
					<button
						key={tier.tier}
						type="button"
						role="tab"
						className="ovk-drawer-tab"
						data-tier-tab={tier.tier}
						aria-selected={tier.tier === activeTier}
						onClick={() => setActiveTier(tier.tier)}
					>
						{tier.label}
					</button>
				))}
			</div>
			{model.tiers.map((tier) => (
				<section
					key={tier.tier}
					className={tier.tier === shown?.tier ? "ovk-drawer-tier" : "ovk-drawer-tier ovk-is-hidden"}
					data-tier={tier.tier}
					aria-label={tier.label}
				>
					{tier.unavailableReason ? (
						<p className="ovk-drawer-unavailable">{tier.unavailableReason}</p>
					) : (
						<pre className="ovk-drawer-body">{tier.body}</pre>
					)}
				</section>
			))}
			{model.provenance ? (
				<footer className="ovk-drawer-provenance" data-component="provenance">
					<h4 className="ovk-subhead">Changelog provenance</h4>
					<dl className="ovk-prov-list">
						<ProvenanceItem label="Action" value={model.provenance.action} />
						<ProvenanceItem label="Source" value={model.provenance.source} />
						<ProvenanceItem label="Role" value={model.provenance.role} />
						<ProvenanceItem label="Guard" value={model.provenance.guard_verdict} />
						<ProvenanceItem label="Updated" value={model.provenance.updated_at} />
					</dl>
				</footer>
			) : null}
		</div>
	);
}

function ProvenanceItem({
	label,
	value,
}: {
	readonly label: string;
	readonly value: string | null;
}): ReactElement | null {
	if (!value) return null;
	return (
		<div className="ovk-prov-item">
			<dt>{label}</dt>
			<dd>{value}</dd>
		</div>
	);
}
