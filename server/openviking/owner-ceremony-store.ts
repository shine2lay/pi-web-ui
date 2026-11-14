/**
 * Memory Explorer — the owner check's in-memory state (OI-1, Security rm-8841fede point 3, rm-3e4885d2): sessions,
 * single-use challenges and the rate limits. Nothing here is ever written to disk or logged, so a restart signs the
 * owner out and drops every challenge. Times come from the explorer clock (tests pass a manual one).
 */
import { randomBytes } from "node:crypto";
import type { OpenVikingExplorerClock } from "./explorer-types.js";
import {
	OWNER_CHALLENGE_BYTES,
	OWNER_SESSION_IDLE_MS,
	OWNER_SESSION_MAX_MS,
	type OwnerRelyingParty,
	type OwnerWriteOp,
} from "./owner-session-types.js";

/** 32 random bytes, base64url: session ids, challenges, challenge ids. */
export const ownerRandomId = (): string => randomBytes(OWNER_CHALLENGE_BYTES).toString("base64url");

export interface OwnerSession {
	id: string;
	rpID: string;
	passkeyId: string;
	createdAt: number;
	lastSeenAt: number;
}

/** Owner sessions: 256-bit random ids, 15 min idle, 4 h in total. */
export class OwnerSessionStore {
	private readonly sessions = new Map<string, OwnerSession>();

	constructor(private readonly clock: OpenVikingExplorerClock) {}

	open(rpID: string, passkeyId: string): OwnerSession {
		const now = this.clock.now();
		const session: OwnerSession = { id: ownerRandomId(), rpID, passkeyId, createdAt: now, lastSeenAt: now };
		this.sessions.set(session.id, session);
		return session;
	}

	/** The live session `id` names (and it counts as activity), or null: unknown, idle too long, or too old. */
	use(id: string | null): OwnerSession | null {
		if (id === null) return null;
		const session = this.sessions.get(id);
		if (!session) return null;
		const now = this.clock.now();
		if (now - session.lastSeenAt > OWNER_SESSION_IDLE_MS || now - session.createdAt > OWNER_SESSION_MAX_MS) {
			this.sessions.delete(id);
			return null;
		}
		session.lastSeenAt = now;
		return session;
	}

	end(id: string): void {
		this.sessions.delete(id);
	}

	/** Ends every session a removed passkey opened. */
	endForPasskey(rpID: string, passkeyId: string): void {
		for (const [id, s] of this.sessions) if (s.rpID === rpID && s.passkeyId === passkeyId) this.sessions.delete(id);
	}
}

export type OwnerChallengeKind = "enroll" | "session" | "write";

export interface OwnerChallenge {
	id: string;
	kind: OwnerChallengeKind;
	/** base64url of 32 random bytes: what the authenticator signs. */
	challenge: string;
	rp: OwnerRelyingParty;
	expiresAt: number;
	/** `write`: the session that asked and the op the assertion is bound to. */
	sessionId: string | null;
	op: OwnerWriteOp | null;
}

/** Single-use challenges: taken once (found or not, valid or not, it is gone), expired after their lifetime. */
export class OwnerChallengeStore {
	private readonly live = new Map<string, { challenge: OwnerChallenge; timer: unknown }>();

	constructor(
		private readonly clock: OpenVikingExplorerClock,
		/** Called once for a write challenge that expired without being taken (R-OWNER-UNDO-1). */
		private readonly onUnused: (challenge: OwnerChallenge) => void = () => {},
	) {}

	issue(
		kind: OwnerChallengeKind,
		rp: OwnerRelyingParty,
		lifetimeMs: number,
		bound: { sessionId: string; op: OwnerWriteOp } | null = null,
	): OwnerChallenge {
		const challenge: OwnerChallenge = {
			id: ownerRandomId(),
			kind,
			challenge: ownerRandomId(),
			rp,
			expiresAt: this.clock.now() + lifetimeMs,
			sessionId: bound?.sessionId ?? null,
			op: bound?.op ?? null,
		};
		const timer = this.clock.setTimer(lifetimeMs, () => {
			if (this.live.get(challenge.id)?.challenge !== challenge) return;
			this.live.delete(challenge.id);
			if (kind === "write") this.onUnused(challenge);
		});
		this.live.set(challenge.id, { challenge, timer });
		return challenge;
	}

	/**
	 * Removes the challenge `id` names (any kind: a wrong kind is used up too) and returns it when it is of `kind`;
	 * else null. The caller refuses one past its lifetime (`expired`), so it still knows what the challenge was for.
	 */
	take(id: unknown, kind: OwnerChallengeKind): OwnerChallenge | null {
		if (typeof id !== "string") return null;
		const entry = this.live.get(id);
		if (!entry) return null;
		this.live.delete(id);
		this.clock.clearTimer(entry.timer);
		return entry.challenge.kind === kind ? entry.challenge : null;
	}

	expired(challenge: OwnerChallenge): boolean {
		return this.clock.now() > challenge.expiresAt;
	}
}

/** At most `calls` per rolling `windowMs`, counted per key across every caller (refusals count too). */
export class OwnerRateLimit {
	private readonly times = new Map<string, number[]>();

	constructor(
		private readonly clock: OpenVikingExplorerClock,
		private readonly limit: { calls: number; windowMs: number },
	) {}

	take(key: string): boolean {
		const now = this.clock.now();
		const recent = (this.times.get(key) ?? []).filter((t) => now - t < this.limit.windowMs);
		const allowed = recent.length < this.limit.calls;
		if (allowed) recent.push(now);
		this.times.set(key, recent);
		return allowed;
	}
}
