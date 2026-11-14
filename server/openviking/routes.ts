/**
 * OpenViking memory — Express route handlers and transport adapter seam.
 *
 * Exposes read-only endpoints:
 * - GET /api/openviking/overview
 * - GET /api/openviking/audit
 * Non-GET requests return HTTP 405 Method Not Allowed (Allow: GET).
 * The Memory Explorer's read routes (tree/roots, tree, note, search) are registered from explorer-read-routes.ts,
 * its write routes (note PUT/DELETE, undo) from explorer-write-routes.ts.
 */
import type { Express, Request, Response } from "express";
import { createOpenVikingClient, OpenVikingDaemonClient } from "./client.js";
import { systemExplorerClock } from "./explorer-clock.js";
import { registerExplorerReadRoutes } from "./explorer-read-routes.js";
import type { OpenVikingExplorerOptions } from "./explorer-types.js";
import { registerExplorerWriteRoutes } from "./explorer-write-routes.js";
import { ownerCheckMissing } from "./owner-gate.js";
import {
	methodNotAllowedResult,
	okResult,
	sendRouteResult,
	toErrorResult,
	type OpenVikingRouteResult,
} from "./route-result.js";
import type {
	OpenVikingAuditQuery,
	OpenVikingAuditResponse,
	OpenVikingDashboardOptions,
	OpenVikingOverviewResponse,
} from "./types.js";

export type { OpenVikingRouteResult } from "./route-result.js";

export async function handleOpenVikingOverviewRequest(
	client: OpenVikingDaemonClient,
	method = "GET",
): Promise<OpenVikingRouteResult<OpenVikingOverviewResponse>> {
	if (method.toUpperCase() !== "GET") {
		return methodNotAllowedResult(method, "/api/openviking/overview");
	}
	try {
		return okResult(await client.getOverview());
	} catch (err) {
		return toErrorResult(err);
	}
}

export async function handleOpenVikingAuditRequest(
	client: OpenVikingDaemonClient,
	query: OpenVikingAuditQuery = {},
	method = "GET",
): Promise<OpenVikingRouteResult<OpenVikingAuditResponse>> {
	if (method.toUpperCase() !== "GET") {
		return methodNotAllowedResult(method, "/api/openviking/audit");
	}
	try {
		return okResult(await client.getAudit(query));
	} catch (err) {
		return toErrorResult(err);
	}
}

export function registerOpenVikingRoutes(
	app: Express,
	optionsOrClient: OpenVikingDashboardOptions | OpenVikingDaemonClient = {},
): OpenVikingDaemonClient {
	const options = optionsOrClient instanceof OpenVikingDaemonClient ? {} : optionsOrClient;
	const client =
		optionsOrClient instanceof OpenVikingDaemonClient ? optionsOrClient : createOpenVikingClient(optionsOrClient);

	app.all("/api/openviking/overview", async (req: Request, res: Response) => {
		const result = await handleOpenVikingOverviewRequest(client, req.method);
		sendRouteResult(res, result);
	});

	app.all("/api/openviking/audit", async (req: Request, res: Response) => {
		const result = await handleOpenVikingAuditRequest(
			client,
			{
				limit: req.query.limit,
				action: req.query.action,
				role: req.query.role,
				owner_only: req.query.owner_only,
			},
			req.method,
		);
		sendRouteResult(res, result);
	});

	// Production passes the passkey owner check's gate (route-modules.ts); without one, nobody passes (fail closed).
	const explorer: OpenVikingExplorerOptions = options.explorer ?? {
		ownerGate: ownerCheckMissing,
		clock: systemExplorerClock,
		onShutdown: () => {},
		onUndoAsk: () => {},
	};
	registerExplorerReadRoutes(app, client, explorer.ownerGate);
	registerExplorerWriteRoutes(app, client, explorer);

	return client;
}
