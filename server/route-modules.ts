/**
 * The self-contained HTTP route modules `server/index.ts` mounts at start-up, in order. New route modules are
 * added here, not in `server/index.ts`, which may not grow (`wt check` WT-SIZE-500 legacy ratchet).
 */
import type { Express } from "express";
import { registerFileTransferRoutes } from "./file-transfer-routes.js";
import { ownerCheckMissing, registerOpenVikingRoutes, systemExplorerClock } from "./openviking/index.js";
import { createOwnerCheck } from "./openviking/owner-check.js";
import { type OwnerTelegramTool, ownerTelegramSender } from "./owner-telegram.js";

/** The JSON parser's `verify` hook a write's passkey assertion needs (the exact received body bytes). */
export { keepOwnerWriteBody } from "./openviking/owner-write-op.js";

/**
 * The running server, given at server start only: then the OpenViking Memory list's background build runs (#155) and
 * the passkey owner check (OI-1) keeps `owner-passkeys.json` in `dataDir` and sends through the Telegram plugin's tool.
 * Without it the explorer refuses everyone (fail closed).
 */
export interface RouteModuleServer {
	dataDir: string;
	/** The plugin manager, read when a notice is sent (it starts after the routes are mounted). */
	plugins: () => { agentToolOf(pluginId: string, name: string): OwnerTelegramTool | undefined };
}

export interface RouteModules {
	/** Server stop: the modules' shutdown hooks (the Memory Explorer ends its held deletes, spec-explorer-writes.md). */
	stop(): Promise<void>;
}

/** The passkey owner check, its undo asks handed to the explorer's writes once they register (R-OWNER-UNDO-1). */
function ownerCheckOf({ dataDir, plugins }: RouteModuleServer) {
	let askUndo: ((operationId: string, untilMs: number) => void) | null = null;
	const check = createOwnerCheck({
		dataDir,
		telegram: (notice) => ownerTelegramSender(plugins(), "owner-check")(notice),
		clock: systemExplorerClock,
		log: (line) => console.log(`[openviking] ${line}`),
		writeListener: { undoAsked: (operationId, untilMs) => askUndo?.(operationId, untilMs) },
	});
	return { check, onUndoAsk: (ask: typeof askUndo) => void (askUndo = ask) };
}

export function registerRouteModules(
	app: Express,
	getCwd: (clientId: string) => string | undefined,
	server?: RouteModuleServer,
): RouteModules {
	registerFileTransferRoutes(app, getCwd);
	const shutdownHooks: Array<() => Promise<void>> = [];
	const owner = server ? ownerCheckOf(server) : null;
	owner?.check.register(app);
	// OpenViking memory (GET overview/audit) and the Memory Explorer behind the owner check (OI-1);
	// with no owner check every explorer route refuses (R-OWNER-FAIL-CLOSED-1).
	registerOpenVikingRoutes(app, {
		explorer: {
			ownerGate: owner?.check.gate ?? ownerCheckMissing,
			clock: systemExplorerClock,
			onShutdown: (hook) => shutdownHooks.push(hook),
			onUndoAsk: owner?.onUndoAsk ?? (() => {}),
		},
	});
	const stop = () => Promise.all(shutdownHooks.map((hook) => hook())).then(() => undefined);
	if (owner) {
		// Exits that skip shutdown() (the systemd quit, restart_service) still end the held deletes: that part of
		// the hook is synchronous; a second call after shutdown() finds nothing left to end.
		process.once("exit", () => void stop());
	}
	return { stop };
}
