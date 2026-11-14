/**
 * showtell-owner-answer (PATCHES.md; ops #882 seam, built by ops #883): the owner's own actions through a plugin's
 * proxy (host.registerProxy) become his recorded answer. A plugin declares its owner actions (method, path, body
 * values, the response field that names the action); when such a request reaches pi-web-ui's front door with the
 * browser's `sec-fetch-site: same-origin` and the upstream answers 2xx, the plugin gets a single-use receipt, and
 * only with that receipt can it have pi-web-ui write one `answer` record (answeredIn = the plugin's name for it,
 * ref = `<answeredIn>:<ref value>`, so a repeat writes nothing). Agent tools and direct calls to the plugin's own
 * server never pass the proxy, so they never get a receipt.
 * Seam: ~/ops-checks/owner-answers-2026-11-13/showtell-seam.md.
 */
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { DecisionRecords, recordId } from "./decision-records.js";
import { proxyForwardPath, type ProxyHit, type ProxyObserver } from "./plugin-proxy.js";

/** A receipt is good for this long after the upstream answered. */
export const RECEIPT_TTL_MS = 10 * 60_000;

/** The most of an upstream answer the proxy keeps for observe() (an action's answer is a small JSON object). */
export const FRONT_DOOR_RESPONSE_MAX = 64 * 1024;

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

/** The doc an answer is about, as the record keeps it. */
export interface FrontDoorDoc {
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
	/** The pi session id of the chat that shared the version he acted on (record only). */
	sharerSession?: string;
}

/** What the plugin adds to a receipt's record: his words verbatim and what they are about. */
export interface OwnerActionRecordFields {
	doc: Omit<FrontDoorDoc, "sharerSession">;
	/** The chat that shared the version he acted on (its pi session id), when the plugin knows it. */
	sharer?: { sessionId?: string; role?: string; chat?: string };
}

export type OwnerActionRecordResult = { ok: true; id: string; added: boolean } | { ok: false; error: string };

/** What a plugin sees as `PluginHost.ownerActions`: the OwnerFrontDoor below, bound to the plugin's id. */
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

interface Watcher {
	watch: OwnerActionWatch;
	handler: (receipt: OwnerActionReceipt) => void;
}

const ANSWERED_IN = /^[a-z]+$/;
const SOURCE = "answer";

/** The `:name` params when `path` (no query) matches `pattern`, else undefined. */
function matchPath(pattern: string, path: string): Record<string, string> | undefined {
	const want = pattern.split("/");
	const got = path.split("/");
	if (want.length !== got.length) return undefined;
	const params: Record<string, string> = {};
	for (let i = 0; i < want.length; i++) {
		const w = want[i]!;
		const g = got[i]!;
		if (w.startsWith(":")) {
			let v: string;
			try {
				v = decodeURIComponent(g);
			} catch {
				return undefined;
			}
			if (!v || v.includes("/")) return undefined;
			params[w.slice(1)] = v;
		} else if (w !== g) return undefined;
	}
	return params;
}

const header = (h: FrontDoorExchange["headers"], name: string): string | undefined => {
	const v = h[name] ?? h[name.toLowerCase()];
	return Array.isArray(v) ? v[0] : v;
};

const bodyHas = (body: unknown, want: Record<string, string> | undefined): boolean => {
	if (!want) return true;
	if (!body || typeof body !== "object" || Array.isArray(body)) return false;
	const b = body as Record<string, unknown>;
	return Object.entries(want).every(([k, v]) => b[k] === v);
};

function refValueOf(text: string, field: string): string | undefined {
	try {
		const j = JSON.parse(text) as unknown;
		if (!j || typeof j !== "object" || Array.isArray(j)) return undefined;
		const v = (j as Record<string, unknown>)[field];
		return typeof v === "string" && v.trim() ? v : undefined;
	} catch {
		return undefined;
	}
}

export class OwnerFrontDoor {
	private readonly watchers = new Map<string, Set<Watcher>>();
	private readonly receipts = new Map<string, OwnerActionReceipt>();
	private readonly now: () => number;
	private readonly newId: () => string;

	constructor(private readonly deps: OwnerFrontDoorDeps) {
		this.now = deps.now ?? Date.now;
		this.newId = deps.newId ?? (() => `fd-${randomUUID()}`);
	}

	/** Declare a plugin's owner actions; returns the way to stop (unloading the plugin stops it too). */
	watch(pluginId: string, watch: OwnerActionWatch, handler: (receipt: OwnerActionReceipt) => void): () => void {
		if (!ANSWERED_IN.test(watch?.answeredIn ?? ""))
			throw new Error(`ownerActions.watch: answeredIn must be lowercase letters`);
		if (!Array.isArray(watch.actions) || !watch.actions.length) throw new Error("ownerActions.watch: no actions");
		for (const a of watch.actions) {
			if (!["POST", "PUT", "PATCH", "DELETE"].includes(a.method) || !a.path?.startsWith("/") || !a.refField) {
				throw new Error(`ownerActions.watch: bad action ${JSON.stringify(a)}`);
			}
		}
		const w: Watcher = { watch, handler };
		const set = this.watchers.get(pluginId) ?? new Set<Watcher>();
		set.add(w);
		this.watchers.set(pluginId, set);
		return () => {
			set.delete(w);
			if (!set.size) this.watchers.delete(pluginId);
		};
	}

	/** Whether a request to this plugin's proxy may be an owner action (the proxy keeps its answer only then). */
	watches(pluginId: string, method: string): boolean {
		const set = this.watchers.get(pluginId);
		if (!set) return false;
		for (const w of set) if (w.watch.actions.some((a) => a.method === method)) return true;
		return false;
	}

	/** The proxy's observer for a request it forwards on `hit` (plugin-proxy.ts pluginProxyMiddleware), or
	 *  undefined when it can't be an owner action, so the proxy keeps nothing. */
	observerFor(
		hit: ProxyHit,
		req: { method: string; url?: string; headers: FrontDoorExchange["headers"]; body?: unknown },
	): ProxyObserver | undefined {
		if (!this.watches(hit.pluginId, req.method)) return undefined;
		const sent = {
			pluginId: hit.pluginId,
			method: req.method,
			path: proxyForwardPath(hit, req.url ?? "/"),
			headers: req.headers,
			body: req.body,
		};
		return {
			max: FRONT_DOOR_RESPONSE_MAX,
			done: (status, responseText) => this.observe({ ...sent, status, responseText }),
		};
	}

	/** Called by proxyHttp after the upstream answered a request it forwarded. */
	observe(ex: FrontDoorExchange): void {
		const set = this.watchers.get(ex.pluginId);
		if (!set || header(ex.headers, "sec-fetch-site") !== "same-origin") return;
		if (ex.status < 200 || ex.status > 299) return;
		const path = ex.path.split("?")[0]!;
		const at = this.now();
		this.prune(at);
		for (const w of set) {
			for (const a of w.watch.actions) {
				if (a.method !== ex.method) continue;
				const params = matchPath(a.path, path);
				if (!params || !bodyHas(ex.body, a.body)) continue;
				const value = refValueOf(ex.responseText, a.refField);
				if (!value) continue;
				const receipt: OwnerActionReceipt = {
					id: this.newId(),
					pluginId: ex.pluginId,
					answeredIn: w.watch.answeredIn,
					method: ex.method,
					path,
					params,
					ref: `${w.watch.answeredIn}:${value}`,
					at,
				};
				this.receipts.set(receipt.id, receipt);
				try {
					w.handler({ ...receipt, params: { ...params } });
				} catch (err) {
					console.error(`[owner-front-door] ${ex.pluginId} receipt handler failed:`, err);
				}
				break;
			}
		}
	}

	/** Write the receipt's record (once). */
	record(pluginId: string, receiptId: string, fields: OwnerActionRecordFields): OwnerActionRecordResult {
		const r = this.receipts.get(receiptId);
		if (!r || r.pluginId !== pluginId) return { ok: false, error: "no such receipt" };
		if (this.now() > r.at + RECEIPT_TTL_MS) {
			this.receipts.delete(receiptId);
			return { ok: false, error: "the receipt expired" };
		}
		const doc = fields?.doc;
		if (!doc || typeof doc.id !== "string" || doc.id !== r.params.doc) {
			return { ok: false, error: "the record's doc isn't the one he acted on" };
		}
		if (`${r.answeredIn}:${doc.batchId}` !== r.ref)
			return { ok: false, error: "the record's batch isn't the receipt's" };
		if (!Array.isArray(doc.words) || !doc.words.length || !doc.words.every((x) => typeof x === "string")) {
			return { ok: false, error: "no words" };
		}
		this.receipts.delete(receiptId);
		const id = recordIdOf(r.ref);
		const sessionId = fields.sharer?.sessionId;
		const file = sessionId ? this.deps.sessionFileOf?.(sessionId) : undefined;
		const added = this.deps.records.append({
			source: SOURCE,
			from: "owner",
			how: "live",
			ask: "showtell",
			answeredIn: r.answeredIn,
			ref: r.ref,
			at: r.at,
			...(fields.sharer?.role ? { to: fields.sharer.role } : {}),
			...(fields.sharer?.chat ? { chat: fields.sharer.chat } : {}),
			...(file ? { file: basename(file) } : {}),
			title: doc.title,
			summary: doc.words.join("\n"),
			doc: {
				id: doc.id,
				title: doc.title,
				version: doc.version,
				latestVersion: doc.latestVersion,
				kind: doc.kind,
				words: [...doc.words],
				link: doc.link,
				batchId: doc.batchId,
				...(sessionId ? { sharerSession: sessionId } : {}),
			},
		});
		return { ok: true, id, added };
	}

	/** The record id already written for a ref. */
	recordIdFor(ref: string): string | undefined {
		return this.deps.records.has(SOURCE, ref) ? recordIdOf(ref) : undefined;
	}

	/** The plugin's view: `PluginHost.ownerActions`. `track` registers the undo (stopped when the plugin unloads). */
	forPlugin(pluginId: string, track: (key: string, undo: () => void) => () => void): PluginOwnerActions {
		return {
			watch: (w, handler) => track(`ownerActions:${w?.answeredIn ?? "?"}`, this.watch(pluginId, w, handler)),
			record: (receiptId, fields) => this.record(pluginId, receiptId, fields),
			recordIdFor: (ref) => this.recordIdFor(ref),
		};
	}

	private prune(now: number): void {
		for (const [id, r] of this.receipts) if (now > r.at + RECEIPT_TTL_MS) this.receipts.delete(id);
	}
}

/** index.ts: the front door over the engine's decision records (`decisions`), or undefined for an engine with none. */
export function ownerFrontDoorFor(engine: object, sessionsRoot: () => string): OwnerFrontDoor | undefined {
	const records = (engine as { decisions?: unknown }).decisions;
	if (!(records instanceof DecisionRecords)) return undefined;
	return new OwnerFrontDoor({ records, sessionFileOf: (id) => sessionFileIn(sessionsRoot(), id) });
}

/** A pi chat file is `<time>_<session id>.jsonl` in a folder under the sessions root: the one for `sessionId`. */
export function sessionFileIn(root: string, sessionId: string): string | undefined {
	if (!/^[A-Za-z0-9-]{8,64}$/.test(sessionId)) return undefined;
	const tail = `_${sessionId}.jsonl`;
	let dirs: string[];
	try {
		dirs = readdirSync(root);
	} catch {
		return undefined;
	}
	for (const d of dirs) {
		try {
			const hit = readdirSync(join(root, d)).find((f) => f.endsWith(tail));
			if (hit) return join(root, d, hit);
		} catch {
			// not a folder
		}
	}
	return undefined;
}

/** The same id DecisionRecords gives an answer record with this ref. */
function recordIdOf(ref: string): string {
	return recordId(SOURCE, ref);
}
