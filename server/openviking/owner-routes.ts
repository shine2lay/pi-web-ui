/**
 * Memory Explorer — the owner check's routes (OI-1, spec-explorer-owner.md), all under `/api/openviking/owner/`;
 * bodies in owner-session-types.ts. Every failure answers `403 OWNER_ONLY` with one body (R-OWNER-REFUSE-1) and logs
 * a reason code only. A `Host` or `Origin` whose host ends in "." is refused first (rm-638da86a). Enrollment needs
 * the single-use code sent to the owner's Telegram; there is no first-come enrollment. Each passkey added or removed
 * sends the owner a Telegram notice (host and time, no secrets). There is no session (Ops #1080, owner Shine
 * 2026-11-22, dr-c54a3286d823): `GET passkeys` lists a host's passkeys (public info only) for anyone who reaches it.
 */
import type { Express, Request, Response } from "express";
import type { OwnerCheckState } from "./owner-check.js";
import { ownerAddressAllowed } from "./owner-gate.js";
import type { OwnerPasskey } from "./owner-passkey-store.js";
import { OwnerRefusal } from "./owner-refusal.js";
import {
	OWNER_CEREMONY_CHALLENGE_MS,
	OWNER_ONLY_BODY,
	OWNER_RELYING_PARTIES,
	OWNER_WRITE_CHALLENGE_MS,
	OWNER_WRITE_HEADER,
	type OwnerCeremonyOptions,
	type OwnerCodeSent,
	type OwnerEnrolled,
	type OwnerPasskeyInfo,
	type OwnerPasskeyList,
	type OwnerPasskeyRemoved,
	type OwnerRelyingParty,
} from "./owner-session-types.js";
import { ownerCreationOptions, ownerRequestOptions, ownerVerifiedRegistration } from "./owner-webauthn.js";
import { checkedOwnerWriteOp } from "./owner-write-op.js";

const BASE = "/api/openviking/owner";
type Answer = { status: number; body: unknown };

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

	/** The host a request names: its `Origin` exactly when sent (rpOf), else its `Host` naming one of the hosts. */
	const rpOfAddress = (req: Request): OwnerRelyingParty => {
		if (req.get("origin") !== undefined) return s.rpOf(req);
		const rp = OWNER_RELYING_PARTIES.find((r) => new URL(r.origin).host === req.headers.host);
		if (!rp) throw new OwnerRefusal("bad_host");
		return rp;
	};

	const route = (method: "get" | "post" | "delete", path: string, handler: (req: Request) => Promise<Answer>) => {
		app[method](`${BASE}/${path}`, async (req: Request, res: Response) => {
			res.setHeader("Cache-Control", "no-store");
			try {
				if (!ownerAddressAllowed(req)) throw new OwnerRefusal("bad_address");
				const answer = await handler(req);
				res.status(answer.status).json(answer.body);
			} catch (err) {
				s.refused(path, err);
				res.status(403).json(OWNER_ONLY_BODY);
			}
		});
	};

	route("get", "passkeys", async (req) => {
		const rp = rpOfAddress(req);
		const body: OwnerPasskeyList = { rp_id: rp.rpID, passkeys: s.passkeys.forRp(rp.rpID).map(infoOf) };
		return { status: 200, body };
	});

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
		if (req.get(OWNER_WRITE_HEADER) !== "1") throw new OwnerRefusal("no_write_header");
		const op = checkedOwnerWriteOp(bodyOf(req).op);
		if (!op) throw new OwnerRefusal("bad_request");
		const passkeys = s.passkeys.forRp(rp.rpID);
		if (passkeys.length === 0) throw new OwnerRefusal("no_passkeys");
		const challenge = s.challenges.issue("write", rp, OWNER_WRITE_CHALLENGE_MS, op);
		const options = await ownerRequestOptions(challenge, passkeys, OWNER_WRITE_CHALLENGE_MS);
		if ("operation_id" in op) undoAsked(op.operation_id, challenge.expiresAt);
		const body: OwnerCeremonyOptions = { challenge_id: challenge.id, expires_at: iso(challenge.expiresAt), options };
		return { status: 200, body };
	});

	route("delete", "passkey", async (req) => {
		const id = typeof req.query.id === "string" ? req.query.id : "";
		const op = checkedOwnerWriteOp({ method: "DELETE", passkey_id: id });
		if (!op) throw new OwnerRefusal("bad_request");
		const rp = await s.confirmWrite(req, op);
		if (!s.passkeys.remove(rp.rpID, id)) throw new OwnerRefusal("bad_request");
		await notify("removed", rp);
		const body: OwnerPasskeyRemoved = { removed: id };
		return { status: 200, body };
	});
}
