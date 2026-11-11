/**
 * Tier-3 click-to-expand reader drawer (frontend #258, Task 2).
 *
 * The one place the dashboard shows a document's body, and only on request: L0 abstract, L1
 * overview and L2 full content as three tabs, plus where the entry came from. Another role's
 * personal memory stays metadata only, whatever the API happened to return (R-ISOLATION-1).
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
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

	// Only a different row resets the level. `model.tiers` is rebuilt on every poll, so depending on it
	// (as this did until #259) re-selected L0 within milliseconds of every click: on the live page the
	// L1 and L2 tabs could be clicked but never became the shown level.
	useEffect(() => {
		setActiveTier(model.tiers[0]?.tier ?? "L0");
		// eslint-disable-next-line react-hooks/exhaustive-deps -- see above: row identity only
	}, [model.rowKey]);

	// A dialog that never gets focus is a lie: `aria-modal="true"` tells a screen reader the rest of the
	// page is inert, and the Escape handler below only fires while focus is inside. Measured on the live
	// page (#259 Task 3): after opening a row, focus stayed on the row button, twelve Tab presses never
	// reached the drawer (it sits behind every remaining row in DOM order) and Escape did nothing.
	useEffect(() => {
		drawerRef.current?.focus();
	}, [model.rowKey]);

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
					return;
				}
				if (event.key === "Tab") keepTabInside(event, drawerRef.current);
			}}
		>
			<header className="ovk-drawer-head">
				<div className="ovk-drawer-ident">
					{/* h2: the drawer's own title, one level under the page's h1 (axe heading-order, #259). */}
					<h2 className="ovk-drawer-title" id={titleId}>
						{model.title}
					</h2>
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
					// design.md names this control `[data-slot="drawer-close"]`; QA and Design key on it (#259).
					data-slot="drawer-close"
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
				{model.tiers.map((tier, index) => (
					<button
						key={tier.tier}
						id={`${titleId}-tab-${tier.tier}`}
						type="button"
						role="tab"
						className="ovk-drawer-tab"
						data-tier-tab={tier.tier}
						aria-selected={tier.tier === activeTier}
						aria-controls={`${titleId}-panel-${tier.tier}`}
						// Roving tabindex (WAI-ARIA APG tabs): one stop for the whole list, arrows move inside it.
						tabIndex={tier.tier === activeTier ? 0 : -1}
						onClick={() => setActiveTier(tier.tier)}
						onKeyDown={(event) => moveTierFocus(event, model.tiers, index, setActiveTier)}
					>
						{tier.label}
					</button>
				))}
			</div>
			{model.tiers.map((tier) => (
				<section
					key={tier.tier}
					id={`${titleId}-panel-${tier.tier}`}
					className={tier.tier === shown?.tier ? "ovk-drawer-tier" : "ovk-drawer-tier ovk-is-hidden"}
					data-tier={tier.tier}
					role="tabpanel"
					aria-labelledby={`${titleId}-tab-${tier.tier}`}
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
					<h3 className="ovk-subhead">Changelog provenance</h3>
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

const DRAWER_FOCUS_STOPS = 'button, [href], select, textarea, input, [tabindex]:not([tabindex="-1"])';

/**
 * Arrow keys, Home and End move between the L0 / L1 / L2 tabs and select the one they land on
 * (WAI-ARIA APG tabs, automatic activation). Without this the tablist has one focus stop and no way
 * to reach the other levels from the keyboard.
 */
function moveTierFocus(
	event: KeyboardEvent<HTMLButtonElement>,
	tiers: readonly { readonly tier: OpenVikingDisclosureTier }[],
	index: number,
	select: (tier: OpenVikingDisclosureTier) => void,
): void {
	const last = tiers.length - 1;
	const next =
		event.key === "ArrowRight" || event.key === "ArrowDown"
			? (index + 1) % tiers.length
			: event.key === "ArrowLeft" || event.key === "ArrowUp"
				? (index + last) % tiers.length
				: event.key === "Home"
					? 0
					: event.key === "End"
						? last
						: null;
	const target = next === null ? undefined : tiers[next];
	if (!target) return;
	event.preventDefault();
	event.stopPropagation();
	select(target.tier);
	const list = event.currentTarget.parentElement;
	list?.querySelectorAll<HTMLElement>('[role="tab"]')[next as number]?.focus();
}

/** Tab and Shift+Tab cycle inside the open drawer, which is what `aria-modal="true"` promises. */
function keepTabInside(event: KeyboardEvent<HTMLDivElement>, drawer: HTMLDivElement | null): void {
	if (!drawer) return;
	const stops = [...drawer.querySelectorAll<HTMLElement>(DRAWER_FOCUS_STOPS)].filter(
		(stop) => !stop.hasAttribute("disabled"),
	);
	const first = stops[0];
	const last = stops.at(-1);
	if (!first || !last) return;
	const active = drawer.ownerDocument.activeElement;
	if (event.shiftKey && (active === first || active === drawer)) {
		event.preventDefault();
		last.focus();
		return;
	}
	if (!event.shiftKey && active === last) {
		event.preventDefault();
		first.focus();
	}
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
