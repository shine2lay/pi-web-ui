/**
 * OpenViking Memory Dashboard — Express route handlers and transport adapter seam.
 *
 * Exposes read-only endpoints:
 * - GET /api/openviking/overview
 * - GET /api/openviking/entries
 * - GET /api/openviking/audit
 * Non-GET requests return HTTP 405 Method Not Allowed (Allow: GET).
 */
import type { Express, Request, Response } from "express";
import { createOpenVikingClient, OpenVikingDaemonClient } from "./client.js";
import {
	OpenVikingDashboardError,
	type OpenVikingAuditQuery,
	type OpenVikingAuditResponse,
	type OpenVikingDashboardOptions,
	type OpenVikingEntriesQuery,
	type OpenVikingEntriesResponse,
	type OpenVikingHttpErrorBody,
	type OpenVikingOverviewResponse,
} from "./types.js";

export interface OpenVikingRouteResult<T> {
	status: number;
	headers?: Record<string, string>;
	body: T | OpenVikingHttpErrorBody;
}

function methodNotAllowedResult(method: string, path: string): OpenVikingRouteResult<never> {
	return {
		status: 405,
		headers: { Allow: "GET", "Cache-Control": "no-store" },
		body: {
			error: {
				code: "METHOD_NOT_ALLOWED",
				message: `OpenViking dashboard endpoint ${path} is strictly read-only (received ${method}; only GET is allowed).`,
				details: { method, path, allowed: ["GET"] },
			},
		},
	};
}

function toErrorResult(err: unknown): OpenVikingRouteResult<never> {
	if (err instanceof OpenVikingDashboardError) {
		return {
			status: err.statusCode,
			headers: { "Cache-Control": "no-store" },
			body: {
				error: {
					code: err.code,
					message: err.message,
					...(err.details ? { details: err.details } : {}),
				},
			},
		};
	}
	const message = err instanceof Error ? err.message : String(err);
	return {
		status: 500,
		headers: { "Cache-Control": "no-store" },
		body: {
			error: {
				code: "INTERNAL_ERROR",
				message,
			},
		},
	};
}

export async function handleOpenVikingOverviewRequest(
	client: OpenVikingDaemonClient,
	method = "GET",
): Promise<OpenVikingRouteResult<OpenVikingOverviewResponse>> {
	if (method.toUpperCase() !== "GET") {
		return methodNotAllowedResult(method, "/api/openviking/overview");
	}
	try {
		const body = await client.getOverview();
		return {
			status: 200,
			headers: { "Cache-Control": "no-store" },
			body,
		};
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
		const body = await client.getEntries(query);
		return {
			status: 200,
			headers: { "Cache-Control": "no-store" },
			body,
		};
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
		const body = await client.getAudit(query);
		return {
			status: 200,
			headers: { "Cache-Control": "no-store" },
			body,
		};
	} catch (err) {
		return toErrorResult(err);
	}
}

function sendRouteResult<T>(res: Response, result: OpenVikingRouteResult<T>): void {
	if (result.headers) {
		for (const [k, v] of Object.entries(result.headers)) {
			res.setHeader(k, v);
		}
	}
	res.status(result.status).json(result.body);
}

export function registerOpenVikingRoutes(
	app: Express,
	optionsOrClient: OpenVikingDashboardOptions | OpenVikingDaemonClient = {},
): OpenVikingDaemonClient {
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

	return client;
}
