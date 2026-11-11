/**
 * OpenViking Memory Dashboard — presentational root (frontend #261, Task 1 seam).
 *
 * The view takes an already-fetched snapshot as a prop and paints it. It never fetches, never takes
 * a state from a URL query parameter, never defines a demo global and never embeds a canned payload
 * (spec.md §Prototype-Only Chrome, enforced by `tests/openviking-dashboard/openviking-dashboard-explorer-audit.test.ts`).
 * The container that polls `/api/openviking/{overview,entries,audit}` is Task 2's (#258).
 *
 * Task 1 ships the placeholder below; the acceptance suite in `tests/openviking-dashboard/` fails on
 * the `[data-openviking-seam="not-implemented"]` marker until Task 2 renders the real page.
 */

import type { ReactElement } from "react";
import type {
	OpenVikingAuditResponse,
	OpenVikingEntriesResponse,
	OpenVikingOverviewResponse,
} from "../../../server/openviking/types.js";
import type { OpenVikingAuditFilterSelection } from "./view-model-types.js";

/** What the page knows right now. `loading` is the browser's own state; the rest come from the API. */
export type OpenVikingDashboardSnapshot =
	| { readonly status: "loading" }
	| {
			readonly status: "ready";
			readonly overview: OpenVikingOverviewResponse;
			readonly entries: OpenVikingEntriesResponse;
			readonly audit: OpenVikingAuditResponse;
	  }
	| { readonly status: "fetch-failed"; readonly message: string };

export interface OpenVikingDashboardViewProps {
	readonly snapshot: OpenVikingDashboardSnapshot;
	/** Injected clock, so ages are deterministic in tests and never drift from the fetched data. */
	readonly nowMs: number;
	/** Selected workspace tab; the container keeps it in the URL so polling never resets the view. */
	readonly activeTab?: "mount-map" | "namespace-explorer" | "commit-audit";
	readonly onActiveTabChange?: (tab: "mount-map" | "namespace-explorer" | "commit-audit") => void;
	readonly auditFilter?: OpenVikingAuditFilterSelection;
	readonly onAuditFilterChange?: (selection: OpenVikingAuditFilterSelection) => void;
}

export function OpenVikingDashboardView(props: OpenVikingDashboardViewProps): ReactElement {
	void props;
	return (
		<div data-component="openviking-dashboard" data-openviking-seam="not-implemented">
			OpenViking dashboard seam declaration (frontend #261); Task 2 (#258) renders the page.
		</div>
	);
}
