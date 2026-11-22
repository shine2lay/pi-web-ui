/**
 * Ops #1080 (owner Shine 2026-11-22, dr-c54a3286d823: "Remove sign-in only, keep for edits"; spec-explorer-owner.md
 * R-OWNER-READ-2, R-OWNER-WRITE-1/2): every explorer read answers with no session or cookie, the session routes are
 * gone, every write still needs its own passkey assertion bound to its op, and `GET owner/passkeys` lists this host's
 * passkeys without their public keys.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { OwnerWriteOp } from "../../server/openviking/owner-session-types.js";
import { NOW } from "./openviking-daemon-fake.js";
import { FakePasskey } from "./openviking-owner-fakes.js";
import { expectOwnerOnly, OWNER, type OwnerHarness, ownerHarness, PI_RP, TS_RP } from "./openviking-owner-harness.js";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const q = encodeURIComponent;
const ROLE_ROOT = "viking://user/qa/memories";
const NOTE = "viking://user/qa/memories/cases/edit-me.md";
const OPENED_MS = NOW - 300_000;
const OPENED = new Date(OPENED_MS).toISOString();
const PI_HOST = new URL(PI_RP.origin).host;
const TS_HOST = new URL(TS_RP.origin).host;

const READS: [string, string, unknown][] = [
	["GET", "/api/openviking/tree/roots", undefined],
	["GET", `/api/openviking/tree?uri=${q(ROLE_ROOT)}`, undefined],
	["GET", `/api/openviking/note?uri=${q(NOTE)}&level=full`, undefined],
	["POST", "/api/openviking/search", { mode: "exact", query: "before", roots: [ROLE_ROOT] }],
	["GET", "/api/openviking/audit?owner_only=true", undefined],
];

const harnesses: OwnerHarness[] = [];
async function harness(): Promise<OwnerHarness> {
	const x = await ownerHarness();
	harnesses.push(x);
	x.fake.store.put(NOTE, "before\n", OPENED_MS);
	return x;
}
afterEach(async () => {
	await Promise.all(harnesses.splice(0).map((x) => x.close()));
});

function edit(content: string) {
	const raw = JSON.stringify({ uri: NOTE, content, opened_mod_time: OPENED });
	const op: OwnerWriteOp = { method: "PUT", uri: NOTE, opened_mod_time: OPENED, body_sha256: sha256(raw) };
	return { raw, op };
}

describe("reads are open: no session, no cookie (R-OWNER-READ-2)", () => {
	it.each([0, 1])("with %i passkeys enrolled, all 5 read routes answer 200 with no cookie and set none", async (n) => {
		const x = await harness();
		if (n) await x.owned(new FakePasskey(PI_RP.rpID));
		for (const [method, path, body] of READS) {
			const r = await x.call(method, path, { body });
			expect([method, path, r.status]).toEqual([method, path, 200]);
			expect(r.setCookie).toBeNull();
		}
		const audit = await x.call("GET", "/api/openviking/audit");
		expect((audit.body as { owner_events: string }).owner_events).toBe("included");
	});

	it("reads answer with no Origin too (a same-origin GET sends none)", async () => {
		const x = await harness();
		expect((await x.call("GET", `/api/openviking/note?uri=${q(NOTE)}&level=full`, { origin: null })).status).toBe(200);
	});

	it.each([
		["a trailing-dot Host", { host: "pi.wai2shine.com." }],
		["a malformed Host", { host: "pi.wai2shine.com:bad" }],
		["a trailing-dot Origin", { origin: "https://pi.wai2shine.com." }],
		["a malformed Origin", { origin: "not a url" }],
	] as const)("%s -> 403 OWNER_ONLY on every read, nothing reaches the store", async (_what, change) => {
		const x = await harness();
		const before = x.fake.calls.length;
		for (const [method, path, body] of READS.slice(0, 4))
			expectOwnerOnly(await x.call(method, path, { body, ...change }));
		expect(x.fake.calls.length).toBe(before);
	});
});

describe("the session routes are gone (Rule 23)", () => {
	it.each(["session/options", "session/verify", "session/logout"])("POST %s -> 404", async (route) => {
		const x = await harness();
		await x.owned(new FakePasskey(PI_RP.rpID));
		const r = await x.call("POST", `${OWNER}/${route}`, { body: {} });
		expect(r.status).toBe(404);
		expect(r.setCookie).toBeNull();
	});
});

describe("writes still need a fresh passkey assertion bound to their op (R-OWNER-WRITE-1/2)", () => {
	it("no assertion -> 403 on edit, delete, undo and passkey removal; nothing written", async () => {
		const x = await harness();
		const passkey = new FakePasskey(PI_RP.rpID);
		await x.owned(passkey);
		expectOwnerOnly(await x.write("PUT", "/api/openviking/note", { rawBody: edit("after\n").raw }));
		expectOwnerOnly(await x.write("DELETE", `/api/openviking/note?uri=${q(NOTE)}`));
		expectOwnerOnly(
			await x.write("POST", "/api/openviking/undo", { rawBody: JSON.stringify({ operation_id: "op-1-00000000" }) }),
		);
		expectOwnerOnly(await x.write("DELETE", `${OWNER}/passkey?id=${q(passkey.id)}`));
		expect(x.fake.store.nodes.get(NOTE)?.content).toBe("before\n");
		expect(x.owner.passkeyCount()).toBe(1);
	});

	it("an edit with an assertion for its op and no cookie at all: 200", async () => {
		const x = await harness();
		const passkey = new FakePasskey(PI_RP.rpID);
		await x.owned(passkey);
		const { raw, op } = edit("after\n");
		const r = await x.write("PUT", "/api/openviking/note", { assertion: await x.assertion(passkey, op), rawBody: raw });
		expect(r.status).toBe(200);
		expect(x.fake.store.nodes.get(NOTE)?.content).toBe("after\n");
	});

	it("an assertion from a passkey that isn't enrolled -> 403", async () => {
		const x = await harness();
		await x.owned(new FakePasskey(PI_RP.rpID));
		const { raw, op } = edit("pwned\n");
		const assertion = await x.assertion(new FakePasskey(PI_RP.rpID), op);
		expectOwnerOnly(await x.write("PUT", "/api/openviking/note", { assertion, rawBody: raw }));
		expect(x.fake.store.nodes.get(NOTE)?.content).toBe("before\n");
	});

	it("a challenge asked on one host and used on the other -> 403", async () => {
		const x = await harness();
		const passkey = new FakePasskey(PI_RP.rpID);
		await x.owned(passkey);
		await x.owned(new FakePasskey(TS_RP.rpID));
		const { raw, op } = edit("after\n");
		const assertion = await x.assertion(passkey, op);
		expectOwnerOnly(await x.write("PUT", "/api/openviking/note", { assertion, rawBody: raw, origin: TS_RP.origin }));
	});

	it("write/options needs X-Owner-Write: 1, an exact Origin, a valid op and a passkey on the host", async () => {
		const x = await harness();
		const ask = (headers: Record<string, string>, origin?: string | null) =>
			x.call("POST", `${OWNER}/write/options`, { body: { op: edit("x").op }, headers, origin });
		expectOwnerOnly(await ask({ "X-Owner-Write": "1" }));
		await x.owned(new FakePasskey(PI_RP.rpID));
		expect((await ask({ "X-Owner-Write": "1" })).status).toBe(200);
		expectOwnerOnly(await ask({}));
		expectOwnerOnly(await ask({ "X-Owner-Write": "1" }, "https://evil.example"));
		expectOwnerOnly(await ask({ "X-Owner-Write": "1" }, null));
		expectOwnerOnly(await ask({ "X-Owner-Write": "1" }, TS_RP.origin));
		const bad = { method: "PUT", uri: NOTE, opened_mod_time: OPENED, body_sha256: "nope" };
		expectOwnerOnly(
			await x.call("POST", `${OWNER}/write/options`, { body: { op: bad }, headers: { "X-Owner-Write": "1" } }),
		);
	});
});

describe("GET owner/passkeys: this host's passkeys, public info only", () => {
	it("lists id, rp_id and created_at per host, never a public key or counter", async () => {
		const x = await harness();
		const pi = new FakePasskey(PI_RP.rpID);
		await x.owned(pi);
		const empty = await x.call("GET", `${OWNER}/passkeys`, { origin: TS_RP.origin });
		expect([empty.status, empty.body]).toEqual([200, { rp_id: TS_RP.rpID, passkeys: [] }]);
		const r = await x.call("GET", `${OWNER}/passkeys`);
		expect(r.status).toBe(200);
		const body = r.body as { rp_id: string; passkeys: Record<string, unknown>[] };
		expect(body.rp_id).toBe(PI_RP.rpID);
		expect(body.passkeys.map((p) => Object.keys(p).sort())).toEqual([["created_at", "id", "rp_id"]]);
		expect(body.passkeys[0]).toMatchObject({ id: pi.id, rp_id: PI_RP.rpID });
		expect(r.text).not.toMatch(/public_key|counter/);
	});

	it("with no Origin, the Host names the host", async () => {
		const x = await harness();
		await x.owned(new FakePasskey(TS_RP.rpID));
		const r = await x.call("GET", `${OWNER}/passkeys`, { origin: null, host: TS_HOST });
		expect([r.status, (r.body as { rp_id: string }).rp_id]).toEqual([200, TS_RP.rpID]);
		expect((await x.call("GET", `${OWNER}/passkeys`, { origin: null, host: PI_HOST })).status).toBe(200);
	});

	it.each([
		["a foreign Origin", { origin: "https://evil.example" }],
		["no Origin and an unknown Host", { origin: null, host: "evil.example" }],
		["a trailing-dot Host", { origin: null, host: "pi.wai2shine.com." }],
	] as const)("%s -> 403 OWNER_ONLY", async (_what, change) => {
		const x = await harness();
		await x.owned(new FakePasskey(PI_RP.rpID));
		expectOwnerOnly(await x.call("GET", `${OWNER}/passkeys`, change));
	});
});
