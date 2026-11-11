/**
 * OpenViking Memory Dashboard — `GET /api/openviking/audit` -> audit rows and filters
 * (frontend #261, Task 1 seam). Task 2 (#258) implements the bodies.
 */

import type { OpenVikingAuditResponse } from "../../../server/openviking/types.js";
import { notImplemented } from "./not-implemented.js";
import type {
	OpenVikingAuditFiltersModel,
	OpenVikingAuditFilterSelection,
	OpenVikingAuditRowModel,
	OpenVikingRenderState,
} from "./view-model-types.js";

/**
 * Audit rows in server order. The action badge comes from `events[].action` only — the five
 * contract actions `commit` | `role_memory_write` | `promote_shared` | `reject_noise` |
 * `sidecar_timeout` (spec.md §3). A `role_memory_write` is labelled as a role memory write and
 * never as a commit: only a session committing its own work is a commit.
 *
 * Personal (agent) rows stay redacted: the server sends no `summary_1line` for them
 * (`R-ISOLATION-1`) and the row shows metadata only.
 */
export function buildAuditRows(
	audit: OpenVikingAuditResponse | null,
	nowMs: number,
	renderState: OpenVikingRenderState,
	selection: OpenVikingAuditFilterSelection,
): readonly OpenVikingAuditRowModel[] {
	void audit;
	void nowMs;
	void renderState;
	void selection;
	return notImplemented("buildAuditRows");
}

/**
 * The audit stream's filter controls: one option per contract action (plus "all") and one per role
 * present in the response (plus "all"), with the current selection marked. Filtering is a view
 * concern; no count, rate or verdict is computed in the browser.
 */
export function buildAuditFilters(
	audit: OpenVikingAuditResponse | null,
	selection: OpenVikingAuditFilterSelection,
): OpenVikingAuditFiltersModel {
	void audit;
	void selection;
	return notImplemented("buildAuditFilters");
}
