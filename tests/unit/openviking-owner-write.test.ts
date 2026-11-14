/**
 * The owner check, writes (OI-1; Security rm-3e4885d2; spec-explorer-owner.md R-OWNER-WRITE-1/2, R-OWNER-UNDO-1):
 * no step-up window, each write (PUT note, DELETE note, POST undo, DELETE passkey) needs the session, Origin, the
 * `X-Owner-Write: 1` header and its own fresh user-verified assertion over a challenge bound to that exact op.
 * Each Security case is one test, named after it. Reads and enrollment: openviking-owner-passkey.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnerWriteListener } from "../../server/openviking/owner-check.js";
import { OWNER_WRITE_CHALLENGE_MS, type OwnerWriteOp } from "../../server/openviking/owner-session-types.js";
import { NOW } from "./openviking-daemon-fake.js";
import { settle } from "./openviking-explorer-harness.js";
import { FakePasskey } from "./openviking-owner-fakes.js";
import { expectOwnerOnly, OWNER, type OwnerHarness, ownerHarness, PI_RP, TS_RP } from "./openviking-owner-harness.js";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const q = encodeURIComponent;
const NOTE = "viking://user/qa/memories/cases/edit-me.md";
const OTHER = "viking://user/qa/memories/cases/other.md";
const OPENED_MS = NOW - 300_000;
const OPENED = new Date(OPENED_MS).toISOString();

/** A PUT as the page sends it: the exact body bytes and the op bound to them. */
function edit(content: string, o: { uri?: string; opened?: string } = {}) {
	const raw = JSON.stringify({ uri: o.uri ?? NOTE, content, opened_mod_time: o.opened ?? OPENED });
	const op: OwnerWriteOp = {
		method: "PUT",
		uri: o.uri ?? NOTE,
		opened_mod_time: o.opened ?? OPENED,
		body_sha256: sha256(raw),
	};
	return { raw, op };
}
const deleteOp = (uri: string): OwnerWriteOp => ({ method: "DELETE", uri, body_sha256: sha256("") });

const harnesses: OwnerHarness[] = [];
async function signedIn(opts: { writeListener?: OwnerWriteListener } = {}) {
	const x = await ownerHarness(opts);
	harnesses.push(x);
	x.fake.store.put(NOTE, "before\n", OPENED_MS);
	x.fake.store.put(OTHER, "other\n", OPENED_MS);
	const passkey = new FakePasskey(PI_RP.rpID);
	const cookie = await x.owned(passkey);
	/** Calls that would change the store: content/write, or any DELETE. */
	const writes = () =>
		x.fake.calls.filter((c) => c.method === "DELETE" || c.url.pathname === "/api/v1/content/write").length;
	return { x, passkey, cookie, writes };
}
afterEach(async () => {
	await Promise.all(harnesses.splice(0).map((x) => x.close()));
});

describe("owner check: each write needs its own assertion bound to its op (R-OWNER-WRITE-1/2)", () => {
	it("an edit with session, Origin, X-Owner-Write and an assertion for its op: 200", async () => {
		const { x, passkey, cookie } = await signedIn();
		const { raw, op } = edit("after\n");
		const assertion = await x.assertion(passkey, cookie, op);
		const r = await x.write("PUT", "/api/openviking/note", { cookie, assertion, rawBody: raw });
		expect(r.status).toBe(200);
		expect(x.fake.store.nodes.get(NOTE)?.content).toBe("after\n");
	});

	it("write with a valid session but no assertion -> 403 on edit, delete and undo; nothing written", async () => {
		const { x, cookie, writes } = await signedIn();
		expectOwnerOnly(await x.write("PUT", "/api/openviking/note", { cookie, rawBody: edit("after\n").raw }));
		expectOwnerOnly(await x.write("DELETE", `/api/openviking/note?uri=${q(NOTE)}`, { cookie }));
		const undo = JSON.stringify({ operation_id: "op-1-00000000" });
		expectOwnerOnly(await x.write("POST", "/api/openviking/undo", { cookie, rawBody: undo }));
		expect(writes()).toBe(0);
	});

	it("an assertion reused -> 403: the challenge is used up by its first write", async () => {
		const { x, passkey, cookie } = await signedIn();
		const { raw, op } = edit("after\n");
		const assertion = await x.assertion(passkey, cookie, op);
		expect((await x.write("PUT", "/api/openviking/note", { cookie, assertion, rawBody: raw })).status).toBe(200);
		x.fake.store.put(NOTE, "before\n", OPENED_MS);
		expectOwnerOnly(await x.write("PUT", "/api/openviking/note", { cookie, assertion, rawBody: raw }));
		expect(x.fake.store.nodes.get(NOTE)?.content).toBe("before\n");
	});

	it.each([
		["a different uri", () => edit("after\n", { uri: OTHER })],
		["a different body (sha256)", () => edit("something else\n")],
		["a different opened_mod_time", () => edit("after\n", { opened: new Date(OPENED_MS + 1000).toISOString() })],
	])("an assertion for op A replayed on op B (%s) -> 403, nothing written", async (_what, other) => {
		const { x, passkey, cookie, writes } = await signedIn();
		const assertion = await x.assertion(passkey, cookie, edit("after\n").op);
		expectOwnerOnly(await x.write("PUT", "/api/openviking/note", { cookie, assertion, rawBody: other().raw }));
		expect(writes()).toBe(0);
	});

	it("an assertion for op A replayed on op B (a different method) -> 403, nothing deleted", async () => {
		const { x, passkey, cookie, writes } = await signedIn();
		const assertion = await x.assertion(passkey, cookie, edit("after\n").op);
		expectOwnerOnly(await x.write("DELETE", `/api/openviking/note?uri=${q(NOTE)}`, { cookie, assertion }));
		const forDelete = await x.assertion(passkey, cookie, deleteOp(NOTE));
		expectOwnerOnly(
			await x.write("PUT", "/api/openviking/note", { cookie, assertion: forDelete, rawBody: edit("x").raw }),
		);
		expect(writes()).toBe(0);
	});

	it("a delete whose request carries a body its op did not cover -> 403", async () => {
		const { x, passkey, cookie } = await signedIn();
		const assertion = await x.assertion(passkey, cookie, deleteOp(NOTE));
		const r = await x.write("DELETE", `/api/openviking/note?uri=${q(NOTE)}`, { cookie, assertion, rawBody: "{}" });
		expectOwnerOnly(r);
	});

	it("a challenge older than 60 s -> 403", async () => {
		const { x, passkey, cookie } = await signedIn();
		const { raw, op } = edit("after\n");
		const assertion = await x.assertion(passkey, cookie, op);
		x.clock.advance(OWNER_WRITE_CHALLENGE_MS + 1);
		expectOwnerOnly(await x.write("PUT", "/api/openviking/note", { cookie, assertion, rawBody: raw }));
		expect(x.fake.store.nodes.get(NOTE)?.content).toBe("before\n");
	});

	it("UV=false -> 403", async () => {
		const { x, passkey, cookie } = await signedIn();
		const { raw, op } = edit("after\n");
		const assertion = await x.assertion(passkey, cookie, op, { userVerified: false });
		expectOwnerOnly(await x.write("PUT", "/api/openviking/note", { cookie, assertion, rawBody: raw }));
	});

	it("two writes need two assertions", async () => {
		const { x, passkey, cookie } = await signedIn();
		const first = edit("one\n");
		const a1 = await x.assertion(passkey, cookie, first.op);
		const r1 = await x.write("PUT", "/api/openviking/note", { cookie, assertion: a1, rawBody: first.raw });
		expect(r1.status).toBe(200);
		const second = edit("two\n", { opened: (r1.body as { mod_time: string }).mod_time });
		expectOwnerOnly(await x.write("PUT", "/api/openviking/note", { cookie, assertion: a1, rawBody: second.raw }));
		const a2 = await x.assertion(passkey, cookie, second.op);
		expect((await x.write("PUT", "/api/openviking/note", { cookie, assertion: a2, rawBody: second.raw })).status).toBe(
			200,
		);
		expect(x.fake.store.nodes.get(NOTE)?.content).toBe("two\n");
	});

	it.each([
		["a wrong Origin", { origin: "https://evil.example" }],
		["the other host's Origin", { origin: TS_RP.origin }],
		["no Origin", { origin: null }],
		["missing X-Owner-Write", { ownerWrite: null }],
		["X-Owner-Write not 1", { ownerWrite: "true" }],
	] as const)("%s -> 403, and the challenge is used up", async (_what, change) => {
		const { x, passkey, cookie } = await signedIn();
		const { raw, op } = edit("after\n");
		const assertion = await x.assertion(passkey, cookie, op);
		expectOwnerOnly(await x.write("PUT", "/api/openviking/note", { cookie, assertion, rawBody: raw, ...change }));
		expectOwnerOnly(await x.write("PUT", "/api/openviking/note", { cookie, assertion, rawBody: raw }));
		expect(x.fake.store.nodes.get(NOTE)?.content).toBe("before\n");
	});

	it("a stolen cookie with no passkey: write/options works, the write without the owner's assertion does not", async () => {
		const { x, cookie } = await signedIn();
		const thief = new FakePasskey(PI_RP.rpID);
		const { raw, op } = edit("pwned\n");
		const assertion = await x.assertion(thief, cookie, op);
		expectOwnerOnly(await x.write("PUT", "/api/openviking/note", { cookie, assertion, rawBody: raw }));
		expect(x.fake.store.nodes.get(NOTE)?.content).toBe("before\n");
	});

	it("an assertion over another session's challenge -> 403", async () => {
		const { x, passkey, cookie } = await signedIn();
		const other = x.cookieOf(await x.signIn(passkey));
		const { raw, op } = edit("after\n");
		const assertion = await x.assertion(passkey, other, op);
		expectOwnerOnly(await x.write("PUT", "/api/openviking/note", { cookie, assertion, rawBody: raw }));
	});

	it("write/options needs a session and a valid op", async () => {
		const { x, cookie } = await signedIn();
		expectOwnerOnly(await x.call("POST", `${OWNER}/write/options`, { body: { op: edit("x").op } }));
		const bad = { method: "PUT", uri: NOTE, opened_mod_time: OPENED, body_sha256: "nope" };
		expectOwnerOnly(await x.call("POST", `${OWNER}/write/options`, { cookie, body: { op: bad } }));
		const extra = { ...edit("x").op, recursive: true };
		expectOwnerOnly(await x.call("POST", `${OWNER}/write/options`, { cookie, body: { op: extra } }));
	});
});

describe("owner check: removing a passkey is a write (DELETE passkey)", () => {
	it("DELETE passkey needs its own assertion; done, it ends the passkey's sessions and tells Telegram", async () => {
		const { x, passkey, cookie } = await signedIn();
		const removeOp: OwnerWriteOp = { method: "DELETE", passkey_id: passkey.id };
		expectOwnerOnly(await x.write("DELETE", `${OWNER}/passkey?id=${q(passkey.id)}`, { cookie }));
		const assertion = await x.assertion(passkey, cookie, removeOp);
		const r = await x.write("DELETE", `${OWNER}/passkey?id=${q(passkey.id)}`, { cookie, assertion });
		expect([r.status, r.body]).toEqual([200, { removed: passkey.id }]);
		expect(x.owner.passkeyCount()).toBe(0);
		const notice = x.telegram.sent.at(-1)?.text ?? "";
		expect(notice).toContain("removed");
		expect(notice).toContain(PI_RP.rpID);
		expectOwnerOnly(await x.call("GET", "/api/openviking/tree/roots", { cookie }));
	});
});

describe("owner check: an undo asked for freezes a held delete (R-OWNER-UNDO-1)", () => {
	/** A delete the owner confirmed: held 10 s (`202`); its undo op and body. */
	async function heldDelete() {
		const s = await signedIn();
		const forDelete = await s.x.assertion(s.passkey, s.cookie, deleteOp(NOTE));
		const r = await s.x.write("DELETE", `/api/openviking/note?uri=${q(NOTE)}`, {
			cookie: s.cookie,
			assertion: forDelete,
		});
		expect(r.status).toBe(202);
		const operationId = (r.body as { operation_id: string }).operation_id;
		const undoOp: OwnerWriteOp = { method: "POST", operation_id: operationId };
		return { ...s, undoOp, undoBody: JSON.stringify({ operation_id: operationId }) };
	}
	const storeDeletes = (x: OwnerHarness) => x.fake.calls.filter((c) => c.method === "DELETE").length;

	it("not asked: the confirmed delete runs when its 10 s close", async () => {
		const { x } = await heldDelete();
		x.clock.advance(10_001);
		await settle();
		expect(storeDeletes(x)).toBe(1);
	});

	it("asked inside the 10 s and confirmed after them: the delete never runs, the undo cancels it", async () => {
		const { x, passkey, cookie, undoOp, undoBody } = await heldDelete();
		x.clock.advance(5_000);
		const assertion = await x.assertion(passkey, cookie, undoOp);
		x.clock.advance(20_000);
		await settle();
		expect(storeDeletes(x)).toBe(0);
		const r = await x.write("POST", "/api/openviking/undo", { cookie, assertion, rawBody: undoBody });
		expect([r.status, (r.body as { state: string }).state]).toEqual([200, "cancelled"]);
		x.clock.advance(OWNER_WRITE_CHALLENGE_MS);
		await settle();
		expect(storeDeletes(x)).toBe(0);
	});

	it("asked and never confirmed: the 60 s run out, the delete is cancelled, never run", async () => {
		const { x, passkey, cookie, undoOp, undoBody } = await heldDelete();
		await x.assertion(passkey, cookie, undoOp);
		x.clock.advance(OWNER_WRITE_CHALLENGE_MS + 1);
		await settle();
		expect(storeDeletes(x)).toBe(0);
		const late = await x.assertion(passkey, cookie, undoOp);
		const r = await x.write("POST", "/api/openviking/undo", { cookie, assertion: late, rawBody: undoBody });
		const error = (r.body as { error: { code: string; details: unknown } }).error;
		expect([r.status, error.code, error.details]).toEqual([410, "UNDO_WINDOW_CLOSED", { state: "cancelled" }]);
	});

	it("an undo whose assertion fails leaves the delete frozen, and a retry inside the 60 s cancels it", async () => {
		const { x, passkey, cookie, undoOp, undoBody } = await heldDelete();
		const failed = await x.assertion(passkey, cookie, undoOp, { userVerified: false });
		expectOwnerOnly(await x.write("POST", "/api/openviking/undo", { cookie, assertion: failed, rawBody: undoBody }));
		x.clock.advance(15_000);
		await settle();
		expect(storeDeletes(x)).toBe(0);
		const retry = await x.assertion(passkey, cookie, undoOp);
		const r = await x.write("POST", "/api/openviking/undo", { cookie, assertion: retry, rawBody: undoBody });
		expect([r.status, (r.body as { state: string }).state]).toEqual([200, "cancelled"]);
	});
});

describe("owner check: the undo ask reaches the writes (R-OWNER-UNDO-1)", () => {
	const undoOp: OwnerWriteOp = { method: "POST", operation_id: "op-1794631805120-3f9a1c2e" };

	it("write/options for an undo tells the writes it was asked, until the challenge's end; other ops do not", async () => {
		const listener = { undoAsked: vi.fn() };
		const { x, passkey, cookie } = await signedIn({ writeListener: listener });
		const untilMs = x.clock.now() + OWNER_WRITE_CHALLENGE_MS;
		await x.assertion(passkey, cookie, undoOp);
		expect(listener.undoAsked).toHaveBeenCalledExactlyOnceWith(undoOp.operation_id, untilMs);
		await x.assertion(passkey, cookie, edit("x").op);
		expect(listener.undoAsked).toHaveBeenCalledTimes(1);
	});

	it("write/options for an undo the writes refuse to freeze still answers a challenge (the undo answers why)", async () => {
		const listener = {
			undoAsked: vi.fn(() => {
				throw new Error("window closed");
			}),
		};
		const { x, cookie } = await signedIn({ writeListener: listener });
		const r = await x.call("POST", `${OWNER}/write/options`, { cookie, body: { op: undoOp } });
		expect(r.status).toBe(200);
	});
});
