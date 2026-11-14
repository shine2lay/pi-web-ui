/**
 * Memory Explorer — the owner check's routes (OI-1, spec-explorer-owner.md), all under `/api/openviking/owner/`;
 * bodies in owner-session-types.ts. Every failure answers `403 OWNER_ONLY` with one body (R-OWNER-REFUSE-1) and logs
 * a reason code only. A `Host` or `Origin` whose host ends in "." is refused first (rm-638da86a). Enrollment needs the single-use code sent to the owner's Telegram; there is no first-come
 * enrollment. Each passkey added or removed sends the owner a Telegram notice (host and time, no secrets).
 */
import type { Express, Request, Response } from "express";
import type { OwnerCheckState } from "./owner-check.js";
import { ownerAddressAllowed } from "./owner-gate.js";
import type { OwnerPasskey } from "./owner-passkey-store.js";
import { OwnerRefusal } from "./owner-refusal.js";
import {
	OWNER_CEREMONY_CHALLENGE_MS,
	OWNER_ONLY_BODY,
	OWNER_SESSION_COOKIE,
	OWNER_SESSION_COOKIE_PATH,
	OWNER_SESSION_IDLE_MS,
	OWNER_SESSION_MAX_MS,
	OWNER_WRITE_CHALLENGE_MS,
	type OwnerCeremonyOptions,
	type OwnerCodeSent,
	type OwnerEnrolled,
	type OwnerPasskeyInfo,
	type OwnerPasskeyRemoved,
	type OwnerRelyingParty,
	type OwnerSessionOpened,
	type OwnerSignedOut,
} from "./owner-session-types.js";
import {
	ownerCreationOptions,
	ownerRequestOptions,
	ownerVerifiedAssertion,
	ownerVerifiedRegistration,
} from "./owner-webauthn.js";
import { checkedOwnerWriteOp } from "./owner-write-op.js";

const BASE = "/api/openviking/owner";
const COOKIE_ATTRS = `Path=${OWNER_SESSION_COOKIE_PATH}; HttpOnly; Secure; SameSite=Strict`;

type Answer = { status: number; body: unknown; cookie?: string };

const infoOf = (p: OwnerPasskey): OwnerPasskeyInfo => ({ id: p.id, rp_id: p.rp_id, created_at: p.created_at });

function bodyOf(req: Request): Record<string, unknown> {
	const body: unknown = req.body;
	if (body === undefined || body === null) return {};
	if (typeof body !== "object" || Array.isArray(body)) throw new OwnerRefusal("bad_request");
	return body as Record<string, unknown>;
}

export function registerOwnerRoutes(app: Express, s: OwnerCheckState): void {
	const iso = (ms: number) => new Date(ms).toISOString();

	const limited = (name: string) => {
		if (!s.limits.take(name)) throw new OwnerRefusal("rate_limited");
	};

	/** The owner's Telegram notice for a passkey added or removed; a failed send is logged, the change stands. */
	const notify = async (what: "added" | "removed", rp: OwnerRelyingParty) => {
		const text = `A passkey was ${what} for the memory explorer on ${rp.rpID} at ${iso(s.deps.clock.now())}.`;
		let ok = false;
		try {
			ok = (await s.deps.telegram({ text, from: "pi-web-ui owner check" })).ok;
		} catch {
			ok = false;
		}
		s.deps.log(`owner-check: passkey ${what} rp=${rp.rpID} notice=${ok ? "sent" : "failed"}`);
	};

	const route = (method: "post" | "delete", path: string, handler: (req: Request) => Promise<Answer>) => {
		app[method](`${BASE}/${path}`, async (req: Request, res: Response) => {
			res.setHeader("Cache-Control", "no-store");
			try {
				if (!ownerAddressAllowed(req)) throw new OwnerRefusal("bad_address");
				const answer = await handler(req);
				if (answer.cookie !== undefined) res.setHeader("Set-Cookie", answer.cookie);
				res.status(answer.status).json(answer.body);
			} catch (err) {
				s.refused(path, err);
				res.status(403).json(OWNER_ONLY_BODY);
			}
		});
	};

	route("post", "passkey/code", async (req) => {
		const rp = s.rpOf(req);
		if (!s.codeLimit.take("code")) throw new OwnerRefusal("rate_limited");
		const sent = await s.codes.issue(rp);
		if (!sent.ok) throw new OwnerRefusal(sent.reason);
		s.deps.log(`owner-check: enrollment code sent rp=${rp.rpID}`);
		const body: OwnerCodeSent = { sent: true, rp_id: rp.rpID, expires_at: iso(sent.expiresAt) };
		return { status: 202, body };
	});

	route("post", "passkey/enroll/options", async (req) => {
		limited("enroll/options");
		const rp = s.rpOf(req);
		if (!s.codes.take(rp.rpID, bodyOf(req).code)) throw new OwnerRefusal("bad_code");
		const challenge = s.challenges.issue("enroll", rp, OWNER_CEREMONY_CHALLENGE_MS);
		const options = await ownerCreationOptions(challenge, s.passkeys.forRp(rp.rpID), OWNER_CEREMONY_CHALLENGE_MS);
		const body: OwnerCeremonyOptions = { challenge_id: challenge.id, expires_at: iso(challenge.expiresAt), options };
		return { status: 200, body };
	});

	route("post", "passkey/enroll/verify", async (req) => {
		limited("enroll/verify");
		const rp = s.rpOf(req);
		const b = bodyOf(req);
		const challenge = s.challenges.take(b.challenge_id, "enroll");
		if (!challenge || s.challenges.expired(challenge) || challenge.rp.rpID !== rp.rpID) {
			throw new OwnerRefusal("unknown_challenge");
		}
		const passkey = await ownerVerifiedRegistration(challenge, b.response, iso(s.deps.clock.now()));
		if (!passkey) throw new OwnerRefusal("assertion_failed");
		s.passkeys.add(passkey);
		await notify("added", rp);
		const body: OwnerEnrolled = { passkey: infoOf(passkey) };
		return { status: 201, body };
	});

	route("post", "session/options", async (req) => {
		limited("session/options");
		const rp = s.rpOf(req);
		const passkeys = s.passkeys.forRp(rp.rpID);
		if (passkeys.length === 0) throw new OwnerRefusal("no_passkeys");
		const challenge = s.challenges.issue("session", rp, OWNER_CEREMONY_CHALLENGE_MS);
		const options = await ownerRequestOptions(challenge, passkeys, OWNER_CEREMONY_CHALLENGE_MS);
		const body: OwnerCeremonyOptions = { challenge_id: challenge.id, expires_at: iso(challenge.expiresAt), options };
		return { status: 200, body };
	});

	route("post", "session/verify", async (req) => {
		limited("session/verify");
		const rp = s.rpOf(req);
		const b = bodyOf(req);
		const challenge = s.challenges.take(b.challenge_id, "session");
		if (!challenge || s.challenges.expired(challenge) || challenge.rp.rpID !== rp.rpID) {
			throw new OwnerRefusal("unknown_challenge");
		}
		const passkeys = s.passkeys.forRp(rp.rpID);
		const verified = await ownerVerifiedAssertion(challenge, b.response, passkeys);
		if (!verified) throw new OwnerRefusal("assertion_failed");
		s.passkeys.setCounter(rp.rpID, verified.passkey.id, verified.counter);
		const session = s.sessions.open(rp.rpID, verified.passkey.id);
		s.deps.log(`owner-check: session opened rp=${rp.rpID}`);
		const body: OwnerSessionOpened = {
			expires_at: iso(session.createdAt + OWNER_SESSION_MAX_MS),
			idle_ms: OWNER_SESSION_IDLE_MS,
			passkey_id: verified.passkey.id,
			passkeys: passkeys.map(infoOf),
		};
		const maxAge = Math.floor(OWNER_SESSION_MAX_MS / 1000);
		return { status: 200, body, cookie: `${OWNER_SESSION_COOKIE}=${session.id}; ${COOKIE_ATTRS}; Max-Age=${maxAge}` };
	});

	/** R-OWNER-UNDO-1. A refusal here (unknown op, window closed) is the undo route's to answer, so it is dropped. */
	const undoAsked = (operationId: string, untilMs: number) => {
		try {
			s.listener.undoAsked(operationId, untilMs);
		} catch {
			// The undo itself answers OPERATION_UNKNOWN / UNDO_WINDOW_CLOSED.
		}
	};

	route("post", "write/options", async (req) => {
		limited("write/options");
		const rp = s.rpOf(req);
		const session = s.sessionOf(req);
		if (session.rpID !== rp.rpID) throw new OwnerRefusal("bad_origin");
		const op = checkedOwnerWriteOp(bodyOf(req).op);
		if (!op) throw new OwnerRefusal("bad_request");
		const passkeys = s.passkeys.forRp(rp.rpID);
		const challenge = s.challenges.issue("write", rp, OWNER_WRITE_CHALLENGE_MS, { sessionId: session.id, op });
		const options = await ownerRequestOptions(challenge, passkeys, OWNER_WRITE_CHALLENGE_MS);
		if ("operation_id" in op) undoAsked(op.operation_id, challenge.expiresAt);
		const body: OwnerCeremonyOptions = { challenge_id: challenge.id, expires_at: iso(challenge.expiresAt), options };
		return { status: 200, body };
	});

	route("post", "session/logout", async (req) => {
		s.rpOf(req);
		try {
			s.sessions.end(s.sessionOf(req).id);
		} catch {
			// No live session: signing out is still done.
		}
		const body: OwnerSignedOut = { signed_out: true };
		return { status: 200, body, cookie: `${OWNER_SESSION_COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0` };
	});

	route("delete", "passkey", async (req) => {
		const id = typeof req.query.id === "string" ? req.query.id : "";
		const op = checkedOwnerWriteOp({ method: "DELETE", passkey_id: id });
		if (!op) throw new OwnerRefusal("bad_request");
		const session = await s.confirmWrite(req, op);
		if (!s.passkeys.remove(session.rpID, id)) throw new OwnerRefusal("bad_request");
		s.sessions.endForPasskey(session.rpID, id);
		const rp = s.rpOf(req);
		await notify("removed", rp);
		const body: OwnerPasskeyRemoved = { removed: id };
		return { status: 200, body };
	});
}
