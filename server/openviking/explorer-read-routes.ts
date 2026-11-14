/**
 * Memory Explorer — the read routes (spec-explorer.md G1-G4, backend #162):
 * - GET  /api/openviking/tree/roots
 * - GET  /api/openviking/tree?uri=&offset=&limit=
 * - GET  /api/openviking/note?uri=&level=
 * - POST /api/openviking/search
 * Each asks the one owner gate (owner-gate.ts) with the roots whose content its answer would show, before any daemon
 * call: tree/roots `[]` for its counts (and each root again for `recent[]`), tree and note the uri's root, search
 * the requested roots. Then the uri rule, the setup-file lock (G8), `/health`, and the daemon reads. Other methods: 405,
 * except PUT and DELETE on `/note`, which go on to the write routes (explorer-write-routes.ts).
 */
import type { Express, NextFunction, Request, Response } from "express";
import type { OpenVikingDaemonClient } from "./client.js";
import { assertMemoryReachable, toExplorerError } from "./explorer-daemon.js";
import { buildNote, parseNoteLevel } from "./explorer-note-read.js";
import { explorerRefusal, isSetupFile, parseExplorerUri } from "./explorer-rules.js";
import { parseSearchRequest, runSearch } from "./explorer-search.js";
import { buildTreeFolder, buildTreeRoots } from "./explorer-tree-read.js";
import { EXPLORER_FOLDER_LIMIT, type OpenVikingExplorerUri, type OpenVikingSearchRequest } from "./explorer-types.js";
import { assertOwner, type OpenVikingOwnerGate, ownerMayRead } from "./owner-gate.js";
import { methodNotAllowedResult, okResult, sendRouteResult, toErrorResult } from "./route-result.js";
import { OpenVikingDashboardError } from "./types.js";

type Handler = (req: Request) => Promise<unknown>;

/** `/note` methods the write routes (registered after these) answer. */
const NOTE_WRITE_METHODS: readonly string[] = ["PUT", "DELETE"];

/** A uri the request may read: inside the roots, the gate passes its root, and not a locked setup file. */
function readableUri(gate: OpenVikingOwnerGate, req: Request, raw: unknown): OpenVikingExplorerUri {
	const target = parseExplorerUri(raw);
	assertOwner(gate, req, { kind: "read", roots: [target.root.uri] });
	if (isSetupFile(target.uri)) {
		throw explorerRefusal("SETUP_FILE_LOCKED", "Identity and soul files are not opened here.", { uri: target.uri });
	}
	return target;
}

/** `offset` >= 0 (default 0) and `limit` 1-200 (default 30), as integers; else `400 INVALID_ARGUMENT`. */
function folderPage(req: Request): { offset: number; limit: number } {
	const int = (raw: unknown, fallback: number, min: number, max: number, name: string) => {
		if (raw === undefined) return fallback;
		const n = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
		if (!Number.isSafeInteger(n) || n < min || n > max) {
			throw new OpenVikingDashboardError(`${name} must be an integer ${min}-${max}.`, 400, "INVALID_ARGUMENT", {
				[name]: raw,
			});
		}
		return n;
	};
	return {
		offset: int(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER, "offset"),
		limit: int(
			req.query.limit,
			EXPLORER_FOLDER_LIMIT.default,
			EXPLORER_FOLDER_LIMIT.min,
			EXPLORER_FOLDER_LIMIT.max,
			"limit",
		),
	};
}

export function registerExplorerReadRoutes(
	app: Express,
	client: OpenVikingDaemonClient,
	gate: OpenVikingOwnerGate,
): void {
	const { http } = client;
	const route = (path: string, method: "GET" | "POST", handler: Handler, servedLater: readonly string[] = []) => {
		app.all(path, async (req: Request, res: Response, next: NextFunction) => {
			const received = req.method.toUpperCase();
			if (received !== method) {
				if (servedLater.includes(received)) {
					next();
					return;
				}
				sendRouteResult(res, methodNotAllowedResult(req.method, path, [method, ...servedLater]));
				return;
			}
			try {
				sendRouteResult(res, okResult(await handler(req)));
			} catch (err) {
				sendRouteResult(res, toErrorResult(toExplorerError(err)));
			}
		});
	};

	route("/api/openviking/tree/roots", "GET", async (req) => {
		assertOwner(gate, req, { kind: "read", roots: [] });
		return buildTreeRoots(http, client.now(), (root) => ownerMayRead(gate, req, [root]));
	});

	route("/api/openviking/tree", "GET", async (req) => {
		const target = readableUri(gate, req, req.query.uri);
		const page = folderPage(req);
		await assertMemoryReachable(http);
		return buildTreeFolder(http, target, page);
	});

	route(
		"/api/openviking/note",
		"GET",
		async (req) => {
			const target = readableUri(gate, req, req.query.uri);
			const level = parseNoteLevel(req.query.level);
			await assertMemoryReachable(http);
			return buildNote(http, client.statePaths, target, level);
		},
		NOTE_WRITE_METHODS,
	);

	route("/api/openviking/search", "POST", async (req) => {
		const plan = parseSearchRequest(req.body as OpenVikingSearchRequest | undefined);
		assertOwner(gate, req, { kind: "read", roots: plan.roots.map((r) => r.uri) });
		await assertMemoryReachable(http);
		return runSearch(http, plan, client.now());
	});
}
