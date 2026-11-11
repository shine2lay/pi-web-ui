/**
 * OpenViking Memory Dashboard — the browser-side display contract (frontend #261, Task 1 seam).
 *
 * API shapes are NEVER redeclared here: they are imported from `server/openviking/types.ts`
 * (the canonical contract). What this file adds is the display model the page renders — text that is
 * already formatted, plus the attributes that prove where each figure came from.
 *
 * Browser code formats values only; it never computes sums, averages, percentages or health
 * verdicts (spec.md `A07`).
 */

import type {
	OpenVikingAuditAction,
	OpenVikingAuditEvent,
	OpenVikingDisclosureTier,
	OpenVikingEntryProvenance,
	OpenVikingExplorerEntry,
	OpenVikingGuardVerdict,
	OpenVikingHealthState,
	OpenVikingMemoryLayer,
	OpenVikingModeLabel,
	OpenVikingScreenState,
	OpenVikingSlotSummary,
} from "../../../server/openviking/types.js";

/** `[data-screen-state]`: the four server states plus the browser's own pre-first-response state. */
export type OpenVikingRenderState = "loading" | OpenVikingScreenState;

/** One painted figure. `text` is final: the component never re-formats, defaults or substitutes it. */
export interface OpenVikingDisplayValue {
	/** Exactly what is painted. Never `"0"` for a missing value, never an invented duration. */
	readonly text: string;
	/** `data-source-field`: the server field this text came from. */
	readonly sourceField: string;
	/** `data-unreachable-value="true"`: the `:1933` source was unreachable (null), so there is no number. */
	readonly unreachable: boolean;
	/** Nothing measures this yet (spec G3): neutral wording, never a healthy badge. */
	readonly notMeasured: boolean;
	/** Optional `aria-label` when the short text alone would not read out. */
	readonly ariaLabel?: string;
}

/** A state's visuals, so colour is never the only cue (design.md §Screen States). */
export interface OpenVikingStatePresentation {
	readonly healthState: OpenVikingHealthState | "loading";
	/** Pill text, e.g. `Healthy`, `Stale (> 15m cadence)`, `Server Unreachable`, `Zero Activity`, `Loading…`. */
	readonly label: string;
	/** `●`/`◐`/`◌`/`✕`; null while loading (no status glyph before the first answer). */
	readonly glyph: string | null;
	/** `data-icon`; null while loading. */
	readonly dataIcon: string | null;
	readonly border: "solid" | "dashed" | "dotted" | "double" | "none";
	/** Verbatim `stale_badge` from the API (`"> 30s"`, `"> 15m"`, …); the browser never invents an age. */
	readonly staleBadge: string | null;
}

export interface OpenVikingLastAnsweredLine {
	readonly text: string;
	readonly sourceField: "observer.last_reachable_at";
	/** false when `last_reachable_at` is null, so a null can never read as a duration. */
	readonly isDuration: boolean;
}

export interface OpenVikingStatusHeaderModel {
	readonly renderState: OpenVikingRenderState;
	readonly presentation: OpenVikingStatePresentation;
	/** `observer.mode_label` verbatim: `Active` | `Degraded Local Fallback` | `Offline`. */
	readonly modeLabel: OpenVikingModeLabel | null;
	/** "N role memory folders" — a folder count, never a liveness claim. */
	readonly roleMemoryFolders: OpenVikingDisplayValue;
	readonly daemonBind: OpenVikingDisplayValue;
	/** "Checked 4s ago" from `observer.checked_at` (request time). */
	readonly checkedAge: OpenVikingDisplayValue;
	/** Rendered in the `error` state only; null elsewhere. Gates nothing. */
	readonly lastAnswered: OpenVikingLastAnsweredLine | null;
}

export type OpenVikingSummaryCardId = "system-health" | "context-injection" | "commit-governance";

export interface OpenVikingSummaryCardModel {
	readonly cardId: OpenVikingSummaryCardId;
	readonly title: string;
	/** This panel's own `health_state` — never the screen's (design.md §Per-card pills). */
	readonly presentation: OpenVikingStatePresentation;
	/** `data-panel-updated-at`. */
	readonly panelUpdatedAt: string | null;
	/** null when the panel has no timestamp to date: no age line beats an invented one. */
	readonly age: OpenVikingDisplayValue | null;
	/** "from local audit log" / "from local metrics log" while `:1933` is down; null otherwise. */
	readonly sourceNote: string | null;
	/** At most five text fields per card (design.md Tier 1). */
	readonly fields: readonly OpenVikingDisplayValue[];
}

export interface OpenVikingSlotRowModel {
	readonly slotId: OpenVikingSlotSummary["slot_id"];
	/** Verbatim `OPENVIKING_CONTEXT_SLOTS[].label` from `server/openviking/types.ts`. */
	readonly label: string;
	readonly uriPrefix: string;
	readonly hitRate: OpenVikingDisplayValue;
	readonly avgTokens: OpenVikingDisplayValue;
	readonly presentation: OpenVikingStatePresentation;
	readonly age: OpenVikingDisplayValue;
	/** `aria-describedby` target of this row's `(?)` trigger. */
	readonly tooltipId: string;
}

export type OpenVikingMemoryGroupKind = "repo" | "craft-preferences" | "shared-memory" | "role";

export interface OpenVikingMemoryRowModel {
	readonly key: string;
	readonly uri: string;
	/** Short logical URI for the row: never a 64-char hash, never an internal storage path. */
	readonly displayUri: string;
	readonly title: string;
	readonly categoryLabel: string;
	readonly scopeLabel: string;
	readonly roleLabel: string | null;
	readonly tiers: readonly OpenVikingDisclosureTier[];
	/** One-line L0 abstract; for another role's personal memory, the isolation placeholder. */
	readonly l0Line: string;
	readonly age: OpenVikingDisplayValue;
	readonly isolated: boolean;
}

export interface OpenVikingMemoryGroupModel {
	readonly key: string;
	readonly layer: OpenVikingMemoryLayer;
	readonly kind: OpenVikingMemoryGroupKind;
	/** Group heading, e.g. "repo rollcall", "craft preferences", "role design". */
	readonly title: string;
	readonly subtitle: string | null;
	readonly rows: readonly OpenVikingMemoryRowModel[];
}

export interface OpenVikingAuditRowModel {
	readonly key: string;
	readonly action: OpenVikingAuditAction;
	/** Badge text for the action; a `role_memory_write` is never labelled a commit. */
	readonly actionLabel: string;
	readonly roleLabel: string;
	readonly displayUri: string;
	readonly summaryLine: string;
	readonly guardVerdict: OpenVikingGuardVerdict;
	readonly guardLabel: string;
	readonly age: OpenVikingDisplayValue;
	/** Personal (agent) rows are metadata only (R-ISOLATION-1). */
	readonly isolated: boolean;
}

export interface OpenVikingFilterOption {
	readonly value: string;
	readonly label: string;
	readonly selected: boolean;
}

export interface OpenVikingAuditFiltersModel {
	readonly actions: readonly OpenVikingFilterOption[];
	readonly roles: readonly OpenVikingFilterOption[];
}

export interface OpenVikingAuditFilterSelection {
	readonly action: OpenVikingAuditAction | "all";
	readonly role: string | "all";
}

export interface OpenVikingDrawerTierModel {
	readonly tier: OpenVikingDisclosureTier;
	readonly label: string;
	readonly body: string;
	/** "Unavailable while offline" / isolation notice; null when real content is shown. */
	readonly unavailableReason: string | null;
}

export interface OpenVikingDrawerModel {
	/** The row that opened the drawer: the component returns focus here on close. */
	readonly rowKey: string;
	readonly title: string;
	readonly displayUri: string;
	readonly scopeLabel: string;
	readonly layerLabel: string;
	readonly tiers: readonly OpenVikingDrawerTierModel[];
	readonly provenance: OpenVikingEntryProvenance | null;
	/** Non-null only for a personal (agent) URI the viewer may not read. */
	readonly isolationNotice: string | null;
}

/** What a drawer was opened from, with the content read's outcome (403 `ISOLATED_ROLE_MEMORY` included). */
export type OpenVikingDrawerSource =
	| { readonly kind: "memory"; readonly rowKey: string; readonly entry: OpenVikingExplorerEntry }
	| { readonly kind: "audit"; readonly rowKey: string; readonly event: OpenVikingAuditEvent }
	| { readonly kind: "slot"; readonly rowKey: string; readonly slot: OpenVikingSlotSummary };

export interface OpenVikingContentError {
	readonly code: string;
	readonly message: string;
}
