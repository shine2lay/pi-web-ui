/**
 * showtell-owner-answer (PATCHES.md; ops #882 seam, built by ops #883): the owner's own actions through a plugin's
 * proxy (host.registerProxy) become his recorded answer. A plugin declares its owner actions (method, path, body
 * values, the response field that names the action); when such a request reaches pi-web-ui's front door with the
 * browser's `sec-fetch-site: same-origin` and the upstream answers 2xx, the plugin gets a single-use receipt, and
 * only with that receipt can it have pi-web-ui write one `answer` record (answeredIn = the plugin's name for it,
 * ref = `<answeredIn>:<ref value>`, so a repeat writes nothing). Agent tools and direct calls to the plugin's own
 * server never pass the proxy, so they never get a receipt.
 * Seam: ~/ops-checks/owner-answers-2026-11-13/showtell-seam.md.
 *
 * Seam only (ops #882): every member throws OWNER_FRONT_DOOR_NOT_BUILT until ops #883 builds it.
 */
import type { DecisionRecords } from "./decision-records.js";

export const OWNER_FRONT_DOOR_NOT_BUILT = "owner front door: not built (ops #883)";

/** A receipt is good for this long after the upstream answered. */
export const RECEIPT_TTL_MS = 10 * 60_000;

/** One owner action on a plugin's proxy, e.g. `{ method: "POST", path: "/api/docs/:doc/status",
 *  body: { status: "done" }, refField: "batch_id" }`. `path` is the forwarded path (after the prefix);
 *  `:name` segments become the receipt's params. */
export interface OwnerActionSpec {
	method: "POST" | "PUT" | "PATCH" | "DELETE";
	path: string;
	/** Values the request's JSON body must have (string equality), if any. */
	body?: Record<string, string>;
	/** The field of the upstream's JSON answer that names the action (it becomes the record's ref). */
	refField: string;
}

export interface OwnerActionWatch {
	/** Where the record says he answered, e.g. "showtell". Lowercase letters only. */
	answeredIn: string;
	actions: OwnerActionSpec[];
}

export interface OwnerActionReceipt {
	id: string;
	pluginId: string;
	answeredIn: string;
	method: string;
	/** The forwarded path. */
	path: string;
	params: Record<string, string>;
	/** `<answeredIn>:<the response's refField value>`. */
	ref: string;
	/** When the upstream answered (ms). */
	at: number;
}

/** What the plugin adds to a receipt's record: his words verbatim and what they are about. */
export interface OwnerActionRecordFields {
	doc: {
		id: string;
		title: string;
		/** The version he acted on. */
		version: number;
		/** The doc's newest version when he acted. */
		latestVersion: number;
		kind: "approved" | "comments";
		/** Verbatim: ["Approved"], or each comment's body in number order. */
		words: string[];
		/** e.g. "/showtell/#/d/<id>". */
		link: string;
		/** The upstream's own id of the action, e.g. the batch id. */
		batchId: string;
	};
	/** The chat that shared the version he acted on (its pi session id), when the plugin knows it. */
	sharer?: { sessionId?: string; role?: string; chat?: string };
}

export type OwnerActionRecordResult = { ok: true; id: string; added: boolean } | { ok: false; error: string };

/** What a plugin sees as `PluginHost.ownerActions` (ops #883 adds the optional member to server/plugins.ts):
 *  the OwnerFrontDoor below, bound to the plugin's id. */
export interface PluginOwnerActions {
	watch(watch: OwnerActionWatch, handler: (receipt: OwnerActionReceipt) => void): () => void;
	record(receiptId: string, fields: OwnerActionRecordFields): OwnerActionRecordResult;
	recordIdFor(ref: string): string | undefined;
}

/** A proxied request as the proxy saw it, once the upstream answered. */
export interface FrontDoorExchange {
	pluginId: string;
	method: string;
	/** The forwarded path (after the prefix), query included. */
	path: string;
	headers: Record<string, string | string[] | undefined>;
	/** The request's JSON body, when it had one. */
	body?: unknown;
	status: number;
	/** The upstream's answer, as text (JSON when it is an action). */
	responseText: string;
}

export interface OwnerFrontDoorDeps {
	records: Pick<DecisionRecords, "append" | "has">;
	now?: () => number;
	newId?: () => string;
	/** A pi session id's chat file (absolute or base name), when the server knows it. */
	sessionFileOf?: (sessionId: string) => string | undefined;
}

export class OwnerFrontDoor {
	constructor(_deps: OwnerFrontDoorDeps) {}

	/** Declare a plugin's owner actions; returns the way to stop (unloading the plugin stops it too). */
	watch(_pluginId: string, _watch: OwnerActionWatch, _handler: (receipt: OwnerActionReceipt) => void): () => void {
		throw new Error(OWNER_FRONT_DOOR_NOT_BUILT);
	}

	/** Called by proxyHttp after the upstream answered a request it forwarded. */
	observe(_exchange: FrontDoorExchange): void {
		throw new Error(OWNER_FRONT_DOOR_NOT_BUILT);
	}

	/** Write the receipt's record (once). */
	record(_pluginId: string, _receiptId: string, _fields: OwnerActionRecordFields): OwnerActionRecordResult {
		throw new Error(OWNER_FRONT_DOOR_NOT_BUILT);
	}

	/** The record id already written for a ref. */
	recordIdFor(_ref: string): string | undefined {
		throw new Error(OWNER_FRONT_DOOR_NOT_BUILT);
	}
}
