/**
 * R-OWNER-UNDO-1 end to end (spec-explorer-writes.md "Undo" + "Operation States"; backend #167): the undo ask goes
 * through the real `owner/write/options`, the undo through the real owner gate with a fake authenticator, and the
 * explorer's writes reach the daemon fake. A held delete never reaches `DELETE /api/v1/fs` once its undo was asked
 * for inside the 10 s; the change record shows how it ended. Gate cases: openviking-owner-write.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { OWNER_WRITE_CHALLENGE_MS, type OwnerWriteOp } from "../../server/openviking/owner-session-types.js";
import { NOW } from "./openviking-daemon-fake.js";
import { settle } from "./openviking-explorer-harness.js";
import { FakePasskey } from "./openviking-owner-fakes.js";
import { type OwnerHarness, ownerHarness, PI_RP } from "./openviking-owner-harness.js";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const NOTE = "viking://user/qa/memories/cases/edit-me.md";
const OPENED_MS = NOW - 300_000;
const OPENED = new Date(OPENED_MS).toISOString();
const WINDOW_MS = 10_000;

const harnesses: OwnerHarness[] = [];
afterEach(async () => {
	await Promise.all(harnesses.splice(0).map((x) => x.close()));
});

async function signedIn() {
	const x = await ownerHarness();
	harnesses.push(x);
	x.fake.store.put(NOTE, "before\n", OPENED_MS);
	const passkey = new FakePasskey(PI_RP.rpID);
	const cookie = await x.owned(passkey);
	return { x, passkey, cookie };
}

const undoOpOf = (operationId: string): OwnerWriteOp => ({ method: "POST", operation_id: operationId });
const undoBodyOf = (operationId: string) => JSON.stringify({ operation_id: operationId });
/** Store calls that delete: the one `DELETE /api/v1/fs` a held delete makes when its window closes. */
const storeDeletes = (x: OwnerHarness) =>
	x.fake.calls.filter((c) => c.method === "DELETE" && c.url.pathname === "/api/v1/fs").length;
const contentWrites = (x: OwnerHarness) =>
	x.fake.calls.filter((c) => c.url.pathname === "/api/v1/content/write").length;
const outcomes = (x: OwnerHarness) => x.changelog().map((l) => `${l.action} ${l.outcome}`);
const errorOf = (r: { status: number; body: unknown }) => {
	const e = (r.body as { error: { code: string; details?: unknown } }).error;
	return [r.status, e.code, e.details];
};

/** The owner confirmed a delete: `202`, held 10 s from now. */
async function heldDelete() {
	const s = await signedIn();
	const op: OwnerWriteOp = { method: "DELETE", uri: NOTE, body_sha256: sha256("") };
	const assertion = await s.x.assertion(s.passkey, s.cookie, op);
	const r = await s.x.write("DELETE", `/api/openviking/note?uri=${encodeURIComponent(NOTE)}`, {
		cookie: s.cookie,
		assertion,
	});
	expect(r.status).toBe(202);
	const operationId = (r.body as { operation_id: string }).operation_id;
	return { ...s, operationId, undoOp: undoOpOf(operationId), undoBody: undoBodyOf(operationId) };
}

/** Walks the clock forward in `stepMs` steps (every timer fires on its own ms), then lets the writes settle. */
async function walk(x: OwnerHarness, totalMs: number, stepMs = 250) {
	for (let t = 0; t < totalMs; t += stepMs) x.clock.advance(Math.min(stepMs, totalMs - t));
	await settle();
}

describe("R-OWNER-UNDO-1: once undo was asked for, a held delete never runs", () => {
	it.each([
		["confirmed 30 s after the ask", 30_000],
		["never confirmed", null],
	])("asked at 9.999 s, %s: no DELETE /api/v1/fs at any clock time", async (_what, confirmAfterMs) => {
		const { x, passkey, cookie, operationId, undoOp, undoBody } = await heldDelete();
		x.clock.advance(WINDOW_MS - 1);
		const assertion = await x.assertion(passkey, cookie, undoOp);
		if (confirmAfterMs !== null) {
			await walk(x, confirmAfterMs);
			expect(storeDeletes(x)).toBe(0);
			const r = await x.write("POST", "/api/openviking/undo", { cookie, assertion, rawBody: undoBody });
			expect([r.status, r.body]).toEqual([200, { operation_id: operationId, state: "cancelled" }]);
		}
		await walk(x, 5 * OWNER_WRITE_CHALLENGE_MS);
		expect(storeDeletes(x)).toBe(0);
		expect(x.fake.store.nodes.get(NOTE)?.content).toBe("before\n");
	});

	it("assertion verified -> cancelled: owner_undo applied, then owner_delete cancelled, one operation_id", async () => {
		const { x, passkey, cookie, operationId, undoOp, undoBody } = await heldDelete();
		x.clock.advance(5_000);
		const assertion = await x.assertion(passkey, cookie, undoOp);
		await walk(x, 20_000);
		const r = await x.write("POST", "/api/openviking/undo", { cookie, assertion, rawBody: undoBody });
		expect([r.status, r.body]).toEqual([200, { operation_id: operationId, state: "cancelled" }]);
		expect(outcomes(x)).toEqual(["owner_undo applied", "owner_delete cancelled"]);
		expect(x.changelog().map((l) => l.operation_id)).toEqual([operationId, operationId]);
		expect(x.changelog()[0]).toMatchObject({ undo_of: "delete", role: "owner" });
		expect(storeDeletes(x)).toBe(0);
	});

	it("the 60 s challenge expires unused -> cancelled: owner_undo unconfirmed, owner_delete cancelled, no DELETE", async () => {
		const { x, passkey, cookie, operationId, undoOp, undoBody } = await heldDelete();
		x.clock.advance(5_000);
		await x.assertion(passkey, cookie, undoOp);
		await walk(x, OWNER_WRITE_CHALLENGE_MS - 1);
		expect(outcomes(x)).toEqual([]);
		await walk(x, 1);
		expect(outcomes(x)).toEqual(["owner_undo unconfirmed", "owner_delete cancelled"]);
		expect(x.changelog().map((l) => l.operation_id)).toEqual([operationId, operationId]);
		expect(storeDeletes(x)).toBe(0);
		const late = await x.assertion(passkey, cookie, undoOp);
		const r = await x.write("POST", "/api/openviking/undo", { cookie, assertion: late, rawBody: undoBody });
		expect(errorOf(r)).toEqual([410, "UNDO_WINDOW_CLOSED", { state: "cancelled" }]);
	});

	it("asked at 10.001 s: too late, the delete ran and the undo answers 410 { state: applied }", async () => {
		const { x, passkey, cookie, undoOp, undoBody } = await heldDelete();
		await walk(x, WINDOW_MS + 1);
		expect(storeDeletes(x)).toBe(1);
		const assertion = await x.assertion(passkey, cookie, undoOp);
		const r = await x.write("POST", "/api/openviking/undo", { cookie, assertion, rawBody: undoBody });
		expect(errorOf(r)).toEqual([410, "UNDO_WINDOW_CLOSED", { state: "applied" }]);
		expect(outcomes(x)).toEqual(["owner_delete applied"]);
		expect(storeDeletes(x)).toBe(1);
	});

	it("an undo for an unknown operation -> 404 OPERATION_UNKNOWN, nothing written", async () => {
		const { x, passkey, cookie } = await signedIn();
		const unknown = "op-1794631805120-3f9a1c2e";
		const assertion = await x.assertion(passkey, cookie, undoOpOf(unknown));
		const r = await x.write("POST", "/api/openviking/undo", { cookie, assertion, rawBody: undoBodyOf(unknown) });
		expect(errorOf(r)).toEqual([404, "OPERATION_UNKNOWN", undefined]);
		expect(outcomes(x)).toEqual([]);
	});

	it("restart while undo_pending: owner_delete not_applied_restart, no store call, then or later", async () => {
		const { x, passkey, cookie, operationId, undoOp } = await heldDelete();
		x.clock.advance(5_000);
		await x.assertion(passkey, cookie, undoOp);
		const callsBefore = x.fake.calls.length;
		const y = await x.restart();
		harnesses.push(y);
		expect(outcomes(x)).toEqual(["owner_delete not_applied_restart"]);
		expect(x.changelog()[0]).toMatchObject({ operation_id: operationId });
		await walk(x, 5 * OWNER_WRITE_CHALLENGE_MS);
		expect(x.fake.calls.length).toBe(callsBefore);
		expect(storeDeletes(x)).toBe(0);
	});
});

describe("R-OWNER-UNDO-1 for an edit: the ask keeps undo open for the challenge's 60 s", () => {
	async function confirmedEdit() {
		const s = await signedIn();
		const raw = JSON.stringify({ uri: NOTE, content: "after\n", opened_mod_time: OPENED });
		const op: OwnerWriteOp = { method: "PUT", uri: NOTE, opened_mod_time: OPENED, body_sha256: sha256(raw) };
		const assertion = await s.x.assertion(s.passkey, s.cookie, op);
		const r = await s.x.write("PUT", "/api/openviking/note", { cookie: s.cookie, assertion, rawBody: raw });
		expect(r.status).toBe(200);
		const operationId = (r.body as { operation_id: string }).operation_id;
		return { ...s, operationId, undoOp: undoOpOf(operationId), undoBody: undoBodyOf(operationId) };
	}

	it("asked inside the 10 s, confirmed at 30 s: undone", async () => {
		const { x, passkey, cookie, undoOp, undoBody } = await confirmedEdit();
		x.clock.advance(5_000);
		const assertion = await x.assertion(passkey, cookie, undoOp);
		await walk(x, 25_000);
		const r = await x.write("POST", "/api/openviking/undo", { cookie, assertion, rawBody: undoBody });
		expect([r.status, (r.body as { state: string }).state]).toEqual([200, "undone"]);
		expect(x.fake.store.nodes.get(NOTE)?.content).toBe("before\n");
		expect(outcomes(x)).toEqual(["owner_edit applied", "owner_undo applied"]);
	});

	it("asked inside the 10 s, the challenge expires: undo closed, nothing written, no line", async () => {
		const { x, passkey, cookie, undoOp, undoBody } = await confirmedEdit();
		x.clock.advance(5_000);
		await x.assertion(passkey, cookie, undoOp);
		await walk(x, OWNER_WRITE_CHALLENGE_MS + 1);
		const late = await x.assertion(passkey, cookie, undoOp);
		const r = await x.write("POST", "/api/openviking/undo", { cookie, assertion: late, rawBody: undoBody });
		expect(errorOf(r)).toEqual([410, "UNDO_WINDOW_CLOSED", { state: "closed" }]);
		expect(contentWrites(x)).toBe(1);
		expect(x.fake.store.nodes.get(NOTE)?.content).toBe("after\n");
		expect(outcomes(x)).toEqual(["owner_edit applied"]);
	});
});
