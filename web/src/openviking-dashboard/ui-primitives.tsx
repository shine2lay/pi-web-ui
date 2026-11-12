/**
 * Shared leaf components for the OpenViking Memory Dashboard (frontend #258, Task 2).
 *
 * Every figure the page paints goes through `Figure`, so the server field it came from is always
 * visible in the DOM (`data-source-field`) and a missing `:1933` value always reads
 * `— (Unreachable)` instead of a zero (spec.md `A07`, `R-FAIL-1..3`).
 */

import { useCallback, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { OpenVikingDisplayValue, OpenVikingStatePresentation } from "./view-model-types.js";

export function Figure({
	value,
	className,
}: {
	readonly value: OpenVikingDisplayValue;
	readonly className?: string;
}): ReactElement {
	return (
		<span
			className={className ? `ovk-figure ${className}` : "ovk-figure"}
			data-source-field={value.sourceField}
			{...(value.unreachable ? { "data-unreachable-value": "true" } : {})}
			{...(value.notMeasured ? { "data-not-measured": "true" } : {})}
			{...(value.ariaLabel ? { "aria-label": value.ariaLabel } : {})}
		>
			{value.text}
		</span>
	);
}

/**
 * A state pill. `healthState` is painted only where the page is entitled to claim that state:
 * slot rows pass `paintHealthState={false}` so a "nothing measures this yet" row can never be read
 * as the server reporting zero activity.
 */
export function StatePill({
	presentation,
	paintHealthState = true,
	className,
}: {
	readonly presentation: OpenVikingStatePresentation;
	readonly paintHealthState?: boolean;
	readonly className?: string;
}): ReactElement {
	return (
		<span
			className={className ? `ovk-pill ${className}` : "ovk-pill"}
			{...(paintHealthState ? { "data-health-state": presentation.healthState } : {})}
			{...(presentation.dataIcon ? { "data-icon": presentation.dataIcon } : {})}
			{...(presentation.staleBadge ? { "data-stale-badge": "true" } : {})}
			data-border={presentation.border}
		>
			{presentation.glyph ? (
				<span className="ovk-pill-glyph" aria-hidden="true">
					{presentation.glyph}
				</span>
			) : null}
			<span className="ovk-pill-label">{presentation.label}</span>
		</span>
	);
}

/**
 * Tier-2 progressive disclosure: a `(?)` trigger that reveals its explanation on hover and on
 * focus. The tip lives next to the trigger (no portal) so `aria-describedby` and the Escape key
 * work the same for a pointer and for a keyboard.
 */
export function InfoTooltip({
	label,
	body,
	badge,
}: {
	readonly label: string;
	readonly body: string;
	readonly badge?: boolean;
}): ReactElement {
	const tipId = useId();
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement | null>(null);

	const onKeyDown = useCallback((event: { key: string; preventDefault(): void }) => {
		if (event.key === "Escape") {
			event.preventDefault();
			setOpen(false);
			triggerRef.current?.focus();
		}
	}, []);

	return (
		<span className="ovk-tooltip-host">
			<button
				ref={triggerRef}
				type="button"
				className={badge ? "ovk-tooltip-trigger ovk-tooltip-badge" : "ovk-tooltip-trigger"}
				data-tooltip-trigger={label}
				aria-expanded={open}
				{...(open ? { "aria-describedby": tipId } : {})}
				onClick={() => setOpen(true)}
				onMouseEnter={() => setOpen(true)}
				onMouseLeave={() => setOpen(false)}
				onFocus={() => setOpen(true)}
				onBlur={() => setOpen(false)}
				onKeyDown={onKeyDown}
			>
				{badge ? <span className="ovk-badge-text">{label}</span> : null}
				<span className="ovk-help-mark" aria-hidden="true">
					?
				</span>
				<span className="ovk-sr-only">{badge ? " — what this means" : `${label} — what this means`}</span>
			</button>
			{open ? (
				<span id={tipId} role="tooltip" className="ovk-tooltip ovk-tooltip-floating" data-floating="true">
					<span className="ovk-tooltip-title">{label}</span>
					<span className="ovk-tooltip-body">{body}</span>
				</span>
			) : null}
		</span>
	);
}

/**
 * A list panel's own call is still out (frontend #273, M4): placeholder bars, never an empty-list note
 * and never a zero. `aria-busy` plus the visible words say it is loading.
 */
export function PanelSkeleton({ label }: { readonly label: string }): ReactElement {
	return (
		<div className="ovk-panel-skeleton" data-component="panel-skeleton" aria-busy="true">
			<p className="ovk-empty-note">{label}</p>
			{[0, 1, 2].map((bar) => (
				<span key={bar} className="ovk-skeleton-row" aria-hidden="true" />
			))}
		</div>
	);
}

/** A list panel's own call failed (#269 F2): said in that panel only; the rest of the page keeps painting. */
export function PanelFailed({ text }: { readonly text: string }): ReactElement {
	return (
		<p className="ovk-panel-failed" data-component="panel-failed">
			<span className="ovk-pill-glyph" aria-hidden="true">
				✕
			</span>{" "}
			{text}
		</p>
	);
}

/** A panel's framing: title, its own freshness line, and the contract badges that explain it. */
export function PanelHeader({
	title,
	meta,
	children,
}: {
	readonly title: string;
	readonly meta: ReactNode;
	readonly children?: ReactNode;
}): ReactElement {
	return (
		<header className="ovk-panel-header">
			<div className="ovk-panel-header-row">
				{/* h2: a panel is a top-level section under the page's h1 (axe heading-order, #259). */}
				<h2 className="ovk-panel-title">{title}</h2>
				<div className="ovk-panel-meta">{meta}</div>
			</div>
			{children ? <div className="ovk-badge-strip">{children}</div> : null}
		</header>
	);
}
