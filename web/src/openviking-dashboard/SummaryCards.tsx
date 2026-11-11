/**
 * Tier-1 summary cards (frontend #258, Task 2): three grouped cards, at most five text fields each.
 *
 * Each card carries its own panel's freshness and health, never the screen's — a stale commit log
 * must not make the daemon look down, and a healthy daemon must not make a stale log look current
 * (design.md §Per-card pills).
 */

import type { ReactElement } from "react";
import { OPENVIKING_CARD_TEXT } from "./text.js";
import { Figure, InfoTooltip, StatePill } from "./ui-primitives.js";
import type { OpenVikingSummaryCardModel } from "./view-model-types.js";

const CARD_TOOLTIPS = {
	"system-health": {
		label: "Mode 1 L0",
		body: "Mode 1: at chat start the lead is given the L0 abstract of each matching memory — a one-line summary, never the full document.",
	},
	"context-injection": {
		label: "Mode 2 Turn-1",
		body: "Mode 2: a worker's first turn is prefetched from the five context slots below, so its opening answer already carries the project's memory.",
	},
	"commit-governance": {
		label: "Write Guard",
		body: "R-PREF-WRITE-GUARD-1: a worker may not write a role preference. The guard turns the write away and records it in the audit stream below.",
	},
} as const;

export function SummaryCards({ cards }: { readonly cards: readonly OpenVikingSummaryCardModel[] }): ReactElement {
	return (
		<div className="ovk-card-grid">
			{cards.map((card) => (
				<SummaryCard key={card.cardId} card={card} />
			))}
		</div>
	);
}

function SummaryCard({ card }: { readonly card: OpenVikingSummaryCardModel }): ReactElement {
	const presentation = card.presentation;
	const text = OPENVIKING_CARD_TEXT[card.cardId];
	const tip = CARD_TOOLTIPS[card.cardId];
	const [headline, ...rest] = card.fields;
	return (
		<section
			className="ovk-card"
			data-component="summary-card"
			data-card-id={card.cardId}
			data-health-state={presentation.healthState}
			{...(card.panelUpdatedAt ? { "data-panel-updated-at": card.panelUpdatedAt } : {})}
			{...(presentation.staleBadge ? { "data-stale-badge": "true" } : {})}
			aria-label={card.title}
		>
			<div className="ovk-card-top">
				{/* h2 under the page's h1 (axe heading-order, #259); the size stays .ovk-card-title's. */}
				<h2 className="ovk-card-title">{card.title}</h2>
				<span className="ovk-card-caption">
					<span className="ovk-card-caption-text">{text.caption}</span>
					<InfoTooltip label={tip.label} body={tip.body} />
				</span>
			</div>
			{headline ? (
				<p className="ovk-card-headline" data-field={headline.sourceField}>
					<Figure value={headline} />
				</p>
			) : null}
			<StatePill presentation={presentation} className="ovk-card-pill" />
			<ul className="ovk-card-fields">
				{rest.map((field) => (
					<li key={`${field.sourceField}:${field.text}`} className="ovk-card-field" data-field={field.sourceField}>
						<Figure value={field} />
					</li>
				))}
			</ul>
			<footer className="ovk-card-foot">
				{card.age ? <Figure value={card.age} className="ovk-card-age" /> : null}
				<span className="ovk-card-cadence">{text.cadence}</span>
				{card.sourceNote ? <span className="ovk-card-source-note">{card.sourceNote}</span> : null}
			</footer>
		</section>
	);
}
