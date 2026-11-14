/**
 * The self-contained HTTP route modules `server/index.ts` mounts at start-up, in order. New route modules are
 * added here, not in `server/index.ts`, which may not grow (`wt check` WT-SIZE-500 legacy ratchet).
 */
import type { Express } from "express";
import { registerFileTransferRoutes } from "./file-transfer-routes.js";
import { ownerCheckPending, registerOpenVikingRoutes, systemExplorerClock } from "./openviking/index.js";

/** `startBackgroundWork`: server start only — the OpenViking Memory list's background build (#155). */
export interface RouteModuleOptions {
	startBackgroundWork?: boolean;
}

export interface RouteModules {
	/** Server stop: the modules' shutdown hooks (the Memory Explorer ends its held deletes, spec-explorer-writes.md). */
	stop(): Promise<void>;
}

export function registerRouteModules(
	app: Express,
	getCwd: (clientId: string) => string | undefined,
	options: RouteModuleOptions = {},
): RouteModules {
	registerFileTransferRoutes(app, getCwd);
	const shutdownHooks: Array<() => Promise<void>> = [];
	// OpenViking Memory Dashboard (GET overview/entries/audit) and Memory Explorer. Until the owner session deploys
	// the gate is R-OWNER-INTERIM-1's: shared-root reads only, every write refused (R-OWNER-FAIL-CLOSED-1).
	const openViking = registerOpenVikingRoutes(app, {
		explorer: {
			ownerGate: ownerCheckPending,
			clock: systemExplorerClock,
			onShutdown: (hook) => shutdownHooks.push(hook),
		},
	});
	const stop = () => Promise.all(shutdownHooks.map((hook) => hook())).then(() => undefined);
	if (options.startBackgroundWork) {
		openViking.startEntriesSnapshot();
		// Exits that skip shutdown() (the systemd quit, restart_service) still end the held deletes: that part of
		// the hook is synchronous; a second call after shutdown() finds nothing left to end.
		process.once("exit", () => void stop());
	}
	return { stop };
}
