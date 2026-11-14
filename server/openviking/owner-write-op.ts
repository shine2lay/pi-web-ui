/**
 * Memory Explorer — the operation a write's passkey assertion is bound to (R-OWNER-WRITE-2, Security rm-3e4885d2).
 * `write/options` stores the op the page says it will send; the gate rebuilds the op from the request the server
 * actually received (method, uri, opened_mod_time, sha256 of the received body bytes) and the two must be identical.
 * The received bytes come from the JSON parser's `verify` hook (`keepOwnerWriteBody`, wired in server/index.ts).
 */
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Request } from "express";
import { OPERATION_ID_RE, parseExplorerUri } from "./explorer-rules.js";
import type { OwnerWriteOp } from "./owner-session-types.js";

const receivedBodies = new WeakMap<IncomingMessage, Buffer>();

/** Paths whose request bodies a write assertion covers. */
const WRITE_BODY_PATHS = /^\/api\/openviking\/(note|undo|owner\/passkey)(\?|$)/;

/** `express.json({ verify })`: keeps the exact body bytes of explorer write requests (and only those). */
export function keepOwnerWriteBody(req: IncomingMessage, _res: unknown, buf: Buffer): void {
	if (WRITE_BODY_PATHS.test(req.url ?? "")) receivedBodies.set(req, Buffer.from(buf));
}

/** Lowercase hex sha256 of the body bytes the server received (no body: of no bytes). */
export function receivedBodySha256(req: IncomingMessage): string {
	return createHash("sha256")
		.update(receivedBodies.get(req) ?? Buffer.alloc(0))
		.digest("hex");
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const B64URL = /^[A-Za-z0-9_-]{1,1024}$/;

function exactKeys(raw: Record<string, unknown>, keys: string[]): boolean {
	const own = Object.keys(raw);
	return own.length === keys.length && keys.every((k) => own.includes(k));
}

function canonicalUri(raw: unknown): string | null {
	try {
		return parseExplorerUri(raw).uri;
	} catch {
		return null;
	}
}

/** The op as `write/options` received it, checked and with its uri canonical; null when it is not a valid op. */
export function checkedOwnerWriteOp(raw: unknown): OwnerWriteOp | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const op = raw as Record<string, unknown>;
	const sha = typeof op.body_sha256 === "string" && SHA256_HEX.test(op.body_sha256) ? op.body_sha256 : null;
	if (op.method === "PUT" && exactKeys(op, ["method", "uri", "opened_mod_time", "body_sha256"])) {
		const uri = canonicalUri(op.uri);
		const modTime = typeof op.opened_mod_time === "string" && op.opened_mod_time !== "" ? op.opened_mod_time : null;
		return uri && modTime && sha ? { method: "PUT", uri, opened_mod_time: modTime, body_sha256: sha } : null;
	}
	if (op.method === "DELETE" && exactKeys(op, ["method", "uri", "body_sha256"])) {
		const uri = canonicalUri(op.uri);
		return uri && sha ? { method: "DELETE", uri, body_sha256: sha } : null;
	}
	if (op.method === "POST" && exactKeys(op, ["method", "operation_id"])) {
		const id = op.operation_id;
		return typeof id === "string" && OPERATION_ID_RE.test(id) ? { method: "POST", operation_id: id } : null;
	}
	if (op.method === "DELETE" && exactKeys(op, ["method", "passkey_id"])) {
		const id = op.passkey_id;
		return typeof id === "string" && B64URL.test(id) ? { method: "DELETE", passkey_id: id } : null;
	}
	return null;
}

const fieldOf = (req: Request, key: string): unknown =>
	typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>)[key] : undefined;

/**
 * The note write (PUT or DELETE `/api/openviking/note`) the request will execute, rebuilt from what the server
 * received, uri canonical as the route parses it. A field that is not one becomes `""`, which no stored op holds.
 */
export function receivedNoteOp(req: Request): OwnerWriteOp {
	const sha = receivedBodySha256(req);
	if (req.method === "PUT") {
		const opened = fieldOf(req, "opened_mod_time");
		const uri = canonicalUri(fieldOf(req, "uri")) ?? "";
		return { method: "PUT", uri, opened_mod_time: typeof opened === "string" ? opened : "", body_sha256: sha };
	}
	return { method: "DELETE", uri: canonicalUri(req.query.uri) ?? "", body_sha256: sha };
}

/** The undo (POST `/api/openviking/undo`) the request will execute. */
export function receivedUndoOp(req: Request): OwnerWriteOp {
	const id = fieldOf(req, "operation_id");
	return { method: "POST", operation_id: typeof id === "string" ? id : "" };
}

/** One string per op, keys in a fixed order: two ops are the same operation exactly when these are equal. */
export function canonicalOwnerWriteOp(op: OwnerWriteOp): string {
	if ("passkey_id" in op) return JSON.stringify(["DELETE passkey", op.passkey_id]);
	if ("operation_id" in op) return JSON.stringify(["POST undo", op.operation_id]);
	if (op.method === "PUT") return JSON.stringify(["PUT note", op.uri, op.opened_mod_time, op.body_sha256]);
	return JSON.stringify(["DELETE note", op.uri, op.body_sha256]);
}
