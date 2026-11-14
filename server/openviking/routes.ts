/**
 * OpenViking Memory Dashboard — Express route handlers and transport adapter seam.
 *
 * Exposes read-only endpoints:
 * - GET /api/openviking/overview
 * - GET /api/openviking/entries
 * - GET /api/openviking/audit
 * Non-GET requests return HTTP 405 Method Not Allowed (Allow: GET).
 * The Memory Explorer's read routes (tree/roots, tree, note, search) are registered from explorer-read-routes.ts.
 */
import type { Express, Request, Response } from "express";
import { createOpenVikingClient, OpenVikingDaemonClient } from "./client.js";
import { registerExplorerReadRoutes } from "./explorer-read-routes.js";
import { ownerCheckPending } from "./owner-gate.js";
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
	OpenVikingEntriesQuery,
	OpenVikingEntriesResponse,
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

export async function handleOpenVikingEntriesRequest(
	client: OpenVikingDaemonClient,
	query: OpenVikingEntriesQuery = {},
	method = "GET",
): Promise<OpenVikingRouteResult<OpenVikingEntriesResponse>> {
	if (method.toUpperCase() !== "GET") {
		return methodNotAllowedResult(method, "/api/openviking/entries");
	}
	try {
		return okResult(await client.getEntries(query));
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

	app.all("/api/openviking/entries", async (req: Request, res: Response) => {
		const result = await handleOpenVikingEntriesRequest(
			client,
			{
				scope: req.query.scope,
				role: req.query.role,
				uri: req.query.uri,
				tier: req.query.tier,
				include_content: req.query.include_content,
			},
			req.method,
		);
		sendRouteResult(res, result);
	});

	app.all("/api/openviking/audit", async (req: Request, res: Response) => {
		const result = await handleOpenVikingAuditRequest(
			client,
			{
				limit: req.query.limit,
				action: req.query.action,
				role: req.query.role,
			},
			req.method,
		);
		sendRouteResult(res, result);
	});

	// Until the owner session (backend #165) deploys, the server's gate is R-OWNER-INTERIM-1's.
	registerExplorerReadRoutes(app, client, options.explorer?.ownerGate ?? ownerCheckPending);

	return client;
}
