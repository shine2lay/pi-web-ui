/**
 * The owner check (OI-1) on a real HTTP server, as server/index.ts mounts it: the JSON parser with the write-body
 * hook, the owner routes, and the explorer routes whose gate is the owner check's. The daemon fake stands in for
 * :1933, `FakePasskey` for the owner's authenticator, `fakeTelegram` for his Telegram, the daemon's manual clock for
 * time. `restart()` builds a new server process on the same data folder (memory gone, passkey file kept).
 */
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createOwnerCheck, type OwnerCheck, type OwnerWriteListener } from "../../server/openviking/owner-check.js";
import { expect } from "vitest";
import {
	OWNER_ONLY_BODY,
	OWNER_RELYING_PARTIES,
	type OwnerWriteOp,
} from "../../server/openviking/owner-session-types.js";
import { keepOwnerWriteBody } from "../../server/openviking/owner-write-op.js";
import { registerOpenVikingRoutes } from "../../server/openviking/index.js";
import { daemon, manualClock, type ManualClock } from "./openviking-daemon-fake.js";
import { FakePasskey, fakeTelegram } from "./openviking-owner-fakes.js";

export const [PI_RP, TS_RP] = OWNER_RELYING_PARTIES;
export const OWNER = "/api/openviking/owner";

export interface OwnerReply {
	status: number;
	body: unknown;
	text: string;
	setCookie: string | null;
}

/** R-OWNER-REFUSE-1: 403 and the one body, byte for byte, whatever failed. */
export function expectOwnerOnly(r: OwnerReply): void {
	expect({ status: r.status, text: r.text }).toEqual({ status: 403, text: JSON.stringify(OWNER_ONLY_BODY) });
}

export interface OwnerCall {
	body?: unknown;
	/** Sent as is (the exact bytes a write's sha256 covers). */
	rawBody?: string;
	cookie?: string | null;
	origin?: string | null;
	headers?: Record<string, string>;
}

export async function ownerHarness(
	opts: { dataDir?: string; clock?: ManualClock; writeListener?: OwnerWriteListener } = {},
) {
	const clock = opts.clock ?? manualClock();
	const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), "ov-owner-"));
	const fake = daemon("up", { explorer: true, clock });
	const telegram = fakeTelegram();
	const logs: string[] = [];
	// As route-modules.ts wires it: undo asks reach the explorer's writes once they register.
	let askUndo: ((operationId: string, untilMs: number) => void) | null = null;
	const owner: OwnerCheck = createOwnerCheck({
		dataDir,
		telegram: telegram.send,
		clock,
		log: (l) => logs.push(l),
		writeListener: opts.writeListener ?? { undoAsked: (id, untilMs) => askUndo?.(id, untilMs) },
	});
	const app = express();
	app.use(express.json({ limit: "10mb", verify: keepOwnerWriteBody }));
	owner.register(app);
	registerOpenVikingRoutes(app, {
		stateDir: mkdtempSync(join(tmpdir(), "ov-owner-state-")),
		fetchImpl: fake.fetchImpl,
		now: clock.now,
		explorer: { ownerGate: owner.gate, clock, onShutdown: () => {}, onUndoAsk: (ask) => void (askUndo = ask) },
	});
	const server: Server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const responses: string[] = [];

	const call = async (method: string, path: string, c: OwnerCall = {}): Promise<OwnerReply> => {
		const headers: Record<string, string> = { ...(c.headers ?? {}) };
		if (c.origin !== null) headers.Origin = c.origin ?? PI_RP.origin;
		if (c.cookie) headers.Cookie = c.cookie;
		const payload = c.rawBody ?? (c.body === undefined ? undefined : JSON.stringify(c.body));
		if (payload !== undefined) headers["Content-Type"] = "application/json";
		const res = await fetch(`${base}${path}`, { method, headers, body: payload });
		const text = await res.text();
		responses.push(text, res.headers.get("set-cookie") ?? "");
		let body: unknown = text;
		try {
			body = text === "" ? null : JSON.parse(text);
		} catch {
			body = text;
		}
		return { status: res.status, body, text, setCookie: res.headers.get("set-cookie") };
	};

	/** The cookie pair (`name=value`) a session/verify set. */
	const cookieOf = (r: OwnerReply) => (r.setCookie ?? "").split(";")[0];

	const rpOf = (passkey: FakePasskey) => OWNER_RELYING_PARTIES.find((rp) => rp.rpID === passkey.rpID) ?? PI_RP;

	/** passkey/code -> the code from Telegram -> enroll/options -> the authenticator -> enroll/verify. */
	const enroll = async (passkey: FakePasskey, o: { userVerified?: boolean } = {}) => {
		const origin = rpOf(passkey).origin;
		const sent = await call("POST", `${OWNER}/passkey/code`, { origin, body: {} });
		if (sent.status !== 202) return sent;
		const options = await call("POST", `${OWNER}/passkey/enroll/options`, {
			origin,
			body: { code: telegram.lastCode() },
		});
		if (options.status !== 200) return options;
		const b = options.body as { challenge_id: string; options: { challenge: string } };
		const response = passkey.register(b.options, { origin, userVerified: o.userVerified });
		return call("POST", `${OWNER}/passkey/enroll/verify`, { origin, body: { challenge_id: b.challenge_id, response } });
	};

	/** session/options -> the authenticator -> session/verify; returns the reply (cookie in `setCookie`). */
	const signIn = async (passkey: FakePasskey, o: { userVerified?: boolean } = {}) => {
		const origin = rpOf(passkey).origin;
		const options = await call("POST", `${OWNER}/session/options`, { origin, body: {} });
		if (options.status !== 200) return options;
		const b = options.body as { challenge_id: string; options: { challenge: string } };
		const response = passkey.assert(b.options, { origin, userVerified: o.userVerified });
		return call("POST", `${OWNER}/session/verify`, { origin, body: { challenge_id: b.challenge_id, response } });
	};

	/** Enrolls `passkey` and signs in; the session cookie. */
	const owned = async (passkey: FakePasskey) => {
		const enrolled = await enroll(passkey);
		if (enrolled.status !== 201) throw new Error(`enroll answered ${enrolled.status}`);
		const session = await signIn(passkey);
		if (session.status !== 200) throw new Error(`sign-in answered ${session.status}`);
		return cookieOf(session);
	};

	/** write/options for `op` -> the authenticator -> the `X-Owner-Assertion` header value. */
	const assertion = async (
		passkey: FakePasskey,
		cookie: string,
		op: OwnerWriteOp,
		o: { userVerified?: boolean } = {},
	) => {
		const origin = rpOf(passkey).origin;
		const options = await call("POST", `${OWNER}/write/options`, { origin, cookie, body: { op } });
		if (options.status !== 200) throw new Error(`write/options answered ${options.status}`);
		const b = options.body as { challenge_id: string; options: { challenge: string } };
		const response = passkey.assert(b.options, { origin, userVerified: o.userVerified });
		return Buffer.from(JSON.stringify({ challenge_id: b.challenge_id, response }), "utf8").toString("base64url");
	};

	/** A write as the page sends it: session, Origin, X-Owner-Write: 1, X-Owner-Assertion. */
	const write = (
		method: string,
		path: string,
		c: { cookie: string; assertion?: string; rawBody?: string; origin?: string | null; ownerWrite?: string | null },
	) => {
		const headers: Record<string, string> = {};
		if (c.ownerWrite !== null) headers["X-Owner-Write"] = c.ownerWrite ?? "1";
		if (c.assertion) headers["X-Owner-Assertion"] = c.assertion;
		return call(method, path, { cookie: c.cookie, rawBody: c.rawBody, origin: c.origin, headers });
	};

	return {
		dataDir,
		clock,
		fake,
		telegram,
		logs,
		responses,
		owner,
		call,
		cookieOf,
		enroll,
		signIn,
		owned,
		assertion,
		write,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
		/** A new server process on the same data folder and clock: sessions and challenges are gone. */
		restart: async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			return ownerHarness({ dataDir, clock });
		},
	};
}

export type OwnerHarness = Awaited<ReturnType<typeof ownerHarness>>;
