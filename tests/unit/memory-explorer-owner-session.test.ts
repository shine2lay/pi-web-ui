/**
 * Memory explorer (design #316): the owner's passkey client on `/api/openviking/owner/*`
 * (spec-explorer-owner.md, backend #166). Sign in, add a passkey with the Telegram code, confirm one
 * write, sign out, remove a passkey. The browser's passkey prompt is passed in.
 */

import { describe, expect, it, vi } from "vitest";
import type { OwnerWriteOp } from "../../server/openviking/owner-session-types.js";
import {
	createOwnerSession,
	OwnerSessionError,
	type OwnerWebAuthn,
} from "../../web/src/memory-explorer/owner-session.js";

const OPENED = {
	expires_at: "2026-11-14T05:00:00.000Z",
	idle_ms: 900_000,
	passkey_id: "pk-1",
	passkeys: [{ id: "pk-1", rp_id: "pi.wai2shine.com", created_at: "2026-11-13T22:00:00.000Z" }],
};
const CEREMONY = { challenge_id: "ch-9", expires_at: "2026-11-14T01:02:00.000Z", options: { challenge: "abc" } };
const ASSERTION = { id: "cred", response: { signature: "s+/=" } };

function server(answers: Record<string, { status?: number; body: unknown }>) {
	const sent: { url: string; init: RequestInit }[] = [];
	const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
		sent.push({ url, init });
		const key = `${init.method ?? "GET"} ${url.replace(/^.*\/api\/openviking\/owner\//, "").replace(/\?.*$/, "")}`;
		const answer = answers[key] ?? { status: 403, body: { error: { code: "OWNER_ONLY" } } };
		return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
	});
	return { fetch, sent };
}

function prompt(): OwnerWebAuthn & { register: ReturnType<typeof vi.fn>; authenticate: ReturnType<typeof vi.fn> } {
	return {
		register: vi.fn(async () => ({ id: "new-cred" })),
		authenticate: vi.fn(async () => ASSERTION),
	};
}

const bodyOf = (init: RequestInit) => JSON.parse(init.body as string);
const decode = (b64url: string) => {
	const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
	return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
};

describe("sign in", () => {
	it("asks for a challenge, runs the passkey prompt on its options, and sends the answer back", async () => {
		const { fetch, sent } = server({
			"POST session/options": { body: CEREMONY },
			"POST session/verify": { body: OPENED },
		});
		const webauthn = prompt();
		const opened = await createOwnerSession({ fetch, webauthn }).signIn();
		expect(opened).toEqual(OPENED);
		expect(webauthn.authenticate).toHaveBeenCalledWith(CEREMONY.options);
		expect(sent.map((s) => s.url.replace(/^.*\/owner\//, ""))).toEqual(["session/options", "session/verify"]);
		expect(bodyOf(sent[1].init)).toEqual({ challenge_id: "ch-9", response: ASSERTION });
		expect(sent.every((s) => s.init.credentials === "same-origin")).toBe(true);
	});

	it("tells a cancelled prompt apart from a refusal", async () => {
		const { fetch } = server({ "POST session/options": { body: CEREMONY } });
		const webauthn = prompt();
		webauthn.authenticate.mockRejectedValueOnce(Object.assign(new Error("closed"), { name: "NotAllowedError" }));
		const session = createOwnerSession({ fetch, webauthn });
		await expect(session.signIn()).rejects.toMatchObject({ code: "CANCELLED" });
		const refused = createOwnerSession({ fetch: server({}).fetch, webauthn: prompt() });
		await expect(refused.signIn()).rejects.toMatchObject({ code: "REFUSED" });
		await expect(refused.signIn()).rejects.toBeInstanceOf(OwnerSessionError);
	});

	it("reads a prompt cancelled behind the passkey library's wrapper as cancelled", async () => {
		const { fetch } = server({ "POST session/options": { body: CEREMONY } });
		const webauthn = prompt();
		const inner = Object.assign(new Error("denied"), { name: "NotAllowedError" });
		webauthn.authenticate.mockRejectedValueOnce(Object.assign(new Error("wrapped"), { name: "WebAuthnError", cause: inner }));
		await expect(createOwnerSession({ fetch, webauthn }).signIn()).rejects.toMatchObject({ code: "CANCELLED" });
	});
});

describe("add a passkey", () => {
	it("sends the Telegram code, then enrolls with the code the owner typed", async () => {
		const { fetch, sent } = server({
			"POST passkey/code": { status: 202, body: { sent: true, rp_id: "pi.wai2shine.com", expires_at: "x" } },
			"POST passkey/enroll/options": { body: CEREMONY },
			"POST passkey/enroll/verify": { status: 201, body: { passkey: OPENED.passkeys[0] } },
		});
		const webauthn = prompt();
		const session = createOwnerSession({ fetch, webauthn });
		await session.sendCode();
		const added = await session.addPasskey("  apple river stone cloud lamp seven tide \n");
		expect(added).toEqual(OPENED.passkeys[0]);
		expect(bodyOf(sent[1].init)).toEqual({ code: "apple river stone cloud lamp seven tide" });
		expect(webauthn.register).toHaveBeenCalledWith(CEREMONY.options);
		expect(bodyOf(sent[2].init)).toEqual({ challenge_id: "ch-9", response: { id: "new-cred" } });
	});

	it("a wrong or used code is a refusal", async () => {
		const session = createOwnerSession({ fetch: server({}).fetch, webauthn: prompt() });
		await expect(session.addPasskey("wrong")).rejects.toMatchObject({ code: "REFUSED" });
	});
});

describe("confirm one write", () => {
	const op: OwnerWriteOp = { method: "DELETE", uri: "viking://user/default/memories/a.md", body_sha256: "e3b0" };

	it("binds the challenge to the op and answers the header value: base64url JSON of challenge and assertion", async () => {
		const { fetch, sent } = server({ "POST write/options": { body: CEREMONY } });
		const header = await createOwnerSession({ fetch, webauthn: prompt() }).confirmWrite(op);
		expect(bodyOf(sent[0].init)).toEqual({ op });
		expect(header).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(decode(header)).toEqual({ challenge_id: "ch-9", response: ASSERTION });
	});

	it("a cancelled prompt after the challenge is cancelled; no challenge is a refusal", async () => {
		const { fetch } = server({ "POST write/options": { body: CEREMONY } });
		const webauthn = prompt();
		webauthn.authenticate.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "AbortError" }));
		await expect(createOwnerSession({ fetch, webauthn }).confirmWrite(op)).rejects.toMatchObject({ code: "CANCELLED" });
		const none = createOwnerSession({ fetch: server({}).fetch, webauthn: prompt() });
		await expect(none.confirmWrite(op)).rejects.toMatchObject({ code: "REFUSED" });
	});
});

describe("sign out and remove a passkey", () => {
	it("signs out", async () => {
		const { fetch, sent } = server({ "POST session/logout": { body: { signed_out: true } } });
		await createOwnerSession({ fetch, webauthn: prompt() }).signOut();
		expect(sent[0].url).toContain("/api/openviking/owner/session/logout");
	});

	it("removes a passkey only with its own confirm, sent as the write headers", async () => {
		const { fetch, sent } = server({
			"POST write/options": { body: CEREMONY },
			"DELETE passkey": { body: { removed: "pk-1" } },
		});
		await createOwnerSession({ fetch, webauthn: prompt() }).removePasskey("pk-1");
		expect(bodyOf(sent[0].init)).toEqual({ op: { method: "DELETE", passkey_id: "pk-1" } });
		const del = sent[1];
		expect(del.url).toContain("/api/openviking/owner/passkey?id=pk-1");
		const headers = new Headers(del.init.headers);
		expect(headers.get("X-Owner-Write")).toBe("1");
		expect(decode(headers.get("X-Owner-Assertion") as string).challenge_id).toBe("ch-9");
	});
});
