/**
 * OpenViking Memory Dashboard — `GET /api/openviking/entries` -> Memory Explorer groups
 * (frontend #261, Task 1 seam). Task 2 (#258) implements the bodies.
 */

import type { OpenVikingEntriesResponse } from "../../../server/openviking/types.js";
import { notImplemented } from "./not-implemented.js";
import type { OpenVikingMemoryGroupModel, OpenVikingRenderState } from "./view-model-types.js";

/**
 * Group keys are stable, so the page and its tests name the same group:
 * `repo:<repo>` (Layer 1 resources of one repo), `craft-preferences` (shared craft domains),
 * `shared:<category>` (other shared memories) and `role:<role>` (Layer 2 personal).
 *
 * Entries grouped for reading, never a flat list (owner rule, VERIFICATION.md M6):
 * Layer 1 Shared splits by repo (`viking://resources/<repo>/…`), craft-preference domains and the
 * other shared memories; Layer 2 Personal splits by role. Groups keep the server's order inside
 * them; a group with no rows is dropped rather than painted as an empty shell.
 *
 * Rows carry metadata only for another role's personal memory: the server already replaced
 * `l0_abstract` with the isolation placeholder and nulled `l1_overview`/`l2_content`
 * (`R-ISOLATION-1`), and the browser never fills that gap in.
 */
export function buildMemoryGroups(
	entries: OpenVikingEntriesResponse | null,
	nowMs: number,
	renderState: OpenVikingRenderState,
): readonly OpenVikingMemoryGroupModel[] {
	void entries;
	void nowMs;
	void renderState;
	return notImplemented("buildMemoryGroups");
}
