/**
 * The self-contained HTTP route modules `server/index.ts` mounts at start-up, in order. New route modules are
 * added here, not in `server/index.ts`, which may not grow (`wt check` WT-SIZE-500 legacy ratchet).
 */
import type { Express } from "express";
import { registerFileTransferRoutes } from "./file-transfer-routes.js";
import { registerOpenVikingRoutes } from "./openviking/index.js";

/** `startBackgroundWork`: server start only — the OpenViking Memory list's background build (#155). */
export interface RouteModuleOptions {
	startBackgroundWork?: boolean;
}

export function registerRouteModules(
	app: Express,
	getCwd: (clientId: string) => string | undefined,
	options: RouteModuleOptions = {},
): void {
	registerFileTransferRoutes(app, getCwd);
	// OpenViking Memory Dashboard: read-only GET /api/openviking/{overview,entries,audit} (spec 6ec68dc).
	const openViking = registerOpenVikingRoutes(app);
	if (options.startBackgroundWork) openViking.startEntriesSnapshot();
}
