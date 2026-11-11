/**
 * OpenViking Memory Dashboard — the frontend seam (frontend #261, Task 1).
 *
 * One import point for Task 2 (#258) and for the acceptance tests: API types stay in
 * `server/openviking/types.ts` and are never redeclared here.
 */

export * from "./view-model-types.js";
export * from "./text.js";
export * from "./format.js";
export * from "./overview-view-model.js";
export * from "./explorer-view-model.js";
export * from "./audit-view-model.js";
export * from "./drawer-view-model.js";
export { OpenVikingDashboardView } from "./OpenVikingDashboardView.js";
export type { OpenVikingDashboardSnapshot, OpenVikingDashboardViewProps } from "./OpenVikingDashboardView.js";
