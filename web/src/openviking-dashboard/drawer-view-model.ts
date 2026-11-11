/**
 * OpenViking Memory Dashboard — the L0/L1/L2 reader drawer (frontend #261, Task 1 seam).
 * Task 2 (#258) implements the body.
 */

import { notImplemented } from "./not-implemented.js";
import type {
	OpenVikingContentError,
	OpenVikingDrawerModel,
	OpenVikingDrawerSource,
	OpenVikingRenderState,
} from "./view-model-types.js";

/**
 * The drawer always describes the row it was opened from: its URI, scope, layer, L0/L1/L2 tiers and
 * provenance come from `source` alone, so a second row can never show the first row's content or age
 * (VERIFICATION.md M3, VERIFICATION-2.md P8).
 *
 * `contentError` carries the outcome of the L1/L2 read: `403 ISOLATED_ROLE_MEMORY` on a personal
 * (agent) URI sets `isolationNotice` and leaves every tier body empty — another role's memory text is
 * never painted (`R-ISOLATION-1`). While `:1933` is unreachable, L1/L2 read "Unavailable while
 * offline" instead of a cached healthy-looking body.
 */
export function buildDrawer(
	source: OpenVikingDrawerSource,
	nowMs: number,
	renderState: OpenVikingRenderState,
	contentError: OpenVikingContentError | null,
): OpenVikingDrawerModel {
	void source;
	void nowMs;
	void renderState;
	void contentError;
	return notImplemented("buildDrawer");
}
