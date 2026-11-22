/**
 * The owner check, Security's follow-ups (backend #170; rm-b52897e2 L1, L2; rm-638da86a):
 * - L1, R-OWNER-GATE-1 "before anything else": a write without its passkey assertion answers the one `403 OWNER_ONLY`
 *   body before it parses a uri, checks a body or calls the daemon, so it cannot learn whether its input is valid.
 *   Reads are open since Ops #1080 (owner Shine 2026-11-22, dr-c54a3286d823): invalid read input is a plain 400.
 * - A Host or Origin whose host ends in "." never passes the owner and explorer routes.
 * - L2: the enrollment code's Telegram text names the host it is for and warns that an unrequested code came from
 *   someone else.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { OwnerRelyingParty, OwnerWriteOp } from "../../server/openviking/owner-session-types.js";
import { NOW } from "./openviking-daemon-fake.js";
import { FakePasskey } from "./openviking-owner-fakes.js";
import {
	expectOwnerOnly,
	OWNER,
	type OwnerHarness,
	type OwnerReply,
	ownerHarness,
	PI_RP,
	TS_RP,
} from "./openviking-owner-harness.js";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const q = encodeURIComponent;
const ROOT = "viking://user/qa/memories";
const NOTE = `${ROOT}/cases/edit-me.md`;
const OPENED_MS = NOW - 300_000;
const OPENED = new Date(OPENED_MS).toISOString();
const DOTTED_ORIGINS = ["https://pi.wai2shine.com.", "https://spark.tailbb5055.ts.net.:8787"];

const harnesses: OwnerHarness[] = [];
afterEach(async () => {
	await Promise.all(harnesses.splice(0).map((x) => x.close()));
});

/** A server with the owner's passkey enrolled, and a note to change. */
async function signedIn(rp: OwnerRelyingParty = PI_RP) {
	const x = await ownerHarness();
	harnesses.push(x);
	x.fake.store.put(NOTE, "before\n", OPENED_MS);
	const passkey = new FakePasskey(rp.rpID);
	await x.owned(passkey);
	x.fake.calls.length = 0;
	const writes = () =>
		x.fake.calls.filter((c) => c.method === "DELETE" || c.url.pathname === "/api/v1/content/write").length;
	return { x, passkey, writes };
}

const expectBadRequest = (r: OwnerReply, code: string) => {
	expect([r.status, (r.body as { error: { code: string } }).error.code]).toEqual([400, code]);
};

/** Each read with invalid input, and the 400 code it gets. */
const BAD_READS: [string, string, string, unknown?][] = [
	["tree, a uri under no root", "GET", `/api/openviking/tree?uri=${q("viking://user/memories")}`],
	["tree, a bad limit", "GET", `/api/openviking/tree?uri=${q(ROOT)}&limit=999`],
	["note, a uri that is not one", "GET", "/api/openviking/note?uri=%zz&level=full"],
	["note, a bad level", "GET", `/api/openviking/note?uri=${q(NOTE)}&level=nope`],
	["search, a bad body", "POST", "/api/openviking/search", { mode: "nope", query: "q", roots: [ROOT] }],
	["search, an unknown root", "POST", "/api/openviking/search", { mode: "exact", query: "q", roots: ["viking://x"] }],
];
const BAD_READ_CODES = [
	"URI_OUTSIDE_ROOTS",
	"INVALID_ARGUMENT",
	"URI_INVALID",
	"LEVEL_INVALID",
	"SEARCH_INVALID",
	"ROOT_UNKNOWN",
];

describe("L1: the owner gate runs before any validation (R-OWNER-GATE-1)", () => {
	it("invalid reads, no session: 400 with the input's own code, nothing sent (reads are open)", async () => {
		const { x } = await signedIn();
		const codes: string[] = [];
		for (const [, method, path, body] of BAD_READS) {
			const r = await x.call(method, path, { body });
			expect(r.status).toBe(400);
			codes.push((r.body as { error: { code: string } }).error.code);
		}
		expect(codes).toEqual(BAD_READ_CODES);
		expect(x.fake.calls).toEqual([]);
	});

	it("identity.md with no session: 403 SETUP_FILE_LOCKED (G8 holds for open reads), nothing sent", async () => {
		const { x } = await signedIn();
		const path = `/api/openviking/note?uri=${q(`${ROOT}/identity.md`)}&level=full`;
		const locked = await x.call("GET", path);
		expect([locked.status, (locked.body as { error: { code: string } }).error.code]).toEqual([
			403,
			"SETUP_FILE_LOCKED",
		]);
		expect(x.fake.calls).toEqual([]);
	});

	it("no assertion + invalid writes (PUT bad body, DELETE bad uri, undo bad id): 403 OWNER_ONLY, nothing sent", async () => {
		const { x } = await signedIn();
		const write = (method: string, path: string, rawBody?: string) =>
			x.call(method, path, { rawBody, headers: { "X-Owner-Write": "1" } });
		expectOwnerOnly(await write("PUT", "/api/openviking/note", JSON.stringify({ uri: "viking://nope", content: 5 })));
		expectOwnerOnly(await write("PUT", "/api/openviking/note", JSON.stringify({ uri: NOTE })));
		expectOwnerOnly(await write("DELETE", "/api/openviking/note?uri=%zz"));
		expectOwnerOnly(await write("DELETE", `/api/openviking/note?uri=${q("viking://user/memories")}`));
		expectOwnerOnly(await write("POST", "/api/openviking/undo", JSON.stringify({ operation_id: "../x" })));
		expectOwnerOnly(await write("POST", "/api/openviking/undo", "{}"));
		expect(x.fake.calls).toEqual([]);
	});

	it("a confirmed edit whose body is invalid: 400 EDIT_INVALID, nothing written", async () => {
		const { x, passkey, writes } = await signedIn();
		const raw = JSON.stringify({ uri: NOTE, content: 5, opened_mod_time: OPENED });
		const op: OwnerWriteOp = { method: "PUT", uri: NOTE, opened_mod_time: OPENED, body_sha256: sha256(raw) };
		const assertion = await x.assertion(passkey, op);
		expectBadRequest(await x.write("PUT", "/api/openviking/note", { assertion, rawBody: raw }), "EDIT_INVALID");
		expect(writes()).toBe(0);
	});
});

describe("a host ending in a dot never passes (rm-638da86a)", () => {
	it.each(DOTTED_ORIGINS)(
		"Origin %s on a confirmed PUT note, DELETE note and undo: 403, nothing written",
		async (origin) => {
			const { x, passkey, writes } = await signedIn();
			const raw = JSON.stringify({ uri: NOTE, content: "after\n", opened_mod_time: OPENED });
			const put: OwnerWriteOp = { method: "PUT", uri: NOTE, opened_mod_time: OPENED, body_sha256: sha256(raw) };
			const putAssertion = await x.assertion(passkey, put);
			expectOwnerOnly(await x.write("PUT", "/api/openviking/note", { assertion: putAssertion, rawBody: raw, origin }));
			const del: OwnerWriteOp = { method: "DELETE", uri: NOTE, body_sha256: sha256("") };
			const delAssertion = await x.assertion(passkey, del);
			expectOwnerOnly(
				await x.write("DELETE", `/api/openviking/note?uri=${q(NOTE)}`, { assertion: delAssertion, origin }),
			);
			const undoRaw = JSON.stringify({ operation_id: "op-1-00000000" });
			const undo: OwnerWriteOp = { method: "POST", operation_id: "op-1-00000000" };
			const undoAssertion = await x.assertion(passkey, undo);
			expectOwnerOnly(
				await x.write("POST", "/api/openviking/undo", { assertion: undoAssertion, rawBody: undoRaw, origin }),
			);
			expect(writes()).toBe(0);
			expect(x.fake.store.nodes.get(NOTE)?.content).toBe("before\n");
		},
	);

	it.each(DOTTED_ORIGINS)("Origin %s on a read: 403", async (origin) => {
		const { x } = await signedIn();
		expect((await x.call("GET", `/api/openviking/tree?uri=${q(ROOT)}`)).status).toBe(200);
		expectOwnerOnly(await x.call("GET", `/api/openviking/tree?uri=${q(ROOT)}`, { origin }));
	});

	it.each([
		["pi.wai2shine.com.", PI_RP],
		["spark.tailbb5055.ts.net.:8787", TS_RP],
	] as const)("Host %s on write/options, GET passkeys and tree: 403", async (host, rp) => {
		const { x } = await signedIn(rp);
		const origin = rp.origin;
		const okHost = host.replace(/\.(:|$)/, "$1");
		const op: OwnerWriteOp = { method: "DELETE", uri: NOTE, body_sha256: sha256("") };
		const ask = (h: string) =>
			x.call("POST", `${OWNER}/write/options`, { origin, host: h, body: { op }, headers: { "X-Owner-Write": "1" } });
		expect((await ask(okHost)).status).toBe(200);
		expectOwnerOnly(await ask(host));
		expect((await x.call("GET", `${OWNER}/passkeys`, { origin, host: okHost })).status).toBe(200);
		expectOwnerOnly(await x.call("GET", `${OWNER}/passkeys`, { origin, host }));
		const tree = `/api/openviking/tree?uri=${q(ROOT)}`;
		expect((await x.call("GET", tree, { origin: null, host: okHost })).status).toBe(200);
		expectOwnerOnly(await x.call("GET", tree, { origin: null, host }));
		expectOwnerOnly(await x.call("GET", "/api/openviking/tree/roots", { origin: null, host }));
	});
});

describe("L2: the enrollment code says which host it is for and what an unasked code means", () => {
	it.each([PI_RP, TS_RP])("the code for $rpID names the host and carries the warning", async (rp) => {
		const x = await ownerHarness();
		harnesses.push(x);
		expect((await x.call("POST", `${OWNER}/passkey/code`, { origin: rp.origin, body: {} })).status).toBe(202);
		const text = x.telegram.sent.at(-1)?.text ?? "";
		expect(text).toContain(x.telegram.lastCode());
		expect(text).toContain(`Only enter this on ${rp.rpID}`);
		expect(text).toContain("If you didn't ask for a code, someone else did: ignore it");
		const other = rp === PI_RP ? TS_RP : PI_RP;
		expect(text).not.toContain(other.rpID);
	});
});
