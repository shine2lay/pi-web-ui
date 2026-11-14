/**
 * Test-only stand-ins for the owner check (OI-1): a software passkey (ES256, attestation "none") that answers
 * WebAuthn options the way a browser + platform authenticator would, and a Telegram sender that records what it
 * was asked to send. Nothing here is imported by production code (rule 29).
 */
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import type { OwnerTelegramNotice, OwnerTelegramResult } from "../../server/owner-telegram.js";

const b64url = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString("base64url");
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest();

/** Authenticator data flags. */
const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

export interface FakePasskeyOptions {
	/** The page's origin the browser puts in clientDataJSON. */
	origin: string;
	/** false: the authenticator reports no user verification (UV=0). */
	userVerified?: boolean;
}

/** One software passkey bound to one RP ID, as a browser would drive it. */
export class FakePasskey {
	readonly credentialId = randomBytes(16);
	private readonly privateKey: KeyObject;
	private readonly cose: Uint8Array;
	private counter = 0;

	constructor(readonly rpID: string) {
		const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
		this.privateKey = privateKey;
		const jwk = publicKey.export({ format: "jwk" });
		const coseKey = new Map<number, number | Uint8Array>([
			[1, 2],
			[3, -7],
			[-1, 1],
			[-2, Buffer.from(jwk.x as string, "base64url")],
			[-3, Buffer.from(jwk.y as string, "base64url")],
		]);
		this.cose = isoCBOR.encode(coseKey);
	}

	get id(): string {
		return b64url(this.credentialId);
	}

	private authData(flags: number, attested: boolean): Buffer {
		this.counter += 1;
		const count = Buffer.alloc(4);
		count.writeUInt32BE(this.counter);
		const head = Buffer.concat([sha256(this.rpID), Buffer.from([flags]), count]);
		if (!attested) return head;
		const idLen = Buffer.alloc(2);
		idLen.writeUInt16BE(this.credentialId.length);
		return Buffer.concat([head, Buffer.alloc(16), idLen, this.credentialId, Buffer.from(this.cose)]);
	}

	private clientData(type: string, challenge: string, origin: string): Buffer {
		return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), "utf8");
	}

	/** navigator.credentials.create() for `options` (PublicKeyCredentialCreationOptionsJSON). */
	register(options: { challenge: string }, opts: FakePasskeyOptions) {
		const flags = UP | AT | (opts.userVerified === false ? 0 : UV);
		const attestationObject = isoCBOR.encode(
			new Map<string, unknown>([
				["fmt", "none"],
				["attStmt", new Map()],
				["authData", this.authData(flags, true)],
			]) as never,
		);
		return {
			id: this.id,
			rawId: this.id,
			type: "public-key",
			response: {
				clientDataJSON: b64url(this.clientData("webauthn.create", options.challenge, opts.origin)),
				attestationObject: b64url(attestationObject),
				transports: ["internal"],
			},
			clientExtensionResults: {},
		};
	}

	/** navigator.credentials.get() for `options` (PublicKeyCredentialRequestOptionsJSON). */
	assert(options: { challenge: string }, opts: FakePasskeyOptions) {
		const flags = UP | (opts.userVerified === false ? 0 : UV);
		const authenticatorData = this.authData(flags, false);
		const clientDataJSON = this.clientData("webauthn.get", options.challenge, opts.origin);
		const signature = sign("sha256", Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.privateKey);
		return {
			id: this.id,
			rawId: this.id,
			type: "public-key",
			response: {
				clientDataJSON: b64url(clientDataJSON),
				authenticatorData: b64url(authenticatorData),
				signature: b64url(signature),
			},
			clientExtensionResults: {},
		};
	}
}

export type FakeTelegramMode = "ok" | "refused" | "maybe_sent" | "throws";

/** The owner's Telegram as the owner check sees it: records each notice; `mode` decides the answer. */
export function fakeTelegram(initial: FakeTelegramMode = "ok") {
	const sent: OwnerTelegramNotice[] = [];
	const state = { mode: initial };
	const send = async (notice: OwnerTelegramNotice): Promise<OwnerTelegramResult> => {
		sent.push(notice);
		if (state.mode === "throws") throw new Error("telegram down");
		if (state.mode === "refused") return { ok: false, error: "Telegram refused it" };
		if (state.mode === "maybe_sent") return { ok: false, error: "no answer", maybeSent: true };
		return { ok: true, messageIds: [sent.length] };
	};
	/** The enrollment code in the last notice that carried one (the owner reading his Telegram). */
	const lastCode = (): string => {
		for (let i = sent.length - 1; i >= 0; i--) {
			const m = /:\n\n([a-z]+(?: [a-z]+)+)\n\n/.exec(sent[i].text);
			if (m) return m[1];
		}
		throw new Error("no code was sent");
	};
	return { send, sent, state, lastCode };
}
