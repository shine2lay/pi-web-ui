/**
 * Memory Explorer — why the owner check refused a request (OI-1). The reason goes to the log only; every refusal
 * answers the one `403 OWNER_ONLY` body (R-OWNER-REFUSE-1), so a caller cannot learn which check failed.
 */
export type OwnerRefusalReason =
	| "no_session"
	| "passkey_gone"
	| "bad_origin"
	| "no_write_header"
	| "rate_limited"
	| "no_assertion"
	| "bad_assertion_header"
	| "unknown_challenge"
	| "challenge_expired"
	| "other_session"
	| "op_mismatch"
	| "assertion_failed"
	| "no_passkeys"
	| "bad_code"
	| "telegram_failed"
	| "bad_request"
	| "error";

/** A refusal raised inside the owner check; turned into the one `403 OWNER_ONLY` body. */
export class OwnerRefusal extends Error {
	constructor(readonly reason: OwnerRefusalReason) {
		super(reason);
	}
}
