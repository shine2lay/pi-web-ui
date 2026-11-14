/**
 * The owner check, reads and enrollment (OI-1; Security rm-8841fede as amended by rm-3e4885d2; spec-explorer-owner.md
 * R-OWNER-READ-1, R-OWNER-REFUSE-1). Each Security case is one test, named after it. Writes: openviking-owner-write.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OWNER_CODE_WORDS } from "../../server/openviking/owner-enroll-code.js";
import {
	OWNER_ENROLL_CODE_MS,
	OWNER_ONLY_BODY,
	OWNER_SESSION_IDLE_MS,
	OWNER_SESSION_MAX_MS,
} from "../../server/openviking/owner-session-types.js";
import { FakePasskey } from "./openviking-owner-fakes.js";
import { expectOwnerOnly, OWNER, type OwnerHarness, ownerHarness, PI_RP, TS_RP } from "./openviking-owner-harness.js";

const ROLE_ROOT = "viking://user/qa/memories";
const ROLE_NOTE = "viking://user/qa/memories/cases/c1.md";
const SHARED_NOTE = "viking://resources/pi-web-ui/README.md";
const q = encodeURIComponent;
const REFUSAL = JSON.stringify(OWNER_ONLY_BODY);

/** The 7 explorer routes as the page calls them (writes without an assertion). */
const EXPLORER_ROUTES: [string, string, unknown][] = [
	["GET", "/api/openviking/tree/roots", undefined],
	["GET", `/api/openviking/tree?uri=${q(ROLE_ROOT)}`, undefined],
	["GET", `/api/openviking/note?uri=${q(ROLE_NOTE)}&level=full`, undefined],
	["POST", "/api/openviking/search", { mode: "exact", query: "case", roots: [ROLE_ROOT] }],
	["PUT", "/api/openviking/note", { uri: SHARED_NOTE, content: "x", opened_mod_time: "2026-01-01T00:00:00.000Z" }],
	["DELETE", `/api/openviking/note?uri=${q(SHARED_NOTE)}`, undefined],
	["POST", "/api/openviking/undo", { operation_id: "op-1-00000000" }],
];

async function expectAllRoutesRefuse(x: OwnerHarness, call: { cookie?: string; headers?: Record<string, string> }) {
	const before = x.fake.calls.length;
	for (const [method, path, body] of EXPLORER_ROUTES) {
		const headers = method === "GET" ? call.headers : { "X-Owner-Write": "1", ...call.headers };
		expectOwnerOnly(await x.call(method, path, { body, cookie: call.cookie, headers }));
	}
	expect(x.fake.calls.length).toBe(before);
}

const read = (x: OwnerHarness, cookie: string | undefined, headers?: Record<string, string>) =>
	x.call("GET", `/api/openviking/note?uri=${q(ROLE_NOTE)}&level=full`, { cookie, headers });

const harnesses: OwnerHarness[] = [];
async function harness(): Promise<OwnerHarness> {
	const x = await ownerHarness();
	harnesses.push(x);
	return x;
}
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(harnesses.splice(0).map((x) => x.close()));
});

describe("owner check: reads need a passkey owner session (R-OWNER-READ-1)", () => {
	it("no cookie -> 403 OWNER_ONLY on all 7 explorer routes, nothing reaches the store", async () => {
		const x = await harness();
		await x.owned(new FakePasskey(PI_RP.rpID));
		await expectAllRoutesRefuse(x, {});
	});

	it("a forged session cookie -> 403 on all 7 routes", async () => {
		const x = await harness();
		await x.owned(new FakePasskey(PI_RP.rpID));
		await expectAllRoutesRefuse(x, { cookie: `pi_owner_session=${Buffer.alloc(32, 7).toString("base64url")}` });
	});

	it("with a session, role-root tree, note and search answer 200 (and tree/roots)", async () => {
		const x = await harness();
		const cookie = await x.owned(new FakePasskey(PI_RP.rpID));
		expect((await x.call("GET", "/api/openviking/tree/roots", { cookie })).status).toBe(200);
		expect((await x.call("GET", `/api/openviking/tree?uri=${q(ROLE_ROOT)}`, { cookie })).status).toBe(200);
		expect((await read(x, cookie)).status).toBe(200);
		const search = await x.call("POST", "/api/openviking/search", {
			cookie,
			body: { mode: "exact", query: "case", roots: [ROLE_ROOT] },
		});
		expect(search.status).toBe(200);
	});

	it("the session cookie is HttpOnly; Secure; SameSite=Strict; Path=/api/openviking with a 256-bit random id", async () => {
		const x = await harness();
		const pk = new FakePasskey(PI_RP.rpID);
		await x.enroll(pk);
		const r = await x.signIn(pk);
		expect(r.status).toBe(200);
		const attrs = (r.setCookie ?? "").split(";").map((a) => a.trim());
		expect(attrs[0]).toMatch(/^pi_owner_session=[A-Za-z0-9_-]{43}$/);
		expect(attrs).toEqual(expect.arrayContaining(["HttpOnly", "Secure", "SameSite=Strict", "Path=/api/openviking"]));
		expect(r.text).not.toContain(attrs[0].split("=")[1]);
	});

	it("an old session: idle 15 min -> 403", async () => {
		const x = await harness();
		const cookie = await x.owned(new FakePasskey(PI_RP.rpID));
		x.clock.advance(OWNER_SESSION_IDLE_MS - 1000);
		expect((await read(x, cookie)).status).toBe(200);
		x.clock.advance(OWNER_SESSION_IDLE_MS + 1);
		expectOwnerOnly(await read(x, cookie));
	});

	it("an expired session: kept busy, it still ends at 4 h -> 403", async () => {
		const x = await harness();
		const cookie = await x.owned(new FakePasskey(PI_RP.rpID));
		for (let t = 0; t + 10 * 60_000 <= OWNER_SESSION_MAX_MS; t += 10 * 60_000) {
			expect((await read(x, cookie)).status).toBe(200);
			x.clock.advance(10 * 60_000);
		}
		x.clock.advance(1);
		expectOwnerOnly(await read(x, cookie));
	});

	it("no session + Tailscale-User-Login -> 403; with a session the header changes nothing", async () => {
		const x = await harness();
		const cookie = await x.owned(new FakePasskey(PI_RP.rpID));
		const tailscale = { "Tailscale-User-Login": "owner@example.com", "Tailscale-User-Name": "Owner" };
		await expectAllRoutesRefuse(x, { headers: tailscale });
		expect((await read(x, cookie, tailscale)).status).toBe(200);
	});

	it("PI_WEB_TOKEN set + no session -> 403, with the token in a header, the query or its cookie", async () => {
		vi.stubEnv("PI_WEB_TOKEN", "owner-token-123");
		const x = await harness();
		await x.owned(new FakePasskey(PI_RP.rpID));
		await expectAllRoutesRefuse(x, { headers: { Authorization: "Bearer owner-token-123" } });
		await expectAllRoutesRefuse(x, { headers: { "X-PI-Token": "owner-token-123" } });
		await expectAllRoutesRefuse(x, { cookie: "pi_web_token=owner-token-123" });
		expectOwnerOnly(await x.call("GET", `/api/openviking/note?uri=${q(ROLE_NOTE)}&level=full&token=owner-token-123`));
	});

	it("zero passkeys -> 403 everywhere: no session opens, every explorer route refuses", async () => {
		const x = await harness();
		expectOwnerOnly(await x.call("POST", `${OWNER}/session/options`, { body: {} }));
		expectOwnerOnly(
			await x.call("POST", `${OWNER}/write/options`, {
				body: { op: { method: "POST", operation_id: "op-1-00000000" } },
			}),
		);
		await expectAllRoutesRefuse(x, {});
		await expectAllRoutesRefuse(x, { cookie: `pi_owner_session=${"A".repeat(43)}` });
	});

	it("restart -> 403: sessions live in memory only", async () => {
		const x = await harness();
		const cookie = await x.owned(new FakePasskey(PI_RP.rpID));
		expect((await read(x, cookie)).status).toBe(200);
		const y = await x.restart();
		harnesses.push(y);
		await expectAllRoutesRefuse(y, { cookie });
	});

	it("logout ends the session and clears the cookie", async () => {
		const x = await harness();
		const cookie = await x.owned(new FakePasskey(PI_RP.rpID));
		const out = await x.call("POST", `${OWNER}/session/logout`, { cookie, body: {} });
		expect(out.status).toBe(200);
		expect(out.setCookie).toMatch(/^pi_owner_session=;/);
		expectOwnerOnly(await read(x, cookie));
	});

	it("a passkey belongs to its host: no session opens on the other host, a foreign Origin is refused", async () => {
		const x = await harness();
		await x.owned(new FakePasskey(PI_RP.rpID));
		expectOwnerOnly(await x.call("POST", `${OWNER}/session/options`, { origin: TS_RP.origin, body: {} }));
		expectOwnerOnly(await x.call("POST", `${OWNER}/session/options`, { origin: "https://evil.example", body: {} }));
		expectOwnerOnly(await x.call("POST", `${OWNER}/session/options`, { origin: null, body: {} }));
		const ts = new FakePasskey(TS_RP.rpID);
		expect((await x.signIn(ts)).status).toBe(403);
		expect(await x.owned(ts)).toMatch(/^pi_owner_session=/);
	});

	it("sign-in with UV=false -> 403 and no cookie", async () => {
		const x = await harness();
		const pk = new FakePasskey(PI_RP.rpID);
		await x.enroll(pk);
		const r = await x.signIn(pk, { userVerified: false });
		expectOwnerOnly(r);
		expect(r.setCookie).toBeNull();
	});

	it("a sign-in challenge works once", async () => {
		const x = await harness();
		const pk = new FakePasskey(PI_RP.rpID);
		await x.enroll(pk);
		const options = await x.call("POST", `${OWNER}/session/options`, { body: {} });
		const b = options.body as { challenge_id: string; options: { challenge: string } };
		const body = { challenge_id: b.challenge_id, response: pk.assert(b.options, { origin: PI_RP.origin }) };
		expect((await x.call("POST", `${OWNER}/session/verify`, { body })).status).toBe(200);
		expectOwnerOnly(await x.call("POST", `${OWNER}/session/verify`, { body }));
	});

	it("options and verify calls are rate limited to 10 a minute", async () => {
		const x = await harness();
		await x.owned(new FakePasskey(PI_RP.rpID));
		for (let i = 0; i < 9; i++)
			expect((await x.call("POST", `${OWNER}/session/options`, { body: {} })).status).toBe(200);
		expectOwnerOnly(await x.call("POST", `${OWNER}/session/options`, { body: {} }));
		x.clock.advance(60_000);
		expect((await x.call("POST", `${OWNER}/session/options`, { body: {} })).status).toBe(200);
	});
});

describe("owner check: enrollment by a code sent only to the owner's Telegram", () => {
	it("passkey/code sends a 7-word code to Telegram only; the response never contains it", async () => {
		const x = await harness();
		const r = await x.call("POST", `${OWNER}/passkey/code`, { body: {} });
		expect(r.status).toBe(202);
		expect(Object.keys(r.body as object).sort()).toEqual(["expires_at", "rp_id", "sent"]);
		const code = x.telegram.lastCode();
		expect(code.split(" ")).toHaveLength(7);
		for (const w of code.split(" ")) expect(OWNER_CODE_WORDS).toContain(w);
		expect(r.text).not.toContain(code);
	});

	it("enroll with no code / a wrong code -> refused", async () => {
		const x = await harness();
		await x.call("POST", `${OWNER}/passkey/code`, { body: {} });
		expectOwnerOnly(await x.call("POST", `${OWNER}/passkey/enroll/options`, { body: {} }));
		expectOwnerOnly(await x.call("POST", `${OWNER}/passkey/enroll/options`, { body: { code: "acid acorn actor" } }));
		expect(x.owner.passkeyCount()).toBe(0);
	});

	it("enroll with a reused code -> refused", async () => {
		const x = await harness();
		await x.call("POST", `${OWNER}/passkey/code`, { body: {} });
		const code = x.telegram.lastCode();
		expect((await x.call("POST", `${OWNER}/passkey/enroll/options`, { body: { code } })).status).toBe(200);
		expectOwnerOnly(await x.call("POST", `${OWNER}/passkey/enroll/options`, { body: { code } }));
	});

	it("enroll with a code older than 10 min -> refused", async () => {
		const x = await harness();
		await x.call("POST", `${OWNER}/passkey/code`, { body: {} });
		x.clock.advance(OWNER_ENROLL_CODE_MS + 1);
		expectOwnerOnly(await x.call("POST", `${OWNER}/passkey/enroll/options`, { body: { code: x.telegram.lastCode() } }));
	});

	it.each(["refused", "maybe_sent", "throws"] as const)(
		"enroll with a code whose Telegram delivery failed (%s) -> refused",
		async (mode) => {
			const x = await harness();
			x.telegram.state.mode = mode;
			expectOwnerOnly(await x.call("POST", `${OWNER}/passkey/code`, { body: {} }));
			x.telegram.state.mode = "ok";
			const code = x.telegram.lastCode();
			expectOwnerOnly(await x.call("POST", `${OWNER}/passkey/enroll/options`, { body: { code } }));
		},
	);

	it("enroll with UV=false -> refused, nothing stored", async () => {
		const x = await harness();
		expectOwnerOnly(await x.enroll(new FakePasskey(PI_RP.rpID), { userVerified: false }));
		expect(x.owner.passkeyCount()).toBe(0);
	});

	it("an enrolled passkey: public key only, file 0600, and a Telegram notice with host and time", async () => {
		const x = await harness();
		const pk = new FakePasskey(PI_RP.rpID);
		const r = await x.enroll(pk);
		expect(r.status).toBe(201);
		const path = join(x.dataDir, "owner-passkeys.json");
		expect(statSync(path).mode & 0o777).toBe(0o600);
		const file = JSON.parse(readFileSync(path, "utf8"));
		expect(file.passkeys).toHaveLength(1);
		expect(Object.keys(file.passkeys[0]).sort()).toEqual([
			"counter",
			"created_at",
			"id",
			"public_key",
			"rp_id",
			"transports",
		]);
		expect(file.passkeys[0]).toMatchObject({ id: pk.id, rp_id: PI_RP.rpID });
		const notice = x.telegram.sent.at(-1)?.text ?? "";
		expect(notice).toContain("added");
		expect(notice).toContain(PI_RP.rpID);
		expect(notice).toContain(new Date(x.clock.now()).toISOString().slice(0, 16));
		expect(readdirSync(x.dataDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	it("passkey/code is rate limited: a 4th code within 10 min -> refused, nothing sent", async () => {
		const x = await harness();
		for (let i = 0; i < 3; i++) expect((await x.call("POST", `${OWNER}/passkey/code`, { body: {} })).status).toBe(202);
		const sent = x.telegram.sent.length;
		expectOwnerOnly(await x.call("POST", `${OWNER}/passkey/code`, { body: {} }));
		expect(x.telegram.sent.length).toBe(sent);
	});

	it("the code value is absent from logs, responses and files", async () => {
		const x = await harness();
		const codes: string[] = [];
		await x.call("POST", `${OWNER}/passkey/code`, { body: {} });
		codes.push(x.telegram.lastCode());
		await x.call("POST", `${OWNER}/passkey/enroll/options`, { body: { code: "wrong wrong wrong" } });
		x.telegram.state.mode = "refused";
		await x.call("POST", `${OWNER}/passkey/code`, { body: {} });
		codes.push(x.telegram.lastCode());
		x.telegram.state.mode = "ok";
		await x.owned(new FakePasskey(PI_RP.rpID));
		codes.push(x.telegram.lastCode());
		const files = readdirSync(x.dataDir).map((f) => readFileSync(join(x.dataDir, f), "utf8"));
		const haystacks = [...x.logs, ...x.responses, ...files];
		for (const code of codes) for (const hay of haystacks) expect(hay).not.toContain(code);
		expect(x.logs.length).toBeGreaterThan(0);
	});
});

describe("owner check: one refusal for every failure (R-OWNER-REFUSE-1)", () => {
	it("identical 403 body for every failure, owner routes and explorer routes alike", async () => {
		const x = await harness();
		const failures = [
			await x.call("POST", `${OWNER}/session/options`, { body: {} }),
			await x.call("POST", `${OWNER}/passkey/enroll/options`, { body: { code: "nope" } }),
			await x.call("POST", `${OWNER}/session/verify`, { body: { challenge_id: "x", response: {} } }),
			await x.call("POST", `${OWNER}/write/options`, { body: {} }),
			await x.call("DELETE", `${OWNER}/passkey?id=abc`),
			await read(x, undefined),
			await x.call("POST", "/api/openviking/undo", { body: { operation_id: "op-1-00000000" } }),
		];
		expect(new Set(failures.map((r) => `${r.status} ${r.text}`))).toEqual(new Set([`403 ${REFUSAL}`]));
	});
});
