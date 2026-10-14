/** I-CONTACT authorized owner challenge handler, O0 (#140). INERT: no production importer, instance, route,
 * timer, file or key. Specified in company-lab roles-contact-o0-2026-10-13/BINDING.md (SPEC v2 §4), accepted as a
 * document by Security rm-4c755cd7 with the code checks below.
 *
 * - The only admissible principal is a native authenticated owner principal (T03), read from roles-owner-native.ts
 *   and nowhere else. T03 is missing, so every connection is unknown `owner-principal-not-admitted` and no
 *   challenge is issued. Browser origin admission, Ops108's ownerChannel mark, a Telegram chat, a client label or
 *   any model, tool or plugin flag is never a principal (`origin-admission-not-owner-auth`).
 * - Host scope (owner-client | observer) and the client id, incarnation and build come from the server's answering
 *   connection, never from the answer payload. Observers get no challenge and cannot answer one.
 * - Challenge: 256-bit value, server memory only (never persisted, logged or put in a record), id drawn
 *   independently of the value, bound to the exact context, 60000 ms of server time on the wall clock AND the
 *   monotonic clock, single use. The answer is compared as exact UTF-8 bytes (length first, then timingSafeEqual),
 *   never decoded. Wrong answer or changed binding invalidates it; nothing is reissued automatically. One pending
 *   challenge per binding (a new issue replaces it), a global cap, refused when full. The same accepted action again
 *   returns the original receipt; anything else on that challenge is a conflict.
 * - Render/open never confirm. G0 (#143) adds a separate explicit confirm action bound to a closed current
 *   artifact/task/plan/run/attempt. It uses the same missing T03 admitter, not a new authentication route.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { RTPI_LIMITS, rtpiCanonical, type RtpiRef } from "./rtpi-core.js";
import {
	g0ArtifactRef,
	g0Binding,
	g0Closed,
	g0ConfirmationSnapshot,
	g0Copy,
	g0Equal,
	type RolesConfirmationSnapshot,
	type RolesGateBinding,
} from "./roles-artifact.js";
import { rolesCurrentConfirmationSnapshot } from "./roles-gates.js";
import { admitNativeOwnerPrincipal, serverMonotonicNow, serverWallNow } from "./roles-owner-native.js";

export type OwnerPrincipalBasis =
	| "t03-native"
	| "browser-origin"
	| "native-client-session"
	| "ops108-owner-channel"
	| "telegram-chat"
	| "client-label"
	| "model-flag"
	| "tool-flag"
	| "plugin-flag";

export type OwnerPrincipalAdmission =
	{ readonly admitted: true; readonly principal: RtpiRef } | { readonly admitted: false; readonly reason: string };

/** Rehydrated by the host from the live (answering) connection; never from tool, model, plugin or client data. */
export interface OwnerHostConnection {
	readonly scope: "owner-client" | "observer";
	readonly channel: "browser" | "telegram" | "role" | "unknown";
	readonly principalBasis: OwnerPrincipalBasis;
	readonly pseudoClient: boolean;
	readonly session: RtpiRef;
	readonly window: RtpiRef;
	/** Server-minted at load for this connection. */
	readonly client: { readonly id: string; readonly incarnation: string; readonly build: string };
}

export type OwnerAction = "render" | "open" | "confirm";

/** The current subject the action is about, rehydrated by the host at issue and again at answer time. */
export interface OwnerActionTarget {
	readonly action: OwnerAction;
	readonly artifact: RtpiRef;
	readonly projection: RtpiRef;
	readonly coverage: RtpiRef;
	readonly policy: RtpiRef;
	/** G0 confirm only; from the task's OWN current native exact-artifact link. */
	readonly gateBinding?: RolesGateBinding;
	/** Current four measured roots + link/whole contract/target install; re-read, not pass flags. */
	readonly gateSnapshot?: RolesConfirmationSnapshot;
}

export interface OwnerActionReceipt {
	readonly challenge: RtpiRef;
	readonly action: OwnerAction;
	readonly principal: RtpiRef;
	readonly session: RtpiRef;
	readonly window: RtpiRef;
	readonly client: RtpiRef;
	readonly artifact: RtpiRef;
	readonly projection: RtpiRef;
	readonly coverage: RtpiRef;
	readonly policy: RtpiRef;
	readonly issuedAt: number;
	readonly expiresAt: number;
	readonly serverNow: number;
	/** Present only for explicit confirm; immutable exact artifact/whole queue/task/plan/run/attempt. */
	readonly gateBinding?: RolesGateBinding;
	readonly gateSnapshot?: RolesConfirmationSnapshot;
}

export type OwnerChallengeRefusal = {
	readonly status: "rejected" | "unknown" | "unavailable";
	readonly reason: string;
};
export type OwnerChallengeIssue =
	| {
			readonly status: "issued";
			readonly challengeId: string;
			/** Goes to the matching client only; never logged, stored in a record or shown to an observer. */
			readonly value: string;
			readonly issuedAt: number;
			readonly expiresAt: number;
	  }
	| OwnerChallengeRefusal;
export type OwnerChallengeAnswer =
	| { readonly status: "accepted"; readonly replay: boolean; readonly receipt: OwnerActionReceipt }
	| OwnerChallengeRefusal;

/** Host facts only. There is deliberately no admitter, capability, clock or randomness option (Security B1). */
export interface OwnerChallengeHandlerOptions {
	readonly currentBuild: string;
	/** The live incarnation for a client id, or null when the client is gone. */
	readonly currentIncarnation: (clientId: string) => string | null;
}

export const OWNER_CHALLENGE_LIMITS = Object.freeze({ bytes: 32, idBytes: 16, pending: 256, accepted: 1024 });

interface Pending {
	readonly id: string;
	/** Exact UTF-8 bytes of the value; server memory only. */
	readonly value: Buffer;
	readonly binding: string;
	readonly principal: RtpiRef;
	readonly clientId: string;
	readonly issuedAt: number;
	readonly expiresAt: number;
	readonly monoIssuedAt: number;
}
interface Accepted {
	readonly binding: string;
	readonly value: Buffer;
	readonly receipt: OwnerActionReceipt;
}

/** Receipts minted by a handler in this process; a copy, parsed JSON or hand-built object is not one. */
const MINTED = new WeakSet<object>();
export function isOwnerActionReceipt(v: unknown): v is OwnerActionReceipt {
	return typeof v === "object" && v !== null && MINTED.has(v);
}

const refuse = (status: OwnerChallengeRefusal["status"], reason: string): OwnerChallengeRefusal =>
	Object.freeze({ status, reason });
/** A frozen copy, so a later change to the host's objects cannot move a minted receipt. */
const frozenRef = (r: RtpiRef): RtpiRef =>
	Object.freeze({ namespace: r.namespace, kind: r.kind, id: r.id, revision: r.revision });
const isRef = (r: unknown): r is RtpiRef =>
	typeof r === "object" &&
	r !== null &&
	typeof (r as RtpiRef).id === "string" &&
	typeof (r as RtpiRef).kind === "string" &&
	typeof (r as RtpiRef).revision === "string";

/** Exact bytes: a length mismatch is a wrong answer; equal lengths go to timingSafeEqual. Never base64url-decoded
 * (Node's decoder skips invalid characters and unused bits, so a decoded compare would accept other strings). */
function sameBytes(answer: string, expected: Buffer): boolean {
	const given = Buffer.from(answer, "utf8");
	if (given.length !== expected.length) return false;
	return timingSafeEqual(given, expected);
}

/** Exact binding: principal, session, window, client incarnation + build, channel, action and current subject. */
function bindingOf(principal: RtpiRef, c: OwnerHostConnection, t: OwnerActionTarget): string {
	return rtpiCanonical({
		principal,
		session: c.session,
		window: c.window,
		client: { id: c.client.id, incarnation: c.client.incarnation, build: c.client.build },
		channel: c.channel,
		action: t.action,
		gateBinding: t.gateBinding ?? null,
		gateSnapshot: t.gateSnapshot ?? null,
		artifact: t.artifact,
		projection: t.projection,
		coverage: t.coverage,
		policy: t.policy,
	});
}

export interface OwnerChallengeHandler {
	issue(connection: OwnerHostConnection, target: OwnerActionTarget): OwnerChallengeIssue;
	/** `connection` is the answering connection as the host knows it; `reply` carries only id and value. */
	answer(
		connection: OwnerHostConnection,
		target: OwnerActionTarget,
		reply: { readonly challengeId: string; readonly value: string },
	): OwnerChallengeAnswer;
	/** Reconnect, reload or client gone: drop that client's pending challenges (no reissue). */
	invalidateClient(clientId: string): number;
	readonly pendingCount: number;
}

/** In-process, in-memory only. Nothing in production calls this (O0 is inert; wiring is J0's). */
export function createOwnerChallengeHandler(options: OwnerChallengeHandlerOptions): OwnerChallengeHandler {
	const currentBuild = options.currentBuild;
	const currentIncarnation = options.currentIncarnation;
	const pending = new Map<string, Pending>();
	const byBinding = new Map<string, string>();
	const accepted = new Map<string, Accepted>();

	/** Checks that hold for both issue and answer; scope and client state come from the host only. */
	function gate(c: OwnerHostConnection, t: OwnerActionTarget): OwnerChallengeRefusal | null {
		if (c.scope !== "owner-client") return refuse("rejected", "observer-no-challenge");
		if (c.pseudoClient) return refuse("rejected", "pseudo-client");
		if (c.channel !== "browser") return refuse("rejected", "channel-not-browser");
		if (t.action !== "render" && t.action !== "open" && t.action !== "confirm")
			return refuse("rejected", "action-not-in-o0");
		if (t.action === "confirm") {
			if (!g0Binding(t.gateBinding)) return refuse("rejected", "confirm-gate-binding-required");
			if (
				!g0Closed(t, ["action", "artifact", "projection", "coverage", "policy", "gateBinding", "gateSnapshot"]) ||
				!g0ConfirmationSnapshot(t.gateSnapshot)
			)
				return refuse("rejected", "confirm-snapshot-closed-schema");
			if (!g0Equal(t.artifact, g0ArtifactRef(t.gateBinding.artifact, t.gateBinding.run.namespace)))
				return refuse("rejected", "confirm-artifact-binding-mismatch");
		} else if (t.gateBinding !== undefined || t.gateSnapshot !== undefined)
			return refuse("rejected", "gate-binding-confirm-only");
		if (![c.session, c.window, t.artifact, t.projection, t.coverage, t.policy].every(isRef))
			return refuse("unknown", "current-subject-unknown");
		if (c.client.build !== currentBuild) return refuse("rejected", "prior-build-client");
		if (currentIncarnation(c.client.id) !== c.client.incarnation)
			return refuse("rejected", "stale-client-fresh-challenge-required");
		if (c.principalBasis !== "t03-native") return refuse("rejected", "origin-admission-not-owner-auth");
		if (t.action === "confirm") {
			const current = rolesCurrentConfirmationSnapshot();
			if (current === null) return refuse("unknown", "confirm-current-passing-roots-required");
			if (
				!g0Equal(t.gateSnapshot, current) ||
				!g0Equal(t.gateBinding, current.binding) ||
				!g0Equal(t.projection, current.projection) ||
				!g0Equal(t.coverage, current.coverage) ||
				!g0Equal(t.policy, current.policy)
			)
				return refuse("rejected", "confirm-current-subject-mismatch");
		}
		return null;
	}
	function principalOf(c: OwnerHostConnection): RtpiRef | OwnerChallengeRefusal {
		const a = admitNativeOwnerPrincipal(c);
		if (!a.admitted) return refuse("unknown", a.reason || "owner-principal-not-admitted");
		if (!isRef(a.principal) || a.principal.kind !== "owner") return refuse("unknown", "owner-principal-not-admitted");
		return frozenRef(a.principal);
	}
	function clocks(): { wall: number; mono: number } | null {
		const wall = serverWallNow();
		const mono = serverMonotonicNow();
		if (!Number.isSafeInteger(wall) || wall < 0 || !Number.isFinite(mono) || mono < 0) return null;
		return { wall, mono };
	}
	function drop(id: string): void {
		const p = pending.get(id);
		if (!p) return;
		pending.delete(id);
		if (byBinding.get(p.binding) === id) byBinding.delete(p.binding);
	}
	function live(p: Pending, wall: number, mono: number): boolean {
		const elapsed = mono - p.monoIssuedAt;
		return p.issuedAt <= wall && wall < p.expiresAt && elapsed >= 0 && elapsed < RTPI_LIMITS.challengeMs;
	}

	return {
		issue(c, t) {
			const g = gate(c, t);
			if (g) return g;
			const principal = principalOf(c);
			if ("status" in principal) return principal;
			const now = clocks();
			if (now === null) return refuse("unknown", "server-clock-unknown");
			// Deleting the visited entry while iterating a Map is well defined.
			for (const p of pending.values()) if (!live(p, now.wall, now.mono)) drop(p.id);
			const binding = bindingOf(principal, c, t);
			// One pending challenge per binding: a new issue for the same binding replaces the earlier one.
			const earlier = byBinding.get(binding);
			if (earlier !== undefined) drop(earlier);
			if (pending.size >= OWNER_CHALLENGE_LIMITS.pending) return refuse("unavailable", "challenge-capacity");
			// Two independent draws: the id says nothing about the value.
			const value = randomBytes(OWNER_CHALLENGE_LIMITS.bytes).toString("base64url");
			const id = "oc-" + randomBytes(OWNER_CHALLENGE_LIMITS.idBytes).toString("hex");
			const p: Pending = {
				id,
				value: Buffer.from(value, "utf8"),
				binding,
				principal,
				clientId: c.client.id,
				issuedAt: now.wall,
				expiresAt: now.wall + RTPI_LIMITS.challengeMs,
				monoIssuedAt: now.mono,
			};
			pending.set(id, p);
			byBinding.set(binding, id);
			return Object.freeze({ status: "issued", challengeId: id, value, issuedAt: p.issuedAt, expiresAt: p.expiresAt });
		},

		answer(c, t, reply) {
			const id = typeof reply?.challengeId === "string" ? reply.challengeId : "";
			const g = gate(c, t);
			if (g) {
				// A real subject change invalidates its owner's pending action; an observer
				// cannot consume somebody else's challenge merely by sending its id.
				const p = pending.get(id);
				if (
					t.action === "confirm" &&
					g.reason.startsWith("confirm-") &&
					p &&
					p.clientId === c.client.id &&
					c.scope === "owner-client" &&
					!c.pseudoClient &&
					c.principalBasis === "t03-native"
				) {
					const a = admitNativeOwnerPrincipal(c);
					if (a.admitted && g0Equal(a.principal, p.principal)) drop(id);
				}
				return g;
			}
			if (t.action === "confirm" && !g0Closed(reply, ["challengeId", "value"]))
				return refuse("rejected", "confirm-answer-closed-schema");
			const value = typeof reply?.value === "string" ? reply.value : "";
			const principal = principalOf(c);
			if ("status" in principal) return principal;
			const binding = bindingOf(principal, c, t);
			// Idempotent read: the same accepted action (same challenge, binding and exact answer bytes) returns the
			// original receipt, also after expiry, and mints or runs nothing. Anything else on it is a conflict.
			const done = accepted.get(id);
			if (done) {
				return done.binding === binding && sameBytes(value, done.value)
					? Object.freeze({ status: "accepted", replay: true, receipt: done.receipt })
					: refuse("rejected", "dedup-key-conflict");
			}
			const p = pending.get(id);
			if (!p) return refuse("rejected", "challenge-unknown-or-used");
			if (p.binding !== binding) {
				drop(id);
				return refuse("rejected", "binding-changed-pending-invalidated");
			}
			const now = clocks();
			if (now === null) return refuse("unknown", "server-clock-unknown");
			if (!live(p, now.wall, now.mono)) {
				drop(id);
				return refuse("rejected", "pending-challenge-expired-or-unbound");
			}
			if (!sameBytes(value, p.value)) {
				drop(id);
				return refuse("rejected", "challenge-answer-mismatch");
			}
			if (accepted.size >= OWNER_CHALLENGE_LIMITS.accepted) return refuse("unavailable", "receipt-capacity");
			drop(id);
			const ns = c.session.namespace;
			const receipt: OwnerActionReceipt = Object.freeze({
				challenge: Object.freeze({ namespace: ns, kind: "challenge", id, revision: "1" }),
				action: t.action,
				principal: p.principal,
				session: frozenRef(c.session),
				window: frozenRef(c.window),
				client: Object.freeze({ namespace: ns, kind: "client", id: c.client.id, revision: c.client.incarnation }),
				artifact: frozenRef(t.artifact),
				projection: frozenRef(t.projection),
				coverage: frozenRef(t.coverage),
				policy: frozenRef(t.policy),
				...(t.gateBinding === undefined
					? {}
					: { gateBinding: g0Copy(t.gateBinding), gateSnapshot: g0Copy(t.gateSnapshot) }),
				issuedAt: p.issuedAt,
				expiresAt: p.expiresAt,
				serverNow: now.wall,
			});
			MINTED.add(receipt);
			accepted.set(id, { binding, value: p.value, receipt });
			return Object.freeze({ status: "accepted", replay: false, receipt });
		},

		invalidateClient(clientId) {
			let n = 0;
			for (const p of pending.values())
				if (p.clientId === clientId) {
					drop(p.id);
					n++;
				}
			return n;
		},

		get pendingCount() {
			return pending.size;
		},
	};
}
