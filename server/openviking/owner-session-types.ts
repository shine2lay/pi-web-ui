/**
 * Memory Explorer — the owner check's wire contract (OI-1, spec-explorer-owner.md; Security rm-8841fede as amended by
 * rm-3e4885d2). No session (reads are open, owner Shine 2026-11-22, dr-c54a3286d823); one fresh user-verified passkey
 * assertion bound to each write. Every route under `/api/openviking/owner/`; every failure answers `403 OWNER_ONLY` with one body.
 * Imported by the page (frontend #290): no runtime imports here beyond constants.
 */

/** The two hosts the owner uses; a passkey belongs to one (its RP ID), so he enrolls once per host. */
export const OWNER_RELYING_PARTIES = [
	{ rpID: "pi.wai2shine.com", origin: "https://pi.wai2shine.com" },
	{ rpID: "spark.tailbb5055.ts.net", origin: "https://spark.tailbb5055.ts.net:8787" },
] as const;

export type OwnerRelyingParty = (typeof OWNER_RELYING_PARTIES)[number];

/** A write carries this header with the value `1` (defense in depth). */
export const OWNER_WRITE_HEADER = "X-Owner-Write";
/** A write carries its passkey assertion here: base64url of the JSON `OwnerAssertionHeader`. */
export const OWNER_ASSERTION_HEADER = "X-Owner-Assertion";

/** A write challenge: 32 random bytes, single use, 60 s. */
export const OWNER_WRITE_CHALLENGE_MS = 60_000;
export const OWNER_CHALLENGE_BYTES = 32;
/** Enrollment prompts: single use, 2 min (the browser's own prompt timeout fits inside). */
export const OWNER_CEREMONY_CHALLENGE_MS = 2 * 60_000;
/** The Telegram enrollment code: single use, 10 min, memory only. */
export const OWNER_ENROLL_CODE_MS = 10 * 60_000;
export const OWNER_ENROLL_CODE_WORDS = 7;
/** Options, verify and assertion calls: at most 10 per rolling minute. */
export const OWNER_RATE_LIMIT = { calls: 10, windowMs: 60_000 } as const;
/** Codes sent to Telegram: at most 3 per rolling 10 minutes. */
export const OWNER_CODE_RATE_LIMIT = { calls: 3, windowMs: 10 * 60_000 } as const;

/** The one refusal body (no oracle: the same for every failure). */
export const OWNER_ONLY_BODY = {
	error: { code: "OWNER_ONLY", message: "The memory explorer is for the owner only." },
} as const;

// ---- the operation a write assertion is bound to ----

/**
 * What one write does, sent to `write/options` before the write and compared byte for byte with the write as the
 * server receives it. `body_sha256`: lowercase hex sha256 of the exact request body bytes (DELETE: of no bytes).
 */
export type OwnerWriteOp =
	| { method: "PUT"; uri: string; opened_mod_time: string; body_sha256: string }
	| { method: "DELETE"; uri: string; body_sha256: string }
	| { method: "POST"; operation_id: string }
	| { method: "DELETE"; passkey_id: string };

/** The `X-Owner-Assertion` header's JSON (before base64url). */
export interface OwnerAssertionHeader {
	challenge_id: string;
	/** WebAuthn `AuthenticationResponseJSON` (navigator.credentials.get, as @simplewebauthn/browser returns it). */
	response: unknown;
}

// ---- request and response bodies, all under /api/openviking/owner/ ----

/** `POST passkey/code` `{}` -> `202`. The code goes only to the owner's Telegram; it is never in a response. */
export interface OwnerCodeSent {
	sent: true;
	rp_id: string;
	expires_at: string;
}

/** `POST passkey/enroll/options`. */
export interface OwnerEnrollOptionsRequest {
	code: string;
}

/** `POST passkey/enroll/options` -> `200`; `options` is WebAuthn `PublicKeyCredentialCreationOptionsJSON`. */
export interface OwnerCeremonyOptions {
	challenge_id: string;
	expires_at: string;
	options: unknown;
}

/** `POST passkey/enroll/verify`; `response` is WebAuthn `RegistrationResponseJSON`. */
export interface OwnerEnrollVerifyRequest {
	challenge_id: string;
	response: unknown;
}

/** A stored passkey as the page sees it (never the public key). */
export interface OwnerPasskeyInfo {
	id: string;
	rp_id: string;
	created_at: string;
}

/** `POST passkey/enroll/verify` -> `201`. */
export interface OwnerEnrolled {
	passkey: OwnerPasskeyInfo;
}

/** `GET passkeys` -> `200`: the request's host and its passkeys (public info only; empty = add one first). */
export interface OwnerPasskeyList {
	rp_id: string;
	passkeys: OwnerPasskeyInfo[];
}

/**
 * `POST write/options` (with `X-Owner-Write: 1`) -> `200` `OwnerCeremonyOptions`, the challenge bound to `op` and
 * the host (`PublicKeyCredentialRequestOptionsJSON`). A host with no passkey is refused like any failure.
 */
export interface OwnerWriteOptionsRequest {
	op: OwnerWriteOp;
}

/** `DELETE passkey?id=` (its own assertion bound to `{ method: "DELETE", passkey_id }`) -> `200`. */
export interface OwnerPasskeyRemoved {
	removed: string;
}
