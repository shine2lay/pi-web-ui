/**
 * Memory Explorer — the owner check's WebAuthn policy (OI-1, Security rm-8841fede point 1) over
 * @simplewebauthn/server: user verification required on every ceremony (an assertion or registration with UV=false is
 * refused), the expected origin and RP ID are the host's own, attestation `none` (the owner trusts his own device).
 * Each function returns null instead of throwing for anything that does not verify.
 */
import {
	type AuthenticationResponseJSON,
	generateAuthenticationOptions,
	generateRegistrationOptions,
	type PublicKeyCredentialCreationOptionsJSON,
	type PublicKeyCredentialRequestOptionsJSON,
	type RegistrationResponseJSON,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { OwnerChallenge } from "./owner-ceremony-store.js";
import type { OwnerPasskey } from "./owner-passkey-store.js";

/** The same WebAuthn user for every passkey: there is one owner. */
const OWNER_USER_ID = new Uint8Array(Buffer.from("pi-web-ui-owner", "utf8"));
/** ES256 and RS256. */
const ALGORITHMS = [-7, -257];

const bytes = (b64url: string) => new Uint8Array(Buffer.from(b64url, "base64url"));

const isCredentialJson = (raw: unknown): raw is { id: string; rawId: string; type: string; response: object } => {
	const r = raw as { id?: unknown; rawId?: unknown; type?: unknown; response?: unknown } | null;
	return (
		r !== null &&
		typeof r === "object" &&
		typeof r.id === "string" &&
		typeof r.rawId === "string" &&
		r.type === "public-key" &&
		typeof r.response === "object" &&
		r.response !== null
	);
};

export function ownerCreationOptions(
	challenge: OwnerChallenge,
	existing: OwnerPasskey[],
	timeoutMs: number,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
	return generateRegistrationOptions({
		rpName: "pi-web-ui memory explorer",
		rpID: challenge.rp.rpID,
		userName: "owner",
		userDisplayName: "Owner",
		userID: OWNER_USER_ID,
		challenge: bytes(challenge.challenge),
		timeout: timeoutMs,
		attestationType: "none",
		excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports })),
		authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
		supportedAlgorithmIDs: ALGORITHMS,
	});
}

export function ownerRequestOptions(
	challenge: OwnerChallenge,
	passkeys: OwnerPasskey[],
	timeoutMs: number,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
	return generateAuthenticationOptions({
		rpID: challenge.rp.rpID,
		challenge: bytes(challenge.challenge),
		timeout: timeoutMs,
		userVerification: "required",
		allowCredentials: passkeys.map((p) => ({ id: p.id, transports: p.transports })),
	});
}

/** A new passkey from a verified, user-verified registration for `challenge`; null otherwise. */
export async function ownerVerifiedRegistration(
	challenge: OwnerChallenge,
	response: unknown,
	createdAt: string,
): Promise<OwnerPasskey | null> {
	if (!isCredentialJson(response)) return null;
	try {
		const result = await verifyRegistrationResponse({
			response: response as unknown as RegistrationResponseJSON,
			expectedChallenge: challenge.challenge,
			expectedOrigin: challenge.rp.origin,
			expectedRPID: challenge.rp.rpID,
			requireUserPresence: true,
			requireUserVerification: true,
			supportedAlgorithmIDs: ALGORITHMS,
		});
		if (!result.verified || !result.registrationInfo.userVerified) return null;
		const { credential } = result.registrationInfo;
		return {
			id: credential.id,
			rp_id: challenge.rp.rpID,
			public_key: Buffer.from(credential.publicKey).toString("base64url"),
			counter: credential.counter,
			transports: credential.transports ?? [],
			created_at: createdAt,
		};
	} catch {
		return null;
	}
}

/** The passkey and its new signature count for a verified, user-verified assertion over `challenge`; null otherwise. */
export async function ownerVerifiedAssertion(
	challenge: OwnerChallenge,
	response: unknown,
	passkeys: OwnerPasskey[],
): Promise<{ passkey: OwnerPasskey; counter: number } | null> {
	if (!isCredentialJson(response)) return null;
	const passkey = passkeys.find((p) => p.id === response.id && p.rp_id === challenge.rp.rpID);
	if (!passkey) return null;
	try {
		const result = await verifyAuthenticationResponse({
			response: response as unknown as AuthenticationResponseJSON,
			expectedChallenge: challenge.challenge,
			expectedOrigin: challenge.rp.origin,
			expectedRPID: challenge.rp.rpID,
			credential: {
				id: passkey.id,
				publicKey: bytes(passkey.public_key),
				counter: passkey.counter,
				transports: passkey.transports,
			},
			requireUserVerification: true,
		});
		if (!result.verified || !result.authenticationInfo.userVerified) return null;
		return { passkey, counter: result.authenticationInfo.newCounter };
	} catch {
		return null;
	}
}
