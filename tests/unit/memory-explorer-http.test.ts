/**
 * Memory explorer (design #316): the HTTP seam against the explorer routes (spec-explorer*.md,
 * architecture #541). Each write is confirmed by the owner's passkey for that exact operation
 * (R-OWNER-WRITE-2): the body the op names is the body sent, and nothing is sent without a confirm.
 */

import { describe, expect, it, vi } from "vitest";
import type { OpenVikingTreeRootsResponse } from "../../server/openviking/explorer-types.js";
import type { OwnerWriteOp } from "../../server/openviking/owner-session-types.js";
import { ExplorerApiError } from "../../web/src/memory-explorer/explorer-api.js";
import { createHttpExplorerApi, sha256Hex } from "../../web/src/memory-explorer/explorer-http.js";

const SHARED = "viking://user/default/memories";
const NOTE = `${SHARED}/preferences/ui_ux_design.md`;
const OPENED = "2026-11-14T01:21:00.000Z";

const ROOTS: OpenVikingTreeRootsResponse = {
	checked_at: "2026-11-14T01:25:00.000Z",
	health_state: "healthy",
	notes_total: 3,
	unread_count: 0,
	roots_partial: false,
	roots: [
		{
			uri: SHARED,
			group: "shared",
			role: null,
			read: true,
			notes: 3,
			folders: 1,
			kinds: { rule: 3, case: 0, fact: 0, event: 0, document: 0, other: 0 },
		},
	],
	recent: [{ uri: NOTE, root: SHARED, kind: "rule", size: 5200, mod_time: OPENED, locked: false }],
};

interface Sent {
	url: string;
	init: RequestInit;
}

function server(answers: Record<string, { status?: number; body: unknown }>) {
	const sent: Sent[] = [];
	const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
		sent.push({ url, init });
		const path = url.replace(/^.*\/api\/openviking/, "").replace(/\?.*$/, "");
		const key = `${init.method ?? "GET"} ${path}`;
		const answer = answers[key];
		if (!answer) return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), { status: 404 });
		return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
	});
	return { fetch, sent };
}

const header = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

describe("reads", () => {
	it("asks tree/roots once for the places and the recent list on the first screen", async () => {
		const { fetch, sent } = server({ "GET /tree/roots": { body: ROOTS } });
		const api = createHttpExplorerApi({ fetch, now: () => 0 });
		const [roots, recent] = await Promise.all([api.roots(), api.recent("all", 8)]);
		expect(roots[0]).toMatchObject({ uri: SHARED, noteCount: 3, read: true, kindCounts: { rule: 3, case: 0 } });
		expect(recent[0]).toMatchObject({ uri: NOTE, kind: "rule", locked: false, changedAt: OPENED });
		expect(sent.filter((s) => s.url.includes("/tree/roots"))).toHaveLength(1);
	});

	it("turns the owner check's refusal into OWNER_ONLY, so the page can ask him to sign in", async () => {
		const { fetch } = server({ "GET /tree/roots": { status: 403, body: { error: { code: "OWNER_ONLY" } } } });
		const api = createHttpExplorerApi({ fetch });
		await expect(api.roots()).rejects.toMatchObject({ code: "OWNER_ONLY" });
	});

	it("keeps a folder too big to count as not counted, never 0", async () => {
		const { fetch } = server({
			"GET /tree": {
				body: {
					uri: SHARED,
					root: SHARED,
					notes: null,
					folders: null,
					counts_reason: "truncated",
					last_change: null,
					abstract: null,
					abstract_reason: "not_ready",
					total: 0,
					children: [],
				},
			},
			"GET /note": { status: 404, body: { error: { code: "NOT_FOUND" } } },
			"GET /tree/roots": { body: ROOTS },
		});
		const listing = await createHttpExplorerApi({ fetch }).folder(SHARED, null);
		expect(listing.folder.noteCount).toBeNull();
		expect(listing.overview).toBeNull();
	});
});

describe("writes are confirmed by the owner's passkey, one operation at a time", () => {
	const edited = {
		operation_id: "op-1",
		uri: NOTE,
		changed: true,
		mod_time: "2026-11-14T01:26:00.000Z",
		undo_until: "2026-11-14T01:26:10.000Z",
	};

	it("refuses every write before sending anything when no owner sign-in is wired", async () => {
		const { fetch, sent } = server({ "PUT /note": { body: edited } });
		const api = createHttpExplorerApi({ fetch });
		await expect(api.save(NOTE, "new text", OPENED)).rejects.toBeInstanceOf(ExplorerApiError);
		await expect(api.remove(NOTE)).rejects.toMatchObject({ code: "OWNER_ONLY" });
		expect(sent).toHaveLength(0);
	});

	it("binds an edit's confirm to the exact body it sends", async () => {
		const { fetch, sent } = server({ "PUT /note": { body: edited } });
		const ops: OwnerWriteOp[] = [];
		const api = createHttpExplorerApi({
			fetch,
			ownerAssertion: async (op) => {
				ops.push(op);
				return "assertion-1";
			},
		});
		const record = await api.save(NOTE, "new text", OPENED);
		expect(record).toMatchObject({ id: "op-1", action: "edit", undoUntil: edited.undo_until });
		const put = sent[0];
		expect(put.init.method).toBe("PUT");
		expect(header(put.init, "X-Owner-Write")).toBe("1");
		expect(header(put.init, "X-Owner-Assertion")).toBe("assertion-1");
		expect(ops[0]).toEqual({
			method: "PUT",
			uri: NOTE,
			opened_mod_time: OPENED,
			body_sha256: await sha256Hex(put.init.body as string),
		});
		expect(JSON.parse(put.init.body as string)).toEqual({ uri: NOTE, content: "new text", opened_mod_time: OPENED });
	});

	it("confirms a delete and an undo with their own operations", async () => {
		const { fetch, sent } = server({
			"DELETE /note": { body: { operation_id: "op-2", uri: NOTE, state: "pending", applies_at: "2026-11-14T01:26:10Z" } },
			"POST /undo": { body: { operation_id: "op-2", state: "cancelled" } },
		});
		const ops: OwnerWriteOp[] = [];
		const api = createHttpExplorerApi({ fetch, ownerAssertion: async (op) => (ops.push(op), "a") });
		const record = await api.remove(NOTE);
		await api.undo(record.id);
		expect(ops).toEqual([
			{ method: "DELETE", uri: NOTE, body_sha256: await sha256Hex("") },
			{ method: "POST", operation_id: "op-2" },
		]);
		expect(sent[0].url).toContain(`uri=${encodeURIComponent(NOTE)}`);
		expect(sent[0].init.body).toBeUndefined();
		expect(JSON.parse(sent[1].init.body as string)).toEqual({ operation_id: "op-2" });
	});

	it("sends nothing when the owner cancels the passkey prompt", async () => {
		const { fetch, sent } = server({ "PUT /note": { body: edited } });
		const api = createHttpExplorerApi({
			fetch,
			ownerAssertion: async () => {
				throw new ExplorerApiError("OWNER_ONLY", "cancelled");
			},
		});
		await expect(api.save(NOTE, "x", OPENED)).rejects.toMatchObject({ code: "OWNER_ONLY" });
		expect(sent).toHaveLength(0);
	});

	it("maps a note saved by someone else since it was opened", async () => {
		const { fetch } = server({ "PUT /note": { status: 409, body: { error: { code: "NOTE_CHANGED" } } } });
		const api = createHttpExplorerApi({ fetch, ownerAssertion: async () => "a" });
		await expect(api.save(NOTE, "x", OPENED)).rejects.toMatchObject({ code: "CHANGED_SINCE_OPENED" });
	});
});
