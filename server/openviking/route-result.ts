/**
 * OpenViking routes — the one way every `/api/openviking/*` route answers: its result shape, the error body
 * `{ error: { code, message, details? } }`, and `405` for a method the route does not take.
 */
import type { Response } from "express";
import { OpenVikingDashboardError, type OpenVikingHttpErrorBody } from "./types.js";

export interface OpenVikingRouteResult<T> {
	status: number;
	headers?: Record<string, string>;
	body: T | OpenVikingHttpErrorBody;
}

const NO_STORE = { "Cache-Control": "no-store" };

export function okResult<T>(body: T): OpenVikingRouteResult<T> {
	return { status: 200, headers: NO_STORE, body };
}

/** `202`: taken, not done yet (the Memory Explorer's held delete). */
export function acceptedResult<T>(body: T): OpenVikingRouteResult<T> {
	return { status: 202, headers: NO_STORE, body };
}

export function methodNotAllowedResult(
	method: string,
	path: string,
	allowed: readonly string[] = ["GET"],
): OpenVikingRouteResult<never> {
	const message =
		allowed.length === 1 && allowed[0] === "GET"
			? `OpenViking dashboard endpoint ${path} is strictly read-only (received ${method}; only GET is allowed).`
			: `OpenViking endpoint ${path} takes ${allowed.join(", ")} (received ${method}).`;
	return {
		status: 405,
		headers: { Allow: allowed.join(", "), ...NO_STORE },
		body: { error: { code: "METHOD_NOT_ALLOWED", message, details: { method, path, allowed: [...allowed] } } },
	};
}

export function toErrorResult(err: unknown): OpenVikingRouteResult<never> {
	if (err instanceof OpenVikingDashboardError) {
		return {
			status: err.statusCode,
			headers: NO_STORE,
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
	return { status: 500, headers: NO_STORE, body: { error: { code: "INTERNAL_ERROR", message } } };
}

export function sendRouteResult<T>(res: Response, result: OpenVikingRouteResult<T>): void {
	if (result.headers) {
		for (const [k, v] of Object.entries(result.headers)) {
			res.setHeader(k, v);
		}
	}
	res.status(result.status).json(result.body);
}
