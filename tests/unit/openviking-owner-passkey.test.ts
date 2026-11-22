/**
 * The owner check, enrollment and refusals (OI-1; Security rm-8841fede as amended by rm-3e4885d2; spec-explorer-owner.md
 * R-OWNER-WRITE-1, R-OWNER-REFUSE-1). Reads are open since Ops #1080 (owner Shine 2026-11-22, dr-c54a3286d823):
 * openviking-owner-open-reads. Writes with an assertion: openviking-owner-write.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OWNER_CODE_WORDS } from "../../server/openviking/owner-enroll-code.js";
import { OWNER_ENROLL_CODE_MS, OWNER_ONLY_BODY } from "../../server/openviking/owner-session-types.js";
import { FakePasskey } from "./openviking-owner-fakes.js";
import { expectOwnerOnly, OWNER, type OwnerHarness, ownerHarness, PI_RP, TS_RP } from "./openviking-owner-harness.js";

const SHARED_NOTE = "viking://resources/pi-web-ui/README.md";
const q = encodeURIComponent;
const REFUSAL = JSON.stringify(OWNER_ONLY_BODY);

/** The 3 explorer writes as the page sends them, without an assertion. */
const EXPLORER_WRITES: [string, string, unknown][] = [
	["PUT", "/api/openviking/note", { uri: SHARED_NOTE, content: "x", opened_mod_time: "2026-01-01T00:00:00.000Z" }],
	["DELETE", `/api/openviking/note?uri=${q(SHARED_NOTE)}`, undefined],
	["POST", "/api/openviking/undo", { operation_id: "op-1-00000000" }],
];

async function expectAllWritesRefuse(x: OwnerHarness, call: { cookie?: string; headers?: Record<string, string> }) {
	const before = x.fake.calls.length;
	for (const [method, path, body] of EXPLORER_WRITES) {
		const headers = { "X-Owner-Write": "1", ...call.headers };
		expectOwnerOnly(await x.call(method, path, { body, cookie: call.cookie, headers }));
	}
	expect(x.fake.calls.length).toBe(before);
}

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

describe("owner check: writes need the owner's passkey, nothing else stands in (R-OWNER-WRITE-1)", () => {
	it("no assertion -> 403 OWNER_ONLY on all 3 explorer writes, nothing reaches the store", async () => {
		const x = await harness();
		await x.owned(new FakePasskey(PI_RP.rpID));
		await expectAllWritesRefuse(x, {});
	});

	it("an old session cookie stands for nothing: 403 on all 3 writes", async () => {
		const x = await harness();
		await x.owned(new FakePasskey(PI_RP.rpID));
		await expectAllWritesRefuse(x, { cookie: `pi_owner_session=${Buffer.alloc(32, 7).toString("base64url")}` });
	});

	it("Tailscale-User-Login stands for nothing: 403 on all 3 writes", async () => {
		const x = await harness();
		await x.owned(new FakePasskey(PI_RP.rpID));
		const tailscale = { "Tailscale-User-Login": "owner@example.com", "Tailscale-User-Name": "Owner" };
		await expectAllWritesRefuse(x, { headers: tailscale });
	});

	it("PI_WEB_TOKEN set: the token in a header or its cookie stands for nothing on writes", async () => {
		vi.stubEnv("PI_WEB_TOKEN", "owner-token-123");
		const x = await harness();
		await x.owned(new FakePasskey(PI_RP.rpID));
		await expectAllWritesRefuse(x, { headers: { Authorization: "Bearer owner-token-123" } });
		await expectAllWritesRefuse(x, { headers: { "X-PI-Token": "owner-token-123" } });
		await expectAllWritesRefuse(x, { cookie: "pi_web_token=owner-token-123" });
	});

	it("zero passkeys -> write/options refuses and every write refuses", async () => {
		const x = await harness();
		expectOwnerOnly(
			await x.call("POST", `${OWNER}/write/options`, {
				body: { op: { method: "POST", operation_id: "op-1-00000000" } },
				headers: { "X-Owner-Write": "1" },
			}),
		);
		await expectAllWritesRefuse(x, {});
	});

	it("a passkey belongs to its host: write/options on the other host or a foreign Origin is refused", async () => {
		const x = await harness();
		await x.owned(new FakePasskey(PI_RP.rpID));
		const ask = (origin: string | null) =>
			x.call("POST", `${OWNER}/write/options`, {
				origin,
				body: { op: { method: "POST", operation_id: "op-1-00000000" } },
				headers: { "X-Owner-Write": "1" },
			});
		expect((await ask(PI_RP.origin)).status).toBe(200);
		expectOwnerOnly(await ask(TS_RP.origin));
		expectOwnerOnly(await ask("https://evil.example"));
		expectOwnerOnly(await ask(null));
		await x.owned(new FakePasskey(TS_RP.rpID));
		expect((await ask(TS_RP.origin)).status).toBe(200);
	});

	it("write/options is rate limited to 10 a minute", async () => {
		const x = await harness();
		await x.owned(new FakePasskey(PI_RP.rpID));
		const ask = () =>
			x.call("POST", `${OWNER}/write/options`, {
				body: { op: { method: "POST", operation_id: "op-1-00000000" } },
				headers: { "X-Owner-Write": "1" },
			});
		for (let i = 0; i < 10; i++) expect((await ask()).status).toBe(200);
		expectOwnerOnly(await ask());
		x.clock.advance(60_000);
		expect((await ask()).status).toBe(200);
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
			await x.call("POST", `${OWNER}/passkey/enroll/options`, { body: { code: "nope" } }),
			await x.call("POST", `${OWNER}/passkey/enroll/verify`, { body: { challenge_id: "x", response: {} } }),
			await x.call("POST", `${OWNER}/write/options`, { body: {} }),
			await x.call("POST", `${OWNER}/write/options`, {
				body: { op: { method: "POST", operation_id: "op-1-00000000" } },
				headers: { "X-Owner-Write": "1" },
			}),
			await x.call("GET", `${OWNER}/passkeys`, { origin: "https://evil.example" }),
			await x.call("DELETE", `${OWNER}/passkey?id=abc`),
			await x.call("GET", "/api/openviking/tree/roots", { host: "pi.wai2shine.com." }),
			await x.call("POST", "/api/openviking/undo", { body: { operation_id: "op-1-00000000" } }),
		];
		expect(new Set(failures.map((r) => `${r.status} ${r.text}`))).toEqual(new Set([`403 ${REFUSAL}`]));
	});
});
