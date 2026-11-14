/**
 * Memory Explorer — the write routes (spec-explorer-writes.md G5, G6, Undo; backend #163):
 * - PUT    /api/openviking/note    `{ uri, content, opened_mod_time }`  edit, applied now, undo for 10 s
 * - DELETE /api/openviking/note?uri=                                  delete, held 10 s (`202`)
 * - POST   /api/openviking/undo    `{ operation_id }`
 * Each asks the one owner gate first with the exact op it will execute (R-OWNER-WRITE-1/2: the session plus its own
 * passkey assertion bound to that op, owner-check.ts), then the uri rule, the setup-file lock (G8) and the body, then `/health`; the
 * operations (explorer-operations.ts) do the rest. These are pi-web-ui's only writes to the store (R-EXPLORER-WRITE-1):
 * `content/write` and `DELETE /api/v1/fs`, through `writeResult`. GET /note is the read routes'.
 */
import type { Express, Request, Response } from "express";
import { appendChangelogLine } from "./changelog-append.js";
import type { OpenVikingDaemonClient } from "./client.js";
import type { OpenVikingDaemonHttp } from "./daemon-http.js";
import { assertMemoryReachable, statUri, toExplorerError } from "./explorer-daemon.js";
import { ExplorerOperations, type ExplorerNoteStore } from "./explorer-operations.js";
import { explorerRefusal, explorerRootHeaders, isSetupFile, parseExplorerUri } from "./explorer-rules.js";
import {
	EXPLORER_CONTENT_MAX_BYTES,
	type OpenVikingExplorerOptions,
	type OpenVikingExplorerUri,
	type OpenVikingNoteEditRequest,
	type OpenVikingUndoRequest,
} from "./explorer-types.js";
import { assertOwnerWrite, type OpenVikingOwnerGate } from "./owner-gate.js";
import { receivedNoteOp, receivedUndoOp } from "./owner-write-op.js";
import {
	acceptedResult,
	methodNotAllowedResult,
	okResult,
	sendRouteResult,
	toErrorResult,
	type OpenVikingRouteResult,
} from "./route-result.js";

/** ISO-8601 with a time and an offset, as the page sends `opened_mod_time` back (`fs/stat`'s own `modTime`). */
const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** Every store failure leaves here mapped (`MEMORY_UNREACHABLE`, `NOT_FOUND`, `MEMORY_ERROR`). */
async function mapped<T>(call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (err) {
		throw toExplorerError(err);
	}
}

/** The operations' store: the daemon, under the root's request headers. */
export function daemonNoteStore(http: OpenVikingDaemonHttp): ExplorerNoteStore {
	const headers = (target: OpenVikingExplorerUri) => explorerRootHeaders(target.root);
	return {
		stat: (target) => mapped(() => statUri(http, target.uri, headers(target))),
		read: (target) =>
			mapped(async () => {
				const text = await http.result("/api/v1/content/read", { uri: target.uri }, headers(target));
				if (typeof text !== "string") {
					throw explorerRefusal("MEMORY_ERROR", `content/read of ${target.uri} did not answer text.`);
				}
				return text;
			}),
		write: (target, content) =>
			mapped(async () => {
				const body = { uri: target.uri, content, mode: "replace", edit_source: "manual" };
				await http.writeResult({ method: "POST", path: "/api/v1/content/write", body }, headers(target));
			}),
		remove: (target) =>
			mapped(async () => {
				const params = { uri: target.uri, recursive: "false" };
				await http.writeResult({ method: "DELETE", path: "/api/v1/fs", params }, headers(target));
			}),
	};
}

/** A uri the request may change: the gate passed this write, inside the roots, not a locked setup file. */
async function writableUri(gate: OpenVikingOwnerGate, req: Request, raw: unknown): Promise<OpenVikingExplorerUri> {
	await assertOwnerWrite(gate, req, receivedNoteOp(req));
	const target = parseExplorerUri(raw);
	if (isSetupFile(target.uri)) {
		throw explorerRefusal("SETUP_FILE_LOCKED", "Identity and soul files are not changed here.", { uri: target.uri });
	}
	return target;
}

const bodyOf = <T>(req: Request): T => (typeof req.body === "object" && req.body !== null ? req.body : {}) as T;

/** G5 step 1: `content` a string of at most 1 MiB (UTF-8), `opened_mod_time` ISO. */
function editFields(body: OpenVikingNoteEditRequest): { content: string; openedModTime: string } {
	const { content, opened_mod_time: opened } = body;
	if (typeof content !== "string") throw explorerRefusal("EDIT_INVALID", "content must be a string.");
	if (Buffer.byteLength(content, "utf8") > EXPLORER_CONTENT_MAX_BYTES) {
		throw explorerRefusal("CONTENT_TOO_LARGE", `A note holds at most ${EXPLORER_CONTENT_MAX_BYTES} bytes.`);
	}
	if (typeof opened !== "string" || !ISO_TIME_RE.test(opened) || Number.isNaN(Date.parse(opened))) {
		throw explorerRefusal("EDIT_INVALID", "opened_mod_time must be the note's ISO-8601 modTime.");
	}
	return { content, openedModTime: opened };
}

export function registerExplorerWriteRoutes(
	app: Express,
	client: OpenVikingDaemonClient,
	explorer: OpenVikingExplorerOptions,
): ExplorerOperations {
	const { http } = client;
	const gate = explorer.ownerGate;
	const operations = new ExplorerOperations({
		store: daemonNoteStore(http),
		append: (line) => appendChangelogLine(client.statePaths.changelogJsonlPath, line),
		clock: explorer.clock,
	});
	explorer.onShutdown(() => operations.shutdown());
	explorer.onUndoAsk((operationId, untilMs) => void operations.askUndo(operationId, untilMs));

	const answer =
		(handler: (req: Request) => Promise<OpenVikingRouteResult<unknown>>) => async (req: Request, res: Response) => {
			try {
				sendRouteResult(res, await handler(req));
			} catch (err) {
				sendRouteResult(res, toErrorResult(toExplorerError(err)));
			}
		};

	app.put(
		"/api/openviking/note",
		answer(async (req) => {
			const body = bodyOf<OpenVikingNoteEditRequest>(req);
			const target = await writableUri(gate, req, body.uri);
			const { content, openedModTime } = editFields(body);
			await assertMemoryReachable(http);
			return okResult(await operations.edit(target, content, openedModTime));
		}),
	);

	app.delete(
		"/api/openviking/note",
		answer(async (req) => {
			const target = await writableUri(gate, req, req.query.uri);
			await assertMemoryReachable(http);
			return acceptedResult(await operations.requestDelete(target));
		}),
	);

	app.all(
		"/api/openviking/undo",
		answer(async (req) => {
			if (req.method.toUpperCase() !== "POST") {
				return methodNotAllowedResult(req.method, "/api/openviking/undo", ["POST"]);
			}
			await assertOwnerWrite(gate, req, receivedUndoOp(req));
			return okResult(await operations.undo(bodyOf<OpenVikingUndoRequest>(req).operation_id));
		}),
	);

	return operations;
}
