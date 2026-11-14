/**
 * The owner's passkey client for the Memory explorer (spec-explorer-owner.md, backend #166): sign in,
 * add a passkey with the 7-word code sent to his Telegram, confirm one write, sign out, remove a
 * passkey. Bodies are `server/openviking/owner-session-types.ts`; the browser's passkey prompt is
 * `@simplewebauthn/browser` unless another is passed in.
 *
 * Every refusal from the server is the same `403 OWNER_ONLY` (no oracle), so the page can only tell
 * three things apart: the owner closed the prompt (CANCELLED), the server said no (REFUSED), or it
 * didn't answer (FAILED).
 */

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import {
	OWNER_ASSERTION_HEADER,
	OWNER_WRITE_HEADER,
	type OwnerAssertionHeader,
	type OwnerCeremonyOptions,
	type OwnerCodeSent,
	type OwnerEnrolled,
	type OwnerPasskeyInfo,
	type OwnerSessionOpened,
	type OwnerWriteOp,
} from "../../../server/openviking/owner-session-types.js";
import { appUrl } from "../base-url.js";
import { ExplorerApiError } from "./explorer-api.js";

const OWNER_API = "/api/openviking/owner";

export type OwnerFailure = "CANCELLED" | "REFUSED" | "FAILED";

export class OwnerSessionError extends Error {
	constructor(
		readonly code: OwnerFailure,
		message: string,
	) {
		super(message);
		this.name = "OwnerSessionError";
	}
}

/** The browser's passkey prompt: create a passkey, or answer a challenge with one. */
export interface OwnerWebAuthn {
	register(options: unknown): Promise<unknown>;
	authenticate(options: unknown): Promise<unknown>;
}

export const browserWebAuthn: OwnerWebAuthn = {
	register: (options) =>
		startRegistration({ optionsJSON: options as Parameters<typeof startRegistration>[0]["optionsJSON"] }),
	authenticate: (options) =>
		startAuthentication({ optionsJSON: options as Parameters<typeof startAuthentication>[0]["optionsJSON"] }),
};

export interface OwnerSessionClient {
	/** Sends a single-use 7-word code to the owner's Telegram (10 minutes). */
	sendCode(): Promise<OwnerCodeSent>;
	/** Adds a passkey for this address with the code he typed. */
	addPasskey(code: string): Promise<OwnerPasskeyInfo>;
	signIn(): Promise<OwnerSessionOpened>;
	/** One write's confirm: the `X-Owner-Assertion` value for exactly `op`. */
	confirmWrite(op: OwnerWriteOp): Promise<string>;
	signOut(): Promise<void>;
	removePasskey(id: string): Promise<void>;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface OwnerSessionOptions {
	readonly fetch?: Fetch;
	readonly webauthn?: OwnerWebAuthn;
}

/** A closed, timed-out or refused browser prompt (also when the passkey library wraps it as `cause`). */
function promptClosed(error: unknown): boolean {
	const names = new Set(["NotAllowedError", "AbortError"]);
	const err = error as { name?: string; cause?: { name?: string } } | null;
	return names.has(err?.name ?? "") || names.has(err?.cause?.name ?? "");
}

/** base64url (no padding) of the UTF-8 JSON, as the server reads `X-Owner-Assertion`. */
export function assertionHeader(value: OwnerAssertionHeader): string {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createOwnerSession(options: OwnerSessionOptions = {}): OwnerSessionClient {
	const fetchImpl: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
	const webauthn = options.webauthn ?? browserWebAuthn;

	async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
		let response: Response;
		try {
			response = await fetchImpl(appUrl(`${OWNER_API}/${path}`), {
				method: "POST",
				credentials: "same-origin",
				...init,
				headers: { accept: "application/json", "content-type": "application/json", ...init.headers },
			});
		} catch {
			throw new OwnerSessionError("FAILED", "The server didn't answer.");
		}
		if (response.status === 403) throw new OwnerSessionError("REFUSED", "The owner check said no.");
		if (!response.ok) throw new OwnerSessionError("FAILED", `The server answered ${response.status}.`);
		return (await response.json()) as T;
	}
	const post = <T>(path: string, body: unknown) => call<T>(path, { body: JSON.stringify(body) });

	async function prompt(run: () => Promise<unknown>): Promise<unknown> {
		try {
			return await run();
		} catch (error) {
			if (promptClosed(error)) throw new OwnerSessionError("CANCELLED", "The passkey prompt was closed.");
			throw new OwnerSessionError("FAILED", "The passkey prompt failed.");
		}
	}

	async function confirmWrite(op: OwnerWriteOp): Promise<string> {
		const ceremony = await post<OwnerCeremonyOptions>("write/options", { op });
		const response = await prompt(() => webauthn.authenticate(ceremony.options));
		return assertionHeader({ challenge_id: ceremony.challenge_id, response });
	}

	return {
		sendCode: () => post<OwnerCodeSent>("passkey/code", {}),
		async addPasskey(code) {
			const ceremony = await post<OwnerCeremonyOptions>("passkey/enroll/options", { code: code.trim() });
			const response = await prompt(() => webauthn.register(ceremony.options));
			const enrolled = await post<OwnerEnrolled>("passkey/enroll/verify", {
				challenge_id: ceremony.challenge_id,
				response,
			});
			return enrolled.passkey;
		},
		async signIn() {
			const ceremony = await post<OwnerCeremonyOptions>("session/options", {});
			const response = await prompt(() => webauthn.authenticate(ceremony.options));
			return post<OwnerSessionOpened>("session/verify", { challenge_id: ceremony.challenge_id, response });
		},
		confirmWrite,
		async signOut() {
			await post("session/logout", {});
		},
		async removePasskey(id) {
			const assertion = await confirmWrite({ method: "DELETE", passkey_id: id });
			await call(`passkey?id=${encodeURIComponent(id)}`, {
				method: "DELETE",
				headers: { [OWNER_WRITE_HEADER]: "1", [OWNER_ASSERTION_HEADER]: assertion },
			});
		},
	};
}

/** A failed confirm in the explorer's words: closed prompt = not confirmed, nothing written. */
export function explorerErrorOf(error: unknown): ExplorerApiError {
	if (error instanceof ExplorerApiError) return error;
	if (error instanceof OwnerSessionError && error.code === "CANCELLED") {
		return new ExplorerApiError("NOT_CONFIRMED", error.message);
	}
	if (error instanceof OwnerSessionError && error.code === "REFUSED")
		return new ExplorerApiError("OWNER_ONLY", error.message);
	return new ExplorerApiError("FAILED", error instanceof Error ? error.message : "Failed.");
}
