/**
 * Memory Explorer — the passkey owner check (OI-1, spec-explorer-owner.md; Security rm-8841fede as amended by
 * rm-3e4885d2). Its `gate` is the one owner gate's production answer (owner-gate.ts, R-OWNER-GATE-1):
 * - a read passes with no session (R-OWNER-READ-2; owner Shine 2026-11-22, dr-c54a3286d823: anyone who reaches
 *   pi-web-ui can ask a chat for any memory, so reads are not guarded; the gate's address check still applies);
 * - a write passes with `Origin` exactly one host's origin, `X-Owner-Write: 1`, and a fresh user-verified assertion
 *   from a passkey of that host over a challenge `write/options` bound to this exact op and host (R-OWNER-WRITE-1/2).
 * The challenge is used up on first use, valid or not. Anything else refuses, with reason codes in the log only
 * (never an assertion, challenge or code value). Its routes are in owner-routes.ts.
 * Not proof of the owner (defense in depth at most): PI_WEB_TOKEN, Tailscale headers, sec-fetch-site, the client IP.
 */
import type { Express, Request } from "express";
import type { OwnerTelegramSender } from "../owner-telegram.js";
import type { OpenVikingExplorerClock } from "./explorer-types.js";
import { OwnerChallengeStore, OwnerRateLimit } from "./owner-ceremony-store.js";
import { OwnerEnrollCodes } from "./owner-enroll-code.js";
import type { OpenVikingOwnerGate } from "./owner-gate.js";
import { OwnerPasskeyStore } from "./owner-passkey-store.js";
import { OwnerRefusal } from "./owner-refusal.js";
import { registerOwnerRoutes } from "./owner-routes.js";
import {
	OWNER_ASSERTION_HEADER,
	OWNER_CODE_RATE_LIMIT,
	OWNER_RATE_LIMIT,
	OWNER_RELYING_PARTIES,
	OWNER_WRITE_HEADER,
	type OwnerRelyingParty,
	type OwnerWriteOp,
} from "./owner-session-types.js";
import { ownerVerifiedAssertion } from "./owner-webauthn.js";
import { canonicalOwnerWriteOp, receivedBodySha256 } from "./owner-write-op.js";

/**
 * Told when an undo's confirmation is asked for (R-OWNER-UNDO-1): it freezes a held delete until `untilMs`, the
 * challenge's end; the writes resolve it from there (a verified undo cancels it; expiry cancels it, unconfirmed).
 */
export interface OwnerWriteListener {
	undoAsked(operationId: string, untilMs: number): void;
}

export interface OwnerCheckDeps {
	/** Where `owner-passkeys.json` lives (production: ~/.pi-web-ui). */
	dataDir: string;
	/** The owner's Telegram (server/owner-telegram.ts); enrollment codes and passkey notices go only here. */
	telegram: OwnerTelegramSender;
	clock: OpenVikingExplorerClock;
	/** One line per event, reason codes only. */
	log: (line: string) => void;
	writeListener?: OwnerWriteListener;
}

export interface OwnerCheck {
	gate: OpenVikingOwnerGate;
	register(app: Express): void;
	passkeyCount(): number;
}

/** The internals the owner routes share with the gate. */
export interface OwnerCheckState {
	deps: OwnerCheckDeps;
	passkeys: OwnerPasskeyStore;
	challenges: OwnerChallengeStore;
	codes: OwnerEnrollCodes;
	limits: OwnerRateLimit;
	codeLimit: OwnerRateLimit;
	listener: OwnerWriteListener;
	/** The host the request's `Origin` names exactly; refuses otherwise. */
	rpOf(req: Request): OwnerRelyingParty;
	/** A write's checks (R-OWNER-WRITE-1/2); refuses unless every one passes. Answers the write's host. */
	confirmWrite(req: Request, op: OwnerWriteOp): Promise<OwnerRelyingParty>;
	refused(where: string, err: unknown): void;
}

const NO_LISTENER: OwnerWriteListener = { undoAsked: () => {} };
const MAX_ASSERTION_HEADER = 16 * 1024;

function assertionOf(req: Request): { challengeId: unknown; response: unknown } {
	const raw = req.get(OWNER_ASSERTION_HEADER);
	if (!raw) throw new OwnerRefusal("no_assertion");
	if (raw.length > MAX_ASSERTION_HEADER || !/^[A-Za-z0-9_-]+$/.test(raw))
		throw new OwnerRefusal("bad_assertion_header");
	try {
		const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown> | null;
		if (parsed === null || typeof parsed !== "object") throw new Error("not an object");
		return { challengeId: parsed.challenge_id, response: parsed.response };
	} catch {
		throw new OwnerRefusal("bad_assertion_header");
	}
}

/** The op as the server received it: the route's op, its method the request's and its body hash the received one. */
function receivedOpMatches(req: Request, op: OwnerWriteOp): boolean {
	if (req.method !== op.method) return false;
	return !("body_sha256" in op) || op.body_sha256 === receivedBodySha256(req);
}

export function createOwnerCheck(deps: OwnerCheckDeps): OwnerCheck {
	const listener = deps.writeListener ?? NO_LISTENER;
	const passkeys = new OwnerPasskeyStore(deps.dataDir);
	const challenges = new OwnerChallengeStore(deps.clock, () => {
		deps.log("owner-check: write confirmation expired unused");
	});
	const codes = new OwnerEnrollCodes({ telegram: deps.telegram, now: deps.clock.now });
	const limits = new OwnerRateLimit(deps.clock, OWNER_RATE_LIMIT);

	const refused = (where: string, err: unknown) => {
		const reason = err instanceof OwnerRefusal ? err.reason : "error";
		deps.log(`owner-check: refused ${where} reason=${reason}`);
	};

	const rpOf = (req: Request): OwnerRelyingParty => {
		const origin = req.get("origin");
		const rp = OWNER_RELYING_PARTIES.find((r) => r.origin === origin);
		if (!rp) throw new OwnerRefusal("bad_origin");
		return rp;
	};

	/** The named challenge is used up first, so whatever fails after that, it never works again. */
	const confirmWrite = async (req: Request, op: OwnerWriteOp): Promise<OwnerRelyingParty> => {
		if (!limits.take("assertion")) throw new OwnerRefusal("rate_limited");
		const { challengeId, response } = assertionOf(req);
		const challenge = challenges.take(challengeId, "write");
		if (!challenge) throw new OwnerRefusal("unknown_challenge");
		const rp = rpOf(req);
		if (challenge.rp.rpID !== rp.rpID) throw new OwnerRefusal("other_host");
		if (req.get(OWNER_WRITE_HEADER) !== "1") throw new OwnerRefusal("no_write_header");
		if (challenges.expired(challenge)) throw new OwnerRefusal("challenge_expired");
		const stored = challenge.op;
		if (!stored || !receivedOpMatches(req, op) || canonicalOwnerWriteOp(stored) !== canonicalOwnerWriteOp(op)) {
			throw new OwnerRefusal("op_mismatch");
		}
		const verified = await ownerVerifiedAssertion(challenge, response, passkeys.forRp(rp.rpID));
		if (!verified) throw new OwnerRefusal("assertion_failed");
		passkeys.setCounter(rp.rpID, verified.passkey.id, verified.counter);
		return rp;
	};

	const state: OwnerCheckState = {
		deps,
		passkeys,
		challenges,
		codes,
		limits,
		codeLimit: new OwnerRateLimit(deps.clock, OWNER_CODE_RATE_LIMIT),
		listener,
		rpOf,
		confirmWrite,
		refused,
	};

	const gate: OpenVikingOwnerGate = (req, access) => {
		if (access.kind === "read") return true;
		return confirmWrite(req, access.op).then(
			() => true,
			(err: unknown) => {
				refused(`write ${access.op.method}`, err);
				return false;
			},
		);
	};

	return {
		gate,
		register: (app) => registerOwnerRoutes(app, state),
		passkeyCount: () => passkeys.all().length,
	};
}
